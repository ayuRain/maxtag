import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileToolCredentialIdentityStore,
  ToolCredentialIdentityRevisionConflictError,
} from '@opentag/config';

test('tool credential identities persist env references without credential values', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-tool-identity-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileToolCredentialIdentityStore(root);

  const created = await store.upsert({
    id: 'lark-operations',
    displayName: 'Lark Operations',
    provider: 'lark',
    envRefs: {
      appId: 'LARK_OPERATIONS_APP_ID',
      appSecret: 'LARK_OPERATIONS_APP_SECRET',
    },
    externalActor: 'MaxTag Operations',
    actor: 'owner:ada',
  });
  assert.equal(created.revision, 1);
  assert.deepEqual(created.envRefs, {
    appId: 'LARK_OPERATIONS_APP_ID',
    appSecret: 'LARK_OPERATIONS_APP_SECRET',
    token: undefined,
  });
  const file = await fs.readFile(
    path.join(root, 'tool-credential-identities.json'),
    'utf8',
  );
  assert.match(file, /LARK_OPERATIONS_APP_SECRET/u);
  assert.doesNotMatch(file, /test-secret-value/u);

  const disabled = await store.setEnabled({
    id: created.id,
    enabled: false,
    expectedRevision: 1,
    actor: 'owner:ada',
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.revision, 2);
  await assert.rejects(
    store.setEnabled({ id: created.id, enabled: true, expectedRevision: 1 }),
    ToolCredentialIdentityRevisionConflictError,
  );
  assert.deepEqual(
    (await store.listAudit()).map((record) => record.action),
    ['tool_identity.disabled', 'tool_identity.created'],
  );
});

test('tool credential identity validation rejects raw values and provider mixing', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-tool-identity-invalid-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileToolCredentialIdentityStore(root);
  await assert.rejects(
    store.upsert({
      id: 'github-release',
      displayName: 'GitHub Release',
      provider: 'github',
      envRefs: { token: 'ghp_raw-secret' },
    }),
    /tool_credential_identity_invalid_env_ref/u,
  );
  await assert.rejects(
    store.upsert({
      id: 'github-release',
      displayName: 'GitHub Release',
      provider: 'github',
      envRefs: { token: 'GITHUB_RELEASE_TOKEN', appId: 'WRONG_APP_ID' },
    }),
    /tool_credential_identity_invalid_env_refs/u,
  );
});
