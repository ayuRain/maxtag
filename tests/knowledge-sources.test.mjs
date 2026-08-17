import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  FileKnowledgeSourceStore,
  FileThreadConfigStore,
  KnowledgeSourceRevisionConflictError,
} from '@opentag/config';
import { StaticExecutorRegistry } from '@opentag/core';
import { buildAgentSystemPrompt } from '@opentag/executor-cli';
import { ScopedFileMemoryStore } from '@opentag/memory';
import { KnowledgeEnrichmentService } from '@opentag/runtime-host';
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

test('knowledge source catalog is cross-process, revisioned, hashed, and workspace isolated', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-knowledge-store-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = new FileKnowledgeSourceStore(root);
  const worker = new FileKnowledgeSourceStore(root);
  const created = await server.upsert({
    workspaceId: 'acme',
    id: 'release-handbook',
    name: 'Release handbook',
    description: 'Approved release gates and evidence rules.',
    kind: 'url',
    sourceUri: 'https://docs.example.com/release',
    content: '# Release gates\n\nBuild, deployment, and client receipt are separate evidence.',
    expectedRevision: 0,
    actor: 'operator:owner',
  });
  assert.equal(created.revision, 1);
  assert.match(created.contentHash, /^[a-f0-9]{64}$/u);
  assert.equal((await worker.get('acme', 'release-handbook')).contentHash, created.contentHash);
  assert.equal(await worker.get('other', 'release-handbook'), undefined);
  await assert.rejects(
    worker.upsert({
      workspaceId: 'acme', id: 'release-handbook', name: 'Stale',
      description: 'Stale edit.', kind: 'text', content: 'Stale.', expectedRevision: 0,
    }),
    (error) => error instanceof KnowledgeSourceRevisionConflictError && error.currentRevision === 1,
  );
  await assert.rejects(
    server.upsert({
      workspaceId: 'acme', id: 'unsafe', name: 'Unsafe',
      description: 'Credential input.', kind: 'text', content: 'api_key = do-not-store-this',
    }),
    /knowledge_source_credentials_not_allowed/u,
  );
  const hits = await worker.search({
    workspaceId: 'acme', ids: ['release-handbook'], query: '客户回执 client receipt', limit: 5,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sourceId, 'release-handbook');
  assert.equal(hits[0].contentHash, created.contentHash);
  assert.match(hits[0].excerpt, /client receipt/u);
  const disabled = await server.setEnabled({
    workspaceId: 'acme', id: 'release-handbook', enabled: false, expectedRevision: 1,
  });
  assert.equal(disabled.revision, 2);
  assert.deepEqual(await worker.list({ workspaceId: 'acme', ids: ['release-handbook'] }), []);
});

test('automated knowledge ingest is idempotent across processes and stale jobs cannot overwrite revisions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-knowledge-ingest-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstProcess = new FileKnowledgeSourceStore(root);
  const secondProcess = new FileKnowledgeSourceStore(root);
  const input = {
    workspaceId: 'acme', id: 'release-notes', name: 'Release notes',
    description: 'Deployment evidence.', kind: 'text',
    content: 'Release evidence requires rollout status.',
    dedupeKey: 'drive:file-42:revision-7', actor: 'ingress:drive',
  };
  const [first, duplicate] = await Promise.all([
    firstProcess.ingest(input),
    secondProcess.ingest({ ...input, id: 'must-not-be-created' }),
  ]);
  assert.equal([first, duplicate].filter((result) => !result.duplicate).length, 1);
  assert.equal(first.job.id, duplicate.job.id);
  assert.equal((await firstProcess.listEnrichments({ workspaceId: 'acme' })).length, 1);

  const [claimedByA, claimedByB] = await Promise.all([
    firstProcess.claimEnrichments({ workerId: 'worker-a', limit: 1 }),
    secondProcess.claimEnrichments({ workerId: 'worker-b', limit: 1 }),
  ]);
  assert.equal(claimedByA.length + claimedByB.length, 1);
  const claimed = claimedByA[0] ?? claimedByB[0];
  const owner = claimedByA.length ? 'worker-a' : 'worker-b';
  await firstProcess.upsert({
    workspaceId: 'acme', id: claimed.sourceId, name: 'Release notes',
    description: 'Updated deployment evidence.', kind: 'text',
    content: 'Release evidence now requires rollout status and a client receipt.',
    expectedRevision: 1,
  });
  const stale = await secondProcess.completeEnrichment({
    id: claimed.id, workerId: owner, executorId: 'codex',
    passages: [{ lineStart: 1, lineEnd: 1, summary: 'Old evidence.', aliases: ['old gate', '旧门槛'] }],
  });
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.passages, []);
});

test('empty enrichment polling does not create a cross-process lock', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-knowledge-empty-poll-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = new FileKnowledgeSourceStore(root);
  const worker = new FileKnowledgeSourceStore(root);
  const [serverJobs, workerJobs] = await Promise.all([
    server.claimEnrichments({ workerId: 'server' }),
    worker.claimEnrichments({ workerId: 'worker' }),
  ]);
  assert.deepEqual(serverJobs, []);
  assert.deepEqual(workerJobs, []);
  await assert.rejects(
    fs.stat(path.join(root, 'knowledge-sources.json.lock')),
    (error) => error?.code === 'ENOENT',
  );
});

test('low-cost knowledge enrichment builds verified aliases that retrieve current source text', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-knowledge-semantic-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileKnowledgeSourceStore(root);
  await store.upsert({
    workspaceId: 'acme', id: 'launch-gates', name: 'Launch gates',
    description: 'Evidence policy.', kind: 'text',
    content: [
      '# Launch gates',
      'Production launch requires rollout status.',
      'Customer receipt is the final evidence gate.',
    ].join('\n'),
  });
  const calls = [];
  const executor = {
    id: 'codex', label: 'Codex',
    async run(request) {
      calls.push(request);
      return {
        summary: '', artifacts: [],
        knowledgePassages: [{
          lineStart: 2, lineEnd: 3,
          summary: 'A launch needs rollout status and final customer receipt.',
          aliases: ['上线证明', '客户回执', 'production evidence'], confidence: 0.94,
        }],
        usage: { runs: 1, inputTokens: 300, outputTokens: 40, costUsd: 0.001 },
      };
    },
  };
  const registry = new StaticExecutorRegistry({
    defaultExecutorId: 'codex',
    registrations: [{
      executor,
      descriptor: {
        id: 'codex', label: 'Codex', provider: 'codex', mode: 'local-cli',
        model: 'gpt-5.6-luna', status: 'ready',
        capabilities: {
          steering: 'next_turn', providerSessions: false, transcriptFallback: true,
          brokeredTools: false, nativeTools: false, inputAttachments: false,
          managedArtifacts: false, automaticMemoryCandidates: false,
          contextRecovery: false, nativeCompaction: false,
        },
      },
    }],
  });
  const service = new KnowledgeEnrichmentService({
    store, executorRegistry: registry, workerId: 'knowledge-test', enabled: true,
  });
  const report = await service.runPass();
  assert.equal(report.completed, 1);
  assert.equal(report.passages, 1);
  assert.equal(report.jobs[0].model, 'gpt-5.6-luna');
  assert.equal(report.jobs[0].usage.inputTokens, 300);
  assert.equal(calls[0].purpose, 'knowledge_enrichment');
  assert.match(calls[0].memory, /2: Production launch requires rollout status/u);
  assert.deepEqual(calls[0].access.grants, []);
  const hits = await store.search({
    workspaceId: 'acme', ids: ['launch-gates'], query: '上线证明', limit: 3,
  });
  assert.equal(hits[0].strategy, 'semantic_alias');
  assert.match(hits[0].excerpt, /Customer receipt is the final evidence gate/u);
});

test('workspace project and channel knowledge assignments merge without sibling leakage', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-knowledge-route-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileThreadConfigStore(root, {
    workspace: { id: 'acme', name: 'Acme', defaultProjectId: 'shared' },
  });
  await store.upsertWorkspacePolicy({ workspaceId: 'acme', knowledgeSourceIds: ['company-handbook'] });
  await store.upsertProjectPolicy({
    workspaceId: 'acme', projectId: 'payments', knowledgeSourceIds: ['payments-api'],
  });
  await store.upsertProjectPolicy({
    workspaceId: 'acme', projectId: 'support', knowledgeSourceIds: ['support-playbook'],
  });
  await store.upsertChannelPolicy({
    workspaceId: 'acme', projectId: 'payments', platform: 'lark', channelId: 'oc_incidents',
    knowledgeSourceIds: ['p0-runbook', 'payments-api'],
  });
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('payments', 'oc_incidents'))).access.knowledgeSourceIds,
    ['company-handbook', 'payments-api', 'p0-runbook'],
  );
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('payments', 'oc_general'))).access.knowledgeSourceIds,
    ['company-handbook', 'payments-api'],
  );
  assert.deepEqual(
    (await store.resolveThreadPolicy(route('support', 'oc_support'))).access.knowledgeSourceIds,
    ['company-handbook', 'support-playbook'],
  );
});

test('broker exposes only assigned enabled knowledge and fences reads after disable', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-knowledge-broker-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverSources = new FileKnowledgeSourceStore(path.join(root, 'config'));
  const workerSources = new FileKnowledgeSourceStore(path.join(root, 'config'));
  const created = await serverSources.upsert({
    workspaceId: 'acme', id: 'release-handbook', name: 'Release handbook',
    description: 'Approved release gates.', kind: 'text',
    content: '# Gates\n\nBuild proof is local.\nDeployment proof needs rollout status.\nClient receipt is the final gate.',
  });
  await serverSources.upsert({
    workspaceId: 'acme', id: 'finance-policy', name: 'Finance policy',
    description: 'Must not reach this route.', kind: 'text', content: 'Private finance source.',
  });
  const request = {
    runId: 'knowledge-run', workspace: { id: 'acme', name: 'Acme' },
    project: { id: 'acme:payments', workspaceId: 'acme', key: 'payments', name: 'Payments' },
    thread: route('payments', 'oc_incidents'),
    message: { id: 'message-1', threadId: 'lark:oc_incidents:root', platform: 'lark', text: 'Check the release gate.', actor: { id: 'user-1' }, createdAt: new Date().toISOString(), mentionsAgent: true },
    identity: { id: 'opentag', displayName: 'MaxTag', instructions: 'Use approved evidence.', defaultExecutorId: 'codex' },
    access: { id: 'access-1', threadId: 'lark:oc_incidents:root', workspaceId: 'acme', projectId: 'acme:payments', knowledgeSourceIds: ['release-handbook'], grants: [], networkPolicy: { mode: 'deny-by-default', allowedHosts: [] } },
    knowledgeSources: [{ ...created, content: undefined }],
    memory: '',
  };
  delete request.knowledgeSources[0].content;
  const prompt = buildAgentSystemPrompt(request);
  assert.match(prompt, /release-handbook: Release handbook/u);
  assert.match(prompt, new RegExp(created.contentHash.slice(0, 12), 'u'));
  assert.doesNotMatch(prompt, /Client receipt is the final gate/u);
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    knowledgeSources: workerSources,
  });
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'opentag-knowledge-test', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: session.mcp.command, args: session.mcp.args, env: session.mcp.env, stderr: 'pipe',
  }));
  context.after(() => client.close());
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ['knowledge_list', 'knowledge_read', 'knowledge_search'],
  );
  const listed = await client.callTool({ name: 'knowledge_list', arguments: {} });
  assert.match(textResult(listed), /release-handbook/u);
  assert.doesNotMatch(textResult(listed), /finance-policy|Client receipt is the final gate/u);
  const searched = await client.callTool({
    name: 'knowledge_search', arguments: { query: 'client receipt', limit: 3 },
  });
  assert.match(textResult(searched), /Client receipt is the final gate/u);
  assert.match(textResult(searched), /"lineStart"/u);
  const read = await client.callTool({
    name: 'knowledge_read', arguments: { id: 'release-handbook', lineStart: 2, lineEnd: 4 },
  });
  assert.match(textResult(read), /Deployment proof needs rollout status/u);
  const unassigned = await client.callTool({
    name: 'knowledge_read', arguments: { id: 'finance-policy' },
  });
  assert.equal(unassigned.isError, true);
  assert.match(textResult(unassigned), /knowledge_source_not_assigned/u);
  await serverSources.setEnabled({
    workspaceId: 'acme', id: 'release-handbook', enabled: false, expectedRevision: 1,
  });
  const denied = await client.callTool({
    name: 'knowledge_read', arguments: { id: 'release-handbook' },
  });
  assert.equal(denied.isError, true);
  assert.match(textResult(denied), /knowledge_source_not_available/u);
  const empty = await client.callTool({ name: 'knowledge_list', arguments: {} });
  assert.match(textResult(empty), /"total": 0/u);
});
