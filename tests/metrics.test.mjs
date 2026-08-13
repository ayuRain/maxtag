import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDeliveryStore } from '@opentag/delivery';
import {
  renderOpenTagPrometheusMetrics,
  startOpenTagObservabilityServer,
} from '@opentag/runtime-host';

function deliverySummary() {
  return {
    outbox: { pending: 1, sending: 0, delivered: 4, failed: 0, cancelled: 0 },
    turnDeliveries: {
      queued: 1,
      accepted: 0,
      completed: 4,
      failed: 0,
      cancelled: 0,
    },
    inboundEvents: {
      received: 1,
      processed: 4,
      ignored: 0,
      failed: 0,
      rejected: 0,
      duplicates: 2,
    },
    workflowProducers: {
      received: 3,
      staged: 2,
      unmatched: 1,
      duplicates: 1,
      ignored: 0,
      failed: 0,
    },
    agentRuns: {
      queued: 2,
      running: 1,
      cancel_requested: 0,
      completed: 3,
      failed: 0,
      cancelled: 0,
    },
    steering: {
      pending: 1,
      claimed: 0,
      scheduled: 0,
      applied: 2,
      failed: 0,
      cancelled: 0,
    },
    sessions: { active: 1, invalidated: 0 },
    bindings: 3,
    oldestStatusUpdatedAt: {
      outbox: { pending: '2026-08-12T00:00:00.000Z' },
      turnDeliveries: { queued: '2026-08-12T00:00:10.000Z' },
      inboundEvents: { received: '2026-08-12T00:00:20.000Z' },
      agentRuns: {
        queued: '2026-08-12T00:00:30.000Z',
        running: '2026-08-12T00:00:45.000Z',
      },
      steering: { pending: '2026-08-12T00:00:40.000Z' },
      sessions: { active: '2026-08-12T00:00:50.000Z' },
    },
  };
}

function snapshot(service = 'opentag-server') {
  return {
    process: {
      service,
      startedAt: '2026-08-11T23:59:00.000Z',
      activeRuns: 1,
      storage: { driver: 'sqlite', wal: true },
      loops: [
        {
          name: 'agent_worker',
          running: false,
          lastRunAt: '2026-08-12T00:00:55.000Z',
          iterations: 9,
          lastItems: {
            claimed: 1,
            completed: 1,
            failed: 0,
            requeued: 0,
            superseded: 0,
          },
        },
      ],
    },
    delivery: deliverySummary(),
    routines: {
      routines: { enabled: 2, disabled: 1 },
      executions: {
        pending: 1,
        claimed: 0,
        queued: 0,
        running: 0,
        completed: 3,
        failed: 0,
        cancelled: 0,
      },
      notifications: {
        pending: 1,
        claimed: 0,
        delivered: 2,
        failed: 0,
        cancelled: 0,
      },
      oldestExecutionUpdatedAt: {
        pending: '2026-08-12T00:00:35.000Z',
      },
      nextRunAt: '2026-08-12T00:05:00.000Z',
    },
    workflows: {
      producerRoutes: { enabled: 2, disabled: 1 },
      workflows: { active: 1, archived: 0 },
      executions: {
        pending: 0,
        running: 1,
        completed: 2,
        failed: 0,
        cancelled: 0,
      },
      nodes: {
        pending: 1,
        claimed: 1,
        queued: 0,
        running: 1,
        completed: 2,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      oldestExecutionUpdatedAt: {
        running: '2026-08-12T00:00:25.000Z',
      },
      oldestNodeUpdatedAt: {
        claimed: '2026-08-12T00:00:15.000Z',
      },
    },
    delegatedAgentTasks: {
      tasks: {
        queued: 1,
        claimed: 1,
        completed: 2,
        failed: 0,
        cancelled: 0,
        stale: 0,
      },
      oldestStatusUpdatedAt: {
        queued: '2026-08-12T00:00:05.000Z',
        claimed: '2026-08-12T00:00:30.000Z',
      },
    },
    knowledgeSourceRefreshes: {
      jobs: { pending: 1, claimed: 1, completed: 3, failed: 0, stale: 0 },
      oldestStatusUpdatedAt: {
        pending: '2026-08-12T00:00:10.000Z',
        claimed: '2026-08-12T00:00:40.000Z',
      },
    },
  };
}

test('Prometheus renderer emits unique, low-cardinality metric samples', () => {
  const rendered = renderOpenTagPrometheusMetrics(
    snapshot(),
    new Date('2026-08-12T00:01:00.000Z'),
  );
  assert.equal(rendered.endsWith('\n'), true);
  assert.match(
    rendered,
    /opentag_agent_runs\{service="opentag-server",status="queued"\} 2/,
  );
  assert.match(
    rendered,
    /opentag_delivery_outbox_oldest_age_seconds\{service="opentag-server",status="pending"\} 60/,
  );
  assert.match(
    rendered,
    /opentag_delivery_turn_oldest_age_seconds\{service="opentag-server",status="queued"\} 50/,
  );
  assert.match(
    rendered,
    /opentag_delivery_inbound_oldest_age_seconds\{service="opentag-server",status="received"\} 40/,
  );
  assert.match(
    rendered,
    /opentag_agent_session_oldest_age_seconds\{service="opentag-server",status="active"\} 10/,
  );
  assert.match(
    rendered,
    /opentag_agent_run_oldest_age_seconds\{service="opentag-server",status="running"\} 15/,
  );
  assert.match(
    rendered,
    /opentag_workflow_node_oldest_age_seconds\{service="opentag-server",status="claimed"\} 45/,
  );
  assert.match(
    rendered,
    /opentag_workflow_producer_routes\{service="opentag-server",state="enabled"\} 2/,
  );
  assert.match(
    rendered,
    /opentag_routine_notifications\{service="opentag-server",status="pending"\} 1/,
  );
  assert.match(
    rendered,
    /opentag_workflow_producer_events\{result="staged",service="opentag-server"\} 2/,
  );
  assert.match(
    rendered,
    /opentag_delegated_agent_tasks\{service="opentag-server",status="queued"\} 1/,
  );
  assert.match(
    rendered,
    /opentag_delegated_agent_task_oldest_age_seconds\{service="opentag-server",status="claimed"\} 30/,
  );
  assert.match(
    rendered,
    /opentag_knowledge_source_refresh_jobs\{service="opentag-server",status="pending"\} 1/,
  );
  assert.match(
    rendered,
    /opentag_knowledge_source_refresh_oldest_age_seconds\{service="opentag-server",status="claimed"\} 20/,
  );
  assert.doesNotMatch(rendered, /workspaceId|projectId|threadId|runId/);

  const helpFamilies = new Set();
  const samples = new Set();
  for (const line of rendered.trimEnd().split('\n')) {
    if (line.startsWith('# HELP ')) {
      const family = line.split(' ')[2];
      assert.equal(helpFamilies.has(family), false, `duplicate HELP ${family}`);
      helpFamilies.add(family);
    } else if (!line.startsWith('#')) {
      const sample = line.slice(0, line.lastIndexOf(' '));
      assert.equal(samples.has(sample), false, `duplicate sample ${sample}`);
      samples.add(sample);
    }
  }
});

test('Prometheus renderer escapes label values', () => {
  const rendered = renderOpenTagPrometheusMetrics(
    snapshot('opentag-"server\\primary'),
    new Date('2026-08-12T00:01:00.000Z'),
  );
  assert.match(rendered, /service="opentag-\\"server\\\\primary"/);
});

test('observability server keeps health open and protects metrics', async (context) => {
  const server = await startOpenTagObservabilityServer({
    host: '127.0.0.1',
    port: 0,
    service: 'opentag-test',
    metricsToken: 'metrics-test-token',
    health: () => ({ ready: true }),
    metrics: () => snapshot('opentag-test'),
  });
  context.after(() => server.close());
  const baseUrl = `http://${server.host}:${server.port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: 'opentag-test',
    ready: true,
  });

  assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
  assert.equal(
    (
      await fetch(`${baseUrl}/metrics`, {
        headers: { authorization: 'Bearer wrong-token' },
      })
    ).status,
    401,
  );
  const metrics = await fetch(`${baseUrl}/metrics`, {
    headers: { authorization: 'Bearer metrics-test-token' },
  });
  assert.equal(metrics.status, 200);
  assert.match(
    metrics.headers.get('content-type') || '',
    /^text\/plain; version=0\.0\.4/,
  );
  assert.match(await metrics.text(), /opentag_process_up/);
});

test('run leases are owner-fenced and requeue without cancelling work', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lease-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const thread = {
    id: 'lark:payments:lease',
    platform: 'lark',
    externalId: 'payments:lease',
    workspaceId: 'acme',
    projectId: 'payments',
    visibility: 'public',
  };
  await store.createAgentRun({
    runId: 'lease-run',
    thread,
    message: {
      id: 'message-1',
      threadId: thread.id,
      platform: thread.platform,
      text: 'Inspect the deployment.',
      actor: { id: 'ada' },
      createdAt: '2026-08-12T00:00:00.000Z',
    },
  });
  await store.claimQueuedAgentRuns({
    workerId: 'worker-a',
    now: new Date('2026-08-12T00:00:10.000Z'),
  });

  assert.equal(
    await store.renewAgentRunLease('lease-run', {
      workerId: 'worker-b',
      now: new Date('2026-08-12T00:00:20.000Z'),
    }),
    false,
  );
  assert.equal(
    await store.renewAgentRunLease('lease-run', {
      workerId: 'worker-a',
      now: new Date('2026-08-12T00:00:30.000Z'),
    }),
    true,
  );
  assert.equal(
    (await store.summarize()).oldestStatusUpdatedAt.agentRuns.running,
    '2026-08-12T00:00:30.000Z',
  );

  assert.equal(
    (
      await store.requeueAgentRun('lease-run', {
        workerId: 'worker-b',
        now: new Date('2026-08-12T00:00:40.000Z'),
      })
    ).status,
    'running',
  );
  const requeued = await store.requeueAgentRun('lease-run', {
    workerId: 'worker-a',
    reason: 'worker_restart',
    now: new Date('2026-08-12T00:00:50.000Z'),
  });
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.workerId, undefined);
  assert.equal(requeued.lastError, 'worker_restart');
  assert.equal(
    (await store.summarize()).oldestStatusUpdatedAt.agentRuns.queued,
    '2026-08-12T00:00:50.000Z',
  );
});
