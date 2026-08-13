import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileThreadConfigStore } from '@opentag/config';
import { LarkDocumentWatcherService } from '@opentag/runtime-host';
import { FileWorkflowStore } from '@opentag/workflows';

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-doc-watch-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const workflowStore = new FileWorkflowStore(path.join(root, 'workflows'));
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
  await threadConfigStore.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'payments',
    name: 'Payments',
    capabilityMode: 'custom',
    grants: [
      {
        id: 'payments:lark-docs',
        kind: 'lark-docs',
        scope: 'project',
        label: 'Lark Docs',
        constraints: {
          documentIds: ['dox-payments'],
          permissions: ['read'],
        },
      },
    ],
    networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
  });
  await workflowStore.upsertWorkflow({
    workspaceId: 'acme',
    projectId: 'payments',
    name: 'Document reviewer',
    trigger: { kind: 'event', eventType: 'lark.document.changed' },
    nodes: [{ id: 'review', instructions: 'Review the changed document.' }],
    destination: {
      platform: 'lark',
      externalId: 'oc_payments',
      channelId: 'oc_payments',
      visibility: 'private',
    },
  });
  const route = await workflowStore.upsertProducerRoute(
    {
      kind: 'lark-document',
      workspaceId: 'acme',
      projectId: 'payments',
      name: 'Payments plan',
      documentId: 'dox-payments',
      pollIntervalSeconds: 30,
    },
    new Date('2026-08-13T01:00:00.000Z'),
  );
  return { workflowStore, threadConfigStore, route };
}

test('Lark document watcher establishes a baseline and emits one revision event', async (context) => {
  const { workflowStore, threadConfigStore, route } = await fixture(context);
  let now = new Date('2026-08-13T01:00:00.000Z');
  let revision = 7;
  let content = 'Initial payment plan';
  let metadataReads = 0;
  let rawReads = 0;
  const watcher = new LarkDocumentWatcherService({
    workflowStore,
    threadConfigStore,
    watcherId: 'watcher-a',
    rawRequestIntervalMs: 0,
    now: () => new Date(now),
    request: async (pathname) => {
      if (pathname.endsWith('/raw_content')) {
        rawReads += 1;
        return { content };
      }
      metadataReads += 1;
      return {
        document: {
          document_id: 'dox-payments',
          revision_id: revision,
          title: 'Payments plan',
        },
      };
    },
  });

  const baseline = await watcher.tick();
  assert.equal(baseline.baseline, 1);
  assert.equal(baseline.staged, 0);
  assert.equal(rawReads, 1);

  now = new Date('2026-08-13T01:00:31.000Z');
  revision = 8;
  content = 'Updated payment plan';
  const changed = await watcher.tick();
  assert.equal(changed.changed, 1);
  assert.equal(changed.staged, 1);
  const executions = await workflowStore.listExecutions();
  assert.equal(executions.length, 1);
  assert.equal(executions[0].trigger.eventId, 'dox-payments:8');
  assert.equal(executions[0].input.documentId, 'dox-payments');
  assert.equal(executions[0].input.previousRevisionId, 7);
  assert.equal(executions[0].input.content, 'Updated payment plan');

  now = new Date('2026-08-13T01:01:02.000Z');
  const unchanged = await watcher.tick();
  assert.equal(unchanged.unchanged, 1);
  assert.equal(unchanged.staged, 0);
  assert.equal(rawReads, 2);
  assert.equal(metadataReads, 3);
  const runtime = (await workflowStore.listProducerRuntime())[0];
  assert.equal(runtime.routeId, route.id);
  assert.equal(runtime.lastRevisionId, 8);
  assert.equal(runtime.failureCount, 0);
});

test('Lark document watcher retries after cursor commit failure without duplicating execution', async (context) => {
  const { workflowStore, threadConfigStore } = await fixture(context);
  let now = new Date('2026-08-13T01:00:00.000Z');
  let revision = 1;
  let failCommit = false;
  const originalComplete = workflowStore.completeProducerPoll.bind(workflowStore);
  workflowStore.completeProducerPoll = async (...args) => {
    if (failCommit) {
      failCommit = false;
      throw new Error('simulated_cursor_commit_failure');
    }
    return originalComplete(...args);
  };
  const watcher = new LarkDocumentWatcherService({
    workflowStore,
    threadConfigStore,
    watcherId: 'watcher-a',
    rawRequestIntervalMs: 0,
    now: () => new Date(now),
    request: async (pathname) =>
      pathname.endsWith('/raw_content')
        ? { content: `Revision ${revision}` }
        : { document: { revision_id: revision, title: 'Payments plan' } },
  });
  await watcher.tick();

  now = new Date('2026-08-13T01:00:31.000Z');
  revision = 2;
  failCommit = true;
  const failed = await watcher.tick();
  assert.equal(failed.staged, 1);
  assert.equal(failed.failed, 1);

  now = new Date('2026-08-13T01:01:02.000Z');
  const retried = await watcher.tick();
  assert.equal(retried.staged, 0);
  assert.equal(retried.duplicates, 1);
  assert.equal((await workflowStore.listExecutions()).length, 1);
  assert.equal((await workflowStore.listProducerRuntime())[0].lastRevisionId, 2);
});

test('Lark document watcher rechecks the current project grant before remote reads', async (context) => {
  const { workflowStore, threadConfigStore } = await fixture(context);
  let now = new Date('2026-08-13T01:00:00.000Z');
  let reads = 0;
  const watcher = new LarkDocumentWatcherService({
    workflowStore,
    threadConfigStore,
    watcherId: 'watcher-a',
    rawRequestIntervalMs: 0,
    now: () => new Date(now),
    request: async (pathname) => {
      reads += 1;
      return pathname.endsWith('/raw_content')
        ? { content: 'Initial plan' }
        : { document: { revision_id: 1, title: 'Payments plan' } };
    },
  });
  await watcher.tick();
  assert.equal(reads, 2);

  await threadConfigStore.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'payments',
    name: 'Payments',
    capabilityMode: 'custom',
    grants: [],
    networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
  });
  now = new Date('2026-08-13T01:00:31.000Z');
  const denied = await watcher.tick();
  assert.equal(denied.failed, 1);
  assert.equal(reads, 2);
  const runtime = (await workflowStore.listProducerRuntime())[0];
  assert.equal(runtime.lastError, 'lark_document_watch_grant_required');
  assert.equal(runtime.failureCount, 1);
});
