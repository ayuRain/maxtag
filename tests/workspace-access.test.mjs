import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileWorkspaceAccessStore } from '../packages/config/dist/index.js';

function actor(id) {
  return { id, platformUserId: id };
}

test('workspace access persists identities, roles, and project capabilities', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-access-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileWorkspaceAccessStore(root);

  const legacyOpen = await store.authorize({
    workspaceId: 'acme',
    projectId: 'alpha',
    platform: 'lark',
    actor: actor('ou-anyone'),
    capability: 'manage_routines',
  });
  assert.equal(legacyOpen.allowed, true);
  assert.equal(legacyOpen.reason, 'open_access');

  await assert.rejects(
    store.upsertMember({
      workspaceId: 'acme',
      displayName: 'Wrong first member',
      role: 'member',
      identities: [{ platform: 'lark', externalId: 'ou-wrong' }],
    }),
    /workspace_first_member_must_be_owner/,
  );

  const owner = await store.upsertMember({
    workspaceId: 'acme',
    displayName: 'Workspace Owner',
    role: 'owner',
    identities: [{ platform: 'lark', externalId: 'ou-owner' }],
    actor: 'bootstrap',
  });
  const contributor = await store.upsertMember({
    workspaceId: 'acme',
    displayName: 'Project Contributor',
    role: 'member',
    identities: [{ platform: 'lark', externalId: 'ou-contributor' }],
  });
  const viewer = await store.upsertMember({
    workspaceId: 'acme',
    displayName: 'Project Viewer',
    role: 'guest',
    identities: [{ platform: 'lark', externalId: 'ou-viewer' }],
  });

  await assert.rejects(
    store.upsertMember({
      workspaceId: 'acme',
      displayName: 'Duplicate identity',
      role: 'member',
      identities: [{ platform: 'lark', externalId: 'ou-contributor' }],
    }),
    /workspace_member_identity_already_linked/,
  );
  await assert.rejects(
    store.upsertMember({
      ...owner,
      role: 'admin',
      actor: 'unsafe-change',
    }),
    /workspace_last_owner_required/,
  );

  await store.setProjectPolicy({
    workspaceId: 'acme',
    projectId: 'alpha',
    mode: 'members',
  });
  await store.upsertProjectMembership({
    workspaceId: 'acme',
    projectId: 'alpha',
    memberId: contributor.id,
    role: 'contributor',
  });
  await store.upsertProjectMembership({
    workspaceId: 'acme',
    projectId: 'alpha',
    memberId: viewer.id,
    role: 'viewer',
  });

  const unknown = await store.authorize({
    workspaceId: 'acme',
    projectId: 'alpha',
    platform: 'lark',
    actor: actor('ou-unknown'),
    capability: 'invoke_agent',
  });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, 'workspace_member_required');

  const contributorInvoke = await store.authorize({
    workspaceId: 'acme',
    projectId: 'alpha',
    platform: 'lark',
    actor: actor('ou-contributor'),
    capability: 'invoke_agent',
  });
  assert.equal(contributorInvoke.allowed, true);
  assert.equal(contributorInvoke.projectMembership?.role, 'contributor');

  const contributorRoutine = await store.authorize({
    workspaceId: 'acme',
    projectId: 'alpha',
    platform: 'lark',
    actor: actor('ou-contributor'),
    capability: 'manage_routines',
  });
  assert.equal(contributorRoutine.allowed, false);
  assert.equal(contributorRoutine.reason, 'capability_not_granted');

  const viewerInvoke = await store.authorize({
    workspaceId: 'acme',
    projectId: 'alpha',
    platform: 'lark',
    actor: actor('ou-viewer'),
    capability: 'invoke_agent',
  });
  assert.equal(viewerInvoke.allowed, false);

  const ownerRoutine = await store.authorize({
    workspaceId: 'acme',
    projectId: 'alpha',
    platform: 'lark',
    actor: actor('ou-owner'),
    capability: 'manage_routines',
  });
  assert.equal(ownerRoutine.allowed, true);
  assert.equal(ownerRoutine.reason, 'workspace_role');

  const reopened = new FileWorkspaceAccessStore(root);
  const snapshot = await reopened.snapshot('acme');
  assert.equal(snapshot.members.length, 3);
  assert.equal(snapshot.projectMemberships.length, 2);
  assert.equal(snapshot.projectPolicies[0].mode, 'members');
  assert.ok(snapshot.audit.length >= 6);
});
