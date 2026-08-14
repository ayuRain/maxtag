import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ExecutorCredentialRevisionConflictError,
  FileExecutorCredentialStore,
  managedExecutorRuntimeSettings,
} from '@opentag/config';

test('managed executor credentials are encrypted, revisioned, and never summarized with secrets', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-executor-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileExecutorCredentialStore(root);

  assert.deepEqual(await store.getSummary(), {
    configured: false,
    revision: 0,
    provider: 'codex',
    authMode: 'cli',
    hasApiKey: false,
  });
  const created = await store.save({
    provider: 'codex',
    authMode: 'api-key',
    model: 'gpt-5.5',
    baseUrl: 'https://api.example.test/v1/',
    apiKey: 'sk-secret-never-persist-plainly',
    expectedRevision: 0,
    actor: 'operator:installation-owner',
  });
  assert.equal(created.configured, true);
  assert.equal(created.revision, 1);
  assert.equal(created.hasApiKey, true);
  assert.equal(JSON.stringify(created).includes('sk-secret'), false);
  assert.equal(created.baseUrl, 'https://api.example.test/v1');

  const persisted = await fs.readFile(store.stateFile, 'utf8');
  assert.equal(persisted.includes('api.example.test'), false);
  assert.equal(persisted.includes('sk-secret-never-persist-plainly'), false);
  assert.match(persisted, /"algorithm": "aes-256-gcm"/u);
  assert.equal((await fs.stat(store.stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(store.keyFile)).mode & 0o777, 0o600);

  const reopened = new FileExecutorCredentialStore(root);
  const credential = await reopened.get();
  assert.equal(credential.apiKey, 'sk-secret-never-persist-plainly');
  const runtime = managedExecutorRuntimeSettings(credential);
  assert.deepEqual(runtime.enabledExecutorIds, ['codex']);
  assert.equal(runtime.defaultExecutorId, 'codex');
  assert.equal(runtime.codexEnvironment.MAXTAG_EXECUTOR_API_KEY, credential.apiKey);
  assert.equal(runtime.codexCommandPrefixArgs.includes('sk-secret-never-persist-plainly'), false);
  assert.match(runtime.codexCommandPrefixArgs.join(' '), /env_key=.*MAXTAG_EXECUTOR_API_KEY/u);

  await assert.rejects(
    reopened.save({
      provider: 'claude',
      authMode: 'cli',
      expectedRevision: 0,
      actor: 'operator:installation-owner',
    }),
    (error) =>
      error instanceof ExecutorCredentialRevisionConflictError &&
      error.currentRevision === 1,
  );
  assert.deepEqual(await reopened.remove({ expectedRevision: 1 }), {
    configured: false,
    revision: 0,
    provider: 'codex',
    authMode: 'cli',
    hasApiKey: false,
  });
});

test('managed executor configuration rejects unsafe URLs and missing API keys', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-executor-invalid-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileExecutorCredentialStore(root);

  await assert.rejects(
    store.save({
      provider: 'codex',
      authMode: 'api-key',
      baseUrl: 'http://127.0.0.1:9999/v1',
      apiKey: 'valid-length-key',
      actor: 'operator:installation-owner',
    }),
    /executor_invalid_base_url/u,
  );
  await assert.rejects(
    store.save({
      provider: 'claude',
      authMode: 'api-key',
      actor: 'operator:installation-owner',
    }),
    /executor_api_key_required/u,
  );
});
