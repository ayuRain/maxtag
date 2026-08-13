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
        OPENTAG_ALERTMANAGER_INGRESS_TOKEN: 'alertmanager-test-secret',
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
    assert.equal(health.security.alertmanagerIngress.mode, 'bearer');

    const bindingResponse = await fetch(`${baseUrl}/v1/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'lark',
        externalId: 'workflow-chat',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        activationMode: 'always',
        requireMention: false,
      }),
    });
    assert.equal(bindingResponse.status, 200);

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

    const alertWorkflowResponse = await fetch(`${baseUrl}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        workflowPayload({
          name: 'Alertmanager incident triage',
          trigger: { kind: 'event', eventType: 'alertmanager.firing' },
          nodes: [
            {
              id: 'publish',
              instructions: 'Summarize this Alertmanager incident.',
            },
          ],
        }),
      ),
    });
    assert.equal(alertWorkflowResponse.status, 200);
    const routeResponse = await fetch(`${baseUrl}/v1/workflow-producers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'alertmanager',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'Production alerts',
      }),
    });
    assert.equal(routeResponse.status, 200);
    const route = (await routeResponse.json()).route;
    const alertmanagerBody = {
      version: '4',
      receiver: 'opentag',
      status: 'firing',
      groupKey: '{}:{alertname="QueueDepthHigh"}',
      groupLabels: { alertname: 'QueueDepthHigh' },
      commonLabels: { severity: 'critical', service: 'worker' },
      commonAnnotations: { summary: 'Queue depth is high' },
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'QueueDepthHigh', instance: 'worker-a' },
          annotations: { summary: 'Depth 97' },
          startsAt: '2026-08-13T01:00:00.000Z',
          endsAt: '0001-01-01T00:00:00Z',
          fingerprint: 'queue-worker-a',
        },
      ],
      workspaceId: 'spoofed-workspace',
      projectId: 'spoofed-project',
    };
    const alertUrl = `${baseUrl}/v1/alertmanager/${route.id}/events`;
    const unauthorizedAlert = await fetch(alertUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(alertmanagerBody),
    });
    assert.equal(unauthorizedAlert.status, 401);
    const postAlert = () =>
      fetch(alertUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer alertmanager-test-secret',
        },
        body: JSON.stringify(alertmanagerBody),
      });
    const firstAlertResponse = await postAlert();
    assert.equal(firstAlertResponse.status, 202);
    const firstAlert = await firstAlertResponse.json();
    const duplicateAlert = await (await postAlert()).json();
    assert.equal(firstAlert.route.workspaceId, 'dev-workspace');
    assert.equal(firstAlert.route.projectId, 'opentag');
    assert.equal(firstAlert.staged.length, 1);
    assert.equal(duplicateAlert.duplicate, true);
    assert.equal(duplicateAlert.staged.length, 0);
    assert.equal(
      duplicateAlert.duplicates[0].id,
      firstAlert.staged[0].id,
    );
    const alertSnapshot = await waitForJson(
      `${baseUrl}/v1/workflows?workspaceId=dev-workspace&projectId=opentag`,
      (data) =>
        data.executions.some(
          (item) => item.id === firstAlert.staged[0].id,
        ),
      child,
      logs,
    );
    const alertExecution = alertSnapshot.executions.find(
      (item) => item.id === firstAlert.staged[0].id,
    );
    assert.equal(alertExecution.workflow.workspaceId, 'dev-workspace');
    assert.equal(alertExecution.workflow.projectId, 'opentag');
    assert.equal(alertExecution.trigger.producer, 'alertmanager-webhook');
    assert.equal(alertExecution.input.provider, 'alertmanager');
    assert.equal('workspaceId' in alertExecution.input, false);
    assert.equal('projectId' in alertExecution.input, false);

    const disableResponse = await fetch(`${baseUrl}/v1/workflow-producers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...route, enabled: false }),
    });
    assert.equal(disableResponse.status, 200);
    const changedAlertResponse = await fetch(alertUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer alertmanager-test-secret',
      },
      body: JSON.stringify({
        ...alertmanagerBody,
        alerts: [
          {
            ...alertmanagerBody.alerts[0],
            annotations: { summary: 'Depth 101' },
          },
        ],
      }),
    });
    assert.equal(changedAlertResponse.status, 202);
    assert.equal(
      (await changedAlertResponse.json()).reason,
      'workflow_producer_route_disabled',
    );
  },
);

test(
  'Lark document producer establishes a baseline and stages a changed revision through SQLite',
  { timeout: 30_000 },
  async (context) => {
    let revision = 11;
    let content = 'Initial release plan';
    const larkServer = net.createServer((socket) => {
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString();
        if (!request.includes('\r\n\r\n')) return;
        const requestLine = request.split('\r\n', 1)[0];
        const pathname = requestLine.split(' ')[1] || '/';
        let body;
        if (pathname.includes('/auth/v3/tenant_access_token/internal')) {
          body = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
        } else if (pathname.endsWith('/raw_content')) {
          body = { code: 0, data: { content } };
        } else if (pathname.includes('/docx/v1/documents/dox_release_plan')) {
          body = {
            code: 0,
            data: {
              document: {
                document_id: 'dox_release_plan',
                revision_id: revision,
                title: 'Release plan',
              },
            },
          };
        } else {
          body = { code: 404, msg: 'not found' };
        }
        const encoded = JSON.stringify(body);
        socket.end(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(encoded)}\r\nconnection: close\r\n\r\n${encoded}`,
        );
      });
    });
    await new Promise((resolve, reject) => {
      larkServer.once('error', reject);
      larkServer.listen(0, '127.0.0.1', resolve);
    });
    const larkAddress = larkServer.address();
    const larkPort =
      typeof larkAddress === 'object' && larkAddress
        ? larkAddress.port
        : undefined;
    assert.ok(larkPort);
    context.after(
      () =>
        new Promise((resolve) => {
          larkServer.close(() => resolve());
          larkServer.closeAllConnections?.();
        }),
    );

    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opentag-lark-document-api-'),
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
        OPENTAG_AGENT_WORKER: 'manual',
        OPENTAG_ROUTINE_SCHEDULER: 'manual',
        OPENTAG_WORKFLOW_COORDINATOR: 'manual',
        OPENTAG_LARK_TRANSPORT: 'http',
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'test-secret',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${larkPort}`,
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
    const projectResponse = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'MaxTag',
        capabilityMode: 'custom',
        tools: ['lark-docs'],
        toolConstraints: {
          'lark-docs': {
            documentIds: ['dox_release_plan'],
            permissions: ['read'],
          },
        },
      }),
    });
    assert.equal(projectResponse.status, 200);

    const workflowResponse = await fetch(`${baseUrl}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        workflowPayload({
          name: 'Release plan reviewer',
          trigger: { kind: 'event', eventType: 'lark.document.changed' },
          nodes: [
            {
              id: 'review',
              instructions: 'Review the changed release plan.',
              publish: false,
            },
          ],
        }),
      ),
    });
    assert.equal(workflowResponse.status, 200);

    const producerResponse = await fetch(`${baseUrl}/v1/workflow-producers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'lark-document',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'Release plan',
        documentId: 'dox_release_plan',
        pollIntervalSeconds: 60,
      }),
    });
    assert.equal(producerResponse.status, 200);

    const baseline = await fetch(`${baseUrl}/v1/workflows/tick`, {
      method: 'POST',
    }).then((response) => response.json());
    assert.equal(baseline.documentWatcher.watcher.baseline, 1);
    assert.equal(baseline.documentWatcher.watcher.staged, 0);

    revision = 12;
    content = 'Release on Friday after the canary passes.';
    const changed = await fetch(`${baseUrl}/v1/workflows/tick`, {
      method: 'POST',
    }).then((response) => response.json());
    assert.equal(changed.documentWatcher.watcher.changed, 1);
    assert.equal(changed.documentWatcher.watcher.staged, 1);
    const execution = changed.workflows.executions.find(
      (item) => item.trigger.eventId === 'dox_release_plan:12',
    );
    assert.ok(execution);
    assert.equal(execution.input.revisionId, 12);
    assert.equal(execution.input.previousRevisionId, 11);
    assert.equal(execution.input.content, content);
    assert.equal(changed.workflows.producerRuntime[0].lastRevisionId, 12);
    assert.equal(changed.workflows.producerRuntime[0].failureCount, 0);
  },
);

test(
  'workflow control API retries a failed node and durably cancels its new attempt',
  { timeout: 30_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opentag-workflow-controls-'),
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
        OPENTAG_AGENT_WORKER: 'manual',
        OPENTAG_WORKFLOW_COORDINATOR: 'inline',
        OPENTAG_WORKFLOW_TICK_INTERVAL_MS: '600000',
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
    await waitForJson(`${baseUrl}/health`, (data) => data.ok === true, child, logs);
    const created = await fetch(`${baseUrl}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        workflowPayload({
          name: 'Recoverable publish',
          nodes: [{ id: 'publish', name: 'Publish', instructions: 'Publish it.' }],
          destination: {
            platform: 'lark',
            externalId: 'workflow-control-chat',
            channelId: 'workflow-control-chat',
            visibility: 'public',
          },
        }),
      ),
    }).then((response) => response.json());
    const triggered = await fetch(
      `${baseUrl}/v1/workflows/${created.workflow.id}/trigger`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    ).then((response) => response.json());
    assert.equal(triggered.execution.status, 'failed');
    assert.equal(
      triggered.execution.nodes[0].error,
      'workflow_destination_binding_required',
    );

    const binding = await fetch(`${baseUrl}/v1/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'lark',
        externalId: 'workflow-control-chat',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        activationMode: 'always',
        requireMention: false,
      }),
    });
    assert.equal(binding.status, 200);
    const retryResponse = await fetch(
      `${baseUrl}/v1/workflow-executions/${triggered.execution.id}/nodes/publish/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'binding configured' }),
      },
    );
    assert.equal(retryResponse.status, 202);
    const retried = await retryResponse.json();
    const retryRunId = `workflow:${triggered.execution.id}:publish:attempt-2`;
    assert.equal(retried.nextAttempt, 2);
    assert.equal(retried.execution.nodes[0].runId, retryRunId);
    assert.deepEqual(retried.execution.nodes[0].runIds, [retryRunId]);

    const cancelResponse = await fetch(
      `${baseUrl}/v1/workflow-executions/${triggered.execution.id}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'operator stopped recovery' }),
      },
    );
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json();
    assert.equal(cancelled.execution.status, 'cancelled');
    assert.deepEqual(cancelled.activeRunIds, [retryRunId]);
    assert.equal(cancelled.runs[0].run.status, 'cancelled');
    const duplicateCancel = await fetch(
      `${baseUrl}/v1/workflow-executions/${triggered.execution.id}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    ).then((response) => response.json());
    assert.equal(duplicateCancel.changed, false);
    assert.deepEqual(duplicateCancel.activeRunIds, [retryRunId]);
    assert.equal(duplicateCancel.runs[0].run.status, 'cancelled');

    const audit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&category=workflow`,
    ).then((response) => response.json());
    assert.ok(
      audit.entries.some(
        (entry) => entry.action === 'workflow.node.retried' && entry.referenceId === triggered.execution.id,
      ),
    );
    assert.ok(
      audit.entries.some(
        (entry) =>
          entry.action === 'workflow.execution.cancelled' &&
          entry.referenceId === triggered.execution.id,
      ),
    );
  },
);
