import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DelegatedAgentRevisionConflictError,
  FileAgentSkillStore,
  FileDelegatedAgentStore,
  FileDelegatedAgentTaskStore,
  FileThreadConfigStore,
} from '@opentag/config';
import { FileDeliveryStore } from '@opentag/delivery';
import { ScopedFileMemoryStore } from '@opentag/memory';
import { createOpenTagToolBroker } from '@opentag/tool-broker';

function route(projectId, channelId) {
  return {
    id: `lark:${channelId}:root`,
    platform: 'lark',
    externalId: `${channelId}:root`,
    workspaceId: 'acme',
    projectId,
    channelId,
    visibility: 'public',
  };
}

function textResult(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

test('delegated agent catalog is cross-process, revisioned, and rejects credentials', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-agents-store-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = new FileDelegatedAgentStore(root);
  const worker = new FileDelegatedAgentStore(root);
  const created = await server.upsert({
    id: 'evidence-reviewer',
    name: 'Evidence reviewer',
    description: 'Review bounded evidence without modifying the workspace.',
    instructions: 'Read the supplied route evidence and report concrete gaps.',
    executorId: 'codex',
    model: 'gpt-5.6-luna',
    skillIds: ['release-proof'],
    grantKinds: ['shell'],
    memoryScopes: ['project'],
    networkHosts: ['docs.example.com'],
    maxTurns: 8,
    timeoutMs: 90_000,
    expectedRevision: 0,
  });
  assert.equal(created.revision, 1);
  assert.equal((await worker.get(created.id)).model, 'gpt-5.6-luna');

  await assert.rejects(
    worker.upsert({
      ...created,
      instructions: 'Stale edit.',
      expectedRevision: 0,
    }),
    (error) =>
      error instanceof DelegatedAgentRevisionConflictError &&
      error.currentRevision === 1,
  );
  await assert.rejects(
    server.upsert({
      id: 'unsafe-reviewer',
      name: 'Unsafe reviewer',
      description: 'Must be rejected.',
      instructions: 'api_key = do-not-store-this',
      executorId: 'codex',
    }),
    /delegated_agent_credentials_not_allowed/u,
  );
  await server.setEnabled({
    id: created.id,
    enabled: false,
    expectedRevision: 1,
  });
  assert.deepEqual(await worker.list({ ids: [created.id] }), []);
});

test('workspace project and channel delegated agents merge without sibling leakage', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-agents-route-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileThreadConfigStore(root, {
    workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
  });
  await store.upsertWorkspacePolicy({
    workspaceId: 'acme',
    agentIds: ['evidence-reviewer'],
  });
  await store.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'payments',
    agentIds: ['release-reviewer'],
  });
  await store.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'support',
    agentIds: ['return-reviewer'],
  });
  await store.upsertChannelPolicy({
    workspaceId: 'acme',
    projectId: 'payments',
    platform: 'lark',
    channelId: 'oc_incidents',
    agentIds: ['incident-reviewer'],
  });

  assert.deepEqual(
    (await store.resolveThreadPolicy(route('payments', 'oc_incidents'))).access
      .agentIds,
    ['evidence-reviewer', 'release-reviewer', 'incident-reviewer'],
  );
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('payments', 'oc_general'))).access
      .agentIds,
    ['evidence-reviewer', 'release-reviewer'],
  );
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('support', 'oc_support'))).access
      .agentIds,
    ['evidence-reviewer', 'return-reviewer'],
  );
});

test('broker invokes only assigned enabled agents with a read-only parent subset', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-agents-broker-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverAgents = new FileDelegatedAgentStore(path.join(root, 'config'));
  const workerAgents = new FileDelegatedAgentStore(path.join(root, 'config'));
  const skills = new FileAgentSkillStore(path.join(root, 'config'));
  const tasks = new FileDelegatedAgentTaskStore(path.join(root, 'config'));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  await skills.upsert({
    id: 'release-proof',
    name: 'Release proof',
    description: 'Verify release evidence.',
    content: 'Separate build, deployment, and client receipt.',
  });
  const definition = await serverAgents.upsert({
    id: 'evidence-reviewer',
    name: 'Evidence reviewer',
    description: 'Review bounded route evidence.',
    instructions: 'Find the strongest verified evidence and remaining gaps.',
    executorId: 'fake',
    skillIds: ['release-proof', 'not-on-parent-route'],
    grantKinds: ['shell', 'browser', 'memory'],
    memoryScopes: ['project', 'workspace'],
    networkHosts: ['docs.example.com', 'blocked.example.com'],
    timeoutMs: 30_000,
  });
  let delegatedRequest;
  let budgetAllowed = true;
  let budgetChecks = 0;
  const fakeExecutor = {
    id: 'fake',
    label: 'Fake delegated executor',
    async run(request) {
      delegatedRequest = request;
      await request.onEvent?.({
        type: 'tool_call',
        call: {
          id: 'child-tool-call',
          name: 'workspace_read',
          title: 'Read workspace file',
          grantKind: 'shell',
          risk: 'read',
          provider: 'opentag:workspace',
        },
      });
      await request.onEvent?.({
        type: 'tool_result',
        call: {
          id: 'child-tool-call',
          name: 'workspace_read',
          title: 'Read workspace file',
          grantKind: 'shell',
          risk: 'read',
          provider: 'opentag:workspace',
          status: 'succeeded',
          durationMs: 4,
        },
      });
      return {
        summary: 'Verified the release evidence; client receipt is still missing.',
        artifacts: [],
        usage: { runs: 1, costUsd: 0.002, inputTokens: 120, outputTokens: 35 },
      };
    },
  };
  const events = [];
  const request = {
    runId: 'parent-run',
    workspace: { id: 'acme', name: 'Acme' },
    project: {
      id: 'acme:payments',
      workspaceId: 'acme',
      key: 'payments',
      name: 'Payments',
    },
    thread: route('payments', 'oc_incidents'),
    message: {
      id: 'message-1',
      threadId: 'lark:oc_incidents:root',
      platform: 'lark',
      text: 'Review the release.',
      actor: { id: 'user-1', displayName: 'Ada' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
    identity: {
      id: 'opentag',
      displayName: 'MaxTag',
      instructions: 'Coordinate the route.',
      defaultExecutorId: 'codex',
    },
    access: {
      id: 'access-1',
      threadId: 'lark:oc_incidents:root',
      workspaceId: 'acme',
      projectId: 'acme:payments',
      skillIds: ['release-proof'],
      agentIds: ['evidence-reviewer'],
      grants: [
        {
          id: 'shell:project:acme:payments',
          kind: 'shell',
          scope: 'project',
          label: 'Workspace',
          constraints: { permissions: ['read', 'write'], commands: ['npm'] },
        },
        {
          id: 'browser:project:acme:payments',
          kind: 'browser',
          scope: 'project',
          label: 'Browser',
          constraints: { permissions: ['read'] },
        },
        {
          id: 'memory:project:acme:payments',
          kind: 'memory',
          scope: 'project',
          label: 'Project memory',
          constraints: { permissions: ['read', 'write'] },
        },
      ],
      networkPolicy: {
        mode: 'restricted',
        allowedHosts: ['docs.example.com'],
      },
    },
    skills: [
      {
        id: 'release-proof',
        name: 'Release proof',
        description: 'Verify release evidence.',
        revision: 1,
      },
    ],
    delegatedAgents: [
      {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        executorId: definition.executorId,
        revision: definition.revision,
      },
    ],
    memory: 'Project approved fact. Workspace fact must not pass.',
    memorySnapshot: {
      loadedAt: new Date().toISOString(),
      scopes: [
        {
          scope: {
            kind: 'workspace',
            workspaceId: 'acme',
            label: 'Workspace memory',
          },
          content: 'Workspace fact must not pass.',
        },
        {
          scope: {
            kind: 'project',
            workspaceId: 'acme',
            projectId: 'acme:payments',
            label: 'Project memory',
          },
          content: 'Project approved fact.',
        },
      ],
      text: 'Workspace fact must not pass.\nProject approved fact.',
    },
    onEvent: (event) => events.push(event),
  };
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    skills,
    delegatedAgents: {
      source: workerAgents,
      tasks,
      async beforeInvoke({ request: parentRequest, definition: checkedAgent }) {
        budgetChecks += 1;
        assert.equal(parentRequest.runId, 'parent-run');
        assert.equal(checkedAgent.id, 'evidence-reviewer');
        if (!budgetAllowed) throw new Error('usage_budget_denied:project');
      },
      resolveExecutor: (agent) => (agent.executorId === 'fake' ? fakeExecutor : undefined),
    },
  });
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'opentag-agents-test', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());
  const parentToolNames = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(parentToolNames.includes('agent_invoke'));
  assert.ok(parentToolNames.includes('agents_list'));
  assert.ok(parentToolNames.includes('agent_tasks_list'));
  assert.ok(parentToolNames.includes('agent_task_create'));
  assert.ok(parentToolNames.includes('agent_task_cancel'));
  assert.ok(parentToolNames.includes('skills_load'));
  const listed = await client.callTool({ name: 'agents_list', arguments: {} });
  assert.match(textResult(listed), /evidence-reviewer/u);

  const invoked = await client.callTool({
    name: 'agent_invoke',
    arguments: { id: 'evidence-reviewer', task: 'Review the available release proof.' },
  });
  assert.match(textResult(invoked), /client receipt is still missing/u);
  assert.equal(budgetChecks, 1);
  assert.ok(delegatedRequest);
  assert.deepEqual(delegatedRequest.access.agentIds, []);
  assert.equal(delegatedRequest.delegation.parentRunId, 'parent-run');
  assert.equal(delegatedRequest.transcript, undefined);
  assert.equal(delegatedRequest.providerSession, undefined);
  assert.deepEqual(delegatedRequest.skills.map((skill) => skill.id), ['release-proof']);
  assert.deepEqual(
    delegatedRequest.access.grants.map((grant) => ({
      id: grant.id,
      permissions: grant.constraints.permissions,
    })),
    [
      { id: 'shell:project:acme:payments', permissions: ['read'] },
      { id: 'browser:project:acme:payments', permissions: ['read'] },
    ],
  );
  assert.deepEqual(delegatedRequest.access.networkPolicy, {
    mode: 'restricted',
    allowedHosts: ['docs.example.com'],
  });
  assert.deepEqual(
    delegatedRequest.memorySnapshot.scopes.map((entry) => entry.scope.kind),
    ['project'],
  );
  assert.doesNotMatch(delegatedRequest.memory, /Workspace fact/u);
  assert.deepEqual(
    events.filter((event) => event.type === 'delegation').map((event) => event.status),
    ['running', 'completed'],
  );
  const invocationId = events.find((event) => event.type === 'delegation').invocationId;
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_call' || event.type === 'tool_result')
      .filter((event) => event.call.provider?.startsWith('delegated:'))
      .map((event) => event.call.provider),
    [
      `delegated:evidence-reviewer:${invocationId}:opentag:workspace`,
      `delegated:evidence-reviewer:${invocationId}:opentag:workspace`,
    ],
  );
  const childSession = await broker.open(delegatedRequest);
  assert.ok(childSession);
  context.after(() => childSession.close());
  const childToolNames = childSession.tools.map((tool) => tool.name).sort();
  assert.deepEqual(childToolNames, [
    'browser_fetch',
    'skills_list',
    'skills_load',
    'workspace_capabilities',
    'workspace_list',
    'workspace_read',
    'workspace_search',
  ]);
  assert.doesNotMatch(childToolNames.join(','), /agent_invoke|workspace_write|workspace_run/u);

  const pendingTask = await client.callTool({
    name: 'agent_task_create',
    arguments: {
      id: definition.id,
      task: 'Review this proof asynchronously and report back to the same thread.',
    },
  });
  assert.match(textResult(pendingTask), /pendingApproval/u);
  let [taskApproval] = await approvals.listToolApprovals({
    runId: request.runId,
    status: 'pending',
  });
  assert.equal(taskApproval.toolName, 'agent_task_create');
  await approvals.approveToolApproval({ id: taskApproval.id, actorId: 'operator:ada' });
  const taskExecution = await broker.executeApproved({
    approvalId: taskApproval.id,
    request,
    claimedBy: 'worker-a',
  });
  assert.equal(taskExecution.approval.status, 'succeeded');
  const [createdTask] = await tasks.list({
    workspaceId: 'acme',
    threadId: request.thread.id,
  });
  assert.equal(createdTask.status, 'queued');
  assert.equal(createdTask.agentId, definition.id);

  const pendingCancel = await client.callTool({
    name: 'agent_task_cancel',
    arguments: { taskId: createdTask.id },
  });
  assert.match(textResult(pendingCancel), /pendingApproval/u);
  [taskApproval] = await approvals.listToolApprovals({
    runId: request.runId,
    status: 'pending',
  });
  assert.equal(taskApproval.toolName, 'agent_task_cancel');
  await approvals.approveToolApproval({ id: taskApproval.id, actorId: 'operator:ada' });
  const cancelExecution = await broker.executeApproved({
    approvalId: taskApproval.id,
    request,
    claimedBy: 'worker-a',
  });
  assert.equal(cancelExecution.approval.status, 'succeeded');
  assert.equal((await tasks.get(createdTask.id)).status, 'cancelled');

  const invokedAgain = await client.callTool({
    name: 'agent_invoke',
    arguments: { id: 'evidence-reviewer', task: 'Review the second proof packet.' },
  });
  assert.match(textResult(invokedAgain), /client receipt is still missing/u);
  assert.equal(budgetChecks, 2);
  const successfulInvocations = events
    .filter((event) => event.type === 'delegation' && event.status === 'running')
    .map((event) => event.invocationId);
  assert.equal(successfulInvocations.length, 2);
  assert.equal(new Set(successfulInvocations).size, 2);
  const delegatedProviders = events
    .filter((event) => event.type === 'tool_call')
    .map((event) => event.call.provider)
    .filter((provider) => provider?.startsWith('delegated:'));
  assert.equal(delegatedProviders.length, 2);
  assert.match(delegatedProviders[0], new RegExp(`:${successfulInvocations[0]}:`, 'u'));
  assert.match(delegatedProviders[1], new RegExp(`:${successfulInvocations[1]}:`, 'u'));

  budgetAllowed = false;
  const budgetDenied = await client.callTool({
    name: 'agent_invoke',
    arguments: { id: definition.id, task: 'Try beyond the route cost limit.' },
  });
  assert.equal(budgetDenied.isError, true);
  assert.match(textResult(budgetDenied), /usage_budget_denied:project/u);
  assert.equal(budgetChecks, 3);
  budgetAllowed = true;

  await serverAgents.setEnabled({
    id: definition.id,
    enabled: false,
    expectedRevision: definition.revision,
  });
  const denied = await client.callTool({
    name: 'agent_invoke',
    arguments: { id: definition.id, task: 'Try after disable.' },
  });
  assert.equal(denied.isError, true);
  assert.match(textResult(denied), /delegated_agent_not_available/u);
  const unassigned = await client.callTool({
    name: 'agent_invoke',
    arguments: { id: 'finance-reviewer', task: 'Cross the route.' },
  });
  assert.equal(unassigned.isError, true);
  assert.match(textResult(unassigned), /delegated_agent_not_assigned/u);
});
