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
