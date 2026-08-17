import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeSource } from '@opentag/core';

export type KnowledgeSourceRefreshStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'stale';

export interface KnowledgeSourceRefreshJob {
  id: string;
  workspaceId: string;
  sourceId: string;
  sourceRevision: number;
  sourceUri: string;
  status: KnowledgeSourceRefreshStatus;
  outcome?: 'updated' | 'unchanged' | 'not-modified';
  requestedBy: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  error?: string;
  resolvedUri?: string;
  sourceRevisionResult?: number;
  contentHash?: string;
  mediaType?: string;
  extractor?: string;
  inputBytes?: number;
  etag?: string;
  lastModified?: string;
}

export interface KnowledgeSourceRefreshSummary {
  jobs: Record<KnowledgeSourceRefreshStatus, number>;
  oldestStatusUpdatedAt: Partial<Record<KnowledgeSourceRefreshStatus, string>>;
}

export interface KnowledgeSourceRefreshScheduleResult {
  due: number;
  queued: KnowledgeSourceRefreshJob[];
  active: number;
}

interface KnowledgeSourceRefreshState {
  version: 1;
  jobs: KnowledgeSourceRefreshJob[];
}

function timestamp(): string {
  return new Date().toISOString();
}

function compact(value: string, limit: number, error: string): string {
  const result = value.replace(/[\0\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!result || result.length > limit) throw new Error(error);
  return result;
}

function workspaceId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 160 || !/^[a-zA-Z0-9_.:-]+$/u.test(id)) {
    throw new Error('knowledge_refresh_workspace_invalid');
  }
  return id;
}

function sourceId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id)) {
    throw new Error('knowledge_refresh_source_invalid');
  }
  return id;
}

function sourceUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('knowledge_refresh_uri_invalid');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    parsed.href.length > 2_000
  ) throw new Error('knowledge_refresh_uri_invalid');
  return parsed.href;
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

function clone(job: KnowledgeSourceRefreshJob): KnowledgeSourceRefreshJob {
  return { ...job };
}

type ScheduledKnowledgeSource = Pick<
  KnowledgeSource,
  'workspaceId' | 'id' | 'kind' | 'sourceUri' | 'enabled' |
  'revision' | 'updatedAt' | 'refreshIntervalMs'
>;

function scheduledBaseline(
  source: ScheduledKnowledgeSource,
  jobs: KnowledgeSourceRefreshJob[],
): string {
  const latest = jobs
    .filter((job) =>
      job.workspaceId === source.workspaceId && job.sourceId === source.id &&
      job.sourceUri === source.sourceUri &&
      (job.sourceRevision === source.revision || job.sourceRevisionResult === source.revision),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return latest?.updatedAt || source.updatedAt;
}

export function knowledgeSourceNextRefreshAt(
  source: ScheduledKnowledgeSource,
  jobs: KnowledgeSourceRefreshJob[],
): string | undefined {
  if (
    !source.enabled || source.kind !== 'url' || !source.sourceUri ||
    !Number.isInteger(source.refreshIntervalMs) || source.refreshIntervalMs! <= 0
  ) return undefined;
  return new Date(
    Date.parse(scheduledBaseline(source, jobs)) + source.refreshIntervalMs!,
  ).toISOString();
}

function normalizedJob(value: unknown): KnowledgeSourceRefreshJob | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const job = value as Partial<KnowledgeSourceRefreshJob>;
  try {
    if (
      typeof job.id !== 'string' || typeof job.workspaceId !== 'string' ||
      typeof job.sourceId !== 'string' || !Number.isInteger(job.sourceRevision) ||
      typeof job.sourceUri !== 'string' ||
      !['pending', 'claimed', 'completed', 'failed', 'stale'].includes(String(job.status)) ||
      typeof job.requestedBy !== 'string' || !Number.isInteger(job.attempts) ||
      !Number.isInteger(job.maxAttempts) || typeof job.createdAt !== 'string' ||
      typeof job.updatedAt !== 'string' || typeof job.availableAt !== 'string'
    ) return undefined;
    return {
      ...job,
      id: compact(job.id, 200, 'knowledge_refresh_id_invalid'),
      workspaceId: workspaceId(job.workspaceId),
      sourceId: sourceId(job.sourceId),
      sourceRevision: Math.max(1, Math.floor(job.sourceRevision!)),
      sourceUri: sourceUri(job.sourceUri),
      status: job.status as KnowledgeSourceRefreshStatus,
      requestedBy: compact(job.requestedBy, 200, 'knowledge_refresh_actor_invalid'),
      attempts: Math.max(0, Math.floor(job.attempts!)),
      maxAttempts: Math.max(1, Math.floor(job.maxAttempts!)),
    } as KnowledgeSourceRefreshJob;
  } catch {
    return undefined;
  }
}

export class FileKnowledgeSourceRefreshStore {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'knowledge-source-refresh-jobs.json');
    this.lockFile = `${this.stateFile}.lock`;
  }

  private async load(): Promise<KnowledgeSourceRefreshState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Partial<KnowledgeSourceRefreshState>;
      return {
        version: 1,
        jobs: Array.isArray(parsed.jobs)
          ? parsed.jobs.flatMap((item) => {
              const job = normalizedJob(item);
              return job ? [job] : [];
            })
          : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, jobs: [] };
      throw error;
    }
  }

  private async save(state: KnowledgeSourceRefreshState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporary, this.stateFile);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const owner = `${process.pid}:${randomUUID()}`;
        const handle = await fs.open(this.lockFile, 'wx');
        await handle.writeFile(`${owner}\n${timestamp()}\n`, 'utf8');
        return async () => {
          await handle.close().catch(() => undefined);
          const current = await fs.readFile(this.lockFile, 'utf8')
            .then((value) => value.split('\n', 1)[0])
            .catch(() => undefined);
          if (current === owner) await fs.unlink(this.lockFile).catch(() => undefined);
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
        if (Date.now() >= deadline) throw new Error('knowledge_refresh_store_lock_timeout');
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
  }

  private async mutate<T>(operation: (state: KnowledgeSourceRefreshState) => T): Promise<T> {
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

  async enqueue(input: {
    workspaceId: string;
    sourceId: string;
    sourceRevision: number;
    sourceUri: string;
    requestedBy: string;
  }): Promise<{ job: KnowledgeSourceRefreshJob; duplicate: boolean }> {
    const workspace = workspaceId(input.workspaceId);
    const source = sourceId(input.sourceId);
    const uri = sourceUri(input.sourceUri);
    const actor = compact(input.requestedBy, 200, 'knowledge_refresh_actor_invalid');
    if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 1) {
      throw new Error('knowledge_refresh_revision_invalid');
    }
    return this.mutate((state) => {
      const duplicate = state.jobs.find((job) =>
        job.workspaceId === workspace && job.sourceId === source &&
        job.sourceRevision === input.sourceRevision && job.sourceUri === uri &&
        (job.status === 'pending' || job.status === 'claimed'),
      );
      if (duplicate) return { job: clone(duplicate), duplicate: true };
      const previous = state.jobs
        .filter((job) =>
          job.workspaceId === workspace && job.sourceId === source &&
          job.sourceUri === uri && job.sourceRevisionResult === input.sourceRevision &&
          job.status === 'completed',
        )
        .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))[0];
      const at = timestamp();
      const job: KnowledgeSourceRefreshJob = {
        id: randomUUID(), workspaceId: workspace, sourceId: source,
        sourceRevision: input.sourceRevision, sourceUri: uri,
        status: 'pending', requestedBy: actor, attempts: 0, maxAttempts: 5,
        createdAt: at, updatedAt: at, availableAt: at,
        etag: previous?.etag, lastModified: previous?.lastModified,
      };
      state.jobs.push(job);
      if (state.jobs.length > 2_000) {
        const active = state.jobs.filter((item) => item.status === 'pending' || item.status === 'claimed');
        const terminal = state.jobs.filter((item) => item.status !== 'pending' && item.status !== 'claimed')
          .slice(-Math.max(0, 2_000 - active.length));
        state.jobs = [...terminal, ...active];
      }
      return { job: clone(job), duplicate: false };
    });
  }

  async enqueueDue(input: {
    sources: KnowledgeSource[];
    requestedBy?: string;
    now?: string;
    limit?: number;
  }): Promise<KnowledgeSourceRefreshScheduleResult> {
    const actor = compact(
      input.requestedBy || 'knowledge-refresh-scheduler',
      200,
      'knowledge_refresh_actor_invalid',
    );
    const at = input.now ? new Date(input.now).toISOString() : timestamp();
    const currentMs = Date.parse(at);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return this.mutate((state) => {
      const due = input.sources
        .filter((source) =>
          source.enabled && source.kind === 'url' && Boolean(source.sourceUri) &&
          Number.isInteger(source.refreshIntervalMs) && source.refreshIntervalMs! > 0,
        )
        .filter((source) =>
          Date.parse(knowledgeSourceNextRefreshAt(source, state.jobs)!) <= currentMs,
        )
        .sort((left, right) =>
          scheduledBaseline(left, state.jobs).localeCompare(scheduledBaseline(right, state.jobs)) ||
          left.workspaceId.localeCompare(right.workspaceId) || left.id.localeCompare(right.id),
        );
      const queued: KnowledgeSourceRefreshJob[] = [];
      let active = 0;
      for (const source of due) {
        const duplicate = state.jobs.find((job) =>
          job.workspaceId === source.workspaceId && job.sourceId === source.id &&
          job.sourceRevision === source.revision && job.sourceUri === source.sourceUri &&
          (job.status === 'pending' || job.status === 'claimed'),
        );
        if (duplicate) {
          active += 1;
          continue;
        }
        if (queued.length >= limit) continue;
        const previous = state.jobs
          .filter((job) =>
            job.workspaceId === source.workspaceId && job.sourceId === source.id &&
            job.sourceUri === source.sourceUri &&
            job.sourceRevisionResult === source.revision && job.status === 'completed',
          )
          .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))[0];
        const job: KnowledgeSourceRefreshJob = {
          id: randomUUID(), workspaceId: source.workspaceId, sourceId: source.id,
          sourceRevision: source.revision, sourceUri: source.sourceUri!, status: 'pending',
          requestedBy: actor, attempts: 0, maxAttempts: 5,
          createdAt: at, updatedAt: at, availableAt: at,
          etag: previous?.etag, lastModified: previous?.lastModified,
        };
        state.jobs.push(job);
        queued.push(clone(job));
      }
      if (state.jobs.length > 2_000) {
        const live = state.jobs.filter((job) => job.status === 'pending' || job.status === 'claimed');
        const terminal = state.jobs.filter((job) => job.status !== 'pending' && job.status !== 'claimed')
          .slice(-Math.max(0, 2_000 - live.length));
        state.jobs = [...terminal, ...live];
      }
      return { due: due.length, queued, active };
    });
  }

  async get(id: string): Promise<KnowledgeSourceRefreshJob | undefined> {
    await this.mutationQueue;
    const job = (await this.load()).jobs.find((item) => item.id === id.trim());
    return job ? clone(job) : undefined;
  }

  async list(input: {
    workspaceId?: string;
    sourceId?: string;
    status?: KnowledgeSourceRefreshStatus;
    limit?: number;
  } = {}): Promise<KnowledgeSourceRefreshJob[]> {
    await this.mutationQueue;
    const workspace = input.workspaceId ? workspaceId(input.workspaceId) : undefined;
    const source = input.sourceId ? sourceId(input.sourceId) : undefined;
    return (await this.load()).jobs
      .filter((job) => !workspace || job.workspaceId === workspace)
      .filter((job) => !source || job.sourceId === source)
      .filter((job) => !input.status || job.status === input.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(input.limit ?? 100, 500)))
      .map(clone);
  }

  async summarize(): Promise<KnowledgeSourceRefreshSummary> {
    await this.mutationQueue;
    const jobs = {
      pending: 0, claimed: 0, completed: 0, failed: 0, stale: 0,
    } satisfies Record<KnowledgeSourceRefreshStatus, number>;
    const oldestStatusUpdatedAt: Partial<Record<KnowledgeSourceRefreshStatus, string>> = {};
    for (const job of (await this.load()).jobs) {
      jobs[job.status] += 1;
      const current = oldestStatusUpdatedAt[job.status];
      if (!current || job.updatedAt < current) oldestStatusUpdatedAt[job.status] = job.updatedAt;
    }
    return { jobs, oldestStatusUpdatedAt };
  }

  async claim(input: { workerId: string; limit?: number; leaseMs?: number }): Promise<KnowledgeSourceRefreshJob[]> {
    const worker = compact(input.workerId, 200, 'knowledge_refresh_worker_invalid');
    const at = timestamp();
    const currentMs = Date.parse(at);
    const leaseMs = Math.max(1_000, Math.min(input.leaseMs ?? 120_000, 900_000));
    const dueOrExpired = (job: KnowledgeSourceRefreshJob): boolean => {
      if (job.status === 'pending') {
        return job.attempts < job.maxAttempts && Date.parse(job.availableAt) <= currentMs;
      }
      return job.status === 'claimed' && Boolean(job.claimedAt) &&
        Date.parse(job.claimedAt!) + leaseMs <= currentMs;
    };
    // Avoid contending on and rewriting the shared file for empty polling
    // passes. A job added after this read is intentionally picked up on the
    // next pass and every candidate is checked again under the mutation lock.
    await this.mutationQueue;
    if (!(await this.load()).jobs.some(dueOrExpired)) return [];
    return this.mutate((state) => {
      for (const job of state.jobs) {
        const lostLease = job.status === 'claimed' && Boolean(job.claimedAt) &&
          Date.parse(job.claimedAt!) + leaseMs <= currentMs;
        if (lostLease && job.attempts >= job.maxAttempts) {
          job.status = 'failed';
          job.error = 'knowledge_refresh_lease_expired_after_max_attempts';
          job.updatedAt = at;
          job.completedAt = at;
          job.claimedAt = undefined;
          job.claimedBy = undefined;
        }
      }
      return state.jobs
        .filter((job) => {
          if (job.attempts >= job.maxAttempts) return false;
          if (job.status === 'pending') return Date.parse(job.availableAt) <= currentMs;
          return job.status === 'claimed' && Boolean(job.claimedAt) &&
            Date.parse(job.claimedAt!) + leaseMs <= currentMs;
        })
        .sort((left, right) => left.availableAt.localeCompare(right.availableAt))
        .slice(0, Math.max(1, Math.min(input.limit ?? 2, 20)))
        .map((job) => {
        job.status = 'claimed'; job.claimedAt = at; job.claimedBy = worker;
        job.updatedAt = at; job.attempts += 1; job.error = undefined;
        return clone(job);
        });
    });
  }

  async complete(input: {
    id: string;
    workerId: string;
    outcome: 'updated' | 'unchanged' | 'not-modified';
    resolvedUri: string;
    sourceRevision: number;
    contentHash: string;
    mediaType?: string;
    extractor?: string;
    inputBytes?: number;
    etag?: string;
    lastModified?: string;
  }): Promise<KnowledgeSourceRefreshJob> {
    return this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === input.id.trim());
      if (!job) throw new Error('knowledge_refresh_not_found');
      if (job.status !== 'claimed' || job.claimedBy !== input.workerId.trim()) {
        throw new Error('knowledge_refresh_claim_lost');
      }
      const at = timestamp();
      Object.assign(job, {
        status: 'completed', outcome: input.outcome, updatedAt: at, completedAt: at,
        claimedAt: undefined, claimedBy: undefined, error: undefined,
        resolvedUri: sourceUri(input.resolvedUri), sourceRevisionResult: input.sourceRevision,
        contentHash: input.contentHash, mediaType: input.mediaType?.slice(0, 120),
        extractor: input.extractor?.slice(0, 120), inputBytes: input.inputBytes,
        etag: input.etag?.slice(0, 500), lastModified: input.lastModified?.slice(0, 500),
      });
      return clone(job);
    });
  }

  async stale(input: { id: string; workerId: string; error: string }): Promise<KnowledgeSourceRefreshJob> {
    return this.finish(input, 'stale');
  }

  async retry(input: { id: string; workerId: string; error: string; retryAfterMs?: number }): Promise<KnowledgeSourceRefreshJob> {
    return this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === input.id.trim());
      if (!job) throw new Error('knowledge_refresh_not_found');
      if (job.status !== 'claimed' || job.claimedBy !== input.workerId.trim()) {
        throw new Error('knowledge_refresh_claim_lost');
      }
      const at = timestamp();
      const terminal = job.attempts >= job.maxAttempts;
      job.status = terminal ? 'failed' : 'pending';
      job.error = compact(input.error || 'knowledge_refresh_failed', 1_000, 'knowledge_refresh_error_invalid');
      job.updatedAt = at; job.claimedAt = undefined; job.claimedBy = undefined;
      if (terminal) job.completedAt = at;
      else job.availableAt = new Date(Date.now() + Math.max(1_000, Math.min(input.retryAfterMs ?? 5_000, 900_000))).toISOString();
      return clone(job);
    });
  }

  private async finish(
    input: { id: string; workerId: string; error: string },
    status: 'stale',
  ): Promise<KnowledgeSourceRefreshJob> {
    return this.mutate((state) => {
      const job = state.jobs.find((item) => item.id === input.id.trim());
      if (!job) throw new Error('knowledge_refresh_not_found');
      if (job.status !== 'claimed' || job.claimedBy !== input.workerId.trim()) {
        throw new Error('knowledge_refresh_claim_lost');
      }
      const at = timestamp();
      job.status = status; job.error = compact(input.error, 1_000, 'knowledge_refresh_error_invalid');
      job.updatedAt = at; job.completedAt = at; job.claimedAt = undefined; job.claimedBy = undefined;
      return clone(job);
    });
  }
}
