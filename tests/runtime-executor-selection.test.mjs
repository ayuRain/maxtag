import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenTagRuntime, openTagAbortSummary } from '@opentag/core';

test('user cancellation has a stable public summary', () => {
  const controller = new AbortController();
  controller.abort('lark-card:user:receipt:stop');
  assert.equal(
    openTagAbortSummary(controller.signal, 'executor_aborted_before_start'),
    'Stopped by request.',
  );
  assert.equal(openTagAbortSummary(undefined, 'provider_failed'), 'provider_failed');
});

test('runtime selects the executor configured by the project identity', async () => {
  const calls = [];
  const progress = [];
  const thread = {
    id: 'lark:payments:root',
    platform: 'lark',
    externalId: 'payments:root',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'payments',
    visibility: 'public',
  };
  const message = {
    id: 'message-1',
    threadId: thread.id,
    platform: 'lark',
    text: 'triage this incident',
    actor: { id: 'user-1' },
    createdAt: new Date().toISOString(),
    mentionsAgent: true,
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      async setMessageProcessingReaction(messageId, active) {
        calls.push(`reaction:${messageId}:${active}`);
      },
      createProgressSurface() {
        return {
          async create(value) {
            progress.push(value);
            return { surfaceId: 'surface-1' };
          },
          async update(_id, value) {
            progress.push(value);
          },
          async complete(_id, value) {
            progress.push(value);
          },
        };
      },
      async sendMessage(_thread, text) {
        calls.push(`sent:${text}`);
      },
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run() {
        calls.push('codex');
        return { summary: 'codex', artifacts: [] };
      },
    },
    executors: {
      codex: {
        id: 'codex',
        label: 'Codex',
        async run() {
          calls.push('codex');
          return { summary: 'codex', artifacts: [] };
        },
      },
      claude: {
        id: 'claude',
        label: 'Claude',
        async run() {
          calls.push('claude');
          return { summary: 'handled by Claude', artifacts: [] };
        },
      },
    },
    memory: {
      async loadThreadMemory() {
        return '';
      },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getWorkspace() {
        return { id: 'acme', name: 'Acme' };
      },
      async getProject() {
        return { id: 'acme:payments', workspaceId: 'acme', key: 'payments', name: 'Payments' };
      },
      async getIdentity() {
        return {
          id: 'payments-agent',
          displayName: 'Payments Copilot',
          instructions: 'Own payment incidents.',
          defaultExecutorId: 'claude',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-1',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  const result = await runtime.handleMessage({
    runId: 'run-1',
    thread,
    message,
  });

  assert.equal(result.summary, 'handled by Claude');
  assert.deepEqual(calls, [
    'reaction:message-1:true',
    'claude',
    'sent:handled by Claude',
    'reaction:message-1:false',
  ]);
  assert.ok(
    progress.some((entry) =>
      entry.checklist.some((item) => item.label === 'Run Claude'),
    ),
  );
});

test('runtime progress incorporates live follow-ups, delegated work, and pending decisions', async () => {
  const progress = [];
  let steeringDelivered = false;
  const thread = {
    id: 'lark:payments:collaboration',
    platform: 'lark',
    externalId: 'payments:collaboration',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'payments',
    visibility: 'private',
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        const record = (state) => progress.push(structuredClone(state));
        return {
          async create(state) {
            record(state);
            return { surfaceId: 'collaboration-card' };
          },
          async update(_id, state) { record(state); },
          async complete(_id, state) { record(state); },
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      steeringMode: 'live',
      async run(request) {
        const followUp = await request.steering.receive();
        assert.equal(followUp.message.text, '请同时检查数据库延迟。');
        await request.steering.acknowledge(followUp.id, 'merged');
        await request.onEvent({
          type: 'delegation',
          invocationId: 'delegate-1',
          agentId: 'release-reviewer',
          executorId: 'codex',
          status: 'running',
          taskPreview: '复核发布证据',
        });
        await request.onEvent({
          type: 'delegation',
          invocationId: 'delegate-1',
          agentId: 'release-reviewer',
          executorId: 'codex',
          status: 'completed',
          summaryPreview: '证据完整',
        });
        await request.onEvent({
          type: 'tool_result',
          call: {
            id: 'workspace-1',
            name: 'workspace_run',
            title: '运行项目命令',
            grantKind: 'shell',
            risk: 'write',
            status: 'succeeded',
            durationMs: 50_000,
            resultPreview: '#24 pushing layers 82%',
          },
        });
        await request.onEvent({
          type: 'tool_call',
          call: {
            id: 'tool-1',
            name: 'github_issue_create',
            title: '创建 GitHub Issue',
            grantKind: 'github',
            risk: 'write',
          },
        });
        await request.onEvent({
          type: 'tool_approval',
          approval: {
            id: 'approval-1',
            status: 'pending',
            runId: request.runId,
            toolCallId: 'tool-1',
            toolName: 'github_issue_create',
            title: '创建 GitHub Issue',
            grantKind: 'github',
            risk: 'write',
            arguments: {},
            argumentSummary: {},
            argumentDigest: 'digest',
            platform: 'lark',
            thread,
            threadId: thread.id,
            requestedBy: 'agent:maxtag',
            requestedAt: '2026-08-15T00:00:00.000Z',
            expiresAt: '2026-08-15T00:15:00.000Z',
          },
        });
        await request.onEvent({
          type: 'tool_result',
          call: {
            id: 'tool-1',
            name: 'github_issue_create',
            title: '创建 GitHub Issue',
            grantKind: 'github',
            risk: 'write',
            status: 'pending_approval',
            durationMs: 10,
          },
        });
        return { summary: '等待批准后继续。', artifacts: [] };
      },
    },
    memory: {
      async loadThreadMemory() { return ''; },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getIdentity() {
        return {
          id: 'maxtag',
          displayName: 'MaxTag',
          instructions: '',
          defaultExecutorId: 'codex',
        };
      },
      async getAccessBundle() {
        return {
          id: 'collaboration-access',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  await runtime.handleMessage({
    runId: 'collaboration-run',
    thread,
    message: {
      id: 'collaboration-message',
      threadId: thread.id,
      platform: 'lark',
      text: '完成一次长任务。',
      actor: { id: 'user-1' },
      createdAt: '2026-08-15T00:00:00.000Z',
      mentionsAgent: true,
    },
    steering: {
      async open(mode) {
        assert.equal(mode, 'live');
        return {
          mode,
          async receive() {
            if (steeringDelivered) return undefined;
            steeringDelivered = true;
            return {
              id: 'steering-1',
              targetRunId: 'collaboration-run',
              receivedAt: '2026-08-15T00:00:01.000Z',
              thread,
              message: {
                id: 'follow-up-message',
                threadId: thread.id,
                platform: 'lark',
                text: '请同时检查数据库延迟。',
                actor: { id: 'user-2' },
                createdAt: '2026-08-15T00:00:01.000Z',
                mentionsAgent: true,
              },
            };
          },
          async acknowledge() {},
        };
      },
    },
  });

  assert.ok(progress.some((state) => state.status === 'waiting'));
  assert.ok(
    progress.some((state) =>
      state.checklist.some(
        (item) => item.id === 'work' && item.detail === '#24 pushing layers 82%',
      ),
    ),
  );
  assert.ok(
    progress.some((state) =>
      state.checklist.some(
        (item) => item.id === 'followups' && item.status === 'done',
      ),
    ),
  );
  assert.ok(
    progress.some((state) =>
      state.checklist.some(
        (item) => item.id === 'agent:delegate-1' && item.status === 'done',
      ),
    ),
  );
  assert.ok(
    progress.some((state) =>
      state.checklist.some(
        (item) => item.id === 'tool:tool-1' && item.status === 'pending',
      ),
    ),
  );
  assert.equal(progress.at(-1).status, 'completed');
});

test('runtime resolves only currently enabled route skill summaries before execution', async () => {
  let executorRequest;
  const thread = {
    id: 'lark:payments:skills',
    platform: 'lark',
    externalId: 'payments:skills',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'oc_payments',
    visibility: 'public',
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create() { return { surfaceId: 'skills-surface' }; },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run(request) {
        executorRequest = request;
        return { summary: 'done', artifacts: [] };
      },
    },
    memory: {
      async loadThreadMemory() { return ''; },
      async remember() {},
      async forget() {},
    },
    skills: {
      async list(input) {
        assert.deepEqual(input, {
          ids: ['workspace-baseline', 'disabled-project-skill'],
        });
        return [
          {
            id: 'workspace-baseline',
            name: 'Workspace baseline',
            description: 'Follow the organization evidence contract.',
            content: 'This body must not be copied into the runtime request.',
            enabled: true,
            revision: 3,
            createdAt: '2026-08-13T00:00:00.000Z',
            updatedAt: '2026-08-13T01:00:00.000Z',
          },
        ];
      },
      async get() { return undefined; },
    },
    delegatedAgents: {
      async list(input) {
        assert.deepEqual(input, {
          ids: ['evidence-reviewer', 'disabled-reviewer'],
        });
        return [
          {
            id: 'evidence-reviewer',
            name: 'Evidence reviewer',
            description: 'Review bounded route evidence.',
            instructions: 'This delegated body must not enter the parent request.',
            executorId: 'codex',
            model: 'gpt-5.6-luna',
            enabled: true,
            revision: 2,
            skillIds: ['workspace-baseline'],
            grantKinds: ['shell'],
            memoryScopes: ['project'],
            networkHosts: [],
            maxTurns: 6,
            timeoutMs: 60_000,
            createdAt: '2026-08-13T00:00:00.000Z',
            updatedAt: '2026-08-13T01:00:00.000Z',
          },
        ];
      },
      async get() { return undefined; },
    },
    knowledgeSources: {
      async list(input) {
        assert.deepEqual(input, {
          workspaceId: 'acme',
          ids: ['release-handbook', 'disabled-handbook'],
        });
        return [{
          id: 'release-handbook',
          workspaceId: 'acme',
          name: 'Release handbook',
          description: 'Approved release evidence.',
          kind: 'text',
          mediaType: 'text/markdown',
          content: 'This source body must stay behind broker tools.',
          contentHash: 'a'.repeat(64),
          sizeBytes: 47,
          enabled: true,
          revision: 4,
          createdAt: '2026-08-13T00:00:00.000Z',
          updatedAt: '2026-08-13T01:00:00.000Z',
        }];
      },
      async get() { return undefined; },
      async search() { return []; },
    },
    threadConfig: {
      async getWorkspace() { return { id: 'acme', name: 'Acme' }; },
      async getProject() {
        return {
          id: 'acme:payments',
          workspaceId: 'acme',
          key: 'payments',
          name: 'Payments',
        };
      },
      async getIdentity() {
        return {
          id: 'opentag',
          displayName: 'MaxTag',
          instructions: 'Follow route policy.',
          defaultExecutorId: 'codex',
        };
      },
      async getAccessBundle() {
        return {
          id: 'skills-access',
          threadId: thread.id,
          skillIds: ['workspace-baseline', 'disabled-project-skill'],
          agentIds: ['evidence-reviewer', 'disabled-reviewer'],
          knowledgeSourceIds: ['release-handbook', 'disabled-handbook'],
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  await runtime.handleMessage({
    runId: 'skills-runtime-run',
    thread,
    message: {
      id: 'skills-message',
      threadId: thread.id,
      platform: 'lark',
      text: 'Use the workspace procedure.',
      actor: { id: 'user-1' },
      createdAt: '2026-08-13T02:00:00.000Z',
      mentionsAgent: true,
    },
  });
  assert.deepEqual(executorRequest.skills, [
    {
      id: 'workspace-baseline',
      name: 'Workspace baseline',
      description: 'Follow the organization evidence contract.',
      revision: 3,
    },
  ]);
  assert.equal(JSON.stringify(executorRequest).includes('This body must not'), false);
  assert.deepEqual(executorRequest.delegatedAgents, [
    {
      id: 'evidence-reviewer',
      name: 'Evidence reviewer',
      description: 'Review bounded route evidence.',
      executorId: 'codex',
      revision: 2,
    },
  ]);
  assert.equal(
    JSON.stringify(executorRequest).includes('This delegated body must not'),
    false,
  );
  assert.equal(JSON.stringify(executorRequest).includes('gpt-5.6-luna'), false);
  assert.deepEqual(executorRequest.knowledgeSources, [{
    id: 'release-handbook',
    workspaceId: 'acme',
    name: 'Release handbook',
    description: 'Approved release evidence.',
    kind: 'text',
    mediaType: 'text/markdown',
    contentHash: 'a'.repeat(64),
    sizeBytes: 47,
    enabled: true,
    revision: 4,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T01:00:00.000Z',
  }]);
  assert.equal(
    JSON.stringify(executorRequest).includes('This source body must stay'),
    false,
  );
});

test('runtime can execute routine work without publishing progress or result chatter', async () => {
  const visible = [];
  const thread = {
    id: 'lark:payments:quiet',
    platform: 'lark',
    externalId: 'payments:quiet',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'payments',
    visibility: 'private',
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        throw new Error('silent_routine_must_not_create_progress');
      },
      async sendMessage() {
        visible.push('message');
      },
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run() {
        return { summary: 'quiet result', artifacts: [] };
      },
    },
    memory: {
      async loadThreadMemory() { return ''; },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getIdentity() {
        return {
          id: 'payments-agent',
          displayName: 'Payments',
          instructions: '',
          defaultExecutorId: 'codex',
        };
      },
      async getAccessBundle() {
        return {
          id: 'quiet-access',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });
  const result = await runtime.handleMessage({
    runId: 'quiet-routine-run',
    thread,
    message: {
      id: 'routine:quiet',
      threadId: thread.id,
      platform: 'lark',
      text: 'check quietly',
      actor: { id: 'routine:quiet', isBot: true },
      createdAt: '2026-08-11T10:00:00.000Z',
      mentionsAgent: true,
    },
    publishResult: false,
  });
  assert.equal(result.summary, 'quiet result');
  assert.deepEqual(visible, []);
});

test('runtime queues only authorized non-sensitive memory candidates for approval', async () => {
  const events = [];
  const proposed = [];
  const thread = {
    id: 'lark:payments:root',
    platform: 'lark',
    externalId: 'payments:root',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'oc_payments',
    visibility: 'private',
  };
  const message = {
    id: 'message-memory-1',
    threadId: thread.id,
    platform: 'lark',
    text: 'Choose the durable runtime mode.',
    actor: { id: 'user-1' },
    createdAt: new Date().toISOString(),
    mentionsAgent: true,
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create() { return { surfaceId: 'surface-memory' }; },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run() {
        return {
          summary: 'SQLite WAL selected.',
          artifacts: [],
          memoryCandidates: [
            { scope: 'project', text: 'Use SQLite WAL for shared workers.' },
            { scope: 'project', text: '  Use   SQLite WAL for shared workers.  ' },
            { scope: 'channel', text: 'Verification Token: should-not-persist' },
            { scope: 'thread', text: 'Keep this decision in the current thread.' },
          ],
        };
      },
    },
    memory: {
      async loadThreadMemory() { return ''; },
      async remember() { throw new Error('automatic_memory_must_not_write'); },
      async forget() {},
      async proposeMemory(input) {
        proposed.push(input);
        return {
          id: `proposal-${proposed.length}`,
          status: 'pending',
          action: input.action,
          scope: input.scope,
          documentKey: `${input.scope}:test`,
          scopeRef: { kind: input.scope, label: input.scope },
          thread: input.thread,
          workspace: input.workspace,
          project: input.project,
          value: input.value,
          actorId: input.actorId,
          source: input.source,
          reason: input.reason,
          createdAt: new Date().toISOString(),
        };
      },
    },
    threadConfig: {
      async getWorkspace() { return { id: 'acme', name: 'Acme' }; },
      async getProject() {
        return { id: 'acme:payments', workspaceId: 'acme', key: 'payments', name: 'Payments' };
      },
      async getIdentity() {
        return {
          id: 'payments-agent',
          displayName: 'Payments Copilot',
          instructions: 'Own payment incidents.',
          defaultExecutorId: 'codex',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-memory',
          threadId: thread.id,
          grants: [
            {
              id: 'project-memory',
              kind: 'memory',
              scope: 'project',
              label: 'Project memory',
              constraints: { permissions: ['read', 'write'] },
            },
          ],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
          memoryRetentionDays: { project: 45 },
        };
      },
    },
  });

  const result = await runtime.handleMessage({
    runId: 'run-memory-1',
    thread,
    message,
    onEvent(event) { events.push(event); },
  });

  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].scope, 'project');
  assert.equal(proposed[0].value, 'Use SQLite WAL for shared workers.');
  assert.equal(proposed[0].source, 'agent-run:run-memory-1');
  assert.equal(proposed[0].retentionDays, 45);
  assert.equal(result.memoryProposals.length, 1);
  assert.equal(events.filter((event) => event.type === 'memory_proposal').length, 1);
});

test('runtime closes the progress surface when a configured executor is unavailable', async () => {
  const completed = [];
  const reactions = [];
  const thread = {
    id: 'lark:payments:root',
    platform: 'lark',
    externalId: 'payments:root',
    workspaceId: 'acme',
    projectId: 'payments',
    visibility: 'public',
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      async setMessageProcessingReaction(messageId, active) {
        reactions.push([messageId, active]);
      },
      createProgressSurface() {
        return {
          async create() {
            return { surfaceId: 'surface-1' };
          },
          async update() {},
          async complete(_id, value) {
            completed.push(value);
          },
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run() {
        return { summary: 'codex', artifacts: [] };
      },
    },
    executors: {
      codex: {
        id: 'codex',
        label: 'Codex',
        async run() {
          return { summary: 'codex', artifacts: [] };
        },
      },
    },
    memory: {
      async loadThreadMemory() {
        return '';
      },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getIdentity() {
        return {
          id: 'payments-agent',
          displayName: 'Payments Copilot',
          instructions: 'Own payment incidents.',
          defaultExecutorId: 'missing',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-1',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  await assert.rejects(
    runtime.handleMessage({
      runId: 'run-2',
      thread,
      message: {
        id: 'message-2',
        threadId: thread.id,
        platform: 'lark',
        text: 'handle this',
        actor: { id: 'user-1' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
    }),
    /executor_not_available:missing/,
  );

  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'failed');
  assert.equal(completed[0].summary, 'executor_not_available:missing');
  assert.equal(completed[0].checklist[0].status, 'failed');
  assert.deepEqual(reactions, [
    ['message-2', true],
    ['message-2', false],
  ]);
});

test('runtime exposes a live steering channel to a capable executor', async () => {
  const calls = [];
  const thread = {
    id: 'lark:live:root',
    platform: 'lark',
    externalId: 'live:root',
    workspaceId: 'acme',
    projectId: 'live',
    visibility: 'public',
  };
  const followUp = {
    id: 'steering-1',
    targetRunId: 'run-live',
    receivedAt: new Date().toISOString(),
    thread,
    message: {
      id: 'message-follow-up',
      threadId: thread.id,
      platform: 'lark',
      text: 'Check the database first.',
      actor: { id: 'user-2' },
    },
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create() {
            return { surfaceId: 'surface-live' };
          },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'live',
      label: 'Live executor',
      steeringMode: 'live',
      async run(request) {
        assert.equal(request.steering.mode, 'live');
        const input = await request.steering.receive({ waitMs: 10 });
        calls.push(input.message.text);
        await request.steering.acknowledge(input.id, 'Applied in place');
        return { summary: 'Steered result', artifacts: [] };
      },
    },
    memory: {
      async loadThreadMemory() {
        return '';
      },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getIdentity() {
        return {
          id: 'live-agent',
          displayName: 'Live agent',
          instructions: 'Handle live input.',
          defaultExecutorId: 'live',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-live',
          threadId: thread.id,
          grants: [],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  const result = await runtime.handleMessage({
    runId: 'run-live',
    thread,
    message: {
      id: 'message-live',
      threadId: thread.id,
      platform: 'lark',
      text: 'Investigate the incident.',
      actor: { id: 'user-1' },
    },
    steering: {
      async open(mode) {
        calls.push(`mode:${mode}`);
        let delivered = false;
        return {
          mode,
          async receive() {
            if (delivered) return undefined;
            delivered = true;
            return followUp;
          },
          async acknowledge(id, detail) {
            calls.push(`ack:${id}:${detail}`);
          },
        };
      },
    },
  });

  assert.equal(result.summary, 'Steered result');
  assert.deepEqual(calls, [
    'mode:live',
    'Check the database first.',
    'ack:steering-1:Applied in place',
  ]);
});

test('runtime loads only memory scopes granted by the resolved project policy', async () => {
  const loaded = [];
  const received = [];
  const thread = {
    id: 'lark:legal:root',
    platform: 'lark',
    externalId: 'legal:root',
    workspaceId: 'acme',
    projectId: 'legal',
    visibility: 'public',
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create() {
            return { surfaceId: 'surface-memory' };
          },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run(request) {
        received.push({
          scopes: request.memorySnapshot.scopes.map((item) => item.scope.kind),
          workspacePermissions: request.access.grants.find(
            (grant) => grant.kind === 'memory' && grant.scope === 'workspace',
          )?.constraints?.permissions,
        });
        return { summary: 'done', artifacts: [] };
      },
    },
    memory: {
      async loadMemory(query) {
        loaded.push(query.scopes);
        return {
          loadedAt: new Date().toISOString(),
          scopes: query.scopes.map((kind) => ({
            scope: { kind, label: kind },
            content: kind,
          })),
          text: query.scopes.join(','),
        };
      },
      async loadThreadMemory() {
        throw new Error('legacy memory path should not be used');
      },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getWorkspace() {
        return { id: 'acme', name: 'Acme' };
      },
      async getProject() {
        return { id: 'acme:legal', workspaceId: 'acme', key: 'legal', name: 'Legal' };
      },
      async getIdentity() {
        return {
          id: 'acme-agent',
          displayName: 'Acme Tag',
          instructions: 'Serve Acme.',
          defaultExecutorId: 'codex',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-legal',
          threadId: thread.id,
          workspaceId: 'acme',
          projectId: 'acme:legal',
          grants: [
            {
              id: 'memory:global',
              kind: 'memory',
              scope: 'global',
              label: 'Legacy installation memory',
              constraints: { permissions: ['read'] },
            },
            {
              id: 'memory:project',
              kind: 'memory',
              scope: 'project',
              label: 'Project memory',
              constraints: { permissions: ['read', 'write'] },
            },
            {
              id: 'memory:workspace',
              kind: 'memory',
              scope: 'workspace',
              label: 'Workspace memory',
              constraints: { permissions: ['read', 'write'] },
            },
            {
              id: 'memory:channel',
              kind: 'memory',
              scope: 'channel',
              label: 'Channel memory',
              constraints: { permissions: ['read', 'write'] },
            },
            {
              id: 'memory:thread',
              kind: 'memory',
              scope: 'thread',
              label: 'Thread memory',
              constraints: { permissions: ['read', 'write'] },
            },
          ],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  await runtime.handleMessage({
    runId: 'run-memory-policy',
    thread,
    workspaceMemoryWriteAllowed: false,
    message: {
      id: 'message-memory-policy',
      threadId: thread.id,
      platform: 'lark',
      text: 'Review the contract.',
      actor: { id: 'user-1' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
  });

  assert.deepEqual(loaded, [['workspace', 'project', 'channel', 'thread']]);
  assert.deepEqual(received, [
    {
      scopes: ['workspace', 'project', 'channel', 'thread'],
      workspacePermissions: ['read'],
    },
  ]);
});

test('runtime sends only retrieved memory to the selected project agent', async () => {
  const received = [];
  const events = [];
  const thread = {
    id: 'lark:payments:retrieval',
    platform: 'lark',
    externalId: 'payments:retrieval',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'oc_payments',
    visibility: 'private',
  };
  const now = new Date().toISOString();
  const projectDocument = {
    key: 'project:acme:acme_payments',
    scope: {
      kind: 'project',
      workspaceId: 'acme',
      projectId: 'acme:payments',
      label: 'Project memory',
    },
    content: 'Relevant database decision.\nUnrelated launch color.',
    version: 4,
    createdAt: now,
    updatedAt: now,
    updatedBy: 'operator:owner',
    latestRevisionId: 'revision-4',
  };
  const fullSnapshot = {
    loadedAt: now,
    scopes: [
      {
        scope: projectDocument.scope,
        content: projectDocument.content,
        document: projectDocument,
      },
    ],
    text: `## Project memory\n${projectDocument.content}`,
  };
  const selectedSnapshot = {
    loadedAt: now,
    scopes: [
      {
        scope: projectDocument.scope,
        content: '[line 1] Relevant database decision.',
        document: projectDocument,
      },
    ],
    text: '## Project memory [scope=project version=4]\n[line 1] Relevant database decision.',
  };
  const runtime = new OpenTagRuntime({
    platform: {
      kind: 'lark',
      capabilities: {
        supportsThreads: true,
        supportsCards: true,
        supportsFiles: true,
        supportsReactions: true,
        supportsMentions: true,
      },
      createProgressSurface() {
        return {
          async create() { return { surfaceId: 'surface-retrieval' }; },
          async update() {},
          async complete() {},
        };
      },
      async sendMessage() {},
    },
    executor: {
      id: 'codex',
      label: 'Codex',
      async run(request) {
        received.push(request);
        return { summary: 'Use Postgres.', artifacts: [] };
      },
    },
    memoryRetriever: {
      async retrieve(input) {
        assert.equal(input.memorySnapshot, fullSnapshot);
        return {
          snapshot: selectedSnapshot,
          strategy: 'semantic',
          candidateLines: 2,
          selectedLines: 1,
          durationMs: 12,
        };
      },
    },
    memory: {
      async loadMemory() { return fullSnapshot; },
      async loadThreadMemory() { throw new Error('legacy_memory_not_expected'); },
      async remember() {},
      async forget() {},
    },
    threadConfig: {
      async getWorkspace() { return { id: 'acme', name: 'Acme' }; },
      async getProject() {
        return {
          id: 'acme:payments',
          workspaceId: 'acme',
          key: 'payments',
          name: 'Payments',
        };
      },
      async getIdentity() {
        return {
          id: 'payments-agent',
          displayName: 'Payments Copilot',
          instructions: 'Own payments.',
          defaultExecutorId: 'codex',
        };
      },
      async getAccessBundle() {
        return {
          id: 'access-retrieval',
          threadId: thread.id,
          grants: [{
            id: 'memory:project',
            kind: 'memory',
            scope: 'project',
            label: 'Project memory',
            constraints: { permissions: ['read'] },
          }],
          networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
        };
      },
    },
  });

  await runtime.handleMessage({
    runId: 'run-retrieval-runtime',
    thread,
    message: {
      id: 'message-retrieval-runtime',
      threadId: thread.id,
      platform: 'lark',
      text: 'Which database?',
      actor: { id: 'owner' },
      createdAt: now,
      mentionsAgent: true,
    },
    onEvent(event) { events.push(event); },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].memorySnapshot, selectedSnapshot);
  assert.match(received[0].memory, /Relevant database decision/u);
  assert.doesNotMatch(received[0].memory, /Unrelated launch color/u);
  assert.deepEqual(events.find((event) => event.type === 'memory_retrieval'), {
    type: 'memory_retrieval',
    strategy: 'semantic',
    candidateLines: 2,
    selectedLines: 1,
    durationMs: 12,
    fallbackReason: undefined,
  });
});
