import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileOperatorCredentialStore,
  OperatorCredentialRevisionConflictError,
} from '@opentag/config';

test('operator credential store persists only token hashes and enforces lifecycle revisions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-operator-credentials-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileOperatorCredentialStore(root);

  const created = await store.create({
    id: 'ops-admin',
    displayName: 'Operations admin',
    role: 'admin',
    workspaceIds: ['dev-workspace'],
    actor: 'operator:installation-owner',
  });
  assert.match(created.token, /^otk_[A-Za-z0-9_-]{40,}$/u);
  assert.equal(created.credential.revision, 1);
  assert.equal((await store.authenticateToken(created.token))?.principal.id, 'ops-admin');
  assert.equal((await store.resolveActive('ops-admin', 1))?.principal.role, 'admin');

  const persisted = await fs.readFile(
    path.join(root, 'operator-credentials.json'),
    'utf8',
  );
  assert.equal(persisted.includes(created.token), false);
  assert.match(persisted, /"tokenHash": "[a-f0-9]{64}"/u);
  assert.equal(JSON.stringify(await store.list()).includes('tokenHash'), false);

  const rotated = await store.rotate({
    id: 'ops-admin',
    expectedRevision: 1,
    actor: 'operator:installation-owner',
  });
  assert.equal(rotated.credential.revision, 2);
  assert.equal(await store.authenticateToken(created.token), undefined);
  assert.equal(await store.resolveActive('ops-admin', 1), undefined);
  assert.equal((await store.authenticateToken(rotated.token))?.revision, 2);
  await assert.rejects(
    store.rotate({
      id: 'ops-admin',
      expectedRevision: 1,
      actor: 'operator:installation-owner',
    }),
    (error) =>
      error instanceof OperatorCredentialRevisionConflictError &&
      error.currentRevision === 2,
  );

  const revoked = await store.revoke({
    id: 'ops-admin',
    expectedRevision: 2,
    actor: 'operator:installation-owner',
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revision, 3);
  assert.equal(await store.authenticateToken(rotated.token), undefined);
  assert.equal(await store.resolveActive('ops-admin', 2), undefined);
  assert.deepEqual(
    (await store.listAudit()).map((record) => record.action),
    [
      'operator_credential.revoked',
      'operator_credential.rotated',
      'operator_credential.created',
    ],
  );
});

test('operator credential store preserves the last persistent installation owner', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-operator-owner-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileOperatorCredentialStore(root);
  await store.create({
    id: 'persistent-owner',
    displayName: 'Persistent owner',
    role: 'owner',
    workspaceIds: ['*'],
    actor: 'operator:local-development',
  });
  await assert.rejects(
    store.revoke({
      id: 'persistent-owner',
      expectedRevision: 1,
      actor: 'operator:persistent-owner',
      preserveInstallationOwner: true,
    }),
    /operator_credential_last_owner_required/u,
  );
  assert.equal((await store.list())[0].status, 'active');
});

test('operator credential store coordinates writers and keeps a stable session secret', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-operator-lock-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new FileOperatorCredentialStore(root);
  const second = new FileOperatorCredentialStore(root);

  const [secretA, secretB] = await Promise.all([
    first.sessionSecret(),
    second.sessionSecret(),
  ]);
  assert.equal(secretA, secretB);
  assert.ok(secretA.length >= 32);

  await Promise.all([
    first.create({
      id: 'viewer-a',
      displayName: 'Viewer A',
      role: 'viewer',
      workspaceIds: ['workspace-a'],
      actor: 'operator:installation-owner',
    }),
    second.create({
      id: 'viewer-b',
      displayName: 'Viewer B',
      role: 'viewer',
      workspaceIds: ['workspace-b'],
      actor: 'operator:installation-owner',
    }),
  ]);
  assert.deepEqual(
    (await first.list()).map((credential) => credential.id),
    ['viewer-a', 'viewer-b'],
  );
  assert.equal((await first.listAudit()).length, 2);
});
