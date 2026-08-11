import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CancelOutboxOptions,
  CancelOutboxResult,
  ClaimOutboundOptions,
  ConfigureThreadBindingInput,
  CreateOutboundInput,
  DeliverySummary,
  FileDeliveryState,
  InboundEventRecord,
  InboundEventStatus,
  OutboxScopeFilter,
  OutboundEnvelope,
  OutboundStatus,
  RecordInboundEventInput,
  RecordInboundEventResult,
  RecoverStaleOutboxOptions,
  RecoverStaleOutboxResult,
  ThreadBinding,
  ThreadBindingScope,
  TurnDeliveryRecord,
  TurnDeliveryStatus,
  UpsertThreadBindingInput,
} from './types.js';

const EMPTY_STATE: FileDeliveryState = {
  nextSequence: 1,
  outbox: [],
  turnDeliveries: [],
  threadBindings: [],
  inboundEvents: [],
};

function now(): string {
  return new Date().toISOString();
}

function cloneEmptyState(): FileDeliveryState {
  return {
    nextSequence: EMPTY_STATE.nextSequence,
    outbox: [],
    turnDeliveries: [],
    threadBindings: [],
    inboundEvents: [],
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

function copyBinding(binding: ThreadBinding): ThreadBinding {
  return {
    ...binding,
    metadata: binding.metadata ? { ...binding.metadata } : undefined,
  };
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
      return {
        nextSequence: parsed.nextSequence ?? 1,
        outbox: parsed.outbox ?? [],
        turnDeliveries: parsed.turnDeliveries ?? [],
        threadBindings: parsed.threadBindings ?? [],
        inboundEvents: parsed.inboundEvents ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return cloneEmptyState();
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

  private async readState(): Promise<FileDeliveryState> {
    await this.mutationQueue;
    return this.load();
  }

  private async mutate<T>(
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

  async listOutbox(options?: {
    runId?: string;
    status?: OutboundStatus;
    limit?: number;
  }): Promise<OutboundEnvelope[]> {
    const state = await this.readState();
    const limit = options?.limit ?? 50;
    return state.outbox
      .filter((item) => !options?.runId || item.runId === options.runId)
      .filter((item) => !options?.status || item.status === options.status)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, limit);
  }

  async listTurnDeliveries(options?: {
    runId?: string;
    status?: TurnDeliveryStatus;
    limit?: number;
  }): Promise<TurnDeliveryRecord[]> {
    const state = await this.readState();
    const limit = options?.limit ?? 50;
    return state.turnDeliveries
      .filter((item) => !options?.runId || item.runId === options.runId)
      .filter((item) => !options?.status || item.status === options.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async configureThreadBinding(
    input: ConfigureThreadBindingInput,
  ): Promise<ThreadBinding> {
    return this.mutate((state) =>
      this.upsertBindingInState(state, {
        ...input,
        scope: input.scope ?? 'channel',
        source: input.source ?? 'configured',
      }),
    );
  }

  async upsertThreadBinding(
    input: UpsertThreadBindingInput,
  ): Promise<ThreadBinding> {
    return this.mutate((state) =>
      this.upsertBindingInState(state, {
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
    const channelObserved = state.threadBindings.find(
      (item) => item.id === channelId || item.channelId === thread.channelId,
    );
    return channelObserved ? copyBinding(channelObserved) : undefined;
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
    limit?: number;
  }): Promise<InboundEventRecord[]> {
    const state = await this.readState();
    const limit = options?.limit ?? 50;
    return state.inboundEvents
      .filter((item) => !options?.status || item.status === options.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async listThreadBindings(limit = 50): Promise<ThreadBinding[]> {
    const state = await this.readState();
    return state.threadBindings
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async summarize(): Promise<DeliverySummary> {
    const state = await this.readState();
    const summary = emptySummary();
    for (const item of state.outbox) summary.outbox[item.status] += 1;
    for (const item of state.turnDeliveries) {
      summary.turnDeliveries[item.status] += 1;
    }
    for (const item of state.inboundEvents) {
      summary.inboundEvents[item.status] += 1;
      summary.inboundEvents.duplicates += item.duplicateCount;
    }
    summary.bindings = state.threadBindings.length;
    return summary;
  }

  private upsertBindingInState(
    state: FileDeliveryState,
    input: ConfigureThreadBindingInput & { scope: ThreadBindingScope },
  ): ThreadBinding {
    const timestamp = now();
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
      existing.requireMention =
        input.requireMention ?? existing.requireMention;
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
    },
  ): Promise<InboundEventRecord | undefined> {
    return this.mutate((state) => {
      const event = state.inboundEvents.find((item) => item.id === id);
      if (!event) return undefined;
      const timestamp = now();
      event.status = status;
      event.workspaceId = input?.workspaceId ?? event.workspaceId;
      event.projectId = input?.projectId ?? event.projectId;
      event.threadId = input?.threadId ?? event.threadId;
      event.messageId = input?.messageId ?? event.messageId;
      event.reason = input?.reason ?? event.reason;
      event.lastError = input?.error ?? event.lastError;
      event.updatedAt = timestamp;
      if (status === 'processed') event.processedAt = timestamp;
      if (status === 'ignored') event.ignoredAt = timestamp;
      if (status === 'failed') event.failedAt = timestamp;
      if (status === 'rejected') event.rejectedAt = timestamp;
      return event;
    });
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
