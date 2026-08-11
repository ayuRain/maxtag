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

async function launchServer(context, prefix, environment) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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
    health: await waitForHealth(`${baseUrl}/health`, child, logs),
  };
}

test(
  'server protects operator APIs while leaving verified client callbacks independent',
  { timeout: 20_000 },
  async (context) => {
    const adminToken = 'integration-operator-token-123456789';
    const { baseUrl, health } = await launchServer(
      context,
      'opentag-auth-api-',
      {
        OPENTAG_ADMIN_TOKEN: adminToken,
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
      body: JSON.stringify({ challenge: 'lark-auth-boundary' }),
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
      }),
    });
    assert.equal(sessionWrite.status, 200);

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
    const { baseUrl, health } = await launchServer(
      context,
      'opentag-client-auth-',
      {
        OPENTAG_ADMIN_TOKEN: 'integration-operator-token-987654321',
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
        text: '/opentag summarize this project',
        actor: { id: 'custom-user', displayName: 'Custom user' },
        mentionsAgent: true,
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
    const { baseUrl, health } = await launchServer(
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

    const allowedWorkspace = await fetch(
      `${baseUrl}/v1/workspace?workspaceId=dev-workspace`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(allowedWorkspace.status, 200);

    const forbiddenWorkspace = await fetch(
      `${baseUrl}/v1/workspace?workspaceId=labs`,
      { headers: { cookie: adminCookie } },
    );
    assert.equal(forbiddenWorkspace.status, 403);
    assert.equal(
      (await forbiddenWorkspace.json()).error,
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

    const viewerLogin = await fetch(`${baseUrl}/v1/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: viewerToken }),
    });
    assert.equal(viewerLogin.status, 200);
    const viewerSession = await viewerLogin.json();
    const viewerCookie = viewerLogin.headers.get('set-cookie')?.split(';', 1)[0];
    assert.equal(viewerSession.principal.role, 'viewer');

    const viewerRead = await fetch(
      `${baseUrl}/v1/access?workspaceId=dev-workspace`,
      { headers: { cookie: viewerCookie } },
    );
    assert.equal(viewerRead.status, 200);

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
