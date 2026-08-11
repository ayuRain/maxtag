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

async function waitForJson(url, predicate, child, logs, timeoutMs = 10_000) {
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

function workflowPayload(overrides = {}) {
  return {
    workspaceId: 'dev-workspace',
    projectId: 'opentag',
    name: 'Build failure triage',
    trigger: { kind: 'manual' },
    nodes: [
      {
        id: 'analyze',
        name: 'Analyze',
        instructions: 'Analyze the failed build evidence.',
      },
      {
        id: 'publish',
        name: 'Publish',
        instructions: 'Publish the likely cause and next action.',
        dependsOn: ['analyze'],
      },
    ],
    destination: {
      platform: 'lark',
      externalId: 'workflow-chat',
      channelId: 'workflow-chat',
      visibility: 'public',
    },
    ...overrides,
  };
}

test(
  'workflow API executes a DAG and dedupes typed event triggers',
  { timeout: 30_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opentag-workflow-api-'),
    );
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
        OPENTAG_LARK_TRANSPORT: 'memory',
        OPENTAG_AGENT_WORKER: 'inline',
        OPENTAG_AGENT_WORKER_INTERVAL_MS: '25',
        OPENTAG_WORKFLOW_COORDINATOR: 'inline',
        OPENTAG_WORKFLOW_TICK_INTERVAL_MS: '600000',
        OPENTAG_WORKFLOW_INGRESS_TOKEN: 'workflow-test-secret',
        OPENTAG_ROUTINE_SCHEDULER: 'manual',
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
    const health = await waitForJson(
      `${baseUrl}/health`,
      (data) => data.ok === true,
      child,
      logs,
    );
    assert.equal(health.workflows.mode, 'inline');
    assert.equal(health.security.workflowIngress.mode, 'bearer');

    const createResponse = await fetch(`${baseUrl}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowPayload()),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();

    const triggerResponse = await fetch(
      `${baseUrl}/v1/workflows/${created.workflow.id}/trigger`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { build: 481, branch: 'main' } }),
      },
    );
    assert.equal(triggerResponse.status, 202);
    const triggered = await triggerResponse.json();
    assert.equal(triggered.accepted, true);
    assert.equal(triggered.tick.queued, 1);

    const completed = await waitForJson(
      `${baseUrl}/v1/workflows?workspaceId=dev-workspace&projectId=opentag`,
      (data) =>
        data.executions.some(
          (execution) =>
            execution.id === triggered.execution.id &&
            execution.status === 'completed',
        ),
      child,
      logs,
    );
    const execution = completed.executions.find(
      (item) => item.id === triggered.execution.id,
    );
    assert.equal(execution.nodes.length, 2);
    assert.ok(execution.nodes.every((node) => node.status === 'completed'));
    const runs = await fetch(`${baseUrl}/v1/runs?limit=20`).then((response) =>
      response.json(),
    );
    const analyzeRun = runs.runs.find(
      (run) => run.id === `workflow:${execution.id}:analyze`,
    );
    const publishRun = runs.runs.find(
      (run) => run.id === `workflow:${execution.id}:publish`,
    );
    assert.equal(analyzeRun.platform, 'workflow');
    assert.equal(publishRun.platform, 'lark');
    assert.match(publishRun.message.text, /Dry-run Codex executor received/);

    const eventCreateResponse = await fetch(`${baseUrl}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        workflowPayload({
          name: 'Alert watcher',
          trigger: { kind: 'event', eventType: 'alert.firing' },
          nodes: [
            {
              id: 'publish',
              instructions: 'Summarize the alert and publish the next action.',
            },
          ],
        }),
      ),
    });
    assert.equal(eventCreateResponse.status, 200);
    const eventBody = {
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      eventType: 'alert.firing',
      eventId: 'alert-42',
      actor: 'spoofed-operator',
      payload: { alert: 'queue_depth_high', value: 97 },
    };
    const unauthorizedEvent = await fetch(`${baseUrl}/v1/workflow-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(eventBody),
    });
    assert.equal(unauthorizedEvent.status, 401);
    const firstEvent = await fetch(`${baseUrl}/v1/workflow-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer workflow-test-secret',
      },
      body: JSON.stringify(eventBody),
    }).then((response) => response.json());
    const duplicateEvent = await fetch(`${baseUrl}/v1/workflow-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer workflow-test-secret',
      },
      body: JSON.stringify(eventBody),
    }).then((response) => response.json());
    assert.equal(firstEvent.staged.length, 1);
    assert.equal(duplicateEvent.staged.length, 0);
    assert.equal(duplicateEvent.duplicates[0].id, firstEvent.staged[0].id);
    const eventCompleted = await waitForJson(
      `${baseUrl}/v1/workflows?workspaceId=dev-workspace&projectId=opentag`,
      (data) =>
        data.executions.some(
          (item) =>
            item.id === firstEvent.staged[0].id && item.status === 'completed',
        ),
      child,
      logs,
    );
    const eventExecution = eventCompleted.executions.find(
      (item) => item.id === firstEvent.staged[0].id,
    );
    assert.equal(
      eventExecution.trigger.actor,
      'workflow-ingress:alert.firing',
    );
  },
);
