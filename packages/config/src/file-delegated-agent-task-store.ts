import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentRunUsage,
  DelegatedAgentTask,
  DelegatedAgentTaskAccessSnapshot,
  DelegatedAgentTaskStore,
  MemoryScopeKind,
  SourceThread,
} from '@opentag/core';

interface DelegatedAgentTaskState {
  version: 1;
  tasks: DelegatedAgentTask[];
}

export interface DelegatedAgentTaskSummary {
  tasks: Record<DelegatedAgentTask['status'], number>;
  oldestStatusUpdatedAt: Partial<Record<DelegatedAgentTask['status'], string>>;
}

function now(): string {
  return new Date().toISOString();
}

function clean(value: string, limit: number, error: string): string {
  const result = value.replace(/\r\n?/gu, '\n').replace(/\0/gu, '').trim();
  if (!result || result.length > limit) throw new Error(error);
  return result;
}

function containsCredential(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:api[_ -]?key|app[_ -]?secret|client[_ -]?secret|password|passwd|access[_ -]?token|refresh[_ -]?token|verification[_ -]?token)\b\s*[:=]\s*\S+/iu.test(
      value,
    )
  );
}

function id(value: string, error: string): string {
  const result = value.trim();
  if (!result || result.length > 200 || !/^[a-zA-Z0-9_.:-]+$/u.test(result)) {
    throw new Error(error);
  }
  return result;
}

function strings(values: string[], maximum = 100): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, maximum);
}

function scopes(values: MemoryScopeKind[]): MemoryScopeKind[] {
  const allowed: MemoryScopeKind[] = ['workspace', 'project', 'channel', 'thread'];
  return [...new Set(values.filter((value) => allowed.includes(value)))];
}

function cloneAccess(value: DelegatedAgentTaskAccessSnapshot): DelegatedAgentTaskAccessSnapshot {
  return {
    skillIds: [...value.skillIds],
    knowledgeSourceIds: [...value.knowledgeSourceIds],
    grantIds: [...value.grantIds],
    memoryScopes: [...value.memoryScopes],
    networkPolicy: {
      mode: value.networkPolicy.mode,
      allowedHosts: [...value.networkPolicy.allowedHosts],
    },
  };
}

function cloneTask(task: DelegatedAgentTask): DelegatedAgentTask {
  return {
    ...task,
    thread: { ...task.thread, metadata: task.thread.metadata ? { ...task.thread.metadata } : undefined },
    accessSnapshot: cloneAccess(task.accessSnapshot),
    usage: task.usage ? { ...task.usage } : undefined,
    policy: task.policy ? {
      ...task.policy,
      skillIds: [...task.policy.skillIds],
      grantIds: [...task.policy.grantIds],
      memoryScopes: [...task.policy.memoryScopes],
      knowledgeSourceIds: [...task.policy.knowledgeSourceIds],
      networkHosts: [...task.policy.networkHosts],
    } : undefined,
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

function normalizeThread(value: unknown): SourceThread | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const thread = value as Partial<SourceThread>;
  if (
    typeof thread.id !== 'string' || typeof thread.platform !== 'string' ||
    typeof thread.externalId !== 'string' ||
    !['public', 'private', 'direct'].includes(String(thread.visibility))
  ) return undefined;
  return {
    ...thread,
    id: thread.id,
    platform: thread.platform,
    externalId: thread.externalId,
    visibility: thread.visibility as SourceThread['visibility'],
    metadata: thread.metadata && typeof thread.metadata === 'object'
      ? { ...thread.metadata }
      : undefined,
  };
}

function normalizeTask(value: unknown): DelegatedAgentTask | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<DelegatedAgentTask>;
  const thread = normalizeThread(item.thread);
  if (
    !thread || typeof item.id !== 'string' || typeof item.parentRunId !== 'string' ||
    typeof item.workspaceId !== 'string' || typeof item.agentId !== 'string' ||
    !Number.isInteger(item.agentRevision) || typeof item.task !== 'string' ||
    typeof item.taskPreview !== 'string' || typeof item.createdBy !== 'string' ||
    !item.accessSnapshot || typeof item.accessSnapshot !== 'object' ||
    !['queued', 'claimed', 'completed', 'failed', 'cancelled', 'stale'].includes(String(item.status)) ||
    !Number.isInteger(item.attempts) || !Number.isInteger(item.maxAttempts) ||
    typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' ||
    typeof item.availableAt !== 'string'
  ) return undefined;
  const access = item.accessSnapshot as Partial<DelegatedAgentTaskAccessSnapshot>;
  if (
    !Array.isArray(access.skillIds) || !Array.isArray(access.knowledgeSourceIds) ||
    !Array.isArray(access.grantIds) || !Array.isArray(access.memoryScopes) ||
    !access.networkPolicy ||
    !['deny-by-default', 'restricted', 'allow-all'].includes(String(access.networkPolicy.mode)) ||
    !Array.isArray(access.networkPolicy.allowedHosts)
  ) return undefined;
  return cloneTask({
    ...item,
    id: item.id,
    status: item.status as DelegatedAgentTask['status'],
    parentRunId: item.parentRunId,
    workspaceId: item.workspaceId,
    thread,
    agentId: item.agentId,
    agentRevision: Math.max(1, Math.floor(item.agentRevision!)),
    task: item.task,
    taskPreview: item.taskPreview,
    createdBy: item.createdBy,
    accessSnapshot: {
      skillIds: strings(access.skillIds as string[]),
      knowledgeSourceIds: strings(access.knowledgeSourceIds as string[]),
      grantIds: strings(access.grantIds as string[]),
      memoryScopes: scopes(access.memoryScopes as MemoryScopeKind[]),
      networkPolicy: {
        mode: access.networkPolicy.mode,
        allowedHosts: strings(access.networkPolicy.allowedHosts),
      },
    },
    attempts: Math.max(0, Math.floor(item.attempts!)),
    maxAttempts: Math.max(1, Math.floor(item.maxAttempts!)),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    availableAt: item.availableAt,
  } as DelegatedAgentTask);
}

export class FileDelegatedAgentTaskStore implements DelegatedAgentTaskStore {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'delegated-agent-tasks.json');
    this.lockFile = `${this.stateFile}.lock`;
  }

  private async load(): Promise<DelegatedAgentTaskState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Partial<DelegatedAgentTaskState>;
      return {
        version: 1,
        tasks: Array.isArray(parsed.tasks)
          ? parsed.tasks.flatMap((item) => {
              const task = normalizeTask(item);
              return task ? [task] : [];
            })
          : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tasks: [] };
      throw error;
    }
  }

  private async save(state: DelegatedAgentTaskState): Promise<void> {
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
        await handle.writeFile(`${owner}\n${now()}\n`, 'utf8');
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
        if (Date.now() >= deadline) throw new Error('delegated_agent_task_store_lock_timeout');
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
  }

  private async mutate<T>(operation: (state: DelegatedAgentTaskState) => T): Promise<T> {
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

  async create(input: {
    parentRunId: string;
    workspaceId: string;
    projectId?: string;
    thread: SourceThread;
    agentId: string;
    agentRevision: number;
    task: string;
    createdBy: string;
    accessSnapshot: DelegatedAgentTaskAccessSnapshot;
  }): Promise<DelegatedAgentTask> {
    const task = clean(input.task, 12_000, 'delegated_agent_task_invalid');
    if (containsCredential(task)) {
      throw new Error('delegated_agent_task_credentials_not_allowed');
    }
    const timestamp = now();
    const record: DelegatedAgentTask = {
      id: randomUUID(),
      status: 'queued',
      parentRunId: id(input.parentRunId, 'delegated_agent_task_parent_invalid'),
      workspaceId: id(input.workspaceId, 'delegated_agent_task_workspace_invalid'),
      projectId: input.projectId?.trim() || undefined,
      thread: { ...input.thread, metadata: input.thread.metadata ? { ...input.thread.metadata } : undefined },
      agentId: id(input.agentId, 'delegated_agent_task_agent_invalid'),
      agentRevision: Math.max(1, Math.floor(input.agentRevision)),
      task,
      taskPreview: task.replace(/\s+/gu, ' ').slice(0, 180),
      createdBy: clean(input.createdBy, 200, 'delegated_agent_task_actor_invalid'),
      accessSnapshot: {
        skillIds: strings(input.accessSnapshot.skillIds),
        knowledgeSourceIds: strings(input.accessSnapshot.knowledgeSourceIds),
        grantIds: strings(input.accessSnapshot.grantIds),
        memoryScopes: scopes(input.accessSnapshot.memoryScopes),
        networkPolicy: {
          mode: input.accessSnapshot.networkPolicy.mode,
          allowedHosts: strings(input.accessSnapshot.networkPolicy.allowedHosts),
        },
      },
      attempts: 0,
      maxAttempts: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
      availableAt: timestamp,
    };
    return this.mutate((state) => {
      state.tasks.push(record);
      if (state.tasks.length > 2_000) {
        const active = state.tasks.filter((item) => item.status === 'queued' || item.status === 'claimed');
        const terminal = state.tasks.filter((item) => item.status !== 'queued' && item.status !== 'claimed')
          .slice(-Math.max(0, 2_000 - active.length));
        state.tasks = [...terminal, ...active];
      }
      return cloneTask(record);
    });
  }

  async get(taskId: string): Promise<DelegatedAgentTask | undefined> {
    await this.mutationQueue;
    const task = (await this.load()).tasks.find((item) => item.id === taskId.trim());
    return task ? cloneTask(task) : undefined;
  }

  async list(input: {
    workspaceId?: string;
    projectId?: string;
    threadId?: string;
    parentRunId?: string;
    status?: DelegatedAgentTask['status'];
    limit?: number;
  } = {}): Promise<DelegatedAgentTask[]> {
    await this.mutationQueue;
    return (await this.load()).tasks
      .filter((task) => !input.workspaceId || task.workspaceId === input.workspaceId)
      .filter((task) => !input.projectId || task.projectId === input.projectId)
      .filter((task) => !input.threadId || task.thread.id === input.threadId)
      .filter((task) => !input.parentRunId || task.parentRunId === input.parentRunId)
      .filter((task) => !input.status || task.status === input.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(input.limit ?? 100, 500)))
      .map(cloneTask);
  }

  async referencedRunIds(workspaceId: string): Promise<string[]> {
    await this.mutationQueue;
    return [...new Set(
      (await this.load()).tasks
        .filter((task) => task.workspaceId === workspaceId)
        .flatMap((task) => [
          task.parentRunId,
          ...(task.continuationRunId ? [task.continuationRunId] : []),
        ]),
    )];
  }

  async summarize(): Promise<DelegatedAgentTaskSummary> {
    await this.mutationQueue;
    const tasks: DelegatedAgentTaskSummary['tasks'] = {
      queued: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      stale: 0,
    };
    const oldestStatusUpdatedAt: DelegatedAgentTaskSummary['oldestStatusUpdatedAt'] = {};
    for (const task of (await this.load()).tasks) {
      tasks[task.status] += 1;
      const oldest = oldestStatusUpdatedAt[task.status];
      if (!oldest || task.updatedAt < oldest) oldestStatusUpdatedAt[task.status] = task.updatedAt;
    }
    return { tasks, oldestStatusUpdatedAt };
  }

  async claim(input: { workerId: string; limit?: number; leaseMs?: number }): Promise<DelegatedAgentTask[]> {
    const workerId = clean(input.workerId, 200, 'delegated_agent_task_worker_invalid');
    const timestamp = now();
    const currentMs = Date.parse(timestamp);
    const leaseMs = Math.max(1_000, Math.min(input.leaseMs ?? 120_000, 900_000));
    return this.mutate((state) => state.tasks
      .filter((task) => {
        if (task.attempts >= task.maxAttempts) return false;
        if (task.status === 'queued') return Date.parse(task.availableAt) <= currentMs;
        return task.status === 'claimed' && Boolean(task.claimedAt) &&
          Date.parse(task.claimedAt!) + leaseMs <= currentMs;
      })
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.max(1, Math.min(input.limit ?? 2, 20)))
      .map((task) => {
        task.status = 'claimed';
        task.claimedAt = timestamp;
        task.claimedBy = workerId;
        task.updatedAt = timestamp;
        task.attempts += 1;
        task.error = undefined;
        return cloneTask(task);
      }));
  }

  async complete(input: {
    id: string;
    workerId: string;
    status?: 'completed' | 'stale';
    summary?: string;
    error?: string;
    executorId?: string;
    model?: string;
    usage?: AgentRunUsage;
    policy?: DelegatedAgentTask['policy'];
  }): Promise<DelegatedAgentTask> {
    if (input.summary && containsCredential(input.summary)) {
      throw new Error('delegated_agent_task_result_credentials_not_allowed');
    }
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === input.id.trim());
      if (!task) throw new Error('delegated_agent_task_not_found');
      if (task.status !== 'claimed' || task.claimedBy !== input.workerId.trim()) {
        throw new Error('delegated_agent_task_claim_lost');
      }
      const timestamp = now();
      task.status = input.status ?? 'completed';
      task.summary = input.summary?.trim().slice(0, 24_000) || undefined;
      task.error = input.error?.replace(/\s+/gu, ' ').trim().slice(0, 1_000) || undefined;
      task.executorId = input.executorId?.trim().slice(0, 120) || undefined;
      task.model = input.model?.trim().slice(0, 200) || undefined;
      task.usage = input.usage ? { ...input.usage } : undefined;
      task.policy = input.policy ? cloneTask({ ...task, policy: input.policy }).policy : undefined;
      task.completedAt = timestamp;
      task.updatedAt = timestamp;
      return cloneTask(task);
    });
  }

  async retry(input: { id: string; workerId: string; error: string; retryAfterMs?: number }): Promise<DelegatedAgentTask> {
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === input.id.trim());
      if (!task) throw new Error('delegated_agent_task_not_found');
      if (task.status !== 'claimed' || task.claimedBy !== input.workerId.trim()) {
        throw new Error('delegated_agent_task_claim_lost');
      }
      const timestamp = now();
      const terminal = task.attempts >= task.maxAttempts;
      task.status = terminal ? 'failed' : 'queued';
      task.error = input.error.replace(/\s+/gu, ' ').trim().slice(0, 1_000) || 'delegated_agent_task_failed';
      task.updatedAt = timestamp;
      task.claimedAt = undefined;
      task.claimedBy = undefined;
      if (terminal) task.completedAt = timestamp;
      else task.availableAt = new Date(Date.now() + Math.max(1_000, Math.min(input.retryAfterMs ?? 5_000, 900_000))).toISOString();
      return cloneTask(task);
    });
  }

  async cancel(input: { id: string; actor: string }): Promise<DelegatedAgentTask> {
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === input.id.trim());
      if (!task) throw new Error('delegated_agent_task_not_found');
      if (
        task.status === 'completed' ||
        task.status === 'failed' ||
        task.status === 'cancelled' ||
        task.status === 'stale'
      ) {
        throw new Error('delegated_agent_task_terminal');
      }
      const timestamp = now();
      task.status = 'cancelled';
      task.cancelledAt = timestamp;
      task.cancelledBy = clean(input.actor, 200, 'delegated_agent_task_actor_invalid');
      task.updatedAt = timestamp;
      return cloneTask(task);
    });
  }

  async markContinuation(input: { id: string; runId: string }): Promise<DelegatedAgentTask> {
    return this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === input.id.trim());
      if (!task) throw new Error('delegated_agent_task_not_found');
      if (!['completed', 'failed', 'stale'].includes(task.status)) {
        throw new Error('delegated_agent_task_not_terminal');
      }
      if (task.continuationRunId && task.continuationRunId !== input.runId.trim()) {
        throw new Error('delegated_agent_task_continuation_conflict');
      }
      task.continuationRunId = clean(
        input.runId,
        200,
        'delegated_agent_task_continuation_invalid',
      );
      task.continuationScheduledAt ??= now();
      task.updatedAt = now();
      return cloneTask(task);
    });
  }
}
