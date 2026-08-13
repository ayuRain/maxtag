import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ALERTMANAGER_WORKFLOW_EVENT_CATALOG,
  FileWorkflowStore,
  normalizeAlertmanagerWorkflowEvent,
  normalizeWorkflowNodes,
  trimWorkflowState,
} from '@opentag/workflows';

function workflowInput(overrides = {}) {
  return {
    workspaceId: 'acme',
    projectId: 'payments',
    name: 'Incident triage',
    description: 'Collect, analyze, and publish an incident brief.',
    enabled: true,
    trigger: { kind: 'event', eventType: 'ci.failed' },
    nodes: [
      {
        id: 'collect',
        instructions: 'Collect the failure evidence from the event input.',
      },
      {
        id: 'analyze',
        instructions: 'Analyze the evidence and identify a likely cause.',
        dependsOn: ['collect'],
      },
      {
        id: 'publish',
        instructions: 'Publish a concise incident brief and next action.',
        dependsOn: ['analyze'],
      },
    ],
    destination: {
      platform: 'lark',
      externalId: 'oc_payments',
      channelId: 'oc_payments',
      visibility: 'public',
      title: 'Payments',
    },
    ...overrides,
  };
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-workflows-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new FileWorkflowStore(root) };
}

test('workflow definitions reject unknown dependencies and cycles', () => {
  assert.throws(
    () =>
      normalizeWorkflowNodes([
        { id: 'one', instructions: 'One', dependsOn: ['missing'] },
      ]),
    /workflow_node_unknown_dependency/,
  );
  assert.throws(
    () =>
      normalizeWorkflowNodes([
        { id: 'one', instructions: 'One', dependsOn: ['two'] },
        { id: 'two', instructions: 'Two', dependsOn: ['one'] },
      ]),
    /workflow_dependency_cycle/,
  );
});

test('Alertmanager v4 notifications normalize bounded evidence with stable ordering', () => {
  const body = {
    version: '4',
    receiver: 'opentag',
    status: 'firing',
    groupKey: '{}:{alertname="QueueDepthHigh"}',
    truncatedAlerts: 2,
    groupLabels: { alertname: 'QueueDepthHigh' },
    commonLabels: { severity: 'critical', service: 'worker' },
    commonAnnotations: { summary: 'Queue depth is above threshold' },
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'QueueDepthHigh', instance: 'worker-b' },
        annotations: { summary: 'Depth 98' },
        startsAt: '2026-08-13T01:00:00.000Z',
        endsAt: '0001-01-01T00:00:00Z',
        fingerprint: 'b',
      },
      {
        status: 'firing',
        labels: { alertname: 'QueueDepthHigh', instance: 'worker-a' },
        annotations: { summary: 'Depth 97' },
        startsAt: '2026-08-13T01:00:00.000Z',
        endsAt: '0001-01-01T00:00:00Z',
        fingerprint: 'a',
      },
    ],
    workspaceId: 'spoofed-workspace',
    projectId: 'spoofed-project',
  };
  const first = normalizeAlertmanagerWorkflowEvent(body);
  const reordered = normalizeAlertmanagerWorkflowEvent({
    ...body,
    alerts: [...body.alerts].reverse(),
  });
  assert.equal(first.eventType, 'alertmanager.firing');
  assert.equal(first.eventId, reordered.eventId);
  const manyAlerts = Array.from({ length: 9 }, (_, index) => ({
    ...body.alerts[0],
    labels: { ...body.alerts[0].labels, instance: `worker-${index}` },
    annotations: { summary: `Depth ${90 + index}` },
    fingerprint: `worker-${index}`,
  }));
  const ninthChanged = normalizeAlertmanagerWorkflowEvent({
    ...body,
    alerts: manyAlerts.map((alert, index) =>
      index === 8
        ? { ...alert, annotations: { summary: 'Depth 999' } }
        : alert,
    ),
  });
  assert.notEqual(
    normalizeAlertmanagerWorkflowEvent({ ...body, alerts: manyAlerts }).eventId,
    ninthChanged.eventId,
  );
  assert.equal(ninthChanged.payload.alerts.length, 8);
  assert.equal(ninthChanged.truncatedAlerts, 3);
  assert.equal(first.alertCount, 4);
  assert.equal(first.truncatedAlerts, 2);
  assert.deepEqual(
    first.payload.alerts.map((alert) => alert.fingerprint),
    ['a', 'b'],
  );
  assert.equal('workspaceId' in first.payload, false);
  assert.equal('projectId' in first.payload, false);
  assert.ok(
    ALERTMANAGER_WORKFLOW_EVENT_CATALOG.some(
      (item) => item.value === 'alertmanager.resolved',
    ),
  );
  assert.throws(
    () => normalizeAlertmanagerWorkflowEvent({ ...body, version: '3' }),
    /alertmanager_version_unsupported/u,
  );
});

test('workflow producer routes preserve immutable project scope and audit lifecycle', async (context) => {
  const { store } = await fixture(context);
  const created = await store.upsertProducerRoute({
    kind: 'alertmanager',
    workspaceId: 'acme',
    projectId: 'payments',
    name: 'Payments alerts',
    actor: 'operator:ada',
  });
  const updated = await store.upsertProducerRoute({
    ...created,
    name: 'Payments production alerts',
    enabled: false,
    actor: 'operator:bob',
  });
  assert.equal(updated.enabled, false);
  await assert.rejects(
    store.upsertProducerRoute({
      ...created,
      projectId: 'identity',
      actor: 'operator:bob',
    }),
    /workflow_producer_route_scope_immutable/u,
  );
  assert.equal((await store.summarize('acme')).producerRoutes.disabled, 1);
  const archived = await store.archiveProducerRoute(created.id, 'operator:ada');
  assert.equal(archived.status, 'archived');
  assert.equal((await store.listProducerRoutes({ workspaceId: 'acme' })).length, 0);
  assert.deepEqual(
    (await store.listProducerAudit({ workspaceId: 'acme' })).map(
      (entry) => entry.action,
    ),
    [
      'workflow.producer.archived',
      'workflow.producer.updated',
      'workflow.producer.created',
    ],
  );
});

test('Lark document producer routes preserve immutable document identity and fence claims', async (context) => {
  const { store } = await fixture(context);
  const created = await store.upsertProducerRoute(
    {
      kind: 'lark-document',
      workspaceId: 'acme',
      projectId: 'payments',
      name: 'Payments plan',
      documentId: 'dox-payments',
      pollIntervalSeconds: 15,
    },
    new Date('2026-08-13T01:00:00.000Z'),
  );
  assert.equal(created.pollIntervalSeconds, 30);
  await assert.rejects(
    store.upsertProducerRoute({
      ...created,
      documentId: 'dox-other',
    }),
    /workflow_producer_route_scope_immutable/u,
  );
  const claimed = await store.claimDueProducerRoutes(
    { kind: 'lark-document', claimerId: 'watcher-a' },
    new Date('2026-08-13T01:00:00.000Z'),
  );
  assert.equal(claimed.length, 1);
  assert.equal(
    (
      await store.claimDueProducerRoutes(
        { kind: 'lark-document', claimerId: 'watcher-b' },
        new Date('2026-08-13T01:00:30.000Z'),
      )
    ).length,
    0,
  );
  await assert.rejects(
    store.completeProducerPoll(
      {
        routeId: created.id,
        claimerId: 'watcher-b',
        revisionId: 1,
      },
      new Date('2026-08-13T01:00:31.000Z'),
    ),
    /workflow_producer_claim_lost/u,
  );
  await store.completeProducerPoll(
    {
      routeId: created.id,
      claimerId: 'watcher-a',
      revisionId: 1,
      contentHash: 'hash-1',
    },
    new Date('2026-08-13T01:00:31.000Z'),
  );
  const runtime = (await store.listProducerRuntime())[0];
  assert.equal(runtime.lastRevisionId, 1);
  assert.equal(runtime.nextPollAt, '2026-08-13T01:01:01.000Z');
  assert.equal((await store.summarize('acme')).producerRuntime.ready, 1);
});

test('event workflows dedupe triggers and advance dependency-ready nodes', async (context) => {
  const { store } = await fixture(context);
  const workflow = await store.upsertWorkflow(workflowInput(), new Date('2026-08-12T01:00:00.000Z'));
  const event = {
    workspaceId: 'acme',
    projectId: 'payments',
    eventType: 'ci.failed',
    eventId: 'build-481',
    payload: { repository: 'acme/payments', run: 481 },
    producer: 'github-webhook',
    sourceExternalId: 'acme/payments',
  };
  const first = await store.triggerEvent(event, new Date('2026-08-12T01:01:00.000Z'));
  const duplicate = await store.triggerEvent(event, new Date('2026-08-12T01:02:00.000Z'));
  assert.equal(first.matched, 1);
  assert.equal(first.staged.length, 1);
  assert.equal(duplicate.staged.length, 0);
  assert.equal(duplicate.duplicates[0].id, first.staged[0].id);
  assert.equal(first.staged[0].trigger.producer, 'github-webhook');
  assert.equal(first.staged[0].trigger.sourceExternalId, 'acme/payments');
  const audit = await store.listAudit({ workspaceId: 'acme' });
  assert.equal(audit[0].action, 'workflow.event.staged');
  assert.equal(audit[0].executionId, first.staged[0].id);
  assert.equal(audit[0].eventType, 'ci.failed');

  const collect = await store.claimReadyNodes({
    claimerId: 'scheduler-a',
    at: new Date('2026-08-12T01:03:00.000Z'),
  });
  assert.deepEqual(collect.map((claim) => claim.node.id), ['collect']);
  assert.equal(collect[0].publish, false);
  await store.markNodeQueued(collect[0].nodeExecution.id, 'run-collect');
  await store.reconcileNodeRun({
    runId: 'run-collect',
    status: 'completed',
    summary: 'Collected build logs.',
  });

  const analyze = await store.claimReadyNodes({
    claimerId: 'scheduler-a',
    at: new Date('2026-08-12T01:04:00.000Z'),
  });
  assert.deepEqual(analyze.map((claim) => claim.node.id), ['analyze']);
  assert.deepEqual(analyze[0].upstream, [
    { nodeId: 'collect', summary: 'Collected build logs.' },
  ]);
  assert.equal(
    (
      await store.claimReadyNodes({
        claimerId: 'scheduler-b',
        staleAfterMs: 120_000,
        at: new Date('2026-08-12T01:05:00.000Z'),
      })
    ).length,
    0,
  );
  const reclaimed = await store.claimReadyNodes({
    claimerId: 'scheduler-b',
    staleAfterMs: 120_000,
    at: new Date('2026-08-12T01:07:00.000Z'),
  });
  assert.equal(reclaimed[0].nodeExecution.id, analyze[0].nodeExecution.id);
  assert.equal(reclaimed[0].nodeExecution.attempts, 2);
  await store.markNodeQueued(reclaimed[0].nodeExecution.id, 'run-analyze');
  await store.reconcileNodeRun({
    runId: 'run-analyze',
    status: 'completed',
    summary: 'The deployment used an expired credential.',
  });

  const publish = await store.claimReadyNodes({ claimerId: 'scheduler-b' });
  assert.deepEqual(publish.map((claim) => claim.node.id), ['publish']);
  assert.equal(publish[0].publish, true);
  await store.markNodeQueued(publish[0].nodeExecution.id, 'run-publish');
  await store.reconcileNodeRun({
    runId: 'run-publish',
    status: 'completed',
    summary: 'Rotate the credential and rerun build 481.',
  });

  const execution = await store.getExecution(first.staged[0].id);
  assert.equal(execution.status, 'completed');
  assert.equal(execution.summary, 'Rotate the credential and rerun build 481.');
  assert.equal(execution.workflowVersion, workflow.version);
  const summary = await store.summarize('acme', 'payments');
  assert.equal(summary.executions.completed, 1);
  assert.equal(summary.oldestExecutionUpdatedAt.completed, execution.updatedAt);
  assert.equal(
    summary.oldestNodeUpdatedAt.completed,
    execution.nodes
      .filter((node) => node.status === 'completed')
      .map((node) => node.updatedAt)
      .sort()[0],
  );
});

test('a failed node skips dependants and preserves the workflow snapshot', async (context) => {
  const { store } = await fixture(context);
  const workflow = await store.upsertWorkflow(workflowInput());
  await assert.rejects(
    store.upsertWorkflow(
      workflowInput({ id: workflow.id, workspaceId: 'another-workspace' }),
    ),
    /workflow_workspace_immutable/,
  );
  const execution = await store.triggerWorkflow(workflow.id, {
    actor: 'operator:ada',
    payload: { incident: 'INC-42' },
  });
  await store.upsertWorkflow(
    workflowInput({
      id: workflow.id,
      name: 'Updated incident triage',
      actor: 'operator:bob',
    }),
  );
  const [claim] = await store.claimReadyNodes({ claimerId: 'scheduler' });
  await store.markNodeFailed(claim.nodeExecution.id, 'evidence_source_unavailable');

  const failed = await store.getExecution(execution.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.workflow.name, 'Incident triage');
  assert.deepEqual(
    failed.nodes.map((node) => node.status),
    ['failed', 'skipped', 'skipped'],
  );
  assert.match(failed.error, /evidence_source_unavailable/);
});

test('failed nodes retry with durable attempt history and reset only blocked descendants', async (context) => {
  const { store } = await fixture(context);
  const workflow = await store.upsertWorkflow(workflowInput());
  const execution = await store.triggerWorkflow(workflow.id);
  const [firstClaim] = await store.claimReadyNodes({ claimerId: 'scheduler-a' });
  await store.markNodeQueued(firstClaim.nodeExecution.id, 'run-collect-1');
  await store.reconcileNodeRun({
    runId: 'run-collect-1',
    status: 'failed',
    error: 'temporary_provider_failure',
  });

  const retried = await store.retryNode(
    execution.id,
    'collect',
    { actor: 'operator:ada', reason: 'provider recovered' },
    new Date('2026-08-12T02:00:00.000Z'),
  );
  assert.deepEqual(retried.resetNodeIds, ['collect', 'analyze', 'publish']);
  assert.equal(retried.nextAttempt, 2);
  const [secondClaim] = await store.claimReadyNodes({
    claimerId: 'scheduler-b',
    at: new Date('2026-08-12T02:01:00.000Z'),
  });
  assert.equal(secondClaim.node.id, 'collect');
  assert.equal(secondClaim.nodeExecution.attempts, 2);
  assert.equal(secondClaim.nodeExecution.retryCount, 1);
  await store.markNodeQueued(secondClaim.nodeExecution.id, 'run-collect-2');
  const current = await store.getExecution(execution.id);
  assert.deepEqual(current.nodes[0].runIds, ['run-collect-1', 'run-collect-2']);
  assert.equal(current.nodes[0].runId, 'run-collect-2');

  await store.reconcileNodeRun({
    runId: 'run-collect-1',
    status: 'completed',
    summary: 'late stale result',
  });
  assert.equal((await store.getExecution(execution.id)).nodes[0].status, 'queued');
  const audit = (await store.listAudit({ workspaceId: 'acme' })).find(
    (entry) => entry.action === 'workflow.node.retried',
  );
  assert.equal(audit.nodeId, 'collect');
  assert.equal(audit.attempt, 2);
});

test('execution cancellation is idempotent and late run results cannot revive it', async (context) => {
  const { store } = await fixture(context);
  const workflow = await store.upsertWorkflow(workflowInput());
  const execution = await store.triggerWorkflow(workflow.id);
  const [claim] = await store.claimReadyNodes({ claimerId: 'scheduler' });
  await store.markNodeQueued(claim.nodeExecution.id, 'run-active');

  const cancelled = await store.cancelExecution(execution.id, {
    actor: 'operator:ada',
    reason: 'incident resolved',
  });
  assert.equal(cancelled.changed, true);
  assert.deepEqual(cancelled.activeRunIds, ['run-active']);
  assert.equal(cancelled.execution.status, 'cancelled');
  assert.deepEqual(
    cancelled.execution.nodes.map((node) => node.status),
    ['cancelled', 'cancelled', 'cancelled'],
  );
  const duplicate = await store.cancelExecution(execution.id);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(duplicate.activeRunIds, ['run-active']);
  await store.reconcileNodeRun({
    runId: 'run-active',
    status: 'completed',
    summary: 'late result',
  });
  assert.equal((await store.getExecution(execution.id)).status, 'cancelled');
  assert.equal(
    (await store.listAudit({ workspaceId: 'acme' }))[0].action,
    'workflow.execution.cancelled',
  );
});

test('workflow retention never drops active executions', async (context) => {
  const { store } = await fixture(context);
  const workflow = await store.upsertWorkflow(workflowInput());
  const active = await store.triggerWorkflow(workflow.id);
  const state = {
    version: 1,
    workflows: [workflow],
    executions: [
      ...Array.from({ length: 1_000 }, (_, index) => ({
        ...structuredClone(active),
        id: `terminal-${index}`,
        status: 'completed',
      })),
      active,
    ],
    audit: [],
    producerRoutes: [],
    producerAudit: [],
  };
  trimWorkflowState(state);
  assert.equal(state.executions.length, 1_000);
  assert.ok(state.executions.some((execution) => execution.id === active.id));
  assert.equal(state.executions[0].id, 'terminal-1');
});
