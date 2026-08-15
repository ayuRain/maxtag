import type {
  ExecutorSteeringMode,
  PlatformKind,
  SourceMessage,
  SourceThread,
  ThreadTranscriptEntry,
  ThreadTranscriptCursor,
  ThreadTranscriptSnapshot,
  ToolApprovalRecord,
  ToolApprovalStatus,
  UsageBudgetPolicy,
} from '@opentag/core';

export type {
  ClaimToolApprovalInput,
  CompleteToolApprovalInput,
  DecideToolApprovalInput,
  FailToolApprovalInput,
  MarkToolApprovalContinuationInput,
  ListToolApprovalsOptions,
  ProposeToolApprovalInput,
  RecoverStaleToolApprovalsInput,
  RecoverStaleToolApprovalsResult,
  ToolApprovalRecord,
  ToolApprovalStatus,
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

export type ThreadBindingAuditAction =
  | 'binding.created'
  | 'binding.updated'
  | 'binding.removed';

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
  | 'memory_proposal'
  | 'memory_retrieval'
  | 'memory_analysis_started'
  | 'memory_analysis_completed'
  | 'memory_analysis_failed'
  | 'memory_query_started'
  | 'memory_query_completed'
  | 'memory_query_failed'
  | 'memory_wrapup_queued'
  | 'memory_wrapup_started'
  | 'memory_wrapup_completed'
  | 'memory_wrapup_retry'
  | 'memory_wrapup_failed'
  | 'tool_call'
  | 'tool_approval'
  | 'tool_result'
  | 'delegation'
  | 'log'
  | 'completed'
  | 'failed'
  | 'human_takeover'
  | 'cancel_requested'
  | 'cancelled'
  | 'steering_mode'
  | 'steering_queued'
  | 'steering_claimed'
  | 'steering_scheduled'
  | 'steering_applied'
  | 'steering_failed'
  | 'steering_cancelled'
  | 'thread_context_imported'
  | 'thread_context_import_failed'
  | 'usage_budget_denied'
  | 'usage_threshold_alert'
  | 'usage_recorded'
  | 'transcript_loaded'
  | 'session_started'
  | 'session_resumed'
  | 'session_invalidated'
  | 'thread_status'
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
  sequence: number;
  runId: string;
  type: AgentRunEventType;
  at: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ScopedAgentRunTimelineEvent extends AgentRunTimelineEvent {
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  threadId: string;
  platform: PlatformKind;
  actorId?: string;
  runStatus: AgentRunStatus;
}

export interface ListAgentRunEventsOptions {
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  runId?: string;
  types?: AgentRunEventType[];
  limit?: number;
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
  forceNewRun?: boolean;
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
  afterCursor?: ThreadTranscriptCursor;
  order?: 'latest' | 'oldest';
  includeContextSummaries?: boolean;
}

export type LoadedThreadTranscript = ThreadTranscriptSnapshot;

export type MemoryWrapupJobStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'failed';

export interface MemoryWrapupCursorRecord extends ThreadTranscriptCursor {
  id: string;
  platform: PlatformKind;
  threadId: string;
  workspaceId?: string;
  projectId?: string;
  sourceRunId: string;
  updatedAt: string;
}

export interface MemoryWrapupJobRecord {
  id: string;
  status: MemoryWrapupJobStatus;
  platform: PlatformKind;
  thread: SourceThread;
  threadId: string;
  workspaceId?: string;
  projectId?: string;
  sourceRunId: string;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  failedAt?: string;
  lastError?: string;
  cursor?: MemoryWrapupCursorRecord;
  proposalIds?: string[];
  transcriptEntries?: number;
  transcriptOmittedEntries?: number;
  contextSummaryId?: string;
  autoApprovedProposalIds?: string[];
}

export interface EnqueueMemoryWrapupInput {
  thread: SourceThread;
  sourceRunId: string;
  debounceMs?: number;
  maxAttempts?: number;
  now?: Date;
}

export interface ClaimMemoryWrapupsOptions {
  workerId: string;
  limit?: number;
  staleMs?: number;
  now?: Date;
}

export interface CompleteMemoryWrapupInput {
  cursor?: ThreadTranscriptCursor;
  proposalIds?: string[];
  transcriptEntries?: number;
  transcriptOmittedEntries?: number;
  contextSummaryId?: string;
  autoApprovedProposalIds?: string[];
  now?: Date;
}

export interface RetryMemoryWrapupInput {
  error: string;
  retryDelayMs?: number;
  now?: Date;
}

export interface ListMemoryWrapupsOptions {
  status?: MemoryWrapupJobStatus;
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  limit?: number;
}

export interface PruneMemoryWrapupsOptions {
  terminalOlderThanMs?: number;
  keepLatestPerThread?: number;
  now?: Date;
}

export interface PruneMemoryWrapupsResult {
  removed: number;
  retained: number;
}

export interface WorkspaceDataLifecycleCounts {
  agentRuns: number;
  agentRunEvents: number;
  outbox: number;
  turnDeliveries: number;
  steering: number;
  invalidatedSessions: number;
  memoryWrapups: number;
  toolApprovals: number;
}

export interface WorkspaceDataLifecyclePreserved {
  activeRuns: number;
  recentTerminalRuns: number;
  referencedTerminalRuns: number;
  inboundEvents: number;
  usageRecords: number;
  sourceMessages: number;
  managedArtifactRuns: number;
}

export interface WorkspaceDataLifecycleOptions {
  workspaceId: string;
  retentionDays?: number;
  keepLatestPerThread?: number;
  dryRun?: boolean;
  actor?: string;
  now?: Date;
  protectedRunIds?: string[];
}

export interface WorkspaceDataLifecycleResult {
  dryRun: boolean;
  workspaceId: string;
  retentionDays: number;
  cutoff: string;
  keepLatestPerThread: number;
  scannedRuns: number;
  eligibleTerminalRuns: number;
  removed: WorkspaceDataLifecycleCounts;
  preserved: WorkspaceDataLifecyclePreserved;
}

export interface DataLifecycleAuditRecord {
  id: string;
  action: 'workspace.data_lifecycle.applied';
  workspaceId: string;
  actor: string;
  at: string;
  retentionDays: number;
  cutoff: string;
  keepLatestPerThread: number;
  removed: WorkspaceDataLifecycleCounts;
  preserved: WorkspaceDataLifecyclePreserved;
}

export interface ListDataLifecycleAuditOptions {
  workspaceId?: string;
  limit?: number;
}

export type SourceThreadMessageOrigin = 'event' | 'history';

export interface SourceThreadMessageRecord {
  id: string;
  platform: PlatformKind;
  threadId: string;
  threadExternalId: string;
  workspaceId?: string;
  projectId?: string;
  thread?: SourceThread;
  message: SourceMessage;
  origin: SourceThreadMessageOrigin;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface ThreadContextSummaryRecord {
  id: string;
  platform: PlatformKind;
  threadId: string;
  threadExternalId: string;
  workspaceId?: string;
  projectId?: string;
  summary: string;
  coveredEntryIds: string[];
  startAt: string;
  endAt: string;
  startMessageId?: string;
  endMessageId?: string;
  entryCount: number;
  characterCount: number;
  contentHash: string;
  fromCursor?: ThreadTranscriptCursor;
  toCursor: ThreadTranscriptCursor;
  rawExpiresAt: string;
  rawPurgedAt?: string;
  createdAt: string;
}

export interface RecordThreadContextSummaryInput {
  thread: SourceThread;
  summary: string;
  entries: ThreadTranscriptEntry[];
  fromCursor?: ThreadTranscriptCursor;
  toCursor: ThreadTranscriptCursor;
  rawGraceMs?: number;
  now?: Date;
}

export interface PurgeThreadContextRawOptions {
  now?: Date;
  limit?: number;
}

export interface PurgeThreadContextRawResult {
  summaries: number;
  sourceMessages: number;
  runMessages: number;
  steeringMessages: number;
}

export interface UpsertSourceThreadMessagesInput {
  thread: SourceThread;
  messages: SourceMessage[];
  origin: SourceThreadMessageOrigin;
  observedAt?: Date;
}

export interface UpsertSourceThreadMessagesResult {
  inserted: number;
  updated: number;
  duplicates: number;
  records: SourceThreadMessageRecord[];
}

export type ThreadContextSyncStatus = 'completed' | 'failed';

export interface ThreadContextSyncRecord {
  id: string;
  source: string;
  status: ThreadContextSyncStatus;
  platform: PlatformKind;
  threadId: string;
  threadExternalId: string;
  workspaceId?: string;
  projectId?: string;
  attemptedAt: string;
  completedAt?: string;
  importedMessages: number;
  duplicateMessages: number;
  truncated: boolean;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export type LarkHistoryImportMode = 'awaiting_choice' | 'from_now' | 'history';

export type LarkHistoryImportStatus =
  | 'awaiting_choice'
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface LarkHistoryImportCursor {
  windowSince: string;
  analysisWindowSince?: string;
  analysis: Record<string, ThreadTranscriptCursor>;
}

/**
 * Durable, tenant-scoped state for one old-group initialization.  A job moves
 * forward in bounded time windows so a process restart can safely repeat only
 * the current window. Imported source-message ids are idempotent; pending
 * memory proposals are content-deduplicated and the analysis cursor is durable.
 */
export interface LarkHistoryImportJobRecord {
  id: string;
  mode: LarkHistoryImportMode;
  status: LarkHistoryImportStatus;
  workspaceId: string;
  projectId: string;
  channelId: string;
  channelTitle?: string;
  thread: SourceThread;
  since?: string;
  until?: string;
  cursor?: LarkHistoryImportCursor;
  analyzeMemory: boolean;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  lastError?: string;
  scannedMessages: number;
  importedMessages: number;
  duplicateMessages: number;
  ignoredMessages: number;
  discoveredThreads: number;
  analyzedThreads: number;
  proposalIds: string[];
  cardMessageId?: string;
  requestedBy?: string;
}

export interface CreateLarkHistoryImportInput {
  workspaceId: string;
  projectId: string;
  channelId: string;
  channelTitle?: string;
  thread: SourceThread;
  mode?: LarkHistoryImportMode;
  since?: Date;
  until?: Date;
  analyzeMemory?: boolean;
  maxAttempts?: number;
  cardMessageId?: string;
  requestedBy?: string;
  now?: Date;
}

export interface ClaimLarkHistoryImportsOptions {
  workerId: string;
  limit?: number;
  staleMs?: number;
  now?: Date;
}

export interface ConfigureLarkHistoryImportInput {
  mode: 'from_now' | 'history';
  since?: Date;
  until?: Date;
  analyzeMemory?: boolean;
  requestedBy?: string;
  cardMessageId?: string;
  now?: Date;
}

export interface UpdateLarkHistoryImportOnboardingInput {
  projectId?: string;
  cardMessageId?: string;
  now?: Date;
}

export interface UpdateLarkHistoryImportProgressInput {
  cursor?: LarkHistoryImportCursor;
  scannedMessages?: number;
  importedMessages?: number;
  duplicateMessages?: number;
  ignoredMessages?: number;
  discoveredThreads?: number;
  analyzedThreads?: number;
  proposalIds?: string[];
  now?: Date;
}

export interface RetryLarkHistoryImportInput {
  error: string;
  retryDelayMs?: number;
  now?: Date;
}

export interface ListLarkHistoryImportsOptions {
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  status?: LarkHistoryImportStatus;
  limit?: number;
}

export interface RecordThreadContextSyncInput {
  thread: SourceThread;
  source: string;
  status: ThreadContextSyncStatus;
  importedMessages?: number;
  duplicateMessages?: number;
  truncated?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
  attemptedAt?: Date;
}

export interface UsageQuantity {
  runs: number;
  costUsd: number;
}

export type AgentUsagePurpose =
  | 'agent'
  | 'delegation'
  | 'memory_retrieval'
  | 'memory_query'
  | 'memory_analysis'
  | 'memory_wrapup';

export type UsageBudgetScope = 'workspace' | 'project' | 'channel' | 'thread';

export interface UsageBudgetLine extends UsageQuantity {
  scope: UsageBudgetScope;
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  threadId?: string;
  period: string;
}

export interface UsageBudgetCheckInput {
  thread: SourceThread;
  policy?: UsageBudgetPolicy;
  policies?: UsageBudgetPolicy[];
  expected?: Partial<UsageQuantity>;
  at?: Date;
}

export interface UsageBudgetCheckResult {
  allowed: boolean;
  reason?: 'runs_budget_exceeded' | 'cost_budget_exceeded';
  period: string;
  policy?: UsageBudgetPolicy;
  current: UsageBudgetLine[];
  projected: UsageBudgetLine[];
  violated?: UsageBudgetLine;
}

export interface RecordAgentRunUsageInput {
  runId: string;
  recordKey?: string;
  purpose?: AgentUsagePurpose;
  thread: SourceThread;
  quantity?: Partial<UsageQuantity>;
  source?: string;
  policies?: UsageBudgetPolicy[];
  at?: Date;
  metadata?: Record<string, unknown>;
}

export interface AgentRunUsageRecord extends UsageQuantity {
  id: string;
  runId: string;
  recordKey?: string;
  purpose: AgentUsagePurpose;
  platform: PlatformKind;
  threadId: string;
  threadExternalId: string;
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  period: string;
  source: string;
  recordedAt: string;
  metadata?: Record<string, unknown>;
}

export interface UsagePurposeLine extends UsageQuantity {
  purpose: AgentUsagePurpose;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costReportedCalls: number;
  tokenReportedCalls: number;
}

export type UsageBudgetAlertMetric = 'runs' | 'cost';
export type UsageBudgetAlertThreshold = 75 | 95;

export interface UsageBudgetAlert {
  id: string;
  runId: string;
  period: string;
  metric: UsageBudgetAlertMetric;
  thresholdPercent: UsageBudgetAlertThreshold;
  scope: UsageBudgetScope;
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  threadId?: string;
  current: number;
  limit: number;
  ratio: number;
  triggeredAt: string;
}

export interface UsageSnapshot {
  period: string;
  records: AgentRunUsageRecord[];
  recordCount: number;
  costReportedRecords: number;
  tokenReportedRecords: number;
  totals: UsageBudgetLine[];
  purposeTotals: UsagePurposeLine[];
  alerts: UsageBudgetAlert[];
}

export interface ReconcileUsageBudgetAlertsInput {
  runId?: string;
  thread: SourceThread;
  policies?: UsageBudgetPolicy[];
  at?: Date;
}

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

export interface RequeueAgentRunOptions {
  workerId?: string;
  reason?: string;
  now?: Date;
}

export interface RenewAgentRunLeaseOptions {
  workerId: string;
  now?: Date;
}

export interface MarkAgentRunRunningOptions {
  workerId?: string;
  now?: Date;
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
  query?: string;
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
  actor?: string;
  reason?: string;
}

export interface RemoveThreadBindingOptions {
  cascadeChannel?: boolean;
  actor?: string;
  reason?: string;
}

export interface ThreadBindingAuditRecord {
  id: string;
  action: ThreadBindingAuditAction;
  bindingId: string;
  platform: PlatformKind;
  externalId: string;
  scope?: ThreadBindingScope;
  source?: ThreadBindingSource;
  channelId?: string;
  workspaceId: string;
  projectId: string;
  actor?: string;
  reason?: string;
  at: string;
  before?: ThreadBinding;
  after?: ThreadBinding;
  metadata?: Record<string, unknown>;
}

export interface ListThreadBindingAuditOptions {
  workspaceId?: string;
  projectId?: string;
  bindingId?: string;
  platform?: PlatformKind;
  limit?: number;
}

export interface DeliverySummary {
  outbox: Record<OutboundStatus, number>;
  turnDeliveries: Record<TurnDeliveryStatus, number>;
  inboundEvents: Record<InboundEventStatus, number> & { duplicates: number };
  agentRuns: Record<AgentRunStatus, number>;
  steering: Record<AgentRunSteeringStatus, number>;
  sessions: Record<AgentThreadSessionStatus, number>;
  toolApprovals: Record<ToolApprovalStatus, number>;
  workflowProducers: {
    received: number;
    staged: number;
    unmatched: number;
    duplicates: number;
    ignored: number;
    failed: number;
  };
  bindings: number;
  usage: {
    records: number;
    currentPeriodRuns: number;
    currentPeriodCostUsd: number;
  };
  oldestStatusUpdatedAt: {
    outbox: Partial<Record<OutboundStatus, string>>;
    turnDeliveries: Partial<Record<TurnDeliveryStatus, string>>;
    inboundEvents: Partial<Record<InboundEventStatus, string>>;
    agentRuns: Partial<Record<AgentRunStatus, string>>;
    steering: Partial<Record<AgentRunSteeringStatus, string>>;
    sessions: Partial<Record<AgentThreadSessionStatus, string>>;
    toolApprovals: Partial<Record<ToolApprovalStatus, string>>;
  };
}

export interface FileDeliveryState {
  nextSequence: number;
  nextSteeringSequence: number;
  nextAgentRunEventSequence: number;
  outbox: OutboundEnvelope[];
  turnDeliveries: TurnDeliveryRecord[];
  threadBindings: ThreadBinding[];
  inboundEvents: InboundEventRecord[];
  agentRuns: AgentRunRecord[];
  agentRunEvents: AgentRunTimelineEvent[];
  agentRunSteering: AgentRunSteeringRecord[];
  agentThreadSessions: AgentThreadSessionRecord[];
  sourceThreadMessages: SourceThreadMessageRecord[];
  threadContextSummaries: ThreadContextSummaryRecord[];
  threadContextSyncs: ThreadContextSyncRecord[];
  usageRecords: AgentRunUsageRecord[];
  usageAlerts: UsageBudgetAlert[];
  threadBindingAudit: ThreadBindingAuditRecord[];
  memoryWrapupJobs: MemoryWrapupJobRecord[];
  memoryWrapupCursors: MemoryWrapupCursorRecord[];
  larkHistoryImportJobs: LarkHistoryImportJobRecord[];
  toolApprovals: ToolApprovalRecord[];
  dataLifecycleAudit: DataLifecycleAuditRecord[];
}
