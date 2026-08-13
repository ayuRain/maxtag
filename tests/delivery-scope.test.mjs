import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createEmptyDeliveryState,
  FileDeliveryStore,
  trimInboundEventState,
} from '../packages/delivery/dist/index.js';

function thread(workspaceId) {
  return {
    id: `lark:${workspaceId}:root`,
    platform: 'lark',
    externalId: `${workspaceId}:root`,
    channelId: `channel-${workspaceId}`,
    workspaceId,
    projectId: 'project',
    visibility: 'public',
  };
}

function message(sourceThread) {
  return {
    id: `message-${sourceThread.workspaceId}`,
    threadId: sourceThread.id,
    platform: 'lark',
    text: 'status',
    actor: { id: `actor-${sourceThread.workspaceId}` },
    mentionsAgent: true,
  };
}

test('delivery collections and summaries filter by workspace before limiting', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-delivery-scope-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);

  for (const workspaceId of ['acme', 'labs']) {
    const sourceThread = thread(workspaceId);
    await store.createAgentRun({
      runId: `run-${workspaceId}`,
      thread: sourceThread,
      message: message(sourceThread),
    });
    await store.enqueue({
      kind: 'lark.text',
      target: { platform: 'lark', chatId: sourceThread.channelId },
      payload: { text: workspaceId },
      runId: `run-${workspaceId}`,
      thread: sourceThread,
    });
    await store.configureThreadBinding({
      platform: 'lark',
      externalId: sourceThread.channelId,
      workspaceId,
      projectId: 'project',
    });
    await store.recordInboundEvent({
      platform: 'lark',
      externalId: `event-${workspaceId}`,
      workspaceId,
      projectId: 'project',
      threadId: sourceThread.id,
    });
  }

  assert.deepEqual(
    (await store.listOutbox({ workspaceId: 'acme', limit: 1 })).map(
      (record) => record.workspaceId,
    ),
    ['acme'],
  );
  assert.deepEqual(
    (await store.listTurnDeliveries({ workspaceId: 'acme' })).map(
      (record) => record.workspaceId,
    ),
    ['acme'],
  );
  assert.deepEqual(
    (await store.listInboundEvents({ workspaceId: 'acme' })).map(
      (record) => record.workspaceId,
    ),
    ['acme'],
  );
  assert.deepEqual(
    (await store.listThreadBindings(10, 'acme')).map(
      (record) => record.workspaceId,
    ),
    ['acme'],
  );

  const scoped = await store.summarize('acme');
  assert.equal(scoped.outbox.pending, 1);
  assert.equal(scoped.turnDeliveries.queued, 1);
  assert.equal(scoped.inboundEvents.received, 1);
  assert.equal(scoped.agentRuns.queued, 1);
  assert.equal(scoped.bindings, 1);
  assert.equal((await store.summarize()).agentRuns.queued, 2);
});

test('inbound message id deduplicates realtime and history event keys', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-inbound-message-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);

  const realtime = await store.recordInboundEvent({
    platform: 'lark',
    externalId: 'evt_live_1',
    eventType: 'im.message.receive_v1',
    workspaceId: 'workspace-1',
    projectId: 'alpha',
    threadId: 'lark:oc_alpha:om_root',
    messageId: 'om_same_message',
  });
  const replay = await store.recordInboundEvent({
    platform: 'lark',
    externalId: 'om_same_message',
    eventType: 'im.message.receive_v1',
    workspaceId: 'workspace-1',
    projectId: 'alpha',
    threadId: 'lark:oc_alpha:om_root',
    messageId: 'om_same_message',
  });
  const distinctPlatform = await store.recordInboundEvent({
    platform: 'slack',
    externalId: 'evt_slack_1',
    messageId: 'om_same_message',
  });

  assert.equal(realtime.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.id, realtime.record.id);
  assert.equal(replay.record.externalId, 'evt_live_1');
  assert.equal(replay.record.duplicateCount, 1);
  assert.equal(distinctPlatform.duplicate, false);
});

test('inbound retention preserves active events and keeps the newest terminal evidence', () => {
  const state = createEmptyDeliveryState();
  state.inboundEvents = [
    {
      id: 'old', platform: 'github', externalId: 'old', status: 'processed',
      duplicateCount: 0, receivedAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:01.000Z',
    },
    {
      id: 'active', platform: 'github', externalId: 'active', status: 'received',
      duplicateCount: 0, receivedAt: '2026-08-13T00:00:02.000Z',
      updatedAt: '2026-08-13T00:00:02.000Z',
    },
    {
      id: 'new', platform: 'github', externalId: 'new', status: 'failed',
      duplicateCount: 0, receivedAt: '2026-08-13T00:00:03.000Z',
      updatedAt: '2026-08-13T00:00:04.000Z',
    },
  ];

  trimInboundEventState(state, 2);

  assert.deepEqual(state.inboundEvents.map((event) => event.id), ['active', 'new']);
});

test('tool approvals dedupe, expire, claim once, and fail stale executions closed', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-tool-approval-state-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('acme');
  const requestedAt = new Date();
  const afterMinutes = (minutes, seconds = 0) =>
    new Date(requestedAt.getTime() + minutes * 60_000 + seconds * 1_000);
  const input = {
    runId: 'run-approval',
    toolCallId: 'call-approval',
    toolName: 'github_issue_create',
    title: 'Create GitHub issue',
    grantKind: 'github',
    risk: 'write',
    arguments: { owner: 'acme', repo: 'payments', title: 'Retry spike' },
    argumentSummary: { owner: 'acme', repo: 'payments', title: 'Retry spike' },
    argumentDigest: 'digest-1',
    thread: sourceThread,
    requestedBy: 'agent:payments',
    now: requestedAt,
  };
  const first = await store.proposeToolApproval(input);
  const duplicate = await store.proposeToolApproval({
    ...input,
    toolCallId: 'call-duplicate',
  });
  assert.equal(duplicate.id, first.id);
  assert.equal((await store.listToolApprovals({ workspaceId: 'acme' })).length, 1);
  assert.equal((await store.summarize('acme')).toolApprovals.pending, 1);

  await store.approveToolApproval({
    id: first.id,
    actorId: 'operator:ada',
    now: afterMinutes(1),
  });
  const [claimA, claimB] = await Promise.all([
    store.claimToolApproval({
      id: first.id,
      claimedBy: 'worker-a',
      expectedArgumentDigest: 'digest-1',
      now: afterMinutes(2),
    }),
    store.claimToolApproval({
      id: first.id,
      claimedBy: 'worker-b',
      expectedArgumentDigest: 'digest-1',
      now: afterMinutes(2),
    }),
  ]);
  assert.equal([claimA, claimB].filter(Boolean).length, 1);
  const claimedBy = claimA?.claimedBy || claimB?.claimedBy;
  assert.ok(claimedBy);
  await assert.rejects(
    store.completeToolApproval({ id: first.id, claimedBy: 'other-worker' }),
    /tool_approval_claim_lost/u,
  );
  const recovered = await store.recoverStaleToolApprovals({
    olderThanMs: 60_000,
    now: afterMinutes(4),
  });
  assert.equal(recovered.failed, 1);
  assert.equal(recovered.records[0].status, 'failed');
  assert.equal(recovered.records[0].error, 'execution_outcome_unknown');
  assert.equal((await store.summarize('acme')).toolApprovals.failed, 1);
  const terminalReplay = await store.proposeToolApproval({
    ...input,
    toolCallId: 'call-after-terminal',
  });
  assert.equal(terminalReplay.id, first.id);
  assert.equal(terminalReplay.status, 'failed');

  const expiring = await store.proposeToolApproval({
    ...input,
    runId: 'run-expiring',
    toolCallId: 'call-expiring',
    argumentDigest: 'digest-expiring',
    ttlMs: 60_000,
  });
  const expired = await store.getToolApproval(
    expiring.id,
    afterMinutes(1, 1),
  );
  assert.equal(expired.status, 'expired');
  await assert.rejects(
    store.approveToolApproval({
      id: expiring.id,
      actorId: 'operator:ada',
      now: afterMinutes(1, 1),
    }),
    /tool_approval_not_pending:expired/u,
  );
});

test('usage budget checks project monthly runs and cost before queueing', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-usage-budget-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('acme');

  await store.recordAgentRunUsage({
    runId: 'usage-run-1',
    thread: sourceThread,
    quantity: { runs: 1, costUsd: 0.75 },
    at: new Date('2026-08-12T10:00:00.000Z'),
  });

  const allowed = await store.checkUsageBudget({
    thread: sourceThread,
    policy: {
      mode: 'custom',
      scope: 'project',
      maxRunsPerMonth: 2,
      maxCostUsdPerMonth: 2,
    },
    expected: { runs: 1, costUsd: 0.5 },
    at: new Date('2026-08-12T11:00:00.000Z'),
  });
  assert.equal(allowed.allowed, true);
  assert.equal(
    allowed.projected.find((line) => line.scope === 'project').runs,
    2,
  );
  assert.equal(
    allowed.projected.find((line) => line.scope === 'project').costUsd,
    1.25,
  );

  const deniedByRuns = await store.checkUsageBudget({
    thread: sourceThread,
    policy: {
      mode: 'custom',
      scope: 'project',
      maxRunsPerMonth: 1,
    },
    expected: { runs: 1 },
    at: new Date('2026-08-12T12:00:00.000Z'),
  });
  assert.equal(deniedByRuns.allowed, false);
  assert.equal(deniedByRuns.reason, 'runs_budget_exceeded');

  const deniedByCost = await store.checkUsageBudget({
    thread: sourceThread,
    policy: {
      mode: 'custom',
      scope: 'project',
      maxCostUsdPerMonth: 1,
    },
    expected: { costUsd: 0.5 },
    at: new Date('2026-08-12T12:00:00.000Z'),
  });
  assert.equal(deniedByCost.allowed, false);
  assert.equal(deniedByCost.reason, 'cost_budget_exceeded');
});

test('channel usage budgets aggregate one client channel across topics', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-channel-budget-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const channelThread = (channelId, topicId) => ({
    id: `lark:${channelId}:${topicId}`,
    platform: 'lark',
    externalId: `${channelId}:${topicId}`,
    channelId,
    workspaceId: 'acme',
    projectId: 'shared',
    visibility: 'public',
  });

  await store.recordAgentRunUsage({
    runId: 'channel-run-1',
    thread: channelThread('oc_incidents', 'topic-1'),
    quantity: { runs: 1, costUsd: 0.4 },
    at: new Date('2026-08-12T10:00:00.000Z'),
  });
  await store.recordAgentRunUsage({
    runId: 'channel-run-2',
    thread: channelThread('oc_other', 'topic-1'),
    quantity: { runs: 1, costUsd: 0.2 },
    at: new Date('2026-08-12T10:30:00.000Z'),
  });

  const check = await store.checkUsageBudget({
    thread: channelThread('oc_incidents', 'topic-2'),
    policy: { mode: 'custom', scope: 'channel', maxRunsPerMonth: 1 },
    expected: { runs: 1 },
    at: new Date('2026-08-12T11:00:00.000Z'),
  });
  assert.equal(check.allowed, false);
  assert.equal(check.violated.scope, 'channel');
  assert.equal(check.violated.channelId, 'oc_incidents');
  assert.equal(check.current.find((line) => line.scope === 'channel').runs, 1);
  assert.equal(check.current.find((line) => line.scope === 'project').runs, 2);
});

test('usage budgets enforce every active scope instead of replacing parent caps', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-layered-budget-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('acme');

  await store.recordAgentRunUsage({
    runId: 'layered-run-1',
    thread: sourceThread,
    at: new Date('2026-08-12T10:00:00.000Z'),
  });
  const check = await store.checkUsageBudget({
    thread: sourceThread,
    policies: [
      { mode: 'custom', scope: 'workspace', maxRunsPerMonth: 1 },
      { mode: 'custom', scope: 'channel', maxRunsPerMonth: 5 },
    ],
    expected: { runs: 1 },
    at: new Date('2026-08-12T11:00:00.000Z'),
  });

  assert.equal(check.allowed, false);
  assert.equal(check.policy.scope, 'workspace');
  assert.equal(check.violated.scope, 'workspace');
});

test('usage threshold alerts persist once at 75 and 95 percent', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-usage-alerts-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('acme');
  const policies = [
    { mode: 'custom', scope: 'workspace', maxRunsPerMonth: 4 },
  ];

  for (let index = 1; index <= 4; index += 1) {
    await store.recordAgentRunUsage({
      runId: `threshold-run-${index}`,
      thread: sourceThread,
      policies,
      at: new Date(`2026-08-12T1${index}:00:00.000Z`),
    });
  }
  await store.recordAgentRunUsage({
    runId: 'threshold-run-4',
    thread: sourceThread,
    policies,
    at: new Date('2026-08-12T14:05:00.000Z'),
  });

  const snapshot = await store.usageSnapshot({
    workspaceId: 'acme',
    period: '2026-08',
  });
  assert.deepEqual(
    snapshot.alerts.map((alert) => alert.thresholdPercent).sort(),
    [75, 95],
  );
  assert.equal(snapshot.records.length, 4);
  assert.equal(
    snapshot.totals.find((line) => line.scope === 'workspace').runs,
    4,
  );
});

test('usage analytics aggregate all records even when details are limited', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-usage-analytics-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('acme');
  for (let index = 1; index <= 3; index += 1) {
    await store.recordAgentRunUsage({
      runId: `analytics-run-${index}`,
      thread: sourceThread,
      quantity: { runs: 1, costUsd: 0.25 },
      at: new Date(`2026-08-12T1${index}:00:00.000Z`),
      metadata: { costReported: true, inputTokens: index * 10 },
    });
  }

  const snapshot = await store.usageSnapshot({
    workspaceId: 'acme',
    period: '2026-08',
    limit: 1,
  });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.recordCount, 3);
  assert.equal(snapshot.costReportedRecords, 3);
  assert.equal(snapshot.tokenReportedRecords, 3);
  assert.equal(
    snapshot.totals.find((line) => line.scope === 'workspace').runs,
    3,
  );
  assert.equal(
    snapshot.totals.find((line) => line.scope === 'workspace').costUsd,
    0.75,
  );
});

test('usage ledger separates main-agent and memory-runner calls without inflating run caps', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-usage-purpose-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('acme');
  const at = new Date('2026-08-12T10:00:00.000Z');

  const agent = await store.recordAgentRunUsage({
    runId: 'purpose-run',
    recordKey: 'agent',
    purpose: 'agent',
    thread: sourceThread,
    quantity: { runs: 1, costUsd: 0.4 },
    at,
    metadata: {
      inputTokens: 100,
      outputTokens: 40,
      costReported: true,
    },
  });
  await store.recordAgentRunUsage({
    runId: 'purpose-run',
    recordKey: 'memory_retrieval:first',
    purpose: 'memory_retrieval',
    thread: sourceThread,
    quantity: { runs: 0, costUsd: 0.01 },
    at,
    metadata: {
      inputTokens: 20,
      outputTokens: 4,
      costReported: true,
    },
  });
  await store.recordAgentRunUsage({
    runId: 'purpose-run',
    recordKey: 'memory_retrieval:second',
    purpose: 'memory_retrieval',
    thread: sourceThread,
    quantity: { runs: 0, costUsd: 0.02 },
    at,
    metadata: { inputTokens: 30, outputTokens: 6 },
  });
  const updatedAgent = await store.recordAgentRunUsage({
    runId: 'purpose-run',
    recordKey: 'agent',
    purpose: 'agent',
    thread: sourceThread,
    quantity: { runs: 1, costUsd: 0.5 },
    at,
    metadata: {
      inputTokens: 110,
      outputTokens: 45,
      costReported: true,
    },
  });
  assert.equal(updatedAgent.id, agent.id);

  const snapshot = await store.usageSnapshot({
    workspaceId: 'acme',
    period: '2026-08',
    limit: 1,
  });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.recordCount, 3);
  assert.equal(
    snapshot.totals.find((line) => line.scope === 'workspace').runs,
    1,
  );
  assert.equal(
    snapshot.totals.find((line) => line.scope === 'workspace').costUsd,
    0.53,
  );
  assert.deepEqual(snapshot.purposeTotals, [
    {
      purpose: 'agent',
      calls: 1,
      runs: 1,
      costUsd: 0.5,
      inputTokens: 110,
      outputTokens: 45,
      costReportedCalls: 1,
      tokenReportedCalls: 1,
    },
    {
      purpose: 'memory_retrieval',
      calls: 2,
      runs: 0,
      costUsd: 0.03,
      inputTokens: 50,
      outputTokens: 10,
      costReportedCalls: 1,
      tokenReportedCalls: 2,
    },
  ]);
});

test('lowering a policy reconciles threshold alerts without waiting for another run', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-alert-reconcile-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('acme');
  for (let index = 1; index <= 3; index += 1) {
    await store.recordAgentRunUsage({
      runId: `reconcile-run-${index}`,
      thread: sourceThread,
      at: new Date(`2026-08-12T1${index}:00:00.000Z`),
    });
  }
  const input = {
    thread: sourceThread,
    policies: [
      { mode: 'custom', scope: 'workspace', maxRunsPerMonth: 4 },
    ],
    at: new Date('2026-08-12T14:00:00.000Z'),
  };
  assert.deepEqual(
    (await store.reconcileUsageBudgetAlerts(input)).map(
      (alert) => alert.thresholdPercent,
    ),
    [75],
  );
  assert.deepEqual(await store.reconcileUsageBudgetAlerts(input), []);
});

test('thread binding audit records create update and cascading remove', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-binding-audit-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);

  const created = await store.configureThreadBinding({
    platform: 'lark',
    externalId: 'oc_project',
    workspaceId: 'dev-workspace',
    projectId: 'payments',
    channelId: 'oc_project',
    actor: 'operator:owner',
    reason: 'initial_route',
  });
  await store.configureThreadBinding({
    platform: 'lark',
    externalId: 'oc_project:topic',
    workspaceId: 'dev-workspace',
    projectId: 'payments',
    scope: 'thread',
    channelId: 'oc_project',
    actor: 'pairing:ou-user',
    reason: 'topic_observed',
  });
  await store.configureThreadBinding({
    platform: 'lark',
    externalId: 'oc_project',
    workspaceId: 'dev-workspace',
    projectId: 'support',
    channelId: 'oc_project',
    actor: 'operator:admin',
    reason: 'reroute_channel',
  });

  const removed = await store.removeThreadBinding(created.id, {
    actor: 'operator:admin',
    reason: 'cleanup',
  });
  assert.equal(removed.length, 2);

  const audit = await store.listThreadBindingAudit({
    workspaceId: 'dev-workspace',
    limit: 10,
  });
  assert.deepEqual(
    audit.map((record) => record.action),
    [
      'binding.removed',
      'binding.removed',
      'binding.updated',
      'binding.created',
      'binding.created',
    ],
  );
  const updated = audit.find((record) => record.action === 'binding.updated');
  assert.equal(updated.before.projectId, 'payments');
  assert.equal(updated.after.projectId, 'support');
  assert.equal(
    audit.find((record) => record.bindingId === created.id).actor,
    'operator:admin',
  );
  assert.equal(
    (await store.listThreadBindingAudit({ projectId: 'payments' })).length,
    3,
  );
});

test('scoped run events preserve route evidence without cross-workspace leakage', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-run-audit-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  for (const workspaceId of ['acme', 'other']) {
    const sourceThread = thread(workspaceId);
    await store.createAgentRun({
      runId: `audit-${workspaceId}`,
      thread: sourceThread,
      message: message(sourceThread),
    });
    await store.appendAgentRunEvent(`audit-${workspaceId}`, 'tool_result', {
      message: 'GitHub repository succeeded',
      metadata: {
        call: {
          name: 'github_repository',
          status: 'succeeded',
          arguments: { repository: `${workspaceId}/repo` },
        },
      },
    });
  }
  const events = await store.listScopedAgentRunEvents({
    workspaceId: 'acme',
    types: ['tool_result'],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, 'audit-acme');
  assert.equal(events[0].workspaceId, 'acme');
  assert.equal(events[0].projectId, 'project');
  assert.equal(events[0].actorId, 'actor-acme');
});

test('legacy run timelines receive monotonic cursors before new events append', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-run-cursor-migrate-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceThread = thread('acme');
  const legacyState = createEmptyDeliveryState();
  delete legacyState.nextAgentRunEventSequence;
  legacyState.agentRuns.push({
    id: 'legacy-run',
    status: 'running',
    platform: 'lark',
    thread: sourceThread,
    message: message(sourceThread),
    threadId: sourceThread.id,
    threadExternalId: sourceThread.externalId,
    workspaceId: 'acme',
    projectId: 'project',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:01.000Z',
  });
  legacyState.agentRunEvents.push(
    {
      id: 'legacy-created',
      runId: 'legacy-run',
      type: 'created',
      at: '2026-08-13T00:00:00.000Z',
    },
    {
      id: 'legacy-started',
      runId: 'legacy-run',
      type: 'started',
      at: '2026-08-13T00:00:01.000Z',
    },
  );
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'delivery-state.json'),
    JSON.stringify(legacyState),
    'utf8',
  );

  const store = new FileDeliveryStore(root);
  const appended = await store.appendAgentRunEvent('legacy-run', 'progress', {
    message: 'Migrated cursor',
  });
  assert.equal(appended.sequence, 3);
  assert.deepEqual(
    (await store.listAgentRunEvents('legacy-run')).map((event) => event.sequence),
    [1, 2, 3],
  );

  const mixedState = JSON.parse(
    await fs.readFile(path.join(root, 'delivery-state.json'), 'utf8'),
  );
  delete mixedState.agentRunEvents[1].sequence;
  mixedState.nextAgentRunEventSequence = 2;
  await fs.writeFile(
    path.join(root, 'delivery-state.json'),
    JSON.stringify(mixedState),
    'utf8',
  );
  const mixedStore = new FileDeliveryStore(root);
  const mixedAppend = await mixedStore.appendAgentRunEvent(
    'legacy-run',
    'progress',
    { message: 'Mixed cursor repaired' },
  );
  assert.equal(mixedAppend.sequence, 4);
  assert.deepEqual(
    (await mixedStore.listAgentRunEvents('legacy-run')).map(
      (event) => event.sequence,
    ),
    [1, 2, 3, 4],
  );
});

test('run search matches visible route and conversation fields after workspace scoping', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-run-search-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const acmeThread = {
    ...thread('acme'),
    title: 'Payments incident room',
    projectId: 'payments',
  };
  await store.createAgentRun({
    runId: 'run-search-acme',
    thread: acmeThread,
    message: {
      ...message(acmeThread),
      text: 'Investigate the retry spike after checkout deploy',
      actor: { id: 'ou-ada', displayName: 'Ada' },
    },
    executorId: 'codex',
  });
  await store.markAgentRunCompleted(
    'run-search-acme',
    'Checkout retries now use exponential backoff.',
  );
  const otherThread = { ...thread('other'), projectId: 'payments' };
  await store.createAgentRun({
    runId: 'run-search-other',
    thread: otherThread,
    message: {
      ...message(otherThread),
      text: 'Investigate the retry spike after checkout deploy',
    },
    metadata: { providerSession: 'private-session-marker' },
  });

  assert.deepEqual(
    (await store.listAgentRuns({
      workspaceId: 'acme',
      query: 'checkout backoff',
    })).map((run) => run.id),
    ['run-search-acme'],
  );
  assert.deepEqual(
    (await store.listAgentRuns({
      workspaceId: 'acme',
      query: 'Payments Ada',
    })).map((run) => run.id),
    ['run-search-acme'],
  );
  assert.deepEqual(
    await store.listAgentRuns({ workspaceId: 'acme', query: 'other' }),
    [],
  );
  assert.deepEqual(
    await store.listAgentRuns({ workspaceId: 'other', query: 'private-session-marker' }),
    [],
  );
});
