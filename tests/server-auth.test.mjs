import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';
import { FileDelegatedAgentTaskStore } from '@opentag/config';
import { createEmptyDeliveryState } from '@opentag/delivery';

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

async function waitForHealth(url, child, logs, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // The server can refuse connections briefly while starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${url}\n${logs.join('')}`);
}

async function launchServer(context, prefix, environment, prepare) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  if (prepare) await prepare(dataDir);
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENTAG_PORT: String(port),
      OPENTAG_HOST: '127.0.0.1',
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_ADMIN_TOKEN: '',
      OPENTAG_ADMIN_COOKIE_SECURE: 'false',
      OPENTAG_CLIENT_INGRESS_TOKEN: '',
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_ROUTINES_ENABLED: 'false',
      ...environment,
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
  return {
    baseUrl,
    dataDir,
    health: await waitForHealth(`${baseUrl}/health`, child, logs),
  };
}

function lifecycleRun(id, updatedAt, threadId = 'lark:oc_lifecycle:root') {
  return {
    id,
    status: 'completed',
    platform: 'lark',
    threadId,
    threadExternalId: 'oc_lifecycle:root',
    workspaceId: 'dev-workspace',
    projectId: 'opentag',
    createdAt: updatedAt,
    updatedAt,
    completedAt: updatedAt,
  };
}

test(
  'installation owners manage Agent Identities while routes bind only matching providers',
  { timeout: 20_000 },
  async (context) => {
    const ownerToken = 'tool-identity-owner-token-that-is-long-enough';
    const scopedToken = 'tool-identity-scoped-token-that-is-long-enough';
    const { baseUrl } = await launchServer(
      context,
      'opentag-tool-identity-api-',
      {
        OPENTAG_ADMIN_TOKEN: ownerToken,
        OPENTAG_OPERATOR_PRINCIPALS_JSON: JSON.stringify([
          {
            id: 'workspace-admin',
            displayName: 'Workspace admin',
            role: 'admin',
            workspaceIds: ['dev-workspace'],
            token: scopedToken,
          },
        ]),
        OPENTAG_OPERATOR_SESSION_SECRET:
          'tool-identity-session-secret-that-is-long-enough',
        GITHUB_PAYMENTS_TOKEN: 'must-not-leak-github-token',
      },
    );
    const login = async (token) => {
      const response = await fetch(`${baseUrl}/v1/admin/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      assert.equal(response.status, 200);
      return {
        cookie: response.headers.get('set-cookie')?.split(';', 1)[0],
        session: await response.json(),
      };
    };
    const owner = await login(ownerToken);
    const scoped = await login(scopedToken);
    const scopedCreate = await fetch(`${baseUrl}/v1/tool-identities`, {
      method: 'POST',
      headers: {
        cookie: scoped.cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': scoped.session.csrfToken,
      },
      body: JSON.stringify({
        id: 'github-payments',
        displayName: 'GitHub Payments',
        provider: 'github',
        envRefs: { token: 'GITHUB_PAYMENTS_TOKEN' },
      }),
    });
    assert.equal(scopedCreate.status, 403);
    assert.equal((await scopedCreate.json()).error, 'installation_owner_required');

    const create = await fetch(`${baseUrl}/v1/tool-identities`, {
      method: 'POST',
      headers: {
        cookie: owner.cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': owner.session.csrfToken,
      },
      body: JSON.stringify({
        id: 'github-payments',
        displayName: 'GitHub Payments',
        provider: 'github',
        envRefs: { token: 'GITHUB_PAYMENTS_TOKEN' },
        externalActor: 'opentag-payments[bot]',
      }),
    });
    assert.equal(create.status, 200);
    const ownerCatalog = await create.json();
    assert.equal(ownerCatalog.identity.revision, 1);
    assert.equal(ownerCatalog.identity.envRefs.token, 'GITHUB_PAYMENTS_TOKEN');
    assert.equal(
      JSON.stringify(ownerCatalog).includes('must-not-leak-github-token'),
      false,
    );

    const scopedCatalog = await fetch(`${baseUrl}/v1/tool-identities`, {
      headers: { cookie: scoped.cookie },
    }).then((response) => response.json());
    assert.equal(scopedCatalog.identities[0].id, 'github-payments');
    assert.equal(scopedCatalog.identities[0].credentialsAvailable, true);
    assert.equal(scopedCatalog.identities[0].envRefs, undefined);

    const bind = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie: scoped.cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': scoped.session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'identity-project',
        name: 'Identity Project',
        capabilityMode: 'custom',
        tools: ['github'],
        toolConstraints: {
          github: {
            repositories: ['acme/payments'],
            permissions: ['read', 'write'],
            credentialIdentityId: 'github-payments',
          },
        },
      }),
    });
    assert.equal(bind.status, 200);
    const bindBody = await bind.json();
    assert.equal(
      bindBody.project.grants[0].credentialIdentityId,
      'github-payments',
    );

    const mismatch = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie: scoped.cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': scoped.session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'mismatch-project',
        tools: ['lark-docs'],
        toolConstraints: {
          'lark-docs': {
            documentIds: ['dox-approved'],
            credentialIdentityId: 'github-payments',
          },
        },
      }),
    });
    assert.equal(mismatch.status, 400);
    assert.equal(
      (await mismatch.json()).error,
      'tool_credential_identity_provider_mismatch:github-payments',
    );

    const disable = await fetch(
      `${baseUrl}/v1/tool-identities/github-payments/disable`,
      {
        method: 'POST',
        headers: {
          cookie: owner.cookie,
          'content-type': 'application/json',
          'x-opentag-csrf': owner.session.csrfToken,
        },
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    );
    assert.equal(disable.status, 200);
    assert.equal((await disable.json()).identity.revision, 2);
    const audit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&category=tool&action=tool_identity`,
      { headers: { cookie: owner.cookie } },
    ).then((response) => response.json());
    assert.deepEqual(
      audit.entries.map((entry) => entry.action),
      ['tool_identity.disabled', 'tool_identity.created'],
    );
    assert.equal(audit.entries[0].credentialIdentityId, 'github-payments');
    assert.equal(audit.entries[0].externalActor, 'opentag-payments[bot]');
    assert.equal(JSON.stringify(audit).includes('GITHUB_PAYMENTS_TOKEN'), false);
  },
);

test(
  'workspace lifecycle preview is scoped while owner apply requires CSRF and exact confirmation',
  { timeout: 20_000 },
  async (context) => {
    const ownerToken = 'lifecycle-owner-token-that-is-long-enough';
    const adminToken = 'lifecycle-admin-token-that-is-long-enough';
    const { baseUrl, dataDir } = await launchServer(
      context,
      'opentag-lifecycle-api-',
      {
        OPENTAG_ADMIN_TOKEN: ownerToken,
        OPENTAG_OPERATOR_PRINCIPALS_JSON: JSON.stringify([
          {
            id: 'lifecycle-admin',
            displayName: 'Lifecycle admin',
            role: 'admin',
            workspaceIds: ['dev-workspace'],
            token: adminToken,
          },
        ]),
        OPENTAG_OPERATOR_SESSION_SECRET: 'lifecycle-session-secret-that-is-long-enough',
      },
      async (root) => {
        const state = createEmptyDeliveryState();
        state.agentRuns.push(
          lifecycleRun('lifecycle-delete', '2026-01-01T00:00:00.000Z'),
          lifecycleRun('lifecycle-keep', '2026-08-01T00:00:00.000Z'),
        );
        state.agentRunEvents.push({
          id: 'lifecycle-event',
          sequence: 1,
          runId: 'lifecycle-delete',
          type: 'completed',
          at: '2026-01-01T00:00:00.000Z',
        });
        await fs.mkdir(path.join(root, 'delivery'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'delivery', 'delivery-state.json'),
          JSON.stringify(state),
          'utf8',
        );
      },
    );
    const login = async (token) => {
      const response = await fetch(`${baseUrl}/v1/admin/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      assert.equal(response.status, 200);
      return {
        cookie: response.headers.get('set-cookie')?.split(';', 1)[0],
        session: await response.json(),
      };
    };
    const admin = await login(adminToken);
    const owner = await login(ownerToken);
    const preview = await fetch(
      `${baseUrl}/v1/data-lifecycle?workspaceId=dev-workspace&retentionDays=90&keepLatestPerThread=1`,
      { headers: { cookie: admin.cookie } },
    );
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.dryRun, true);
    assert.equal(previewBody.removed.agentRuns, 1);
    assert.equal(JSON.stringify(previewBody).includes('lifecycle-delete'), false);
    const wrongWorkspace = await fetch(
      `${baseUrl}/v1/data-lifecycle?workspaceId=other-workspace`,
      { headers: { cookie: admin.cookie } },
    );
    assert.equal(wrongWorkspace.status, 403);
    const applyBody = {
      workspaceId: 'dev-workspace',
      confirmationWorkspaceId: 'dev-workspace',
      retentionDays: 90,
      keepLatestPerThread: 1,
    };
    const adminApply = await fetch(`${baseUrl}/v1/data-lifecycle`, {
      method: 'POST',
      headers: {
        cookie: admin.cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': admin.session.csrfToken,
      },
      body: JSON.stringify(applyBody),
    });
    assert.equal(adminApply.status, 403);
    assert.equal((await adminApply.json()).error, 'operator_owner_required');
    const noCsrf = await fetch(`${baseUrl}/v1/data-lifecycle`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(applyBody),
    });
    assert.equal(noCsrf.status, 403);
    const wrongConfirmation = await fetch(`${baseUrl}/v1/data-lifecycle`, {
      method: 'POST',
      headers: {
        cookie: owner.cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': owner.session.csrfToken,
      },
      body: JSON.stringify({ ...applyBody, confirmationWorkspaceId: 'other' }),
    });
    assert.equal(wrongConfirmation.status, 400);
    const applied = await fetch(`${baseUrl}/v1/data-lifecycle`, {
      method: 'POST',
      headers: {
        cookie: owner.cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': owner.session.csrfToken,
      },
      body: JSON.stringify(applyBody),
    });
    assert.equal(applied.status, 200);
    assert.equal((await applied.json()).removed.agentRuns, 1);
    const sqlite = new SqliteOpenTagStore({
      databasePath: path.join(dataDir, 'opentag.sqlite'),
    });
    context.after(() => sqlite.close());
    assert.equal(await sqlite.deliveryStore.getAgentRun('lifecycle-delete'), undefined);
    assert.ok(await sqlite.deliveryStore.getAgentRun('lifecycle-keep'));
    const audit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&action=workspace.data_lifecycle.applied`,
      { headers: { cookie: owner.cookie } },
    );
    assert.equal(audit.status, 200);
    const auditBody = await audit.json();
    assert.equal(auditBody.entries.length, 1);
    assert.equal(auditBody.entries[0].actor, 'operator:installation-owner');
    assert.match(auditBody.entries[0].summary, /Removed 1 terminal runs/u);
  },
);

test(
  'server protects operator APIs while leaving verified client callbacks independent',
  { timeout: 20_000 },
  async (context) => {
    const adminToken = 'integration-operator-token-123456789';
    const scopedAdminToken = 'integration-scoped-admin-token-123456789';
    const { baseUrl, dataDir, health } = await launchServer(
      context,
      'opentag-auth-api-',
      {
        OPENTAG_ADMIN_TOKEN: adminToken,
        OPENTAG_OPERATOR_PRINCIPALS_JSON: JSON.stringify([
          {
            id: 'dev-admin',
            displayName: 'Development admin',
            role: 'admin',
            workspaceIds: ['dev-workspace'],
            token: scopedAdminToken,
          },
        ]),
        OPENTAG_LARK_EVENT_MODE: 'webhook',
        OPENTAG_LARK_VERIFICATION_TOKEN: 'auth-boundary-lark-token',
        OPENTAG_LARK_CALLBACK_MAX_SKEW_SECONDS: '0',
        LINEAR_MCP_TOKEN: 'host-only-test-token',
        OPENTAG_EXTERNAL_MCP_SERVERS_JSON: JSON.stringify({
          servers: [
            {
              id: 'linear',
              label: 'Linear MCP',
              command: '/deployment/linear-mcp',
              envRefs: { LINEAR_TOKEN: 'LINEAR_MCP_TOKEN' },
              tools: [
                { name: 'search_issues', risk: 'read' },
                { name: 'create_issue', risk: 'write' },
              ],
            },
          ],
        }),
      },
    );
    assert.equal(health.security.operatorAuth.configured, true);
    assert.equal(health.security.clientIngress.mode, 'disabled');
    assert.equal(health.storage.driver, 'sqlite');
    assert.equal(health.storage.wal, true);

    const consoleResponse = await fetch(`${baseUrl}/`);
    assert.equal(consoleResponse.status, 200);
    assert.match(
      consoleResponse.headers.get('content-security-policy') || '',
      /frame-ancestors 'none'/,
    );
    assert.equal(
      consoleResponse.headers.get('x-content-type-options'),
      'nosniff',
    );

    const anonymous = await fetch(`${baseUrl}/v1/workspace`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, 'operator_auth_required');

    const genericIngress = await fetch(`${baseUrl}/v1/client/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(genericIngress.status, 503);
    assert.equal(
      (await genericIngress.json()).error,
      'client_ingress_token_required',
    );

    const larkChallenge = await fetch(`${baseUrl}/v1/lark/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'auth-boundary-lark-token',
        challenge: 'lark-auth-boundary',
      }),
    });
    assert.equal(larkChallenge.status, 200);
    assert.deepEqual(await larkChallenge.json(), {
      challenge: 'lark-auth-boundary',
    });

    const rejectedLogin = await fetch(`${baseUrl}/v1/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'incorrect' }),
    });
    assert.equal(rejectedLogin.status, 401);
    assert.equal(rejectedLogin.headers.get('set-cookie'), null);

    const login = await fetch(`${baseUrl}/v1/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    assert.equal(session.authenticated, true);
    assert.ok(session.csrfToken);

    const sessionRead = await fetch(`${baseUrl}/v1/workspace`, {
      headers: { cookie },
    });
    assert.equal(sessionRead.status, 200);

    const delegatedTaskStore = new FileDelegatedAgentTaskStore(
      path.join(dataDir, 'config'),
    );
    const queuedDelegatedTask = await delegatedTaskStore.create({
      parentRunId: 'auth-parent-run',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      thread: {
        id: 'lark:oc_auth:root',
        platform: 'lark',
        externalId: 'oc_auth:root',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        channelId: 'oc_auth',
        visibility: 'private',
      },
      agentId: 'evidence-reviewer',
      agentRevision: 1,
      task: 'Review the bounded authentication evidence.',
      createdBy: 'agent:opentag',
      accessSnapshot: {
        skillIds: [],
        knowledgeSourceIds: [],
        grantIds: [],
        memoryScopes: [],
        networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
      },
    });
    const scopedTaskList = await fetch(
      `${baseUrl}/v1/agent-tasks?workspaceId=dev-workspace`,
      { headers: { authorization: `Bearer ${scopedAdminToken}` } },
    );
    assert.equal(scopedTaskList.status, 200);
    const scopedTasks = await scopedTaskList.json();
    assert.equal(scopedTasks.tasks[0].id, queuedDelegatedTask.id);
    assert.equal(scopedTasks.tasks[0].task, undefined);
    assert.match(scopedTasks.tasks[0].taskPreview, /authentication evidence/u);

    const scopedTaskCancel = await fetch(
      `${baseUrl}/v1/agent-tasks/${queuedDelegatedTask.id}/cancel`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${scopedAdminToken}` },
      },
    );
    assert.equal(scopedTaskCancel.status, 200);
    assert.equal((await scopedTaskCancel.json()).task.status, 'cancelled');
    const duplicateTaskCancel = await fetch(
      `${baseUrl}/v1/agent-tasks/${queuedDelegatedTask.id}/cancel`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${scopedAdminToken}` },
      },
    );
    assert.equal(duplicateTaskCancel.status, 409);
    assert.equal(
      (await duplicateTaskCancel.json()).error,
      'delegated_agent_task_terminal',
    );

    const connectorRead = await fetch(
      `${baseUrl}/v1/mcp-connectors?workspaceId=dev-workspace`,
      { headers: { cookie } },
    );
    assert.equal(connectorRead.status, 200);
    const connectorSnapshot = await connectorRead.json();
    assert.equal(connectorSnapshot.connectors.length, 1);
    assert.deepEqual(
      connectorSnapshot.connectors[0].tools.map((tool) => tool.risk),
      ['read', 'write'],
    );
    assert.equal(connectorSnapshot.connectors[0].enabled, true);
    assert.equal(connectorSnapshot.connectors[0].revision, 0);
    assert.equal(connectorSnapshot.connectors[0].credentialsAvailable, true);
    for (const hidden of ['command', 'args', 'cwd', 'envRefs', 'LINEAR_MCP_TOKEN']) {
      assert.equal(JSON.stringify(connectorSnapshot).includes(hidden), false);
    }

    const scopedConnectorDisable = await fetch(
      `${baseUrl}/v1/mcp-connectors/linear/disable`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedAdminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expectedRevision: 0 }),
      },
    );
    assert.equal(scopedConnectorDisable.status, 403);
    assert.equal(
      (await scopedConnectorDisable.json()).error,
      'installation_operator_required',
    );

    const disabledConnectorResponse = await fetch(
      `${baseUrl}/v1/mcp-connectors/linear/disable`,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-opentag-csrf': session.csrfToken,
        },
        body: JSON.stringify({
          workspaceId: 'dev-workspace',
          expectedRevision: 0,
        }),
      },
    );
    assert.equal(disabledConnectorResponse.status, 200);
    const disabledConnector = (await disabledConnectorResponse.json()).connector;
    assert.equal(disabledConnector.enabled, false);
    assert.equal(disabledConnector.revision, 1);
    const disabledWorkspace = await fetch(`${baseUrl}/v1/workspace`, {
      headers: { cookie },
    }).then((response) => response.json());
    assert.equal(
      disabledWorkspace.availableTools.find((tool) => tool.id === 'mcp:linear')
        .providerStatus,
      'disabled',
    );

    const staleConnectorUpdate = await fetch(
      `${baseUrl}/v1/mcp-connectors/linear/enable`,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-opentag-csrf': session.csrfToken,
        },
        body: JSON.stringify({ expectedRevision: 0 }),
      },
    );
    assert.equal(staleConnectorUpdate.status, 409);
    assert.deepEqual(await staleConnectorUpdate.json(), {
      error: 'managed_connector_revision_conflict',
      currentRevision: 1,
    });
    const enabledConnectorResponse = await fetch(
      `${baseUrl}/v1/mcp-connectors/linear/enable`,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-opentag-csrf': session.csrfToken,
        },
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    );
    assert.equal(enabledConnectorResponse.status, 200);
    assert.equal((await enabledConnectorResponse.json()).connector.enabled, true);

    const connectorCheck = await fetch(
      `${baseUrl}/v1/mcp-connectors/linear/check`,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-opentag-csrf': session.csrfToken,
        },
        body: JSON.stringify({ workspaceId: 'dev-workspace' }),
      },
    );
    assert.equal(connectorCheck.status, 200);
    const checkedConnector = (await connectorCheck.json()).connector;
    assert.equal(checkedConnector.revision, 2);
    assert.equal(checkedConnector.lastCheck.status, 'unavailable');
    assert.equal(
      checkedConnector.lastCheck.errorCode,
      'external_mcp_connection_failed',
    );
    const connectorAudit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&category=tool&action=connector`,
      { headers: { cookie } },
    ).then((response) => response.json());
    assert.deepEqual(
      connectorAudit.entries.map((entry) => entry.action),
      ['connector.checked', 'connector.enabled', 'connector.disabled'],
    );
    assert.equal(
      JSON.stringify(connectorAudit).includes('/deployment/linear-mcp'),
      false,
    );
    const scopedConnectorAudit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&category=tool&action=connector`,
      { headers: { authorization: `Bearer ${scopedAdminToken}` } },
    ).then((response) => response.json());
    assert.deepEqual(scopedConnectorAudit.entries, []);

    const sessionWriteWithoutCsrf = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'auth-test',
      }),
    });
    assert.equal(sessionWriteWithoutCsrf.status, 403);
    assert.equal(
      (await sessionWriteWithoutCsrf.json()).error,
      'operator_csrf_required',
    );

    const workspaceWrite = await fetch(`${baseUrl}/v1/workspace`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        name: 'Authenticated workspace',
        agentName: 'Workspace Tag',
        executorId: 'claude',
        tools: ['github'],
        toolConstraints: {
          github: {
            repositories: ['acme/shared'],
            permissions: ['read'],
          },
        },
        networkMode: 'restricted',
        allowedHosts: ['github.com'],
        memoryApprovalPolicy: {
          mode: 'require_approval',
          scopes: ['workspace', 'project'],
          actions: ['remember', 'forget'],
        },
        memoryRetentionPolicy: { mode: 'custom', days: 120 },
      }),
    });
    assert.equal(workspaceWrite.status, 200);
    const workspaceWriteBody = await workspaceWrite.json();
    assert.equal(workspaceWriteBody.workspace.identity.displayName, 'Workspace Tag');
    assert.equal(workspaceWriteBody.workspace.grants[0].scope, 'workspace');
    assert.equal(
      workspaceWriteBody.workspace.networkPolicy.mode,
      'restricted',
    );
    assert.deepEqual(workspaceWriteBody.workspace.memoryApprovalPolicy, {
      mode: 'require_approval',
      scopes: ['workspace', 'project'],
      actions: ['remember', 'forget'],
    });
    assert.deepEqual(workspaceWriteBody.workspace.memoryRetentionPolicy, {
      mode: 'custom',
      days: 120,
    });

    const sessionWrite = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'auth-test',
        name: 'Authenticated project',
        tools: ['github', 'lark-docs', 'lark-base', 'mcp:linear'],
        toolConstraints: {
          github: {
            repositories: ['acme/payments'],
            permissions: ['read', 'write'],
          },
          'lark-docs': { documentIds: ['dox-approved'] },
          'lark-base': { appTokens: ['base-approved'] },
          'mcp:linear': {
            tools: ['search_issues', 'create_issue'],
            permissions: ['read', 'write'],
          },
        },
      }),
    });
    assert.equal(sessionWrite.status, 200);

    const configuredWorkspace = await fetch(`${baseUrl}/v1/workspace`, {
      headers: { cookie },
    });
    const configuredSnapshot = await configuredWorkspace.json();
    const configuredProject = configuredSnapshot.projects.find(
      (project) => project.projectId === 'auth-test',
    );
    assert.equal(configuredProject.toolCount, 8);
    assert.deepEqual(
      configuredProject.grants.find((grant) => grant.kind === 'github').constraints,
      { repositories: ['acme/payments'], permissions: ['read', 'write'] },
    );
    assert.ok(
      configuredSnapshot.availableTools.some(
        (tool) =>
          tool.id === 'lark-docs' &&
          tool.toolCount === 2 &&
          tool.readToolCount === 1 &&
          tool.writeToolCount === 1,
      ),
    );
    assert.ok(
      configuredSnapshot.availableTools.some(
        (tool) =>
          tool.id === 'routines' &&
          tool.toolCount === 5 &&
          tool.readToolCount === 1 &&
          tool.writeToolCount === 4,
      ),
    );
    assert.ok(
      configuredSnapshot.availableTools.some(
        (tool) =>
          tool.id === 'mcp:linear' &&
          tool.providerStatus === 'configured' &&
          tool.toolCount === 2 &&
          tool.constraints[0].allowedValues.join(',') ===
            'search_issues,create_issue',
      ),
    );
    assert.deepEqual(
      configuredProject.grants.find((grant) => grant.kind === 'mcp:linear')
        .constraints,
      {
        tools: ['search_issues', 'create_issue'],
        permissions: ['read', 'write'],
      },
    );
    assert.equal(
      JSON.stringify(configuredSnapshot).includes('host-only-test-token'),
      false,
    );

    const invalidExternalTool = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'auth-test',
        tools: ['mcp:linear'],
        toolConstraints: {
          'mcp:linear': {
            tools: ['server_added_without_policy'],
            permissions: ['read'],
          },
        },
      }),
    });
    assert.equal(invalidExternalTool.status, 400);
    assert.equal(
      (await invalidExternalTool.json()).error,
      'invalid_tool_constraint:mcp:linear:tools',
    );
    const invalidWorkspaceCommand = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'auth-test',
        tools: ['shell'],
        toolConstraints: {
          shell: {
            permissions: ['read', 'write'],
            commands: ['*'],
          },
        },
      }),
    });
    assert.equal(invalidWorkspaceCommand.status, 400);
    assert.equal(
      (await invalidWorkspaceCommand.json()).error,
      'invalid_tool_constraint:shell:commands',
    );

    const workspaceCommandPolicy = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'workspace-tools-test',
        tools: ['shell'],
        toolConstraints: {
          shell: {
            permissions: ['read', 'write'],
            commands: ['npm', 'git'],
          },
        },
      }),
    });
    assert.equal(workspaceCommandPolicy.status, 200);
    const workspaceCommandProject = (await workspaceCommandPolicy.json())
      .project;
    assert.deepEqual(workspaceCommandProject.grants[0].constraints, {
      commands: ['npm', 'git'],
      permissions: ['read', 'write'],
    });
    const codexRunner = configuredSnapshot.executors.find(
      (runner) => runner.id === 'codex',
    );
    const claudeRunner = configuredSnapshot.executors.find(
      (runner) => runner.id === 'claude',
    );
    assert.equal(codexRunner.provider, 'codex');
    assert.equal(codexRunner.capabilities.steering, 'next_turn');
    assert.equal(codexRunner.capabilities.brokeredTools, true);
    assert.equal(claudeRunner.provider, 'claude');
    assert.equal(claudeRunner.capabilities.automaticMemoryCandidates, true);

    const unsupportedRunner = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'auth-test',
        executorId: 'not-installed',
      }),
    });
    assert.equal(unsupportedRunner.status, 400);
    assert.equal((await unsupportedRunner.json()).error, 'unsupported_executor');

    const invalidRetention = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-opentag-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'auth-test',
        memoryRetentionPolicy: { mode: 'custom', days: 0 },
      }),
    });
    assert.equal(invalidRetention.status, 400);
    assert.equal(
      (await invalidRetention.json()).error,
      'invalid_memory_retention_days',
    );

    const bearerWrite = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'bearer-test',
      }),
    });
    assert.equal(bearerWrite.status, 200);
    const bearerProject = (await bearerWrite.json()).project;
    assert.equal(bearerProject.agentMode, 'inherit');
    assert.equal(bearerProject.capabilityMode, 'inherit');

    const inheritedWorkspace = await fetch(`${baseUrl}/v1/workspace`, {
      headers: { cookie },
    }).then((response) => response.json());
    const inheritedProject = inheritedWorkspace.projects.find(
      (project) => project.projectId === 'bearer-test',
    );
    assert.equal(inheritedProject.toolCount, 2);
    assert.deepEqual(inheritedProject.memoryApprovalPolicy, {
      mode: 'inherit',
    });
    assert.deepEqual(inheritedProject.memoryRetentionPolicy, {
      mode: 'inherit',
    });

    const logout = await fetch(`${baseUrl}/v1/admin/session`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
  },
);

test(
  'generic client ingress uses its own bearer credential',
  { timeout: 20_000 },
  async (context) => {
    const ingressToken = 'integration-client-ingress-token-12345';
    const adminToken = 'integration-operator-token-987654321';
    const { baseUrl, dataDir, health } = await launchServer(
      context,
      'opentag-client-auth-',
      {
        OPENTAG_ADMIN_TOKEN: adminToken,
        OPENTAG_CLIENT_INGRESS_TOKEN: ingressToken,
      },
    );
    assert.equal(health.security.clientIngress.mode, 'bearer');

    const envelope = {
      platform: 'custom-chat',
      eventId: 'authenticated-client-event',
      thread: {
        externalId: 'custom-chat-42',
        channelId: 'custom-chat-42',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        visibility: 'public',
      },
      message: {
        id: 'authenticated-client-message',
        text: '/maxtag summarize this project',
        actor: { id: 'custom-user', displayName: 'Custom user' },
        attachments: [
          {
            id: 'client-report',
            kind: 'file',
            name: '../../client-report.txt',
            mimeType: 'text/plain',
            contentBase64: Buffer.from('client attachment').toString('base64'),
          },
        ],
      },
    };
    const unauthorized = await fetch(`${baseUrl}/v1/client/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(
      (await unauthorized.json()).error,
      'client_ingress_auth_required',
    );
    const unauthorizedCardAction = await fetch(`${baseUrl}/v1/lark/card-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'card.action.trigger',
        event_id: 'unauthorized-card-action',
      }),
    });
    assert.equal(unauthorizedCardAction.status, 401);
    assert.equal(
      (await unauthorizedCardAction.json()).error,
      'client_ingress_auth_required',
    );
    const unauthorizedBackfill = await fetch(`${baseUrl}/v1/lark/backfill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        since: '2026-08-13T00:00:00.000Z',
        until: '2026-08-13T00:01:00.000Z',
      }),
    });
    assert.equal(unauthorizedBackfill.status, 401);
    assert.equal(
      (await unauthorizedBackfill.json()).error,
      'client_ingress_auth_required',
    );

    const accepted = await fetch(`${baseUrl}/v1/client/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingressToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(envelope),
    });
    assert.equal(accepted.status, 202);
    const result = await accepted.json();
    assert.equal(result.accepted, true);
    assert.equal(result.queued, true);
    assert.equal(result.route.projectId, 'opentag');
    assert.equal(result.run.metadata.workspaceMemoryWriteAllowed, false);
    const attachment = result.run.message.attachments[0];
    assert.equal(attachment.name, 'client-report.txt');
    assert.equal(attachment.metadata.managed, true);
    assert.equal(
      result.run.message.metadata.clientMessage.attachments[0].contentBase64,
      undefined,
    );
    assert.equal(
      result.run.message.metadata.clientMessage.attachments[0].localPath,
      undefined,
    );
    assert.equal(
      path.relative(path.join(dataDir, 'content'), attachment.localPath).startsWith('..'),
      false,
    );
    assert.equal(await fs.readFile(attachment.localPath, 'utf8'), 'client attachment');

    const searchedRunsResponse = await fetch(
      `${baseUrl}/v1/runs?workspaceId=dev-workspace&q=summarize%20custom&limit=10`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    assert.equal(searchedRunsResponse.status, 200);
    const searchedRuns = await searchedRunsResponse.json();
    assert.equal(searchedRuns.query, 'summarize custom');
    assert.equal(searchedRuns.truncated, false);
    assert.deepEqual(
      searchedRuns.runs.map((run) => run.id),
      [result.run.id],
    );

    const authorizedCardAction = await fetch(`${baseUrl}/v1/lark/card-actions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingressToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'card.action.trigger',
        event_id: 'authorized-card-action',
        operator_id: 'ou-operator',
        message_id: 'om-card',
        chat_id: 'oc-card',
        action_value: JSON.stringify({
          action: 'opentag.stop_run',
          run_id: 'run-missing',
        }),
      }),
    });
    assert.equal(authorizedCardAction.status, 200);
    assert.equal((await authorizedCardAction.json()).toast.type, 'warning');

    const detailResponse = await fetch(
      `${baseUrl}/v1/runs/${encodeURIComponent(result.run.id)}/events`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.run.message.attachments[0].metadata.sha256.length, 64);

    const invalidUrlEnvelope = structuredClone(envelope);
    invalidUrlEnvelope.eventId = 'invalid-client-attachment-url';
    invalidUrlEnvelope.message.id = 'invalid-client-attachment-url-message';
    invalidUrlEnvelope.message.attachments = [
      {
        id: 'host-file',
        kind: 'file',
        name: 'passwd',
        url: 'file:///etc/passwd',
      },
    ];
    const invalidUrl = await fetch(`${baseUrl}/v1/client/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingressToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(invalidUrlEnvelope),
    });
    assert.equal(invalidUrl.status, 400);
    assert.equal((await invalidUrl.json()).error, 'attachment_url_not_allowed');

    const budgetPolicy = await fetch(`${baseUrl}/v1/workspace`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        budgetPolicy: {
          mode: 'custom',
          scope: 'workspace',
          maxRunsPerMonth: 0,
        },
      }),
    });
    assert.equal(budgetPolicy.status, 200);
    assert.deepEqual(
      (await budgetPolicy.json()).workspace.budgetPolicy,
      {
        mode: 'custom',
        scope: 'workspace',
        maxRunsPerMonth: 0,
      },
    );

    const budgetEnvelope = structuredClone(envelope);
    budgetEnvelope.eventId = 'budget-denied-client-event';
    budgetEnvelope.message.id = 'budget-denied-client-message';
    budgetEnvelope.message.attachments = [];
    const budgetDenied = await fetch(`${baseUrl}/v1/client/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingressToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(budgetEnvelope),
    });
    assert.equal(budgetDenied.status, 202);
    const budgetDeniedBody = await budgetDenied.json();
    assert.equal(budgetDeniedBody.accepted, false);
    assert.equal(budgetDeniedBody.queued, false);
    assert.equal(budgetDeniedBody.reason, 'usage_budget_denied');
    assert.match(
      budgetDeniedBody.message,
      /Monthly workspace run budget exceeded/,
    );

    const statusEnvelope = structuredClone(envelope);
    statusEnvelope.eventId = 'budget-status-client-event';
    statusEnvelope.message.id = 'budget-status-client-message';
    statusEnvelope.message.text = '/maxtag status';
    statusEnvelope.message.attachments = [];
    const statusAccepted = await fetch(`${baseUrl}/v1/client/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingressToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(statusEnvelope),
    });
    assert.equal(statusAccepted.status, 202);
    const statusAcceptedBody = await statusAccepted.json();
    assert.equal(statusAcceptedBody.accepted, true);
    assert.equal(statusAcceptedBody.queued, true);
    assert.equal(statusAcceptedBody.run.executorId, 'thread-status');

    const workerPass = await fetch(`${baseUrl}/v1/runs/worker-pass`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ limit: 10 }),
    });
    assert.equal(workerPass.status, 200);
    const workerPassBody = await workerPass.json();
    assert.equal(workerPassBody.result.completed, 1);
    assert.equal(workerPassBody.result.failed, 1);
    const statusRun = workerPassBody.result.runs.find(
      (run) => run.id === statusAcceptedBody.run.id,
    );
    assert.equal(statusRun.status, 'completed');
    assert.match(statusRun.summary, /下一次模型调用：已阻止/);
    assert.match(statusRun.summary, /查看本卡片不消耗模型调用/);

    const auditResponse = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&action=thread_status`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json();
    const statusAudit = auditBody.entries.find(
      (entry) => entry.runId === statusAcceptedBody.run.id,
    );
    assert.equal(statusAudit.action, 'thread_status');
    assert.equal(statusAudit.summary, 'Thread capability status inspected');
    assert.doesNotMatch(JSON.stringify(statusAudit), /client-report|run budget/);
  },
);

test(
  'named operator principals enforce workspace scope, write role, and audit identity',
  { timeout: 20_000 },
  async (context) => {
    const adminToken = 'dev-admin-token-that-is-long-enough-123';
    const viewerToken = 'dev-viewer-token-that-is-long-enough-456';
    const principals = [
      {
        id: 'dev-admin',
        displayName: 'Development admin',
        role: 'admin',
        workspaceIds: ['dev-workspace'],
        token: adminToken,
      },
      {
        id: 'dev-viewer',
        displayName: 'Development viewer',
        role: 'viewer',
        workspaceIds: ['dev-workspace'],
        token: viewerToken,
      },
    ];
    const { baseUrl, dataDir, health } = await launchServer(
      context,
      'opentag-principal-api-',
      {
        OPENTAG_OPERATOR_PRINCIPALS_JSON: JSON.stringify(principals),
        OPENTAG_OPERATOR_SESSION_SECRET:
          'principal-session-secret-that-is-long-enough',
      },
    );
    assert.equal(health.security.operatorAuth.configured, true);
    assert.equal(health.security.operatorAuth.principalCount, 2);

    const adminLogin = await fetch(`${baseUrl}/v1/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    });
    assert.equal(adminLogin.status, 200);
    const adminSession = await adminLogin.json();
    const adminCookie = adminLogin.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(adminCookie);
    assert.deepEqual(adminSession.principal, {
      id: 'dev-admin',
      displayName: 'Development admin',
      role: 'admin',
      workspaceIds: ['dev-workspace'],
    });
    assert.equal(Object.hasOwn(adminSession.principal, 'token'), false);

    const viewerCreateAssistant = await fetch(
      `${baseUrl}/v1/assistant/sessions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${viewerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: 'dev-workspace',
          projectId: 'opentag',
        }),
      },
    );
    assert.equal(viewerCreateAssistant.status, 403);
    assert.equal(
      (await viewerCreateAssistant.json()).error,
      'operator_write_required',
    );

    const adminCreateAssistant = await fetch(
      `${baseUrl}/v1/assistant/sessions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: 'dev-workspace',
          projectId: 'opentag',
          title: 'Principal-scoped assistant',
        }),
      },
    );
    assert.equal(adminCreateAssistant.status, 201);
    const adminAssistant = await adminCreateAssistant.json();
    const viewerReadAssistant = await fetch(
      `${baseUrl}/v1/assistant/sessions/${adminAssistant.session.id}`,
      { headers: { authorization: `Bearer ${viewerToken}` } },
    );
    assert.equal(viewerReadAssistant.status, 200);
    const viewerStreamAbort = new AbortController();
    const viewerStream = await fetch(
      `${baseUrl}/v1/assistant/sessions/${adminAssistant.session.id}/events`,
      {
        headers: { authorization: `Bearer ${viewerToken}` },
        signal: viewerStreamAbort.signal,
      },
    );
    assert.equal(viewerStream.status, 200);
    assert.match(viewerStream.headers.get('content-type') || '', /text\/event-stream/u);
    viewerStreamAbort.abort();

    const sqlite = new SqliteOpenTagStore({
      databasePath: path.join(dataDir, 'opentag.sqlite'),
    });
    context.after(() => sqlite.close());
    await sqlite.deliveryStore.configureThreadBinding({
      platform: 'web',
      externalId: 'assistant:labs-private-session',
      scope: 'thread',
      source: 'configured',
      workspaceId: 'labs',
      projectId: 'labs-project',
      channelId: 'web:labs:labs-project',
      title: 'Labs private conversation',
      activationMode: 'always',
      requireMention: false,
      metadata: {
        webAssistant: true,
        webAssistantSessionId: 'labs-private-session',
        webAssistantThreadId: 'web:labs:labs-project:labs-private-session',
      },
    });
    const crossWorkspaceStream = await fetch(
      `${baseUrl}/v1/assistant/sessions/labs-private-session/events`,
      { headers: { authorization: `Bearer ${viewerToken}` } },
    );
    assert.equal(crossWorkspaceStream.status, 403);
    assert.equal(
      (await crossWorkspaceStream.json()).error,
      'operator_workspace_forbidden',
    );
    const approvalThread = {
      id: 'lark:oc-approval:root',
      platform: 'lark',
      externalId: 'oc-approval:root',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'oc-approval',
      visibility: 'private',
    };
    await sqlite.deliveryStore.createAgentRun({
      runId: 'run-operator-tool-approval',
      thread: approvalThread,
    });
    const toolApproval = await sqlite.deliveryStore.proposeToolApproval({
      runId: 'run-operator-tool-approval',
      toolCallId: 'call-operator-tool-approval',
      toolName: 'github_issue_create',
      title: 'Create GitHub issue',
      grantKind: 'github',
      risk: 'write',
      arguments: {
        owner: 'acme',
        repo: 'payments',
        title: 'Review exact arguments',
      },
      argumentSummary: {
        owner: 'acme',
        repo: 'payments',
        title: 'Review exact arguments',
      },
      argumentDigest: 'operator-approval-digest',
      thread: approvalThread,
      requestedBy: 'agent:opentag',
    });
    await sqlite.deliveryStore.appendAgentRunEvent(
      'run-operator-tool-approval',
      'tool_call',
      {
        message: 'Calling Claude Bash command',
        metadata: {
          call: {
            id: 'native-claude-bash-1',
            name: 'claude.bash',
            title: 'Claude Bash command',
            grantKind: 'shell',
            risk: 'write',
            source: 'provider-native',
            provider: 'claude',
            destination: 'https://untrusted-native.example/private?token=leak',
          },
        },
      },
    );
    await sqlite.deliveryStore.appendAgentRunEvent(
      'run-operator-tool-approval',
      'tool_result',
      {
        message: 'GitHub repository succeeded',
        metadata: {
          call: {
            id: 'broker-github-read-1',
            name: 'github_repository',
            title: 'Inspect GitHub repository',
            grantKind: 'github',
            risk: 'read',
            source: 'broker',
            provider: 'opentag:github',
            destination:
              'https://api.github.example/repos/acme/payments?token=must-not-leak',
            status: 'succeeded',
            durationMs: 8,
          },
        },
      },
    );
    await sqlite.deliveryStore.appendAgentRunEvent(
      'run-operator-tool-approval',
      'tool_result',
      {
        message: 'Claude Bash command succeeded',
        metadata: {
          call: {
            id: 'native-claude-bash-1',
            name: 'claude.bash',
            title: 'Claude Bash command',
            grantKind: 'shell',
            risk: 'write',
            source: 'provider-native',
            provider: 'claude',
            status: 'succeeded',
            durationMs: 12,
          },
        },
      },
    );

    const approvalRead = await fetch(
      `${baseUrl}/v1/tool-approvals?workspaceId=dev-workspace&status=pending`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(approvalRead.status, 200);
    const approvalReadBody = await approvalRead.json();
    assert.equal(approvalReadBody.approvals.length, 1);
    assert.deepEqual(approvalReadBody.approvals[0].arguments, {
      owner: 'acme',
      repo: 'payments',
      title: 'Review exact arguments',
    });
    const crossWorkspaceApprovalRead = await fetch(
      `${baseUrl}/v1/tool-approvals?workspaceId=labs`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(crossWorkspaceApprovalRead.status, 403);
    const nativeToolAudit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&category=tool&action=claude.bash`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(nativeToolAudit.status, 200);
    const nativeToolAuditBody = await nativeToolAudit.json();
    assert.equal(nativeToolAuditBody.entries.length, 2);
    assert.deepEqual(
      nativeToolAuditBody.entries.map((entry) => entry.outcome).sort(),
      ['started', 'succeeded'],
    );
    assert.ok(
      nativeToolAuditBody.entries.every(
        (entry) =>
          entry.tool.source === 'provider-native' &&
          entry.tool.provider === 'claude' &&
          entry.tool.argumentKeys === undefined,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(nativeToolAuditBody),
      /arguments|resultPreview|private\/secret/iu,
    );
    const nativeToolAuditCsv = await fetch(
      `${baseUrl}/v1/audit.csv?workspaceId=dev-workspace&category=tool&action=claude.bash`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(nativeToolAuditCsv.status, 200);
    const nativeToolAuditCsvText = await nativeToolAuditCsv.text();
    assert.match(nativeToolAuditCsvText, /"toolSource","toolProvider"/u);
    assert.match(nativeToolAuditCsvText, /provider-native/u);
    assert.match(nativeToolAuditCsvText, /claude/u);
    assert.doesNotMatch(
      JSON.stringify(nativeToolAuditBody),
      /untrusted-native|token=leak/u,
    );

    const destinationAudit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&category=tool&destination=${encodeURIComponent('https://api.github.example')}`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(destinationAudit.status, 200);
    const destinationAuditBody = await destinationAudit.json();
    assert.equal(destinationAuditBody.entries.length, 1);
    assert.equal(
      destinationAuditBody.entries[0].destination,
      'https://api.github.example',
    );
    assert.equal(
      destinationAuditBody.entries[0].tool.destination,
      'https://api.github.example',
    );
    assert.doesNotMatch(
      JSON.stringify(destinationAuditBody),
      /repos\/acme|token=|must-not-leak/u,
    );
    const destinationCsv = await fetch(
      `${baseUrl}/v1/audit.csv?workspaceId=dev-workspace&destination=${encodeURIComponent('https://api.github.example')}`,
      { headers: { cookie: adminCookie } },
    );
    const destinationCsvText = await destinationCsv.text();
    assert.match(destinationCsvText, /"toolProvider","destination"/u);
    assert.match(destinationCsvText, /"https:\/\/api\.github\.example"/u);
    assert.doesNotMatch(destinationCsvText, /repos\/acme|token=|must-not-leak/u);
    const invalidDestinationAudit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&destination=api.github.example`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(invalidDestinationAudit.status, 400);
    assert.equal(
      (await invalidDestinationAudit.json()).error,
      'audit_destination_invalid',
    );

    const allowedWorkspace = await fetch(
      `${baseUrl}/v1/workspace?workspaceId=dev-workspace`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(allowedWorkspace.status, 200);
    const workspaceBeforeSpend = await allowedWorkspace.json();

    const spendRead = await fetch(
      `${baseUrl}/v1/spend?workspaceId=dev-workspace`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(spendRead.status, 200);
    assert.equal((await spendRead.json()).workspace.workspaceId, 'dev-workspace');

    const spendWrite = await fetch(`${baseUrl}/v1/spend/policies`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': adminSession.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        target: 'workspace',
        policy: { mode: 'custom', maxRunsPerMonth: 12 },
      }),
    });
    assert.equal(spendWrite.status, 200);
    assert.deepEqual((await spendWrite.json()).workspace.policy, {
      mode: 'custom',
      scope: 'workspace',
      maxRunsPerMonth: 12,
    });
    const organizationAudit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&category=policy&action=workspace.updated`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(organizationAudit.status, 200);
    const organizationAuditBody = await organizationAudit.json();
    assert.ok(organizationAuditBody.total >= 1);
    assert.ok(
      organizationAuditBody.entries.every(
        (entry) =>
          entry.workspaceId === 'dev-workspace' &&
          entry.category === 'policy' &&
          entry.actor === 'operator:dev-admin',
      ),
    );
    const auditCsv = await fetch(
      `${baseUrl}/v1/audit.csv?workspaceId=dev-workspace&category=policy`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(auditCsv.status, 200);
    assert.match(auditCsv.headers.get('content-type') || '', /text\/csv/u);
    const auditCsvText = await auditCsv.text();
    assert.match(auditCsvText, /workspace\.updated/u);
    assert.doesNotMatch(auditCsvText, /snapshot|providerSession|resultPreview/iu);
    const workspaceAfterSpend = await fetch(
      `${baseUrl}/v1/workspace?workspaceId=dev-workspace`,
      { headers: { cookie: adminCookie } },
    ).then((response) => response.json());
    assert.equal(
      workspaceAfterSpend.workspace.identity.instructions,
      workspaceBeforeSpend.workspace.identity.instructions,
    );

    const forbiddenWorkspace = await fetch(
      `${baseUrl}/v1/workspace?workspaceId=labs`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(forbiddenWorkspace.status, 403);
    assert.equal(
      (await forbiddenWorkspace.json()).error,
      'operator_workspace_forbidden',
    );
    const forbiddenAudit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=labs`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(forbiddenAudit.status, 403);
    assert.equal(
      (await forbiddenAudit.json()).error,
      'operator_workspace_forbidden',
    );
    const forbiddenMemoryAnalysis = await fetch(
      `${baseUrl}/v1/memory-analysis?workspaceId=labs&projectId=opentag`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(forbiddenMemoryAnalysis.status, 403);
    assert.equal(
      (await forbiddenMemoryAnalysis.json()).error,
      'operator_workspace_forbidden',
    );

    const scopedDelivery = await fetch(`${baseUrl}/v1/deliveries?limit=5`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(scopedDelivery.status, 200);
    assert.equal((await scopedDelivery.json()).workspaceId, 'dev-workspace');

    const projectWrite = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': adminSession.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'principal-audit',
        name: 'Principal audit',
        actor: 'spoofed-client-actor',
      }),
    });
    assert.equal(projectWrite.status, 200);

    const auditResponse = await fetch(
      `${baseUrl}/v1/config/audit?workspaceId=dev-workspace&limit=20`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.equal(
      audit.audit.find((record) => record.projectId === 'principal-audit').actor,
      'operator:dev-admin',
    );

    const installationControl = await fetch(`${baseUrl}/v1/routines/tick`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'x-opentag-csrf': adminSession.csrfToken,
      },
    });
    assert.equal(installationControl.status, 403);
    assert.equal(
      (await installationControl.json()).error,
      'installation_operator_required',
    );

    const globalMemory = await fetch(
      `${baseUrl}/v1/memory?scope=global&workspaceId=dev-workspace&projectId=opentag`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(globalMemory.status, 403);
    assert.equal(
      (await globalMemory.json()).error,
      'installation_operator_required',
    );

    const globalMemoryExport = await fetch(
      `${baseUrl}/v1/memory-export?scope=global`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(globalMemoryExport.status, 403);
    assert.equal(
      (await globalMemoryExport.json()).error,
      'installation_operator_required',
    );

    const globalMemoryDiff = await fetch(
      `${baseUrl}/v1/memory-diff?scope=global&revisionId=rev_global`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(globalMemoryDiff.status, 403);
    assert.equal(
      (await globalMemoryDiff.json()).error,
      'installation_operator_required',
    );

    const globalMemoryCompact = await fetch(`${baseUrl}/v1/memory-compact`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': adminSession.csrfToken,
      },
      body: JSON.stringify({ scope: ['global'], apply: true }),
    });
    assert.equal(globalMemoryCompact.status, 403);
    assert.equal(
      (await globalMemoryCompact.json()).error,
      'installation_operator_required',
    );

    const globalMemoryProposal = await fetch(`${baseUrl}/v1/memory-proposals`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': adminSession.csrfToken,
      },
      body: JSON.stringify({
        scope: 'global',
        action: 'remember',
        text: 'global proposal should be installation scoped',
      }),
    });
    assert.equal(globalMemoryProposal.status, 403);
    assert.equal(
      (await globalMemoryProposal.json()).error,
      'installation_operator_required',
    );

    const globalMemoryPreviewWrite = await fetch(`${baseUrl}/v1/dev/messages`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': adminSession.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        text: 'remember global cannot bypass operator scope',
      }),
    });
    assert.equal(globalMemoryPreviewWrite.status, 403);
    assert.equal(
      (await globalMemoryPreviewWrite.json()).error,
      'installation_operator_required',
    );

    const memoryRoute = {
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      externalId: 'oc_retention:root',
      channelId: 'oc_retention',
      threadId: 'lark:oc_retention:root',
      platform: 'lark',
      scope: 'project',
    };
    const timedMemoryWrite = await fetch(`${baseUrl}/v1/memory`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': adminSession.csrfToken,
      },
      body: JSON.stringify({
        ...memoryRoute,
        action: 'remember',
        text: 'Temporary principal API fact.',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    });
    assert.equal(timedMemoryWrite.status, 200);
    const memoryQuery = new URLSearchParams(memoryRoute);
    const timedMemoryRead = await fetch(
      `${baseUrl}/v1/memory?${memoryQuery.toString()}`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(timedMemoryRead.status, 200);
    const timedMemory = await timedMemoryRead.json();
    assert.doesNotMatch(timedMemory.snapshot.text, /Temporary principal/u);
    assert.match(timedMemory.history.document.content, /Temporary principal/u);
    assert.equal(timedMemory.snapshot.scopes[0].expiredLines, 1);
    assert.equal(timedMemory.expiry.entries.length, 1);
    assert.equal(timedMemory.expiry.audit[0].actorId, 'operator:dev-admin');

    const viewerLogin = await fetch(`${baseUrl}/v1/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: viewerToken }),
    });
    assert.equal(viewerLogin.status, 200);
    const viewerSession = await viewerLogin.json();
    const viewerCookie = viewerLogin.headers.get('set-cookie')?.split(';', 1)[0];
    assert.equal(viewerSession.principal.role, 'viewer');

    const viewerApprovalRead = await fetch(
      `${baseUrl}/v1/tool-approvals?workspaceId=dev-workspace`,
      { headers: { cookie: viewerCookie } },
    );
    assert.equal(viewerApprovalRead.status, 200);
    const viewerApprovalDecision = await fetch(
      `${baseUrl}/v1/tool-approvals/${toolApproval.id}/reject`,
      {
        method: 'POST',
        headers: {
          cookie: viewerCookie,
          'x-opentag-csrf': viewerSession.csrfToken,
        },
      },
    );
    assert.equal(viewerApprovalDecision.status, 403);
    assert.equal(
      (await viewerApprovalDecision.json()).error,
      'operator_write_required',
    );

    const rejectedApproval = await fetch(
      `${baseUrl}/v1/tool-approvals/${toolApproval.id}/reject`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'x-opentag-csrf': adminSession.csrfToken,
        },
      },
    );
    assert.equal(rejectedApproval.status, 200);
    assert.equal((await rejectedApproval.json()).approval.status, 'rejected');
    const repeatedRejection = await fetch(
      `${baseUrl}/v1/tool-approvals/${toolApproval.id}/reject`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'x-opentag-csrf': adminSession.csrfToken,
        },
      },
    );
    assert.equal(repeatedRejection.status, 200);
    assert.equal((await repeatedRejection.json()).executed, false);
    const conflictingApproval = await fetch(
      `${baseUrl}/v1/tool-approvals/${toolApproval.id}/approve`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'x-opentag-csrf': adminSession.csrfToken,
        },
      },
    );
    assert.equal(conflictingApproval.status, 409);

    const viewerRead = await fetch(
      `${baseUrl}/v1/access?workspaceId=dev-workspace`,
      { headers: { cookie: viewerCookie } },
    );
    assert.equal(viewerRead.status, 200);

    const viewerSpendRead = await fetch(
      `${baseUrl}/v1/spend?workspaceId=dev-workspace`,
      { headers: { cookie: viewerCookie } },
    );
    assert.equal(viewerSpendRead.status, 200);
    const viewerAuditRead = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&limit=10`,
      { headers: { cookie: viewerCookie } },
    );
    assert.equal(viewerAuditRead.status, 200);
    const viewerMemoryAnalysisRead = await fetch(
      `${baseUrl}/v1/memory-analysis?workspaceId=dev-workspace&projectId=opentag`,
      { headers: { cookie: viewerCookie } },
    );
    assert.equal(viewerMemoryAnalysisRead.status, 200);
    const viewerMemoryAnalysis = await viewerMemoryAnalysisRead.json();
    assert.equal(typeof viewerMemoryAnalysis.retrieval.indexedFacts, 'number');
    assert.equal(typeof viewerMemoryAnalysis.retrieval.indexedAliases, 'number');
    const viewerMemoryRead = await fetch(
      `${baseUrl}/v1/memory?${memoryQuery.toString()}`,
      { headers: { cookie: viewerCookie } },
    );
    assert.equal(viewerMemoryRead.status, 200);
    assert.equal((await viewerMemoryRead.json()).expiry.entries.length, 1);
    const viewerExpiryWrite = await fetch(`${baseUrl}/v1/memory-expiry`, {
      method: 'POST',
      headers: {
        cookie: viewerCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': viewerSession.csrfToken,
      },
      body: JSON.stringify({
        ...memoryRoute,
        selector: 'Temporary principal',
      }),
    });
    assert.equal(viewerExpiryWrite.status, 403);
    assert.equal(
      (await viewerExpiryWrite.json()).error,
      'operator_write_required',
    );

    const clearExpiry = await fetch(`${baseUrl}/v1/memory-expiry`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': adminSession.csrfToken,
      },
      body: JSON.stringify({
        ...memoryRoute,
        selector: 'Temporary principal',
      }),
    });
    assert.equal(clearExpiry.status, 200);
    const clearedExpiry = await clearExpiry.json();
    assert.equal(clearedExpiry.expiry.entries.length, 0);
    assert.deepEqual(
      clearedExpiry.expiry.audit.map((record) => record.action),
      ['clear', 'set'],
    );

    const viewerSpendWrite = await fetch(`${baseUrl}/v1/spend/policies`, {
      method: 'POST',
      headers: {
        cookie: viewerCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': viewerSession.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        target: 'workspace',
        policy: { mode: 'disabled' },
      }),
    });
    assert.equal(viewerSpendWrite.status, 403);
    assert.equal(
      (await viewerSpendWrite.json()).error,
      'operator_write_required',
    );

    const viewerWrite = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        cookie: viewerCookie,
        'content-type': 'application/json',
        'x-opentag-csrf': viewerSession.csrfToken,
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'viewer-write',
      }),
    });
    assert.equal(viewerWrite.status, 403);
    assert.equal((await viewerWrite.json()).error, 'operator_write_required');

    const viewerBearerWrite = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${viewerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'viewer-bearer-write',
      }),
    });
    assert.equal(viewerBearerWrite.status, 403);
    assert.equal(
      (await viewerBearerWrite.json()).error,
      'operator_write_required',
    );
  },
);
