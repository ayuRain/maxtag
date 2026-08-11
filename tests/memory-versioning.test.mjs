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
  await assert.rejects(
    store.restoreScoped({
      ...projectB,
      scope: 'project',
      revisionId: original.revisions[0].id,
    }),
    /memory_revision_not_found/,
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
  assert.match(snapshot.scopes[3].content, /legacy thread/);
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
