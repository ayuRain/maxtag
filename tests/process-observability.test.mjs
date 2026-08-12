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

function launch(script, environment) {
  const logs = [];
  const child = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

async function waitFor(url, child, logs, predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`process exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url, {
        headers: options.token
          ? { authorization: `Bearer ${options.token}` }
          : undefined,
      });
      const body = options.text ? await response.text() : await response.json();
      if (response.ok && predicate(body, response)) return body;
      lastError = new Error(`unexpected response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message}\n${logs.join('')}`);
}

async function stopProcess(processInfo) {
  if (processInfo.child.exitCode !== null) return processInfo.child.exitCode;
  processInfo.child.kill('SIGTERM');
  const [code] = await Promise.race([
    once(processInfo.child, 'exit'),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`shutdown timeout\n${processInfo.logs.join('')}`)),
        4_000,
      ),
    ),
  ]);
  return code;
}

test(
  'server, worker, and scheduler expose authenticated metrics and stop cleanly',
  { timeout: 30_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-processes-'));
    const [serverPort, workerPort, schedulerPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    const metricsToken = 'process-metrics-token';
    const shared = {
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_STORAGE_DRIVER: 'sqlite',
      OPENTAG_SQLITE_PATH: path.join(dataDir, 'opentag.sqlite'),
      OPENTAG_EXECUTOR_MODE: 'dry-run',
      OPENTAG_LARK_TRANSPORT: 'memory',
      OPENTAG_TELEGRAM_TRANSPORT: 'memory',
      OPENTAG_GITHUB_TRANSPORT: 'memory',
      OPENTAG_METRICS_TOKEN: metricsToken,
      OPENTAG_OBSERVABILITY_HOST: '127.0.0.1',
      OPENTAG_ROUTINES_ENABLED: 'true',
      OPENTAG_WORKFLOWS_ENABLED: 'true',
    };
    const processes = [
      launch('apps/server/dist/index.js', {
        ...shared,
        OPENTAG_PORT: String(serverPort),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_ADMIN_TOKEN: '',
        OPENTAG_AGENT_WORKER: 'manual',
        OPENTAG_ROUTINE_SCHEDULER: 'external',
        OPENTAG_WORKFLOW_COORDINATOR: 'external',
      }),
      launch('apps/worker/dist/index.js', {
        ...shared,
        OPENTAG_WORKER_OBSERVABILITY_PORT: String(workerPort),
        OPENTAG_WORKER_INTERVAL_MS: '50',
      }),
      launch('apps/scheduler/dist/index.js', {
        ...shared,
        OPENTAG_SCHEDULER_OBSERVABILITY_PORT: String(schedulerPort),
        OPENTAG_ROUTINE_TICK_INTERVAL_MS: '100',
        OPENTAG_WORKFLOW_TICK_INTERVAL_MS: '50',
      }),
    ];
    context.after(async () => {
      await Promise.allSettled(processes.map(stopProcess));
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const endpoints = [
      {
        name: 'opentag-server',
        port: serverPort,
        process: processes[0],
        loop: 'agent_worker',
      },
      {
        name: 'opentag-worker',
        port: workerPort,
        process: processes[1],
        loop: 'agent_worker',
      },
      {
        name: 'opentag-scheduler',
        port: schedulerPort,
        process: processes[2],
        loop: 'routine_scheduler',
      },
    ];

    for (const endpoint of endpoints) {
      const baseUrl = `http://127.0.0.1:${endpoint.port}`;
      const health = await waitFor(
        `${baseUrl}/health`,
        endpoint.process.child,
        endpoint.process.logs,
        (body) => body.ok === true && body.service === endpoint.name,
      );
      assert.equal(health.storage.driver, 'sqlite');

      const anonymous = await fetch(`${baseUrl}/metrics`);
      assert.equal(anonymous.status, 401);
      const metrics = await waitFor(
        `${baseUrl}/metrics`,
        endpoint.process.child,
        endpoint.process.logs,
        (body, response) =>
          response.headers
            .get('content-type')
            ?.startsWith('text/plain; version=0.0.4') &&
          body.includes(
            `opentag_process_up{service="${endpoint.name}"} 1`,
          ) &&
          body.includes(
            `opentag_runtime_loop_iterations_total{loop="${endpoint.loop}",service="${endpoint.name}"}`,
          ),
        { token: metricsToken, text: true },
      );
      assert.match(metrics, /opentag_agent_runs/);
      assert.match(metrics, /opentag_delivery_outbox_records/);
    }

    const workerMetrics = await waitFor(
      `http://127.0.0.1:${workerPort}/metrics`,
      processes[1].child,
      processes[1].logs,
      (body) =>
        /opentag_runtime_loop_iterations_total\{loop="agent_worker",service="opentag-worker"\} [1-9]/.test(
          body,
        ),
      { token: metricsToken, text: true },
    );
    assert.match(workerMetrics, /opentag_storage_info/);

    const schedulerMetrics = await waitFor(
      `http://127.0.0.1:${schedulerPort}/metrics`,
      processes[2].child,
      processes[2].logs,
      (body) =>
        /opentag_runtime_loop_iterations_total\{loop="workflow_coordinator",service="opentag-scheduler"\} [1-9]/.test(
          body,
        ),
      { token: metricsToken, text: true },
    );
    assert.match(schedulerMetrics, /opentag_routine_executions/);

    const exitCodes = await Promise.all(processes.map(stopProcess));
    assert.deepEqual(exitCodes, [0, 0, 0]);
    assert.match(processes[0].logs.join(''), /OpenTag server stopped/);
    assert.match(processes[1].logs.join(''), /"event":"stopped"/);
    assert.match(processes[2].logs.join(''), /"event":"stopped"/);
  },
);
