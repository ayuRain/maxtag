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

async function startServer(dataDir, ownerToken, commandDir) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${commandDir}:${process.env.PATH}`,
      OPENTAG_PORT: String(port),
      OPENTAG_HOST: '127.0.0.1',
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_ADMIN_TOKEN: ownerToken,
      OPENTAG_ADMIN_COOKIE_SECURE: 'false',
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_LARK_TRANSPORT: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited\n${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return { child, baseUrl, logs };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

test('installation owner enables an authenticated local CLI executor and restart activates it', { timeout: 30_000 }, async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-executor-api-'));
  const commandDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-executor-bin-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  context.after(() => fs.rm(commandDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(commandDir, 'codex'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi\nif [ "$1" = "doctor" ]; then echo '{"checks":{"auth.credentials":{"status":"ok"}}}'; exit 0; fi\nexit 2\n`,
    { mode: 0o755 },
  );

  const ownerToken = 'managed-executor-owner-token-that-is-long-enough';
  let running = await startServer(dataDir, ownerToken, commandDir);
  context.after(() => stopServer(running.child));
  const auth = { authorization: `Bearer ${ownerToken}` };

  const before = await fetch(`${running.baseUrl}/v1/config/executor`, { headers: auth });
  assert.equal(before.status, 200);
  const initial = await before.json();
  assert.equal(initial.config.configured, false);
  assert.equal(initial.installations.codex.installed, true);
  assert.match(initial.installations.codex.version, /9\.9\.9/u);

  const save = await fetch(`${running.baseUrl}/v1/config/executor`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'codex',
      authMode: 'cli',
      model: 'gpt-5.5',
      expectedRevision: 0,
    }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.config.configured, true);
  assert.equal(saved.config.provider, 'codex');
  assert.equal(saved.config.authMode, 'cli');
  assert.equal(saved.reloadPending, true);

  await stopServer(running.child);
  running = await startServer(dataDir, ownerToken, commandDir);
  const active = await fetch(`${running.baseUrl}/v1/config/executor`, { headers: auth });
  assert.equal(active.status, 200);
  const payload = await active.json();
  assert.equal(payload.active.mode, 'local-cli');
  assert.equal(payload.active.defaultExecutorId, 'codex');
  assert.deepEqual(payload.active.executors.map((item) => item.id), ['codex']);
  assert.equal(payload.active.executors[0].status, 'ready');

  const denied = await fetch(`${running.baseUrl}/v1/config/executor`);
  assert.equal(denied.status, 401);
});
