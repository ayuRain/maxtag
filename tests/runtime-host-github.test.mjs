import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpenTagWorkerHost } from '@opentag/runtime-host';
import { FileToolCredentialIdentityStore } from '@opentag/config';
import { toolApprovalArgumentDigest } from '@opentag/tool-broker';

test('standalone worker host keeps GitHub runs on the native transport', async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-github-worker-'),
  );
  try {
    const host = createOpenTagWorkerHost({
      dataDir,
      workerId: 'github-worker-test',
      github: { transportMode: 'memory' },
      executors: { mode: 'dry-run' },
    });
    const thread = {
      id: 'github:acme/opentag#42',
      platform: 'github',
      externalId: 'acme/opentag#42',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'acme/opentag',
      rootMessageId: '42',
      topicId: '42',
      visibility: 'private',
      metadata: {
        owner: 'acme',
        repo: 'opentag',
        repository: 'acme/opentag',
        issueNumber: 42,
      },
    };
    await host.deliveryStore.createAgentRun({
      runId: 'github-worker-run',
      thread,
      message: {
        id: '303',
        threadId: thread.id,
        platform: 'github',
        text: '@MaxTagBot inspect worker routing',
        actor: { id: 'ada', displayName: 'Ada' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
      transportMode: 'github-memory',
    });

    const result = await host.runAgentWorkerPass(1);
    assert.equal(result.claimed, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.runs[0].status, 'completed');
    assert.equal(result.runs[0].workerId, 'github-worker-test');

    const outbox = await host.deliveryStore.listOutbox({ limit: 20 });
    assert.ok(outbox.every((item) => item.status === 'delivered'));
    assert.ok(outbox.some((item) => item.kind === 'github.progress.create'));
    assert.ok(outbox.some((item) => item.kind === 'github.progress.update'));
    assert.ok(outbox.some((item) => item.kind === 'github.comment'));
    assert.ok(
      outbox
        .filter((item) => item.kind.startsWith('github.'))
        .every(
          (item) =>
            item.target.chatId === 'acme/opentag' &&
            item.target.topicId === '42',
        ),
    );

    assert.deepEqual(host.githubTransportStatus(), {
      requested: 'memory',
      mode: 'memory',
      hasToken: false,
      baseUrl: undefined,
    });
    host.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('standalone worker revalidates the shared credential identity revision before an approved write', async (context) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-identity-worker-'),
  );
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const previousToken = process.env.GITHUB_PAYMENTS_WORKER_TOKEN;
  process.env.GITHUB_PAYMENTS_WORKER_TOKEN = 'worker-only-token';
  context.after(() => {
    if (previousToken === undefined) delete process.env.GITHUB_PAYMENTS_WORKER_TOKEN;
    else process.env.GITHUB_PAYMENTS_WORKER_TOKEN = previousToken;
  });
  const identityStore = new FileToolCredentialIdentityStore(
    path.join(dataDir, 'config'),
  );
  const identity = await identityStore.upsert({
    id: 'github-payments',
    displayName: 'GitHub Payments',
    provider: 'github',
    envRefs: { token: 'GITHUB_PAYMENTS_WORKER_TOKEN' },
    externalActor: 'opentag-payments[bot]',
    actor: 'owner:ada',
  });
  const host = createOpenTagWorkerHost({
    dataDir,
    workerId: 'identity-worker-test',
    github: { transportMode: 'memory' },
    executors: { mode: 'dry-run' },
  });
  context.after(() => host.close());
  await host.threadConfigStore.upsertProjectPolicy({
    workspaceId: 'dev-workspace',
    projectId: 'opentag',
    capabilityMode: 'custom',
    grants: [
      {
        id: 'project:dev-workspace:opentag:github',
        kind: 'github',
        scope: 'project',
        label: 'GitHub',
        credentialIdentityId: identity.id,
        constraints: {
          repositories: ['acme/opentag'],
          permissions: ['read', 'write'],
        },
      },
    ],
    networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
    actor: 'owner:ada',
  });
  const thread = {
    id: 'lark:identity-worker:root',
    platform: 'lark',
    externalId: 'identity-worker:root',
    workspaceId: 'dev-workspace',
    projectId: 'opentag',
    channelId: 'identity-worker',
    visibility: 'private',
  };
  await host.deliveryStore.createAgentRun({
    runId: 'identity-worker-run',
    thread,
    message: {
      id: 'identity-worker-message',
      threadId: thread.id,
      platform: 'lark',
      text: 'Create an approved issue',
      actor: { id: 'ada', displayName: 'Ada' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
    transportMode: 'lark-memory',
  });
  const approvalArguments = {
    owner: 'acme',
    repo: 'opentag',
    title: 'Identity revision fence',
  };
  const approval = await host.deliveryStore.proposeToolApproval({
    runId: 'identity-worker-run',
    toolCallId: 'identity-worker-call',
    toolName: 'github_issue_create',
    title: 'Create GitHub issue',
    grantKind: 'github',
    risk: 'write',
    arguments: approvalArguments,
    argumentSummary: {
      owner: 'acme',
      repo: 'opentag',
      title: 'Identity revision fence',
    },
    argumentDigest: toolApprovalArgumentDigest(
      'github_issue_create',
      approvalArguments,
    ),
    credentialIdentityId: identity.id,
    credentialIdentityRevision: identity.revision,
    externalActor: identity.externalActor,
    thread,
    requestedBy: 'agent:opentag',
  });
  await host.deliveryStore.approveToolApproval({
    id: approval.id,
    actorId: 'operator:ada',
  });
  await identityStore.upsert({
    id: identity.id,
    displayName: identity.displayName,
    provider: identity.provider,
    envRefs: identity.envRefs,
    externalActor: identity.externalActor,
    expectedRevision: identity.revision,
    actor: 'owner:ada',
  });

  const pass = await host.runToolApprovalPass(1);
  assert.deepEqual(pass, { claimed: 1, succeeded: 0, failed: 1 });
  const failed = await host.deliveryStore.getToolApproval(approval.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'tool_approval_credential_identity_changed');
});

test('standalone worker host records usage and gates runs by workspace budget', async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-budget-worker-'),
  );
  try {
    const host = createOpenTagWorkerHost({
      dataDir,
      workerId: 'budget-worker-test',
      lark: { transportMode: 'memory' },
      executors: { mode: 'dry-run' },
    });
    await host.threadConfigStore.upsertWorkspacePolicy({
      workspaceId: 'dev-workspace',
      budgetPolicy: {
        mode: 'custom',
        scope: 'workspace',
        maxRunsPerMonth: 1,
      },
      actor: 'operator:owner',
    });

    const thread = {
      id: 'lark:budget:root',
      platform: 'lark',
      externalId: 'budget:root',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'budget',
      visibility: 'public',
    };
    const message = (id, text) => ({
      id,
      threadId: thread.id,
      platform: 'lark',
      text,
      actor: { id: 'ada', displayName: 'Ada' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    });

    await host.deliveryStore.createAgentRun({
      runId: 'budget-run-1',
      thread,
      message: message('message-1', '@MaxTag first'),
      transportMode: 'lark-memory',
    });
    const first = await host.runAgentWorkerPass(1);
    assert.equal(first.completed, 1);

    const usage = await host.deliveryStore.usageSnapshot({
      workspaceId: 'dev-workspace',
    });
    assert.equal(usage.records.length, 1);
    assert.equal(usage.totals.find((line) => line.scope === 'workspace').runs, 1);
    const summary = await host.deliveryStore.summarize('dev-workspace');
    assert.equal(summary.usage.records, 1);
    assert.equal(summary.usage.currentPeriodRuns, 1);

    await host.deliveryStore.createAgentRun({
      runId: 'budget-run-2',
      thread,
      message: message('message-2', '@MaxTag second'),
      transportMode: 'lark-memory',
    });
    const second = await host.runAgentWorkerPass(1);
    assert.equal(second.claimed, 1);
    assert.equal(second.completed, 0);
    assert.equal(second.failed, 1);
    const denied = await host.deliveryStore.getAgentRun('budget-run-2');
    assert.equal(denied.status, 'cancelled');
    assert.match(denied.lastError, /Monthly workspace run budget exceeded/);
    const events = await host.deliveryStore.listAgentRunEvents('budget-run-2');
    assert.ok(events.some((event) => event.type === 'usage_budget_denied'));

    const after = await host.deliveryStore.usageSnapshot({
      workspaceId: 'dev-workspace',
    });
    assert.equal(after.records.length, 1);
    host.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
