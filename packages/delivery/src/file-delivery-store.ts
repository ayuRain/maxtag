import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CreateOutboundInput,
  DeliverySummary,
  FileDeliveryState,
  OutboundEnvelope,
  OutboundStatus,
  ThreadBinding,
  TurnDeliveryRecord,
  TurnDeliveryStatus,
  UpsertThreadBindingInput,
} from './types.js';

const EMPTY_STATE: FileDeliveryState = {
  nextSequence: 1,
  outbox: [],
  turnDeliveries: [],
  threadBindings: [],
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

function emptySummary(): DeliverySummary {
  return {
    outbox: {
      pending: 0,
      sending: 0,
      delivered: 0,
      failed: 0,
    },
    turnDeliveries: {
      queued: 0,
      accepted: 0,
      completed: 0,
      failed: 0,
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

  async upsertThreadBinding(
    input: UpsertThreadBindingInput,
  ): Promise<ThreadBinding> {
    return this.mutate((state) => {
      const timestamp = now();
      const id = bindingId(input.thread.platform, input.thread.externalId);
      const existing = state.threadBindings.find((binding) => binding.id === id);
      if (existing) {
        existing.workspaceId = input.workspaceId;
        existing.projectId = input.projectId;
        existing.title = input.thread.title;
        existing.activationMode = input.activationMode ?? existing.activationMode;
        existing.requireMention =
          input.requireMention ?? existing.requireMention;
        existing.updatedAt = timestamp;
        existing.metadata = input.thread.metadata;
        return existing;
      }

      const binding: ThreadBinding = {
        id,
        platform: input.thread.platform,
        externalId: input.thread.externalId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        title: input.thread.title,
        activationMode: input.activationMode ?? 'mention',
        requireMention:
          input.requireMention ?? input.thread.visibility !== 'direct',
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: input.thread.metadata,
      };
      state.threadBindings.push(binding);
      return binding;
    });
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
    summary.bindings = state.threadBindings.length;
    return summary;
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
