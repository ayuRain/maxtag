import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileLarkBotCredentialStore,
  LarkBotCredentialRevisionConflictError,
} from '@opentag/config';

test('managed Lark credentials are encrypted at rest and revisioned', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-bot-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileLarkBotCredentialStore(root);

  assert.deepEqual(await store.getSummary(), {
    configured: false,
    revision: 0,
    domain: 'feishu',
  });
  const created = await store.save({
    appId: 'cli_test_app',
    appSecret: 'test-secret-never-persist-plainly',
    domain: 'feishu',
    expectedRevision: 0,
    actor: 'operator:installation-owner',
  });
  assert.equal(created.configured, true);
  assert.equal(created.revision, 1);
  assert.equal(created.appId, 'cli_test_app');
  assert.equal(JSON.stringify(created).includes('test-secret'), false);

  const persisted = await fs.readFile(store.stateFile, 'utf8');
  assert.equal(persisted.includes('cli_test_app'), false);
  assert.equal(persisted.includes('test-secret-never-persist-plainly'), false);
  assert.match(persisted, /"algorithm": "aes-256-gcm"/u);
  assert.equal((await fs.stat(store.stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(store.keyFile)).mode & 0o777, 0o600);

  const reopened = new FileLarkBotCredentialStore(root);
  assert.deepEqual(await reopened.get(), {
    revision: 1,
    appId: 'cli_test_app',
    appSecret: 'test-secret-never-persist-plainly',
    domain: 'feishu',
    updatedAt: created.updatedAt,
    updatedBy: 'operator:installation-owner',
  });
  await assert.rejects(
    reopened.save({
      appId: 'cli_test_app',
      appSecret: 'replacement-secret-value',
      expectedRevision: 0,
      actor: 'operator:installation-owner',
    }),
    (error) =>
      error instanceof LarkBotCredentialRevisionConflictError &&
      error.currentRevision === 1,
  );

  assert.deepEqual(await reopened.remove({ expectedRevision: 1 }), {
    configured: false,
    revision: 0,
    domain: 'feishu',
  });
  assert.equal(await reopened.get(), undefined);
  await assert.rejects(fs.stat(store.stateFile), { code: 'ENOENT' });
});
