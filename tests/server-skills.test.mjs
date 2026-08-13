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
      if (response.ok) return;
    } catch {
      // Server startup briefly refuses connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy\n${logs.join('')}`);
}

async function launchServer(context) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-server-skills-'));
  const port = await freePort();
  const logs = [];
  const installationToken = 'skills-installation-token-123456789';
  const workspaceToken = 'skills-workspace-token-123456789';
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENTAG_PORT: String(port),
      OPENTAG_HOST: '127.0.0.1',
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_ADMIN_TOKEN: installationToken,
      OPENTAG_OPERATOR_PRINCIPALS_JSON: JSON.stringify([
        {
          id: 'workspace-admin',
          displayName: 'Workspace admin',
          role: 'admin',
          workspaceIds: ['dev-workspace'],
          token: workspaceToken,
        },
      ]),
      OPENTAG_CLIENT_INGRESS_TOKEN: '',
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_LARK_EVENT_MODE: 'webhook',
      OPENTAG_LARK_VERIFICATION_TOKEN: 'skills-lark-verification-token',
      OPENTAG_LARK_CALLBACK_MAX_SKEW_SECONDS: '0',
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
  await waitForHealth(baseUrl, child, logs);
  return { baseUrl, installationToken, workspaceToken };
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

async function postJson(url, token, body) {
  return fetch(url, {
    method: 'POST',
    headers: { ...authorization(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test(
  'Skills API separates installation catalog management from workspace assignment',
  { timeout: 20_000 },
  async (context) => {
    const { baseUrl, installationToken, workspaceToken } = await launchServer(context);

    const emptyCatalog = await fetch(
      `${baseUrl}/v1/skills?workspaceId=dev-workspace`,
      { headers: authorization(workspaceToken) },
    ).then((response) => response.json());
    assert.equal(emptyCatalog.canManageCatalog, false);
    assert.deepEqual(emptyCatalog.skills, []);
    assert.equal('audit' in emptyCatalog, false);

    const deniedCreate = await postJson(
      `${baseUrl}/v1/skills`,
      workspaceToken,
      {
        id: 'release-proof',
        name: 'Release proof',
        description: 'Collect deployment evidence.',
        content: 'Verify build, rollout, and smoke evidence.',
      },
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal((await deniedCreate.json()).error, 'installation_operator_required');

    const createdResponse = await postJson(
      `${baseUrl}/v1/skills`,
      installationToken,
      {
        workspaceId: 'dev-workspace',
        id: 'release-proof',
        name: 'Release proof',
        description: 'Collect build, rollout, and smoke evidence.',
        content: '# Release proof\n\nVerify build, rollout, and smoke independently.',
        expectedRevision: 0,
      },
    );
    assert.equal(createdResponse.status, 200);
    const created = (await createdResponse.json()).skill;
    assert.equal(created.revision, 1);
    assert.match(created.content, /Verify build/u);

    const scopedCatalogResponse = await fetch(
      `${baseUrl}/v1/skills?workspaceId=dev-workspace`,
      { headers: authorization(workspaceToken) },
    );
    assert.equal(scopedCatalogResponse.status, 200);
    const scopedCatalog = await scopedCatalogResponse.json();
    assert.equal(scopedCatalog.canManageCatalog, false);
    assert.equal(scopedCatalog.skills[0].id, 'release-proof');
    assert.equal('content' in scopedCatalog.skills[0], false);
    assert.equal('createdAt' in scopedCatalog.skills[0], false);
    assert.equal(JSON.stringify(scopedCatalog).includes('Verify build'), false);

    const deniedDetail = await fetch(`${baseUrl}/v1/skills/release-proof`, {
      headers: authorization(workspaceToken),
    });
    assert.equal(deniedDetail.status, 403);
    assert.equal((await deniedDetail.json()).error, 'installation_operator_required');
    const detail = await fetch(`${baseUrl}/v1/skills/release-proof`, {
      headers: authorization(installationToken),
    }).then((response) => response.json());
    assert.match(detail.skill.content, /smoke independently/u);

    const assigned = await postJson(`${baseUrl}/v1/workspace`, workspaceToken, {
      workspaceId: 'dev-workspace',
      skillIds: ['release-proof'],
    });
    assert.equal(assigned.status, 200);
    assert.deepEqual((await assigned.json()).workspace.skillIds, ['release-proof']);

    const disabled = await postJson(
      `${baseUrl}/v1/skills/release-proof/disable`,
      installationToken,
      { workspaceId: 'dev-workspace', expectedRevision: 1 },
    );
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).skill.enabled, false);

    const preserved = await postJson(`${baseUrl}/v1/workspace`, workspaceToken, {
      workspaceId: 'dev-workspace',
      skillIds: ['release-proof'],
    });
    assert.equal(preserved.status, 200);
    const removed = await postJson(`${baseUrl}/v1/workspace`, workspaceToken, {
      workspaceId: 'dev-workspace',
      skillIds: [],
    });
    assert.equal(removed.status, 200);
    const rejectedReassignment = await postJson(
      `${baseUrl}/v1/workspace`,
      workspaceToken,
      { workspaceId: 'dev-workspace', skillIds: ['release-proof'] },
    );
    assert.equal(rejectedReassignment.status, 400);
    assert.equal(
      (await rejectedReassignment.json()).error,
      'agent_skill_not_enabled:release-proof',
    );

    const installationCatalog = await fetch(
      `${baseUrl}/v1/skills?workspaceId=dev-workspace`,
      { headers: authorization(installationToken) },
    ).then((response) => response.json());
    assert.equal(installationCatalog.canManageCatalog, true);
    assert.deepEqual(
      installationCatalog.audit.map((record) => record.action),
      ['skill.disabled', 'skill.created'],
    );
    assert.equal(JSON.stringify(installationCatalog).includes('smoke independently'), false);
  },
);
