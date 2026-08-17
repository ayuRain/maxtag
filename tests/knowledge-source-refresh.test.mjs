import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  FileKnowledgeSourceRefreshStore,
  FileKnowledgeSourceStore,
} from '../packages/config/dist/index.js';
import {
  decodeKnowledgeContentBase64,
  extractKnowledgeContent,
  KnowledgeSourceRefreshService,
} from '../packages/runtime-host/dist/index.js';

async function temporary(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-knowledge-refresh-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function docxBuffer(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function pdfBuffer(text) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 54, y: 720, size: 14, font });
  return Buffer.from(await document.save());
}

test('content extraction removes active HTML and handles DOCX on the server', async () => {
  const html = await extractKnowledgeContent({
    buffer: Buffer.from('<html><body><main><h1>Release gate</h1><script>secret()</script><p>Require client receipt.</p></main></body></html>'),
    mediaType: 'text/html; charset=utf-8', fileName: 'release.html',
  });
  assert.match(html.content, /Release gate/iu);
  assert.match(html.content, /client receipt/u);
  assert.doesNotMatch(html.content, /secret/u);
  assert.equal(html.extraction.extractor, 'html-to-text');

  const docx = await extractKnowledgeContent({
    buffer: await docxBuffer('Production proof needs rollout and receipt.'),
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileName: 'runbook.docx',
  });
  assert.match(docx.content, /Production proof/u);
  assert.equal(docx.extraction.extractor, 'mammoth');
  assert.match(docx.extraction.rawHash, /^[a-f0-9]{64}$/u);

  const pdf = await extractKnowledgeContent({
    buffer: await pdfBuffer('PDF release evidence requires client receipt.'),
    mediaType: 'application/pdf', fileName: 'release.pdf',
  });
  assert.match(pdf.content, /PDF release evidence requires client receipt/u);
  assert.equal(pdf.extraction.extractor, 'pdf-parse');
  assert.equal(pdf.extraction.pageCount, 1);
});

test('content extraction rejects binary text, unsupported media, and malformed base64', async () => {
  await assert.rejects(
    extractKnowledgeContent({ buffer: Buffer.from([0, 1, 2]), mediaType: 'text/plain' }),
    /knowledge_extraction_text_binary/u,
  );
  await assert.rejects(
    extractKnowledgeContent({ buffer: Buffer.from('x'), mediaType: 'image/png' }),
    /knowledge_extraction_media_type_unsupported/u,
  );
  assert.throws(() => decodeKnowledgeContentBase64('not base64'), /knowledge_extraction_base64_invalid/u);
});

test('empty refresh polling does not create a cross-process lock', async (context) => {
  const root = await temporary(context);
  const refreshes = new FileKnowledgeSourceRefreshStore(root);
  assert.deepEqual(await refreshes.claim({ workerId: 'worker-a' }), []);
  await assert.rejects(
    fs.stat(path.join(root, 'knowledge-source-refresh-jobs.json.lock')),
    (error) => error?.code === 'ENOENT',
  );
});

test('durable refresh updates once, deduplicates active jobs, and uses conditional requests', async (context) => {
  const root = await temporary(context);
  const sources = new FileKnowledgeSourceStore(root);
  const refreshes = new FileKnowledgeSourceRefreshStore(root);
  const source = await sources.upsert({
    workspaceId: 'dev-workspace', id: 'release-runbook', name: 'Release runbook',
    description: 'Release evidence policy.', kind: 'url', sourceUri: 'https://docs.example.com/runbook',
    content: 'Old content', mediaType: 'text/plain', expectedRevision: 0,
  });
  const queued = await refreshes.enqueue({
    workspaceId: source.workspaceId, sourceId: source.id, sourceRevision: source.revision,
    sourceUri: source.sourceUri, requestedBy: 'owner:test',
  });
  const duplicate = await refreshes.enqueue({
    workspaceId: source.workspaceId, sourceId: source.id, sourceRevision: source.revision,
    sourceUri: source.sourceUri, requestedBy: 'owner:test',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, queued.job.id);
  const service = new KnowledgeSourceRefreshService({
    store: refreshes, knowledgeStore: sources, workerId: 'worker-a',
    resolve: async () => ['203.0.113.9'],
    fetch: async () => new Response('<html><body><article><h1>Runbook</h1><p>Rollout and client receipt.</p></article></body></html>', {
      headers: { 'content-type': 'text/html', etag: '"revision-2"' },
    }),
  });
  const pass = await service.runPass();
  assert.equal(pass.updated, 1);
  const updated = await sources.get('dev-workspace', 'release-runbook');
  assert.equal(updated.revision, 2);
  assert.match(updated.content, /client receipt/u);
  assert.equal(updated.extraction.extractor, 'html-to-text');

  await refreshes.enqueue({
    workspaceId: updated.workspaceId, sourceId: updated.id, sourceRevision: updated.revision,
    sourceUri: updated.sourceUri, requestedBy: 'owner:test',
  });
  let headers;
  const conditional = new KnowledgeSourceRefreshService({
    store: refreshes, knowledgeStore: sources, workerId: 'worker-b',
    resolve: async () => ['203.0.113.9'],
    fetch: async (_url, options) => {
      headers = options.headers;
      return new Response(null, { status: 304, headers: { etag: '"revision-2"' } });
    },
  });
  const second = await conditional.runPass();
  assert.equal(second.notModified, 1, JSON.stringify(second));
  assert.equal(headers['if-none-match'], '"revision-2"');
  assert.equal((await sources.get('dev-workspace', 'release-runbook')).revision, 2);
});

test('scheduled URL refresh is revision-bound and queues once across workers', async (context) => {
  const root = await temporary(context);
  const sources = new FileKnowledgeSourceStore(root);
  const source = await sources.upsert({
    workspaceId: 'dev-workspace', id: 'scheduled-runbook', name: 'Scheduled runbook',
    description: 'Workspace-owned current policy.', kind: 'url',
    sourceUri: 'https://docs.example.com/scheduled', content: 'Current snapshot',
    refreshIntervalMs: 60 * 60_000, expectedRevision: 0,
  });
  assert.equal(source.refreshIntervalMs, 60 * 60_000);
  const scheduledAt = new Date(Date.parse(source.updatedAt) + source.refreshIntervalMs);
  const refreshA = new FileKnowledgeSourceRefreshStore(root);
  const refreshB = new FileKnowledgeSourceRefreshStore(root);

  const early = await refreshA.enqueueDue({
    sources: await sources.listScheduledRefreshSources(),
    now: new Date(scheduledAt.getTime() - 1).toISOString(),
  });
  assert.equal(early.due, 0);
  const concurrent = await Promise.all([
    refreshA.enqueueDue({ sources: await sources.listScheduledRefreshSources(), now: scheduledAt.toISOString() }),
    refreshB.enqueueDue({ sources: await sources.listScheduledRefreshSources(), now: scheduledAt.toISOString() }),
  ]);
  assert.equal(concurrent.reduce((total, item) => total + item.queued.length, 0), 1);
  assert.equal((await refreshA.list({ sourceId: source.id })).length, 1);

  const serviceRoot = await temporary(context);
  const serviceSources = new FileKnowledgeSourceStore(serviceRoot);
  const serviceRefreshes = new FileKnowledgeSourceRefreshStore(serviceRoot);
  const serviceSource = await serviceSources.upsert({
    workspaceId: 'dev-workspace', id: 'service-runbook', name: 'Service runbook',
    description: 'Scheduled service execution.', kind: 'url',
    sourceUri: 'https://docs.example.com/service', content: 'Current snapshot',
    refreshIntervalMs: 60 * 60_000, expectedRevision: 0,
  });
  const listScheduled = serviceSources.listScheduledRefreshSources.bind(serviceSources);
  serviceSources.listScheduledRefreshSources = async () =>
    (await listScheduled()).map((item) => ({
      ...item,
      updatedAt: new Date(Date.now() - item.refreshIntervalMs - 1_000).toISOString(),
    }));
  const service = new KnowledgeSourceRefreshService({
    store: serviceRefreshes, knowledgeStore: serviceSources, workerId: 'scheduled-worker',
    fetch: async () => new Response(null, { status: 304 }),
    resolve: async () => ['203.0.113.9'],
  });
  const pass = await service.runPass();
  assert.equal(pass.scheduled, 1);
  assert.equal(pass.claimed, 1);
  assert.equal(pass.notModified, 1);
  const completed = (await serviceRefreshes.list({ sourceId: serviceSource.id }))[0];
  const nextDueAt = Date.parse(completed.updatedAt) + serviceSource.refreshIntervalMs;

  const after = await serviceRefreshes.enqueueDue({
    sources: await listScheduled(),
    now: new Date(nextDueAt - 1).toISOString(),
  });
  assert.equal(after.due, 0);
  const next = await serviceRefreshes.enqueueDue({
    sources: await listScheduled(),
    now: new Date(nextDueAt).toISOString(),
  });
  assert.equal(next.queued.length, 1);
});

test('automatic refresh accepts only governed URL intervals', async (context) => {
  const sources = new FileKnowledgeSourceStore(await temporary(context));
  await assert.rejects(
    sources.upsert({
      workspaceId: 'dev-workspace', id: 'text-source', name: 'Text source',
      description: 'Static content.', kind: 'text', content: 'Snapshot',
      refreshIntervalMs: 60 * 60_000,
    }),
    /knowledge_source_refresh_url_required/u,
  );
  await assert.rejects(
    sources.upsert({
      workspaceId: 'dev-workspace', id: 'fast-source', name: 'Fast source',
      description: 'Unsafe refresh frequency.', kind: 'url', content: 'Snapshot',
      sourceUri: 'https://docs.example.com/fast', refreshIntervalMs: 60_000,
    }),
    /knowledge_source_refresh_interval_invalid/u,
  );
});

test('refresh dedupe and validators are revision-bound', async (context) => {
  const root = await temporary(context);
  const sources = new FileKnowledgeSourceStore(root);
  const refreshes = new FileKnowledgeSourceRefreshStore(root);
  const first = await sources.upsert({
    workspaceId: 'dev-workspace', id: 'revision-source', name: 'Revision Source',
    description: 'Revision-bound refresh.', kind: 'url',
    sourceUri: 'https://docs.example.com/a', content: 'One', expectedRevision: 0,
  });
  const oldJob = await refreshes.enqueue({
    workspaceId: first.workspaceId, sourceId: first.id, sourceRevision: 1,
    sourceUri: first.sourceUri, requestedBy: 'owner:test',
  });
  const second = await sources.upsert({
    workspaceId: first.workspaceId, id: first.id, name: first.name,
    description: first.description, kind: 'url', sourceUri: 'https://docs.example.com/b',
    content: 'Two', expectedRevision: 1,
  });
  const currentJob = await refreshes.enqueue({
    workspaceId: second.workspaceId, sourceId: second.id, sourceRevision: 2,
    sourceUri: second.sourceUri, requestedBy: 'owner:test',
  });
  assert.equal(currentJob.duplicate, false);
  assert.notEqual(currentJob.job.id, oldJob.job.id);
  assert.equal(currentJob.job.etag, undefined);
});

test('remote refresh rejects private DNS and cross-origin redirects without changing Source', async (context) => {
  const root = await temporary(context);
  const sources = new FileKnowledgeSourceStore(root);
  const refreshes = new FileKnowledgeSourceRefreshStore(root);
  const source = await sources.upsert({
    workspaceId: 'dev-workspace', id: 'security-source', name: 'Security Source',
    description: 'Network boundary checks.', kind: 'url', sourceUri: 'https://docs.example.com/source',
    content: 'Known good', expectedRevision: 0,
  });
  await refreshes.enqueue({ workspaceId: source.workspaceId, sourceId: source.id, sourceRevision: 1, sourceUri: source.sourceUri, requestedBy: 'owner:test' });
  const privateService = new KnowledgeSourceRefreshService({
    store: refreshes, knowledgeStore: sources, workerId: 'worker-private',
    resolve: async () => ['127.0.0.1'], fetch: async () => assert.fail('fetch must not run'),
    retryBaseMs: 1_000,
  });
  const privatePass = await privateService.runPass();
  assert.equal(privatePass.retried, 1);
  assert.equal((await sources.get('dev-workspace', source.id)).revision, 1);

  const pending = (await refreshes.list({ sourceId: source.id }))[0];
  pending.availableAt = new Date(0).toISOString();
  // Complete the remaining policy case with an independent durable store.
  const root2 = await temporary(context);
  const sources2 = new FileKnowledgeSourceStore(root2);
  const refreshes2 = new FileKnowledgeSourceRefreshStore(root2);
  const source2 = await sources2.upsert({ ...source, expectedRevision: 0, content: 'Known good' });
  await refreshes2.enqueue({ workspaceId: source2.workspaceId, sourceId: source2.id, sourceRevision: 1, sourceUri: source2.sourceUri, requestedBy: 'owner:test' });
  const redirectService = new KnowledgeSourceRefreshService({
    store: refreshes2, knowledgeStore: sources2, workerId: 'worker-redirect',
    resolve: async () => ['203.0.113.10'],
    fetch: async () => new Response(null, { status: 302, headers: { location: 'https://other.example.net/private' } }),
    retryBaseMs: 1_000,
  });
  const redirected = await redirectService.runPass();
  assert.equal(redirected.retried, 1);
  assert.match(redirected.jobs[0].error, /cross_origin_redirect_denied/u);
  assert.equal((await sources2.get('dev-workspace', source2.id)).revision, 1);
});

test('refresh result becomes stale when Source revision changes after enqueue', async (context) => {
  const root = await temporary(context);
  const sources = new FileKnowledgeSourceStore(root);
  const refreshes = new FileKnowledgeSourceRefreshStore(root);
  const source = await sources.upsert({
    workspaceId: 'dev-workspace', id: 'racing-source', name: 'Racing Source',
    description: 'Revision conflict.', kind: 'url', sourceUri: 'https://docs.example.com/a',
    content: 'Revision one', expectedRevision: 0,
  });
  await refreshes.enqueue({ workspaceId: source.workspaceId, sourceId: source.id, sourceRevision: 1, sourceUri: source.sourceUri, requestedBy: 'owner:test' });
  await sources.upsert({
    workspaceId: source.workspaceId, id: source.id, name: source.name,
    description: source.description, kind: 'url', sourceUri: 'https://docs.example.com/b',
    content: 'Revision two', expectedRevision: 1,
  });
  const service = new KnowledgeSourceRefreshService({
    store: refreshes, knowledgeStore: sources, workerId: 'worker-race',
    resolve: async () => ['203.0.113.10'], fetch: async () => assert.fail('fetch must not run'),
  });
  const pass = await service.runPass();
  assert.equal(pass.stale, 1);
  assert.equal((await sources.get('dev-workspace', source.id)).content, 'Revision two');
});
