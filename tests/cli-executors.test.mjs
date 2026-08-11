import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexExecutor } from '@opentag/executor-codex';
import { createClaudeExecutor } from '@opentag/executor-claude';
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
    const input = request();
    const executor = createCodexExecutor({
      mode: 'local-cli',
      command: process.execPath,
      commandPrefixArgs: [fakeCli],
      workspaceRoot: files.root,
      timeoutMs: 2_000,
    });
    const result = await executor.run(input.value);
    const detail = JSON.parse(result.summary);

    assert.equal(detail.cwd, await fs.realpath(files.projectDir));
    assert.equal(detail.secret, undefined);
    assert.equal(detail.hasPrompt, true);
    assert.ok(detail.args.includes('--sandbox'));
    assert.ok(detail.args.includes('read-only'));
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

test('Claude local CLI parses streamed results and emits bounded deltas', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-claude.mjs',
    `for await (const _chunk of process.stdin) {}
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
  const executor = createClaudeExecutor({
    mode: 'local-cli',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
    maxBudgetUsd: 0.05,
  });
  const result = await executor.run(input.value);

  assert.equal(result.summary, 'Claude handled the project.');
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
    `for await (const _chunk of process.stdin) {}
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
