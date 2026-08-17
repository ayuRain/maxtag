import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import {
  createHttpProjectRunner,
  startProjectRunnerServer,
} from '@opentag/project-runner';

test('project runner executes only allowlisted commands in an isolated project directory', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-project-runner-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = startProjectRunnerServer({
    workspaceRoot: root,
    token: 'test-token-with-enough-entropy',
    allowedCommands: ['node'],
    host: '127.0.0.1',
    port: 0,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const runner = createHttpProjectRunner({
    baseUrl,
    token: 'test-token-with-enough-entropy',
  });
  const result = await runner.execute({
    projectKey: 'project-a',
    command: 'node',
    args: ['-e', 'console.log(process.cwd()); console.error("diagnostic")'],
    timeoutMs: 5_000,
    maxOutputBytes: 16_384,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, '.');
  assert.match(result.stdout, /project-a/u);
  assert.match(result.stderr, /diagnostic/u);
  assert.match(result.requestId, /^[a-f0-9-]{36}$/u);
  assert.equal((await fs.stat(path.join(root, 'project-a'))).isDirectory(), true);

  await assert.rejects(
    runner.execute({
      projectKey: 'project-a',
      command: 'sh',
      args: ['-c', 'echo unsafe'],
      timeoutMs: 5_000,
      maxOutputBytes: 16_384,
    }),
    /project_runner_command_not_allowed/u,
  );
});

test('project runner rejects unauthenticated and traversal requests', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-project-runner-auth-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = startProjectRunnerServer({
    workspaceRoot: root,
    token: 'correct-token',
    allowedCommands: ['node'],
    host: '127.0.0.1',
    port: 0,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}/v1/execute`;
  const unauthorized = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
    body: JSON.stringify({ projectKey: 'project-a', command: 'node', args: [], timeoutMs: 1_000, maxOutputBytes: 4_096 }),
  });
  assert.equal(unauthorized.status, 401);
  const traversal = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer correct-token', 'content-type': 'application/json' },
    body: JSON.stringify({ projectKey: '..', command: 'node', args: [], timeoutMs: 1_000, maxOutputBytes: 4_096 }),
  });
  assert.equal(traversal.status, 400);
  assert.match(await traversal.text(), /project_runner_project_key_invalid/u);
});
