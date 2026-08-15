import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ScopedFileMemoryStore } from '../packages/memory/dist/index.js';

function query(workspaceId, projectId, externalId = 'channel:root') {
  return {
    thread: {
      id: `lark:${externalId}`,
      platform: 'lark',
      externalId,
      workspaceId,
      projectId,
      channelId: externalId.split(':')[0],
      visibility: 'public',
    },
  };
}

test('versioned memory isolates scopes and restores an immutable revision', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const projectA = query('workspace-a', 'project-a');
  const projectASameChannelTopic = query(
    'workspace-a',
    'project-a',
    'channel:other-topic',
  );
  const projectASiblingChannel = query(
    'workspace-a',
    'project-a',
    'sibling:root',
  );
  const projectB = query('workspace-a', 'project-b', 'other:root');
  const workspaceB = query('workspace-b', 'project-a', 'third:root');

  await store.rememberScoped({
    ...projectA,
    scope: 'global',
    text: 'shared installation fact',
    actorId: 'operator:owner',
    source: 'operator-api',
  });
  await store.rememberScoped({
    ...projectA,
    scope: 'workspace',
    text: 'workspace A fact',
    actorId: 'lark:ou-workspace-owner',
    source: 'lark-command',
  });
  await store.rememberScoped({
    ...projectA,
    scope: 'project',
    text: 'project A fact',
    actorId: 'lark:ou-project-member',
    source: 'lark-command',
  });
  await store.rememberScoped({
    ...projectA,
    scope: 'channel',
    text: 'channel A fact',
    actorId: 'lark:ou-project-member',
    source: 'lark-command',
  });
  await store.rememberScoped({
    ...projectA,
    scope: 'thread',
    text: 'thread A fact',
    actorId: 'lark:ou-project-member',
    source: 'lark-command',
  });

  const a = await store.loadMemory(projectA);
  assert.equal(a.scopes.every((item) => item.content.length > 0), true);
  const b = await store.loadMemory(projectB);
  assert.match(b.scopes[0].content, /shared installation fact/);
  assert.match(b.scopes[1].content, /workspace A fact/);
  assert.equal(b.scopes[2].content, '');
  assert.equal(b.scopes[3].content, '');
  assert.equal(b.scopes[4].content, '');
  const sameProjectOtherChannel = await store.loadMemory(projectASiblingChannel);
  assert.match(sameProjectOtherChannel.scopes[2].content, /project A fact/);
  assert.equal(sameProjectOtherChannel.scopes[3].content, '');
  assert.equal(sameProjectOtherChannel.scopes[4].content, '');
  const sameChannelOtherTopic = await store.loadMemory(projectASameChannelTopic);
  assert.match(sameChannelOtherTopic.scopes[2].content, /project A fact/);
  assert.match(sameChannelOtherTopic.scopes[3].content, /channel A fact/);
  assert.equal(sameChannelOtherTopic.scopes[4].content, '');
  const otherWorkspace = await store.loadMemory(workspaceB);
  assert.match(otherWorkspace.scopes[0].content, /shared installation fact/);
  assert.equal(otherWorkspace.scopes[1].content, '');

  const original = await store.getMemoryHistory({
    ...projectA,
    scope: 'project',
  });
  assert.equal(original.document.version, 1);
  assert.equal(original.revisions[0].actorId, 'lark:ou-project-member');
  assert.equal(original.revisions[0].source, 'lark-command');

  await store.forgetScoped({
    ...projectA,
    scope: 'project',
    selector: 'project A fact',
    actorId: 'operator:admin',
    source: 'operator-api',
  });
  assert.equal(
    (await store.loadMemory({ ...projectA, scopes: ['project'] })).scopes[0]
      .content,
    '',
  );
  await store.restoreScoped({
    ...projectA,
    scope: 'project',
    revisionId: original.revisions[0].id,
    actorId: 'operator:owner',
    source: 'operator-api',
  });
  const restored = await store.getMemoryHistory({
    ...projectA,
    scope: 'project',
  });
  assert.equal(restored.document.version, 3);
  assert.match(restored.document.content, /project A fact/);
  assert.deepEqual(
    restored.revisions.map((revision) => revision.action),
    ['restore', 'forget', 'remember'],
  );
  assert.equal(
    restored.revisions[0].restoredFromRevisionId,
    original.revisions[0].id,
  );
  const restoreDiff = await store.diffMemory({
    ...projectA,
    scope: 'project',
    revisionId: restored.revisions[0].id,
  });
  assert.equal(restoreDiff.from.action, 'forget');
  assert.equal(restoreDiff.to.action, 'restore');
  assert.deepEqual(restoreDiff.removedLines, []);
  assert.equal(restoreDiff.addedLines.length, 1);
  assert.match(restoreDiff.addedLines[0], /project A fact/);
  const forgetDiff = await store.diffMemory({
    ...projectA,
    scope: 'project',
    revisionId: restored.revisions[1].id,
  });
  assert.equal(forgetDiff.to.action, 'forget');
  assert.equal(forgetDiff.addedLines.length, 0);
  assert.equal(forgetDiff.removedLines.length, 1);
  assert.match(forgetDiff.removedLines[0], /project A fact/);
  await assert.rejects(
    store.restoreScoped({
      ...projectB,
      scope: 'project',
      revisionId: original.revisions[0].id,
    }),
    /memory_revision_not_found/,
  );

  const exportedProject = await store.exportMemory({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    scopes: ['project'],
    includeRevisions: true,
    revisionLimit: 2,
  });
  assert.equal(exportedProject.schemaVersion, 1);
  assert.equal(exportedProject.documents.length, 1);
  assert.equal(exportedProject.documents[0].key, 'project:workspace-a:project-a');
  assert.equal(exportedProject.documents[0].scope.kind, 'project');
  assert.equal(exportedProject.revisions.length, 2);
  assert.deepEqual(
    exportedProject.revisions.map((revision) => revision.action),
    ['restore', 'forget'],
  );

  const exportedWorkspace = await store.exportMemory({
    workspaceId: 'workspace-a',
    includeRevisions: false,
  });
  assert.deepEqual(
    exportedWorkspace.documents.map((document) => document.key).sort(),
    [
      'channel:workspace-a:lark:channel',
      'project:workspace-a:project-a',
      'thread:lark-channel_root',
      'workspace:workspace-a',
    ],
  );
  assert.equal(exportedWorkspace.revisions.length, 0);

  const compactDryRun = await store.compactMemory({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    scopes: ['project'],
    keepLatestPerDocument: 1,
  });
  assert.equal(compactDryRun.dryRun, true);
  assert.equal(compactDryRun.scannedRevisions, 3);
  assert.equal(compactDryRun.droppedRevisions.length, 1);
  assert.equal(compactDryRun.droppedRevisions[0].action, 'forget');
  assert.equal(
    (await store.getMemoryHistory({ ...projectA, scope: 'project' })).revisions
      .length,
    3,
  );

  const compactApplied = await store.compactMemory({
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    scopes: ['project'],
    keepLatestPerDocument: 1,
    dryRun: false,
  });
  assert.equal(compactApplied.dryRun, false);
  assert.equal(compactApplied.droppedRevisions.length, 1);
  const compactedHistory = await store.getMemoryHistory({
    ...projectA,
    scope: 'project',
  });
  assert.deepEqual(
    compactedHistory.revisions.map((revision) => revision.action),
    ['restore', 'remember'],
  );
  assert.equal(
    compactedHistory.revisions[0].restoredFromRevisionId,
    compactedHistory.revisions[1].id,
  );
});

test('versioned file memory imports legacy Markdown once', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-import-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(
    path.join(root, 'workspaces', 'workspace-a', 'projects', 'project-a'),
    { recursive: true },
  );
  await fs.mkdir(path.join(root, 'threads'), { recursive: true });
  await fs.writeFile(path.join(root, 'global.md'), '- legacy global\n', 'utf8');
  await fs.writeFile(
    path.join(
      root,
      'workspaces',
      'workspace-a',
      'projects',
      'project-a',
      'memory.md',
    ),
    '- legacy project\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'threads', 'lark-channel_root.md'),
    '- legacy thread\n',
    'utf8',
  );

  const store = new ScopedFileMemoryStore(root);
  const project = query('workspace-a', 'project-a');
  const snapshot = await store.loadMemory(project);
  assert.match(snapshot.scopes[0].content, /legacy global/);
  assert.match(snapshot.scopes[2].content, /legacy project/);
  assert.equal(snapshot.scopes[3].content, '');
  assert.match(snapshot.scopes[4].content, /legacy thread/);
  const history = await store.getMemoryHistory({ ...project, scope: 'project' });
  assert.equal(history.revisions[0].action, 'import');
  assert.equal(history.revisions[0].actorId, 'system:legacy-import');

  await store.restoreScoped({
    ...project,
    scope: 'project',
    revisionId: history.revisions[0].id,
    actorId: 'operator:owner',
  });

  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'new fact',
    actorId: 'operator:owner',
  });
  const persisted = JSON.parse(
    await fs.readFile(path.join(root, 'memory-state.json'), 'utf8'),
  );
  assert.equal(persisted.documents.length, 3);
  assert.equal(persisted.revisions.length, 5);
});

test('memory proposals approve or reject without bypassing revision history', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-proposals-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const project = query('workspace-a', 'project-a');

  const proposal = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'remember',
    value: 'needs operator approval',
    actorId: 'lark:ou-requester',
    source: 'lark-command',
    searchAliases: ['future approval question', '未来审批问题'],
  });
  assert.equal(proposal.status, 'pending');
  assert.equal(
    (await store.loadMemory({ ...project, scopes: ['project'] })).scopes[0]
      .content,
    '',
  );
  assert.equal(
    (await store.listMemoryProposals({ status: 'pending', workspaceId: 'workspace-a' }))
      .length,
    1,
  );
  assert.deepEqual(await store.listMemorySemanticIndex({
    ...project,
    scopes: ['project'],
  }), []);
  const duplicate = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'remember',
    value: '  NEEDS   operator approval ',
    actorId: 'agent:codex',
    source: 'agent-run:duplicate',
  });
  assert.equal(duplicate.id, proposal.id);
  assert.equal(duplicate.source, 'lark-command');
  assert.equal(
    (await store.listMemoryProposals({ status: 'pending', workspaceId: 'workspace-a' }))
      .length,
    1,
  );

  const approved = await store.approveMemoryProposal({
    id: proposal.id,
    actorId: 'operator:owner',
    reason: 'looks useful',
  });
  assert.equal(approved.status, 'approved');
  assert.ok(approved.appliedRevisionId);
  const history = await store.getMemoryHistory({ ...project, scope: 'project' });
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].source, 'memory-approval');
  assert.match(history.document.content, /needs operator approval/);
  let semanticIndex = await store.listMemorySemanticIndex({
    ...project,
    scopes: ['project'],
  });
  assert.equal(semanticIndex.length, 1);
  assert.deepEqual(semanticIndex[0].aliases, [
    'future approval question',
    '未来审批问题',
  ]);
  assert.equal(semanticIndex[0].version, history.document.version);

  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'A later independent fact.',
    actorId: 'operator:owner',
  });
  semanticIndex = await store.listMemorySemanticIndex({
    ...project,
    scopes: ['project'],
  });
  assert.equal(semanticIndex.length, 1);
  assert.equal(
    semanticIndex[0].version,
    (await store.getMemoryHistory({ ...project, scope: 'project' })).document.version,
  );

  const rejectProposal = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'forget',
    value: 'needs operator approval',
    actorId: 'lark:ou-requester',
    source: 'lark-command',
  });
  const rejected = await store.rejectMemoryProposal({
    id: rejectProposal.id,
    actorId: 'operator:owner',
    reason: 'keep it for now',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(
    (await store.listMemorySemanticIndex({ ...project, scopes: ['project'] }))
      .length,
    1,
  );
  assert.equal(
    (await store.getMemoryHistory({ ...project, scope: 'project' })).revisions
      .length,
    2,
  );
});

test('memory replace proposals merge atomically and reject stale versions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-replace-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const project = query('workspace-a', 'project-a');

  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'Use SQLite WAL for shared workers.',
    actorId: 'operator:owner',
  });
  const current = await store.getMemoryHistory({ ...project, scope: 'project' });
  const replacement = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'replace',
    value: 'Use Postgres for distributed workers.',
    selector: 'Use SQLite WAL for shared workers.',
    expectedDocumentVersion: current.document.version,
    actorId: 'memory-runner:codex',
  });
  const approved = await store.approveMemoryProposal({
    id: replacement.id,
    actorId: 'operator:owner',
  });
  assert.equal(approved.status, 'approved');
  const merged = await store.getMemoryHistory({ ...project, scope: 'project' });
  assert.doesNotMatch(merged.document.content, /SQLite WAL/);
  assert.match(merged.document.content, /Postgres for distributed workers/);
  assert.equal(merged.revisions[0].action, 'replace');

  const stale = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'replace',
    value: 'Use an in-memory queue.',
    selector: 'Use Postgres for distributed workers.',
    expectedDocumentVersion: merged.document.version,
    actorId: 'memory-runner:codex',
  });
  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'Keep WAL backups for 30 days.',
    actorId: 'operator:owner',
  });
  await assert.rejects(
    store.approveMemoryProposal({ id: stale.id, actorId: 'operator:owner' }),
    /memory_proposal_stale_document_version/,
  );
});

test('remember proposals from the same analysis can be approved sequentially', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-remember-batch-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const project = query('workspace-a', 'project-a');
  const before = await store.getMemoryHistory({ ...project, scope: 'project' });

  const first = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'remember',
    value: 'The production database is Postgres.',
    expectedDocumentVersion: before.document?.version ?? 0,
    actorId: 'memory-runner:codex',
  });
  const second = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'remember',
    value: 'Database backups are retained for 30 days.',
    expectedDocumentVersion: before.document?.version ?? 0,
    actorId: 'memory-runner:codex',
  });

  await store.approveMemoryProposal({
    id: first.id,
    actorId: 'operator:owner',
  });
  const approved = await store.approveMemoryProposal({
    id: second.id,
    actorId: 'operator:owner',
  });
  assert.equal(approved.status, 'approved');

  const after = await store.getMemoryHistory({ ...project, scope: 'project' });
  assert.match(after.document.content, /production database is Postgres/u);
  assert.match(after.document.content, /backups are retained for 30 days/u);
  assert.equal(after.document.version, (before.document?.version ?? 0) + 2);
});

test('memory merge proposals collapse multiple approved facts in one atomic revision', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-merge-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const project = query('workspace-a', 'project-a');

  for (const [text, alias] of [
    ['Use Postgres for distributed workers.', 'shared worker database'],
    ['Keep database backups for 30 days.', 'database retention period'],
  ]) {
    const proposal = await store.proposeMemory({
      ...project,
      scope: 'project',
      action: 'remember',
      value: text,
      actorId: 'memory-runner:codex',
      searchAliases: [alias],
    });
    await store.approveMemoryProposal({
      id: proposal.id,
      actorId: 'operator:owner',
    });
  }
  const before = await store.getMemoryHistory({ ...project, scope: 'project' });
  const merge = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'merge',
    value: 'Distributed workers use Postgres with 30-day database backups.',
    selectors: [
      'Use Postgres for distributed workers.',
      'Keep database backups for 30 days.',
    ],
    expectedDocumentVersion: before.document.version,
    actorId: 'memory-runner:codex',
    searchAliases: ['worker persistence and retention policy'],
    retentionDays: 60,
  });
  const approved = await store.approveMemoryProposal({
    id: merge.id,
    actorId: 'operator:owner',
  });
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.selectors, [
    'Use Postgres for distributed workers.',
    'Keep database backups for 30 days.',
  ]);
  const after = await store.getMemoryHistory({ ...project, scope: 'project' });
  assert.equal(after.document.version, before.document.version + 1);
  assert.equal(after.revisions.length, before.revisions.length + 1);
  assert.equal(after.revisions[0].action, 'merge');
  assert.deepEqual(after.revisions[0].selectors, approved.selectors);
  assert.doesNotMatch(after.document.content, /Use Postgres for distributed workers/u);
  assert.doesNotMatch(after.document.content, /Keep database backups for 30 days/u);
  assert.match(after.document.content, /Postgres with 30-day database backups/u);
  const semantic = await store.listMemorySemanticIndex({
    ...project,
    scopes: ['project'],
  });
  assert.equal(semantic.length, 1);
  assert.deepEqual(semantic[0].aliases, [
    'worker persistence and retention policy',
  ]);
  const expiry = await store.getMemoryExpiry({ ...project, scope: 'project' });
  assert.equal(expiry.entries.length, 1);

  const stale = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'merge',
    value: 'A stale merge.',
    selectors: [
      'Distributed workers use Postgres with 30-day database backups.',
      'A later independent fact.',
    ],
    expectedDocumentVersion: after.document.version,
    actorId: 'memory-runner:codex',
  });
  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'A later independent fact.',
    actorId: 'operator:owner',
  });
  await assert.rejects(
    store.approveMemoryProposal({ id: stale.id, actorId: 'operator:owner' }),
    /memory_proposal_stale_document_version/u,
  );
  await assert.rejects(
    store.proposeMemory({
      ...project,
      scope: 'project',
      action: 'merge',
      value: 'An over-broad merge.',
      selectors: Array.from({ length: 9 }, (_, index) => `fact-${index}`),
      expectedDocumentVersion: after.document.version,
      actorId: 'memory-runner:codex',
    }),
    /memory_merge_selectors_limit_exceeded/u,
  );
});

test('index proposals backfill aliases without changing approved memory revisions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-index-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const project = query('workspace-a', 'project-a');
  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'Use Postgres for distributed workers.',
    actorId: 'operator:owner',
  });
  const before = await store.getMemoryHistory({ ...project, scope: 'project' });
  const proposal = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'index',
    value: 'Use Postgres for distributed workers.',
    selector: 'Use Postgres for distributed workers.',
    expectedDocumentVersion: before.document.version,
    actorId: 'memory-runner:codex',
    searchAliases: ['分布式 worker 数据库', 'shared task persistence'],
  });
  assert.equal(
    (await store.listMemorySemanticIndex({ ...project, scopes: ['project'] }))
      .length,
    0,
  );
  const approved = await store.approveMemoryProposal({
    id: proposal.id,
    actorId: 'operator:owner',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.appliedRevisionId, undefined);
  const after = await store.getMemoryHistory({ ...project, scope: 'project' });
  assert.equal(after.document.version, before.document.version);
  assert.equal(after.revisions.length, before.revisions.length);
  const index = await store.listMemorySemanticIndex({
    ...project,
    scopes: ['project'],
  });
  assert.equal(index.length, 1);
  assert.deepEqual(index[0].aliases, [
    '分布式 worker 数据库',
    'shared task persistence',
  ]);

  const stale = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'index',
    value: 'Use Postgres for distributed workers.',
    selector: 'Use Postgres for distributed workers.',
    expectedDocumentVersion: after.document.version,
    actorId: 'memory-runner:codex',
    searchAliases: ['PG worker storage'],
  });
  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'Another durable fact.',
    actorId: 'operator:owner',
  });
  await assert.rejects(
    store.approveMemoryProposal({ id: stale.id, actorId: 'operator:owner' }),
    /memory_proposal_stale_document_version/u,
  );
});

test('memory search is lexical, bounded, and isolated to the requested route scopes', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-search-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const payments = query('workspace-a', 'payments');
  const support = query('workspace-a', 'support');

  await store.rememberScoped({
    ...payments,
    scope: 'project',
    text: 'Use SQLite WAL for shared payment workers.',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...support,
    scope: 'project',
    text: 'Use a private support escalation queue.',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...payments,
    scope: 'thread',
    text: 'The current rollout is canary only.',
    actorId: 'operator:owner',
  });

  const projectResult = await store.searchMemory({
    ...payments,
    scopes: ['project'],
    query: 'sqlite shared workers',
  });
  assert.equal(projectResult.scannedDocuments, 1);
  assert.equal(projectResult.hits.length, 1);
  assert.match(projectResult.hits[0].line, /SQLite WAL/u);
  assert.equal(projectResult.hits[0].scope.kind, 'project');

  const isolated = await store.searchMemory({
    ...payments,
    scopes: ['project'],
    query: 'support escalation',
  });
  assert.deepEqual(isolated.hits, []);

  const threadResult = await store.searchMemory({
    ...payments,
    scopes: ['thread'],
    query: 'canary',
    limit: 1,
  });
  assert.equal(threadResult.hits.length, 1);
  assert.equal(threadResult.hits[0].scope.kind, 'thread');
});

test('memory expiry hides facts without deleting history and follows unchanged lines across versions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-expiry-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const project = query('workspace-a', 'project-a');

  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'Temporary launch code is sunrise-seven.',
    expiresAt: '2000-01-01T00:00:00.000Z',
    actorId: 'operator:owner',
    source: 'operator-api',
  });
  const first = await store.getMemoryHistory({ ...project, scope: 'project' });
  const indexProposal = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'index',
    value: 'Temporary launch code is sunrise-seven.',
    selector: 'Temporary launch code',
    expectedDocumentVersion: first.document.version,
    actorId: 'memory-runner:codex',
    searchAliases: ['临时发布口令'],
  });
  await store.approveMemoryProposal({
    id: indexProposal.id,
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'Durable owner is the platform team.',
    actorId: 'operator:owner',
  });

  const hidden = await store.loadMemory({ ...project, scopes: ['project'] });
  assert.doesNotMatch(hidden.text, /sunrise-seven/u);
  assert.match(hidden.text, /Durable owner/u);
  assert.deepEqual(hidden.scopes[0].lineNumbers, [2]);
  assert.equal(hidden.scopes[0].expiredLines, 1);
  assert.doesNotMatch(hidden.scopes[0].document.content, /sunrise-seven/u);
  assert.match(
    (await store.getMemoryHistory({ ...project, scope: 'project' })).document.content,
    /sunrise-seven/u,
  );
  assert.deepEqual(
    (await store.searchMemory({
      ...project,
      scopes: ['project'],
      query: 'sunrise-seven',
    })).hits,
    [],
  );
  assert.deepEqual(
    await store.listMemorySemanticIndex({ ...project, scopes: ['project'] }),
    [],
  );
  const expiry = await store.getMemoryExpiry({
    ...project,
    scope: 'project',
    includeAudit: true,
  });
  assert.equal(expiry.entries.length, 1);
  assert.equal(expiry.entries[0].version, hidden.scopes[0].document.version);
  assert.equal(expiry.entries[0].lineNumber, 1);
  assert.equal(expiry.audit.length, 1);
  assert.equal(expiry.audit[0].action, 'set');
  assert.equal(expiry.audit[0].actorId, 'operator:owner');
  assert.equal(Object.hasOwn(expiry.audit[0], 'text'), false);

  const cleared = await store.setMemoryExpiry({
    ...project,
    scope: 'project',
    selector: 'Temporary launch code',
    actorId: 'operator:owner',
    source: 'operator-api',
  });
  assert.equal(cleared.entries.length, 0);
  assert.deepEqual(
    cleared.audit.map((record) => record.action),
    ['clear', 'set'],
  );
  const restored = await store.loadMemory({ ...project, scopes: ['project'] });
  assert.match(restored.text, /sunrise-seven/u);
  assert.deepEqual(restored.scopes[0].lineNumbers, [1, 2]);
  assert.equal(
    (await store.listMemorySemanticIndex({ ...project, scopes: ['project'] })).length,
    1,
  );

  await store.setMemoryExpiry({
    ...project,
    scope: 'project',
    selector: 'Durable owner',
    expiresAt: '2030-01-01T00:00:00.000Z',
    actorId: 'operator:owner',
  });
  await store.rememberScoped({
    ...project,
    scope: 'project',
    text: 'A third fact advances the document version.',
    actorId: 'operator:owner',
  });
  const migrated = await store.getMemoryExpiry({ ...project, scope: 'project' });
  assert.equal(migrated.entries.length, 1);
  assert.equal(migrated.entries[0].lineNumber, 2);
  assert.equal(
    migrated.entries[0].version,
    (await store.getMemoryHistory({ ...project, scope: 'project' })).document.version,
  );
  await store.forgetScoped({
    ...project,
    scope: 'project',
    selector: 'Durable owner',
    actorId: 'operator:owner',
  });
  assert.equal(
    (await store.getMemoryExpiry({ ...project, scope: 'project' })).entries.length,
    0,
  );

  await store.rememberScoped({
    ...project,
    scope: 'thread',
    text: 'Temporary checklist:\nconfirm canary\nremove test binding',
    expiresAt: '2000-01-01T00:00:00.000Z',
    actorId: 'operator:owner',
  });
  const multiline = await store.loadMemory({ ...project, scopes: ['thread'] });
  assert.equal(multiline.scopes[0].expiredLines, 3);
  assert.equal(multiline.scopes[0].content, '');
  assert.equal(
    (await store.getMemoryExpiry({ ...project, scope: 'thread' })).entries.length,
    3,
  );
  await store.setMemoryExpiry({
    ...project,
    scope: 'thread',
    selector: 'confirm canary',
    actorId: 'operator:owner',
  });
  assert.equal(
    (await store.getMemoryExpiry({ ...project, scope: 'thread' })).entries.length,
    0,
  );
  assert.match(
    (await store.loadMemory({ ...project, scopes: ['thread'] })).text,
    /Temporary checklist:[\s\S]*remove test binding/u,
  );
});

test('approved proposals apply default retention at approval time to complete new notes', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-retention-approval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ScopedFileMemoryStore(root);
  const project = query('workspace-a', 'project-a');
  const proposal = await store.proposeMemory({
    ...project,
    scope: 'project',
    action: 'remember',
    value: 'Temporary rollout checklist:\nconfirm canary\nremove test binding',
    actorId: 'memory-runner:codex',
    retentionDays: 30,
  });
  assert.equal(proposal.retentionDays, 30);
  assert.equal((await store.getMemoryExpiry({ ...project, scope: 'project' })).entries.length, 0);

  const approvedAt = Date.now();
  await store.approveMemoryProposal({ id: proposal.id, actorId: 'operator:owner' });
  const expiry = await store.getMemoryExpiry({
    ...project,
    scope: 'project',
    includeAudit: true,
  });
  assert.equal(expiry.entries.length, 3);
  assert.equal(expiry.audit.length, 3);
  assert.ok(expiry.entries.every((entry) => entry.source === 'memory-retention-policy'));
  const expected = approvedAt + 30 * 24 * 60 * 60 * 1_000;
  assert.ok(
    expiry.entries.every(
      (entry) => Math.abs(Date.parse(entry.expiresAt) - expected) < 2_000,
    ),
  );

  await assert.rejects(
    store.proposeMemory({
      ...project,
      scope: 'project',
      action: 'remember',
      value: 'Invalid retention.',
      retentionDays: 0,
    }),
    /memory_retention_days_invalid/u,
  );
});
