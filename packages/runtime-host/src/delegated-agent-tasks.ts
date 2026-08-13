import type {
  AccessBundle,
  AgentRunEvent,
  AgentRunRequest,
  DelegatedAgentDefinition,
  DelegatedAgentTask,
  Executor,
  KnowledgeSource,
  MemoryScopeKind,
  MemoryStore,
  ThreadConfigStore,
} from '@opentag/core';
import { memoryScopeGranted } from '@opentag/core';
import {
  FileAgentSkillStore,
  FileDelegatedAgentStore,
  FileDelegatedAgentTaskStore,
  FileKnowledgeSourceStore,
} from '@opentag/config';
import type { DeliveryStore } from '@opentag/delivery';

export interface DelegatedAgentTaskServiceOptions {
  store: FileDelegatedAgentTaskStore;
  agentStore: FileDelegatedAgentStore;
  skillStore: FileAgentSkillStore;
  knowledgeStore: FileKnowledgeSourceStore;
  memoryStore: MemoryStore;
  threadConfigStore: ThreadConfigStore & {
    resolveThreadPolicy?(thread: DelegatedAgentTask['thread']): Promise<{
      identity: AgentRunRequest['identity'];
      access: AccessBundle;
      workspace?: AgentRunRequest['workspace'];
      project?: AgentRunRequest['project'];
    }>;
  };
  deliveryStore: DeliveryStore;
  resolveExecutor(definition: DelegatedAgentDefinition): Executor | undefined;
  workerId: string;
  enabled?: boolean;
  batchSize?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  onCompleted?: (task: DelegatedAgentTask) => Promise<string | undefined>;
}

export interface DelegatedAgentTaskPassResult {
  claimed: number;
  completed: number;
  stale: number;
  cancelled: number;
  retried: number;
  failed: number;
  tasks: DelegatedAgentTask[];
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000) || 'delegated_agent_task_failed';
}

function intersect<T>(current: T[], ceiling: T[]): T[] {
  const allowed = new Set(ceiling);
  return current.filter((value) => allowed.has(value));
}

function readOnlyGrant(grant: AccessBundle['grants'][number]): AccessBundle['grants'][number] {
  return { ...grant, constraints: { ...grant.constraints, permissions: ['read'] } };
}

function readAllowed(grant: AccessBundle['grants'][number]): boolean {
  const permissions = grant.constraints?.permissions;
  return !Array.isArray(permissions) || permissions.includes('read');
}

function networkPolicy(
  current: AccessBundle['networkPolicy'],
  approved: AccessBundle['networkPolicy'],
  definition: DelegatedAgentDefinition,
): AccessBundle['networkPolicy'] {
  if (current.mode === 'deny-by-default' || approved.mode === 'deny-by-default') {
    return { mode: 'deny-by-default', allowedHosts: [] };
  }
  const approvedHosts = approved.mode === 'allow-all'
    ? definition.networkHosts
    : definition.networkHosts.filter((host) => approved.allowedHosts.includes(host));
  const allowed = current.mode === 'allow-all'
    ? approvedHosts
    : approvedHosts.filter((host) => current.allowedHosts.includes(host));
  return allowed.length
    ? { mode: 'restricted', allowedHosts: allowed }
    : { mode: 'deny-by-default', allowedHosts: [] };
}

export class DelegatedAgentTaskService {
  private pass?: Promise<DelegatedAgentTaskPassResult>;
  private readonly active = new Map<string, AbortController>();
  private shuttingDown = false;
  private _passCount = 0;
  private _lastPassAt?: string;
  private _lastPassResult?: DelegatedAgentTaskPassResult;

  constructor(private readonly options: DelegatedAgentTaskServiceOptions) {}

  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  get running(): boolean {
    return Boolean(this.pass);
  }

  get passCount(): number {
    return this._passCount;
  }

  get lastPassAt(): string | undefined {
    return this._lastPassAt;
  }

  get lastPassResult(): DelegatedAgentTaskPassResult | undefined {
    return this._lastPassResult ? structuredClone(this._lastPassResult) : undefined;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const controller of this.active.values()) {
      controller.abort('delegated_agent_task_shutdown');
    }
  }

  async waitForIdle(): Promise<void> {
    await this.pass;
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      running: this.running,
      workerId: this.options.workerId,
      batchSize: Math.max(1, Math.min(this.options.batchSize ?? 2, 20)),
      active: this.active.size,
      passCount: this.passCount,
      lastPassAt: this.lastPassAt,
    };
  }

  async runPass(limit = this.options.batchSize ?? 2): Promise<DelegatedAgentTaskPassResult> {
    if (this.pass) return this.pass;
    if (!this.enabled || this.shuttingDown) {
      return { claimed: 0, completed: 0, stale: 0, cancelled: 0, retried: 0, failed: 0, tasks: [] };
    }
    this.pass = this.executePass(limit);
    try {
      const result = await this.pass;
      this._passCount += 1;
      this._lastPassAt = new Date().toISOString();
      this._lastPassResult = structuredClone(result);
      return result;
    } finally {
      this.pass = undefined;
    }
  }

  private async executePass(limit: number): Promise<DelegatedAgentTaskPassResult> {
    const result: DelegatedAgentTaskPassResult = {
      claimed: 0, completed: 0, stale: 0, cancelled: 0, retried: 0, failed: 0, tasks: [],
    };
    await this.scheduleTerminalContinuations();
    const claimed = await this.options.store.claim({
      workerId: this.options.workerId,
      limit: Math.max(1, Math.min(limit, 20)),
      leaseMs: this.options.leaseMs,
    });
    result.claimed = claimed.length;
    for (const task of claimed) {
      if (this.shuttingDown) break;
      let terminal: DelegatedAgentTask;
      try {
        terminal = await this.executeTask(task);
      } catch (error) {
        const latest = await this.options.store.get(task.id);
        if (latest?.status === 'cancelled') {
          terminal = latest;
        } else {
          const retryBaseMs = Math.max(1_000, Math.min(this.options.retryBaseMs ?? 5_000, 300_000));
          terminal = await this.options.store.retry({
            id: task.id,
            workerId: this.options.workerId,
            error: compactError(error),
            retryAfterMs: retryBaseMs * 2 ** Math.max(0, task.attempts - 1),
          });
        }
      }
      result.tasks.push(terminal);
      if (terminal.status === 'completed') {
        result.completed += 1;
        await this.scheduleContinuation(terminal).catch(() => undefined);
      } else if (terminal.status === 'stale') {
        result.stale += 1;
        await this.scheduleContinuation(terminal).catch(() => undefined);
      } else if (terminal.status === 'failed') {
        result.failed += 1;
        await this.scheduleContinuation(terminal).catch(() => undefined);
      }
      else if (terminal.status === 'cancelled') result.cancelled += 1;
      else result.retried += 1;
    }
    return result;
  }

  private async scheduleTerminalContinuations(): Promise<void> {
    if (!this.options.onCompleted) return;
    const pending = (await Promise.all(
      (['completed', 'failed', 'stale'] as const).map((status) =>
        this.options.store.list({ status, limit: 100 }),
      ),
    )).flat().filter((task) => !task.continuationRunId);
    for (const task of pending) {
      await this.scheduleContinuation(task).catch(() => undefined);
    }
  }

  private async scheduleContinuation(task: DelegatedAgentTask): Promise<void> {
    if (!this.options.onCompleted || task.continuationRunId) return;
    const runId = await this.options.onCompleted(task);
    if (runId) await this.options.store.markContinuation({ id: task.id, runId });
  }

  private async stale(task: DelegatedAgentTask, error: string): Promise<DelegatedAgentTask> {
    await this.options.deliveryStore.appendAgentRunEvent(task.parentRunId, 'delegation', {
      message: `${task.agentId} asynchronous delegation stale`,
      metadata: {
        invocationId: task.id,
        agentId: task.agentId,
        status: 'failed',
        async: true,
        error,
      },
    }).catch(() => undefined);
    return this.options.store.complete({
      id: task.id,
      workerId: this.options.workerId,
      status: 'stale',
      error,
    });
  }

  private async executeTask(task: DelegatedAgentTask): Promise<DelegatedAgentTask> {
    const current = await this.options.store.get(task.id);
    if (current?.status === 'cancelled') return current;
    const definition = await this.options.agentStore.get(task.agentId);
    if (!definition?.enabled || definition.revision !== task.agentRevision) {
      return this.stale(task, 'delegated_agent_task_definition_changed');
    }
    const resolved = this.options.threadConfigStore.resolveThreadPolicy
      ? await this.options.threadConfigStore.resolveThreadPolicy(task.thread)
      : {
          identity: await this.options.threadConfigStore.getIdentity(task.thread),
          access: await this.options.threadConfigStore.getAccessBundle(task.thread),
          workspace: await this.options.threadConfigStore.getWorkspace?.(task.thread),
          project: await this.options.threadConfigStore.getProject?.(task.thread),
        };
    if (
      resolved.access.workspaceId !== task.workspaceId ||
      !resolved.access.agentIds?.includes(task.agentId)
    ) {
      return this.stale(task, 'delegated_agent_task_route_changed');
    }
    const executor = this.options.resolveExecutor(definition);
    if (!executor) return this.stale(task, 'delegated_agent_task_executor_unavailable');
    const approvedGrants = new Set(task.accessSnapshot.grantIds);
    const grantKinds = new Set(definition.grantKinds);
    const grants = resolved.access.grants
      .filter((grant) => approvedGrants.has(grant.id) && grantKinds.has(grant.kind) && grant.kind !== 'memory' && readAllowed(grant))
      .map(readOnlyGrant);
    const skillIds = intersect(
      intersect(resolved.access.skillIds ?? [], task.accessSnapshot.skillIds),
      definition.skillIds,
    );
    const skills = await this.options.skillStore.list({ ids: skillIds });
    const knowledgeIds = intersect(
      resolved.access.knowledgeSourceIds ?? [],
      task.accessSnapshot.knowledgeSourceIds,
    );
    const knowledgeSources: KnowledgeSource[] = await this.options.knowledgeStore.list({
      workspaceId: task.workspaceId,
      ids: knowledgeIds,
    });
    const memoryScopes = intersect(
      intersect(
        task.accessSnapshot.memoryScopes,
        definition.memoryScopes,
      ),
      ['workspace', 'project', 'channel', 'thread'] as MemoryScopeKind[],
    ).filter((scope) => memoryScopeGranted(resolved.access, scope, 'read'));
    const memorySnapshot = memoryScopes.length && this.options.memoryStore.loadMemory
      ? await this.options.memoryStore.loadMemory({
          thread: task.thread,
          workspace: resolved.workspace,
          project: resolved.project,
          scopes: memoryScopes,
        })
      : undefined;
    const childNetwork = networkPolicy(
      resolved.access.networkPolicy,
      task.accessSnapshot.networkPolicy,
      definition,
    );
    await this.options.deliveryStore.appendAgentRunEvent(task.parentRunId, 'delegation', {
      message: `${definition.id} asynchronous delegation running`,
      metadata: {
        invocationId: task.id,
        agentId: definition.id,
        executorId: definition.executorId,
        status: 'running',
        taskPreview: task.taskPreview,
        async: true,
      },
    }).catch(() => undefined);
    const controller = new AbortController();
    this.active.set(task.id, controller);
    const timeout = setTimeout(
      () => controller.abort(`delegated_agent_timeout:${definition.timeoutMs}ms`),
      definition.timeoutMs,
    );
    let cancellationPoll: NodeJS.Timeout | undefined;
    const stopCancellationPoll = (): void => {
      if (cancellationPoll) clearInterval(cancellationPoll);
      cancellationPoll = undefined;
    };
    cancellationPoll = setInterval(() => {
      void this.options.store.get(task.id).then((latest) => {
        if (!latest || latest.status === 'cancelled') {
          controller.abort('delegated_agent_task_cancelled');
          stopCancellationPoll();
        }
      }).catch(() => undefined);
    }, 250);
    try {
      const request: AgentRunRequest = {
        runId: `${task.parentRunId}:async-delegate:${task.id}`,
        workspace: resolved.workspace,
        project: resolved.project,
        thread: task.thread,
        message: {
          id: `delegated-task:${task.id}`,
          threadId: task.thread.id,
          platform: task.thread.platform,
          text: task.task,
          actor: { id: task.createdBy, isBot: true },
          createdAt: task.createdAt,
          mentionsAgent: true,
        },
        identity: {
          id: `delegated:${definition.id}`,
          displayName: definition.name,
          description: definition.description,
          instructions: `${definition.instructions}\n\nFinish within at most ${definition.maxTurns} focused tool-use turns. Return the strongest verified result available when the limit is reached.`,
          defaultExecutorId: definition.executorId,
        },
        access: {
          id: `${resolved.access.id}:async-delegate:${task.id}`,
          threadId: task.thread.id,
          workspaceId: task.workspaceId,
          projectId: task.projectId,
          skillIds,
          agentIds: [],
          knowledgeSourceIds: knowledgeSources.map((source) => source.id),
          grants,
          networkPolicy: childNetwork,
          budgetPolicy: resolved.access.budgetPolicy,
          budgetPolicies: resolved.access.budgetPolicies,
          memoryApprovalPolicy: { mode: 'disabled' },
          toolApprovalPolicy: { mode: 'disabled' },
        },
        skills,
        knowledgeSources: knowledgeSources.map(({ content: _content, ...source }) => source),
        delegatedAgents: [],
        delegation: { parentRunId: task.parentRunId, agentId: definition.id, depth: 1 },
        memory: memorySnapshot?.text ?? '',
        memorySnapshot,
        abortSignal: controller.signal,
        onEvent: async (event: AgentRunEvent) => {
          if (event.type !== 'tool_call' && event.type !== 'tool_result') return;
          await this.options.deliveryStore.appendAgentRunEvent(
            task.parentRunId,
            event.type,
            {
              message: event.type === 'tool_call'
                ? `Calling ${event.call.title}`
                : `${event.call.title} ${event.call.status}`,
              metadata: {
                call: {
                  ...event.call,
                  provider: `delegated:${definition.id}:${task.id}:${event.call.provider ?? 'unknown'}`,
                },
              },
            },
          );
        },
      };
      const run = await executor.run(request);
      const latest = await this.options.store.get(task.id);
      if (latest?.status === 'cancelled') return latest;
      const summary = run.summary.trim().slice(0, 24_000);
      const policy: NonNullable<DelegatedAgentTask['policy']> = {
        readOnly: true,
        recursiveDelegation: false,
        directPublishing: false,
        transcriptShared: false,
        skillIds,
        grantIds: grants.map((grant) => grant.id),
        memoryScopes,
        knowledgeSourceIds: knowledgeSources.map((source) => source.id),
        networkHosts: childNetwork.allowedHosts,
      };
      const terminal = await this.options.store.complete({
        id: task.id,
        workerId: this.options.workerId,
        summary: summary || '(delegated agent returned no summary)',
        executorId: definition.executorId,
        model: definition.model,
        usage: run.usage,
        policy,
      });
      await this.options.deliveryStore.appendAgentRunEvent(task.parentRunId, 'delegation', {
        message: `${definition.id} asynchronous delegation completed`,
        metadata: {
          invocationId: task.id,
          agentId: definition.id,
          executorId: definition.executorId,
          status: 'completed',
          summaryPreview: terminal.summary?.replace(/\s+/gu, ' ').slice(0, 300),
          usage: run.usage,
          async: true,
        },
      }).catch(() => undefined);
      await this.options.deliveryStore.recordAgentRunUsage({
        runId: task.parentRunId,
        recordKey: `delegation:${task.id}`,
        purpose: 'delegation',
        thread: task.thread,
        quantity: { runs: 0, costUsd: run.usage?.costUsd ?? 0 },
        source: 'delegated-agent-task',
        policies: resolved.access.budgetPolicies,
        metadata: {
          async: true,
          agentId: definition.id,
          executorId: definition.executorId,
          inputTokens: run.usage?.inputTokens,
          outputTokens: run.usage?.outputTokens,
        },
      });
      return terminal;
    } finally {
      clearTimeout(timeout);
      stopCancellationPoll();
      this.active.delete(task.id);
    }
  }
}
