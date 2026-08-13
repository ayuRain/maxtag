import type {
  AgentRunUsage,
  ExecutorDescriptor,
  ExecutorRegistry,
  KnowledgePassageCandidate,
} from '@opentag/core';
import {
  FileKnowledgeSourceStore,
  type KnowledgeSourceEnrichmentJob,
} from '@opentag/config';

const DEFAULT_CHUNK_CHARS = 36_000;
const DEFAULT_MAX_CHUNKS = 8;

export interface KnowledgeEnrichmentServiceOptions {
  store: FileKnowledgeSourceStore;
  executorRegistry: ExecutorRegistry;
  executorId?: string;
  workerId: string;
  enabled?: boolean;
  batchSize?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  maxChunkChars?: number;
  maxChunks?: number;
}

export interface KnowledgeEnrichmentPassResult {
  claimed: number;
  completed: number;
  stale: number;
  retried: number;
  failed: number;
  passages: number;
  jobs: KnowledgeSourceEnrichmentJob[];
}

function addUsage(total: AgentRunUsage, usage: AgentRunUsage | undefined): void {
  if (!usage) return;
  for (const key of ['runs', 'costUsd', 'inputTokens', 'outputTokens'] as const) {
    if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]!;
  }
}

function numberedChunks(content: string, maxChars: number, maxChunks: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length) chunks.push(current.join('\n'));
    current = [];
    currentChars = 0;
  };
  for (const [index, value] of content.split('\n').entries()) {
    const prefix = `${index + 1}: `;
    const line = value.length + prefix.length > maxChars
      ? `${prefix}[line omitted from semantic enrichment: ${value.length} characters]`
      : `${prefix}${value}`;
    if (current.length && currentChars + line.length + 1 > maxChars) flush();
    if (chunks.length >= maxChunks) break;
    current.push(line);
    currentChars += line.length + 1;
  }
  if (chunks.length < maxChunks) flush();
  return chunks;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000) || 'knowledge_enrichment_failed';
}

export class KnowledgeEnrichmentService {
  private readonly options: KnowledgeEnrichmentServiceOptions;
  private runningPass?: Promise<KnowledgeEnrichmentPassResult>;
  private readonly active = new Set<AbortController>();
  private shuttingDown = false;

  constructor(options: KnowledgeEnrichmentServiceOptions) {
    this.options = options;
  }

  get running(): boolean {
    return Boolean(this.runningPass);
  }

  status(): {
    enabled: boolean;
    running: boolean;
    executor?: ExecutorDescriptor;
    batchSize: number;
  } {
    const executorId = this.options.executorId ?? this.options.executorRegistry.defaultExecutorId;
    return {
      enabled: this.options.enabled !== false,
      running: this.running,
      executor: this.options.executorRegistry.describe(executorId),
      batchSize: Math.max(1, Math.min(this.options.batchSize ?? 2, 20)),
    };
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const controller of this.active) controller.abort('knowledge_enrichment_shutdown');
  }

  async waitForIdle(): Promise<void> {
    await this.runningPass;
  }

  async runPass(limit = this.options.batchSize ?? 2): Promise<KnowledgeEnrichmentPassResult> {
    if (this.runningPass) return this.runningPass;
    if (this.shuttingDown || this.options.enabled === false) {
      return { claimed: 0, completed: 0, stale: 0, retried: 0, failed: 0, passages: 0, jobs: [] };
    }
    this.runningPass = this.executePass(limit);
    try {
      return await this.runningPass;
    } finally {
      this.runningPass = undefined;
    }
  }

  private async executePass(limit: number): Promise<KnowledgeEnrichmentPassResult> {
    const result: KnowledgeEnrichmentPassResult = {
      claimed: 0, completed: 0, stale: 0, retried: 0, failed: 0, passages: 0, jobs: [],
    };
    const claimed = await this.options.store.claimEnrichments({
      workerId: this.options.workerId,
      limit: Math.max(1, Math.min(limit, 20)),
      leaseMs: this.options.leaseMs,
    });
    result.claimed = claimed.length;
    for (const job of claimed) {
      if (this.shuttingDown) break;
      let terminal: KnowledgeSourceEnrichmentJob;
      try {
        terminal = await this.enrich(job);
      } catch (error) {
        const retryBaseMs = Math.max(1_000, Math.min(this.options.retryBaseMs ?? 5_000, 300_000));
        terminal = await this.options.store.retryEnrichment({
          id: job.id,
          workerId: this.options.workerId,
          error: compactError(error),
          retryAfterMs: retryBaseMs * 2 ** Math.max(0, job.attempts - 1),
        });
      }
      result.jobs.push(terminal);
      if (terminal.status === 'completed') {
        result.completed += 1;
        result.passages += terminal.passages.length;
      } else if (terminal.status === 'stale') result.stale += 1;
      else if (terminal.status === 'failed') result.failed += 1;
      else result.retried += 1;
    }
    return result;
  }

  private async enrich(job: KnowledgeSourceEnrichmentJob): Promise<KnowledgeSourceEnrichmentJob> {
    const source = await this.options.store.get(job.workspaceId, job.sourceId);
    if (!source || source.revision !== job.sourceRevision || source.contentHash !== job.contentHash) {
      return this.options.store.completeEnrichment({
        id: job.id,
        workerId: this.options.workerId,
        passages: [],
        executorId: 'stale-source-check',
      });
    }
    const executorId = this.options.executorId ?? this.options.executorRegistry.defaultExecutorId;
    const executor = this.options.executorRegistry.get(executorId);
    const descriptor = this.options.executorRegistry.describe(executorId);
    if (!executor || !descriptor || descriptor.status === 'unavailable') {
      throw new Error('knowledge_enrichment_executor_unavailable');
    }
    const chunks = numberedChunks(
      source.content,
      Math.max(4_000, Math.min(this.options.maxChunkChars ?? DEFAULT_CHUNK_CHARS, 44_000)),
      Math.max(1, Math.min(this.options.maxChunks ?? DEFAULT_MAX_CHUNKS, 12)),
    );
    const passages: KnowledgePassageCandidate[] = [];
    const usage: AgentRunUsage = {};
    for (const [index, chunk] of chunks.entries()) {
      if (this.shuttingDown) throw new Error('knowledge_enrichment_shutdown');
      const controller = new AbortController();
      this.active.add(controller);
      try {
        const runId = `knowledge-enrichment:${job.id}:${index + 1}`;
        const threadId = `knowledge:${job.workspaceId}:${job.sourceId}`;
        const run = await executor.run({
          runId,
          purpose: 'knowledge_enrichment',
          workspace: { id: job.workspaceId, name: job.workspaceId },
          thread: {
            id: threadId,
            platform: 'knowledge-ingress',
            externalId: job.sourceId,
            workspaceId: job.workspaceId,
            visibility: 'private',
          },
          message: {
            id: `${runId}:message`,
            threadId,
            platform: 'knowledge-ingress',
            text: `Index source ${job.sourceId} revision ${job.sourceRevision}, chunk ${index + 1} of ${chunks.length}.`,
            actor: { id: 'opentag-knowledge-ingress', isBot: true },
            createdAt: new Date().toISOString(),
            mentionsAgent: true,
          },
          identity: {
            id: 'opentag-knowledge-enrichment',
            displayName: 'MaxTag Knowledge Enrichment',
            instructions: 'Create only verified semantic passage declarations.',
            defaultExecutorId: executorId,
          },
          access: {
            id: `knowledge-enrichment:${job.id}`,
            threadId,
            workspaceId: job.workspaceId,
            grants: [],
            networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
          },
          memory: [
            `Source: ${source.name} [${source.id}]`,
            `Revision: ${source.revision}`,
            `SHA-256: ${source.contentHash}`,
            `Chunk: ${index + 1}/${chunks.length}`,
            '',
            chunk,
          ].join('\n'),
          abortSignal: controller.signal,
        });
        passages.push(...(run.knowledgePassages ?? []));
        addUsage(usage, run.usage);
      } finally {
        this.active.delete(controller);
      }
    }
    return this.options.store.completeEnrichment({
      id: job.id,
      workerId: this.options.workerId,
      passages,
      executorId,
      model: descriptor.model,
      usage: Object.keys(usage).length ? usage : undefined,
    });
  }
}
