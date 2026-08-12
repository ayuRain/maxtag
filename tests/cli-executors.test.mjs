import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  codexMcpConfigArgs,
  createCodexExecutor,
} from '@opentag/executor-codex';
import {
  claudeMcpConfig,
  createClaudeExecutor,
} from '@opentag/executor-claude';
import {
  CliExecutionError,
  createCliEnvironment,
  runCliCommand,
} from '@opentag/executor-cli';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-cli-test-'));
  const projectDir = path.join(root, 'payments');
  await fs.mkdir(projectDir);
  return {
    root,
    projectDir,
    async script(name, source) {
      const file = path.join(root, name);
      await fs.writeFile(file, source, 'utf8');
      return file;
    },
  };
}

function request(overrides = {}) {
  const events = [];
  return {
    events,
    value: {
      runId: 'run-cli-1',
      workspace: { id: 'acme', name: 'Acme' },
      project: {
        id: 'acme:payments',
        workspaceId: 'acme',
        key: 'payments',
        name: 'Payments',
      },
      thread: {
        id: 'lark:payments:root',
        platform: 'lark',
        externalId: 'payments:root',
        workspaceId: 'acme',
        projectId: 'payments',
        visibility: 'public',
      },
      message: {
        id: 'message-1',
        threadId: 'lark:payments:root',
        platform: 'lark',
        text: 'Summarize the repository.',
        actor: { id: 'user-1', displayName: 'Ada' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
      identity: {
        id: 'payments-agent',
        displayName: 'Payments Copilot',
        instructions: 'Own payment incidents.',
        defaultExecutorId: 'codex',
      },
      access: {
        id: 'access-1',
        threadId: 'lark:payments:root',
        workspaceId: 'acme',
        projectId: 'acme:payments',
        grants: [],
        networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
      },
      memory: 'Project memory.',
      memorySnapshot: { loadedAt: new Date().toISOString(), scopes: [], text: '' },
      async onEvent(event) {
        events.push(event);
      },
      ...overrides,
    },
  };
}

function providerSession(providerId, sessionId) {
  const records = [];
  const invalidations = [];
  return {
    records,
    invalidations,
    value: {
      providerId,
      namespace: 'test:local',
      sessionId,
      async record(value) {
        records.push(value);
      },
      async invalidate(reason) {
        invalidations.push(reason);
      },
    },
  };
}

function fakeToolSessions() {
  const state = { opened: 0, closed: 0 };
  const session = {
    mcp: {
      name: 'opentag',
      command: process.execPath,
      args: ['/tmp/opentag-mcp-proxy.mjs'],
      env: {
        OPENTAG_TOOL_BROKER_URL: 'http://127.0.0.1:43210',
        OPENTAG_TOOL_BROKER_TOKEN: 'per-run-capability',
      },
    },
    tools: [{ name: 'memory_get', title: 'Read scoped memory', risk: 'read' }],
    async close() {
      state.closed += 1;
    },
  };
  return {
    state,
    session,
    factory: {
      async open() {
        state.opened += 1;
        return session;
      },
    },
  };
}

test('command runner streams lines and bounds retained output', async () => {
  const lines = [];
  const result = await runCliCommand({
    command: process.execPath,
    args: ['-e', "console.log('first'); console.log('x'.repeat(3000));"],
    cwd: process.cwd(),
    input: '',
    maxOutputBytes: 1024,
    onStdoutLine(line) {
      lines.push(line);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  assert.equal(lines[0], 'first');
  assert.equal(lines[1].length, 3000);
});

test('command runner terminates an aborted process group', async () => {
  const files = await fixture();
  const sentinel = path.join(files.root, 'child-survived');
  const child = await files.script(
    'delayed-child.mjs',
    `import fs from 'node:fs/promises';
setTimeout(() => fs.writeFile(${JSON.stringify(sentinel)}, 'survived'), 300);
setInterval(() => {}, 1000);
`,
  );
  const parent = await files.script(
    'parent.mjs',
    `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' });
console.log('ready');
setInterval(() => {}, 1000);
`,
  );
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = runCliCommand({
    command: process.execPath,
    args: [parent],
    cwd: process.cwd(),
    input: '',
    abortSignal: controller.signal,
    onStdoutLine(line) {
      if (line === 'ready') controller.abort();
    },
  });

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CliExecutionError);
    assert.equal(error.kind, 'aborted');
    return true;
  });
  assert.ok(Date.now() - startedAt < 2_000);
  await delay(450);
  await assert.rejects(fs.access(sentinel));
});

test('command runner enforces its timeout', async () => {
  await assert.rejects(
    runCliCommand({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      input: '',
      timeoutMs: 30,
    }),
    (error) => {
      assert.ok(error instanceof CliExecutionError);
      assert.equal(error.kind, 'timeout');
      return true;
    },
  );
});

test('command runner can keep stdin open for live messages', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'streaming-stdin.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let count = 0;
for await (const line of lines) {
  console.log(line);
  count += 1;
  if (count === 2) process.exit(0);
}
`,
  );
  const seen = [];
  const result = await runCliCommand({
    command: process.execPath,
    args: [fakeCli],
    cwd: process.cwd(),
    input: 'first\n',
    stdinMode: 'stream',
    async onStdinReady(writer) {
      await writer.writeLine('second');
    },
    onStdoutLine(line) {
      seen.push(line);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen, ['first', 'second']);
});

test('Codex local CLI parses JSONL and does not inherit service secrets', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex.mjs',
    `let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const detail = JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), secret: process.env.OPENTAG_LARK_APP_SECRET, hasPrompt: prompt.includes('Summarize the repository.') });
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'warning-1', type: 'error', message: 'recoverable cache miss' } }));
console.log(JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'git status' } }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'git status' } }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: detail } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }));
`,
  );
  const originalSecret = process.env.OPENTAG_LARK_APP_SECRET;
  process.env.OPENTAG_LARK_APP_SECRET = 'must-not-leak';
  try {
    const broker = fakeToolSessions();
    const session = providerSession('codex');
    const input = request({ providerSession: session.value });
    const executor = createCodexExecutor({
      mode: 'local-cli',
      command: process.execPath,
      commandPrefixArgs: [fakeCli],
      workspaceRoot: files.root,
      timeoutMs: 2_000,
      toolSessions: broker.factory,
    });
    const result = await executor.run(input.value);
    const detail = JSON.parse(result.summary);

    assert.equal(detail.cwd, await fs.realpath(files.projectDir));
    assert.equal(detail.secret, undefined);
    assert.equal(detail.hasPrompt, true);
    assert.ok(detail.args.includes('--sandbox'));
    assert.ok(detail.args.includes('read-only'));
    assert.ok(detail.args.includes('--ignore-user-config'));
    assert.ok(
      detail.args.some((value) =>
        value.startsWith('mcp_servers.opentag.command='),
      ),
    );
    assert.equal(detail.args.includes('--ephemeral'), false);
    assert.deepEqual(broker.state, { opened: 1, closed: 1 });
    assert.deepEqual(session.records, ['thread-1']);
    assert.ok(
      input.events.some(
        (event) =>
          event.type === 'progress' && event.item.label === 'Run Codex CLI',
      ),
    );
    assert.equal(
      input.events.some(
        (event) => event.type === 'progress' && event.item.label === 'error',
      ),
      false,
    );
    assert.ok(
      input.events.some(
        (event) =>
          event.type === 'log' && event.message === 'recoverable cache miss',
      ),
    );
  } finally {
    if (originalSecret === undefined) delete process.env.OPENTAG_LARK_APP_SECRET;
    else process.env.OPENTAG_LARK_APP_SECRET = originalSecret;
  }
});

test('Codex publishes declared files as managed artifacts', async () => {
  const files = await fixture();
  const artifactRoot = path.join(files.root, 'managed-artifacts');
  const fakeCli = await files.script(
    'fake-codex-artifact.mjs',
    `import fs from 'node:fs/promises';
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
await fs.writeFile('result.csv', 'name,value\\nlatency,42\\n');
const text = ['Analysis complete.', 'OPENTAG_ARTIFACT: {"path":"result.csv","title":"Latency result","kind":"report"}'].join('\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'artifact-session' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );
  const input = request();
  const executor = createCodexExecutor({
    mode: 'local-cli',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    artifactRoot,
    timeoutMs: 2_000,
  });

  const result = await executor.run(input.value);
  assert.equal(result.summary, 'Analysis complete.');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].title, 'Latency result');
  assert.equal(
    await fs.readFile(result.artifacts[0].path, 'utf8'),
    'name,value\nlatency,42\n',
  );
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'artifact' && event.artifact.id === result.artifacts[0].id,
    ),
  );
});

test('Codex resumes a persisted provider session without replaying transcript', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex-resume.mjs',
    `let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const detail = JSON.stringify({ args: process.argv.slice(2), replayed: prompt.includes('old transcript marker') });
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session-1' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: detail } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );
  const session = providerSession('codex', 'codex-session-1');
  const input = request({
    providerSession: session.value,
    transcript: {
      threadId: 'lark:payments:root',
      loadedAt: new Date().toISOString(),
      entries: [{
        id: 'old-user',
        runId: 'old-run',
        role: 'user',
        text: 'old transcript marker',
        at: new Date().toISOString(),
        source: 'run',
      }],
      totalEntries: 1,
      omittedEntries: 0,
      truncated: false,
    },
  });
  const executor = createCodexExecutor({
    mode: 'local-cli',
    sessionMode: 'provider',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
  });
  const result = await executor.run(input.value);
  const detail = JSON.parse(result.summary);
  const resumeIndex = detail.args.indexOf('resume');

  assert.ok(resumeIndex > 0);
  assert.equal(detail.args[resumeIndex + 1], 'codex-session-1');
  assert.equal(detail.replayed, false);
  assert.deepEqual(session.records, ['codex-session-1']);
});

test('Codex rebuilds a missing provider session from durable transcript once', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex-missing-session.mjs',
    `let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
if (args.includes('resume')) {
  console.error('session not found');
  process.exit(1);
}
const detail = JSON.stringify({ args, rebuiltFromTranscript: prompt.includes('durable transcript marker') });
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session-new' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: detail } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );
  const session = providerSession('codex', 'codex-session-missing');
  const input = request({
    providerSession: session.value,
    transcript: {
      threadId: 'lark:payments:root',
      loadedAt: new Date().toISOString(),
      entries: [{
        id: 'durable-user',
        runId: 'durable-run',
        role: 'user',
        text: 'durable transcript marker',
        at: new Date().toISOString(),
        source: 'run',
      }],
      totalEntries: 1,
      omittedEntries: 0,
      truncated: false,
    },
  });
  const executor = createCodexExecutor({
    mode: 'local-cli',
    sessionMode: 'provider',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
  });
  const result = await executor.run(input.value);
  const detail = JSON.parse(result.summary);

  assert.equal(detail.args.includes('resume'), false);
  assert.equal(detail.rebuiltFromTranscript, true);
  assert.equal(session.invalidations.length, 1);
  assert.deepEqual(session.records, ['codex-session-new']);
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'log' &&
        event.message.includes('retrying once with durable shared-thread context'),
    ),
  );
});

test('Claude local CLI parses streamed results and emits bounded deltas', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-claude.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
await new Promise((resolve) => lines.once('line', resolve));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working on it. ' } } }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Candidate response' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Claude handled the project.', total_cost_usd: 0.001 }));
`,
  );
  const input = request({
    identity: {
      id: 'payments-agent',
      displayName: 'Payments Copilot',
      instructions: 'Own payment incidents.',
      defaultExecutorId: 'claude',
    },
  });
  const broker = fakeToolSessions();
  const executor = createClaudeExecutor({
    mode: 'local-cli',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
    maxBudgetUsd: 0.05,
    toolSessions: broker.factory,
  });
  const result = await executor.run(input.value);

  assert.equal(result.summary, 'Claude handled the project.');
  assert.deepEqual(broker.state, { opened: 1, closed: 1 });
  assert.equal(
    input.events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.text)
      .join(''),
    'Working on it. ',
  );
  assert.ok(
    input.events.some(
      (event) => event.type === 'log' && event.message.includes('cost=$0.0010'),
    ),
  );
});

test('Claude local CLI surfaces the provider error instead of raw JSONL', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-claude-error.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
await new Promise((resolve) => lines.once('line', resolve));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude auth required' }));
process.exitCode = 1;
`,
  );
  const input = request();
  const executor = createClaudeExecutor({
    mode: 'local-cli',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
  });

  await assert.rejects(executor.run(input.value), /Claude auth required/);
});

test('Claude streams live steering into the active provider session', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-claude-live.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const messages = [];
for await (const line of lines) {
  messages.push(JSON.parse(line));
  if (messages.length === 1) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-1' }));
  }
  if (messages.length === 2) {
    const result = JSON.stringify({ args: process.argv.slice(2), messages });
    console.log(JSON.stringify({ type: 'result', subtype: 'success', result }));
    break;
  }
}
`,
  );
  const session = providerSession('claude');
  const acknowledgements = [];
  let delivered = false;
  const input = request({
    providerSession: session.value,
    steering: {
      mode: 'live',
      async receive() {
        if (delivered) {
          await delay(10);
          return undefined;
        }
        delivered = true;
        return {
          id: 'steer-1',
          targetRunId: 'run-cli-1',
          receivedAt: new Date().toISOString(),
          thread: request().value.thread,
          message: {
            id: 'follow-up-1',
            threadId: 'lark:payments:root',
            platform: 'lark',
            text: 'Also check the retry path.',
            actor: { id: 'user-2', displayName: 'Lin' },
            createdAt: new Date().toISOString(),
            mentionsAgent: false,
          },
        };
      },
      async acknowledge(id, detail) {
        acknowledgements.push({ id, detail });
      },
    },
  });
  const executor = createClaudeExecutor({
    mode: 'local-cli',
    sessionMode: 'provider',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
  });
  const result = await executor.run(input.value);
  const detail = JSON.parse(result.summary);
  const inputFormatIndex = detail.args.indexOf('--input-format');

  assert.equal(executor.steeringMode, 'live');
  assert.equal(detail.args[inputFormatIndex + 1], 'stream-json');
  assert.equal(detail.args.includes('--no-session-persistence'), false);
  assert.equal(detail.messages[0].type, 'user');
  assert.match(detail.messages[1].message.content[0].text, /retry path/);
  assert.match(detail.messages[1].message.content[0].text, /Lin/);
  assert.deepEqual(session.records, ['claude-session-1']);
  assert.deepEqual(acknowledgements, [
    { id: 'steer-1', detail: 'Forwarded to the active Claude stream' },
  ]);
});

test('Claude defers a follow-up that races with stream completion', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-claude-race.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
await new Promise((resolve) => lines.once('line', resolve));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Initial turn completed.' }));
`,
  );
  const events = [];
  const acknowledgements = [];
  let resolveCompletion;
  const completionSeen = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  let delivered = false;
  const input = request({
    async onEvent(event) {
      events.push(event);
      if (
        event.type === 'log' &&
        event.message.includes('Claude turn completed')
      ) {
        resolveCompletion();
      }
      if (
        event.type === 'progress' &&
        event.item.id === 'claude-steering-steer-race' &&
        event.item.status === 'running'
      ) {
        await completionSeen;
      }
    },
    steering: {
      mode: 'live',
      async receive() {
        if (delivered) {
          await delay(10);
          return undefined;
        }
        delivered = true;
        return {
          id: 'steer-race',
          targetRunId: 'run-cli-1',
          receivedAt: new Date().toISOString(),
          thread: request().value.thread,
          message: {
            id: 'follow-up-race',
            threadId: 'lark:payments:root',
            platform: 'lark',
            text: 'Late follow-up.',
            actor: { id: 'user-2', displayName: 'Lin' },
            createdAt: new Date().toISOString(),
            mentionsAgent: false,
          },
        };
      },
      async acknowledge(id) {
        acknowledgements.push(id);
      },
    },
  });
  const executor = createClaudeExecutor({
    mode: 'local-cli',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
  });
  const result = await executor.run(input.value);

  assert.equal(result.summary, 'Initial turn completed.');
  assert.deepEqual(acknowledgements, []);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'log' &&
        event.message.includes('durable mailbox will continue it'),
    ),
  );
});

test('CLI environment only includes provider auth and explicit inherited keys', () => {
  const input = request();
  const original = {
    openai: process.env.OPENAI_API_KEY,
    lark: process.env.OPENTAG_LARK_APP_SECRET,
    custom: process.env.OPENTAG_TEST_CUSTOM,
  };
  process.env.OPENAI_API_KEY = 'openai-test';
  process.env.OPENTAG_LARK_APP_SECRET = 'lark-secret';
  process.env.OPENTAG_TEST_CUSTOM = 'custom-value';
  try {
    const env = createCliEnvironment({
      provider: 'codex',
      request: input.value,
      inheritEnv: ['OPENTAG_TEST_CUSTOM'],
    });
    assert.equal(env.OPENAI_API_KEY, 'openai-test');
    assert.equal(env.OPENTAG_TEST_CUSTOM, 'custom-value');
    assert.equal(env.OPENTAG_LARK_APP_SECRET, undefined);
    assert.equal(env.OPENTAG_RUN_ID, 'run-cli-1');
  } finally {
    for (const [name, value] of [
      ['OPENAI_API_KEY', original.openai],
      ['OPENTAG_LARK_APP_SECRET', original.lark],
      ['OPENTAG_TEST_CUSTOM', original.custom],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('GitHub credentials stay in the host and MCP configs are run-scoped', () => {
  const base = request().value;
  const input = request({
    access: {
      ...base.access,
      grants: [
        {
          id: 'github',
          kind: 'github',
          scope: 'project',
          label: 'GitHub',
          constraints: { repositories: ['acme/payments'] },
        },
      ],
    },
  });
  const original = {
    gh: process.env.GH_TOKEN,
    github: process.env.GITHUB_TOKEN,
    ssh: process.env.SSH_AUTH_SOCK,
  };
  process.env.GH_TOKEN = 'host-gh-token';
  process.env.GITHUB_TOKEN = 'host-github-token';
  process.env.SSH_AUTH_SOCK = '/tmp/host-agent.sock';
  try {
    const env = createCliEnvironment({ provider: 'codex', request: input.value });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);

    const broker = fakeToolSessions();
    const codexArgs = codexMcpConfigArgs(broker.session);
    assert.ok(
      codexArgs.some((value) =>
        value.includes('OPENTAG_TOOL_BROKER_TOKEN="per-run-capability"'),
      ),
    );
    assert.deepEqual(JSON.parse(claudeMcpConfig(broker.session)), {
      mcpServers: {
        opentag: {
          command: process.execPath,
          args: ['/tmp/opentag-mcp-proxy.mjs'],
          env: {
            OPENTAG_TOOL_BROKER_URL: 'http://127.0.0.1:43210',
            OPENTAG_TOOL_BROKER_TOKEN: 'per-run-capability',
          },
        },
      },
    });
  } finally {
    for (const [name, value] of [
      ['GH_TOKEN', original.gh],
      ['GITHUB_TOKEN', original.github],
      ['SSH_AUTH_SOCK', original.ssh],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
