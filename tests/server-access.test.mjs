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

function clientEvent(eventId, actorId, text) {
  return {
    platform: 'lark',
    eventId,
    thread: {
      externalId: 'oc_access:root',
      channelId: 'oc_access',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
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
        OPENTAG_TELEGRAM_TRANSPORT: 'memory',
        OPENTAG_TELEGRAM_BOT_USERNAME: 'OpenTagBot',
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

    const unknown = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent('access-unknown', 'ou-unknown', '@OpenTag status'),
    );
    assert.equal(unknown.response.status, 202);
    assert.equal(unknown.data.accepted, false);
    assert.equal(unknown.data.reason, 'actor_not_authorized');
    assert.equal(unknown.data.authorization.reason, 'workspace_member_required');

    const viewer = await postJson(
      baseUrl,
      '/v1/client/events',
      clientEvent('access-viewer', 'ou-viewer', '@OpenTag status'),
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
      clientEvent('access-contributor', 'ou-contributor', '@OpenTag status'),
    );
    assert.equal(contributorRun.response.status, 202);
    assert.equal(contributorRun.data.accepted, true);
    assert.equal(
      contributorRun.data.run.metadata.actorAuthorization.projectRole,
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
      nativeTelegramContributor.data.run.metadata.actorAuthorization.memberId,
      contributor.id,
    );
    assert.equal(
      nativeTelegramContributor.data.run.metadata.actorAuthorization.projectRole,
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
      contributorWorkspaceMemory.data.run.metadata.actorAuthorization.workspaceRole,
      'member',
    );

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
    assert.equal(ownerRoutine.data.run.metadata.actorAuthorization.workspaceRole, 'owner');

    const access = await fetch(`${baseUrl}/v1/access?workspaceId=dev-workspace`).then(
      (response) => response.json(),
    );
    assert.equal(access.members.length, 3);
    assert.equal(access.projectPolicies[0].mode, 'members');
    assert.equal(access.projectMemberships.length, 1);

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
