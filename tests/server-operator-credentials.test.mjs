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

async function startServer(dataDir, ownerToken) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENTAG_PORT: String(port),
      OPENTAG_HOST: '127.0.0.1',
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_ADMIN_TOKEN: ownerToken,
      OPENTAG_ADMIN_COOKIE_SECURE: 'false',
      OPENTAG_CLIENT_INGRESS_TOKEN: '',
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_LARK_EVENT_MODE: 'long-connection',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return { child, baseUrl, logs };
    } catch {
      // The listener can refuse connections briefly during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`server startup timed out\n${logs.join('')}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function postJson(url, token, body) {
  return fetch(url, {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test(
  'persistent operator credentials rotate and revoke tokens plus browser sessions across restarts',
  { timeout: 30_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opentag-server-operator-credentials-'),
    );
    context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const ownerToken = 'operator-bootstrap-owner-token-123456789';
    let running = await startServer(dataDir, ownerToken);
    context.after(() => stopServer(running.child));

    const create = await postJson(
      `${running.baseUrl}/v1/operator-credentials`,
      ownerToken,
      {
        id: 'workspace-admin',
        displayName: 'Workspace admin',
        role: 'admin',
        workspaceIds: ['dev-workspace'],
      },
    );
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.match(created.token, /^otk_/u);
    assert.equal(created.credential.revision, 1);
    const firstToken = created.token;

    const list = await fetch(`${running.baseUrl}/v1/operator-credentials`, {
      headers: bearer(ownerToken),
    });
    assert.equal(list.status, 200);
    const listedText = await list.text();
    assert.equal(listedText.includes(firstToken), false);
    assert.equal(listedText.includes('tokenHash'), false);
    assert.equal(JSON.parse(listedText).credentials[0].tokenPrefix, firstToken.slice(0, 12));

    const adminDenied = await fetch(
      `${running.baseUrl}/v1/operator-credentials`,
      { headers: bearer(firstToken) },
    );
    assert.equal(adminDenied.status, 403);
    assert.equal((await adminDenied.json()).error, 'installation_owner_required');

    const login = await fetch(`${running.baseUrl}/v1/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: firstToken }),
    });
    assert.equal(login.status, 200);
    const firstSession = await login.json();
    const firstCookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(firstCookie);
    assert.equal(firstSession.principal.id, 'workspace-admin');

    const scopedWorkspace = await fetch(
      `${running.baseUrl}/v1/workspace?workspaceId=dev-workspace`,
      { headers: bearer(firstToken) },
    );
    assert.equal(scopedWorkspace.status, 200);
    const otherWorkspace = await fetch(
      `${running.baseUrl}/v1/workspace?workspaceId=other-workspace`,
      { headers: bearer(firstToken) },
    );
    assert.equal(otherWorkspace.status, 403);

    const rotate = await postJson(
      `${running.baseUrl}/v1/operator-credentials/workspace-admin/rotate`,
      ownerToken,
      { expectedRevision: 1 },
    );
    assert.equal(rotate.status, 200);
    const rotated = await rotate.json();
    const secondToken = rotated.token;
    assert.equal(rotated.credential.revision, 2);
    assert.notEqual(secondToken, firstToken);

    assert.equal(
      (
        await fetch(`${running.baseUrl}/v1/workspace`, {
          headers: bearer(firstToken),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${running.baseUrl}/v1/workspace`, {
          headers: { cookie: firstCookie },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${running.baseUrl}/v1/workspace`, {
          headers: bearer(secondToken),
        })
      ).status,
      200,
    );

    await stopServer(running.child);
    running = await startServer(dataDir, ownerToken);
    assert.equal(
      (
        await fetch(`${running.baseUrl}/v1/workspace`, {
          headers: bearer(secondToken),
        })
      ).status,
      200,
    );

    const secondLogin = await fetch(`${running.baseUrl}/v1/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: secondToken }),
    });
    const secondSession = await secondLogin.json();
    const secondCookie = secondLogin.headers.get('set-cookie')?.split(';', 1)[0];
    assert.equal(secondLogin.status, 200);
    assert.ok(secondCookie);

    const revoke = await postJson(
      `${running.baseUrl}/v1/operator-credentials/workspace-admin/revoke`,
      ownerToken,
      { expectedRevision: 2 },
    );
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).credential.status, 'revoked');
    assert.equal(
      (
        await fetch(`${running.baseUrl}/v1/workspace`, {
          headers: bearer(secondToken),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${running.baseUrl}/v1/workspace`, {
          headers: {
            cookie: secondCookie,
            'x-opentag-csrf': secondSession.csrfToken,
          },
        })
      ).status,
      401,
    );

    const audit = await fetch(
      `${running.baseUrl}/v1/audit?workspaceId=dev-workspace&category=access`,
      { headers: bearer(ownerToken) },
    );
    assert.equal(audit.status, 200);
    const actions = (await audit.json()).entries.map((entry) => entry.action);
    assert.ok(actions.includes('operator_credential.created'));
    assert.ok(actions.includes('operator_credential.rotated'));
    assert.ok(actions.includes('operator_credential.revoked'));

    const stored = await fs.readFile(
      path.join(dataDir, 'config', 'operator-credentials.json'),
      'utf8',
    );
    assert.equal(stored.includes(firstToken), false);
    assert.equal(stored.includes(secondToken), false);
  },
);

test(
  'an open loopback install bootstraps exactly one persistent installation owner without locking itself out',
  { timeout: 20_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opentag-server-operator-bootstrap-'),
    );
    context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const running = await startServer(dataDir, '');
    context.after(() => stopServer(running.child));

    const invalidFirst = await fetch(
      `${running.baseUrl}/v1/operator-credentials`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'first-admin',
          displayName: 'First admin',
          role: 'admin',
          workspaceIds: ['dev-workspace'],
        }),
      },
    );
    assert.equal(invalidFirst.status, 409);
    assert.equal(
      (await invalidFirst.json()).error,
      'operator_credential_first_owner_required',
    );

    const createOwner = await fetch(
      `${running.baseUrl}/v1/operator-credentials`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'installation-owner-1',
          displayName: 'Installation owner',
          role: 'owner',
          workspaceIds: ['*'],
        }),
      },
    );
    assert.equal(createOwner.status, 201);
    const created = await createOwner.json();
    const cookie = createOwner.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    assert.equal(created.session.principal.id, 'installation-owner-1');

    assert.equal((await fetch(`${running.baseUrl}/v1/workspace`)).status, 401);
    assert.equal(
      (
        await fetch(`${running.baseUrl}/v1/workspace`, {
          headers: { cookie },
        })
      ).status,
      200,
    );

    const revokeLastOwner = await fetch(
      `${running.baseUrl}/v1/operator-credentials/installation-owner-1/revoke`,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-opentag-csrf': created.session.csrfToken,
        },
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    );
    assert.equal(revokeLastOwner.status, 409);
    assert.equal(
      (await revokeLastOwner.json()).error,
      'operator_credential_last_owner_required',
    );
  },
);
