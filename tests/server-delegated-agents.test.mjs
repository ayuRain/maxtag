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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-server-agents-'));
  const port = await freePort();
  const logs = [];
  const installationToken = 'agents-installation-token-123456789';
  const workspaceToken = 'agents-workspace-token-123456789';
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
      OPENTAG_LARK_VERIFICATION_TOKEN: 'agents-lark-verification-token',
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
  'Agents API separates installation definitions from route assignment',
  { timeout: 20_000 },
  async (context) => {
    const { baseUrl, installationToken, workspaceToken } = await launchServer(context);

    const emptyCatalog = await fetch(
      `${baseUrl}/v1/agents?workspaceId=dev-workspace`,
      { headers: authorization(workspaceToken) },
    ).then((response) => response.json());
    assert.equal(emptyCatalog.canManageCatalog, false);
    assert.deepEqual(emptyCatalog.agents, []);
    assert.equal('audit' in emptyCatalog, false);

    const deniedCreate = await postJson(`${baseUrl}/v1/agents`, workspaceToken, {
      id: 'evidence-reviewer',
      name: 'Evidence reviewer',
      description: 'Review route evidence.',
      instructions: 'Verify the evidence and report gaps.',
      executorId: 'codex',
    });
    assert.equal(deniedCreate.status, 403);
    assert.equal((await deniedCreate.json()).error, 'installation_operator_required');

    const skillResponse = await postJson(
      `${baseUrl}/v1/skills`,
      installationToken,
      {
        id: 'release-proof',
        name: 'Release proof',
        description: 'Verify release evidence.',
        content: 'Separate build, rollout, smoke, and receipt evidence.',
        expectedRevision: 0,
      },
    );
    assert.equal(skillResponse.status, 200);

    const createdResponse = await postJson(
      `${baseUrl}/v1/agents`,
      installationToken,
      {
        workspaceId: 'dev-workspace',
        id: 'evidence-reviewer',
        name: 'Evidence reviewer',
        description: 'Review bounded route evidence.',
        instructions: 'Return the strongest verified result and remaining gaps.',
        executorId: 'codex',
        model: 'gpt-5.6-luna',
        skillIds: ['release-proof'],
        grantKinds: ['shell', 'browser'],
        memoryScopes: ['project', 'thread'],
        networkHosts: ['docs.example.com'],
        maxTurns: 6,
        timeoutMs: 60_000,
        expectedRevision: 0,
      },
    );
    assert.equal(createdResponse.status, 200);
    const created = (await createdResponse.json()).agent;
    assert.equal(created.revision, 1);
    assert.equal(created.model, 'gpt-5.6-luna');

    const agentAudit = await fetch(
      `${baseUrl}/v1/audit?workspaceId=dev-workspace&category=agent`,
      { headers: authorization(installationToken) },
    ).then((response) => response.json());
    assert.equal(agentAudit.filters.category, 'agent');
    assert.equal(agentAudit.entries[0].action, 'agent.created');
    assert.equal(agentAudit.entries[0].referenceId, 'evidence-reviewer');

    const scopedCatalog = await fetch(
      `${baseUrl}/v1/agents?workspaceId=dev-workspace`,
      { headers: authorization(workspaceToken) },
    ).then((response) => response.json());
    assert.equal(scopedCatalog.canManageCatalog, false);
    assert.equal(scopedCatalog.agents[0].id, 'evidence-reviewer');
    for (const hidden of [
      'instructions',
      'model',
      'skillIds',
      'grantKinds',
      'memoryScopes',
      'networkHosts',
      'createdAt',
    ]) {
      assert.equal(hidden in scopedCatalog.agents[0], false);
    }
    assert.equal(JSON.stringify(scopedCatalog).includes('strongest verified'), false);

    const deniedDetail = await fetch(`${baseUrl}/v1/agents/evidence-reviewer`, {
      headers: authorization(workspaceToken),
    });
    assert.equal(deniedDetail.status, 403);
    const detail = await fetch(`${baseUrl}/v1/agents/evidence-reviewer`, {
      headers: authorization(installationToken),
    }).then((response) => response.json());
    assert.equal(detail.agent.model, 'gpt-5.6-luna');
    assert.deepEqual(detail.agent.grantKinds, ['shell', 'browser']);

    const assigned = await postJson(`${baseUrl}/v1/workspace`, workspaceToken, {
      workspaceId: 'dev-workspace',
      agentIds: ['evidence-reviewer'],
    });
    assert.equal(assigned.status, 200);
    assert.deepEqual((await assigned.json()).workspace.agentIds, [
      'evidence-reviewer',
    ]);

    const disabled = await postJson(
      `${baseUrl}/v1/agents/evidence-reviewer/disable`,
      installationToken,
      { workspaceId: 'dev-workspace', expectedRevision: 1 },
    );
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).agent.enabled, false);

    const preserved = await postJson(`${baseUrl}/v1/workspace`, workspaceToken, {
      workspaceId: 'dev-workspace',
      agentIds: ['evidence-reviewer'],
    });
    assert.equal(preserved.status, 200);
    const removed = await postJson(`${baseUrl}/v1/workspace`, workspaceToken, {
      workspaceId: 'dev-workspace',
      agentIds: [],
    });
    assert.equal(removed.status, 200);
    const rejectedReassignment = await postJson(
      `${baseUrl}/v1/workspace`,
      workspaceToken,
      { workspaceId: 'dev-workspace', agentIds: ['evidence-reviewer'] },
    );
    assert.equal(rejectedReassignment.status, 400);
    assert.equal(
      (await rejectedReassignment.json()).error,
      'delegated_agent_not_enabled:evidence-reviewer',
    );

    const installationCatalog = await fetch(
      `${baseUrl}/v1/agents?workspaceId=dev-workspace`,
      { headers: authorization(installationToken) },
    ).then((response) => response.json());
    assert.equal(installationCatalog.canManageCatalog, true);
    assert.deepEqual(
      installationCatalog.audit.map((record) => record.action),
      ['agent.disabled', 'agent.created'],
    );
    assert.equal(
      JSON.stringify(installationCatalog).includes('strongest verified'),
      false,
    );
  },
);
