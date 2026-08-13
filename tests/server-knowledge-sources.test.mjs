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
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('failed_to_reserve_test_port');
  return port;
}

async function launchServer(context) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-server-knowledge-'));
  const port = await freePort();
  const logs = [];
  const ownerToken = 'knowledge-owner-token-123456789';
  const workspaceToken = 'knowledge-workspace-token-123456789';
  const ingressToken = 'knowledge-ingress-token-123456789';
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENTAG_PORT: String(port), OPENTAG_HOST: '127.0.0.1', OPENTAG_DATA_DIR: dataDir,
      OPENTAG_ADMIN_TOKEN: ownerToken,
      OPENTAG_OPERATOR_PRINCIPALS_JSON: JSON.stringify([{
        id: 'workspace-admin', displayName: 'Workspace admin', role: 'admin',
        workspaceIds: ['dev-workspace'], token: workspaceToken,
      }]),
      OPENTAG_CLIENT_INGRESS_TOKEN: '', OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_KNOWLEDGE_INGRESS_PRINCIPALS_JSON: JSON.stringify([{
        id: 'drive-sync', workspaceId: 'dev-workspace', token: ingressToken,
      }]),
      OPENTAG_KNOWLEDGE_ENRICHMENT_ENABLED: 'false',
      OPENTAG_ROUTINES_ENABLED: 'false', OPENTAG_LARK_EVENT_MODE: 'webhook',
      OPENTAG_LARK_VERIFICATION_TOKEN: 'knowledge-lark-verification-token',
      OPENTAG_LARK_CALLBACK_MAX_SKEW_SECONDS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited\n${logs.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) {
        return { baseUrl, ownerToken, workspaceToken, ingressToken };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy\n${logs.join('')}`);
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

function postJson(url, token, body) {
  return fetch(url, {
    method: 'POST',
    headers: { ...authorization(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Knowledge API keeps content owner-only and route assignment workspace-scoped', { timeout: 20_000 }, async (context) => {
  const { baseUrl, ownerToken, workspaceToken } = await launchServer(context);
  const empty = await fetch(`${baseUrl}/v1/knowledge-sources?workspaceId=dev-workspace`, {
    headers: authorization(workspaceToken),
  }).then((response) => response.json());
  assert.equal(empty.canManageCatalog, false);
  assert.deepEqual(empty.sources, []);

  const deniedCreate = await postJson(`${baseUrl}/v1/knowledge-sources`, workspaceToken, {
    workspaceId: 'dev-workspace', id: 'release-handbook', name: 'Release handbook',
    description: 'Approved release gates.', kind: 'text', content: 'Owner-only content.',
  });
  assert.equal(deniedCreate.status, 403);
  assert.equal((await deniedCreate.json()).error, 'operator_owner_required');

  const createdResponse = await postJson(`${baseUrl}/v1/knowledge-sources`, ownerToken, {
    workspaceId: 'dev-workspace', id: 'release-handbook', name: 'Release handbook',
    description: 'Approved release gates and evidence rules.', kind: 'url',
    sourceUri: 'https://docs.example.com/release', mediaType: 'text/markdown',
    content: '# Release gates\n\nBuild, rollout, and client receipt are separate.', expectedRevision: 0,
  });
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()).source;
  assert.equal(created.revision, 1);
  assert.match(created.contentHash, /^[a-f0-9]{64}$/u);

  const scoped = await fetch(`${baseUrl}/v1/knowledge-sources?workspaceId=dev-workspace`, {
    headers: authorization(workspaceToken),
  }).then((response) => response.json());
  assert.equal(scoped.sources[0].id, 'release-handbook');
  assert.equal('content' in scoped.sources[0], false);
  assert.equal(JSON.stringify(scoped).includes('client receipt'), false);
  const deniedDetail = await fetch(
    `${baseUrl}/v1/knowledge-sources/release-handbook?workspaceId=dev-workspace`,
    { headers: authorization(workspaceToken) },
  );
  assert.equal(deniedDetail.status, 403);
  const detail = await fetch(
    `${baseUrl}/v1/knowledge-sources/release-handbook?workspaceId=dev-workspace`,
    { headers: authorization(ownerToken) },
  ).then((response) => response.json());
  assert.match(detail.source.content, /client receipt/u);

  const assigned = await postJson(`${baseUrl}/v1/projects`, workspaceToken, {
    workspaceId: 'dev-workspace', projectId: 'opentag', knowledgeSourceIds: ['release-handbook'],
  });
  assert.equal(assigned.status, 200);
  assert.deepEqual((await assigned.json()).project.knowledgeSourceIds, ['release-handbook']);

  const disabled = await postJson(
    `${baseUrl}/v1/knowledge-sources/release-handbook/disable`, ownerToken,
    { workspaceId: 'dev-workspace', expectedRevision: 1 },
  );
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).source.enabled, false);
  const preserved = await postJson(`${baseUrl}/v1/projects`, workspaceToken, {
    workspaceId: 'dev-workspace', projectId: 'opentag', knowledgeSourceIds: ['release-handbook'],
  });
  assert.equal(preserved.status, 200);
  const removed = await postJson(`${baseUrl}/v1/projects`, workspaceToken, {
    workspaceId: 'dev-workspace', projectId: 'opentag', knowledgeSourceIds: [],
  });
  assert.equal(removed.status, 200);
  const rejected = await postJson(`${baseUrl}/v1/projects`, workspaceToken, {
    workspaceId: 'dev-workspace', projectId: 'opentag', knowledgeSourceIds: ['release-handbook'],
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'knowledge_source_not_enabled:release-handbook');

  const ownerCatalog = await fetch(`${baseUrl}/v1/knowledge-sources?workspaceId=dev-workspace`, {
    headers: authorization(ownerToken),
  }).then((response) => response.json());
  assert.equal(ownerCatalog.canManageCatalog, true);
  assert.deepEqual(ownerCatalog.audit.map((entry) => entry.action), [
    'knowledge.disabled', 'knowledge.created',
  ]);
  assert.equal(JSON.stringify(ownerCatalog).includes('client receipt'), false);
});

test('knowledge ingress binds tokens to one workspace and exposes content-free idempotent status', { timeout: 20_000 }, async (context) => {
  const { baseUrl, ingressToken } = await launchServer(context);
  const body = {
    id: 'synced-runbook', name: 'Synced runbook',
    description: 'Imported by Drive sync.', kind: 'text',
    content: '# Deploy\n\nProduction proof needs rollout status and client receipt.',
    dedupeKey: 'drive:file-42:revision-7',
  };
  const unauthorized = await fetch(`${baseUrl}/v1/knowledge/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(unauthorized.status, 401);

  const deniedWorkspace = await fetch(`${baseUrl}/v1/knowledge/ingest`, {
    method: 'POST',
    headers: { ...authorization(ingressToken), 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, workspaceId: 'another-workspace' }),
  });
  assert.equal(deniedWorkspace.status, 403);
  assert.equal((await deniedWorkspace.json()).error, 'knowledge_ingress_workspace_denied');

  const first = await fetch(`${baseUrl}/v1/knowledge/ingest`, {
    method: 'POST',
    headers: { ...authorization(ingressToken), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(first.status, 202);
  const accepted = await first.json();
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.source.workspaceId, 'dev-workspace');
  assert.equal(accepted.enrichment.status, 'pending');
  assert.equal(JSON.stringify(accepted).includes('client receipt'), false);

  const duplicate = await fetch(`${baseUrl}/v1/knowledge/ingest`, {
    method: 'POST',
    headers: { ...authorization(ingressToken), 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, id: 'must-not-be-created' }),
  }).then((response) => response.json());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.enrichment.id, accepted.enrichment.id);

  const statusResponse = await fetch(
    `${baseUrl}/v1/knowledge/ingest/${encodeURIComponent(accepted.enrichment.id)}`,
    { headers: authorization(ingressToken) },
  );
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.enrichment.workspaceId, 'dev-workspace');
  assert.equal(status.enrichment.passageCount, 0);
  assert.equal('passages' in status.enrichment, false);
  assert.equal('dedupeHash' in status.enrichment, false);
});

test('owner upload extracts HTML server-side and URL refresh is durably queued', { timeout: 20_000 }, async (context) => {
  const { baseUrl, ownerToken, ingressToken } = await launchServer(context);
  const html = '<html><body><main><h1>Release policy</h1><script>drop-me()</script><p>Require rollout and client receipt.</p></main></body></html>';
  const uploaded = await postJson(`${baseUrl}/v1/knowledge-sources`, ownerToken, {
    workspaceId: 'dev-workspace', id: 'uploaded-policy', name: 'Uploaded policy',
    description: 'Server extracted HTML.', kind: 'file', sourceUri: 'policy.html',
    mediaType: 'text/html', fileName: 'policy.html',
    contentBase64: Buffer.from(html).toString('base64'), expectedRevision: 0,
  });
  assert.equal(uploaded.status, 200);
  const uploadedBody = await uploaded.json();
  assert.equal(uploadedBody.source.extraction.extractor, 'html-to-text');
  assert.equal(uploadedBody.source.mediaType, 'text/plain');
  assert.equal(JSON.stringify(uploadedBody).includes('client receipt'), true);
  assert.equal(JSON.stringify(uploadedBody).includes('drop-me'), false);

  const ingressUpload = await postJson(`${baseUrl}/v1/knowledge/ingest`, ingressToken, {
    id: 'ingress-upload', name: 'Ingress upload', description: 'Automated text upload.',
    kind: 'file', sourceUri: 'sync.txt', mediaType: 'text/plain', fileName: 'sync.txt',
    contentBase64: Buffer.from('Synced release evidence.').toString('base64'),
    dedupeKey: 'sync:file-1:revision-1',
  });
  assert.equal(ingressUpload.status, 202);
  const ingressBody = await ingressUpload.json();
  assert.equal(ingressBody.source.extraction.extractor, 'plain-text');
  assert.equal(JSON.stringify(ingressBody).includes('Synced release evidence'), false);

  const remote = await postJson(`${baseUrl}/v1/knowledge-sources`, ownerToken, {
    workspaceId: 'dev-workspace', id: 'remote-policy', name: 'Remote policy',
    description: 'Refreshable HTTPS snapshot.', kind: 'url',
    sourceUri: 'https://docs.example.com/policy', mediaType: 'text/plain',
    content: 'Initial snapshot', refreshIntervalMs: 86400000, expectedRevision: 0,
  });
  assert.equal(remote.status, 200);
  const remoteBody = await remote.json();
  assert.equal(remoteBody.source.refreshIntervalMs, 86400000);
  assert.match(
    remoteBody.catalog.sources.find((source) => source.id === 'remote-policy').nextRefreshAt,
    /^\d{4}-\d{2}-\d{2}T/u,
  );
  const queued = await postJson(
    `${baseUrl}/v1/knowledge-sources/remote-policy/refresh`, ownerToken,
    { workspaceId: 'dev-workspace' },
  );
  assert.equal(queued.status, 202);
  const queuedBody = await queued.json();
  assert.equal(queuedBody.refresh.status, 'pending');
  assert.equal('etag' in queuedBody.refresh, false);
  assert.equal('lastModified' in queuedBody.refresh, false);

  const duplicate = await postJson(
    `${baseUrl}/v1/knowledge-sources/remote-policy/refresh`, ownerToken,
    { workspaceId: 'dev-workspace' },
  ).then((response) => response.json());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.refresh.id, queuedBody.refresh.id);

  const status = await fetch(
    `${baseUrl}/v1/knowledge-sources/remote-policy/refresh/${encodeURIComponent(queuedBody.refresh.id)}?workspaceId=dev-workspace`,
    { headers: authorization(ownerToken) },
  );
  assert.equal(status.status, 200);
  assert.equal((await status.json()).refresh.status, 'pending');
});
