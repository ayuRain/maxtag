import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  AgentSkillRevisionConflictError,
  FileAgentSkillStore,
  FileThreadConfigStore,
} from '@opentag/config';
import { buildAgentSystemPrompt } from '@opentag/executor-cli';
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

test('skill catalog is shared across processes and rejects credentials and stale revisions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-skills-store-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = new FileAgentSkillStore(root);
  const worker = new FileAgentSkillStore(root);
  const created = await server.upsert({
    id: 'incident-review',
    name: 'Incident review',
    description: 'Review an incident using the shared evidence checklist.',
    content: '# Procedure\n\n1. Establish the timeline.\n2. Cite each source.',
    expectedRevision: 0,
    actor: 'operator:owner',
  });
  assert.equal(created.revision, 1);
  assert.equal((await worker.get('incident-review')).name, 'Incident review');

  await assert.rejects(
    worker.upsert({
      id: 'incident-review',
      name: 'Stale edit',
      description: 'Must not win.',
      content: 'Stale body.',
      expectedRevision: 0,
    }),
    (error) =>
      error instanceof AgentSkillRevisionConflictError &&
      error.currentRevision === 1,
  );
  await assert.rejects(
    server.upsert({
      id: 'unsafe',
      name: 'Unsafe',
      description: 'Contains a secret.',
      content: 'api_key = do-not-store-this',
    }),
    /agent_skill_credentials_not_allowed/u,
  );
  const disabled = await server.setEnabled({
    id: 'incident-review',
    enabled: false,
    expectedRevision: 1,
  });
  assert.equal(disabled.revision, 2);
  assert.deepEqual(await worker.list({ ids: ['incident-review'] }), []);
  assert.equal(
    (await worker.list({ ids: ['incident-review'], includeDisabled: true }))[0]
      .enabled,
    false,
  );
});

test('workspace project and channel skills merge additively without leaking to siblings', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-skills-route-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileThreadConfigStore(root, {
    workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
  });
  await store.upsertWorkspacePolicy({
    workspaceId: 'acme',
    skillIds: ['evidence-baseline'],
  });
  await store.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'payments',
    skillIds: ['payments-release', 'evidence-baseline'],
  });
  await store.upsertProjectPolicy({
    workspaceId: 'acme',
    projectId: 'support',
    skillIds: ['customer-return'],
  });
  await store.upsertChannelPolicy({
    workspaceId: 'acme',
    projectId: 'payments',
    platform: 'lark',
    channelId: 'oc_incidents',
    skillIds: ['p0-response', 'payments-release'],
  });

  assert.deepEqual(
    (await store.resolveThreadPolicy(route('payments', 'oc_incidents'))).access
      .skillIds,
    ['evidence-baseline', 'payments-release', 'p0-response'],
  );
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('payments', 'oc_general'))).access
      .skillIds,
    ['evidence-baseline', 'payments-release'],
  );
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('support', 'oc_support'))).access
      .skillIds,
    ['evidence-baseline', 'customer-return'],
  );
});

test('broker exposes only assigned enabled skills and rechecks disable before loading', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-skills-broker-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverSkills = new FileAgentSkillStore(path.join(root, 'config'));
  const workerSkills = new FileAgentSkillStore(path.join(root, 'config'));
  await serverSkills.upsert({
    id: 'incident-review',
    name: 'Incident review',
    description: 'Review incident evidence.',
    content: 'PRIVATE PROCEDURE BODY: establish the verified timeline.',
  });
  await serverSkills.upsert({
    id: 'finance-close',
    name: 'Finance close',
    description: 'Close the monthly books.',
    content: 'Must not be visible to the incident route.',
  });
  const request = {
    runId: 'skill-run',
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
      text: 'Review the incident.',
      actor: { id: 'user-1', displayName: 'Ada' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
    identity: {
      id: 'opentag',
      displayName: 'MaxTag',
      instructions: 'Follow the route policy.',
      defaultExecutorId: 'codex',
    },
    access: {
      id: 'access-1',
      threadId: 'lark:oc_incidents:root',
      workspaceId: 'acme',
      projectId: 'acme:payments',
      skillIds: ['incident-review'],
      grants: [],
      networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
    },
    skills: [
      {
        id: 'incident-review',
        name: 'Incident review',
        description: 'Review incident evidence.',
        revision: 1,
      },
    ],
    memory: '',
  };
  const prompt = buildAgentSystemPrompt(request);
  assert.match(prompt, /incident-review: Incident review - Review incident evidence/u);
  assert.doesNotMatch(prompt, /PRIVATE PROCEDURE BODY/u);

  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    skills: workerSkills,
  });
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'opentag-skills-test', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ['skills_list', 'skills_load'],
  );
  const listed = await client.callTool({ name: 'skills_list', arguments: {} });
  assert.match(textResult(listed), /incident-review/u);
  assert.doesNotMatch(textResult(listed), /finance-close/u);
  const loaded = await client.callTool({
    name: 'skills_load',
    arguments: { id: 'incident-review' },
  });
  assert.match(textResult(loaded), /PRIVATE PROCEDURE BODY/u);

  await serverSkills.setEnabled({
    id: 'incident-review',
    enabled: false,
    expectedRevision: 1,
  });
  const disabledList = await client.callTool({ name: 'skills_list', arguments: {} });
  assert.match(textResult(disabledList), /"total": 0/u);
  const denied = await client.callTool({
    name: 'skills_load',
    arguments: { id: 'incident-review' },
  });
  assert.equal(denied.isError, true);
  assert.match(textResult(denied), /skill_not_available/u);
  const unassigned = await client.callTool({
    name: 'skills_load',
    arguments: { id: 'finance-close' },
  });
  assert.equal(unassigned.isError, true);
  assert.match(textResult(unassigned), /skill_not_assigned/u);
});
