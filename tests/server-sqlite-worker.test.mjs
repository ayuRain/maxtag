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
      throw new Error(`process exited early (${child.exitCode})\n${logs.join('')}`);
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

async function startServer(dataDir) {
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
      OPENTAG_ADMIN_TOKEN: '',
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_EXECUTOR_MODE: 'dry-run',
      OPENTAG_LARK_TRANSPORT: 'memory',
      OPENTAG_TELEGRAM_TRANSPORT: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForJson(
    `${baseUrl}/health`,
    (data) => data.ok === true,
    child,
    logs,
  );
  return { baseUrl, child, health, logs };
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

test(
  'server and standalone worker share SQLite runs across restart',
  { timeout: 25_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-sqlite-app-'));
    const processes = [];
    context.after(async () => {
      await Promise.all(processes.map(stopProcess));
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const firstServer = await startServer(dataDir);
    processes.push(firstServer.child);
    assert.equal(firstServer.health.storage.driver, 'sqlite');
    assert.equal(firstServer.health.storage.wal, true);

    const queuedResponse = await fetch(`${firstServer.baseUrl}/v1/dev/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        async: true,
        platform: 'telegram',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        text: '@OpenTag verify the shared SQLite worker path',
      }),
    });
    assert.equal(queuedResponse.status, 202);
    const queued = await queuedResponse.json();
    assert.equal(queued.run.status, 'queued');

    const workerLogs = [];
    const worker = spawn(process.execPath, ['apps/worker/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_STORAGE_DRIVER: 'sqlite',
        OPENTAG_WORKER_ONCE: '1',
        OPENTAG_EXECUTOR_MODE: 'dry-run',
        OPENTAG_LARK_TRANSPORT: 'memory',
        OPENTAG_TELEGRAM_TRANSPORT: 'memory',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.push(worker);
    worker.stdout.on('data', (chunk) => workerLogs.push(chunk.toString()));
    worker.stderr.on('data', (chunk) => workerLogs.push(chunk.toString()));
    const [workerCode] = await once(worker, 'exit');
    assert.equal(workerCode, 0, workerLogs.join(''));
    assert.match(workerLogs.join(''), /"claimed":1/);

    const completed = await waitForJson(
      `${firstServer.baseUrl}/v1/runs?limit=20`,
      (data) =>
        data.runs.some(
          (run) => run.id === queued.run.id && run.status === 'completed',
        ),
      firstServer.child,
      firstServer.logs,
    );
    assert.match(
      completed.runs.find((run) => run.id === queued.run.id).summary,
      /Dry-run Codex executor received/,
    );

    const memoryRoute = {
      platform: 'lark',
      externalId: 'sqlite-memory-channel',
      threadId: 'lark:sqlite-memory-channel:root',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      scope: 'project',
    };
    const firstMemoryWrite = await fetch(`${firstServer.baseUrl}/v1/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryRoute,
        action: 'remember',
        text: 'memory persisted before restart',
      }),
    });
    assert.equal(firstMemoryWrite.status, 200);

    await stopProcess(firstServer.child);
    const secondServer = await startServer(dataDir);
    processes.push(secondServer.child);
    assert.deepEqual(secondServer.health.storage.migration, {
      deliveryImported: false,
      pairingImported: false,
      accessImported: false,
      memoryImported: false,
      routinesImported: false,
      workflowsImported: false,
    });
    const afterRestart = await fetch(
      `${secondServer.baseUrl}/v1/runs?limit=20`,
    ).then((response) => response.json());
    assert.equal(
      afterRestart.runs.find((run) => run.id === queued.run.id)?.status,
      'completed',
    );
    const memoryQuery = new URLSearchParams(memoryRoute);
    const persistedMemory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    assert.match(
      persistedMemory.snapshot.scopes[0].content,
      /memory persisted before restart/,
    );
    assert.equal(persistedMemory.history.document.version, 1);
    assert.equal(
      persistedMemory.history.revisions[0].actorId,
      'operator:local-development',
    );
    assert.equal(persistedMemory.history.revisions[0].source, 'operator-api');

    await fetch(`${secondServer.baseUrl}/v1/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryRoute,
        action: 'remember',
        text: 'temporary second version',
      }),
    });
    const restoreResponse = await fetch(`${secondServer.baseUrl}/v1/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryRoute,
        action: 'restore',
        revisionId: persistedMemory.history.revisions[0].id,
      }),
    });
    assert.equal(restoreResponse.status, 200);
    const restoredMemory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    assert.equal(restoredMemory.history.document.version, 3);
    assert.equal(restoredMemory.history.revisions[0].action, 'restore');
    assert.doesNotMatch(
      restoredMemory.snapshot.scopes[0].content,
      /temporary second version/,
    );
  },
);
