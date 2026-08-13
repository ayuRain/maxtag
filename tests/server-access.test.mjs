import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error('failed_to_reserve_test_port');
  return port;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy\n${logs.join('')}`);
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

function clientEvent(eventId, actorId, text, projectId = 'opentag') {
  return {
    platform: 'lark',
    eventId,
    thread: {
      externalId: `oc_access_${projectId}:root`,
      channelId: `oc_access_${projectId}`,
      workspaceId: 'dev-workspace',
      projectId,
      visibility: 'public',
    },
    message: {
      id: `message-${eventId}`,
      text,
      actor: { id: actorId, platformUserId: actorId },
      mentionsAgent: true,
    },
  };
}

function larkEvent(eventId, messageId, actorId, text) {
  return {
    event_id: eventId,
    token: 'access-lark-token',
    event: {
      message: {
        message_id: messageId,
        chat_id: 'oc_access_native',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: String(Date.now()),
      },
      sender: {
        sender_id: { open_id: actorId },
        tenant_key: 'dev-workspace',
      },
    },
  };
}

function telegramUpdate(updateId, actorId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId - 9_000,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: -100456, type: 'supergroup', title: 'Access lab' },
      from: { id: actorId, is_bot: false, first_name: 'Workspace member' },
      text,
    },
  };
}

test(
  'server enforces workspace identities and project capabilities on client ingress',
  { timeout: 25_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-access-server-'));
    const port = await freePort();
    const logs = [];
    const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_STORAGE_DRIVER: 'sqlite',
        OPENTAG_ADMIN_TOKEN: '',
        OPENTAG_AGENT_WORKER: 'manual',
        OPENTAG_ROUTINES_ENABLED: 'false',
        OPENTAG_LARK_TRANSPORT: 'memory',
        OPENTAG_LARK_EVENT_MODE: 'webhook',
        OPENTAG_LARK_VERIFICATION_TOKEN: 'access-lark-token',
        OPENTAG_LARK_CALLBACK_MAX_SKEW_SECONDS: '0',
        OPENTAG_TELEGRAM_TRANSPORT: 'memory',
        OPENTAG_TELEGRAM_BOT_USERNAME: 'MaxTagBot',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
    context.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(baseUrl, child, logs);
    assert.equal(health.storage.driver, 'sqlite');

    const ownerResult = await postJson(baseUrl, '/v1/access/members', {
      workspaceId: 'dev-workspace',
      displayName: 'Workspace owner',
      role: 'owner',
      identities: [
        { platform: 'lark', externalId: 'ou-owner' },
        { platform: 'telegram', externalId: '1001' },
      ],
    });
    assert.equal(ownerResult.response.status, 200);

    const contributorResult = await postJson(baseUrl, '/v1/access/members', {
      workspaceId: 'dev-workspace',
      displayName: 'Contributor',
      role: 'member',
      identities: [
        { platform: 'lark', externalId: 'ou-contributor' },
        { platform: 'telegram', externalId: '42' },
      ],
    });
    assert.equal(contributorResult.response.status, 200);
    const contributor = contributorResult.data.member;

    const isolatedProject = await postJson(baseUrl, '/v1/projects', {
      workspaceId: 'dev-workspace',
      projectId: 'legal',
      name: 'Legal',
      agentMode: 'inherit',
      capabilityMode: 'inherit',
      memoryMode: 'isolated',
    });
    assert.equal(isolatedProject.response.status, 200);

    const reviewedProject = await postJson(baseUrl, '/v1/projects', {
      workspaceId: 'dev-workspace',
      projectId: 'reviewed',
      name: 'Reviewed Memory',
      agentMode: 'inherit',
      capabilityMode: 'inherit',
      memoryMode: 'workspace',
      memoryApprovalPolicy: {
        mode: 'require_approval',
        scopes: ['project'],
        actions: ['remember', 'forget'],
      },
      memoryRetentionPolicy: { mode: 'custom', days: 14 },
    });
    assert.equal(reviewedProject.response.status, 200);
    assert.deepEqual(reviewedProject.data.project.memoryApprovalPolicy, {
      mode: 'require_approval',
      scopes: ['project'],
      actions: ['remember', 'forget'],
    });
    assert.deepEqual(reviewedProject.data.project.memoryRetentionPolicy, {
      mode: 'custom',
      days: 14,
    });

    const viewerResult = await postJson(baseUrl, '/v1/access/members', {
      workspaceId: 'dev-workspace',
      displayName: 'Viewer',
      role: 'guest',
      platform: 'lark',
      externalId: 'ou-viewer',
    });
    assert.equal(viewerResult.response.status, 200);

    const policyResult = await postJson(baseUrl, '/v1/access/project-policy', {
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      mode: 'members',
    });
    assert.equal(policyResult.response.status, 200);

    const assignment = await postJson(
      baseUrl,
      '/v1/access/project-memberships',
      {
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        memberId: contributor.id,
        role: 'contributor',
      },
    );
    assert.equal(assignment.response.status, 200);

    const isolatedPolicy = await postJson(
      baseUrl,
      '/v1/access/project-policy',
      {
        workspaceId: 'dev-workspace',
        projectId: 'legal',
        mode: 'members',
      },
    );
    assert.equal(isolatedPolicy.response.status, 200);
    const isolatedAssignment = await postJson(
      baseUrl,
      '/v1/access/project-memberships',
      {
        workspaceId: 'dev-workspace',
        projectId: 'legal',
        memberId: contributor.id,
        role: 'contributor',
      },
    );
    assert.equal(isolatedAssignment.response.status, 200);

    const reviewedPolicy = await postJson(
      baseUrl,
      '/v1/access/project-policy',
      {
        workspaceId: 'dev-workspace',
        projectId: 'reviewed',
        mode: 'members',
      },
    );
    assert.equal(reviewedPolicy.response.status, 200);
    const reviewedAssignment = await postJson(
      baseUrl,
      '/v1/access/project-memberships',
      {
        workspaceId: 'dev-workspace',
        projectId: 'reviewed',
        memberId: contributor.id,
        role: 'contributor',
      },
    );
    assert.equal(reviewedAssignment.response.status, 200);

    const larkBinding = await postJson(baseUrl, '/v1/bindings', {
      platform: 'lark',
      externalId: 'oc_access_native',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      activationMode: 'always',
      requireMention: false,
    });
    assert.equal(larkBinding.response.status, 200);

    const telegramBinding = await postJson(baseUrl, '/v1/bindings', {
      platform: 'telegram',
      externalId: '-100456',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      activationMode: 'always',
      requireMention: false,
    });
    assert.equal(telegramBinding.response.status, 200);

    const bindingAudit = await fetch(
      `${baseUrl}/v1/binding-audit?workspaceId=dev-workspace&limit=10`,
    ).then((response) => response.json());
    assert.equal(bindingAudit.audit.length, 2);
    assert.ok(
      bindingAudit.audit.every(
        (record) =>
          record.action === 'binding.created' &&
          record.actor === 'operator:local-development' &&
          record.after.projectId === 'opentag',
      ),
    );
    const larkAudit = await fetch(
      `${baseUrl}/v1/binding-audit?workspaceId=dev-workspace&platform=lark`,
    ).then((response) => response.json());
    assert.equal(larkAudit.audit.length, 1);
    assert.equal(larkAudit.audit[0].bindingId, larkBinding.data.binding.id);

    const bindingExportResponse = await fetch(
      `${baseUrl}/v1/binding-export?workspaceId=dev-workspace`,
    );
    assert.equal(bindingExportResponse.status, 200);
    const bindingExport = await bindingExportResponse.json();
    assert.equal(bindingExport.schemaVersion, 1);
    assert.equal(bindingExport.workspaceId, 'dev-workspace');
    assert.equal(bindingExport.count, 2);
    assert.ok(
      bindingExport.bindings.every(
        (binding) =>
          binding.projectId === 'opentag' &&
          binding.workspaceId === 'dev-workspace' &&
          !Object.hasOwn(binding, 'metadata'),
      ),
    );

    const bindingImportDryRun = await postJson(baseUrl, '/v1/binding-import', {
      workspaceId: 'dev-workspace',
      bindings: [
        {
          platform: 'lark',
          externalId: 'oc_legal_imported',
          projectId: 'legal',
          title: 'Legal imported group',
          activationMode: 'always',
          requireMention: false,
        },
      ],
    });
    assert.equal(bindingImportDryRun.response.status, 200);
    assert.equal(bindingImportDryRun.data.dryRun, true);
    assert.equal(bindingImportDryRun.data.imported, 0);
    assert.equal(bindingImportDryRun.data.preview.length, 1);
    assert.equal(bindingImportDryRun.data.preview[0].projectId, 'legal');

    const afterDryRunExport = await fetch(
      `${baseUrl}/v1/binding-export?workspaceId=dev-workspace`,
    ).then((response) => response.json());
    assert.equal(afterDryRunExport.count, 2);
    assert.equal(
      afterDryRunExport.bindings.some(
        (binding) => binding.externalId === 'oc_legal_imported',
      ),
      false,
    );

    const invalidImport = await postJson(baseUrl, '/v1/binding-import', {
      workspaceId: 'dev-workspace',
      apply: true,
      bindings: [
        {
          platform: 'lark',
          externalId: 'oc_missing_project',
          projectId: 'missing',
        },
      ],
    });
    assert.equal(invalidImport.response.status, 400);
    assert.equal(invalidImport.data.errors[0].error, 'binding_project_not_found');
    assert.equal(invalidImport.data.imported, 0);

    const bindingImportApply = await postJson(baseUrl, '/v1/binding-import', {
      workspaceId: 'dev-workspace',
      apply: true,
      bindings: [
        {
          platform: 'lark',
          externalId: 'oc_legal_imported',
          projectId: 'legal',
          title: 'Legal imported group',
          activationMode: 'always',
          requireMention: false,
        },
      ],
    });
    assert.equal(bindingImportApply.response.status, 200);
    assert.equal(bindingImportApply.data.imported, 1);
    assert.equal(bindingImportApply.data.bindings[0].projectId, 'legal');
    assert.equal(
      bindingImportApply.data.bindings[0].metadata.configuredVia,
      'binding-import',
    );
    const importedAudit = await fetch(
      `${baseUrl}/v1/binding-audit?workspaceId=dev-workspace&bindingId=${bindingImportApply.data.bindings[0].id}`,
    ).then((response) => response.json());
    assert.equal(importedAudit.audit[0].reason, 'binding_import');
    assert.equal(importedAudit.audit[0].actor, 'operator:local-development');

    const unknown = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent('access-unknown', 'ou-unknown', '@MaxTag status'),
    );
    assert.equal(unknown.response.status, 202);
    assert.equal(unknown.data.accepted, false);
    assert.equal(unknown.data.reason, 'actor_not_authorized');
    assert.equal(unknown.data.authorization.reason, 'workspace_member_required');

    const viewer = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent('access-viewer', 'ou-viewer', '@MaxTag status'),
    );
    assert.equal(viewer.data.accepted, false);
    assert.equal(viewer.data.authorization.reason, 'project_member_required');

    const nativeLarkUnknown = await postJson(
      baseUrl,
      '/v1/lark/events',
      larkEvent(
        'access-native-lark-unknown',
        'om_access_native_unknown',
        'ou-native-unknown',
        'status',
      ),
    );
    assert.equal(nativeLarkUnknown.response.status, 202);
    assert.equal(nativeLarkUnknown.data.accepted, false);
    assert.equal(nativeLarkUnknown.data.reason, 'actor_not_authorized');
    assert.equal(
      nativeLarkUnknown.data.authorization.reason,
      'workspace_member_required',
    );

    const nativeTelegramUnknown = await postJson(
      baseUrl,
      '/v1/telegram/events',
      telegramUpdate(9_101, 99, 'status'),
    );
    assert.equal(nativeTelegramUnknown.response.status, 202);
    assert.equal(nativeTelegramUnknown.data.accepted, false);
    assert.equal(nativeTelegramUnknown.data.reason, 'actor_not_authorized');
    assert.equal(
      nativeTelegramUnknown.data.authorization.reason,
      'workspace_member_required',
    );

    const contributorRun = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent('access-contributor', 'ou-contributor', '@MaxTag status'),
    );
    assert.equal(contributorRun.response.status, 202);
    assert.equal(contributorRun.data.accepted, true);
    assert.equal(
      contributorRun.data.authorization.projectRole,
      'contributor',
    );

    const nativeTelegramContributor = await postJson(
      baseUrl,
      '/v1/telegram/events',
      telegramUpdate(9_102, 42, 'status'),
    );
    assert.equal(nativeTelegramContributor.response.status, 202);
    assert.equal(nativeTelegramContributor.data.accepted, true);
    assert.equal(
      nativeTelegramContributor.data.authorization.memberId,
      contributor.id,
    );
    assert.equal(
      nativeTelegramContributor.data.authorization.projectRole,
      'contributor',
    );

    const contributorWorkspaceMemory = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent(
        'access-workspace-memory',
        'ou-contributor',
        'remember workspace shared workspace fact',
      ),
    );
    assert.equal(contributorWorkspaceMemory.data.accepted, true);
    assert.equal(
      contributorWorkspaceMemory.data.run.metadata.workspaceMemoryWriteAllowed,
      true,
    );
    assert.equal(
      contributorWorkspaceMemory.data.authorization.workspaceRole,
      'member',
    );

    const isolatedWorkspaceMemory = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent(
        'access-isolated-workspace-memory',
        'ou-contributor',
        'remember workspace must remain isolated',
        'legal',
      ),
    );
    assert.equal(isolatedWorkspaceMemory.data.accepted, false);
    assert.equal(
      isolatedWorkspaceMemory.data.authorization.reason,
      'memory_scope_not_granted',
    );

    const isolatedProjectMemory = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent(
        'access-isolated-project-memory',
        'ou-contributor',
        'remember project legal-only fact',
        'legal',
      ),
    );
    assert.equal(isolatedProjectMemory.data.accepted, true);

    const reviewedProjectMemory = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent(
        'access-reviewed-project-memory',
        'ou-contributor',
        'remember project reviewed fact',
        'reviewed',
      ),
    );
    assert.equal(reviewedProjectMemory.data.accepted, true);
    const reviewedWorker = await postJson(baseUrl, '/v1/runs/worker-pass', {
      limit: 20,
    });
    assert.equal(reviewedWorker.response.status, 200);
    assert.ok(reviewedWorker.data.result.completed >= 1);
    const reviewedRun = reviewedWorker.data.result.runs.find(
      (run) => run.id === reviewedProjectMemory.data.run.id,
    );
    assert.ok(reviewedRun);
    assert.match(reviewedRun.summary, /Queued remember/);
    const reviewedProposals = await fetch(
      `${baseUrl}/v1/memory-proposals?workspaceId=dev-workspace&projectId=reviewed&status=pending`,
    ).then((response) => response.json());
    assert.equal(reviewedProposals.proposals.length, 1);
    assert.equal(reviewedProposals.proposals[0].action, 'remember');
    assert.equal(reviewedProposals.proposals[0].value, 'reviewed fact');
    assert.equal(reviewedProposals.proposals[0].retentionDays, 14);
    const reviewedEvents = await fetch(
      `${baseUrl}/v1/runs/${encodeURIComponent(reviewedRun.id)}/events`,
    ).then((response) => response.json());
    const reviewedMemoryEvent = reviewedEvents.events.find(
      (event) => event.type === 'memory_command',
    );
    assert.equal(reviewedMemoryEvent.metadata.action, 'proposed');
    assert.equal(
      reviewedMemoryEvent.metadata.proposalId,
      reviewedProposals.proposals[0].id,
    );
    const reviewedMemoryBeforeApproval = await postJson(baseUrl, '/v1/memory', {
      action: 'show',
      workspaceId: 'dev-workspace',
      projectId: 'reviewed',
      externalId: 'oc_access_reviewed:root',
      channelId: 'oc_access_reviewed',
      scope: 'project',
    });
    assert.equal(reviewedMemoryBeforeApproval.response.status, 200);
    assert.equal(reviewedMemoryBeforeApproval.data.memoryCommand.content, '');
    const approveReviewedMemory = await postJson(
      baseUrl,
      `/v1/memory-proposals/${reviewedProposals.proposals[0].id}/approve`,
      { reason: 'test approval' },
    );
    assert.equal(approveReviewedMemory.response.status, 200);
    assert.equal(approveReviewedMemory.data.proposal.status, 'approved');
    const reviewedMemoryAfterApproval = await postJson(baseUrl, '/v1/memory', {
      action: 'show',
      workspaceId: 'dev-workspace',
      projectId: 'reviewed',
      externalId: 'oc_access_reviewed:root',
      channelId: 'oc_access_reviewed',
      scope: 'project',
    });
    assert.match(
      reviewedMemoryAfterApproval.data.memoryCommand.content,
      /reviewed fact/,
    );
    const reviewedMemorySnapshot = await fetch(
      `${baseUrl}/v1/memory?workspaceId=dev-workspace&projectId=reviewed&externalId=oc_access_reviewed%3Aroot&channelId=oc_access_reviewed&scope=project`,
    ).then((response) => response.json());
    assert.equal(reviewedMemorySnapshot.expiry.entries.length, 1);
    assert.equal(
      reviewedMemorySnapshot.expiry.entries[0].source,
      'memory-retention-policy',
    );
    assert.ok(
      Date.parse(reviewedMemorySnapshot.expiry.entries[0].expiresAt) >=
        Date.now() + 13 * 24 * 60 * 60 * 1_000,
    );
    const reviewedSearch = await fetch(
      `${baseUrl}/v1/memory-search?workspaceId=dev-workspace&projectId=reviewed&externalId=oc_access_reviewed%3Aroot&channelId=oc_access_reviewed&scope=project&q=reviewed%20fact`,
    ).then((response) => response.json());
    assert.equal(reviewedSearch.scope, 'project');
    assert.equal(reviewedSearch.hits.length, 1);
    assert.match(reviewedSearch.hits[0].line, /reviewed fact/u);
    assert.match(reviewedSearch.hits[0].documentKey, /reviewed/u);

    const isolatedSearch = await fetch(
      `${baseUrl}/v1/memory-search?workspaceId=dev-workspace&projectId=legal&externalId=oc_access_legal%3Aroot&channelId=oc_access_legal&scope=project&q=reviewed%20fact`,
    ).then((response) => response.json());
    assert.deepEqual(isolatedSearch.hits, []);

    const ownerGlobalMemory = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent(
        'access-global-memory',
        'ou-owner',
        'remember global installation fact',
      ),
    );
    assert.equal(ownerGlobalMemory.data.accepted, false);
    assert.equal(
      ownerGlobalMemory.data.authorization.reason,
      'memory_scope_not_granted',
    );

    const deniedRoutine = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent(
        'access-routine',
        'ou-contributor',
        'schedule every 30m: Check CI',
      ),
    );
    assert.equal(deniedRoutine.data.accepted, false);
    assert.equal(deniedRoutine.data.authorization.capability, 'manage_routines');
    assert.equal(deniedRoutine.data.authorization.reason, 'capability_not_granted');

    const ownerRoutine = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent('access-owner', 'ou-owner', 'schedule every 30m: Check CI'),
    );
    assert.equal(ownerRoutine.data.accepted, true);
    assert.equal(ownerRoutine.data.authorization.workspaceRole, 'owner');

    const access = await fetch(`${baseUrl}/v1/access?workspaceId=dev-workspace`).then(
      (response) => response.json(),
    );
    assert.equal(access.members.length, 3);
    assert.equal(
      access.projectPolicies.find((policy) => policy.projectId === 'opentag')
        .mode,
      'members',
    );
    assert.equal(access.projectMemberships.length, 3);
    assert.ok(
      access.projectMemberships.some(
        (membership) => membership.projectId === 'reviewed',
      ),
    );

    const ignored = await fetch(`${baseUrl}/v1/deliveries?limit=20`).then(
      (response) => response.json(),
    );
    const deniedEvent = ignored.inboundEvents.find(
      (event) => event.externalId === 'access-unknown',
    );
    assert.equal(deniedEvent.reason, 'actor_not_authorized');
    assert.equal(
      deniedEvent.metadata.authorization.reason,
      'workspace_member_required',
    );
    assert.equal(
      ignored.inboundEvents.find(
        (event) => event.externalId === 'access-native-lark-unknown',
      ).reason,
      'actor_not_authorized',
    );
    assert.equal(
      ignored.inboundEvents.find((event) => event.externalId === 'update:9101')
        .reason,
      'actor_not_authorized',
    );
  },
);
