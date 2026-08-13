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
    token: 'routine-lark-token',
    event: {
      message: {
        message_id: messageId,
        root_id: rootId,
        parent_id: rootId,
        chat_id: 'oc_standing_work',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: `@MaxTag ${text}` }),
        mentions: [
          {
            key: '@MaxTag',
            id: { open_id: 'ou_opentag_bot' },
            name: 'MaxTag',
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
        OPENTAG_LARK_EVENT_MODE: 'webhook',
        OPENTAG_LARK_VERIFICATION_TOKEN: 'routine-lark-token',
        OPENTAG_LARK_CALLBACK_MAX_SKEW_SECONDS: '0',
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

    const quietResponse = await fetch(`${baseUrl}/v1/routines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'Quiet failure watcher',
        instructions: 'Check quietly and only alert after repeated failures.',
        enabled: true,
        schedule: { kind: 'interval', everyMinutes: 60 },
        notifications: {
          mode: 'failures_only',
          failureThreshold: 2,
          recovery: true,
        },
        destination: {
          platform: 'lark',
          externalId: 'quiet-chat:om_quiet_root',
          channelId: 'quiet-chat',
          threadId: 'lark:quiet-chat:om_quiet_root',
          rootMessageId: 'om_quiet_root',
          topicId: 'om_quiet_root',
          visibility: 'private',
        },
      }),
    });
    assert.equal(quietResponse.status, 200);
    const quietRoutine = (await quietResponse.json()).routine;
    assert.equal(quietRoutine.notifications.mode, 'failures_only');
    assert.equal(quietRoutine.notifications.failureThreshold, 2);
    const quietTrigger = await fetch(
      `${baseUrl}/v1/routines/${quietRoutine.id}/trigger`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    ).then((response) => response.json());
    const quietSnapshot = await waitForJson(
      `${baseUrl}/v1/routines?workspaceId=dev-workspace`,
      (data) =>
        data.executions.some(
          (item) =>
            item.id === quietTrigger.execution.id && item.status === 'completed',
        ),
      child,
      logs,
    );
    assert.equal(
      quietSnapshot.notifications.filter(
        (item) => item.routineId === quietRoutine.id,
      ).length,
      0,
    );
    const quietRunDetail = await fetch(
      `${baseUrl}/v1/runs/${encodeURIComponent(quietTrigger.execution.runId)}/events`,
    ).then((response) => response.json());
    assert.equal(quietRunDetail.run.status, 'completed');
    assert.equal(quietRunDetail.usage.purpose, 'agent');
    assert.deepEqual(quietRunDetail.deliveries.outbox, []);

    const onceAt = new Date(Date.now() + 150).toISOString();
    const onceResponse = await fetch(`${baseUrl}/v1/routines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'One-time thread follow-up',
        instructions: 'Report the one-time release status.',
        enabled: true,
        schedule: { kind: 'once', at: onceAt },
        destination: {
          platform: 'lark',
          externalId: 'once-chat:om_once_root',
          channelId: 'once-chat',
          threadId: 'lark:once-chat:om_once_root',
          rootMessageId: 'om_once_root',
          topicId: 'om_once_root',
          visibility: 'private',
        },
      }),
    });
    assert.equal(onceResponse.status, 200);
    const onceRoutineCreated = (await onceResponse.json()).routine;
    await new Promise((resolve) => setTimeout(resolve, 180));
    const onceTick = await fetch(`${baseUrl}/v1/routines/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(onceTick.status, 200);
    const onceSnapshot = await waitForJson(
      `${baseUrl}/v1/routines?workspaceId=dev-workspace`,
      (data) =>
        data.executions.some(
          (item) =>
            item.routineId === onceRoutineCreated.id &&
            item.status === 'completed',
        ),
      child,
      logs,
    );
    const onceRoutine = onceSnapshot.routines.find(
      (item) => item.id === onceRoutineCreated.id,
    );
    const onceExecutions = onceSnapshot.executions.filter(
      (item) => item.routineId === onceRoutineCreated.id,
    );
    assert.equal(onceRoutine.enabled, false);
    assert.equal(onceRoutine.nextRunAt, undefined);
    assert.equal(onceExecutions.length, 1);
    const onceRunResponse = await fetch(`${baseUrl}/v1/runs?limit=20`);
    assert.equal(onceRunResponse.status, 200);
    const onceRun = (await onceRunResponse.json()).runs.find(
      (item) => item.id === onceExecutions[0].runId,
    );
    assert.ok(onceRun);
    assert.equal(onceRun.threadId, 'lark:once-chat:om_once_root');
    assert.equal(onceRun.thread.rootMessageId, 'om_once_root');
    assert.equal(onceRun.thread.topicId, 'om_once_root');
    assert.equal(onceRun.thread.visibility, 'private');
    await fetch(`${baseUrl}/v1/routines/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const afterSecondTick = await fetch(
      `${baseUrl}/v1/routines?workspaceId=dev-workspace`,
    ).then((response) => response.json());
    assert.equal(
      afterSecondTick.executions.filter(
        (item) => item.routineId === onceRoutineCreated.id,
      ).length,
      1,
    );

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
