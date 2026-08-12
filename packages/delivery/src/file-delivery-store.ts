import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentRunEventType,
  AgentRunRecord,
  AgentRunSteeringRecord,
  AgentRunSteeringStatus,
  AgentRunStatus,
  AgentRunTimelineEvent,
  AgentThreadSessionQuery,
  AgentThreadSessionRecord,
  CancelOutboxOptions,
  CancelOutboxResult,
  ClaimAgentRunsOptions,
  ClaimAgentRunSteeringOptions,
  ClaimOutboundOptions,
  ConfigureThreadBindingInput,
  CreateAgentRunInput,
  CreateAgentRunOrSteerInput,
  CreateAgentRunOrSteerResult,
  CreateOutboundInput,
  DeliverySummary,
  FileDeliveryState,
  InboundEventRecord,
  InboundEventStatus,
  EnqueueAgentRunSteeringInput,
  ListAgentRunSteeringOptions,
  LoadThreadTranscriptOptions,
  LoadedThreadTranscript,
  OutboxScopeFilter,
  OutboundEnvelope,
  OutboundStatus,
  RecordInboundEventInput,
  RecordInboundEventResult,
  RecordAgentThreadSessionInput,
  RecoverStaleOutboxOptions,
  RecoverStaleOutboxResult,
  RecoverStaleAgentRunsOptions,
  RecoverStaleAgentRunsResult,
  ThreadBinding,
  ThreadBindingScope,
  TurnDeliveryRecord,
  TurnDeliveryStatus,
  ListAgentRunsOptions,
  CancelThreadAgentRunsResult,
  UpsertThreadBindingInput,
} from './types.js';

const EMPTY_STATE: FileDeliveryState = {
  nextSequence: 1,
  nextSteeringSequence: 1,
  outbox: [],
  turnDeliveries: [],
  threadBindings: [],
  inboundEvents: [],
  agentRuns: [],
  agentRunEvents: [],
  agentRunSteering: [],
  agentThreadSessions: [],
};

function now(): string {
  return new Date().toISOString();
}

export function createEmptyDeliveryState(): FileDeliveryState {
  return {
    nextSequence: EMPTY_STATE.nextSequence,
    nextSteeringSequence: EMPTY_STATE.nextSteeringSequence,
    outbox: [],
    turnDeliveries: [],
    threadBindings: [],
    inboundEvents: [],
    agentRuns: [],
    agentRunEvents: [],
    agentRunSteering: [],
    agentThreadSessions: [],
  };
}

export function normalizeDeliveryState(
  parsed: Partial<FileDeliveryState>,
): FileDeliveryState {
  return {
    nextSequence: parsed.nextSequence ?? 1,
    nextSteeringSequence: parsed.nextSteeringSequence ?? 1,
    outbox: parsed.outbox ?? [],
    turnDeliveries: parsed.turnDeliveries ?? [],
    threadBindings: parsed.threadBindings ?? [],
    inboundEvents: parsed.inboundEvents ?? [],
    agentRuns: parsed.agentRuns ?? [],
    agentRunEvents: parsed.agentRunEvents ?? [],
    agentRunSteering: parsed.agentRunSteering ?? [],
    agentThreadSessions: parsed.agentThreadSessions ?? [],
  };
}

function targetIdFor(input: CreateOutboundInput): string {
  return (
    input.target.cardId ||
    input.target.chatId ||
    input.thread?.externalId ||
    'unknown-target'
  );
}

function bindingId(platform: string, externalId: string): string {
  return `${platform}:${externalId}`.replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

export function upsertThreadBindingInState(
  state: FileDeliveryState,
  input: ConfigureThreadBindingInput & { scope: ThreadBindingScope },
  timestamp = now(),
): ThreadBinding {
  const id = bindingId(input.platform, input.externalId);
  const existing = state.threadBindings.find((binding) => binding.id === id);
  if (existing) {
    existing.scope = input.scope ?? existing.scope;
    existing.source =
      existing.source === 'configured' && input.source === 'observed'
        ? existing.source
        : input.source ?? existing.source;
    existing.channelId = input.channelId ?? existing.channelId;
    existing.workspaceId = input.workspaceId;
    existing.projectId = input.projectId;
    existing.title = input.title ?? existing.title;
    existing.activationMode = input.activationMode ?? existing.activationMode;
    existing.requireMention = input.requireMention ?? existing.requireMention;
    existing.updatedAt = timestamp;
    existing.metadata = input.metadata ?? existing.metadata;
    return copyBinding(existing);
  }

  const binding: ThreadBinding = {
    id,
    platform: input.platform,
    externalId: input.externalId,
    scope: input.scope,
    source: input.source ?? 'observed',
    channelId: input.channelId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    title: input.title,
    activationMode: input.activationMode ?? 'mention',
    requireMention: input.requireMention ?? true,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: input.metadata,
  };
  state.threadBindings.push(binding);
  return copyBinding(binding);
}

function copyBinding(binding: ThreadBinding): ThreadBinding {
  return {
    ...binding,
    metadata: binding.metadata ? { ...binding.metadata } : undefined,
  };
}

function copyRun(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    thread: run.thread
      ? {
          ...run.thread,
          metadata: run.thread.metadata ? { ...run.thread.metadata } : undefined,
        }
      : undefined,
    message: run.message
      ? {
          ...run.message,
          actor: { ...run.message.actor },
          attachments: run.message.attachments
            ? run.message.attachments.map((attachment) => ({
                ...attachment,
                metadata: attachment.metadata
                  ? { ...attachment.metadata }
                  : undefined,
              }))
            : undefined,
          metadata: run.message.metadata ? { ...run.message.metadata } : undefined,
        }
      : undefined,
    metadata: run.metadata ? { ...run.metadata } : undefined,
  };
}

function copySteering(
  steering: AgentRunSteeringRecord,
): AgentRunSteeringRecord {
  return {
    ...steering,
    thread: {
      ...steering.thread,
      metadata: steering.thread.metadata
        ? { ...steering.thread.metadata }
        : undefined,
    },
    message: {
      ...steering.message,
      actor: { ...steering.message.actor },
      attachments: steering.message.attachments?.map((attachment) => ({
        ...attachment,
        metadata: attachment.metadata
          ? { ...attachment.metadata }
          : undefined,
      })),
      metadata: steering.message.metadata
        ? { ...steering.message.metadata }
        : undefined,
    },
    metadata: steering.metadata ? { ...steering.metadata } : undefined,
  };
}

function copySession(
  session: AgentThreadSessionRecord,
): AgentThreadSessionRecord {
  return { ...session };
}

function threadSessionId(input: AgentThreadSessionQuery): string {
  const scope = JSON.stringify([
    input.providerId,
    input.namespace,
    input.thread.platform,
    input.thread.workspaceId || '',
    input.thread.projectId || '',
    input.thread.id,
  ]);
  return `session:${createHash('sha256').update(scope).digest('hex').slice(0, 32)}`;
}

function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isActiveRunStatus(status: AgentRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'cancel_requested';
}

function sameThread(
  left: Pick<AgentRunRecord, 'platform' | 'threadId' | 'workspaceId' | 'projectId'>,
  right: Pick<AgentRunRecord, 'platform' | 'threadId' | 'workspaceId' | 'projectId'>,
): boolean {
  return (
    left.platform === right.platform &&
    left.threadId === right.threadId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId
  );
}

function steeringContinuationRunId(steeringId: string): string {
  return `steering:${steeringId}`;
}

function inboundEventId(platform: string, externalId: string): string {
  return `${platform}:event:${externalId}`.replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function outboundTargetKey(record: OutboundEnvelope): string {
  return (
    record.target.cardId ||
    record.target.chatId ||
    record.target.rootId ||
    'unknown-target'
  );
}

function matchesOutboxScope(
  record: OutboundEnvelope,
  filter: OutboxScopeFilter,
): boolean {
  if (filter.runId && record.runId !== filter.runId) return false;
  if (filter.threadId && record.threadId !== filter.threadId) return false;
  if (filter.workspaceId && record.workspaceId !== filter.workspaceId) return false;
  if (filter.projectId && record.projectId !== filter.projectId) return false;
  if (filter.kind && record.kind !== filter.kind) return false;
  if (filter.targetId && outboundTargetKey(record) !== filter.targetId) {
    return false;
  }
  return true;
}

function hasOutboxScope(filter: OutboxScopeFilter): boolean {
  return Boolean(
    filter.runId ||
      filter.threadId ||
      filter.workspaceId ||
      filter.projectId ||
      filter.targetId ||
      filter.kind,
  );
}

function emptySummary(): DeliverySummary {
  return {
    outbox: {
      pending: 0,
      sending: 0,
      delivered: 0,
      failed: 0,
      cancelled: 0,
    },
    turnDeliveries: {
      queued: 0,
      accepted: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    inboundEvents: {
      received: 0,
      processed: 0,
      ignored: 0,
      failed: 0,
      rejected: 0,
      duplicates: 0,
    },
    agentRuns: {
      queued: 0,
      running: 0,
      cancel_requested: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    steering: {
      pending: 0,
      claimed: 0,
      scheduled: 0,
      applied: 0,
      failed: 0,
      cancelled: 0,
    },
    sessions: {
      active: 0,
      invalidated: 0,
    },
    bindings: 0,
  };
}

export class FileDeliveryStore {
  private readonly stateFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'delivery-state.json');
  }

  private async load(): Promise<FileDeliveryState> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as Partial<FileDeliveryState>;
      return normalizeDeliveryState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createEmptyDeliveryState();
      }
      throw error;
    }
  }

  private async save(state: FileDeliveryState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporaryFile, this.stateFile);
  }

  protected async readState(): Promise<FileDeliveryState> {
    await this.mutationQueue;
    return this.load();
  }

  protected async mutate<T>(
    operation: (state: FileDeliveryState) => T,
  ): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = operation(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async enqueue(input: CreateOutboundInput): Promise<OutboundEnvelope> {
    return this.mutate((state) => {
      const timestamp = now();
      const envelope: OutboundEnvelope = {
        id: randomUUID(),
        sequence: state.nextSequence,
        kind: input.kind,
        target: input.target,
        payload: input.payload,
        status: 'pending',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        nextAttemptAt: timestamp,
        runId: input.runId,
        threadId: input.thread?.id,
        workspaceId: input.thread?.workspaceId,
        projectId: input.thread?.projectId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.nextSequence += 1;
      state.outbox.push(envelope);
      if (input.runId) {
        state.turnDeliveries.push({
          id: `turn:${input.runId}:${envelope.id}`,
          runId: input.runId,
          outboxId: envelope.id,
          kind: input.kind,
          platform: input.target.platform,
          threadId: input.thread?.id,
          workspaceId: input.thread?.workspaceId,
          projectId: input.thread?.projectId,
          targetId: targetIdFor(input),
          status: 'queued',
          queuedAt: timestamp,
          updatedAt: timestamp,
        });
      }
      return envelope;
    });
  }

  async markSending(id: string): Promise<OutboundEnvelope | undefined> {
    return this.mutate((state) => {
      const envelope = state.outbox.find((item) => item.id === id);
      if (!envelope) return undefined;
      envelope.status = 'sending';
      envelope.attempts += 1;
      envelope.updatedAt = now();
      this.updateTurnDelivery(state, id, 'accepted');
      return envelope;
    });
  }

  async markDelivered(
    id: string,
    externalId?: string,
  ): Promise<OutboundEnvelope | undefined> {
    return this.mutate((state) => {
      const envelope = state.outbox.find((item) => item.id === id);
      if (!envelope) return undefined;
      envelope.status = 'delivered';
      envelope.externalId = externalId;
      envelope.lastError = undefined;
      envelope.updatedAt = now();
      this.updateTurnDelivery(state, id, 'completed');
      return envelope;
    });
  }

  async markFailed(
    id: string,
    error: string,
  ): Promise<OutboundEnvelope | undefined> {
    return this.mutate((state) => {
      const envelope = state.outbox.find((item) => item.id === id);
      if (!envelope) return undefined;
      envelope.status =
        envelope.attempts >= envelope.maxAttempts ? 'failed' : 'pending';
      envelope.lastError = error;
      envelope.nextAttemptAt = new Date(Date.now() + 30_000).toISOString();
      envelope.updatedAt = now();
      this.updateTurnDelivery(
        state,
        id,
        envelope.status === 'failed' ? 'failed' : 'queued',
        error,
      );
      return envelope;
    });
  }

  async claimReadyOutbox(
    options?: ClaimOutboundOptions,
  ): Promise<OutboundEnvelope[]> {
    return this.mutate((state) => {
      const limit = Math.max(1, Math.min(options?.limit ?? 10, 100));
      const timestamp = (options?.now ?? new Date()).toISOString();
      const claimed: OutboundEnvelope[] = [];
      const ordered = [...state.outbox].sort((a, b) => a.sequence - b.sequence);
      for (const envelope of ordered) {
        if (claimed.length >= limit) break;
        if (envelope.status !== 'pending') continue;
        if (envelope.nextAttemptAt > timestamp) continue;
        const targetKey = outboundTargetKey(envelope);
        const blocked = state.outbox.some(
          (earlier) =>
            earlier.sequence < envelope.sequence &&
            outboundTargetKey(earlier) === targetKey &&
            (earlier.status === 'pending' || earlier.status === 'sending'),
        );
        if (blocked) continue;
        envelope.status = 'sending';
        envelope.attempts += 1;
        envelope.updatedAt = timestamp;
        this.updateTurnDelivery(state, envelope.id, 'accepted');
        claimed.push({ ...envelope });
      }
      return claimed;
    });
  }

  async retryFailedOutbox(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const envelope = state.outbox.find((item) => item.id === id);
      if (!envelope || envelope.status !== 'failed') return false;
      const timestamp = now();
      envelope.status = 'pending';
      envelope.attempts = 0;
      envelope.nextAttemptAt = timestamp;
      envelope.lastError = undefined;
      envelope.updatedAt = timestamp;
      this.updateTurnDelivery(state, id, 'queued');
      return true;
    });
  }

  async recoverStaleOutbox(
    options: RecoverStaleOutboxOptions = {},
  ): Promise<RecoverStaleOutboxResult> {
    return this.mutate((state) => {
      const timestamp = options.now ?? new Date();
      const cutoff = new Date(
        timestamp.getTime() - (options.olderThanMs ?? 120_000),
      ).toISOString();
      const nowIso = timestamp.toISOString();
      const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
      const result: RecoverStaleOutboxResult = {
        requeued: 0,
        failed: 0,
        records: [],
      };

      for (const envelope of state.outbox) {
        if (result.records.length >= limit) break;
        if (envelope.status !== 'sending') continue;
        if (envelope.updatedAt > cutoff) continue;
        if (!matchesOutboxScope(envelope, options)) continue;

        const reason = options.reason ?? 'stale_sending_recovered';
        envelope.lastError = reason;
        envelope.updatedAt = nowIso;
        if (envelope.attempts >= envelope.maxAttempts) {
          envelope.status = 'failed';
          envelope.nextAttemptAt = nowIso;
          result.failed += 1;
          this.updateTurnDelivery(state, envelope.id, 'failed', reason);
        } else {
          envelope.status = 'pending';
          envelope.nextAttemptAt = nowIso;
          result.requeued += 1;
          this.updateTurnDelivery(state, envelope.id, 'queued', reason);
        }
        result.records.push({ ...envelope });
      }

      return result;
    });
  }

  async cancelOutbox(
    options: CancelOutboxOptions,
  ): Promise<CancelOutboxResult> {
    return this.mutate((state) => {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
      const timestamp = now();
      const result: CancelOutboxResult = {
        cancelled: 0,
        records: [],
      };
      if (!hasOutboxScope(options)) return result;

      for (const envelope of state.outbox) {
        if (result.records.length >= limit) break;
        if (envelope.status !== 'pending' && envelope.status !== 'sending') {
          continue;
        }
        if (!matchesOutboxScope(envelope, options)) continue;

        envelope.status = 'cancelled';
        envelope.lastError = options.reason ?? 'cancelled_by_operator';
        envelope.updatedAt = timestamp;
        result.cancelled += 1;
        result.records.push({ ...envelope });
        this.updateTurnDelivery(
          state,
          envelope.id,
          'cancelled',
          envelope.lastError,
        );
      }

      return result;
    });
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    return this.mutate((state) =>
      copyRun(this.createAgentRunInState(state, input)),
    );
  }

  async createAgentRunOrSteer(
    input: CreateAgentRunOrSteerInput,
  ): Promise<CreateAgentRunOrSteerResult> {
    return this.mutate((state) => {
      const existing = state.agentRuns.find((run) => run.id === input.runId);
      if (existing) {
        return { disposition: 'created', run: copyRun(existing) };
      }
      const duplicateSteering = this.findDuplicateSteering(state, input);
      if (duplicateSteering) {
        const target = state.agentRuns.find(
          (run) => run.id === duplicateSteering.targetRunId,
        );
        if (target) {
          return {
            disposition: 'steered',
            run: copyRun(target),
            steering: copySteering(duplicateSteering),
          };
        }
      }

      const active = this.activeRunForThread(state, {
        platform: input.thread.platform,
        threadId: input.thread.id,
        workspaceId: input.thread.workspaceId,
        projectId: input.thread.projectId,
      });
      if (active && input.message) {
        const steering = this.enqueueSteeringInState(state, active, {
          targetRunId: active.id,
          message: input.message,
          inboundEventId: input.inboundEventId,
          bindingId: input.bindingId,
          executorId: input.executorId,
          transportMode: input.transportMode,
          allowLiveSteering: input.allowLiveSteering,
          metadata: input.metadata,
        });
        return {
          disposition: 'steered',
          run: copyRun(active),
          steering: copySteering(steering),
        };
      }

      const run = this.createAgentRunInState(state, input);
      return { disposition: 'created', run: copyRun(run) };
    });
  }

  async enqueueAgentRunSteering(
    input: EnqueueAgentRunSteeringInput,
  ): Promise<AgentRunSteeringRecord | undefined> {
    return this.mutate((state) => {
      const target = state.agentRuns.find(
        (run) => run.id === input.targetRunId,
      );
      if (!target || !target.thread || !isActiveRunStatus(target.status)) {
        return undefined;
      }
      const duplicate = this.findDuplicateSteering(state, {
        thread: target.thread!,
        message: input.message,
        inboundEventId: input.inboundEventId,
      });
      if (duplicate) return copySteering(duplicate);
      return copySteering(
        this.enqueueSteeringInState(state, target, input),
      );
    });
  }

  async claimQueuedAgentRuns(
    options: ClaimAgentRunsOptions = {},
  ): Promise<AgentRunRecord[]> {
    return this.mutate((state) => {
      const limit = Math.max(1, Math.min(options.limit ?? 1, 20));
      const timestamp = (options.now ?? new Date()).toISOString();
      const claimed: AgentRunRecord[] = [];
      const ordered = [...state.agentRuns].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );

      for (const run of ordered) {
        if (claimed.length >= limit) break;
        if (run.status !== 'queued') continue;
        const threadAlreadyRunning = state.agentRuns.some(
          (candidate) =>
            candidate.id !== run.id &&
            sameThread(candidate, run) &&
            (candidate.status === 'running' ||
              candidate.status === 'cancel_requested'),
        );
        if (threadAlreadyRunning) continue;
        if (!run.thread || !run.message) {
          run.status = 'failed';
          run.failedAt = timestamp;
          run.lastError = 'missing_saved_run_payload';
          run.updatedAt = timestamp;
          this.appendAgentRunEventInState(state, run.id, 'failed', {
            message: run.lastError,
          });
          continue;
        }

        run.status = 'running';
        run.startedAt = run.startedAt ?? timestamp;
        run.claimedAt = timestamp;
        run.workerId = options.workerId;
        run.updatedAt = timestamp;
        this.appendAgentRunEventInState(state, run.id, 'started', {
          message: 'Agent run claimed by worker',
          metadata: {
            workerId: options.workerId,
          },
        });
        claimed.push(copyRun(run));
      }

      return claimed;
    });
  }

  async setAgentRunSteeringMode(
    runId: string,
    mode: 'live' | 'next_turn',
  ): Promise<AgentRunRecord | undefined> {
    return this.mutate((state) => {
      const run = state.agentRuns.find((item) => item.id === runId);
      if (!run) return undefined;
      if (run.metadata?.steeringMode === mode) return copyRun(run);
      run.metadata = { ...run.metadata, steeringMode: mode };
      run.updatedAt = now();
      this.appendAgentRunEventInState(state, runId, 'steering_mode', {
        message:
          mode === 'live'
            ? 'Executor accepts live steering'
            : 'Follow-ups continue in the next turn',
        metadata: { mode },
      });
      return copyRun(run);
    });
  }

  async claimNextAgentRunSteering(
    runId: string,
    options: ClaimAgentRunSteeringOptions,
  ): Promise<AgentRunSteeringRecord | undefined> {
    return this.mutate((state) => {
      const run = state.agentRuns.find((item) => item.id === runId);
      if (!run || run.status !== 'running') return undefined;
      const steering = state.agentRunSteering
        .filter(
          (item) =>
            item.targetRunId === runId &&
            item.status === 'pending' &&
            item.allowLive,
        )
        .sort((a, b) => a.sequence - b.sequence)[0];
      if (!steering) return undefined;
      const timestamp = (options.now ?? new Date()).toISOString();
      steering.status = 'claimed';
      steering.mode = 'live';
      steering.claimedBy = options.workerId;
      steering.claimedAt = timestamp;
      steering.updatedAt = timestamp;
      this.appendAgentRunEventInState(state, runId, 'steering_claimed', {
        message: `Live follow-up from ${steering.message.actor.displayName || steering.message.actor.id}`,
        metadata: {
          steeringId: steering.id,
          messageId: steering.message.id,
          actorId: steering.message.actor.id,
        },
      });
      return copySteering(steering);
    });
  }

  async markAgentRunSteeringApplied(
    id: string,
    detail?: string,
    expectedRunId?: string,
  ): Promise<AgentRunSteeringRecord | undefined> {
    return this.mutate((state) => {
      const steering = state.agentRunSteering.find((item) => item.id === id);
      if (!steering) return undefined;
      if (expectedRunId && steering.targetRunId !== expectedRunId) {
        return undefined;
      }
      if (steering.status === 'applied') return copySteering(steering);
      if (steering.status !== 'claimed') return copySteering(steering);
      const timestamp = now();
      steering.status = 'applied';
      steering.mode = 'live';
      steering.appliedAt = timestamp;
      steering.updatedAt = timestamp;
      steering.lastError = undefined;
      this.appendAgentRunEventInState(
        state,
        steering.targetRunId,
        'steering_applied',
        {
          message: detail || 'Live follow-up applied',
          metadata: { steeringId: steering.id, messageId: steering.message.id },
        },
      );
      this.updateInboundEventInState(state, steering.inboundEventId, 'processed', {
        workspaceId: steering.workspaceId,
        projectId: steering.projectId,
        threadId: steering.threadId,
        messageId: steering.message.id,
        metadata: {
          steeringId: steering.id,
          steeringMode: 'live',
          targetRunId: steering.targetRunId,
        },
      });
      return copySteering(steering);
    });
  }

  async listAgentRunSteering(
    options: ListAgentRunSteeringOptions = {},
  ): Promise<AgentRunSteeringRecord[]> {
    const state = await this.readState();
    const limit = options.limit ?? 50;
    return state.agentRunSteering
      .filter(
        (item) =>
          !options.runId ||
          item.targetRunId === options.runId ||
          item.continuationRunId === options.runId,
      )
      .filter((item) => !options.status || item.status === options.status)
      .filter(
        (item) => !options.workspaceId || item.workspaceId === options.workspaceId,
      )
      .filter((item) => !options.projectId || item.projectId === options.projectId)
      .filter((item) => !options.threadId || item.threadId === options.threadId)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, limit)
      .map(copySteering);
  }

  async loadThreadTranscript(
    options: LoadThreadTranscriptOptions,
  ): Promise<LoadedThreadTranscript> {
    const state = await this.readState();
    const maxEntries = Math.max(2, Math.min(options.maxEntries ?? 40, 200));
    const maxChars = Math.max(1_000, Math.min(options.maxChars ?? 40_000, 200_000));
    const entries: LoadedThreadTranscript['entries'] = [];
    const excludedRun = options.excludeRunId
      ? state.agentRuns.find((run) => run.id === options.excludeRunId)
      : undefined;
    const runs = state.agentRuns
      .filter(
        (run) =>
          run.id !== options.excludeRunId &&
          run.platform === options.thread.platform &&
          run.threadId === options.thread.id &&
          run.workspaceId === options.thread.workspaceId &&
          run.projectId === options.thread.projectId &&
          (!excludedRun || run.createdAt <= excludedRun.createdAt) &&
          Boolean(run.message),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const liveSteeringByRun = new Map<string, AgentRunSteeringRecord[]>();
    for (const steering of state.agentRunSteering) {
      if (
        steering.status !== 'applied' ||
        steering.mode !== 'live' ||
        steering.platform !== options.thread.platform ||
        steering.threadId !== options.thread.id ||
        steering.workspaceId !== options.thread.workspaceId ||
        steering.projectId !== options.thread.projectId ||
        (excludedRun && steering.receivedAt > excludedRun.createdAt)
      ) {
        continue;
      }
      const items = liveSteeringByRun.get(steering.targetRunId) ?? [];
      items.push(steering);
      liveSteeringByRun.set(steering.targetRunId, items);
    }

    for (const run of runs) {
      const attachmentText = run.message?.attachments
        ?.map((attachment) =>
          [attachment.kind, attachment.name, attachment.localPath || attachment.url]
            .filter(Boolean)
            .join(': '),
        )
        .filter(Boolean);
      const messageText = [
        run.message?.text || '(no text)',
        attachmentText?.length ? `Attachments:\n${attachmentText.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      entries.push({
        id: `transcript:${run.id}:user`,
        runId: run.id,
        role: 'user',
        text: messageText,
        at: run.message?.createdAt || run.createdAt,
        source: 'run',
        actor: run.message?.actor,
        messageId: run.message?.id,
      });
      for (const steering of (liveSteeringByRun.get(run.id) ?? []).sort(
        (a, b) => a.sequence - b.sequence,
      )) {
        const steeringAttachments = steering.message.attachments
          ?.map((attachment) =>
            [
              attachment.kind,
              attachment.name,
              attachment.localPath || attachment.url,
            ]
              .filter(Boolean)
              .join(': '),
          )
          .filter(Boolean);
        entries.push({
          id: `transcript:${steering.id}:live`,
          runId: steering.targetRunId,
          role: 'user',
          text: [
            steering.message.text || '(no text)',
            steeringAttachments?.length
              ? `Attachments:\n${steeringAttachments.join('\n')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          at: steering.receivedAt,
          source: 'live_steering',
          actor: steering.message.actor,
          messageId: steering.message.id,
        });
      }
      if (run.status === 'completed' && run.summary) {
        entries.push({
          id: `transcript:${run.id}:assistant`,
          runId: run.id,
          role: 'assistant',
          text: run.summary,
          at: run.completedAt || run.updatedAt,
          source: 'run',
          actor: {
            id:
              typeof run.metadata?.agentId === 'string'
                ? run.metadata.agentId
                : 'opentag',
            displayName:
              typeof run.metadata?.agentDisplayName === 'string'
                ? run.metadata.agentDisplayName
                : 'OpenTag',
            isBot: true,
          },
        });
      }
    }
    let truncated = false;
    const bounded = entries.map((entry) => {
      if (entry.text.length <= 12_000) return entry;
      truncated = true;
      return { ...entry, text: `${entry.text.slice(0, 12_000)}\n[truncated]` };
    });
    const selected: LoadedThreadTranscript['entries'] = [];
    let chars = 0;
    for (let index = bounded.length - 1; index >= 0; index -= 1) {
      if (selected.length >= maxEntries) break;
      const entry = bounded[index];
      if (chars + entry.text.length > maxChars) {
        if (selected.length === 0) {
          const suffix = '\n[truncated]';
          selected.push({
            ...entry,
            text: `${entry.text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`,
          });
          truncated = true;
        }
        break;
      }
      selected.push(entry);
      chars += entry.text.length;
    }
    selected.reverse();
    const omittedEntries = entries.length - selected.length;
    return {
      threadId: options.thread.id,
      loadedAt: now(),
      entries: selected,
      totalEntries: entries.length,
      omittedEntries,
      truncated: truncated || omittedEntries > 0,
    };
  }

  async getAgentThreadSession(
    query: AgentThreadSessionQuery,
  ): Promise<AgentThreadSessionRecord | undefined> {
    const state = await this.readState();
    const session = state.agentThreadSessions.find(
      (item) => item.id === threadSessionId(query) && item.status === 'active',
    );
    return session ? copySession(session) : undefined;
  }

  async recordAgentThreadSession(
    input: RecordAgentThreadSessionInput,
  ): Promise<AgentThreadSessionRecord> {
    return this.mutate((state) => {
      const id = threadSessionId(input);
      const timestamp = now();
      const existing = state.agentThreadSessions.find((item) => item.id === id);
      const resumed =
        existing?.status === 'active' && existing.sessionId === input.sessionId;
      const session: AgentThreadSessionRecord = existing ?? {
        id,
        providerId: input.providerId,
        namespace: input.namespace,
        sessionId: input.sessionId,
        status: 'active',
        platform: input.thread.platform,
        threadId: input.thread.id,
        workspaceId: input.thread.workspaceId,
        projectId: input.thread.projectId,
        startedByRunId: input.runId,
        lastRunId: input.runId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      session.sessionId = input.sessionId;
      session.status = 'active';
      if (!resumed) {
        session.startedByRunId = input.runId;
        session.createdAt = timestamp;
      }
      session.lastRunId = input.runId;
      session.updatedAt = timestamp;
      session.invalidatedAt = undefined;
      session.invalidationReason = undefined;
      if (!existing) state.agentThreadSessions.push(session);

      const run = state.agentRuns.find((item) => item.id === input.runId);
      if (run) {
        run.metadata = {
          ...run.metadata,
          providerSessionId: input.sessionId,
          providerSessionNamespace: input.namespace,
          providerSessionResumed: resumed,
        };
        run.updatedAt = timestamp;
        this.appendAgentRunEventInState(
          state,
          run.id,
          resumed ? 'session_resumed' : 'session_started',
          {
            message: resumed
              ? `${input.providerId} session resumed`
              : `${input.providerId} session recorded`,
            metadata: {
              providerId: input.providerId,
              namespace: input.namespace,
              sessionId: input.sessionId,
            },
          },
        );
      }
      return copySession(session);
    });
  }

  async invalidateAgentThreadSession(input: AgentThreadSessionQuery & {
    runId?: string;
    reason: string;
  }): Promise<AgentThreadSessionRecord | undefined> {
    return this.mutate((state) => {
      const session = state.agentThreadSessions.find(
        (item) => item.id === threadSessionId(input),
      );
      if (!session || session.status === 'invalidated') {
        return session ? copySession(session) : undefined;
      }
      const timestamp = now();
      session.status = 'invalidated';
      session.invalidatedAt = timestamp;
      session.invalidationReason = input.reason;
      session.updatedAt = timestamp;
      if (input.runId) {
        const run = state.agentRuns.find((item) => item.id === input.runId);
        if (run) {
          run.metadata = {
            ...run.metadata,
            providerSessionInvalidated: input.reason,
          };
          run.updatedAt = timestamp;
          this.appendAgentRunEventInState(
            state,
            run.id,
            'session_invalidated',
            {
              message: input.reason,
              metadata: {
                providerId: input.providerId,
                namespace: input.namespace,
                sessionId: session.sessionId,
              },
            },
          );
        }
      }
      return copySession(session);
    });
  }

  async listAgentThreadSessions(options: {
    workspaceId?: string;
    projectId?: string;
    threadId?: string;
    status?: 'active' | 'invalidated';
    limit?: number;
  } = {}): Promise<AgentThreadSessionRecord[]> {
    const state = await this.readState();
    return state.agentThreadSessions
      .filter((item) => !options.workspaceId || item.workspaceId === options.workspaceId)
      .filter((item) => !options.projectId || item.projectId === options.projectId)
      .filter((item) => !options.threadId || item.threadId === options.threadId)
      .filter((item) => !options.status || item.status === options.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, options.limit ?? 50)
      .map(copySession);
  }

  async recoverStaleAgentRuns(
    options: RecoverStaleAgentRunsOptions = {},
  ): Promise<RecoverStaleAgentRunsResult> {
    return this.mutate((state) => {
      const timestamp = options.now ?? new Date();
      const cutoff = new Date(
        timestamp.getTime() - (options.olderThanMs ?? 120_000),
      ).toISOString();
      const nowIso = timestamp.toISOString();
      const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
      const result: RecoverStaleAgentRunsResult = {
        requeued: 0,
        cancelled: 0,
        records: [],
      };

      for (const run of state.agentRuns) {
        if (result.records.length >= limit) break;
        if (run.updatedAt > cutoff) continue;
        if (run.status === 'running') {
          const reason = options.reason ?? 'stale_running_recovered';
          run.status = 'queued';
          run.workerId = undefined;
          run.claimedAt = undefined;
          run.lastError = reason;
          run.updatedAt = nowIso;
          this.appendAgentRunEventInState(state, run.id, 'log', {
            message: reason,
            metadata: { recoveredFrom: 'running' },
          });
          for (const steering of state.agentRunSteering) {
            if (
              steering.targetRunId === run.id &&
              steering.status === 'claimed'
            ) {
              steering.status = 'pending';
              steering.mode = undefined;
              steering.claimedBy = undefined;
              steering.claimedAt = undefined;
              steering.updatedAt = nowIso;
            }
          }
          result.requeued += 1;
          result.records.push(copyRun(run));
        } else if (run.status === 'cancel_requested') {
          const reason = options.reason ?? 'stale_cancel_request_finalized';
          run.status = 'cancelled';
          run.cancelledAt = nowIso;
          run.lastError = reason;
          run.updatedAt = nowIso;
          this.appendAgentRunEventInState(state, run.id, 'cancelled', {
            message: reason,
          });
          this.finishRunInboundInState(state, run, nowIso);
          this.finishContinuationSteeringInState(state, run, nowIso);
          this.scheduleNextSteeringInState(state, run, nowIso);
          result.cancelled += 1;
          result.records.push(copyRun(run));
        }
      }

      return result;
    });
  }

  async markAgentRunRunning(id: string): Promise<AgentRunRecord | undefined> {
    return this.updateAgentRun(id, 'running', {
      startedAt: now(),
      event: {
        type: 'started',
        message: 'Agent run started',
      },
    });
  }

  async markAgentRunCompleted(
    id: string,
    summary?: string,
  ): Promise<AgentRunRecord | undefined> {
    const timestamp = now();
    return this.updateAgentRun(id, 'completed', {
      completedAt: timestamp,
      summary,
      event: {
        type: 'completed',
        message: summary ?? 'Agent run completed',
      },
    });
  }

  async markAgentRunFailed(
    id: string,
    error: string,
  ): Promise<AgentRunRecord | undefined> {
    const timestamp = now();
    return this.updateAgentRun(id, 'failed', {
      failedAt: timestamp,
      lastError: error,
      event: {
        type: 'failed',
        message: error,
      },
    });
  }

  async requestAgentRunCancel(
    id: string,
    reason?: string,
  ): Promise<AgentRunRecord | undefined> {
    return this.mutate((state) => {
      const run = state.agentRuns.find((item) => item.id === id);
      if (!run) return undefined;
      if (
        isTerminalRunStatus(run.status)
      ) {
        return copyRun(run);
      }
      const timestamp = now();
      if (run.status === 'queued') {
        run.status = 'cancelled';
        run.cancelRequestedAt = timestamp;
        run.cancelledAt = timestamp;
        run.lastError = reason ?? run.lastError;
        run.updatedAt = timestamp;
        this.appendAgentRunEventInState(state, id, 'cancel_requested', {
          message: reason ?? 'Cancel requested',
        });
        this.appendAgentRunEventInState(state, id, 'cancelled', {
          message: reason ?? 'Queued run cancelled',
        });
        this.finishRunInboundInState(state, run, timestamp);
        this.finishContinuationSteeringInState(state, run, timestamp);
        this.scheduleNextSteeringInState(state, run, timestamp);
        return copyRun(run);
      }
      run.status = 'cancel_requested';
      run.cancelRequestedAt = timestamp;
      run.lastError = reason ?? run.lastError;
      run.updatedAt = timestamp;
      this.appendAgentRunEventInState(state, id, 'cancel_requested', {
        message: reason ?? 'Cancel requested',
      });
      return copyRun(run);
    });
  }

  async cancelActiveAgentRunsForThread(
    thread: {
      platform: AgentRunRecord['platform'];
      id: string;
      workspaceId?: string;
      projectId?: string;
    },
    reason = 'cancelled_from_thread',
    options?: { runId?: string },
  ): Promise<CancelThreadAgentRunsResult> {
    return this.mutate((state) => {
      const timestamp = now();
      const scope = {
        platform: thread.platform,
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        projectId: thread.projectId,
      };
      for (const steering of state.agentRunSteering) {
        if (!sameThread(steering, scope)) continue;
        if (
          options?.runId &&
          steering.targetRunId !== options.runId &&
          steering.continuationRunId !== options.runId
        ) {
          continue;
        }
        if (steering.status !== 'pending' && steering.status !== 'claimed') {
          continue;
        }
        steering.status = 'cancelled';
        steering.cancelledAt = timestamp;
        steering.updatedAt = timestamp;
        steering.lastError = reason;
        this.appendAgentRunEventInState(
          state,
          steering.targetRunId,
          'steering_cancelled',
          {
            message: reason,
            metadata: { steeringId: steering.id },
          },
        );
        this.updateInboundEventInState(
          state,
          steering.inboundEventId,
          'ignored',
          {
            workspaceId: steering.workspaceId,
            projectId: steering.projectId,
            threadId: steering.threadId,
            messageId: steering.message.id,
            reason,
            metadata: { steeringId: steering.id },
          },
          timestamp,
        );
      }

      const affectedRuns: AgentRunRecord[] = [];
      for (const run of state.agentRuns) {
        if (!sameThread(run, scope) || !isActiveRunStatus(run.status)) continue;
        if (options?.runId && run.id !== options.runId) continue;
        if (run.status === 'queued') {
          run.status = 'cancelled';
          run.cancelRequestedAt = timestamp;
          run.cancelledAt = timestamp;
          run.lastError = reason;
          run.updatedAt = timestamp;
          this.appendAgentRunEventInState(state, run.id, 'cancel_requested', {
            message: reason,
          });
          this.appendAgentRunEventInState(state, run.id, 'cancelled', {
            message: reason,
          });
          this.finishRunInboundInState(state, run, timestamp);
          this.finishContinuationSteeringInState(state, run, timestamp);
        } else if (run.status !== 'cancel_requested') {
          run.status = 'cancel_requested';
          run.cancelRequestedAt = timestamp;
          run.lastError = reason;
          run.updatedAt = timestamp;
          this.appendAgentRunEventInState(state, run.id, 'cancel_requested', {
            message: reason,
          });
        }
        affectedRuns.push(copyRun(run));
      }
      const allCancelledSteering = state.agentRunSteering
        .filter(
          (steering) =>
            sameThread(steering, scope) &&
            (!options?.runId ||
              steering.targetRunId === options.runId ||
              steering.continuationRunId === options.runId) &&
            steering.status === 'cancelled' &&
            steering.cancelledAt === timestamp,
        )
        .map(copySteering);
      return {
        runs: affectedRuns,
        steering: allCancelledSteering,
      };
    });
  }

  async markAgentRunCancelled(
    id: string,
    reason?: string,
  ): Promise<AgentRunRecord | undefined> {
    const timestamp = now();
    return this.updateAgentRun(id, 'cancelled', {
      cancelledAt: timestamp,
      lastError: reason,
      event: {
        type: 'cancelled',
        message: reason ?? 'Agent run cancelled',
      },
    });
  }

  async appendAgentRunEvent(
    runId: string,
    type: AgentRunEventType,
    input?: {
      message?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<AgentRunTimelineEvent> {
    return this.mutate((state) =>
      this.appendAgentRunEventInState(state, runId, type, input),
    );
  }

  async getAgentRun(id: string): Promise<AgentRunRecord | undefined> {
    const state = await this.readState();
    const run = state.agentRuns.find((item) => item.id === id);
    return run ? copyRun(run) : undefined;
  }

  async listAgentRuns(
    options: ListAgentRunsOptions = {},
  ): Promise<AgentRunRecord[]> {
    const state = await this.readState();
    const limit = options.limit ?? 50;
    return state.agentRuns
      .filter((item) => !options.status || item.status === options.status)
      .filter((item) => !options.workspaceId || item.workspaceId === options.workspaceId)
      .filter((item) => !options.projectId || item.projectId === options.projectId)
      .filter((item) => !options.threadId || item.threadId === options.threadId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(copyRun);
  }

  async listAgentRunEvents(
    runId: string,
    limit = 100,
  ): Promise<AgentRunTimelineEvent[]> {
    const state = await this.readState();
    return state.agentRunEvents
      .filter((item) => item.runId === runId)
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-limit)
      .map((item) => ({ ...item }));
  }

  async listOutbox(options?: {
    runId?: string;
    status?: OutboundStatus;
    workspaceId?: string;
    limit?: number;
  }): Promise<OutboundEnvelope[]> {
    const state = await this.readState();
    const limit = options?.limit ?? 50;
    return state.outbox
      .filter((item) => !options?.runId || item.runId === options.runId)
      .filter((item) => !options?.status || item.status === options.status)
      .filter(
        (item) => !options?.workspaceId || item.workspaceId === options.workspaceId,
      )
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, limit);
  }

  async getOutbox(id: string): Promise<OutboundEnvelope | undefined> {
    const state = await this.readState();
    const record = state.outbox.find((item) => item.id === id);
    return record ? { ...record, target: { ...record.target } } : undefined;
  }

  async getDeliveredOutboundByExternalId(input: {
    platform: OutboundEnvelope['target']['platform'];
    externalId: string;
    kind?: string;
  }): Promise<OutboundEnvelope | undefined> {
    const state = await this.readState();
    const record = state.outbox
      .filter(
        (item) =>
          item.status === 'delivered' &&
          item.target.platform === input.platform &&
          item.externalId === input.externalId &&
          (!input.kind || item.kind === input.kind),
      )
      .sort((a, b) => b.sequence - a.sequence)[0];
    return record
      ? {
          ...record,
          target: { ...record.target },
          payload: { ...record.payload },
        }
      : undefined;
  }

  async listTurnDeliveries(options?: {
    runId?: string;
    status?: TurnDeliveryStatus;
    workspaceId?: string;
    limit?: number;
  }): Promise<TurnDeliveryRecord[]> {
    const state = await this.readState();
    const limit = options?.limit ?? 50;
    return state.turnDeliveries
      .filter((item) => !options?.runId || item.runId === options.runId)
      .filter((item) => !options?.status || item.status === options.status)
      .filter(
        (item) => !options?.workspaceId || item.workspaceId === options.workspaceId,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async configureThreadBinding(
    input: ConfigureThreadBindingInput,
  ): Promise<ThreadBinding> {
    return this.mutate((state) =>
      upsertThreadBindingInState(state, {
        ...input,
        scope: input.scope ?? 'channel',
        source: input.source ?? 'configured',
      }),
    );
  }

  async removeThreadBinding(
    id: string,
    options: { cascadeChannel?: boolean } = {},
  ): Promise<ThreadBinding[]> {
    return this.mutate((state) => {
      const target = state.threadBindings.find((item) => item.id === id);
      if (!target) return [];
      const cascadeChannel = options.cascadeChannel ?? true;
      const removed = state.threadBindings.filter(
        (item) =>
          item.id === id ||
          (cascadeChannel &&
            Boolean(target.channelId) &&
            item.platform === target.platform &&
            item.channelId === target.channelId),
      );
      const removedIds = new Set(removed.map((item) => item.id));
      state.threadBindings = state.threadBindings.filter(
        (item) => !removedIds.has(item.id),
      );
      return removed.map(copyBinding);
    });
  }

  async upsertThreadBinding(
    input: UpsertThreadBindingInput,
  ): Promise<ThreadBinding> {
    return this.mutate((state) =>
      upsertThreadBindingInState(state, {
        platform: input.thread.platform,
        externalId: input.thread.externalId,
        scope: 'thread',
        source: 'observed',
        channelId: input.thread.channelId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        title: input.thread.title,
        activationMode: input.activationMode ?? 'mention',
        requireMention:
          input.requireMention ?? input.thread.visibility !== 'direct',
        metadata: input.thread.metadata,
      }),
    );
  }

  async getThreadBinding(
    platform: string,
    externalId: string,
  ): Promise<ThreadBinding | undefined> {
    const state = await this.readState();
    const binding = state.threadBindings.find(
      (item) => item.id === bindingId(platform, externalId),
    );
    return binding ? copyBinding(binding) : undefined;
  }

  async getThreadBindingById(id: string): Promise<ThreadBinding | undefined> {
    const state = await this.readState();
    const binding = state.threadBindings.find((item) => item.id === id);
    return binding ? copyBinding(binding) : undefined;
  }

  async getThreadBindingForThread(
    thread: { platform: string; externalId: string; channelId?: string },
  ): Promise<ThreadBinding | undefined> {
    const state = await this.readState();
    const exactId = bindingId(thread.platform, thread.externalId);
    const channelId = thread.channelId
      ? bindingId(thread.platform, thread.channelId)
      : undefined;
    const exactConfigured = state.threadBindings.find(
      (item) => item.id === exactId && item.source === 'configured',
    );
    if (exactConfigured) return copyBinding(exactConfigured);
    const exactObserved = state.threadBindings.find((item) => item.id === exactId);
    if (!thread.channelId) {
      return exactObserved ? copyBinding(exactObserved) : undefined;
    }
    const channelConfigured = state.threadBindings.find(
      (item) =>
        item.source === 'configured' &&
        (item.id === channelId || item.channelId === thread.channelId),
    );
    if (channelConfigured) return copyBinding(channelConfigured);
    if (exactObserved) return copyBinding(exactObserved);
    return undefined;
  }

  async recordInboundEvent(
    input: RecordInboundEventInput,
  ): Promise<RecordInboundEventResult> {
    return this.mutate((state) => {
      const id = inboundEventId(input.platform, input.externalId);
      const existing = state.inboundEvents.find((event) => event.id === id);
      const timestamp = now();
      if (existing) {
        existing.duplicateCount += 1;
        existing.updatedAt = timestamp;
        return { record: existing, duplicate: true };
      }

      const record: InboundEventRecord = {
        id,
        platform: input.platform,
        externalId: input.externalId,
        status: 'received',
        duplicateCount: 0,
        eventType: input.eventType,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        threadId: input.threadId,
        messageId: input.messageId,
        receivedAt: timestamp,
        updatedAt: timestamp,
        metadata: input.metadata,
      };
      state.inboundEvents.push(record);
      return { record, duplicate: false };
    });
  }

  async markInboundEventProcessed(
    id: string,
    input?: {
      workspaceId?: string;
      projectId?: string;
      threadId?: string;
      messageId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<InboundEventRecord | undefined> {
    return this.updateInboundEvent(id, 'processed', input);
  }

  async markInboundEventIgnored(
    id: string,
    reason: string,
    input?: {
      workspaceId?: string;
      projectId?: string;
      threadId?: string;
      messageId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<InboundEventRecord | undefined> {
    return this.updateInboundEvent(id, 'ignored', { ...input, reason });
  }

  async markInboundEventRejected(
    id: string,
    reason: string,
  ): Promise<InboundEventRecord | undefined> {
    return this.updateInboundEvent(id, 'rejected', { reason });
  }

  async markInboundEventFailed(
    id: string,
    error: string,
  ): Promise<InboundEventRecord | undefined> {
    return this.updateInboundEvent(id, 'failed', { error });
  }

  async listInboundEvents(options?: {
    status?: InboundEventStatus;
    workspaceId?: string;
    limit?: number;
  }): Promise<InboundEventRecord[]> {
    const state = await this.readState();
    const limit = options?.limit ?? 50;
    return state.inboundEvents
      .filter((item) => !options?.status || item.status === options.status)
      .filter(
        (item) => !options?.workspaceId || item.workspaceId === options.workspaceId,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async listThreadBindings(
    limit = 50,
    workspaceId?: string,
  ): Promise<ThreadBinding[]> {
    const state = await this.readState();
    return state.threadBindings
      .filter((item) => !workspaceId || item.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async summarize(workspaceId?: string): Promise<DeliverySummary> {
    const state = await this.readState();
    const summary = emptySummary();
    for (const item of state.outbox) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.outbox[item.status] += 1;
      }
    }
    for (const item of state.turnDeliveries) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.turnDeliveries[item.status] += 1;
      }
    }
    for (const item of state.inboundEvents) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.inboundEvents[item.status] += 1;
        summary.inboundEvents.duplicates += item.duplicateCount;
      }
    }
    for (const item of state.agentRuns) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.agentRuns[item.status] += 1;
      }
    }
    for (const item of state.agentRunSteering) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.steering[item.status] += 1;
      }
    }
    for (const item of state.agentThreadSessions) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.sessions[item.status] += 1;
      }
    }
    summary.bindings = state.threadBindings.filter(
      (item) => !workspaceId || item.workspaceId === workspaceId,
    ).length;
    return summary;
  }

  private createAgentRunInState(
    state: FileDeliveryState,
    input: CreateAgentRunInput,
    timestamp = now(),
  ): AgentRunRecord {
    const existing = state.agentRuns.find((run) => run.id === input.runId);
    if (existing) return existing;
    const record: AgentRunRecord = {
      id: input.runId,
      status: 'queued',
      platform: input.thread.platform,
      thread: input.thread,
      message: input.message,
      threadId: input.thread.id,
      threadExternalId: input.thread.externalId,
      workspaceId: input.thread.workspaceId,
      projectId: input.thread.projectId,
      messageId: input.message?.id,
      actorId: input.message?.actor.id,
      bindingId: input.bindingId,
      executorId: input.executorId,
      transportMode: input.transportMode,
      title: input.thread.title,
      inboundEventId: input.inboundEventId,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata,
    };
    state.agentRuns.push(record);
    this.appendAgentRunEventInState(state, input.runId, 'created', {
      message: 'Agent run created',
      metadata: {
        threadId: input.thread.id,
        messageId: input.message?.id,
        bindingId: input.bindingId,
      },
    });
    return record;
  }

  private activeRunForThread(
    state: FileDeliveryState,
    scope: Pick<
      AgentRunRecord,
      'platform' | 'threadId' | 'workspaceId' | 'projectId'
    >,
  ): AgentRunRecord | undefined {
    return state.agentRuns
      .filter(
        (run) =>
          sameThread(run, scope) &&
          isActiveRunStatus(run.status),
      )
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (b.status === 'running' && a.status !== 'running') return 1;
        return a.createdAt.localeCompare(b.createdAt);
      })[0];
  }

  private findDuplicateSteering(
    state: FileDeliveryState,
    input: {
      thread: { platform: string; id: string };
      message?: { id: string };
      inboundEventId?: string;
    },
  ): AgentRunSteeringRecord | undefined {
    return state.agentRunSteering.find(
      (item) =>
        (Boolean(input.inboundEventId) &&
          item.inboundEventId === input.inboundEventId) ||
        (Boolean(input.message?.id) &&
          item.platform === input.thread.platform &&
          item.threadId === input.thread.id &&
          item.message.id === input.message?.id),
    );
  }

  private enqueueSteeringInState(
    state: FileDeliveryState,
    target: AgentRunRecord,
    input: EnqueueAgentRunSteeringInput,
    timestamp = now(),
  ): AgentRunSteeringRecord {
    if (!target.thread) throw new Error('steering_target_missing_thread');
    const steering: AgentRunSteeringRecord = {
      id: randomUUID(),
      sequence: state.nextSteeringSequence,
      targetRunId: target.id,
      status: 'pending',
      allowLive: input.allowLiveSteering ?? true,
      platform: target.platform,
      thread: target.thread,
      message: {
        ...input.message,
        threadId: target.thread.id,
      },
      threadId: target.threadId,
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      inboundEventId: input.inboundEventId,
      bindingId: input.bindingId ?? target.bindingId,
      executorId: input.executorId ?? target.executorId,
      transportMode: input.transportMode ?? target.transportMode,
      receivedAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata,
    };
    state.nextSteeringSequence += 1;
    state.agentRunSteering.push(steering);
    this.appendAgentRunEventInState(state, target.id, 'steering_queued', {
      message: `Follow-up queued from ${steering.message.actor.displayName || steering.message.actor.id}`,
      metadata: {
        steeringId: steering.id,
        messageId: steering.message.id,
        actorId: steering.message.actor.id,
        allowLive: steering.allowLive,
      },
    });
    const inbound = steering.inboundEventId
      ? state.inboundEvents.find((event) => event.id === steering.inboundEventId)
      : undefined;
    if (inbound) {
      inbound.workspaceId = steering.workspaceId ?? inbound.workspaceId;
      inbound.projectId = steering.projectId ?? inbound.projectId;
      inbound.threadId = steering.threadId;
      inbound.messageId = steering.message.id;
      inbound.metadata = {
        ...inbound.metadata,
        steeringId: steering.id,
        steeringTargetRunId: target.id,
      };
      inbound.updatedAt = timestamp;
    }
    return steering;
  }

  private finishContinuationSteeringInState(
    state: FileDeliveryState,
    run: AgentRunRecord,
    timestamp: string,
  ): void {
    const steeringId =
      typeof run.metadata?.steeringId === 'string'
        ? run.metadata.steeringId
        : undefined;
    if (!steeringId) return;
    const steering = state.agentRunSteering.find(
      (item) => item.id === steeringId,
    );
    if (!steering || steering.continuationRunId !== run.id) return;

    let inboundStatus: InboundEventStatus;
    let eventType: AgentRunEventType;
    if (run.status === 'completed') {
      steering.status = 'applied';
      steering.appliedAt = timestamp;
      steering.lastError = undefined;
      inboundStatus = 'processed';
      eventType = 'steering_applied';
    } else if (run.status === 'failed') {
      steering.status = 'failed';
      steering.failedAt = timestamp;
      steering.lastError = run.lastError || 'continuation_failed';
      inboundStatus = 'failed';
      eventType = 'steering_failed';
    } else if (run.status === 'cancelled') {
      steering.status = 'cancelled';
      steering.cancelledAt = timestamp;
      steering.lastError = run.lastError || 'continuation_cancelled';
      inboundStatus = 'ignored';
      eventType = 'steering_cancelled';
    } else {
      return;
    }
    steering.updatedAt = timestamp;
    this.appendAgentRunEventInState(state, steering.targetRunId, eventType, {
      message:
        run.status === 'completed'
          ? 'Follow-up completed in the next turn'
          : steering.lastError,
      metadata: {
        steeringId: steering.id,
        continuationRunId: run.id,
        mode: 'next_turn',
      },
    });
    this.updateInboundEventInState(
      state,
      steering.inboundEventId,
      inboundStatus,
      {
        workspaceId: steering.workspaceId,
        projectId: steering.projectId,
        threadId: steering.threadId,
        messageId: steering.message.id,
        reason:
          inboundStatus === 'ignored' ? steering.lastError : undefined,
        error: inboundStatus === 'failed' ? steering.lastError : undefined,
        metadata: {
          steeringId: steering.id,
          steeringMode: 'next_turn',
          targetRunId: steering.targetRunId,
          continuationRunId: run.id,
        },
      },
    );
  }

  private finishRunInboundInState(
    state: FileDeliveryState,
    run: AgentRunRecord,
    timestamp: string,
  ): void {
    if (!run.inboundEventId || !isTerminalRunStatus(run.status)) return;
    const status: InboundEventStatus =
      run.status === 'completed'
        ? 'processed'
        : run.status === 'failed'
          ? 'failed'
          : 'ignored';
    this.updateInboundEventInState(
      state,
      run.inboundEventId,
      status,
      {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        threadId: run.threadId,
        messageId: run.messageId,
        reason: status === 'ignored' ? run.lastError : undefined,
        error: status === 'failed' ? run.lastError : undefined,
        metadata: { runId: run.id },
      },
      timestamp,
    );
  }

  private scheduleNextSteeringInState(
    state: FileDeliveryState,
    scope: Pick<
      AgentRunRecord,
      'platform' | 'threadId' | 'workspaceId' | 'projectId'
    >,
    timestamp = now(),
  ): AgentRunRecord | undefined {
    if (
      state.agentRuns.some(
        (run) => sameThread(run, scope) && isActiveRunStatus(run.status),
      )
    ) {
      return undefined;
    }
    const steering = state.agentRunSteering
      .filter(
        (item) =>
          sameThread(item, scope) &&
          (item.status === 'pending' || item.status === 'claimed') &&
          state.agentRuns.some(
            (run) =>
              run.id === item.targetRunId && isTerminalRunStatus(run.status),
          ),
      )
      .sort((a, b) => a.sequence - b.sequence)[0];
    if (!steering) return undefined;

    const runId = steeringContinuationRunId(steering.id);
    const continuation = this.createAgentRunInState(
      state,
      {
        runId,
        thread: steering.thread,
        message: steering.message,
        inboundEventId: steering.inboundEventId,
        bindingId: steering.bindingId,
        executorId: steering.executorId,
        transportMode: steering.transportMode,
        metadata: {
          ...steering.metadata,
          source: 'steering',
          steeringId: steering.id,
          continuationOfRunId: steering.targetRunId,
        },
      },
      timestamp,
    );
    steering.status = 'scheduled';
    steering.mode = 'next_turn';
    steering.continuationRunId = continuation.id;
    steering.scheduledAt = timestamp;
    steering.claimedBy = undefined;
    steering.claimedAt = undefined;
    steering.updatedAt = timestamp;
    this.appendAgentRunEventInState(
      state,
      steering.targetRunId,
      'steering_scheduled',
      {
        message: 'Follow-up scheduled as the next turn',
        metadata: {
          steeringId: steering.id,
          continuationRunId: continuation.id,
          mode: 'next_turn',
        },
      },
    );
    return continuation;
  }

  private appendAgentRunEventInState(
    state: FileDeliveryState,
    runId: string,
    type: AgentRunEventType,
    input?: {
      message?: string;
      metadata?: Record<string, unknown>;
    },
  ): AgentRunTimelineEvent {
    const event: AgentRunTimelineEvent = {
      id: randomUUID(),
      runId,
      type,
      at: now(),
      message: input?.message,
      metadata: input?.metadata,
    };
    state.agentRunEvents.push(event);
    return { ...event };
  }

  private async updateAgentRun(
    id: string,
    status: AgentRunStatus,
    input?: {
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      cancelRequestedAt?: string;
      cancelledAt?: string;
      summary?: string;
      lastError?: string;
      event?: {
        type: AgentRunEventType;
        message?: string;
        metadata?: Record<string, unknown>;
      };
    },
  ): Promise<AgentRunRecord | undefined> {
    return this.mutate((state) => {
      const run = state.agentRuns.find((item) => item.id === id);
      if (!run) return undefined;
      if (isTerminalRunStatus(run.status) && run.status !== status) {
        return copyRun(run);
      }
      const timestamp = now();
      const cancellationWins =
        run.status === 'cancel_requested' && status === 'completed';
      const nextStatus: AgentRunStatus = cancellationWins ? 'cancelled' : status;
      run.status = nextStatus;
      run.startedAt = input?.startedAt ?? run.startedAt;
      run.completedAt = cancellationWins
        ? run.completedAt
        : input?.completedAt ?? run.completedAt;
      run.failedAt = input?.failedAt ?? run.failedAt;
      run.cancelRequestedAt =
        input?.cancelRequestedAt ?? run.cancelRequestedAt;
      run.cancelledAt = input?.cancelledAt ?? run.cancelledAt;
      if (cancellationWins) run.cancelledAt = timestamp;
      run.summary = input?.summary ?? run.summary;
      run.lastError = input?.lastError ?? run.lastError;
      run.updatedAt = timestamp;
      if (cancellationWins) {
        this.appendAgentRunEventInState(state, id, 'cancelled', {
          message: run.lastError || 'Cancellation completed before finalization',
        });
      } else if (input?.event) {
        this.appendAgentRunEventInState(state, id, input.event.type, {
          message: input.event.message,
          metadata: input.event.metadata,
        });
      }
      if (isTerminalRunStatus(nextStatus)) {
        this.finishRunInboundInState(state, run, timestamp);
        this.finishContinuationSteeringInState(state, run, timestamp);
        this.scheduleNextSteeringInState(state, run, timestamp);
      }
      return copyRun(run);
    });
  }

  private async updateInboundEvent(
    id: string,
    status: InboundEventStatus,
    input?: {
      workspaceId?: string;
      projectId?: string;
      threadId?: string;
      messageId?: string;
      reason?: string;
      error?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<InboundEventRecord | undefined> {
    return this.mutate((state) =>
      this.updateInboundEventInState(state, id, status, input),
    );
  }

  private updateInboundEventInState(
    state: FileDeliveryState,
    id: string | undefined,
    status: InboundEventStatus,
    input?: {
      workspaceId?: string;
      projectId?: string;
      threadId?: string;
      messageId?: string;
      reason?: string;
      error?: string;
      metadata?: Record<string, unknown>;
    },
    timestamp = now(),
  ): InboundEventRecord | undefined {
    if (!id) return undefined;
    const event = state.inboundEvents.find((item) => item.id === id);
    if (!event) return undefined;
    event.status = status;
    event.workspaceId = input?.workspaceId ?? event.workspaceId;
    event.projectId = input?.projectId ?? event.projectId;
    event.threadId = input?.threadId ?? event.threadId;
    event.messageId = input?.messageId ?? event.messageId;
    event.reason = input?.reason ?? event.reason;
    event.lastError = input?.error ?? event.lastError;
    event.metadata = input?.metadata
      ? { ...event.metadata, ...input.metadata }
      : event.metadata;
    event.updatedAt = timestamp;
    if (status === 'processed') event.processedAt = timestamp;
    if (status === 'ignored') event.ignoredAt = timestamp;
    if (status === 'failed') event.failedAt = timestamp;
    if (status === 'rejected') event.rejectedAt = timestamp;
    return event;
  }

  private updateTurnDelivery(
    state: FileDeliveryState,
    outboxId: string,
    status: TurnDeliveryStatus,
    error?: string,
  ): void {
    const timestamp = now();
    const delivery = state.turnDeliveries.find(
      (item) => item.outboxId === outboxId,
    );
    if (!delivery) return;
    delivery.status = status;
    delivery.updatedAt = timestamp;
    delivery.lastError = error;
    if (status === 'accepted') delivery.acceptedAt = timestamp;
    if (status === 'completed') delivery.completedAt = timestamp;
    if (status === 'failed') delivery.failedAt = timestamp;
  }
}

export type DeliveryStore = Pick<FileDeliveryStore, keyof FileDeliveryStore>;
