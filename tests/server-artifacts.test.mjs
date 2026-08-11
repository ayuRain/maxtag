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
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Startup can briefly refuse connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server health timeout\n${logs.join('')}`);
}

async function waitForArtifact(baseUrl, runId, adminToken) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events?limit=100`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    const detail = await response.json();
    if (detail.run?.status === 'completed' && detail.artifacts?.length) return detail;
    if (detail.run?.status === 'failed') {
      throw new Error(detail.run.lastError || 'artifact run failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('artifact run timeout');
}

test(
  'server persists CLI artifacts and serves integrity-checked operator downloads',
  { timeout: 20_000 },
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-server-artifact-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    const projectDir = path.join(workspaceRoot, 'opentag');
    const fakeCli = path.join(root, 'fake-codex.mjs');
    const adminToken = 'artifact-admin-token-123456';
    const ingressToken = 'artifact-ingress-token-123456';
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      fakeCli,
      `#!/usr/bin/env node
import fs from 'node:fs/promises';
for await (const _chunk of process.stdin) {}
await fs.writeFile('result.txt', 'durable artifact\\n');
const text = ['Finished artifact run.', 'OPENTAG_ARTIFACT: {"path":"result.txt","title":"Durable result","kind":"report"}'].join('\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'server-artifact-session' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
      { mode: 0o700 },
    );

    const port = await freePort();
    const logs = [];
    const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_ADMIN_TOKEN: adminToken,
        OPENTAG_CLIENT_INGRESS_TOKEN: ingressToken,
        OPENTAG_EXECUTOR_MODE: 'local-cli',
        OPENTAG_EXECUTOR_WORKSPACE_ROOT: workspaceRoot,
        OPENTAG_CODEX_COMMAND: fakeCli,
        OPENTAG_AGENT_WORKER: 'inline',
        OPENTAG_ROUTINES_ENABLED: 'false',
        OPENTAG_WORKFLOWS_ENABLED: 'false',
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
      await fs.rm(root, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child, logs);
    const accepted = await fetch(`${baseUrl}/v1/client/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingressToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        platform: 'custom-chat',
        eventId: 'artifact-event-1',
        thread: {
          externalId: 'artifact-room',
          channelId: 'artifact-room',
          workspaceId: 'dev-workspace',
          projectId: 'opentag',
          visibility: 'public',
        },
        message: {
          id: 'artifact-message-1',
          text: '/opentag create a report',
          actor: { id: 'artifact-user' },
          mentionsAgent: true,
        },
      }),
    });
    assert.equal(accepted.status, 202);
    const queued = await accepted.json();
    const detail = await waitForArtifact(baseUrl, queued.run.id, adminToken);

    assert.equal(detail.run.summary, 'Finished artifact run.');
    assert.equal(detail.artifacts.length, 1);
    assert.equal(detail.artifacts[0].title, 'Durable result');
    assert.equal(detail.artifacts[0].path, undefined);
    assert.match(detail.artifacts[0].downloadUrl, /\/artifacts\//u);
    assert.ok(detail.events.some((event) => event.type === 'artifact'));

    const anonymous = await fetch(`${baseUrl}${detail.artifacts[0].downloadUrl}`);
    assert.equal(anonymous.status, 401);
    const download = await fetch(`${baseUrl}${detail.artifacts[0].downloadUrl}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'durable artifact\n');
    assert.match(download.headers.get('content-disposition') || '', /filename\*/u);

    const artifactEvent = detail.events.find((event) => event.type === 'artifact');
    await fs.writeFile(artifactEvent.metadata.artifact.path, 'tampered');
    const tampered = await fetch(`${baseUrl}${detail.artifacts[0].downloadUrl}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(tampered.status, 404);
  },
);
