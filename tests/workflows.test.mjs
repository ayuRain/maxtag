import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileWorkflowStore,
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

test('event workflows dedupe triggers and advance dependency-ready nodes', async (context) => {
  const { store } = await fixture(context);
  const workflow = await store.upsertWorkflow(workflowInput(), new Date('2026-08-12T01:00:00.000Z'));
  const event = {
    workspaceId: 'acme',
    projectId: 'payments',
    eventType: 'ci.failed',
    eventId: 'build-481',
    payload: { repository: 'acme/payments', run: 481 },
  };
  const first = await store.triggerEvent(event, new Date('2026-08-12T01:01:00.000Z'));
  const duplicate = await store.triggerEvent(event, new Date('2026-08-12T01:02:00.000Z'));
  assert.equal(first.matched, 1);
  assert.equal(first.staged.length, 1);
  assert.equal(duplicate.staged.length, 0);
  assert.equal(duplicate.duplicates[0].id, first.staged[0].id);

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
  };
  trimWorkflowState(state);
  assert.equal(state.executions.length, 1_000);
  assert.ok(state.executions.some((execution) => execution.id === active.id));
  assert.equal(state.executions[0].id, 'terminal-1');
});
