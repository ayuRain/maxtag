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
      ['workspace', 'project', 'channel', 'thread'],
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
      ['project', 'channel', 'thread'],
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

test('budget policies inherit from workspace and can be overridden per project', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-budget-policy-'));
  try {
    const store = new FileThreadConfigStore(rootDir, {
      workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
    });
    await store.upsertWorkspacePolicy({
      workspaceId: 'acme',
      budgetPolicy: {
        mode: 'custom',
        scope: 'workspace',
        maxRunsPerMonth: 20,
        maxCostUsdPerMonth: 12.5,
      },
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'shared',
      budgetPolicy: { mode: 'inherit' },
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'incidents',
      budgetPolicy: {
        mode: 'custom',
        scope: 'project',
        maxRunsPerMonth: 3,
      },
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'lab',
      budgetPolicy: { mode: 'disabled' },
      actor: 'operator:owner',
    });

    const thread = (projectId) => ({
      id: `lark:${projectId}:root`,
      platform: 'lark',
      externalId: `${projectId}:root`,
      workspaceId: 'acme',
      projectId,
      visibility: 'public',
    });

    assert.deepEqual(
      (await store.resolveThreadPolicy(thread('shared'))).access.budgetPolicy,
      {
        mode: 'custom',
        scope: 'workspace',
        maxRunsPerMonth: 20,
        maxCostUsdPerMonth: 12.5,
      },
    );
    assert.deepEqual(
      (await store.resolveThreadPolicy(thread('incidents'))).access.budgetPolicy,
      {
        mode: 'custom',
        scope: 'project',
        maxRunsPerMonth: 3,
      },
    );
    assert.deepEqual(
      (await store.resolveThreadPolicy(thread('incidents'))).access.budgetPolicies,
      [
        {
          mode: 'custom',
          scope: 'workspace',
          maxRunsPerMonth: 20,
          maxCostUsdPerMonth: 12.5,
        },
        {
          mode: 'custom',
          scope: 'project',
          maxRunsPerMonth: 3,
        },
      ],
    );
    assert.deepEqual(
      (await store.resolveThreadPolicy(thread('lab'))).access.budgetPolicy,
      { mode: 'disabled' },
    );
    assert.deepEqual(
      (await store.resolveThreadPolicy(thread('lab'))).access.budgetPolicies,
      [
        {
          mode: 'custom',
          scope: 'workspace',
          maxRunsPerMonth: 20,
          maxCostUsdPerMonth: 12.5,
        },
      ],
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('memory approval policies inherit from workspace and can be overridden per project', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-approval-policy-'));
  try {
    const store = new FileThreadConfigStore(rootDir, {
      workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
    });
    await store.upsertWorkspacePolicy({
      workspaceId: 'acme',
      memoryApprovalPolicy: {
        mode: 'require_approval',
        scopes: ['workspace'],
        actions: ['remember'],
      },
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'shared',
      memoryApprovalPolicy: { mode: 'inherit' },
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'legal',
      memoryApprovalPolicy: {
        mode: 'require_approval',
        scopes: ['project'],
        actions: ['remember', 'forget'],
      },
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'lab',
      memoryApprovalPolicy: { mode: 'disabled' },
      actor: 'operator:owner',
    });

    const thread = (projectId) => ({
      id: `lark:${projectId}:root`,
      platform: 'lark',
      externalId: `${projectId}:root`,
      workspaceId: 'acme',
      projectId,
      visibility: 'public',
    });

    assert.deepEqual(
      (await store.resolveThreadPolicy(thread('shared'))).access
        .memoryApprovalPolicy,
      {
        mode: 'require_approval',
        scopes: ['workspace'],
        actions: ['remember'],
      },
    );
    assert.deepEqual(
      (await store.resolveThreadPolicy(thread('legal'))).access
        .memoryApprovalPolicy,
      {
        mode: 'require_approval',
        scopes: ['project'],
        actions: ['remember', 'forget'],
      },
    );
    assert.deepEqual(
      (await store.resolveThreadPolicy(thread('lab'))).access
        .memoryApprovalPolicy,
      { mode: 'disabled' },
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('memory retention keeps workspace facts independent and lets projects inherit or override local scopes', async (context) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-memory-retention-policy-'));
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = new FileThreadConfigStore(rootDir, {
    workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
  });
  await store.upsertWorkspacePolicy({
    workspaceId: 'acme',
    memoryRetentionPolicy: { mode: 'custom', days: 180 },
  });
  await store.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'shared',
    memoryRetentionPolicy: { mode: 'inherit' },
  });
  await store.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'incidents',
    memoryRetentionPolicy: { mode: 'custom', days: 30 },
  });
  await store.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'archive',
    memoryRetentionPolicy: { mode: 'keep' },
  });
  const route = (projectId) => ({
    id: `lark:${projectId}:root`,
    platform: 'lark',
    externalId: `${projectId}:root`,
    workspaceId: 'acme',
    projectId,
    channelId: `oc_${projectId}`,
    visibility: 'public',
  });

  assert.deepEqual(
    (await store.resolveThreadPolicy(route('shared'))).access.memoryRetentionDays,
    { workspace: 180, project: 180, channel: 180, thread: 180 },
  );
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('incidents'))).access.memoryRetentionDays,
    { workspace: 180, project: 30, channel: 30, thread: 30 },
  );
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('archive'))).access.memoryRetentionDays,
    { workspace: 180 },
  );
});

test('new channels inherit a default channel cap without replacing aggregate caps', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-default-channel-budget-'));
  try {
    const store = new FileThreadConfigStore(rootDir, {
      workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
    });
    await store.upsertWorkspacePolicy({
      workspaceId: 'acme',
      budgetPolicy: { mode: 'custom', scope: 'workspace', maxRunsPerMonth: 100 },
      defaultChannelBudgetPolicy: {
        mode: 'custom',
        scope: 'channel',
        maxRunsPerMonth: 10,
      },
    });
    const route = (channelId) => ({
      id: `lark:${channelId}:root`,
      platform: 'lark',
      externalId: `${channelId}:root`,
      workspaceId: 'acme',
      projectId: 'shared',
      channelId,
      visibility: 'public',
    });

    assert.deepEqual(
      (await store.resolveThreadPolicy(route('oc_new'))).access.budgetPolicies,
      [
        { mode: 'custom', scope: 'workspace', maxRunsPerMonth: 100 },
        { mode: 'custom', scope: 'channel', maxRunsPerMonth: 10 },
      ],
    );
    await store.upsertChannelPolicy({
      workspaceId: 'acme',
      projectId: 'shared',
      platform: 'lark',
      channelId: 'oc_unlimited',
      budgetPolicy: { mode: 'disabled' },
    });
    assert.deepEqual(
      (await store.resolveThreadPolicy(route('oc_unlimited'))).access.budgetPolicies,
      [{ mode: 'custom', scope: 'workspace', maxRunsPerMonth: 100 }],
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('channel policy overlays project instructions, capabilities, and budget without leaking', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-channel-policy-'));
  try {
    const store = new FileThreadConfigStore(rootDir, {
      workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
    });
    await store.upsertWorkspacePolicy({
      workspaceId: 'acme',
      identity: {
        id: 'workspace-agent',
        displayName: 'Acme Tag',
        instructions: 'Follow workspace policy.',
        defaultExecutorId: 'codex',
      },
      grants: [
        { id: 'workspace:github', kind: 'github', scope: 'workspace', label: 'GitHub' },
      ],
      networkPolicy: { mode: 'restricted', allowedHosts: ['github.com'] },
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'shared',
      agentMode: 'custom',
      identity: {
        id: 'shared-agent',
        displayName: 'Shared Agent',
        instructions: 'Follow project policy.',
        defaultExecutorId: 'claude',
      },
      capabilityMode: 'inherit',
      actor: 'operator:owner',
    });
    await store.upsertChannelPolicy({
      workspaceId: 'acme',
      projectId: 'shared',
      platform: 'lark',
      channelId: 'oc_incidents',
      title: 'Incidents',
      instructionMode: 'append',
      instructions: 'Escalate P0 incidents immediately.',
      capabilityMode: 'extend',
      grants: [
        { id: 'channel:lark-docs', kind: 'lark-docs', scope: 'channel', label: 'Lark Docs' },
      ],
      networkPolicy: { mode: 'restricted', allowedHosts: ['open.feishu.cn'] },
      budgetPolicy: { mode: 'custom', scope: 'channel', maxRunsPerMonth: 5 },
      memoryApprovalPolicy: {
        mode: 'require_approval',
        scopes: ['channel'],
        actions: ['forget'],
      },
      actor: 'operator:owner',
    });

    const channelThread = (channelId, visibility = 'public') => ({
      id: `lark:${channelId}:root`,
      platform: 'lark',
      externalId: `${channelId}:root`,
      workspaceId: 'acme',
      projectId: 'shared',
      channelId,
      visibility,
    });
    const resolved = await store.resolveThreadPolicy(channelThread('oc_incidents'));
    assert.match(resolved.identity.instructions, /Follow project policy/);
    assert.match(resolved.identity.instructions, /Escalate P0 incidents immediately/);
    assert.equal(resolved.identity.defaultExecutorId, 'claude');
    assert.deepEqual(
      resolved.access.grants
        .filter((grant) => grant.kind !== 'memory')
        .map((grant) => grant.kind),
      ['github', 'lark-docs'],
    );
    assert.deepEqual(resolved.access.networkPolicy, {
      mode: 'restricted',
      allowedHosts: ['github.com', 'open.feishu.cn'],
    });
    assert.deepEqual(resolved.access.budgetPolicy, {
      mode: 'custom',
      scope: 'channel',
      maxRunsPerMonth: 5,
    });
    assert.deepEqual(resolved.access.memoryApprovalPolicy, {
      mode: 'require_approval',
      scopes: ['channel'],
      actions: ['forget'],
    });
    assert.equal(resolved.channelPolicy.title, 'Incidents');

    const sibling = await store.resolveThreadPolicy(channelThread('oc_general'));
    assert.equal(sibling.identity.instructions, 'Follow project policy.');
    assert.deepEqual(
      sibling.access.grants
        .filter((grant) => grant.kind !== 'memory')
        .map((grant) => grant.kind),
      ['github'],
    );
    assert.deepEqual(sibling.access.networkPolicy, {
      mode: 'restricted',
      allowedHosts: ['github.com'],
    });
    assert.equal(sibling.channelPolicy, undefined);

    const direct = await store.resolveThreadPolicy(
      channelThread('oc_incidents', 'direct'),
    );
    assert.equal(direct.identity.instructions, 'Follow project policy.');
    assert.equal(direct.channelPolicy, undefined);

    const reloaded = new FileThreadConfigStore(rootDir);
    assert.equal((await reloaded.listChannelPolicies('acme', 'shared')).length, 1);
    const removed = await reloaded.removeChannelPolicy({
      workspaceId: 'acme',
      projectId: 'shared',
      platform: 'lark',
      channelId: 'oc_incidents',
      actor: 'operator:admin',
    });
    assert.equal(removed.title, 'Incidents');
    const fallback = await reloaded.resolveThreadPolicy(channelThread('oc_incidents'));
    assert.equal(fallback.identity.instructions, 'Follow project policy.');
    assert.equal(fallback.channelPolicy, undefined);
    assert.deepEqual(
      (await reloaded.listAudit(10, 'acme'))
        .filter((record) => record.action.startsWith('channel.'))
        .map((record) => record.action),
      ['channel.removed', 'channel.created'],
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('named capability bundles inherit through projects and channels without leaking', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-bundles-'));
  try {
    const store = new FileThreadConfigStore(rootDir, {
      workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
    });
    await store.upsertCapabilityBundle({
      workspaceId: 'acme',
      id: 'data-readonly',
      name: 'Data read only',
      preset: 'data-readonly',
      grants: [{
        id: 'bundle:acme:data-readonly:mcp-clickhouse',
        kind: 'mcp:clickhouse',
        scope: 'workspace',
        label: 'ClickHouse',
        constraints: { permissions: ['read'] },
      }],
      networkPolicy: {
        mode: 'restricted',
        allowedHosts: ['clickhouse.internal'],
      },
      actor: 'operator:owner',
    });
    await store.upsertCapabilityBundle({
      workspaceId: 'acme',
      id: 'github-write',
      name: 'GitHub write',
      preset: 'github-write',
      grants: [{
        id: 'bundle:acme:github-write:github',
        kind: 'github',
        scope: 'workspace',
        label: 'GitHub',
        credentialIdentityId: 'github-bot',
        constraints: {
          permissions: ['read', 'write'],
          repositories: ['acme/shared'],
        },
      }],
      networkPolicy: {
        mode: 'restricted',
        allowedHosts: ['api.github.com'],
      },
      actor: 'operator:owner',
    });
    await store.upsertCapabilityBundle({
      workspaceId: 'acme',
      id: 'platform-monitoring',
      name: 'Platform monitoring',
      preset: 'platform-monitoring',
      grants: [{
        id: 'bundle:acme:platform-monitoring:mcp-kubernetes',
        kind: 'mcp:kubernetes',
        scope: 'workspace',
        label: 'Kubernetes',
        constraints: { permissions: ['read'] },
      }],
      networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
      actor: 'operator:owner',
    });
    await store.upsertWorkspacePolicy({
      workspaceId: 'acme',
      bundleIds: ['data-readonly'],
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'shared',
      capabilityMode: 'inherit',
      actor: 'operator:owner',
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'engineering',
      capabilityMode: 'custom',
      bundleIds: ['github-write'],
      actor: 'operator:owner',
    });
    await store.upsertChannelPolicy({
      workspaceId: 'acme',
      projectId: 'engineering',
      platform: 'lark',
      channelId: 'oc_incidents',
      capabilityMode: 'extend',
      bundleIds: ['platform-monitoring'],
      actor: 'operator:owner',
    });

    const thread = (projectId, channelId) => ({
      id: `lark:${channelId}:main`,
      platform: 'lark',
      externalId: `${channelId}:main`,
      workspaceId: 'acme',
      projectId,
      channelId,
      visibility: 'public',
    });
    const inherited = await store.resolveThreadPolicy(thread('shared', 'oc_shared'));
    assert.deepEqual(inherited.access.capabilityBundleIds, ['data-readonly']);
    assert.ok(inherited.access.grants.some((grant) => grant.kind === 'mcp:clickhouse'));
    assert.equal(inherited.access.grants.some((grant) => grant.kind === 'github'), false);
    assert.deepEqual(inherited.access.networkPolicy, {
      mode: 'restricted',
      allowedHosts: ['clickhouse.internal'],
    });

    const engineering = await store.resolveThreadPolicy(
      thread('engineering', 'oc_engineering'),
    );
    assert.deepEqual(engineering.access.capabilityBundleIds, ['github-write']);
    assert.ok(engineering.access.grants.some((grant) => grant.kind === 'github'));
    assert.equal(
      engineering.access.grants.some((grant) => grant.kind === 'mcp:clickhouse'),
      false,
    );

    const incident = await store.resolveThreadPolicy(
      thread('engineering', 'oc_incidents'),
    );
    assert.deepEqual(
      new Set(incident.access.capabilityBundleIds),
      new Set(['github-write', 'platform-monitoring']),
    );
    assert.ok(incident.access.grants.some((grant) => grant.kind === 'github'));
    assert.ok(incident.access.grants.some((grant) => grant.kind === 'mcp:kubernetes'));

    const reloaded = new FileThreadConfigStore(rootDir);
    const bundles = await reloaded.listCapabilityBundles('acme');
    assert.equal(bundles.length, 3);
    await assert.rejects(
      () => reloaded.removeCapabilityBundle({
        workspaceId: 'acme',
        id: 'github-write',
      }),
      /capability_bundle_in_use/,
    );
    const disabled = await reloaded.setCapabilityBundleEnabled({
      workspaceId: 'acme',
      id: 'github-write',
      enabled: false,
      expectedRevision: bundles.find((bundle) => bundle.id === 'github-write').revision,
      actor: 'operator:owner',
    });
    assert.equal(disabled.enabled, false);
    const afterDisable = await reloaded.resolveThreadPolicy(
      thread('engineering', 'oc_engineering'),
    );
    assert.deepEqual(afterDisable.access.capabilityBundleIds, []);
    assert.equal(afterDisable.access.grants.some((grant) => grant.kind === 'github'), false);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('external write approval policy inherits and overrides at workspace project and channel', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-tool-approval-policy-'));
  try {
    const store = new FileThreadConfigStore(rootDir, {
      workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
    });
    const route = (projectId, channelId = `oc_${projectId}`) => ({
      id: `lark:${channelId}:root`,
      platform: 'lark',
      externalId: `${channelId}:root`,
      workspaceId: 'acme',
      projectId,
      channelId,
      visibility: 'public',
    });

    assert.deepEqual(
      (await store.resolveThreadPolicy(route('shared'))).access.toolApprovalPolicy,
      { mode: 'require_approval', risks: ['write'] },
    );
    await store.upsertWorkspacePolicy({
      workspaceId: 'acme',
      toolApprovalPolicy: { mode: 'disabled' },
    });
    await store.upsertProjectPolicy({
      workspaceId: 'acme',
      projectId: 'guarded',
      toolApprovalPolicy: { mode: 'require_approval', risks: ['write'] },
    });
    await store.upsertChannelPolicy({
      workspaceId: 'acme',
      projectId: 'guarded',
      platform: 'lark',
      channelId: 'oc_direct',
      toolApprovalPolicy: { mode: 'disabled' },
    });
    assert.deepEqual(
      (await store.resolveThreadPolicy(route('shared'))).access.toolApprovalPolicy,
      { mode: 'disabled' },
    );
    assert.deepEqual(
      (await store.resolveThreadPolicy(route('guarded'))).access.toolApprovalPolicy,
      { mode: 'require_approval', risks: ['write'] },
    );
    assert.deepEqual(
      (await store.resolveThreadPolicy(route('guarded', 'oc_direct'))).access
        .toolApprovalPolicy,
      { mode: 'disabled' },
    );

    const reloaded = new FileThreadConfigStore(rootDir);
    assert.deepEqual(
      (await reloaded.resolveThreadPolicy(route('guarded', 'oc_direct'))).access
        .toolApprovalPolicy,
      { mode: 'disabled' },
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
