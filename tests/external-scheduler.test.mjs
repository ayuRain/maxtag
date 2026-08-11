import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteOpenTagStore } from '../packages/storage-sqlite/dist/index.js';

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
      throw new Error(`server exited early (${child.exitCode})\n${logs.join('')}`);
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
  throw new Error(
    `timed out waiting for ${url}: ${lastError?.message}\n${logs.join('')}`,
  );
}

async function runProcess(script, env, timeoutMs = 10_000) {
  const child = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timeout);
  assert.equal(
    code,
    0,
    `${script} exited with code=${code} signal=${signal}\n${logs.join('')}`,
  );
  return logs.join('');
}

test(
  'external scheduler and worker share routine state through SQLite WAL',
  { timeout: 30_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opentag-external-scheduler-'),
    );
    const databasePath = path.join(dataDir, 'opentag.sqlite');
    const port = await freePort();
    const serverLogs = [];
    const sharedEnv = {
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_STORAGE_DRIVER: 'sqlite',
      OPENTAG_SQLITE_PATH: databasePath,
      OPENTAG_EXECUTOR_MODE: 'dry-run',
      OPENTAG_LARK_TRANSPORT: 'memory',
    };
    const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...sharedEnv,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_AGENT_WORKER: 'manual',
        OPENTAG_ROUTINE_SCHEDULER: 'external',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()));
    server.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()));
    let store;
    context.after(async () => {
      store?.close();
      if (server.exitCode === null) {
        server.kill('SIGTERM');
        await Promise.race([
          once(server, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForJson(
      `${baseUrl}/health`,
      (data) => data.ok === true,
      server,
      serverLogs,
    );
    assert.equal(health.routines.mode, 'external');
    assert.equal(health.routines.running, false);

    const createResponse = await fetch(`${baseUrl}/v1/routines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'External scheduler digest',
        instructions: 'Summarize external scheduler progress.',
        schedule: { kind: 'interval', everyMinutes: 60 },
        destination: {
          platform: 'lark',
          externalId: 'external-scheduler-chat',
          visibility: 'public',
        },
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    const triggerResponse = await fetch(
      `${baseUrl}/v1/routines/${created.routine.id}/trigger`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(triggerResponse.status, 202);
    const triggered = await triggerResponse.json();
    assert.equal(triggered.schedulerMode, 'external');
    assert.equal(triggered.execution.status, 'pending');
    assert.equal(triggered.tick, undefined);

    const firstSchedulerLog = await runProcess(
      'apps/scheduler/dist/index.js',
      { ...sharedEnv, OPENTAG_SCHEDULER_ONCE: 'true' },
    );
    assert.match(firstSchedulerLog, /"event":"scheduler_tick"/);
    assert.match(firstSchedulerLog, /"queued":1/);

    store = new SqliteOpenTagStore({ databasePath });
    let execution = (
      await store.routineStore.listExecutions({
        routineId: created.routine.id,
      })
    )[0];
    assert.equal(execution.status, 'queued');
    assert.match(execution.runId, /^routine:/);
    assert.equal(
      (await store.deliveryStore.getAgentRun(execution.runId)).status,
      'queued',
    );

    const workerLog = await runProcess('apps/worker/dist/index.js', {
      ...sharedEnv,
      OPENTAG_WORKER_ONCE: 'true',
      OPENTAG_WORKER_BATCH: '5',
    });
    assert.match(workerLog, /"event":"worker_pass"/);
    assert.match(workerLog, /"completed":1/);
    assert.equal(
      (await store.deliveryStore.getAgentRun(execution.runId)).status,
      'completed',
    );
    assert.equal(
      (
        await store.routineStore.listExecutions({
          routineId: created.routine.id,
        })
      )[0].status,
      'queued',
    );

    const reconcileLog = await runProcess(
      'apps/scheduler/dist/index.js',
      { ...sharedEnv, OPENTAG_SCHEDULER_ONCE: 'true' },
    );
    assert.match(reconcileLog, /"reconciled":1/);
    execution = (
      await store.routineStore.listExecutions({
        routineId: created.routine.id,
      })
    )[0];
    assert.equal(execution.status, 'completed');
    assert.match(execution.summary, /Dry-run Codex executor received/);
  },
);

test(
  'external scheduler and workers advance a workflow DAG across processes',
  { timeout: 30_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opentag-external-workflow-'),
    );
    const databasePath = path.join(dataDir, 'opentag.sqlite');
    const port = await freePort();
    const serverLogs = [];
    const sharedEnv = {
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_STORAGE_DRIVER: 'sqlite',
      OPENTAG_SQLITE_PATH: databasePath,
      OPENTAG_EXECUTOR_MODE: 'dry-run',
      OPENTAG_LARK_TRANSPORT: 'memory',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_WORKFLOWS_ENABLED: 'true',
    };
    const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...sharedEnv,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_AGENT_WORKER: 'manual',
        OPENTAG_WORKFLOW_COORDINATOR: 'external',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()));
    server.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()));
    let store;
    context.after(async () => {
      store?.close();
      if (server.exitCode === null) {
        server.kill('SIGTERM');
        await Promise.race([
          once(server, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForJson(
      `${baseUrl}/health`,
      (data) => data.ok === true,
      server,
      serverLogs,
    );
    assert.equal(health.workflows.mode, 'external');

    const createResponse = await fetch(`${baseUrl}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'External workflow',
        trigger: { kind: 'manual' },
        nodes: [
          { id: 'analyze', instructions: 'Analyze the external input.' },
          {
            id: 'publish',
            instructions: 'Publish the result.',
            dependsOn: ['analyze'],
          },
        ],
        destination: {
          platform: 'lark',
          externalId: 'external-workflow-chat',
          visibility: 'public',
        },
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    const triggerResponse = await fetch(
      `${baseUrl}/v1/workflows/${created.workflow.id}/trigger`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(triggerResponse.status, 202);
    const triggered = await triggerResponse.json();
    assert.equal(triggered.coordinatorMode, 'external');
    assert.equal(triggered.execution.status, 'pending');

    const schedulerLog = await runProcess('apps/scheduler/dist/index.js', {
      ...sharedEnv,
      OPENTAG_SCHEDULER_ONCE: 'true',
    });
    assert.match(schedulerLog, /"event":"workflow_tick"/);
    assert.match(schedulerLog, /"queued":1/);

    store = new SqliteOpenTagStore({ databasePath });
    let execution = await store.workflowStore.getExecution(
      triggered.execution.id,
    );
    assert.deepEqual(
      execution.nodes.map((node) => node.status),
      ['queued', 'pending'],
    );

    await runProcess('apps/worker/dist/index.js', {
      ...sharedEnv,
      OPENTAG_WORKER_ONCE: 'true',
    });
    execution = await store.workflowStore.getExecution(triggered.execution.id);
    assert.deepEqual(
      execution.nodes.map((node) => node.status),
      ['completed', 'queued'],
    );
    assert.equal(
      (
        await store.deliveryStore.getAgentRun(
          `workflow:${execution.id}:publish`,
        )
      ).platform,
      'lark',
    );

    await runProcess('apps/worker/dist/index.js', {
      ...sharedEnv,
      OPENTAG_WORKER_ONCE: 'true',
    });
    execution = await store.workflowStore.getExecution(triggered.execution.id);
    assert.equal(execution.status, 'completed');
    assert.ok(execution.nodes.every((node) => node.status === 'completed'));
  },
);
