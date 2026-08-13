import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentRunUsage,
  KnowledgePassageCandidate,
  KnowledgeSearchHit,
  KnowledgeSource,
  KnowledgeSourceExtraction,
  KnowledgeSourceKind,
  KnowledgeSourceStore,
} from '@opentag/core';

export interface KnowledgeSourceAuditRecord {
  id: string;
  sourceId: string;
  workspaceId: string;
  action: 'knowledge.created' | 'knowledge.updated' | 'knowledge.enabled' | 'knowledge.disabled';
  actor: string;
  at: string;
  revision: number;
  contentHash: string;
}

export interface KnowledgeSourcePassageIndex {
  lineStart: number;
  lineEnd: number;
  summary: string;
  aliases: string[];
  confidence: number;
  excerptHash: string;
}

export interface KnowledgeSourceEnrichmentJob {
  id: string;
  workspaceId: string;
  sourceId: string;
  sourceRevision: number;
  contentHash: string;
  status: 'pending' | 'claimed' | 'completed' | 'failed' | 'stale';
  dedupeHash?: string;
  actor: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  error?: string;
  executorId?: string;
  model?: string;
  usage?: AgentRunUsage;
  passages: KnowledgeSourcePassageIndex[];
}

export interface KnowledgeSourceIngestResult {
  source: KnowledgeSource;
  job: KnowledgeSourceEnrichmentJob;
  duplicate: boolean;
}

interface KnowledgeSourceFileState {
  version: 1;
  sources: KnowledgeSource[];
  audit: KnowledgeSourceAuditRecord[];
  enrichments: KnowledgeSourceEnrichmentJob[];
}

export class KnowledgeSourceRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('knowledge_source_revision_conflict');
    this.name = 'KnowledgeSourceRevisionConflictError';
  }
}

function now(): string {
  return new Date().toISOString();
}

export function normalizeKnowledgeSourceId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id)) {
    throw new Error('knowledge_source_invalid_id');
  }
  return id;
}

function cleanText(value: string, limit: number, error: string): string {
  const text = value.replace(/\r\n?/gu, '\n').replace(/\0/gu, '').trim();
  if (!text || text.length > limit) throw new Error(error);
  return text;
}

function normalizeWorkspaceId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 160 || !/^[a-zA-Z0-9_.:-]+$/u.test(id)) {
    throw new Error('knowledge_source_invalid_workspace');
  }
  return id;
}

function sourceKind(value: KnowledgeSourceKind): KnowledgeSourceKind {
  if (value !== 'text' && value !== 'file' && value !== 'url') {
    throw new Error('knowledge_source_invalid_kind');
  }
  return value;
}

function sourceUri(value: string | undefined, kind: KnowledgeSourceKind): string | undefined {
  const uri = value?.trim();
  if (!uri) return undefined;
  if (uri.length > 2_000) throw new Error('knowledge_source_invalid_uri');
  if (kind === 'url') {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error('knowledge_source_invalid_uri');
    }
    if (parsed.protocol !== 'https:') throw new Error('knowledge_source_invalid_uri');
    return parsed.href;
  }
  return uri.replace(/\0/gu, '');
}

export const KNOWLEDGE_SOURCE_REFRESH_INTERVALS_MS = [
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
] as const;

function refreshInterval(
  value: number | undefined,
  kind: KnowledgeSourceKind,
  current?: number,
): number | undefined {
  if (kind !== 'url') {
    if (value !== undefined && value !== 0) {
      throw new Error('knowledge_source_refresh_url_required');
    }
    return undefined;
  }
  if (value === undefined) return current;
  if (value === 0) return undefined;
  if (!Number.isInteger(value) || !KNOWLEDGE_SOURCE_REFRESH_INTERVALS_MS.includes(
    value as (typeof KNOWLEDGE_SOURCE_REFRESH_INTERVALS_MS)[number],
  )) {
    throw new Error('knowledge_source_refresh_interval_invalid');
  }
  return value;
}

function storedRefreshInterval(
  value: unknown,
  kind: KnowledgeSourceKind,
): number | undefined {
  return kind === 'url' && typeof value === 'number' &&
    KNOWLEDGE_SOURCE_REFRESH_INTERVALS_MS.includes(
      value as (typeof KNOWLEDGE_SOURCE_REFRESH_INTERVALS_MS)[number],
    )
    ? value
    : undefined;
}

function containsCredential(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:api[_ -]?key|app[_ -]?secret|client[_ -]?secret|password|passwd|access[_ -]?token|refresh[_ -]?token|verification[_ -]?token)\b\s*[:=]\s*\S+/iu.test(value)
  );
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function cloneSource(source: KnowledgeSource): KnowledgeSource {
  return {
    ...source,
    extraction: source.extraction ? { ...source.extraction } : undefined,
  };
}

function normalizeExtraction(value: KnowledgeSourceExtraction | undefined): KnowledgeSourceExtraction | undefined {
  if (!value) return undefined;
  const extractor = value.extractor;
  if (!['plain-text', 'html-to-text', 'mammoth', 'pdf-parse'].includes(extractor)) {
    throw new Error('knowledge_source_extractor_invalid');
  }
  if (!Number.isInteger(value.inputBytes) || value.inputBytes < 1 || value.inputBytes > 10 * 1024 * 1024) {
    throw new Error('knowledge_source_input_size_invalid');
  }
  if (!/^[a-f0-9]{64}$/u.test(value.rawHash)) {
    throw new Error('knowledge_source_raw_hash_invalid');
  }
  if (!Number.isFinite(Date.parse(value.extractedAt))) {
    throw new Error('knowledge_source_extracted_at_invalid');
  }
  if (
    value.pageCount !== undefined &&
    (!Number.isInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 200)
  ) throw new Error('knowledge_source_page_count_invalid');
  return {
    sourceMediaType: cleanText(value.sourceMediaType, 120, 'knowledge_source_invalid_media_type'),
    extractor,
    inputBytes: value.inputBytes,
    rawHash: value.rawHash,
    fileName: value.fileName?.replace(/[\0\r\n]/gu, '').trim().slice(0, 240) || undefined,
    extractedAt: new Date(value.extractedAt).toISOString(),
    pageCount: value.pageCount,
  };
}

function cloneEnrichment(job: KnowledgeSourceEnrichmentJob): KnowledgeSourceEnrichmentJob {
  return {
    ...job,
    usage: job.usage ? { ...job.usage } : undefined,
    passages: job.passages.map((passage) => ({
      ...passage,
      aliases: [...passage.aliases],
    })),
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function normalizeSource(value: unknown): KnowledgeSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<KnowledgeSource>;
  try {
    if (
      typeof item.id !== 'string' ||
      typeof item.workspaceId !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.description !== 'string' ||
      typeof item.kind !== 'string' ||
      typeof item.mediaType !== 'string' ||
      typeof item.content !== 'string' ||
      typeof item.enabled !== 'boolean' ||
      !Number.isInteger(item.revision) ||
      typeof item.createdAt !== 'string' ||
      typeof item.updatedAt !== 'string'
    ) return undefined;
    const content = cleanText(item.content, 200_000, 'knowledge_source_content_too_large');
    return {
      id: normalizeKnowledgeSourceId(item.id),
      workspaceId: normalizeWorkspaceId(item.workspaceId),
      name: cleanText(item.name, 120, 'knowledge_source_invalid_name'),
      description: cleanText(item.description, 500, 'knowledge_source_invalid_description'),
      kind: sourceKind(item.kind as KnowledgeSourceKind),
      sourceUri: sourceUri(item.sourceUri, item.kind as KnowledgeSourceKind),
      mediaType: cleanText(item.mediaType, 120, 'knowledge_source_invalid_media_type'),
      extraction: normalizeExtraction(item.extraction),
      refreshIntervalMs: storedRefreshInterval(
        item.refreshIntervalMs,
        item.kind as KnowledgeSourceKind,
      ),
      content,
      contentHash: hash(content),
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      enabled: item.enabled,
      revision: Math.max(1, Math.floor(item.revision!)),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function normalizeState(value: unknown): KnowledgeSourceFileState {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<KnowledgeSourceFileState>
    : {};
  return {
    version: 1,
    sources: Array.isArray(record.sources)
      ? record.sources.flatMap((item) => {
          const source = normalizeSource(item);
          return source ? [source] : [];
        })
      : [],
    audit: Array.isArray(record.audit)
      ? record.audit.filter((item): item is KnowledgeSourceAuditRecord => Boolean(
          item && typeof item.id === 'string' && typeof item.sourceId === 'string' &&
          typeof item.workspaceId === 'string' && typeof item.action === 'string' &&
          typeof item.actor === 'string' && typeof item.at === 'string' &&
          Number.isInteger(item.revision) && typeof item.contentHash === 'string',
        ))
      : [],
    enrichments: Array.isArray(record.enrichments)
      ? record.enrichments.flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const job = item as Partial<KnowledgeSourceEnrichmentJob>;
          if (
            typeof job.id !== 'string' || typeof job.workspaceId !== 'string' ||
            typeof job.sourceId !== 'string' || !Number.isInteger(job.sourceRevision) ||
            typeof job.contentHash !== 'string' ||
            !['pending', 'claimed', 'completed', 'failed', 'stale'].includes(String(job.status)) ||
            typeof job.actor !== 'string' || !Number.isInteger(job.attempts) ||
            !Number.isInteger(job.maxAttempts) || typeof job.createdAt !== 'string' ||
            typeof job.updatedAt !== 'string' || typeof job.availableAt !== 'string'
          ) return [];
          return [{
            ...job,
            workspaceId: normalizeWorkspaceId(job.workspaceId),
            sourceId: normalizeKnowledgeSourceId(job.sourceId),
            sourceRevision: Math.max(1, Math.floor(job.sourceRevision!)),
            status: job.status as KnowledgeSourceEnrichmentJob['status'],
            attempts: Math.max(0, Math.floor(job.attempts!)),
            maxAttempts: Math.max(1, Math.floor(job.maxAttempts!)),
            passages: Array.isArray(job.passages)
              ? job.passages.filter((passage): passage is KnowledgeSourcePassageIndex => Boolean(
                  passage && Number.isInteger(passage.lineStart) &&
                  Number.isInteger(passage.lineEnd) && typeof passage.summary === 'string' &&
                  Array.isArray(passage.aliases) && typeof passage.confidence === 'number' &&
                  typeof passage.excerptHash === 'string',
                )).map((passage) => ({ ...passage, aliases: [...passage.aliases] }))
              : [],
          } as KnowledgeSourceEnrichmentJob];
        })
      : [],
  };
}

function normalizedSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function searchTerms(query: string): Array<{ value: string; weight: number }> {
  const normalized = normalizedSearchText(query);
  const terms = new Map<string, number>();
  for (const token of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      for (let size = 2; size <= Math.min(4, token.length); size += 1) {
        for (let index = 0; index <= token.length - size; index += 1) {
          terms.set(token.slice(index, index + size), size * 0.8);
        }
      }
      if (token.length === 1) terms.set(token, 0.5);
    } else if (token.length >= 2) {
      terms.set(token, token.length >= 6 ? 2.2 : 1.5);
    }
  }
  return [...terms].map(([value, weight]) => ({ value, weight })).slice(0, 32);
}

function bestPassage(source: KnowledgeSource, terms: Array<{ value: string; weight: number }>): KnowledgeSearchHit | undefined {
  const lines = source.content.split('\n');
  let best: KnowledgeSearchHit | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const from = Math.max(0, index - 2);
    const to = Math.min(lines.length, index + 3);
    const excerpt = lines.slice(from, to).join('\n').trim().slice(0, 1_500);
    const normalized = normalizedSearchText(excerpt);
    const matched = terms.filter((term) => normalized.includes(term.value));
    if (!matched.length) continue;
    const title = normalizedSearchText(`${source.name} ${source.description}`);
    const score = matched.reduce((total, term) => total + term.weight, 0) +
      matched.filter((term) => title.includes(term.value)).length * 2 +
      new Set(matched.map((term) => term.value)).size * 0.5;
    if (!best || score > best.score) {
      best = {
        sourceId: source.id,
        sourceName: source.name,
        revision: source.revision,
        contentHash: source.contentHash,
        lineStart: from + 1,
        lineEnd: to,
        excerpt,
        score: Math.round(score * 1_000) / 1_000,
        matchedTerms: [...new Set(matched.map((term) => term.value))].slice(0, 12),
        strategy: 'lexical',
      };
    }
  }
  return best;
}

export class FileKnowledgeSourceStore implements KnowledgeSourceStore {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'knowledge-sources.json');
    this.lockFile = `${this.stateFile}.lock`;
  }

  private async load(): Promise<KnowledgeSourceFileState> {
    try {
      return normalizeState(JSON.parse(await fs.readFile(this.stateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, sources: [], audit: [], enrichments: [] };
      }
      throw error;
    }
  }

  private async save(state: KnowledgeSourceFileState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporaryFile, this.stateFile);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const owner = `${process.pid}:${randomUUID()}`;
        const handle = await fs.open(this.lockFile, 'wx');
        await handle.writeFile(`${owner}\n${now()}\n`, 'utf8');
        return async () => {
          await handle.close().catch(() => undefined);
          const currentOwner = await fs.readFile(this.lockFile, 'utf8')
            .then((value) => value.split('\n', 1)[0])
            .catch(() => undefined);
          if (currentOwner === owner) await fs.unlink(this.lockFile).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stale = await Promise.all([fs.stat(this.lockFile), fs.readFile(this.lockFile, 'utf8')])
          .then(([stat, value]) => Date.now() - stat.mtimeMs > 30_000 && !processIsAlive(Number(value.split(':', 1)[0])))
          .catch(() => false);
        if (stale) {
          await fs.unlink(this.lockFile).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error('knowledge_source_store_lock_timeout');
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
  }

  private async mutate<T>(operation: (state: KnowledgeSourceFileState) => T): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const release = await this.acquireLock();
      try {
        const state = await this.load();
        const result = operation(state);
        await this.save(state);
        return result;
      } finally {
        await release();
      }
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async list(input: { workspaceId: string; ids?: string[]; includeDisabled?: boolean }): Promise<KnowledgeSource[]> {
    await this.mutationQueue;
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const selectedIds = input.ids?.map(normalizeKnowledgeSourceId);
    const selected = selectedIds ? new Set(selectedIds) : undefined;
    return (await this.load()).sources
      .filter((source) => source.workspaceId === workspaceId)
      .filter((source) => input.includeDisabled || source.enabled)
      .filter((source) => !selected || selected.has(source.id))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(cloneSource);
  }

  async get(workspaceIdValue: string, idValue: string): Promise<KnowledgeSource | undefined> {
    await this.mutationQueue;
    const workspaceId = normalizeWorkspaceId(workspaceIdValue);
    const id = normalizeKnowledgeSourceId(idValue);
    const source = (await this.load()).sources.find(
      (item) => item.workspaceId === workspaceId && item.id === id,
    );
    return source ? cloneSource(source) : undefined;
  }

  async listScheduledRefreshSources(): Promise<KnowledgeSource[]> {
    await this.mutationQueue;
    return (await this.load()).sources
      .filter((source) =>
        source.enabled && source.kind === 'url' && Boolean(source.sourceUri) &&
        Boolean(source.refreshIntervalMs),
      )
      .sort((left, right) =>
        left.workspaceId.localeCompare(right.workspaceId) || left.id.localeCompare(right.id),
      )
      .map(cloneSource);
  }

  async upsert(input: {
    workspaceId: string;
    id: string;
    name: string;
    description: string;
    kind: KnowledgeSourceKind;
    sourceUri?: string;
    mediaType?: string;
    extraction?: KnowledgeSourceExtraction;
    refreshIntervalMs?: number;
    content: string;
    expectedRevision?: number;
    actor?: string;
  }): Promise<KnowledgeSource> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const id = normalizeKnowledgeSourceId(input.id);
    const name = cleanText(input.name, 120, 'knowledge_source_invalid_name');
    const description = cleanText(input.description, 500, 'knowledge_source_invalid_description');
    const kind = sourceKind(input.kind);
    const uri = sourceUri(input.sourceUri, kind);
    const mediaType = cleanText(input.mediaType || 'text/markdown', 120, 'knowledge_source_invalid_media_type');
    const extraction = normalizeExtraction(input.extraction);
    const content = cleanText(input.content, 200_000, 'knowledge_source_content_too_large');
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > 200_000) throw new Error('knowledge_source_content_too_large');
    if (containsCredential(`${description}\n${content}`)) {
      throw new Error('knowledge_source_credentials_not_allowed');
    }
    return this.mutate((state) => {
      const index = state.sources.findIndex(
        (source) => source.workspaceId === workspaceId && source.id === id,
      );
      const current = index >= 0 ? state.sources[index] : undefined;
      if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.revision ?? 0)) {
        throw new KnowledgeSourceRevisionConflictError(current?.revision ?? 0);
      }
      const timestamp = now();
      const source: KnowledgeSource = {
        id,
        workspaceId,
        name,
        description,
        kind,
        sourceUri: uri,
        mediaType,
        extraction,
        refreshIntervalMs: refreshInterval(input.refreshIntervalMs, kind, current?.refreshIntervalMs),
        content,
        contentHash: hash(content),
        sizeBytes,
        enabled: current?.enabled ?? true,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (index >= 0) state.sources.splice(index, 1, source);
      else state.sources.push(source);
      this.enqueueEnrichmentInState(state, source, input.actor?.trim() || 'operator');
      state.audit.push({
        id: randomUUID(), sourceId: id, workspaceId,
        action: current ? 'knowledge.updated' : 'knowledge.created',
        actor: input.actor?.trim() || 'operator', at: timestamp,
        revision: source.revision, contentHash: source.contentHash,
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneSource(source);
    });
  }

  private enqueueEnrichmentInState(
    state: KnowledgeSourceFileState,
    source: KnowledgeSource,
    actor: string,
    dedupeHash?: string,
  ): KnowledgeSourceEnrichmentJob {
    const timestamp = now();
    const job: KnowledgeSourceEnrichmentJob = {
      id: randomUUID(),
      workspaceId: source.workspaceId,
      sourceId: source.id,
      sourceRevision: source.revision,
      contentHash: source.contentHash,
      status: 'pending',
      dedupeHash,
      actor,
      attempts: 0,
      maxAttempts: 5,
      createdAt: timestamp,
      updatedAt: timestamp,
      availableAt: timestamp,
      passages: [],
    };
    state.enrichments.push(job);
    if (state.enrichments.length > 2_000) {
      const active = state.enrichments.filter((item) =>
        item.status === 'pending' || item.status === 'claimed',
      );
      const terminal = state.enrichments.filter((item) =>
        item.status !== 'pending' && item.status !== 'claimed',
      ).slice(-Math.max(0, 2_000 - active.length));
      state.enrichments = [...terminal, ...active];
    }
    return job;
  }

  async ingest(input: {
    workspaceId: string;
    id: string;
    name: string;
    description: string;
    kind: KnowledgeSourceKind;
    sourceUri?: string;
    mediaType?: string;
    extraction?: KnowledgeSourceExtraction;
    content: string;
    dedupeKey?: string;
    actor?: string;
  }): Promise<KnowledgeSourceIngestResult> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const id = normalizeKnowledgeSourceId(input.id);
    const name = cleanText(input.name, 120, 'knowledge_source_invalid_name');
    const description = cleanText(input.description, 500, 'knowledge_source_invalid_description');
    const kind = sourceKind(input.kind);
    const uri = sourceUri(input.sourceUri, kind);
    const mediaType = cleanText(input.mediaType || 'text/markdown', 120, 'knowledge_source_invalid_media_type');
    const extraction = normalizeExtraction(input.extraction);
    const content = cleanText(input.content, 200_000, 'knowledge_source_content_too_large');
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > 200_000) throw new Error('knowledge_source_content_too_large');
    if (containsCredential(`${description}\n${content}`)) {
      throw new Error('knowledge_source_credentials_not_allowed');
    }
    const dedupeKey = input.dedupeKey?.trim();
    if (dedupeKey && dedupeKey.length > 500) throw new Error('knowledge_ingest_dedupe_key_invalid');
    const dedupeHash = dedupeKey ? hash(`${workspaceId}\n${dedupeKey}`) : undefined;
    return this.mutate((state) => {
      const duplicate = dedupeHash
        ? state.enrichments.find(
            (job) => job.workspaceId === workspaceId && job.dedupeHash === dedupeHash,
          )
        : undefined;
      if (duplicate) {
        const source = state.sources.find(
          (item) => item.workspaceId === workspaceId && item.id === duplicate.sourceId,
        );
        if (!source) throw new Error('knowledge_ingest_source_not_found');
        return { source: cloneSource(source), job: cloneEnrichment(duplicate), duplicate: true };
      }
      const index = state.sources.findIndex(
        (source) => source.workspaceId === workspaceId && source.id === id,
      );
      const current = index >= 0 ? state.sources[index] : undefined;
      const timestamp = now();
      const source: KnowledgeSource = {
        id, workspaceId, name, description, kind, sourceUri: uri, mediaType, extraction, content,
        refreshIntervalMs: kind === 'url' ? current?.refreshIntervalMs : undefined,
        contentHash: hash(content), sizeBytes, enabled: current?.enabled ?? true,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp,
      };
      if (index >= 0) state.sources.splice(index, 1, source);
      else state.sources.push(source);
      const actor = input.actor?.trim() || 'knowledge-ingress';
      const job = this.enqueueEnrichmentInState(state, source, actor, dedupeHash);
      state.audit.push({
        id: randomUUID(), sourceId: id, workspaceId,
        action: current ? 'knowledge.updated' : 'knowledge.created',
        actor, at: timestamp, revision: source.revision, contentHash: source.contentHash,
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return { source: cloneSource(source), job: cloneEnrichment(job), duplicate: false };
    });
  }

  async setEnabled(input: {
    workspaceId: string;
    id: string;
    enabled: boolean;
    expectedRevision?: number;
    actor?: string;
  }): Promise<KnowledgeSource> {
    return this.mutate((state) => {
      const workspaceId = normalizeWorkspaceId(input.workspaceId);
      const id = normalizeKnowledgeSourceId(input.id);
      const index = state.sources.findIndex(
        (source) => source.workspaceId === workspaceId && source.id === id,
      );
      if (index < 0) throw new Error('knowledge_source_not_found');
      const current = state.sources[index];
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new KnowledgeSourceRevisionConflictError(current.revision);
      }
      const source = { ...cloneSource(current), enabled: input.enabled, revision: current.revision + 1, updatedAt: now() };
      state.sources.splice(index, 1, source);
      if (input.enabled) {
        this.enqueueEnrichmentInState(state, source, input.actor?.trim() || 'operator');
      }
      state.audit.push({
        id: randomUUID(), sourceId: id, workspaceId,
        action: input.enabled ? 'knowledge.enabled' : 'knowledge.disabled',
        actor: input.actor?.trim() || 'operator', at: source.updatedAt,
        revision: source.revision, contentHash: source.contentHash,
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneSource(source);
    });
  }

  async applyRemoteRefresh(input: {
    workspaceId: string;
    id: string;
    expectedRevision: number;
    expectedSourceUri: string;
    content: string;
    mediaType: string;
    extraction: KnowledgeSourceExtraction;
    actor?: string;
  }): Promise<{ source: KnowledgeSource; changed: boolean }> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const id = normalizeKnowledgeSourceId(input.id);
    const expectedUri = sourceUri(input.expectedSourceUri, 'url');
    const mediaType = cleanText(input.mediaType, 120, 'knowledge_source_invalid_media_type');
    const extraction = normalizeExtraction(input.extraction)!;
    const content = cleanText(input.content, 200_000, 'knowledge_source_content_too_large');
    if (Buffer.byteLength(content, 'utf8') > 200_000) {
      throw new Error('knowledge_source_content_too_large');
    }
    if (containsCredential(content)) throw new Error('knowledge_source_credentials_not_allowed');
    return this.mutate((state) => {
      const index = state.sources.findIndex(
        (source) => source.workspaceId === workspaceId && source.id === id,
      );
      if (index < 0) throw new Error('knowledge_source_not_found');
      const current = state.sources[index];
      if (
        current.kind !== 'url' || current.sourceUri !== expectedUri ||
        current.revision !== input.expectedRevision
      ) throw new KnowledgeSourceRevisionConflictError(current.revision);
      if (!current.enabled) throw new Error('knowledge_source_disabled');
      const contentHash = hash(content);
      if (contentHash === current.contentHash) {
        const source = {
          ...cloneSource(current), mediaType, extraction, updatedAt: now(),
        };
        state.sources.splice(index, 1, source);
        return { source: cloneSource(source), changed: false };
      }
      const at = now();
      const source: KnowledgeSource = {
        ...cloneSource(current), content, contentHash,
        sizeBytes: Buffer.byteLength(content, 'utf8'), mediaType, extraction,
        revision: current.revision + 1, updatedAt: at,
      };
      state.sources.splice(index, 1, source);
      const actor = input.actor?.trim() || 'knowledge-refresh';
      this.enqueueEnrichmentInState(state, source, actor);
      state.audit.push({
        id: randomUUID(), sourceId: id, workspaceId, action: 'knowledge.updated',
        actor, at, revision: source.revision, contentHash: source.contentHash,
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return { source: cloneSource(source), changed: true };
    });
  }

  async search(input: { workspaceId: string; ids: string[]; query: string; limit?: number }): Promise<KnowledgeSearchHit[]> {
    const terms = searchTerms(cleanText(input.query, 1_000, 'knowledge_search_query_invalid'));
    if (!terms.length) return [];
    await this.mutationQueue;
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const ids = new Set(input.ids.map(normalizeKnowledgeSourceId));
    const state = await this.load();
    const sources = state.sources.filter(
      (source) => source.workspaceId === workspaceId && source.enabled && ids.has(source.id),
    );
    const hits: KnowledgeSearchHit[] = sources.flatMap((source) => {
      const hit = bestPassage(source, terms);
      return hit ? [hit] : [];
    });
    for (const source of sources) {
      const enrichment = state.enrichments
        .filter((job) =>
          job.workspaceId === workspaceId && job.sourceId === source.id &&
          job.sourceRevision === source.revision && job.contentHash === source.contentHash &&
          job.status === 'completed',
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (!enrichment) continue;
      const lines = source.content.split('\n');
      for (const passage of enrichment.passages) {
        const semanticText = normalizedSearchText(`${passage.summary} ${passage.aliases.join(' ')}`);
        const matched = terms.filter((term) => semanticText.includes(term.value));
        if (!matched.length) continue;
        const excerpt = lines.slice(passage.lineStart - 1, passage.lineEnd).join('\n').trim().slice(0, 1_500);
        if (!excerpt || hash(excerpt) !== passage.excerptHash) continue;
        const score = 4 + matched.reduce((total, term) => total + term.weight, 0) +
          new Set(matched.map((term) => term.value)).size + passage.confidence * 2.5;
        hits.push({
          sourceId: source.id,
          sourceName: source.name,
          revision: source.revision,
          contentHash: source.contentHash,
          lineStart: passage.lineStart,
          lineEnd: passage.lineEnd,
          excerpt,
          score: Math.round(score * 1_000) / 1_000,
          matchedTerms: [...new Set(matched.map((term) => term.value))].slice(0, 12),
          strategy: 'semantic_alias',
        });
      }
    }
    const unique = new Map<string, KnowledgeSearchHit>();
    for (const hit of hits) {
      const key = `${hit.sourceId}:${hit.lineStart}:${hit.lineEnd}`;
      const current = unique.get(key);
      if (!current || hit.score > current.score) unique.set(key, hit);
    }
    return [...unique.values()]
      .sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId))
      .slice(0, Math.max(1, Math.min(input.limit ?? 8, 20)));
  }

  async getEnrichment(id: string): Promise<KnowledgeSourceEnrichmentJob | undefined> {
    await this.mutationQueue;
    const job = (await this.load()).enrichments.find((item) => item.id === id.trim());
    return job ? cloneEnrichment(job) : undefined;
  }

  async listEnrichments(input: {
    workspaceId?: string;
    sourceId?: string;
    status?: KnowledgeSourceEnrichmentJob['status'];
    limit?: number;
  } = {}): Promise<KnowledgeSourceEnrichmentJob[]> {
    await this.mutationQueue;
    const workspaceId = input.workspaceId ? normalizeWorkspaceId(input.workspaceId) : undefined;
    const sourceId = input.sourceId ? normalizeKnowledgeSourceId(input.sourceId) : undefined;
    return (await this.load()).enrichments
      .filter((job) => !workspaceId || job.workspaceId === workspaceId)
      .filter((job) => !sourceId || job.sourceId === sourceId)
      .filter((job) => !input.status || job.status === input.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(input.limit ?? 100, 500)))
      .map(cloneEnrichment);
  }

  async claimEnrichments(input: {
    workerId: string;
    limit?: number;
    leaseMs?: number;
  }): Promise<KnowledgeSourceEnrichmentJob[]> {
    const workerId = cleanText(input.workerId, 200, 'knowledge_enrichment_worker_invalid');
    const timestamp = now();
    const currentMs = Date.parse(timestamp);
    const leaseMs = Math.max(1_000, Math.min(input.leaseMs ?? 120_000, 900_000));
    return this.mutate((state) => state.enrichments
      .filter((job) => {
        if (job.attempts >= job.maxAttempts) return false;
        if (job.status === 'pending') return Date.parse(job.availableAt) <= currentMs;
        return job.status === 'claimed' && Boolean(job.claimedAt) &&
          Date.parse(job.claimedAt!) + leaseMs <= currentMs;
      })
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.max(1, Math.min(input.limit ?? 4, 20)))
      .map((job) => {
        job.status = 'claimed';
        job.claimedAt = timestamp;
        job.claimedBy = workerId;
        job.updatedAt = timestamp;
        job.attempts += 1;
        job.error = undefined;
        return cloneEnrichment(job);
      }));
  }

  async completeEnrichment(input: {
    id: string;
    workerId: string;
    passages: KnowledgePassageCandidate[];
    executorId: string;
    model?: string;
    usage?: AgentRunUsage;
  }): Promise<KnowledgeSourceEnrichmentJob> {
    return this.mutate((state) => {
      const job = state.enrichments.find((item) => item.id === input.id.trim());
      if (!job) throw new Error('knowledge_enrichment_not_found');
      if (job.status !== 'claimed' || job.claimedBy !== input.workerId.trim()) {
        throw new Error('knowledge_enrichment_claim_lost');
      }
      const timestamp = now();
      const source = state.sources.find(
        (item) => item.workspaceId === job.workspaceId && item.id === job.sourceId,
      );
      if (!source || source.revision !== job.sourceRevision || source.contentHash !== job.contentHash) {
        job.status = 'stale';
        job.updatedAt = timestamp;
        job.completedAt = timestamp;
        job.error = 'knowledge_enrichment_source_changed';
        job.passages = [];
        return cloneEnrichment(job);
      }
      const lines = source.content.split('\n');
      const passages = new Map<string, KnowledgeSourcePassageIndex>();
      for (const candidate of input.passages.slice(0, 48)) {
        const lineStart = Math.floor(candidate.lineStart);
        const lineEnd = Math.floor(candidate.lineEnd);
        if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart || lineEnd > lines.length) continue;
        const summary = candidate.summary.replace(/\s+/gu, ' ').trim().slice(0, 500);
        const aliases = [...new Set(candidate.aliases.map((value) => value.replace(/\s+/gu, ' ').trim().slice(0, 100)).filter(Boolean))].slice(0, 8);
        const confidence = Math.max(0, Math.min(candidate.confidence ?? 0.7, 1));
        const excerpt = lines.slice(lineStart - 1, lineEnd).join('\n').trim().slice(0, 1_500);
        if (!summary || aliases.length < 2 || !excerpt || confidence < 0.5) continue;
        if (containsCredential(`${summary}\n${aliases.join('\n')}`)) continue;
        const key = `${lineStart}:${lineEnd}`;
        passages.set(key, { lineStart, lineEnd, summary, aliases, confidence, excerptHash: hash(excerpt) });
      }
      job.status = 'completed';
      job.updatedAt = timestamp;
      job.completedAt = timestamp;
      job.error = undefined;
      job.executorId = cleanText(input.executorId, 120, 'knowledge_enrichment_executor_invalid');
      job.model = input.model?.trim().slice(0, 200) || undefined;
      job.usage = input.usage ? { ...input.usage } : undefined;
      job.passages = [...passages.values()];
      return cloneEnrichment(job);
    });
  }

  async retryEnrichment(input: {
    id: string;
    workerId: string;
    error: string;
    retryAfterMs?: number;
  }): Promise<KnowledgeSourceEnrichmentJob> {
    return this.mutate((state) => {
      const job = state.enrichments.find((item) => item.id === input.id.trim());
      if (!job) throw new Error('knowledge_enrichment_not_found');
      if (job.status !== 'claimed' || job.claimedBy !== input.workerId.trim()) {
        throw new Error('knowledge_enrichment_claim_lost');
      }
      const timestamp = now();
      const terminal = job.attempts >= job.maxAttempts;
      job.status = terminal ? 'failed' : 'pending';
      job.updatedAt = timestamp;
      job.error = input.error.replace(/\s+/gu, ' ').trim().slice(0, 1_000) || 'knowledge_enrichment_failed';
      job.claimedAt = undefined;
      job.claimedBy = undefined;
      if (terminal) job.completedAt = timestamp;
      else job.availableAt = new Date(Date.now() + Math.max(1_000, Math.min(input.retryAfterMs ?? 5_000, 900_000))).toISOString();
      return cloneEnrichment(job);
    });
  }

  async listAudit(workspaceId: string, limit = 200): Promise<KnowledgeSourceAuditRecord[]> {
    await this.mutationQueue;
    return (await this.load()).audit
      .filter((record) => record.workspaceId === normalizeWorkspaceId(workspaceId))
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((record) => ({ ...record }));
  }
}
