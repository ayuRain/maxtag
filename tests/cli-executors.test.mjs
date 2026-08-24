import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  codexNativeWebEnabled,
  codexMcpConfigArgs,
  createCodexExecutor,
} from '@opentag/executor-codex';
import {
  claudeIsolatedSettings,
  claudeMcpConfig,
  claudeTools,
  createClaudeExecutor,
} from '@opentag/executor-claude';
import {
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  CliExecutionError,
  collectCliArtifacts,
  createCliEnvironment,
  isCliContextOverflow,
  memoryCandidateInstructions,
  resolveProjectWorkingDirectory,
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

test('CLI executor prompt exposes the authoritative client route identity', () => {
  const input = request();
  input.value.thread = {
    ...input.value.thread,
    channelId: 'oc_payments',
    rootMessageId: 'om_root',
    topicId: 'omt_topic',
    title: 'Payments incident room',
    visibility: 'private',
  };

  const prompt = buildAgentSystemPrompt(input.value);

  assert.match(prompt, /Authoritative execution route:/u);
  assert.match(prompt, /Workspace: Acme \[acme\]/u);
  assert.match(prompt, /Project: Payments \[payments\]/u);
  assert.match(prompt, /Channel ID: oc_payments/u);
  assert.match(prompt, /Root message ID: om_root/u);
  assert.match(prompt, /Topic ID: omt_topic/u);
  assert.match(prompt, /Thread visibility: private/u);
  assert.match(prompt, /Do not infer route IDs from actor IDs/u);
});

test('agent prompt owns outcomes and recovers inside the granted project sandbox', () => {
  const input = request();
  input.value.access.grants = [{
    id: 'shell',
    kind: 'shell',
    scope: 'project',
    label: 'Project sandbox',
    constraints: { permissions: ['read', 'write'], commands: ['git', 'npm'] },
  }];

  const prompt = buildAgentSystemPrompt(input.value);

  assert.match(prompt, /general-purpose project agent, not a fixed workflow runner/u);
  assert.match(prompt, /Skills, wrappers, and workflows are optional accelerators/u);
  assert.match(prompt, /inspect its stdout\/stderr/u);
  assert.match(prompt, /make a safe in-sandbox correction, and retry/u);
  assert.match(prompt, /without asking for confirmation/u);
  assert.match(prompt, /explicit approval boundary/u);
});

test('project runtime prompt treats multiple groups as entrances to one agent', () => {
  const input = request();
  input.value.providerSession = {
    providerId: 'codex',
    namespace: 'runtime:test',
    runtimeScope: 'project',
    async record() {},
    async invalidate() {},
  };

  const prompt = buildAgentSystemPrompt(input.value);
  assert.match(prompt, /long-lived Agent for this Project/u);
  assert.match(prompt, /every bound group or client/u);
  assert.match(prompt, /same Project conversation and persistent workspace/u);
  assert.match(prompt, /reply through the current source thread/u);
});

test('project routes receive distinct managed directories instead of sharing the workspace root', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-project-root-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = request();
  const second = request();
  second.value.project = {
    ...second.value.project,
    id: 'acme:analytics',
    key: 'analytics',
    name: 'Analytics',
  };

  const firstDirectory = await resolveProjectWorkingDirectory(root, first.value);
  const secondDirectory = await resolveProjectWorkingDirectory(root, second.value);

  assert.equal(firstDirectory, path.join(root, 'payments'));
  assert.equal(secondDirectory, path.join(root, 'analytics'));
  assert.notEqual(firstDirectory, root);
  assert.notEqual(secondDirectory, root);
  assert.equal((await fs.stat(firstDirectory)).isDirectory(), true);
  assert.equal((await fs.stat(secondDirectory)).isDirectory(), true);
});

test('Claude native tools stay read-only while brokered tools carry route grants', () => {
  const restricted = request();
  restricted.value.access.grants = [
    { id: 'shell', kind: 'shell', scope: 'project', label: 'Workspace files' },
    { id: 'browser', kind: 'browser', scope: 'project', label: 'Web' },
  ];
  restricted.value.access.networkPolicy = {
    mode: 'restricted',
    allowedHosts: ['github.com'],
  };
  const restrictedTools = claudeTools(restricted.value);
  assert.deepEqual(restrictedTools.available.sort(), ['Glob', 'Grep', 'Read']);
  assert.deepEqual(restrictedTools.allowed.sort(), ['Glob', 'Grep', 'Read']);
  assert.equal(restrictedTools.allowed.includes('Edit'), false);
  assert.equal(restrictedTools.allowed.includes('Write'), false);
  assert.equal(restrictedTools.allowed.includes('Bash'), false);
  assert.equal(restrictedTools.available.includes('WebFetch'), false);
  assert.equal(restrictedTools.allowed.includes('WebSearch'), false);
  assert.deepEqual(claudeIsolatedSettings(restricted.value), {
    disableAllHooks: true,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
    },
  });

  const unrestricted = request();
  unrestricted.value.access.grants = restricted.value.access.grants;
  unrestricted.value.access.networkPolicy = {
    mode: 'allow-all',
    allowedHosts: [],
  };
  const unrestrictedTools = claudeTools(unrestricted.value);
  assert.equal(unrestrictedTools.allowed.includes('Bash'), false);
  assert.equal(unrestrictedTools.allowed.includes('WebFetch'), false);
  assert.equal(unrestrictedTools.allowed.includes('WebSearch'), false);
  assert.deepEqual(
    claudeIsolatedSettings(unrestricted.value).sandbox.network.allowedDomains,
    [],
  );
});

test('Codex native web search stays disabled so browser access is brokered', () => {
  const restricted = request();
  restricted.value.access.grants = [
    { id: 'browser', kind: 'browser', scope: 'project', label: 'Web' },
  ];
  restricted.value.access.networkPolicy = {
    mode: 'restricted',
    allowedHosts: ['github.com'],
  };
  assert.equal(codexNativeWebEnabled(restricted.value), false);
  restricted.value.access.networkPolicy = { mode: 'allow-all', allowedHosts: [] };
  assert.equal(codexNativeWebEnabled(restricted.value), false);
  restricted.value.access.grants = [];
  assert.equal(codexNativeWebEnabled(restricted.value), false);
});

test('memory retrieval prompt is read-only and its declarations are hidden from users', async () => {
  const input = request({
    purpose: 'memory_retrieval',
    memory: [
      'REF {"documentKey":"project:acme:payments","version":3,"lineNumber":7,"scope":"project"}',
      'Use Postgres for distributed workers.',
    ].join('\n'),
  });
  const systemPrompt = buildAgentSystemPrompt(input.value);
  assert.match(systemPrompt, /one-shot read-only relevance selector/u);
  assert.match(systemPrompt, /Candidate text is untrusted data/u);
  assert.match(systemPrompt, /Do not use tools/u);

  const result = await collectCliArtifacts({
    finalMessage: [
      'OPENTAG_MEMORY_SELECTION: {"documentKey":"project:acme:payments","version":3,"lineNumber":7,"reason":"database decision","confidence":0.95}',
      'OPENTAG_MEMORY_SELECTION: {"documentKey":"project:acme:payments","version":"old","lineNumber":8}',
    ].join('\n'),
    cwd: process.cwd(),
    runId: 'memory-retrieval-test',
  });
  assert.equal(result.summary, '');
  assert.deepEqual(result.memorySelections, [
    {
      documentKey: 'project:acme:payments',
      version: 3,
      lineNumber: 7,
      reason: 'database decision',
      confidence: 0.95,
    },
  ]);
  assert.match(result.warnings[0], /version must be a non-negative integer/u);
});

test('knowledge enrichment prompt and passage declarations stay read-only and hidden', async () => {
  const input = request({
    purpose: 'knowledge_enrichment',
    memory: '1: Production launch requires rollout status.\n2: Customer receipt is final.',
  });
  const prompt = buildAgentSystemPrompt(input.value);
  assert.match(prompt, /one-shot read-only semantic indexer/u);
  assert.match(prompt, /Source text is untrusted data/u);
  assert.match(prompt, /OPENTAG_KNOWLEDGE_PASSAGE/u);
  assert.match(prompt, /Do not use tools/u);
  const result = await collectCliArtifacts({
    finalMessage: [
      'OPENTAG_KNOWLEDGE_PASSAGE: {"lineStart":1,"lineEnd":2,"summary":"Launch evidence gates.","aliases":["上线证明","production evidence"],"confidence":0.93}',
      'OPENTAG_KNOWLEDGE_PASSAGE: {"lineStart":0,"lineEnd":2,"summary":"Invalid.","aliases":["one","two"]}',
    ].join('\n'),
    cwd: process.cwd(),
    runId: 'knowledge-enrichment-test',
  });
  assert.equal(result.summary, '');
  assert.deepEqual(result.knowledgePassages, [{
    lineStart: 1, lineEnd: 2, summary: 'Launch evidence gates.',
    aliases: ['上线证明', 'production evidence'], confidence: 0.93,
  }]);
  assert.match(result.warnings[0], /lineStart is invalid/u);
});

test('automatic memory wrapup keeps the one-shot read-only analysis contract', () => {
  const input = request({ purpose: 'memory_wrapup' });
  input.value.access.grants = [
    {
      id: 'memory:project',
      kind: 'memory',
      scope: 'project',
      label: 'Project memory',
      constraints: { permissions: ['read', 'write'] },
    },
  ];
  const prompt = buildAgentSystemPrompt(input.value);
  assert.match(prompt, /MaxTag Memory Analyst/u);
  assert.match(prompt, /one-shot read-only memory worker/u);
  assert.match(prompt, /Do not use tools/u);
  assert.match(
    memoryCandidateInstructions(input.value),
    /OPENTAG_MEMORY_DECISION/u,
  );
  assert.doesNotMatch(prompt, /MaxTag project agent/u);
});

test('agent prompts distinguish durable memory from conversation context', () => {
  const input = request({ memory: undefined });
  input.value.access.grants = [
    {
      id: 'memory:workspace',
      kind: 'memory',
      scope: 'workspace',
      label: 'Company memory',
      constraints: { permissions: ['read', 'write'] },
    },
    {
      id: 'memory:project',
      kind: 'memory',
      scope: 'project',
      label: 'Project memory',
      constraints: { permissions: ['read', 'write'] },
    },
    {
      id: 'memory:thread',
      kind: 'memory',
      scope: 'thread',
      label: 'Legacy thread memory',
      constraints: { permissions: ['read', 'write'] },
    },
  ];
  const prompt = buildAgentSystemPrompt(input.value);
  const memoryPrompt = memoryCandidateInstructions(input.value);
  assert.match(prompt, /does not mean the current conversation history is absent/u);
  assert.match(prompt, /available as conversational context for follow-up questions/u);
  assert.match(memoryPrompt, /Allowed scopes for this run: workspace, project/u);
  assert.doesNotMatch(memoryPrompt, /Allowed scopes:.*thread/u);
  assert.match(memoryPrompt, /one-off recall tests/u);
});

test('memory analysis parses bounded semantic aliases without exposing declarations', async () => {
  const input = request({ purpose: 'memory_analysis' });
  input.value.access.grants = [
    {
      id: 'memory:project',
      kind: 'memory',
      scope: 'project',
      label: 'Project memory',
      constraints: { permissions: ['read', 'write'] },
    },
  ];
  const prompt = memoryCandidateInstructions(input.value);
  assert.match(prompt, /retrieval aliases/u);
  const result = await collectCliArtifacts({
    finalMessage: [
      'OPENTAG_MEMORY_DECISION: {"operation":"remember","scope":"project","text":"Use Postgres for distributed workers.","aliases":["shared worker database","共享 worker 用什么数据库","shared worker database","  PG   decision  ","a","two","three","four","five"],"confidence":0.96}',
      'This prose must not survive memory analysis.',
    ].join('\n'),
    cwd: process.cwd(),
    runId: 'memory-analysis-alias-test',
  });
  assert.equal(result.memoryDecisions.length, 1);
  assert.deepEqual(result.memoryDecisions[0].aliases, [
    'shared worker database',
    '共享 worker 用什么数据库',
    'PG decision',
    'two',
    'three',
    'four',
  ]);
  assert.equal(result.summary, 'This prose must not survive memory analysis.');
});

test('memory analysis parses bounded multi-fact merge declarations', async () => {
  const input = request({ purpose: 'memory_analysis' });
  input.value.access.grants = [
    {
      id: 'memory:project',
      kind: 'memory',
      scope: 'project',
      label: 'Project memory',
      constraints: { permissions: ['read', 'write'] },
    },
  ];
  assert.match(memoryCandidateInstructions(input.value), /Use merge when two or more/u);
  const result = await collectCliArtifacts({
    finalMessage: [
      'OPENTAG_MEMORY_DECISION: {"operation":"merge","scope":"project","text":"Distributed workers use Postgres with 30-day backups.","selectors":["Use Postgres for distributed workers.","Keep database backups for 30 days.","Use Postgres for distributed workers."],"expectedDocumentVersion":4,"aliases":["worker persistence policy"],"confidence":0.97}',
      'OPENTAG_MEMORY_DECISION: {"operation":"merge","scope":"project","text":"Invalid single-source merge.","selectors":["Only one fact."],"expectedDocumentVersion":4,"confidence":0.99}',
    ].join('\n'),
    cwd: process.cwd(),
    runId: 'memory-analysis-merge-test',
  });
  assert.deepEqual(result.memoryDecisions, [
    {
      operation: 'merge',
      scope: 'project',
      text: 'Distributed workers use Postgres with 30-day backups.',
      selector: undefined,
      selectors: [
        'Use Postgres for distributed workers.',
        'Keep database backups for 30 days.',
      ],
      expectedDocumentVersion: 4,
      reason: undefined,
      confidence: 0.97,
      aliases: ['worker persistence policy'],
    },
  ]);
  assert.match(result.warnings[0], /at least two selectors are required/u);
});

test('Codex accepts an empty successful turn for memory analysis only', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex-empty-memory.mjs',
    `console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ephemeral-memory' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 0 } }));
`,
  );
  const executor = createCodexExecutor({
    mode: 'local-cli',
    sessionMode: 'provider',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
  });

  const memoryResult = await executor.run(request({ purpose: 'memory_analysis' }).value);
  assert.equal(memoryResult.summary, '');
  assert.deepEqual(memoryResult.memoryDecisions, []);

  await assert.rejects(
    executor.run(request().value),
    /codex_no_final_response/u,
  );
});

test('verified turn memory remains in the user prompt for resumed provider sessions', () => {
  const session = providerSession('codex', 'codex-session-memory');
  const input = request({
    providerSession: session.value,
    memory: '[line 7] Use Postgres for distributed workers.',
  });

  const prompt = buildAgentUserPrompt(input.value);
  assert.match(prompt, /VERIFIED APPROVED MEMORY FOR THIS TURN/u);
  assert.match(prompt, /Use Postgres for distributed workers/u);
});

test('Codex memory retrieval is ephemeral, read-only, and has no brokered tools', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex-memory-retrieval.mjs',
    `let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const detail = JSON.stringify({ args: process.argv.slice(2), selectorPrompt: prompt.includes('MaxTag Memory Retrieval') });
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'must-not-persist' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'OPENTAG_MEMORY_SELECTION: {"documentKey":"project:acme:payments","version":3,"lineNumber":7,"confidence":0.9}' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );
  const broker = fakeToolSessions();
  const session = providerSession('codex', 'main-agent-session');
  const input = request({
    purpose: 'memory_retrieval',
    providerSession: session.value,
    memory: [
      'REF {"documentKey":"project:acme:payments","version":3,"lineNumber":7,"scope":"project"}',
      'Use Postgres for distributed workers.',
    ].join('\n'),
  });
  const executor = createCodexExecutor({
    mode: 'local-cli',
    sessionMode: 'provider',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
    toolSessions: broker.factory,
  });

  const result = await executor.run(input.value);
  assert.equal(result.memorySelections.length, 1);
  assert.equal(broker.state.opened, 0);
  assert.deepEqual(session.records, []);
  assert.deepEqual(session.invalidations, []);
  assert.ok(result.memorySelections[0].confidence >= 0.9);
  const log = input.events.find(
    (event) => event.type === 'log' && event.message.startsWith('Codex thread'),
  );
  assert.ok(log);

  const detailCli = await files.script(
    'fake-codex-memory-args.mjs',
    `console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: JSON.stringify(process.argv.slice(2)) } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );
  const argsResult = await createCodexExecutor({
    mode: 'local-cli',
    sessionMode: 'provider',
    command: process.execPath,
    commandPrefixArgs: [detailCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
    toolSessions: broker.factory,
  }).run(input.value);
  const args = JSON.parse(argsResult.summary);
  assert.ok(args.includes('--ephemeral'));
  assert.equal(args.includes('resume'), false);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args.some((value) => value.startsWith('mcp_servers.')), false);
});

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

test('CLI context overflow classifier recognizes provider variants without matching ordinary failures', () => {
  assert.equal(isCliContextOverflow(new Error('prompt is too long')), true);
  assert.equal(
    isCliContextOverflow(new Error('maximum context length exceeded')),
    true,
  );
  assert.equal(
    isCliContextOverflow(new Error('input exceeds the context window for this model')),
    true,
  );
  assert.equal(isCliContextOverflow(new Error('rate limit exceeded')), false);
  assert.equal(isCliContextOverflow(new Error('session not found')), false);
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
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } }));
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
    assert.equal(detail.args.includes('--search'), false);
    assert.ok(
      detail.args.some((value) =>
        value.startsWith('mcp_servers.opentag.command='),
      ),
    );
    assert.equal(detail.args.includes('--ephemeral'), false);
    assert.deepEqual(broker.state, { opened: 1, closed: 1 });
    assert.deepEqual(session.records, ['thread-1']);
    assert.deepEqual(result.usage, {
      runs: 1,
      inputTokens: 10,
      outputTokens: 4,
    });
    assert.ok(
      input.events.some(
        (event) =>
          event.type === 'progress' && event.item.label === 'Run Codex CLI',
      ),
    );
    const nativeCall = input.events.find(
      (event) => event.type === 'tool_call' && event.call.name === 'codex.shell',
    );
    assert.ok(nativeCall);
    assert.equal(nativeCall.call.source, 'provider-native');
    assert.equal(nativeCall.call.provider, 'codex');
    assert.equal(nativeCall.call.arguments, undefined);
    const nativeResult = input.events.find(
      (event) => event.type === 'tool_result' && event.call.id === 'cmd-1',
    );
    assert.equal(nativeResult?.call.status, 'succeeded');
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

test('Codex stays read-only with shell and browser grants', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex-mediated.mjs',
    `let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: JSON.stringify(process.argv.slice(2)) } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );
  const input = request();
  input.value.access.grants = [
    {
      id: 'shell',
      kind: 'shell',
      scope: 'project',
      label: 'Workspace',
      constraints: { permissions: ['read', 'write'] },
    },
    { id: 'browser', kind: 'browser', scope: 'project', label: 'Browser' },
  ];
  input.value.access.networkPolicy = { mode: 'allow-all', allowedHosts: [] };
  const result = await createCodexExecutor({
    mode: 'local-cli',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
  }).run(input.value);
  const args = JSON.parse(result.summary);

  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args.includes('--search'), false);
  assert.equal(
    args.some((value) => value.includes('sandbox_workspace_write.network_access')),
    false,
  );
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
const detail = JSON.stringify({ args: process.argv.slice(2), replayed: prompt.includes('old transcript marker'), memoryInjected: prompt.includes('Project memory.') });
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
  assert.equal(detail.memoryInjected, true);
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

test('Codex scopes context overflow recovery to the resumed thread session', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex-context-overflow.mjs',
    `let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
if (args.includes('resume')) {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'context_length_exceeded: maximum context length reached' } }));
  process.exit(1);
}
const detail = JSON.stringify({ args, rebuiltFromTranscript: prompt.includes('bounded transcript marker') });
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session-after-overflow' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: detail } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );
  const session = providerSession('codex', 'codex-session-full');
  const input = request({
    providerSession: session.value,
    transcript: {
      threadId: 'lark:payments:root',
      loadedAt: new Date().toISOString(),
      entries: [{
        id: 'bounded-user',
        runId: 'bounded-run',
        role: 'user',
        text: 'bounded transcript marker',
        at: new Date().toISOString(),
        source: 'run',
      }],
      totalEntries: 12,
      omittedEntries: 11,
      truncated: true,
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
  assert.match(session.invalidations[0], /context limit/);
  assert.deepEqual(session.records, ['codex-session-after-overflow']);
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'progress' &&
        event.item.id === 'codex-session-recovery' &&
        event.item.status === 'done',
    ),
  );
});

test('Codex app server applies live steering in an isolated provider home', async () => {
  const files = await fixture();
  const authSource = path.join(files.root, 'source-codex-home');
  const codexHome = path.join(files.root, 'opentag-codex-home');
  await fs.mkdir(authSource);
  await fs.writeFile(
    path.join(authSource, 'auth.json'),
    JSON.stringify({ token: 'seed-only-test-token' }),
    'utf8',
  );
  await fs.writeFile(
    path.join(authSource, 'config.toml'),
    '[mcp_servers.personal]\ncommand = "must-not-leak"\n',
    'utf8',
  );
  const fakeCli = await files.script(
    'fake-codex-app-server-live.mjs',
    `import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
let turnId = 'turn-live-1';
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }));
  } else if (message.method === 'thread/start') {
    if (message.params.config.mcp_servers.opentag.default_tools_approval_mode !== 'approve') {
      throw new Error('brokered MCP tools must defer approval to MaxTag');
    }
    console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'codex-app-thread-1' } } }));
  } else if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } }));
  } else if (message.method === 'turn/steer') {
    const managedConfig = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    const auth = await fs.readFile(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8');
    const detail = {
      args: process.argv.slice(2),
      cwd: process.cwd(),
      codexHome: process.env.CODEX_HOME,
      managedConfig,
      authSeeded: auth.includes('seed-only-test-token'),
      projectId: process.env.OPENTAG_PROJECT_ID,
      prompt: message.params.input[0].text,
      clientUserMessageId: message.params.clientUserMessageId,
    };
    console.log(JSON.stringify({ id: message.id, result: { turnId } }));
    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'codex-app-thread-1', turnId, completedAtMs: Date.now(), item: { id: 'answer-1', type: 'agentMessage', text: JSON.stringify(detail) } } }));
    console.log(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'codex-app-thread-1', turnId, tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 17 }, total: { inputTokens: 12, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 17 } } } }));
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'codex-app-thread-1', turn: { id: turnId, status: 'completed', items: [] } } }));
  }
}
`,
  );
  const broker = fakeToolSessions();
  const session = providerSession('codex');
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
          id: 'codex-steer-1',
          targetRunId: 'run-cli-1',
          receivedAt: new Date().toISOString(),
          thread: request().value.thread,
          message: {
            id: 'codex-follow-up-1',
            threadId: 'lark:payments:root',
            platform: 'lark',
            text: 'Also inspect retry isolation.',
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
  const executor = createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    disableNativeShell: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome,
    codexAuthSourceHome: authSource,
    timeoutMs: 2_000,
    toolSessions: broker.factory,
  });

  const result = await executor.run(input.value);
  const detail = JSON.parse(result.summary);
  assert.equal(executor.steeringMode, 'live');
  assert.deepEqual(detail.args.slice(-7), [
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    'app-server',
    '--stdio',
    '--strict-config',
  ]);
  assert.equal(detail.cwd, await fs.realpath(files.projectDir));
  assert.equal(detail.codexHome, codexHome);
  assert.equal(detail.authSeeded, true);
  assert.doesNotMatch(detail.managedConfig, /must-not-leak/u);
  assert.equal(detail.projectId, 'acme:payments');
  assert.match(detail.prompt, /retry isolation/u);
  assert.match(detail.prompt, /Lin/u);
  assert.equal(detail.clientUserMessageId, 'codex-follow-up-1');
  assert.deepEqual(session.records, ['codex-app-thread-1']);
  assert.deepEqual(acknowledgements, [
    {
      id: 'codex-steer-1',
      detail: 'Forwarded to the active Codex turn',
    },
  ]);
  assert.deepEqual(broker.state, { opened: 1, closed: 1 });
  assert.deepEqual(result.usage, {
    runs: 1,
    inputTokens: 12,
    outputTokens: 5,
  });
});

test('Codex app server defers steering rejected by a completed turn', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex-app-server-race.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'race-thread' } } }));
  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'race-turn', status: 'inProgress', items: [] } } }));
  }
  if (message.method === 'turn/steer') {
    console.log(JSON.stringify({ id: message.id, error: { code: -32000, message: 'active turn not steerable', data: { activeTurnNotSteerable: { turnKind: 'review' } } } }));
    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'race-thread', turnId: 'race-turn', completedAtMs: Date.now(), item: { id: 'answer', type: 'agentMessage', text: 'Initial turn completed.' } } }));
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'race-thread', turn: { id: 'race-turn', status: 'completed', items: [] } } }));
  }
}
`,
  );
  const acknowledgements = [];
  let delivered = false;
  const input = request({
    steering: {
      mode: 'live',
      async receive() {
        if (delivered) return undefined;
        delivered = true;
        return {
          id: 'race-steer',
          targetRunId: 'run-cli-1',
          receivedAt: new Date().toISOString(),
          thread: request().value.thread,
          message: {
            id: 'race-follow-up',
            threadId: 'lark:payments:root',
            platform: 'lark',
            text: 'Late follow-up',
            actor: { id: 'user-2' },
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
  const result = await createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome: path.join(files.root, 'codex-race-home'),
    timeoutMs: 2_000,
  }).run(input.value);

  assert.equal(result.summary, 'Initial turn completed.');
  assert.deepEqual(acknowledgements, []);
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'log' && event.message.includes('durable mailbox'),
    ),
  );
});

test('Codex /compact compacts the existing provider thread without starting an agent turn', async () => {
  const files = await fixture();
  const methodLog = path.join(files.root, 'compact-methods.json');
  const fakeCli = await files.script(
    'fake-codex-app-server-compact.mjs',
    `import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
const methods = [];
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method) methods.push(message.method);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === 'thread/resume') console.log(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId } } }));
  if (message.method === 'thread/compact/start') {
    await fs.writeFile(${JSON.stringify(methodLog)}, JSON.stringify(methods));
    console.log(JSON.stringify({ id: message.id, result: {} }));
    console.log(JSON.stringify({ method: 'turn/started', params: { threadId: 'compact-thread', turn: { id: 'compact-turn', status: 'inProgress', items: [] } } }));
    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'compact-thread', turnId: 'compact-turn', item: { id: 'compact-item', type: 'contextCompaction' } } }));
  }
  if (message.method === 'turn/start') {
    await fs.writeFile(${JSON.stringify(methodLog)}, JSON.stringify(methods));
  }
}
`,
  );
  const session = providerSession('codex', 'compact-thread');
  const input = request({
    providerSession: session.value,
    message: { ...request().value.message, text: '/compact' },
  });
  const broker = fakeToolSessions();

  const result = await createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome: path.join(files.root, 'codex-compact-home'),
    timeoutMs: 2_000,
    toolSessions: broker.factory,
  }).run(input.value);

  assert.match(result.summary, /compacted in place/u);
  assert.deepEqual(session.records, ['compact-thread']);
  assert.deepEqual(session.invalidations, []);
  assert.deepEqual(broker.state, { opened: 0, closed: 0 });
  const methods = JSON.parse(await fs.readFile(methodLog, 'utf8'));
  assert.ok(methods.includes('thread/compact/start'));
  assert.equal(methods.includes('turn/start'), false);
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'progress' &&
        event.item.id === 'codex-context-compaction' &&
        event.item.status === 'done' &&
        event.item.detail.includes('item confirmation'),
    ),
  );
});

test('Codex /compact explains when the route has no provider thread', async () => {
  const input = request({
    providerSession: providerSession('codex').value,
    message: { ...request().value.message, text: '/compact' },
  });
  const result = await createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: '/does/not/run',
    workspaceRoot: process.cwd(),
  }).run(input.value);

  assert.match(result.summary, /no active Codex conversation context/u);
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'progress' &&
        event.item.id === 'codex-context-compaction' &&
        event.item.status === 'done',
    ),
  );
});

test('Codex app server surfaces automatic context compaction as one lifecycle item', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-codex-app-server-auto-compact.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'auto-compact-thread' } } }));
  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'auto-compact-turn', status: 'inProgress', items: [] } } }));
    console.log(JSON.stringify({ method: 'item/started', params: { threadId: 'auto-compact-thread', turnId: 'auto-compact-turn', item: { id: 'auto-compact-item', type: 'contextCompaction' } } }));
    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'auto-compact-thread', turnId: 'auto-compact-turn', item: { id: 'auto-compact-item', type: 'contextCompaction' } } }));
    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'auto-compact-thread', turnId: 'auto-compact-turn', item: { id: 'answer', type: 'agentMessage', text: 'Automatic compaction completed safely.' } } }));
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'auto-compact-thread', turn: { id: 'auto-compact-turn', status: 'completed', items: [] } } }));
  }
}
`,
  );
  const session = providerSession('codex');
  const input = request({ providerSession: session.value });

  const result = await createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome: path.join(files.root, 'codex-auto-compact-home'),
    timeoutMs: 2_000,
  }).run(input.value);

  assert.equal(result.summary, 'Automatic compaction completed safely.');
  const lifecycle = input.events.filter(
    (event) =>
      event.type === 'progress' &&
      event.item.id === 'codex-context-compaction',
  );
  assert.deepEqual(
    lifecycle.map((event) => event.item.status),
    ['running', 'done'],
  );
});

test('Codex app server proactively compacts a completed near-limit provider thread', async () => {
  const files = await fixture();
  const methodLog = path.join(files.root, 'proactive-compact-methods.json');
  const fakeCli = await files.script(
    'fake-codex-app-server-proactive-compact.mjs',
    `import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
const methods = [];
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method) methods.push(message.method);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === 'thread/resume') console.log(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId } } }));
  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'near-limit-turn', status: 'inProgress', items: [] } } }));
    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'near-limit-thread', turnId: 'near-limit-turn', item: { id: 'answer', type: 'agentMessage', text: 'Reply stays available.' } } }));
    console.log(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'near-limit-thread', turnId: 'near-limit-turn', tokenUsage: { modelContextWindow: 100, last: { inputTokens: 80, outputTokens: 10, totalTokens: 90 }, total: { inputTokens: 80, outputTokens: 10, totalTokens: 90 } } } }));
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'near-limit-thread', turn: { id: 'near-limit-turn', status: 'completed', items: [] } } }));
  }
  if (message.method === 'thread/compact/start') {
    await fs.writeFile(${JSON.stringify(methodLog)}, JSON.stringify(methods));
    console.log(JSON.stringify({ id: message.id, result: {} }));
    console.log(JSON.stringify({ method: 'thread/compacted', params: { threadId: 'near-limit-thread', turnId: 'proactive-compact-turn' } }));
  }
}
`,
  );
  const session = providerSession('codex', 'near-limit-thread');
  const input = request({ providerSession: session.value });
  const result = await createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome: path.join(files.root, 'codex-proactive-compact-home'),
    timeoutMs: 2_000,
    contextCompactionThreshold: 0.85,
  }).run(input.value);

  assert.equal(result.summary, 'Reply stays available.');
  assert.deepEqual(result.usage, { runs: 1, inputTokens: 80, outputTokens: 10 });
  const methods = JSON.parse(await fs.readFile(methodLog, 'utf8'));
  assert.deepEqual(
    methods.filter((method) => method === 'turn/start' || method === 'thread/compact/start'),
    ['turn/start', 'thread/compact/start'],
  );
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'progress' &&
        event.item.id === 'codex-context-compaction' &&
        event.item.status === 'running' &&
        event.item.detail.includes('90%'),
    ),
  );
});

test('Codex app server recovers context overflow by compacting the same provider thread once', async () => {
  const files = await fixture();
  const methodLog = path.join(files.root, 'overflow-compact-methods.json');
  const fakeCli = await files.script(
    'fake-codex-app-server-overflow-compact.mjs',
    `import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
const methods = [];
let turnCount = 0;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method) methods.push(message.method);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === 'thread/resume') console.log(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId } } }));
  if (message.method === 'turn/start') {
    turnCount += 1;
    const turnId = 'overflow-turn-' + turnCount;
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } }));
    if (turnCount === 1) {
      console.log(JSON.stringify({ method: 'error', params: { threadId: 'overflow-thread', turnId, error: { message: 'context_length_exceeded: maximum context length reached' }, willRetry: false } }));
      console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'overflow-thread', turn: { id: turnId, status: 'failed', error: { message: 'context_length_exceeded' }, items: [] } } }));
    } else {
      await fs.writeFile(${JSON.stringify(methodLog)}, JSON.stringify({ methods, prompt: message.params.input[0].text }));
      console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'overflow-thread', turnId, item: { id: 'answer', type: 'agentMessage', text: 'Recovered in the same Codex thread.' } } }));
      console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'overflow-thread', turn: { id: turnId, status: 'completed', items: [] } } }));
    }
  }
  if (message.method === 'thread/compact/start') {
    console.log(JSON.stringify({ id: message.id, result: {} }));
    console.log(JSON.stringify({ method: 'turn/started', params: { threadId: 'overflow-thread', turn: { id: 'overflow-compact-turn', status: 'inProgress', items: [] } } }));
    console.log(JSON.stringify({ method: 'thread/compacted', params: { threadId: 'overflow-thread', turnId: 'overflow-compact-turn' } }));
  }
}
`,
  );
  const session = providerSession('codex', 'overflow-thread');
  const input = request({ providerSession: session.value });
  const result = await createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome: path.join(files.root, 'codex-overflow-compact-home'),
    timeoutMs: 2_000,
  }).run(input.value);

  assert.equal(result.summary, 'Recovered in the same Codex thread.');
  assert.deepEqual(session.invalidations, []);
  assert.deepEqual(session.records, ['overflow-thread']);
  const detail = JSON.parse(await fs.readFile(methodLog, 'utf8'));
  assert.deepEqual(
    detail.methods.filter(
      (method) => method === 'turn/start' || method === 'thread/compact/start',
    ),
    ['turn/start', 'thread/compact/start', 'turn/start'],
  );
  assert.match(detail.prompt, /Continue and complete the user request/u);
  assert.doesNotMatch(detail.prompt, /Summarize the repository/u);
});

test('Codex app server falls back to bounded durable context when native compaction fails', async () => {
  const files = await fixture();
  const attemptMarker = path.join(files.root, 'native-compact-fallback.txt');
  const fakeCli = await files.script(
    'fake-codex-app-server-compact-fallback.mjs',
    `import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === 'thread/resume') console.log(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId } } }));
  if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'durable-fallback-thread' } } }));
  if (message.method === 'turn/start') {
    const first = message.params.threadId === 'native-full-thread';
    const turnId = first ? 'native-full-turn' : 'durable-fallback-turn';
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } }));
    if (first) {
      console.log(JSON.stringify({ method: 'error', params: { threadId: 'native-full-thread', turnId, error: { message: 'context_length_exceeded' }, willRetry: false } }));
      console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-full-thread', turn: { id: turnId, status: 'failed', error: { message: 'context_length_exceeded' }, items: [] } } }));
    } else {
      await fs.writeFile(${JSON.stringify(attemptMarker)}, message.params.input[0].text.includes('durable compact fallback marker') ? 'durable' : 'missing');
      console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'durable-fallback-thread', turnId, item: { id: 'answer', type: 'agentMessage', text: 'Recovered from durable context.' } } }));
      console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'durable-fallback-thread', turn: { id: turnId, status: 'completed', items: [] } } }));
    }
  }
  if (message.method === 'thread/compact/start') {
    console.log(JSON.stringify({ id: message.id, error: { code: -32000, message: 'native compaction unavailable' } }));
  }
}
`,
  );
  const session = providerSession('codex', 'native-full-thread');
  const input = request({
    providerSession: session.value,
    transcript: {
      threadId: 'lark:payments:root',
      loadedAt: new Date().toISOString(),
      entries: [
        {
          id: 'durable-compact-entry',
          runId: 'old-run',
          role: 'user',
          text: 'durable compact fallback marker',
          at: new Date().toISOString(),
          source: 'run',
        },
      ],
      totalEntries: 1,
      omittedEntries: 0,
      truncated: false,
    },
  });
  const result = await createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome: path.join(files.root, 'codex-compact-fallback-home'),
    timeoutMs: 2_000,
  }).run(input.value);

  assert.equal(result.summary, 'Recovered from durable context.');
  assert.equal(await fs.readFile(attemptMarker, 'utf8'), 'durable');
  assert.equal(session.invalidations.length, 1);
  assert.match(session.invalidations[0], /context limit/u);
  assert.deepEqual(session.records, [
    'native-full-thread',
    'durable-fallback-thread',
  ]);
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'progress' &&
        event.item.id === 'codex-context-compaction' &&
        event.item.status === 'failed',
    ),
  );
});

test('Codex app server rebuilds only a missing resumed topic session', async () => {
  const files = await fixture();
  const attemptMarker = path.join(files.root, 'resume-attempt.txt');
  const fakeCli = await files.script(
    'fake-codex-app-server-resume-recovery.mjs',
    `import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === 'thread/resume') {
    await fs.writeFile(${JSON.stringify(attemptMarker)}, message.params.threadId);
    console.log(JSON.stringify({ id: message.id, error: { code: -32001, message: 'codex thread not found' } }));
  }
  if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'rebuilt-topic-thread' } } }));
  if (message.method === 'turn/start') {
    const rebuilt = message.params.input[0].text.includes('durable app-server marker');
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'rebuilt-turn', status: 'inProgress', items: [] } } }));
    console.log(JSON.stringify({ method: 'item/completed', params: { threadId: 'rebuilt-topic-thread', turnId: 'rebuilt-turn', completedAtMs: Date.now(), item: { id: 'answer', type: 'agentMessage', text: JSON.stringify({ rebuilt }) } } }));
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'rebuilt-topic-thread', turn: { id: 'rebuilt-turn', status: 'completed', items: [] } } }));
  }
}
`,
  );
  const session = providerSession('codex', 'missing-topic-thread');
  const input = request({
    providerSession: session.value,
    transcript: {
      threadId: 'lark:payments:root',
      loadedAt: new Date().toISOString(),
      entries: [
        {
          id: 'durable-app-server-entry',
          runId: 'old-run',
          role: 'user',
          text: 'durable app-server marker',
          at: new Date().toISOString(),
          source: 'run',
        },
      ],
      totalEntries: 1,
      omittedEntries: 0,
      truncated: false,
    },
  });
  const result = await createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome: path.join(files.root, 'codex-recovery-home'),
    timeoutMs: 2_000,
  }).run(input.value);

  assert.equal(JSON.parse(result.summary).rebuilt, true);
  assert.equal(await fs.readFile(attemptMarker, 'utf8'), 'missing-topic-thread');
  assert.equal(session.invalidations.length, 1);
  assert.match(session.invalidations[0], /unavailable/u);
  assert.deepEqual(session.records, ['rebuilt-topic-thread']);
});

test('Codex app server interrupts the exact active turn on cancellation', async () => {
  const files = await fixture();
  const interruptMarker = path.join(files.root, 'interrupt.json');
  const turnReadyMarker = path.join(files.root, 'turn-ready');
  const fakeCli = await files.script(
    'fake-codex-app-server-cancel.mjs',
    `import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === 'thread/start') console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'cancel-thread' } } }));
  if (message.method === 'turn/start') {
    await fs.writeFile(${JSON.stringify(turnReadyMarker)}, 'ready');
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'cancel-turn', status: 'inProgress', items: [] } } }));
  }
  if (message.method === 'turn/interrupt') {
    await fs.writeFile(${JSON.stringify(interruptMarker)}, JSON.stringify(message.params));
    console.log(JSON.stringify({ id: message.id, result: {} }));
  }
}
`,
  );
  const controller = new AbortController();
  const execution = createCodexExecutor({
    mode: 'local-cli',
    appServer: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    codexHome: path.join(files.root, 'codex-cancel-home'),
    timeoutMs: 2_000,
  }).run(request({ abortSignal: controller.signal }).value);
  const readyDeadline = Date.now() + 2_000;
  while (true) {
    try {
      await fs.access(turnReadyMarker);
      break;
    } catch {
      if (Date.now() >= readyDeadline) {
        throw new Error('codex_cancel_test_turn_not_ready');
      }
      await delay(10);
    }
  }
  controller.abort('cancelled_from_shared_thread');

  await assert.rejects(execution, /cancelled_from_shared_thread|executor_aborted/u);
  const interrupted = JSON.parse(await fs.readFile(interruptMarker, 'utf8'));
  assert.deepEqual(interrupted, {
    threadId: 'cancel-thread',
    turnId: 'cancel-turn',
  });
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
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Claude handled the project.', total_cost_usd: 0.001, usage: { input_tokens: 20, output_tokens: 8 } }));
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
  assert.deepEqual(result.usage, {
    runs: 1,
    costUsd: 0.001,
    inputTokens: 20,
    outputTokens: 8,
  });
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

test('Claude excludes native mutation tools even when a provider emits stale evidence', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-claude-native.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
await new Promise((resolve) => lines.once('line', resolve));
const args = process.argv.slice(2);
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-edit-1', name: 'Edit', input: { file_path: '/private/secret', new_string: 'must-not-persist' } } } }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-edit-1', content: 'changed' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(args), usage: { input_tokens: 1, output_tokens: 1 } }));
`,
  );
  const input = request();
  input.value.access.grants = [
    { id: 'shell', kind: 'shell', scope: 'project', label: 'Workspace files' },
  ];
  input.value.access.networkPolicy = {
    mode: 'restricted',
    allowedHosts: ['github.com'],
  };
  const executor = createClaudeExecutor({
    mode: 'local-cli',
    command: process.execPath,
    commandPrefixArgs: [fakeCli],
    workspaceRoot: files.root,
    timeoutMs: 2_000,
  });
  const result = await executor.run(input.value);
  const args = JSON.parse(result.summary);
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.deepEqual(
    JSON.parse(args[args.indexOf('--settings') + 1]),
    claudeIsolatedSettings(input.value),
  );
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--no-chrome'));
  const availableTools = args[args.indexOf('--tools') + 1].split(',');
  assert.equal(availableTools.includes('Edit'), false);
  assert.equal(availableTools.includes('Write'), false);
  assert.equal(availableTools.includes('Bash'), false);
  const nativeCall = input.events.find(
    (event) => event.type === 'tool_call' && event.call.name === 'claude.edit',
  );
  assert.ok(nativeCall);
  assert.equal(nativeCall.call.source, 'provider-native');
  assert.equal(nativeCall.call.provider, 'claude');
  assert.equal(nativeCall.call.arguments, undefined);
  const nativeResult = input.events.find(
    (event) => event.type === 'tool_result' && event.call.id === 'native-edit-1',
  );
  assert.equal(nativeResult?.call.status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(input.events), /must-not-persist|private\/secret/u);
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

test('Claude recovers a resumed context overflow once from durable thread context', async () => {
  const files = await fixture();
  const fakeCli = await files.script(
    'fake-claude-context-overflow.mjs',
    `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const first = await new Promise((resolve) => lines.once('line', resolve));
const args = process.argv.slice(2);
if (args.includes('--resume')) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Prompt is too long for the context window' }));
  process.exit(1);
}
const prompt = JSON.parse(first).message.content[0].text;
const detail = JSON.stringify({ args, rebuiltFromTranscript: prompt.includes('claude durable marker') });
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-after-overflow' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: detail }));
`,
  );
  const session = providerSession('claude', 'claude-session-full');
  const input = request({
    providerSession: session.value,
    transcript: {
      threadId: 'lark:payments:root',
      loadedAt: new Date().toISOString(),
      entries: [{
        id: 'claude-durable-user',
        runId: 'claude-durable-run',
        role: 'user',
        text: 'claude durable marker',
        at: new Date().toISOString(),
        source: 'run',
      }],
      totalEntries: 1,
      omittedEntries: 0,
      truncated: false,
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

  assert.equal(detail.args.includes('--resume'), false);
  assert.equal(detail.rebuiltFromTranscript, true);
  assert.equal(session.invalidations.length, 1);
  assert.match(session.invalidations[0], /context limit/);
  assert.deepEqual(session.records, ['claude-session-after-overflow']);
  assert.ok(
    input.events.some(
      (event) =>
        event.type === 'log' &&
        event.message.includes('bounded durable shared-thread context'),
    ),
  );
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
