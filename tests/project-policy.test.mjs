import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileThreadConfigStore } from '@opentag/config';

test('project policy persists and resolves scoped identity and access', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-config-test-'));
  try {
    const store = new FileThreadConfigStore(rootDir, {
      workspace: {
        id: 'acme',
        name: 'Acme',
        defaultProjectId: 'general',
      },
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'payments',
      name: 'Payments',
      identity: {
        id: 'payments-agent',
        displayName: 'Payments Copilot',
        instructions: 'Own payment incidents.',
        defaultExecutorId: 'claude',
      },
      grants: [
        {
          id: 'payments:github',
          kind: 'github',
          scope: 'project',
          label: 'GitHub',
        },
      ],
      networkPolicy: {
        mode: 'restricted',
        allowedHosts: ['github.com'],
      },
      actor: 'test',
    });

    const reloaded = new FileThreadConfigStore(rootDir);
    const resolved = await reloaded.resolveThreadPolicy({
      id: 'lark:payments:root',
      platform: 'lark',
      externalId: 'payments:root',
      workspaceId: 'acme',
      projectId: 'payments',
      channelId: 'payments',
      visibility: 'public',
    });

    assert.equal(resolved.configured, true);
    assert.equal(resolved.workspace.name, 'Acme');
    assert.equal(resolved.project.name, 'Payments');
    assert.equal(resolved.identity.displayName, 'Payments Copilot');
    assert.equal(resolved.identity.defaultExecutorId, 'claude');
    assert.equal(resolved.access.networkPolicy.mode, 'restricted');
    assert.deepEqual(resolved.access.networkPolicy.allowedHosts, ['github.com']);
    assert.ok(resolved.access.grants.some((grant) => grant.kind === 'github'));
    assert.equal(
      resolved.access.grants.filter((grant) => grant.kind === 'memory').length,
      3,
    );
    assert.equal(
      resolved.access.grants.some((grant) => grant.scope === 'global'),
      false,
    );
    assert.deepEqual(
      resolved.access.grants.find((grant) => grant.scope === 'workspace')
        .constraints.permissions,
      ['read', 'write'],
    );
    assert.deepEqual(
      resolved.access.grants.find(
        (grant) => grant.id === 'memory:project:acme:payments',
      ).constraints.permissions,
      ['read', 'write'],
    );

    const audit = await reloaded.listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'project.created');
    assert.equal(audit[0].actor, 'test');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('workspace agent inheritance and memory boundaries follow the project profile', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-profile-test-'));
  try {
    const store = new FileThreadConfigStore(rootDir, {
      workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'general' },
    });
    await store.upsertWorkspacePolicy({
      workspaceId: 'acme',
      name: 'Acme Workspace',
      identity: {
        id: 'acme-agent',
        displayName: 'Acme Tag',
        instructions: 'Serve every Acme project.',
        defaultExecutorId: 'claude',
      },
      grants: [
        {
          id: 'workspace:acme:github',
          kind: 'github',
          scope: 'workspace',
          label: 'GitHub',
          constraints: { repositories: ['acme/shared'] },
        },
      ],
      networkPolicy: {
        mode: 'restricted',
        allowedHosts: ['github.com'],
      },
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'shared',
      name: 'Shared project',
      agentMode: 'inherit',
      capabilityMode: 'inherit',
      memoryMode: 'workspace',
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'legal',
      name: 'Legal',
      agentMode: 'inherit',
      capabilityMode: 'custom',
      grants: [
        {
          id: 'project:acme:legal:lark-docs',
          kind: 'lark-docs',
          scope: 'project',
          label: 'Lark Docs',
        },
      ],
      networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
      memoryMode: 'isolated',
      actor: 'operator:owner',
    });

    const publicThread = (projectId) => ({
      id: `lark:${projectId}:root`,
      platform: 'lark',
      externalId: `${projectId}:root`,
      workspaceId: 'acme',
      projectId,
      channelId: projectId,
      visibility: 'public',
    });
    const shared = await store.resolveThreadPolicy(publicThread('shared'));
    assert.equal(shared.workspace.name, 'Acme Workspace');
    assert.equal(shared.identity.displayName, 'Acme Tag');
    assert.equal(shared.access.networkPolicy.mode, 'restricted');
    assert.ok(shared.access.grants.some((grant) => grant.kind === 'github'));
    assert.equal(
      shared.access.grants.some((grant) => grant.kind === 'lark-docs'),
      false,
    );
    assert.deepEqual(
      shared.access.grants
        .filter((grant) => grant.kind === 'memory')
        .map((grant) => grant.scope),
      ['workspace', 'project', 'thread'],
    );

    const isolated = await store.resolveThreadPolicy(publicThread('legal'));
    assert.equal(isolated.identity.displayName, 'Acme Tag');
    assert.equal(isolated.access.networkPolicy.mode, 'deny-by-default');
    assert.ok(isolated.access.grants.some((grant) => grant.kind === 'lark-docs'));
    assert.equal(
      isolated.access.grants.some((grant) => grant.kind === 'github'),
      false,
    );
    assert.deepEqual(
      isolated.access.grants
        .filter((grant) => grant.kind === 'memory')
        .map((grant) => grant.scope),
      ['project', 'thread'],
    );

    const direct = await store.resolveThreadPolicy({
      ...publicThread('shared'),
      id: 'lark:dm:root',
      externalId: 'dm:root',
      visibility: 'direct',
    });
    assert.deepEqual(
      direct.access.grants
        .filter((grant) => grant.kind === 'memory')
        .map((grant) => grant.scope),
      ['thread'],
    );
    assert.ok(direct.access.grants.some((grant) => grant.kind === 'github'));
    assert.equal(direct.access.networkPolicy.mode, 'restricted');
    const privateThread = await store.resolveThreadPolicy({
      ...publicThread('shared'),
      id: 'github:acme/shared:42',
      externalId: 'acme/shared#42',
      platform: 'github',
      visibility: 'private',
    });
    assert.deepEqual(
      privateThread.access.grants.find(
        (grant) => grant.kind === 'memory' && grant.scope === 'workspace',
      ).constraints.permissions,
      ['read'],
    );
    assert.deepEqual(
      privateThread.access.grants.find(
        (grant) => grant.kind === 'memory' && grant.scope === 'project',
      ).constraints.permissions,
      ['read', 'write'],
    );
    const audit = await store.listAudit();
    assert.equal(
      audit.find((record) => record.action === 'workspace.updated')?.actor,
      'operator:owner',
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
