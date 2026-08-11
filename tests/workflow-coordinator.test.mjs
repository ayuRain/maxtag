import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileThreadConfigStore } from '@opentag/config';
import { FileDeliveryStore } from '@opentag/delivery';
import { WorkflowCoordinatorService } from '@opentag/runtime-host';
import { FileWorkflowStore } from '@opentag/workflows';

async function fixture(context) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-workflow-coordinator-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const workflowStore = new FileWorkflowStore(path.join(root, 'workflows'));
  const deliveryStore = new FileDeliveryStore(path.join(root, 'delivery'));
  const threadConfigStore = new FileThreadConfigStore(
    path.join(root, 'config'),
    {
      workspace: {
        id: 'acme',
        name: 'Acme',
        defaultProjectId: 'payments',
      },
    },
  );
  const coordinator = new WorkflowCoordinatorService({
    workflowStore,
    deliveryStore,
    threadConfigStore,
    coordinatorId: 'coordinator-test',
  });
  return { workflowStore, deliveryStore, threadConfigStore, coordinator };
}

async function createWorkflow(workflowStore, overrides = {}) {
  return workflowStore.upsertWorkflow({
    workspaceId: 'acme',
    projectId: 'payments',
    name: 'CI triage',
    trigger: { kind: 'event', eventType: 'ci.failed' },
    nodes: [
      { id: 'analyze', instructions: 'Analyze the CI failure.' },
      {
        id: 'publish',
        instructions: 'Publish the next action.',
        dependsOn: ['analyze'],
      },
    ],
    destination: {
      platform: 'lark',
      externalId: 'oc_payments',
      channelId: 'oc_payments',
      visibility: 'public',
    },
    ...overrides,
  });
}

test('workflow coordinator bridges internal nodes and publishes only sinks', async (context) => {
  const { workflowStore, deliveryStore, coordinator } = await fixture(context);
  const workflow = await createWorkflow(workflowStore);
  const execution = await workflowStore.triggerWorkflow(workflow.id, {
    payload: { build: 481, branch: 'main' },
  });

  const firstTick = await coordinator.tick(new Date('2026-08-12T02:00:00.000Z'));
  assert.equal(firstTick.queued, 1);
  const analyzeRun = await deliveryStore.getAgentRun(
    `workflow:${execution.id}:analyze`,
  );
  assert.equal(analyzeRun.platform, 'workflow');
  assert.equal(analyzeRun.metadata.workflowPublish, false);
  assert.match(analyzeRun.message.text, /"build": 481/);

  await deliveryStore.markAgentRunCompleted(
    analyzeRun.id,
    'The test database migration failed.',
  );
  const secondTick = await coordinator.tick(new Date('2026-08-12T02:01:00.000Z'));
  assert.equal(secondTick.queued, 1);
  const publishRun = await deliveryStore.getAgentRun(
    `workflow:${execution.id}:publish`,
  );
  assert.equal(publishRun.platform, 'lark');
  assert.equal(publishRun.metadata.workflowPublish, true);
  assert.match(publishRun.message.text, /The test database migration failed/);
  assert.equal(
    (await deliveryStore.getThreadBinding('lark', 'oc_payments')).projectId,
    'payments',
  );

  await deliveryStore.markAgentRunCompleted(
    publishRun.id,
    'Repair the migration and rerun build 481.',
  );
  await coordinator.tick(new Date('2026-08-12T02:02:00.000Z'));
  const completed = await workflowStore.getExecution(execution.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.summary, 'Repair the migration and rerun build 481.');
});

test('workflow coordinator refuses a sink bound outside its project', async (context) => {
  const { workflowStore, deliveryStore, coordinator } = await fixture(context);
  await deliveryStore.configureThreadBinding({
    platform: 'lark',
    externalId: 'oc_payments',
    workspaceId: 'acme',
    projectId: 'security',
    scope: 'channel',
    source: 'configured',
  });
  const workflow = await createWorkflow(workflowStore, {
    nodes: [{ id: 'publish', instructions: 'Publish the event.' }],
  });
  const execution = await workflowStore.triggerWorkflow(workflow.id);

  const result = await coordinator.tick();
  assert.equal(result.queued, 0);
  assert.equal(result.failed, 1);
  const failed = await workflowStore.getExecution(execution.id);
  assert.equal(failed.status, 'failed');
  assert.equal(
    failed.nodes[0].error,
    'workflow_destination_binding_scope_mismatch',
  );
});
