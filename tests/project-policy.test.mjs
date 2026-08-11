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
      4,
    );

    const audit = await reloaded.listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'project.created');
    assert.equal(audit[0].actor, 'test');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
