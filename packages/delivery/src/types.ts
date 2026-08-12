import type {
  ExecutorSteeringMode,
  PlatformKind,
  SourceMessage,
  SourceThread,
  ThreadTranscriptSnapshot,
} from '@opentag/core';

export type OutboundStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export type TurnDeliveryStatus =
  | 'queued'
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ThreadActivationMode = 'mention' | 'always';

export type ThreadBindingScope = 'thread' | 'channel';

export type ThreadBindingSource = 'observed' | 'configured';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunSteeringStatus =
  | 'pending'
  | 'claimed'
  | 'scheduled'
  | 'applied'
  | 'failed'
  | 'cancelled';

export type AgentThreadSessionStatus = 'active' | 'invalidated';

export type AgentRunEventType =
  | 'created'
  | 'started'
  | 'progress'
  | 'text_delta'
  | 'artifact'
  | 'tool_call'
  | 'tool_result'
  | 'log'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'steering_mode'
  | 'steering_queued'
  | 'steering_claimed'
  | 'steering_scheduled'
  | 'steering_applied'
  | 'steering_failed'
  | 'steering_cancelled'
  | 'transcript_loaded'
  | 'session_started'
  | 'session_resumed'
  | 'session_invalidated'
  | 'memory_command'
  | 'routine_command';

export type InboundEventStatus =
  | 'received'
  | 'processed'
  | 'ignored'
  | 'failed'
  | 'rejected';

export interface OutboundTarget {
  platform: PlatformKind;
  chatId?: string;
  topicId?: string;
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

export interface OutboxScopeFilter {
  runId?: string;
  threadId?: string;
  workspaceId?: string;
  projectId?: string;
  targetId?: string;
  kind?: string;
}

export interface RecoverStaleOutboxOptions extends OutboxScopeFilter {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
  reason?: string;
}

export interface RecoverStaleOutboxResult {
  requeued: number;
  failed: number;
  records: OutboundEnvelope[];
}

export interface CancelOutboxOptions extends OutboxScopeFilter {
  reason?: string;
  limit?: number;
}

export interface CancelOutboxResult {
  cancelled: number;
  records: OutboundEnvelope[];
}

export interface AgentRunRecord {
  id: string;
  status: AgentRunStatus;
  platform: PlatformKind;
  thread?: SourceThread;
  message?: SourceMessage;
  threadId: string;
  threadExternalId: string;
  workspaceId?: string;
  projectId?: string;
  messageId?: string;
  actorId?: string;
  bindingId?: string;
  executorId?: string;
  transportMode?: string;
  title?: string;
  inboundEventId?: string;
  workerId?: string;
  claimedAt?: string;
  summary?: string;
  lastError?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelRequestedAt?: string;
  cancelledAt?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRunTimelineEvent {
  id: string;
  runId: string;
  type: AgentRunEventType;
  at: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentRunInput {
  runId: string;
  thread: SourceThread;
  message?: SourceMessage;
  inboundEventId?: string;
  bindingId?: string;
  executorId?: string;
  transportMode?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentRunOrSteerInput extends CreateAgentRunInput {
  allowLiveSteering?: boolean;
}

export interface AgentRunSteeringRecord {
  id: string;
  sequence: number;
  targetRunId: string;
  status: AgentRunSteeringStatus;
  mode?: ExecutorSteeringMode;
  allowLive: boolean;
  platform: PlatformKind;
  thread: SourceThread;
  message: SourceMessage;
  threadId: string;
  workspaceId?: string;
  projectId?: string;
  inboundEventId?: string;
  bindingId?: string;
  executorId?: string;
  transportMode?: string;
  continuationRunId?: string;
  claimedBy?: string;
  claimedAt?: string;
  receivedAt: string;
  scheduledAt?: string;
  appliedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  updatedAt: string;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentRunOrSteerResult {
  disposition: 'created' | 'steered';
  run: AgentRunRecord;
  steering?: AgentRunSteeringRecord;
}

export interface EnqueueAgentRunSteeringInput {
  targetRunId: string;
  message: SourceMessage;
  inboundEventId?: string;
  bindingId?: string;
  executorId?: string;
  transportMode?: string;
  allowLiveSteering?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ClaimAgentRunSteeringOptions {
  workerId: string;
  now?: Date;
}

export interface ListAgentRunSteeringOptions {
  runId?: string;
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  status?: AgentRunSteeringStatus;
  limit?: number;
}

export interface AgentThreadSessionRecord {
  id: string;
  providerId: string;
  namespace: string;
  sessionId: string;
  status: AgentThreadSessionStatus;
  platform: PlatformKind;
  threadId: string;
  workspaceId?: string;
  projectId?: string;
  startedByRunId: string;
  lastRunId: string;
  createdAt: string;
  updatedAt: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface AgentThreadSessionQuery {
  providerId: string;
  namespace: string;
  thread: SourceThread;
}

export interface RecordAgentThreadSessionInput
  extends AgentThreadSessionQuery {
  sessionId: string;
  runId: string;
}

export interface LoadThreadTranscriptOptions {
  thread: SourceThread;
  excludeRunId?: string;
  maxEntries?: number;
  maxChars?: number;
}

export type LoadedThreadTranscript = ThreadTranscriptSnapshot;

export interface CancelThreadAgentRunsResult {
  runs: AgentRunRecord[];
  steering: AgentRunSteeringRecord[];
}

export interface ClaimAgentRunsOptions {
  limit?: number;
  workerId?: string;
  now?: Date;
}

export interface RecoverStaleAgentRunsOptions {
  olderThanMs?: number;
  now?: Date;
  limit?: number;
  reason?: string;
}

export interface RecoverStaleAgentRunsResult {
  requeued: number;
  cancelled: number;
  records: AgentRunRecord[];
}

export interface ListAgentRunsOptions {
  status?: AgentRunStatus;
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  limit?: number;
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
  agentRuns: Record<AgentRunStatus, number>;
  steering: Record<AgentRunSteeringStatus, number>;
  sessions: Record<AgentThreadSessionStatus, number>;
  bindings: number;
}

export interface FileDeliveryState {
  nextSequence: number;
  nextSteeringSequence: number;
  outbox: OutboundEnvelope[];
  turnDeliveries: TurnDeliveryRecord[];
  threadBindings: ThreadBinding[];
  inboundEvents: InboundEventRecord[];
  agentRuns: AgentRunRecord[];
  agentRunEvents: AgentRunTimelineEvent[];
  agentRunSteering: AgentRunSteeringRecord[];
  agentThreadSessions: AgentThreadSessionRecord[];
}
