import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import {
  createHttpProjectRunner,
  parseProjectRunnerRoutesJson,
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

test('project runner wildcard uses the isolated Pod as the command boundary', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-project-runtime-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = startProjectRunnerServer({
    workspaceRoot: root,
    token: 'runtime-token',
    allowedCommands: ['*'],
    host: '127.0.0.1',
    port: 0,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const runner = createHttpProjectRunner({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: 'runtime-token',
  });
  const result = await runner.execute({
    projectKey: 'project-a',
    command: 'sh',
    args: ['-c', 'printf agent-runtime'],
    timeoutMs: 5_000,
    maxOutputBytes: 16_384,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'agent-runtime');
});

test('project runner terminates a command when the response client disconnects', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-project-disconnect-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = startProjectRunnerServer({
    workspaceRoot: root,
    token: 'disconnect-token',
    allowedCommands: ['node'],
    host: '127.0.0.1',
    port: 0,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${address.port}/v1/execute`, {
    method: 'POST',
    headers: { authorization: 'Bearer disconnect-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      projectKey: 'project-a',
      command: 'node',
      args: ['-e', 'require("node:fs").writeFileSync("command.pid", String(process.pid)); setInterval(() => {}, 1000)'],
      timeoutMs: 60_000,
      maxOutputBytes: 4_096,
    }),
    signal: controller.signal,
  });
  const pidFile = path.join(root, 'project-a', 'command.pid');
  let pid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      pid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(Number.isInteger(pid) && pid > 0, 'command process should have started');
  controller.abort();
  await assert.rejects(pending, /abort/u);
  let alive = true;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, 'disconnected command process should be terminated');
});

test('project runner routes selected projects to a dedicated runtime', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-project-routes-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const makeServer = async (workspaceRoot, marker) => {
    await fs.mkdir(workspaceRoot, { recursive: true });
    const server = startProjectRunnerServer({
      workspaceRoot,
      token: 'route-token',
      allowedCommands: ['node'],
      host: '127.0.0.1',
      port: 0,
      async environment() { return { OPENTAG_TEST_RUNTIME: marker }; },
    });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
  const normal = await makeServer(path.join(root, 'normal'), 'normal');
  const algorithm = await makeServer(path.join(root, 'algorithm'), 'algorithm');
  const runner = createHttpProjectRunner({
    baseUrl: normal,
    token: 'route-token',
    routes: parseProjectRunnerRoutesJson(JSON.stringify({
      'project-algorithm': algorithm,
    })),
  });
  const execute = (projectKey) => runner.execute({
    projectKey,
    command: 'node',
    args: ['-e', 'process.stdout.write(process.env.OPENTAG_TEST_RUNTIME)'],
    timeoutMs: 5_000,
    maxOutputBytes: 16_384,
  });
  assert.equal((await execute('project-default')).stdout, 'normal');
  assert.equal((await execute('project-algorithm')).stdout, 'algorithm');
  assert.throws(
    () => parseProjectRunnerRoutesJson('{"project-a":"https://user:pass@example.com"}'),
    /project_runner_route_invalid/u,
  );
});
