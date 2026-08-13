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

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server did not become healthy\n${logs.join('')}`);
}

function event(eventId, threadId, text, actorId = 'user-1') {
  return {
    platform: 'lark',
    eventId,
    eventType: 'im.message.receive_v1',
    thread: {
      externalId: `channel-a:${threadId}`,
      channelId: 'channel-a',
      rootMessageId: threadId,
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      visibility: 'public',
    },
    message: {
      id: `message-${eventId}`,
      text,
      actor: { id: actorId, displayName: actorId },
      mentionsAgent: true,
    },
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test(
  'client follow-ups steer one active thread and continue durably on CLI executors',
  { timeout: 20_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-server-steer-'));
    const port = await freePort();
    const logs = [];
    const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_STORAGE_DRIVER: 'sqlite',
        OPENTAG_EXECUTOR_MODE: 'dry-run',
        OPENTAG_AGENT_WORKER: 'manual',
        OPENTAG_ROUTINES_ENABLED: 'false',
        OPENTAG_WORKFLOWS_ENABLED: 'false',
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
    await waitForHealth(baseUrl, child, logs);
    const first = await postJson(
      `${baseUrl}/v1/client/events`,
      event('event-1', 'root-1', 'Investigate the incident.'),
    );
    assert.equal(first.response.status, 202);
    assert.equal(first.data.disposition, 'created');

    const followUp = await postJson(
      `${baseUrl}/v1/client/events`,
      event('event-2', 'root-1', 'Check the last deployment too.', 'user-2'),
    );
    assert.equal(followUp.response.status, 202);
    assert.equal(followUp.data.disposition, 'steered');
    assert.equal(followUp.data.run.id, first.data.run.id);
    assert.equal(followUp.data.steering.status, 'pending');

    let runs = await (await fetch(`${baseUrl}/v1/runs?limit=20`)).json();
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].status, 'queued');

    const firstPass = await postJson(`${baseUrl}/v1/runs/worker-pass`, {
      limit: 1,
    });
    assert.equal(firstPass.data.result.completed, 1);
    runs = await (await fetch(`${baseUrl}/v1/runs?limit=20`)).json();
    assert.equal(runs.runs.filter((run) => run.status === 'completed').length, 1);
    const continuation = runs.runs.find((run) => run.status === 'queued');
    assert.ok(continuation);
    assert.equal(continuation.metadata.source, 'steering');

    const detail = await (
      await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(first.data.run.id)}/events`)
    ).json();
    assert.equal(detail.steering[0].status, 'scheduled');
    assert.equal(detail.steering[0].mode, 'next_turn');
    assert.ok(
      detail.events.some((item) => item.type === 'steering_scheduled'),
    );
    assert.ok(detail.threadRuns.some((run) => run.id === first.data.run.id));
    assert.ok(Array.isArray(detail.deliveries.outbox));
    assert.ok(Array.isArray(detail.deliveries.turns));
    assert.equal(detail.usage.runId, first.data.run.id);

    const secondPass = await postJson(`${baseUrl}/v1/runs/worker-pass`, {
      limit: 1,
    });
    assert.equal(secondPass.data.result.completed, 1);
    const completedDetail = await (
      await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(first.data.run.id)}/events`)
    ).json();
    assert.equal(completedDetail.steering[0].status, 'applied');

    const third = await postJson(
      `${baseUrl}/v1/client/events`,
      event('event-3', 'root-stop', 'Start another task.'),
    );
    assert.equal(third.data.disposition, 'created');
    const operatorSteer = await postJson(
      `${baseUrl}/v1/runs/${encodeURIComponent(third.data.run.id)}/steer`,
      { text: 'Include the error budget.' },
    );
    assert.equal(operatorSteer.response.status, 202);
    assert.equal(operatorSteer.data.steering.status, 'pending');
    const stop = await postJson(
      `${baseUrl}/v1/client/events`,
      event('event-stop', 'root-stop', '/stop', 'user-2'),
    );
    assert.equal(stop.response.status, 200);
    assert.equal(stop.data.control, 'stop');
    assert.equal(stop.data.cancelled.runs[0].id, third.data.run.id);
    assert.equal(stop.data.cancelled.steering.length, 1);
    assert.equal(
      (await (await fetch(`${baseUrl}/v1/runs?limit=20`)).json()).runs.find(
        (run) => run.id === third.data.run.id,
      ).status,
      'cancelled',
    );
  },
);
