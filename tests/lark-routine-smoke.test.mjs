import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

async function streamText(stream) {
  let value = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) value += chunk;
  return value;
}

async function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function jsonBody(request) {
  let value = '';
  request.setEncoding('utf8');
  for await (const chunk of request) value += chunk;
  return value ? JSON.parse(value) : {};
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function spawnSmoke(args) {
  const child = spawn(
    process.execPath,
    ['scripts/lark-routine-smoke.mjs', '--json', ...args],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const [stdout, stderr, exit] = await Promise.all([
    streamText(child.stdout),
    streamText(child.stderr),
    once(child, 'exit'),
  ]);
  return { result: JSON.parse(stdout), stderr, exit };
}

function bridgeHandler(_request, response) {
  sendJson(response, {
    ok: true,
    eventKeys: [
      { eventKey: 'im.message.receive_v1', running: true, ready: true },
      { eventKey: 'card.action.trigger', running: true, ready: true },
    ],
  });
}

test('Lark routine smoke is non-mutating unless live send is explicit', async () => {
  let mutations = 0;
  const server = await listen((request, response) => {
    if (request.method !== 'GET') mutations += 1;
    if (request.url === '/health') {
      sendJson(response, {
        ok: true,
        clients: { lark: { mode: 'http', hasCredentials: true } },
      });
      return;
    }
    if (request.url?.startsWith('/v1/routines?')) {
      sendJson(response, {
        routines: [],
        executions: [],
        scheduler: { enabled: false, mode: 'manual' },
      });
      return;
    }
    sendJson(response, { error: 'not_found' }, 404);
  });
  const bridge = await listen(bridgeHandler);
  try {
    const result = await spawnSmoke([
      `--server-url=http://127.0.0.1:${server.address().port}`,
      `--bridge-health-url=http://127.0.0.1:${bridge.address().port}/health`,
    ]);
    assert.deepEqual(result.exit, [0, null], result.stderr);
    assert.equal(result.result.ok, true);
    assert.equal(result.result.sent, false);
    assert.equal(result.result.scheduler.mode, 'manual');
    assert.equal(mutations, 0);
  } finally {
    server.close();
    bridge.close();
  }
});

test('Lark routine smoke proves one execution, exact topic route, and delivery', async () => {
  let routine;
  let execution;
  let run;
  let delivery;
  let tickCount = 0;
  const chatId = 'oc_routine_smoke';
  const rootId = 'om_routine_root';
  const threadId = `lark:${chatId}:${rootId}`;
  const server = await listen(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, {
        ok: true,
        clients: { lark: { mode: 'http', hasCredentials: true } },
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/routines') {
      sendJson(response, {
        routines: routine ? [routine] : [],
        executions: execution ? [execution] : [],
        scheduler: { enabled: false, mode: 'manual', tickIntervalMs: 30_000 },
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/routines') {
      const body = await jsonBody(request);
      routine = {
        ...body,
        id: '00000000-0000-4000-8000-000000000001',
        nextRunAt: body.schedule.at,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sendJson(response, { routine });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/routines/tick') {
      tickCount += 1;
      await jsonBody(request);
      routine = { ...routine, enabled: false, nextRunAt: undefined };
      execution = {
        id: 'routine-execution-1',
        routineId: routine.id,
        trigger: 'scheduled',
        status: 'completed',
        runId: 'routine:run-1',
      };
      run = {
        id: execution.runId,
        status: 'completed',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        threadId,
        thread: {
          id: threadId,
          channelId: chatId,
          rootMessageId: rootId,
          topicId: rootId,
          visibility: 'private',
        },
      };
      delivery = {
        id: 'delivery-1',
        runId: run.id,
        kind: 'lark.text',
        status: 'delivered',
        target: { chatId, rootId },
      };
      sendJson(response, { result: { staged: 1 } });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/runs') {
      sendJson(response, { runs: run ? [run] : [] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/deliveries') {
      sendJson(response, { outbox: delivery ? [delivery] : [] });
      return;
    }
    sendJson(response, { error: 'not_found' }, 404);
  });
  const bridge = await listen(bridgeHandler);
  try {
    const result = await spawnSmoke([
      '--send',
      '--tick',
      '--delay-ms=1',
      '--poll-ms=10',
      '--timeout-ms=3000',
      `--server-url=http://127.0.0.1:${server.address().port}`,
      `--bridge-health-url=http://127.0.0.1:${bridge.address().port}/health`,
      `--chat-id=${chatId}`,
      `--root-message-id=${rootId}`,
    ]);
    assert.deepEqual(result.exit, [0, null], result.stderr);
    assert.equal(result.result.ok, true);
    assert.equal(result.result.sent, true);
    assert.equal(result.result.routine.enabled, false);
    assert.equal(result.result.routine.executionCount, 1);
    assert.equal(result.result.route.threadId, threadId);
    assert.equal(result.result.delivery.status, 'delivered');
    assert.equal(tickCount, 1);
  } finally {
    server.close();
    bridge.close();
  }
});
