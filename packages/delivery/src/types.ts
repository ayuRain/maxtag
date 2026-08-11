import type { PlatformKind, SourceThread } from '@opentag/core';

export type OutboundStatus = 'pending' | 'sending' | 'delivered' | 'failed';

export type TurnDeliveryStatus = 'queued' | 'accepted' | 'completed' | 'failed';

export type ThreadActivationMode = 'mention' | 'always';

export type ThreadBindingScope = 'thread' | 'channel';

export type ThreadBindingSource = 'observed' | 'configured';

export type InboundEventStatus =
  | 'received'
  | 'processed'
  | 'ignored'
  | 'failed'
  | 'rejected';

export interface OutboundTarget {
  platform: PlatformKind;
  chatId?: string;
  cardId?: string;
  rootId?: string;
  replyToMessageId?: string;
}

export interface OutboundEnvelope {
  id: string;
  sequence: number;
  kind: string;
  target: OutboundTarget;
  payload: Record<string, unknown>;
  status: OutboundStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  runId?: string;
  threadId?: string;
  workspaceId?: string;
  projectId?: string;
  externalId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOutboundInput {
  kind: string;
  target: OutboundTarget;
  payload: Record<string, unknown>;
  runId?: string;
  thread?: SourceThread;
  maxAttempts?: number;
}

export interface ClaimOutboundOptions {
  limit?: number;
  now?: Date;
}

export interface TurnDeliveryRecord {
  id: string;
  runId: string;
  outboxId: string;
  kind: string;
  platform: PlatformKind;
  threadId?: string;
  workspaceId?: string;
  projectId?: string;
  targetId: string;
  status: TurnDeliveryStatus;
  queuedAt: string;
  acceptedAt?: string;
  completedAt?: string;
  failedAt?: string;
  lastError?: string;
  updatedAt: string;
}

export interface ThreadBinding {
  id: string;
  platform: PlatformKind;
  externalId: string;
  scope?: ThreadBindingScope;
  source?: ThreadBindingSource;
  channelId?: string;
  workspaceId: string;
  projectId: string;
  title?: string;
  activationMode: ThreadActivationMode;
  requireMention: boolean;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface InboundEventRecord {
  id: string;
  platform: PlatformKind;
  externalId: string;
  status: InboundEventStatus;
  duplicateCount: number;
  eventType?: string;
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  messageId?: string;
  receivedAt: string;
  processedAt?: string;
  ignoredAt?: string;
  failedAt?: string;
  rejectedAt?: string;
  reason?: string;
  lastError?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RecordInboundEventInput {
  platform: PlatformKind;
  externalId: string;
  eventType?: string;
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordInboundEventResult {
  record: InboundEventRecord;
  duplicate: boolean;
}

export interface UpsertThreadBindingInput {
  thread: SourceThread;
  workspaceId: string;
  projectId: string;
  activationMode?: ThreadActivationMode;
  requireMention?: boolean;
}

export interface ConfigureThreadBindingInput {
  platform: PlatformKind;
  externalId: string;
  workspaceId: string;
  projectId: string;
  scope?: ThreadBindingScope;
  source?: ThreadBindingSource;
  channelId?: string;
  title?: string;
  activationMode?: ThreadActivationMode;
  requireMention?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DeliverySummary {
  outbox: Record<OutboundStatus, number>;
  turnDeliveries: Record<TurnDeliveryStatus, number>;
  inboundEvents: Record<InboundEventStatus, number> & { duplicates: number };
  bindings: number;
}

export interface FileDeliveryState {
  nextSequence: number;
  outbox: OutboundEnvelope[];
  turnDeliveries: TurnDeliveryRecord[];
  threadBindings: ThreadBinding[];
  inboundEvents: InboundEventRecord[];
}
