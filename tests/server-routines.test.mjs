import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error('failed_to_reserve_test_port');
  return port;
}

async function waitForJson(url, predicate, child, logs, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (response.ok && predicate(data)) return data;
      lastError = new Error(`unexpected response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message}\n${logs.join('')}`);
}

function larkEvent(eventId, messageId, text, rootId = 'om_standing_root') {
  return {
    event_id: eventId,
    event: {
      message: {
        message_id: messageId,
        root_id: rootId,
        parent_id: rootId,
        chat_id: 'oc_standing_work',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: `@OpenTag ${text}` }),
        mentions: [
          {
            key: '@OpenTag',
            id: { open_id: 'ou_opentag_bot' },
            name: 'OpenTag',
          },
        ],
        create_time: String(Date.now()),
      },
      sender: {
        sender_id: { open_id: 'ou_channel_operator' },
        tenant_key: 'dev-workspace',
      },
    },
  };
}

test(
  'routine API bridges a manual trigger into a completed agent run',
  { timeout: 25_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-routine-api-'));
    const port = await freePort();
    const logs = [];
    const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_EXECUTOR_MODE: 'dry-run',
        OPENTAG_LARK_TRANSPORT: 'memory',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_opentag_bot',
        OPENTAG_AGENT_WORKER: 'inline',
        OPENTAG_AGENT_WORKER_INTERVAL_MS: '50',
        OPENTAG_ROUTINE_TICK_INTERVAL_MS: '600000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
    context.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForJson(`${baseUrl}/health`, (data) => data.ok === true, child, logs);

    const createResponse = await fetch(`${baseUrl}/v1/routines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'Integration digest',
        instructions: 'Summarize the integration test project.',
        enabled: true,
        schedule: { kind: 'interval', everyMinutes: 60 },
        destination: {
          platform: 'lark',
          externalId: 'integration-chat',
          channelId: 'integration-chat',
          visibility: 'public',
        },
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();

    const triggerResponse = await fetch(
      `${baseUrl}/v1/routines/${created.routine.id}/trigger`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'integration-test' }),
      },
    );
    assert.equal(triggerResponse.status, 202);
    const triggered = await triggerResponse.json();
    assert.equal(triggered.accepted, true);
    assert.match(triggered.execution.runId, /^routine:/);

    const snapshot = await waitForJson(
      `${baseUrl}/v1/routines?workspaceId=dev-workspace`,
      (data) =>
        data.executions.some(
          (execution) =>
            execution.id === triggered.execution.id && execution.status === 'completed',
        ),
      child,
      logs,
    );
    const execution = snapshot.executions.find(
      (item) => item.id === triggered.execution.id,
    );
    assert.equal(execution.status, 'completed');
    assert.match(execution.summary, /Dry-run Codex executor received/);

    const runsResponse = await fetch(`${baseUrl}/v1/runs?limit=10`);
    assert.equal(runsResponse.status, 200);
    const runs = await runsResponse.json();
    const run = runs.runs.find((item) => item.id === execution.runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.metadata.source, 'routine');
    assert.equal(run.metadata.routineName, 'Integration digest');

    const bindingResponse = await fetch(`${baseUrl}/v1/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'lark',
        externalId: 'oc_standing_work',
        channelId: 'oc_standing_work',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        activationMode: 'mention',
        requireMention: true,
      }),
    });
    assert.equal(bindingResponse.status, 200);

    const createCommandResponse = await fetch(`${baseUrl}/v1/lark/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        larkEvent(
          'standing-create-event',
          'om_standing_create',
          'schedule every 15m: Summarize channel incidents',
        ),
      ),
    });
    assert.equal(createCommandResponse.status, 202);
    const createCommand = await createCommandResponse.json();
    assert.equal(createCommand.accepted, true);
    assert.equal(createCommand.run.executorId, 'routine-command');

    const commandCompleted = await waitForJson(
      `${baseUrl}/v1/runs?limit=20`,
      (data) =>
        data.runs.some(
          (item) =>
            item.id === createCommand.run.id &&
            item.status === 'completed' &&
            item.summary?.includes('Standing work created'),
        ),
      child,
      logs,
    );
    assert.match(
      commandCompleted.runs.find((item) => item.id === createCommand.run.id)
        .summary,
      /Standing work created/,
    );

    const standingSnapshot = await waitForJson(
      `${baseUrl}/v1/routines?workspaceId=dev-workspace&projectId=opentag`,
      (data) =>
        data.routines.some(
          (routine) => routine.name === 'Summarize channel incidents',
        ),
      child,
      logs,
    );
    const standing = standingSnapshot.routines.find(
      (routine) => routine.name === 'Summarize channel incidents',
    );
    assert.equal(standing.createdBy, 'ou_channel_operator');
    assert.equal(standing.destination.externalId, 'oc_standing_work:om_standing_root');
    assert.equal(standing.destination.rootMessageId, 'om_standing_root');

    const listCommandResponse = await fetch(`${baseUrl}/v1/lark/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        larkEvent('standing-list-event', 'om_standing_list', 'routines'),
      ),
    });
    assert.equal(listCommandResponse.status, 202);
    const listCommand = await listCommandResponse.json();
    const listCompleted = await waitForJson(
      `${baseUrl}/v1/runs?limit=20`,
      (data) =>
        data.runs.some(
          (item) =>
            item.id === listCommand.run.id &&
            item.status === 'completed' &&
            item.summary?.includes('Standing work in this thread'),
        ),
      child,
      logs,
    );
    assert.match(
      listCompleted.runs.find((item) => item.id === listCommand.run.id).summary,
      /Summarize channel incidents/,
    );

    const pauseCommandResponse = await fetch(`${baseUrl}/v1/lark/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        larkEvent(
          'standing-pause-event',
          'om_standing_pause',
          `pause routine ${standing.id.slice(0, 8)}`,
        ),
      ),
    });
    assert.equal(pauseCommandResponse.status, 202);
    const pauseCommand = await pauseCommandResponse.json();
    await waitForJson(
      `${baseUrl}/v1/runs?limit=20`,
      (data) =>
        data.runs.some(
          (item) =>
            item.id === pauseCommand.run.id &&
            item.status === 'completed' &&
            item.summary?.includes('Standing work paused'),
        ),
      child,
      logs,
    );
    const pausedSnapshot = await fetch(
      `${baseUrl}/v1/routines?workspaceId=dev-workspace&projectId=opentag`,
    ).then((response) => response.json());
    assert.equal(
      pausedSnapshot.routines.find((routine) => routine.id === standing.id)
        .enabled,
      false,
    );
  },
);
