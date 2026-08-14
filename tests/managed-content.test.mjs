import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectCliArtifacts } from '@opentag/executor-cli';
import {
  ManagedContentError,
  ManagedContentStore,
  pathIsWithin,
} from '@opentag/runtime-host';

function message(projectId = 'payments') {
  const thread = {
    id: `custom:room:${projectId}`,
    platform: 'custom-chat',
    externalId: `room:${projectId}`,
    workspaceId: 'acme',
    projectId,
    visibility: 'public',
  };
  return {
    thread,
    message: {
      id: `message:${projectId}`,
      threadId: thread.id,
      platform: 'custom-chat',
      text: 'Inspect this file.',
      actor: { id: 'user-1' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
  };
}

test('managed content materializes client bytes into isolated content-addressed paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-content-'));
  try {
    const store = new ManagedContentStore({ rootDir: root, maxBytes: 1024 });
    const first = message('payments');
    const attachment = {
      id: 'client-file-1',
      kind: 'file',
      name: '../../report.txt',
      mimeType: 'text/plain',
      metadata: {
        clientContentBase64: Buffer.from('managed report').toString('base64'),
      },
    };
    const managed = await store.materializeClientAttachment({
      ...first,
      attachment,
    });

    assert.equal(managed.name, 'report.txt');
    assert.equal(managed.sizeBytes, 14);
    assert.equal(managed.metadata.managed, true);
    assert.equal(managed.metadata.source, 'client');
    assert.equal(managed.metadata.clientContentBase64, undefined);
    assert.equal(pathIsWithin(root, managed.localPath), true);
    assert.equal(await fs.readFile(managed.localPath, 'utf8'), 'managed report');

    const other = message('ledger');
    const isolated = await store.materializeClientAttachment({
      ...other,
      attachment,
    });
    assert.notEqual(path.dirname(isolated.localPath), path.dirname(managed.localPath));
    assert.equal(isolated.metadata.projectId, 'ledger');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('managed content rejects host paths, invalid base64, empty files, and size overflow', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-content-errors-'));
  const scoped = message();
  const store = new ManagedContentStore({ rootDir: root, maxBytes: 4 });
  try {
    await assert.rejects(
      store.materializeClientAttachment({
        ...scoped,
        attachment: {
          id: 'path',
          kind: 'file',
          metadata: {
            clientLocalPathRejected: true,
            clientContentBase64: Buffer.from('data').toString('base64'),
          },
        },
      }),
      (error) =>
        error instanceof ManagedContentError &&
        error.code === 'attachment_local_path_not_allowed',
    );
    await assert.rejects(
      store.materializeClientAttachment({
        ...scoped,
        attachment: {
          id: 'bad',
          kind: 'file',
          metadata: { clientContentBase64: 'not base64!' },
        },
      }),
      (error) =>
        error instanceof ManagedContentError &&
        error.code === 'attachment_base64_invalid',
    );
    await assert.rejects(
      store.materializeClientAttachment({
        ...scoped,
        attachment: {
          id: 'large',
          kind: 'file',
          metadata: {
            clientContentBase64: Buffer.from('too large').toString('base64'),
          },
        },
      }),
      (error) =>
        error instanceof ManagedContentError && error.code === 'attachment_too_large',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('managed content refuses a scoped directory redirected outside its root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-content-symlink-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-content-outside-'));
  const scoped = message();
  const store = new ManagedContentStore({ rootDir: root, maxBytes: 1024 });
  const attachment = {
    id: 'redirected',
    kind: 'file',
    name: 'report.txt',
    metadata: {
      clientContentBase64: Buffer.from('managed report').toString('base64'),
    },
  };
  try {
    const first = await store.materializeClientAttachment({
      ...scoped,
      attachment,
    });
    const messageDirectory = path.dirname(first.localPath);
    await fs.rm(messageDirectory, { recursive: true, force: true });
    await fs.symlink(outside, messageDirectory, 'dir');

    await assert.rejects(
      store.materializeClientAttachment({ ...scoped, attachment }),
      (error) =>
        error instanceof ManagedContentError &&
        error.code === 'attachment_path_invalid',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('managed content does not create scopes through a redirected inputs directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-content-root-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-content-root-outside-'));
  const scoped = message();
  const store = new ManagedContentStore({ rootDir: root, maxBytes: 1024 });
  try {
    await fs.symlink(outside, path.join(root, 'inputs'), 'dir');
    await assert.rejects(
      store.materializeClientAttachment({
        ...scoped,
        attachment: {
          id: 'redirected-root',
          kind: 'file',
          name: 'report.txt',
          metadata: {
            clientContentBase64: Buffer.from('managed report').toString('base64'),
          },
        },
      }),
      (error) =>
        error instanceof ManagedContentError &&
        error.code === 'attachment_path_invalid',
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('CLI artifact collection strips declarations and rejects traversal and symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-artifacts-'));
  const cwd = path.join(root, 'project');
  const artifactRoot = path.join(root, 'managed');
  try {
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'report.csv'), 'metric,value\nlatency,42\n');
    await fs.writeFile(path.join(root, 'outside.txt'), 'secret');
    await fs.symlink(path.join(root, 'outside.txt'), path.join(cwd, 'outside-link.txt'));

    const result = await collectCliArtifacts({
      finalMessage: [
        'Report complete.',
        'OPENTAG_ARTIFACT: {"path":"report.csv","title":"Latency report","kind":"report"}',
        'OPENTAG_ARTIFACT: {"path":"../outside.txt","title":"Outside"}',
        'OPENTAG_ARTIFACT: {"path":"outside-link.txt","title":"Symlink"}',
      ].join('\n'),
      cwd,
      artifactRoot,
      runId: 'run-artifact-1',
    });

    assert.equal(result.summary, 'Report complete.');
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].title, 'Latency report');
    assert.equal(result.artifacts[0].metadata.managed, true);
    assert.equal(pathIsWithin(artifactRoot, result.artifacts[0].path), true);
    assert.equal(
      await fs.readFile(result.artifacts[0].path, 'utf8'),
      'metric,value\nlatency,42\n',
    );
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some((warning) => warning.includes('escaped')));
    assert.ok(result.warnings.some((warning) => warning.includes('outside')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI artifact collection publishes durable HTTPS link and pull-request references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-artifact-links-'));
  try {
    const result = await collectCliArtifacts({
      finalMessage: [
        'References ready.',
        'OPENTAG_ARTIFACT: {"url":"https://github.com/ayuRain/MaxTag/pull/42#discussion","title":"Isolation proof","kind":"pull-request"}',
        'OPENTAG_ARTIFACT: {"url":"https://docs.example.com/report?id=7","title":"Hosted report","kind":"link"}',
        'OPENTAG_ARTIFACT: {"url":"http://example.com/plain","kind":"link"}',
        'OPENTAG_ARTIFACT: {"url":"https://127.0.0.1/internal","kind":"link"}',
        'OPENTAG_ARTIFACT: {"url":"https://github.com/ayuRain/MaxTag/issues/42","kind":"pull-request"}',
      ].join('\n'),
      cwd: root,
      runId: 'run-artifact-links-1',
    });

    assert.equal(result.summary, 'References ready.');
    assert.equal(result.artifacts.length, 2);
    assert.deepEqual(
      result.artifacts.map((artifact) => ({
        kind: artifact.kind,
        title: artifact.title,
        url: artifact.url,
        storage: artifact.metadata.storage,
      })),
      [
        {
          kind: 'pull-request',
          title: 'Isolation proof',
          url: 'https://github.com/ayuRain/MaxTag/pull/42',
          storage: 'external-reference',
        },
        {
          kind: 'link',
          title: 'Hosted report',
          url: 'https://docs.example.com/report?id=7',
          storage: 'external-reference',
        },
      ],
    );
    assert.ok(result.artifacts.every((artifact) => artifact.metadata.managed === true));
    assert.equal(result.warnings.length, 3);
    assert.ok(result.warnings.some((warning) => warning.includes('must use HTTPS')));
    assert.ok(result.warnings.some((warning) => warning.includes('public DNS hostname')));
    assert.ok(result.warnings.some((warning) => warning.includes('/pull/<number>')));
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI artifact collection keeps link references when file storage is unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-artifact-link-no-root-'));
  try {
    await fs.writeFile(path.join(root, 'report.txt'), 'report');
    const result = await collectCliArtifacts({
      finalMessage: [
        'OPENTAG_ARTIFACT: {"path":"report.txt","kind":"report"}',
        'OPENTAG_ARTIFACT: {"url":"https://example.com/result","kind":"link"}',
      ].join('\n'),
      cwd: root,
      runId: 'run-artifact-link-no-root',
    });

    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].kind, 'link');
    assert.equal(result.artifacts[0].url, 'https://example.com/result');
    assert.ok(result.warnings.some((warning) => warning.includes('no managed artifact root')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI output extracts bounded memory candidates without exposing declarations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-candidates-'));
  try {
    const result = await collectCliArtifacts({
      finalMessage: [
        'Work complete.',
        'OPENTAG_MEMORY: {"scope":"project","text":"Use SQLite WAL for shared workers.","reason":"Runtime invariant"}',
        'OPENTAG_MEMORY: {"scope":"project","text":"Use SQLite WAL for shared workers."}',
        'OPENTAG_MEMORY: {"scope":"workspace","text":"Workspace-wide durable convention"}',
        'OPENTAG_MEMORY: {"scope":"thread","text":"Follow up after deployment"}',
        'OPENTAG_MEMORY: {"scope":"channel","text":"This fourth distinct declaration is ignored"}',
      ].join('\n'),
      cwd: root,
      runId: 'run-memory-candidate-1',
    });

    assert.equal(result.summary, 'Work complete.');
    assert.deepEqual(result.memoryCandidates, [
      {
        scope: 'project',
        text: 'Use SQLite WAL for shared workers.',
        reason: 'Runtime invariant',
      },
      {
        scope: 'workspace',
        text: 'Workspace-wide durable convention',
        reason: undefined,
      },
    ]);
    assert.ok(result.warnings.some((warning) => warning.includes('candidate limit')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI output extracts bounded semantic memory merge decisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-decisions-'));
  try {
    const result = await collectCliArtifacts({
      finalMessage: [
        'OPENTAG_MEMORY_DECISION: {"operation":"replace","scope":"project","text":"Use Postgres for distributed workers.","selector":"Use SQLite WAL for shared workers.","expectedDocumentVersion":3,"reason":"User explicitly replaced the storage decision","confidence":0.94}',
        'OPENTAG_MEMORY_DECISION: {"operation":"merge","scope":"project","text":"Use Postgres with 30-day backups.","selectors":["Use Postgres for distributed workers.","Keep database backups for 30 days."],"expectedDocumentVersion":3,"reason":"Consolidate storage policy","confidence":0.96}',
        'OPENTAG_MEMORY_DECISION: {"operation":"skip","scope":"thread","reason":"Transient status","confidence":0.2}',
        'OPENTAG_MEMORY_DECISION: {"operation":"forget","scope":"project","selector":"missing version"}',
        'OPENTAG_MEMORY_DECISION: {"operation":"merge","scope":"project","text":"Too broad.","selectors":["one","two","three","four","five","six","seven","eight","nine"],"expectedDocumentVersion":3}',
      ].join('\n'),
      cwd: root,
      runId: 'run-memory-decision-1',
    });

    assert.equal(result.summary, '');
    assert.deepEqual(result.memoryDecisions, [
      {
        operation: 'replace',
        scope: 'project',
        text: 'Use Postgres for distributed workers.',
        selector: 'Use SQLite WAL for shared workers.',
        selectors: undefined,
        expectedDocumentVersion: 3,
        reason: 'User explicitly replaced the storage decision',
        confidence: 0.94,
      },
      {
        operation: 'merge',
        scope: 'project',
        text: 'Use Postgres with 30-day backups.',
        selector: undefined,
        selectors: [
          'Use Postgres for distributed workers.',
          'Keep database backups for 30 days.',
        ],
        expectedDocumentVersion: 3,
        reason: 'Consolidate storage policy',
        confidence: 0.96,
      },
      {
        operation: 'skip',
        scope: 'thread',
        text: undefined,
        selector: undefined,
        selectors: undefined,
        expectedDocumentVersion: undefined,
        reason: 'Transient status',
        confidence: 0.2,
      },
    ]);
    assert.ok(
      result.warnings.some((warning) =>
        warning.includes('expectedDocumentVersion is required'),
      ),
    );
    assert.ok(
      result.warnings.some((warning) =>
        warning.includes('at most eight selectors are allowed'),
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI artifact collection refuses a redirected managed runs directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-artifact-root-link-'));
  const cwd = path.join(root, 'project');
  const artifactRoot = path.join(root, 'managed');
  const outside = path.join(root, 'outside');
  try {
    await fs.mkdir(cwd);
    await fs.mkdir(artifactRoot);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(cwd, 'report.txt'), 'managed report');
    await fs.symlink(outside, path.join(artifactRoot, 'runs'), 'dir');

    await assert.rejects(
      collectCliArtifacts({
        finalMessage:
          'OPENTAG_ARTIFACT: {"path":"report.txt","title":"Report"}',
        cwd,
        artifactRoot,
        runId: 'redirected-run',
      }),
      /managed_artifact_directory_escape/u,
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
