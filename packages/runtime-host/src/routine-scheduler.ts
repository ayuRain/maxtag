import type {
  PlatformKind,
  SourceMessage,
  SourceThread,
} from '@opentag/core';
import type { FileThreadConfigStore } from '@opentag/config';
import type {
  AgentRunRecord,
  DeliveryStore,
  ThreadBinding,
} from '@opentag/delivery';
import type {
  FileRoutineStore,
  Routine,
  RoutineClaim,
} from '@opentag/routines';

export interface RoutineTickResult {
  at: string;
  staged: number;
  claimed: number;
  queued: number;
  failed: number;
  reconciled: number;
  executionIds: string[];
  runIds: string[];
}

export interface RoutineSchedulerServiceOptions {
  routineStore: FileRoutineStore;
  deliveryStore: DeliveryStore;
  threadConfigStore: FileThreadConfigStore;
  schedulerId: string;
  claimStaleMs?: number;
  batchSize?: number;
  transportModeForPlatform?: (platform: PlatformKind) => string;
  onRunQueued?: (run: AgentRunRecord) => void | Promise<void>;
}

export interface RoutineSchedulerTickOptions {
  at?: Date;
  stageDue?: boolean;
}

function applyBindingToThread(
  thread: SourceThread,
  binding: ThreadBinding,
): SourceThread {
  return {
    ...thread,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    title: binding.title || thread.title,
    metadata: {
      ...thread.metadata,
      bindingId: binding.id,
      bindingScope: binding.scope,
      bindingSource: binding.source,
    },
  };
}

function defaultTransportMode(platform: PlatformKind): string {
  return `${platform}-scheduled`;
}

export class RoutineSchedulerService {
  private readonly routineStore: FileRoutineStore;
  private readonly deliveryStore: DeliveryStore;
  private readonly threadConfigStore: FileThreadConfigStore;
  private readonly schedulerId: string;
  private readonly claimStaleMs: number;
  private readonly batchSize: number;
  private readonly transportModeForPlatform: (platform: PlatformKind) => string;
  private readonly onRunQueued?: (run: AgentRunRecord) => void | Promise<void>;
  private tickPass: Promise<RoutineTickResult> | undefined;
  private _lastTickAt: string | undefined;
  private _lastTickResult: RoutineTickResult | undefined;
  private _tickCount = 0;

  constructor(options: RoutineSchedulerServiceOptions) {
    this.routineStore = options.routineStore;
    this.deliveryStore = options.deliveryStore;
    this.threadConfigStore = options.threadConfigStore;
    this.schedulerId = options.schedulerId;
    this.claimStaleMs = Math.max(1_000, options.claimStaleMs ?? 120_000);
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 100));
    this.transportModeForPlatform =
      options.transportModeForPlatform ?? defaultTransportMode;
    this.onRunQueued = options.onRunQueued;
  }

  get running(): boolean {
    return Boolean(this.tickPass);
  }

  get lastTickAt(): string | undefined {
    return this._lastTickAt;
  }

  get lastTickResult(): RoutineTickResult | undefined {
    return this._lastTickResult
      ? structuredClone(this._lastTickResult)
      : undefined;
  }

  get tickCount(): number {
    return this._tickCount;
  }

  async waitForIdle(): Promise<void> {
    await this.tickPass;
  }

  async reconcileExecutions(): Promise<number> {
    const executions = await this.routineStore.listExecutions({ limit: 500 });
    let reconciled = 0;
    for (const execution of executions) {
      if (!execution.runId) continue;
      if (
        execution.status === 'completed' ||
        execution.status === 'failed' ||
        execution.status === 'cancelled'
      ) {
        continue;
      }
      const run = await this.deliveryStore.getAgentRun(execution.runId);
      if (!run) continue;
      await this.routineStore.reconcileRun({
        runId: run.id,
        status: run.status === 'cancel_requested' ? 'running' : run.status,
        summary: run.summary,
        error: run.lastError,
      });
      reconciled += 1;
    }
    return reconciled;
  }

  async tick(
    options: RoutineSchedulerTickOptions = {},
  ): Promise<RoutineTickResult> {
    if (this.tickPass) return this.tickPass;
    this.tickPass = this.runTick(options);
    try {
      return await this.tickPass;
    } finally {
      this.tickPass = undefined;
    }
  }

  private async runTick(
    options: RoutineSchedulerTickOptions,
  ): Promise<RoutineTickResult> {
    const at = options.at ?? new Date();
    const reconciledBefore = await this.reconcileExecutions();
    const staged =
      options.stageDue === false
        ? []
        : await this.routineStore.stageDue(at, this.batchSize);
    const claims = await this.routineStore.claimExecutions({
      claimerId: this.schedulerId,
      limit: this.batchSize,
      staleAfterMs: this.claimStaleMs,
      at,
    });
    const result: RoutineTickResult = {
      at: at.toISOString(),
      staged: staged.length,
      claimed: claims.length,
      queued: 0,
      failed: 0,
      reconciled: reconciledBefore,
      executionIds: claims.map((claim) => claim.execution.id),
      runIds: [],
    };
    for (const claim of claims) {
      try {
        const run = await this.enqueueClaim(claim, at);
        result.queued += 1;
        result.runIds.push(run.id);
      } catch (error) {
        result.failed += 1;
        await this.routineStore.markExecutionFailed(
          claim.execution.id,
          error instanceof Error ? error.message : String(error),
          at,
        );
      }
    }
    result.reconciled += await this.reconcileExecutions();
    this._lastTickAt = result.at;
    this._lastTickResult = structuredClone(result);
    this._tickCount += 1;
    return result;
  }

  private async routineProjectId(routine: Routine): Promise<string> {
    if (routine.projectId) return routine.projectId;
    const workspaces = await this.threadConfigStore.listWorkspacePolicies();
    return (
      workspaces.find((item) => item.workspace.id === routine.workspaceId)
        ?.workspace.defaultProjectId || 'opentag'
    );
  }

  private async runInput(
    claim: RoutineClaim,
    at: Date,
  ): Promise<{ thread: SourceThread; message: SourceMessage }> {
    const routine = claim.routine;
    const destination = routine.destination;
    const projectId = await this.routineProjectId(routine);
    const threadId =
      destination.threadId ||
      `${destination.platform}:${destination.externalId}:routine:${routine.id}`;
    const thread: SourceThread = {
      id: threadId,
      platform: destination.platform,
      externalId: destination.externalId,
      workspaceId: routine.workspaceId,
      projectId,
      channelId: destination.channelId || destination.externalId,
      rootMessageId: destination.rootMessageId,
      topicId: destination.topicId,
      title: destination.title || routine.name,
      visibility: destination.visibility,
      metadata: {
        routineId: routine.id,
        routineExecutionId: claim.execution.id,
        routineTrigger: claim.execution.trigger,
      },
    };
    return {
      thread,
      message: {
        id: `routine:${claim.execution.id}`,
        threadId,
        platform: destination.platform,
        text: routine.instructions,
        actor: {
          id: `routine:${routine.id}`,
          displayName: routine.name,
          isBot: true,
        },
        createdAt: at.toISOString(),
        mentionsAgent: true,
        metadata: {
          routineId: routine.id,
          routineExecutionId: claim.execution.id,
          scheduledFor: claim.execution.scheduledFor,
        },
      },
    };
  }

  private async enqueueClaim(
    claim: RoutineClaim,
    at: Date,
  ): Promise<AgentRunRecord> {
    const input = await this.runInput(claim, at);
    const configuredBinding = await this.deliveryStore.getThreadBindingForThread(
      input.thread,
    );
    if (
      configuredBinding &&
      (configuredBinding.workspaceId !== input.thread.workspaceId ||
        configuredBinding.projectId !== input.thread.projectId)
    ) {
      throw new Error('routine_destination_binding_scope_mismatch');
    }
    const thread = configuredBinding
      ? applyBindingToThread(input.thread, configuredBinding)
      : input.thread;
    const message = { ...input.message, threadId: thread.id };
    const observedBinding = await this.deliveryStore.upsertThreadBinding({
      thread,
      workspaceId: thread.workspaceId ?? 'default-workspace',
      projectId: thread.projectId ?? 'general',
      activationMode: configuredBinding?.activationMode ?? 'always',
      requireMention: configuredBinding?.requireMention ?? false,
    });
    const policy = await this.threadConfigStore.resolveThreadPolicy(thread);
    const run = await this.deliveryStore.createAgentRun({
      runId: `routine:${claim.execution.id}`,
      thread,
      message,
      bindingId: configuredBinding?.id ?? observedBinding.id,
      executorId: policy.identity.defaultExecutorId,
      transportMode: this.transportModeForPlatform(thread.platform),
      metadata: {
        source: 'routine',
        routineId: claim.routine.id,
        routineName: claim.routine.name,
        routineExecutionId: claim.execution.id,
        routineTrigger: claim.execution.trigger,
        routineScheduledFor: claim.execution.scheduledFor,
        actorAuthorization: {
          allowed: true,
          reason: 'operator_or_internal',
        },
        workspaceMemoryWriteAllowed: true,
        agentId: policy.identity.id,
        agentDisplayName: policy.identity.displayName,
        policyConfigured: policy.configured,
        grantKinds: policy.access.grants.map((grant) => grant.kind),
      },
    });
    await this.routineStore.markExecutionQueued(
      claim.execution.id,
      run.id,
      at,
    );
    await this.onRunQueued?.(run);
    return run;
  }
}
