export type PlatformKind =
  | 'lark'
  | 'telegram'
  | 'slack'
  | 'github'
  | 'linear'
  | (string & {});

export type ThreadVisibility = 'public' | 'private' | 'direct';

export type ClientStatus = 'ready' | 'partial' | 'planned';

export type MemoryScopeKind =
  | 'global'
  | 'workspace'
  | 'project'
  | 'channel'
  | 'thread';
export type MemoryApprovalAction = 'remember' | 'forget';

export interface MemoryApprovalPolicy {
  mode?: 'inherit' | 'require_approval' | 'disabled';
  scopes?: MemoryScopeKind[];
  actions?: MemoryApprovalAction[];
}

export interface MemoryRetentionPolicy {
  mode?: 'inherit' | 'keep' | 'custom';
  days?: number;
}

export interface ToolApprovalPolicy {
  mode?: 'inherit' | 'require_approval' | 'disabled';
  risks?: ToolCallRisk[];
}

export type MemoryRetentionDaysByScope = Partial<
  Record<Exclude<MemoryScopeKind, 'global'>, number>
>;

export interface Workspace {
  id: string;
  name: string;
  defaultProjectId?: string;
  platformTenantIds?: Partial<Record<PlatformKind, string>>;
  metadata?: Record<string, unknown>;
}

export interface Project {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description?: string;
  platformBindings?: Array<{
    platform: PlatformKind;
    externalId: string;
    channelId?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface MemoryScope {
  kind: MemoryScopeKind;
  workspaceId?: string;
  projectId?: string;
  platform?: PlatformKind;
  channelId?: string;
  threadId?: string;
  label: string;
}

export interface ScopedMemorySnapshot {
  loadedAt: string;
  scopes: Array<{
    scope: MemoryScope;
    content: string;
    document?: MemoryDocument;
    lineNumbers?: number[];
    expiredLines?: number;
  }>;
  text: string;
}

export type MemoryRevisionAction =
  | 'remember'
  | 'replace'
  | 'merge'
  | 'forget'
  | 'restore'
  | 'import';

export interface MemoryDocument {
  key: string;
  scope: MemoryScope;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  latestRevisionId: string;
}

export interface MemorySemanticIndexEntry {
  documentKey: string;
  version: number;
  lineNumber: number;
  lineHash: string;
  aliases: string[];
  indexedAt: string;
  indexedBy: string;
}

export interface MemorySemanticIndexQuery extends MemoryQuery {
  limit?: number;
}

export interface MemoryExpiryEntry {
  documentKey: string;
  version: number;
  lineNumber: number;
  lineHash: string;
  expiresAt: string;
  setAt: string;
  setBy: string;
  source?: string;
}

export interface MemoryExpiryAuditRecord {
  id: string;
  action: 'set' | 'clear';
  documentKey: string;
  version: number;
  lineNumber: number;
  lineHash: string;
  expiresAt?: string;
  actorId: string;
  source?: string;
  at: string;
}

export interface MemoryExpiryQuery extends MemoryQuery {
  scope?: MemoryScopeKind;
  includeAudit?: boolean;
  limit?: number;
}

export interface MemoryExpiryUpdateInput extends MemoryQuery {
  scope: MemoryScopeKind;
  selector: string;
  expiresAt?: string;
  actorId?: string;
  source?: string;
}

export interface MemoryExpirySnapshot {
  checkedAt: string;
  entries: MemoryExpiryEntry[];
  audit: MemoryExpiryAuditRecord[];
}

export interface MemoryRevision {
  id: string;
  documentKey: string;
  version: number;
  action: MemoryRevisionAction;
  actorId: string;
  source?: string;
  at: string;
  content: string;
  selector?: string;
  selectors?: string[];
  restoredFromRevisionId?: string;
}

export interface MemoryHistory {
  document?: MemoryDocument;
  revisions: MemoryRevision[];
}

export interface MemoryQuery {
  thread: SourceThread;
  workspace?: Workspace;
  project?: Project;
  scopes?: MemoryScopeKind[];
}

export interface MemoryWriteRequest extends MemoryQuery {
  scope: MemoryScopeKind;
  text: string;
  expiresAt?: string;
  actorId?: string;
  source?: string;
}

export interface MemoryForgetRequest extends MemoryQuery {
  scope: MemoryScopeKind;
  selector: string;
  actorId?: string;
  source?: string;
}

export interface MemoryHistoryQuery extends MemoryQuery {
  scope: MemoryScopeKind;
  limit?: number;
}

export interface MemoryRestoreRequest extends MemoryQuery {
  scope: MemoryScopeKind;
  revisionId: string;
  actorId?: string;
  source?: string;
}

export interface MemoryExportQuery {
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  threadId?: string;
  scopes?: MemoryScopeKind[];
  includeRevisions?: boolean;
  revisionLimit?: number;
}

export interface MemoryExport {
  schemaVersion: 1;
  exportedAt: string;
  filters: {
    workspaceId?: string;
    projectId?: string;
    channelId?: string;
    threadId?: string;
    scopes?: MemoryScopeKind[];
    includeRevisions: boolean;
    revisionLimit?: number;
  };
  documents: MemoryDocument[];
  revisions: MemoryRevision[];
}

export interface MemoryDiffQuery extends MemoryHistoryQuery {
  revisionId: string;
  compareToRevisionId?: string;
}

export type MemoryDiffLineKind = 'context' | 'added' | 'removed';

export interface MemoryDiffLine {
  kind: MemoryDiffLineKind;
  line: string;
  oldLine?: number;
  newLine?: number;
}

export interface MemoryDiff {
  documentKey: string;
  scope: MemoryScope;
  from?: MemoryRevision;
  to: MemoryRevision;
  addedLines: string[];
  removedLines: string[];
  lines: MemoryDiffLine[];
}

export interface MemoryCompactionQuery extends MemoryExportQuery {
  dryRun?: boolean;
  keepLatestPerDocument?: number;
}

export interface MemoryCompactionResult {
  schemaVersion: 1;
  compactedAt: string;
  dryRun: boolean;
  filters: {
    workspaceId?: string;
    projectId?: string;
    channelId?: string;
    threadId?: string;
    scopes?: MemoryScopeKind[];
    keepLatestPerDocument: number;
  };
  scannedDocuments: number;
  scannedRevisions: number;
  droppedRevisions: MemoryRevision[];
  keptRevisions: MemoryRevision[];
  protectedRevisionIds: string[];
}

export type MemoryProposalAction =
  | 'remember'
  | 'replace'
  | 'merge'
  | 'forget'
  | 'index';
export type MemoryProposalStatus = 'pending' | 'approved' | 'rejected';

export interface MemoryProposal {
  id: string;
  status: MemoryProposalStatus;
  action: MemoryProposalAction;
  scope: MemoryScopeKind;
  documentKey: string;
  scopeRef: MemoryScope;
  thread: SourceThread;
  workspace?: Workspace;
  project?: Project;
  value: string;
  selector?: string;
  selectors?: string[];
  expectedDocumentVersion?: number;
  actorId?: string;
  source?: string;
  reason?: string;
  searchAliases?: string[];
  retentionDays?: number;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  appliedRevisionId?: string;
}

export interface MemoryProposalInput extends MemoryQuery {
  action: MemoryProposalAction;
  scope: MemoryScopeKind;
  value: string;
  selector?: string;
  selectors?: string[];
  expectedDocumentVersion?: number;
  actorId?: string;
  source?: string;
  reason?: string;
  searchAliases?: string[];
  retentionDays?: number;
}

export interface MemoryProposalListQuery {
  status?: MemoryProposalStatus;
  workspaceId?: string;
  projectId?: string;
  scope?: MemoryScopeKind;
  limit?: number;
}

export interface MemoryProposalDecisionInput {
  id: string;
  actorId?: string;
  reason?: string;
}

export interface MemorySearchQuery extends MemoryQuery {
  query: string;
  limit?: number;
}

export interface MemorySearchHit {
  documentKey: string;
  scope: MemoryScope;
  line: string;
  lineNumber: number;
  score: number;
  version: number;
  updatedAt: string;
}

export interface MemorySearchResult {
  query: string;
  searchedAt: string;
  scannedDocuments: number;
  hits: MemorySearchHit[];
}

export interface SourceThread {
  id: string;
  platform: PlatformKind;
  externalId: string;
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  rootMessageId?: string;
  topicId?: string;
  title?: string;
  visibility: ThreadVisibility;
  permalink?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceActor {
  id: string;
  displayName?: string;
  platformUserId?: string;
  isBot?: boolean;
}

export interface SourceAttachment {
  id: string;
  kind: 'image' | 'file' | 'audio' | 'video' | 'link';
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  localPath?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceMessage {
  id: string;
  threadId: string;
  platform: PlatformKind;
  text: string;
  actor: SourceActor;
  createdAt: string;
  mentionsAgent: boolean;
  replyToMessageId?: string;
  attachments?: SourceAttachment[];
  metadata?: Record<string, unknown>;
}

export interface ThreadTranscriptEntry {
  id: string;
  runId?: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  source: 'run' | 'live_steering' | 'source_message' | 'context_summary';
  actor?: SourceActor;
  messageId?: string;
}

export interface ThreadTranscriptSnapshot {
  threadId: string;
  loadedAt: string;
  entries: ThreadTranscriptEntry[];
  totalEntries: number;
  omittedEntries: number;
  truncated: boolean;
  nextCursor?: ThreadTranscriptCursor;
}

export interface ThreadTranscriptCursor {
  at: string;
  entryId: string;
}

export interface AgentIdentity {
  id: string;
  displayName: string;
  description?: string;
  instructions: string;
  defaultExecutorId: string;
  avatarUrl?: string;
}

export interface AgentSkillSummary {
  id: string;
  name: string;
  description: string;
  revision: number;
}

export interface AgentSkill extends AgentSkillSummary {
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillSource {
  list(input?: {
    ids?: string[];
    includeDisabled?: boolean;
  }): Promise<AgentSkill[]>;
  get(id: string): Promise<AgentSkill | undefined>;
}

export type KnowledgeSourceKind = 'text' | 'file' | 'url';

export interface KnowledgeSourceExtraction {
  sourceMediaType: string;
  extractor: 'plain-text' | 'html-to-text' | 'mammoth' | 'pdf-parse';
  inputBytes: number;
  rawHash: string;
  fileName?: string;
  extractedAt: string;
  pageCount?: number;
}

export interface KnowledgeSourceSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  kind: KnowledgeSourceKind;
  sourceUri?: string;
  mediaType: string;
  extraction?: KnowledgeSourceExtraction;
  refreshIntervalMs?: number;
  contentHash: string;
  sizeBytes: number;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSource extends KnowledgeSourceSummary {
  content: string;
}

export interface KnowledgeSearchHit {
  sourceId: string;
  sourceName: string;
  revision: number;
  contentHash: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  score: number;
  matchedTerms: string[];
  strategy?: 'lexical' | 'semantic_alias';
}

export interface KnowledgePassageCandidate {
  lineStart: number;
  lineEnd: number;
  summary: string;
  aliases: string[];
  confidence?: number;
}

export interface KnowledgeSourceStore {
  list(input: {
    workspaceId: string;
    ids?: string[];
    includeDisabled?: boolean;
  }): Promise<KnowledgeSource[]>;
  get(workspaceId: string, id: string): Promise<KnowledgeSource | undefined>;
  search(input: {
    workspaceId: string;
    ids: string[];
    query: string;
    limit?: number;
  }): Promise<KnowledgeSearchHit[]>;
}

export interface DelegatedAgentSummary {
  id: string;
  name: string;
  description: string;
  executorId: string;
  revision: number;
}

export interface DelegatedAgentDefinition extends DelegatedAgentSummary {
  instructions: string;
  enabled: boolean;
  model?: string;
  skillIds: string[];
  grantKinds: ToolGrantKind[];
  memoryScopes: MemoryScopeKind[];
  networkHosts: string[];
  maxTurns: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface DelegatedAgentSource {
  list(input?: {
    ids?: string[];
    includeDisabled?: boolean;
  }): Promise<DelegatedAgentDefinition[]>;
  get(id: string): Promise<DelegatedAgentDefinition | undefined>;
}

export interface DelegatedAgentInvocation {
  parentRunId: string;
  agentId: string;
  depth: number;
}

export type DelegatedAgentTaskStatus =
  | 'queued'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

export interface DelegatedAgentTaskAccessSnapshot {
  skillIds: string[];
  knowledgeSourceIds: string[];
  grantIds: string[];
  memoryScopes: MemoryScopeKind[];
  networkPolicy: AccessBundle['networkPolicy'];
}

export interface DelegatedAgentTask {
  id: string;
  status: DelegatedAgentTaskStatus;
  parentRunId: string;
  workspaceId: string;
  projectId?: string;
  thread: SourceThread;
  agentId: string;
  agentRevision: number;
  task: string;
  taskPreview: string;
  createdBy: string;
  accessSnapshot: DelegatedAgentTaskAccessSnapshot;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  summary?: string;
  error?: string;
  executorId?: string;
  model?: string;
  usage?: AgentRunUsage;
  continuationRunId?: string;
  continuationScheduledAt?: string;
  policy?: {
    readOnly: true;
    recursiveDelegation: false;
    directPublishing: false;
    transcriptShared: false;
    skillIds: string[];
    grantIds: string[];
    memoryScopes: MemoryScopeKind[];
    knowledgeSourceIds: string[];
    networkHosts: string[];
  };
}

export interface DelegatedAgentTaskStore {
  create(input: {
    parentRunId: string;
    workspaceId: string;
    projectId?: string;
    thread: SourceThread;
    agentId: string;
    agentRevision: number;
    task: string;
    createdBy: string;
    accessSnapshot: DelegatedAgentTaskAccessSnapshot;
  }): Promise<DelegatedAgentTask>;
  get(id: string): Promise<DelegatedAgentTask | undefined>;
  list(input?: {
    workspaceId?: string;
    projectId?: string;
    threadId?: string;
    parentRunId?: string;
    status?: DelegatedAgentTaskStatus;
    limit?: number;
  }): Promise<DelegatedAgentTask[]>;
  referencedRunIds?(workspaceId: string): Promise<string[]>;
  cancel(input: { id: string; actor: string }): Promise<DelegatedAgentTask>;
  markContinuation(input: { id: string; runId: string }): Promise<DelegatedAgentTask>;
}

export interface UsageBudgetLimit {
  maxRunsPerMonth?: number;
  maxCostUsdPerMonth?: number;
}

export interface UsageBudgetPolicy extends UsageBudgetLimit {
  mode?: 'inherit' | 'custom' | 'disabled';
  scope?: 'workspace' | 'project' | 'channel' | 'thread';
}

export type ToolGrantKind =
  | 'github'
  | 'lark-docs'
  | 'lark-base'
  | 'browser'
  | 'shell'
  | 'memory'
  | (string & {});

export interface ToolGrant {
  id: string;
  kind: ToolGrantKind;
  scope: 'thread' | 'channel' | 'workspace' | 'project' | 'global';
  label: string;
  credentialIdentityId?: string;
  constraints?: Record<string, unknown>;
}

export interface AccessBundle {
  id: string;
  threadId: string;
  workspaceId?: string;
  projectId?: string;
  skillIds?: string[];
  agentIds?: string[];
  knowledgeSourceIds?: string[];
  grants: ToolGrant[];
  networkPolicy: {
    mode: 'deny-by-default' | 'allow-all' | 'restricted';
    allowedHosts: string[];
  };
  budgetPolicy?: UsageBudgetPolicy;
  budgetPolicies?: UsageBudgetPolicy[];
  memoryApprovalPolicy?: MemoryApprovalPolicy;
  memoryRetentionDays?: MemoryRetentionDaysByScope;
  toolApprovalPolicy?: ToolApprovalPolicy;
}

export interface ChecklistItem {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

export interface ProgressState {
  runId: string;
  title: string;
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
  checklist: ChecklistItem[];
  updatedAt: string;
}

export const OPENTAG_STOP_RUN_ACTION = 'opentag.stop_run';
export const OPENTAG_TAKE_OVER_RUN_ACTION = 'opentag.take_over_run';
export const OPENTAG_APPROVE_MEMORY_PROPOSAL_ACTION =
  'opentag.memory_proposal.approve';
export const OPENTAG_REJECT_MEMORY_PROPOSAL_ACTION =
  'opentag.memory_proposal.reject';
export const OPENTAG_APPROVE_TOOL_ACTION = 'opentag.tool_approval.approve';
export const OPENTAG_REJECT_TOOL_ACTION = 'opentag.tool_approval.reject';
export const OPENTAG_SET_THREAD_ACTIVATION_ACTION =
  'opentag.thread_activation.set';
export const OPENTAG_REQUEUE_RUN_ABORT_REASON = 'opentag.run_requeue';
export const OPENTAG_LEASE_LOST_ABORT_REASON = 'opentag.run_lease_lost';

export function isOpenTagRequeueAbort(signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    typeof signal.reason === 'string' &&
    (signal.reason === OPENTAG_REQUEUE_RUN_ABORT_REASON ||
      signal.reason.startsWith(`${OPENTAG_REQUEUE_RUN_ABORT_REASON}:`))
  );
}

export function isOpenTagLeaseLostAbort(
  signal: AbortSignal | undefined,
): boolean {
  return (
    signal?.aborted === true &&
    typeof signal.reason === 'string' &&
    (signal.reason === OPENTAG_LEASE_LOST_ABORT_REASON ||
      signal.reason.startsWith(`${OPENTAG_LEASE_LOST_ABORT_REASON}:`))
  );
}

export function openTagAbortSummary(
  signal: AbortSignal | undefined,
  fallback: string,
): string {
  if (
    !signal?.aborted ||
    isOpenTagRequeueAbort(signal) ||
    isOpenTagLeaseLostAbort(signal)
  ) {
    return fallback;
  }
  return 'Stopped by request.';
}

export interface ProgressSurface {
  create(state: ProgressState): Promise<{ surfaceId: string }>;
  update(surfaceId: string, state: ProgressState): Promise<void>;
  complete(surfaceId: string, state: ProgressState): Promise<void>;
}

export type ArtifactKind =
  | 'message'
  | 'file'
  | 'patch'
  | 'pull-request'
  | 'report'
  | 'chart'
  | 'link'
  | (string & {});

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  url?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export type ToolCallRisk = 'read' | 'write';
export type ToolCallStatus =
  | 'pending_approval'
  | 'succeeded'
  | 'failed'
  | 'denied';

export type ToolApprovalStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired';

export interface ToolApprovalRecord {
  id: string;
  status: ToolApprovalStatus;
  runId: string;
  toolCallId: string;
  toolName: string;
  title: string;
  grantKind: ToolGrantKind;
  risk: ToolCallRisk;
  arguments: Record<string, unknown>;
  argumentSummary: Record<string, unknown>;
  argumentDigest: string;
  credentialIdentityId?: string;
  credentialIdentityRevision?: number;
  externalActor?: string;
  platform: PlatformKind;
  thread: SourceThread;
  threadId: string;
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  claimedAt?: string;
  claimedBy?: string;
  completedAt?: string;
  failedAt?: string;
  resultPreview?: string;
  error?: string;
  continuationStatus?: 'pending' | 'scheduled';
  continuationRunId?: string;
  continuationScheduledAt?: string;
}

export interface ProposeToolApprovalInput {
  runId: string;
  toolCallId: string;
  toolName: string;
  title: string;
  grantKind: ToolGrantKind;
  risk: ToolCallRisk;
  arguments: Record<string, unknown>;
  argumentSummary: Record<string, unknown>;
  argumentDigest: string;
  credentialIdentityId?: string;
  credentialIdentityRevision?: number;
  externalActor?: string;
  thread: SourceThread;
  requestedBy: string;
  ttlMs?: number;
  now?: Date;
}

export interface ListToolApprovalsOptions {
  status?: ToolApprovalStatus;
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  runId?: string;
  limit?: number;
  now?: Date;
}

export interface DecideToolApprovalInput {
  id: string;
  actorId: string;
  now?: Date;
}

export interface ClaimToolApprovalInput {
  id: string;
  claimedBy: string;
  expectedArgumentDigest: string;
  now?: Date;
}

export interface CompleteToolApprovalInput {
  id: string;
  claimedBy: string;
  resultPreview?: string;
  now?: Date;
}

export interface MarkToolApprovalContinuationInput {
  id: string;
  runId: string;
  now?: Date;
}

export interface FailToolApprovalInput {
  id: string;
  claimedBy: string;
  error: string;
  now?: Date;
}

export interface RecoverStaleToolApprovalsInput {
  olderThanMs?: number;
  limit?: number;
  now?: Date;
}

export interface RecoverStaleToolApprovalsResult {
  failed: number;
  records: ToolApprovalRecord[];
}

export interface ToolApprovalStore {
  proposeToolApproval(input: ProposeToolApprovalInput): Promise<ToolApprovalRecord>;
  getToolApproval(id: string, now?: Date): Promise<ToolApprovalRecord | undefined>;
  listToolApprovals(options?: ListToolApprovalsOptions): Promise<ToolApprovalRecord[]>;
  approveToolApproval(input: DecideToolApprovalInput): Promise<ToolApprovalRecord>;
  rejectToolApproval(input: DecideToolApprovalInput): Promise<ToolApprovalRecord>;
  claimToolApproval(input: ClaimToolApprovalInput): Promise<ToolApprovalRecord | undefined>;
  completeToolApproval(input: CompleteToolApprovalInput): Promise<ToolApprovalRecord>;
  markToolApprovalContinuationScheduled(
    input: MarkToolApprovalContinuationInput,
  ): Promise<ToolApprovalRecord>;
  failToolApproval(input: FailToolApprovalInput): Promise<ToolApprovalRecord>;
  recoverStaleToolApprovals(
    input?: RecoverStaleToolApprovalsInput,
  ): Promise<RecoverStaleToolApprovalsResult>;
}

export interface ToolCallAudit {
  id: string;
  name: string;
  title: string;
  grantKind: ToolGrantKind;
  risk: ToolCallRisk;
  source?: 'broker' | 'provider-native';
  provider?: string;
  destination?: string;
  agentIdentityId?: string;
  credentialIdentityId?: string;
  credentialIdentityRevision?: number;
  externalActor?: string;
  arguments?: Record<string, unknown>;
}

export interface ToolResultAudit extends ToolCallAudit {
  status: ToolCallStatus;
  durationMs: number;
  resultPreview?: string;
  error?: string;
}

export type AgentRunEvent =
  | { type: 'progress'; item: ChecklistItem; message?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'memory_proposal'; proposal: MemoryProposal }
  | {
      type: 'memory_retrieval';
      strategy: RuntimeMemoryRetrievalStrategy;
      candidateLines: number;
      selectedLines: number;
      durationMs: number;
      fallbackReason?: string;
    }
  | { type: 'tool_call'; call: ToolCallAudit }
  | { type: 'tool_approval'; approval: ToolApprovalRecord }
  | { type: 'tool_result'; call: ToolResultAudit }
  | {
      type: 'delegation';
      invocationId: string;
      agentId: string;
      executorId: string;
      status: 'running' | 'completed' | 'failed';
      taskPreview?: string;
      summaryPreview?: string;
      usage?: AgentRunUsage;
    }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export interface AgentRunUsage {
  runs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentRunRequest {
  runId: string;
  workspace?: Workspace;
  project?: Project;
  thread: SourceThread;
  message: SourceMessage;
  identity: AgentIdentity;
  access: AccessBundle;
  skills?: AgentSkillSummary[];
  delegatedAgents?: DelegatedAgentSummary[];
  knowledgeSources?: KnowledgeSourceSummary[];
  delegation?: DelegatedAgentInvocation;
  memory: string;
  memorySnapshot?: ScopedMemorySnapshot;
  transcript?: ThreadTranscriptSnapshot;
  providerSession?: ProviderSessionContext;
  steering?: AgentSteeringChannel;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  purpose?:
    | 'agent'
    | 'memory_analysis'
    | 'memory_query'
    | 'memory_retrieval'
    | 'memory_wrapup'
    | 'knowledge_enrichment';
}

export interface AgentMemorySelection {
  documentKey: string;
  version: number;
  lineNumber: number;
  reason?: string;
  confidence?: number;
}

export type AgentMemoryCandidateScope =
  | 'workspace'
  | 'project'
  | 'channel'
  | 'thread';

export interface AgentMemoryCandidate {
  scope: AgentMemoryCandidateScope;
  text: string;
  reason?: string;
}

export type AgentMemoryDecisionOperation =
  | 'remember'
  | 'replace'
  | 'merge'
  | 'forget'
  | 'index'
  | 'skip';

export interface AgentMemoryDecision {
  operation: AgentMemoryDecisionOperation;
  scope: AgentMemoryCandidateScope;
  text?: string;
  selector?: string;
  selectors?: string[];
  expectedDocumentVersion?: number;
  reason?: string;
  confidence?: number;
  aliases?: string[];
}

export interface AgentRunResult {
  summary: string;
  artifacts: Artifact[];
  memoryCandidates?: AgentMemoryCandidate[];
  memoryDecisions?: AgentMemoryDecision[];
  memorySelections?: AgentMemorySelection[];
  knowledgePassages?: KnowledgePassageCandidate[];
  memoryProposals?: MemoryProposal[];
  usage?: AgentRunUsage;
}

export type ExecutorSteeringMode = 'live' | 'next_turn';

export interface ExecutorCapabilities {
  steering: ExecutorSteeringMode;
  providerSessions: boolean;
  transcriptFallback: boolean;
  brokeredTools: boolean;
  nativeTools: boolean;
  inputAttachments: boolean;
  managedArtifacts: boolean;
  automaticMemoryCandidates: boolean;
  contextRecovery: boolean;
  nativeCompaction: boolean;
}

export interface ExecutorDescriptor {
  id: string;
  label: string;
  provider: string;
  mode: string;
  model?: string;
  status: 'ready' | 'dry-run' | 'unavailable';
  capabilities: ExecutorCapabilities;
}

export interface AgentSteeringInput {
  id: string;
  targetRunId: string;
  receivedAt: string;
  thread: SourceThread;
  message: SourceMessage;
}

export interface AgentSteeringChannel {
  mode: ExecutorSteeringMode;
  receive(options?: {
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<AgentSteeringInput | undefined>;
  acknowledge(id: string, detail?: string): Promise<void>;
}

export interface AgentSteeringProvider {
  open(mode: ExecutorSteeringMode): Promise<AgentSteeringChannel>;
}

export interface ProviderSessionContext {
  providerId: string;
  namespace: string;
  sessionId?: string;
  resumedFromRunId?: string;
  record(sessionId: string): Promise<void>;
  invalidate(reason: string): Promise<void>;
}

export interface Executor {
  id: string;
  label: string;
  steeringMode?: ExecutorSteeringMode;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface ExecutorRegistration {
  descriptor: ExecutorDescriptor;
  executor: Executor;
}

export interface ExecutorRegistry {
  readonly defaultExecutorId: string;
  get(id: string): Executor | undefined;
  has(id: string): boolean;
  describe(id: string): ExecutorDescriptor | undefined;
  list(): ExecutorDescriptor[];
  toRecord(): Record<string, Executor>;
}

export interface PlatformCapabilities {
  supportsThreads: boolean;
  supportsCards: boolean;
  supportsFiles: boolean;
  supportsReactions: boolean;
  supportsMentions: boolean;
}

export interface PlatformAdapter {
  kind: PlatformKind;
  capabilities: PlatformCapabilities;
  /**
   * Show or clear the platform-native "working on it" acknowledgement for an
   * inbound message. This is deliberately best-effort UI feedback: callers
   * must not make run delivery depend on it succeeding.
   */
  setMessageProcessingReaction?(
    messageId: string,
    active: boolean,
  ): Promise<void>;
  createProgressSurface(thread: SourceThread): ProgressSurface;
  /**
   * Publish a platform-native card for a control/status surface. Callers must
   * fall back to sendMessage when the adapter does not support rich cards.
   */
  sendCard?(
    thread: SourceThread,
    card: Record<string, unknown>,
    options?: {
      runId?: string;
      replyToMessageId?: string;
      stage?: 'thread-status-card';
    },
  ): Promise<{ cardId: string }>;
  sendMessage(
    thread: SourceThread,
    text: string,
    artifacts?: Artifact[],
    options?: {
      runId?: string;
      replyToMessageId?: string;
      stage?: 'thread-reply' | 'routine-notification';
      notificationId?: string;
    },
  ): Promise<void>;
}

export interface MemoryStore {
  loadThreadMemory(thread: SourceThread): Promise<string>;
  loadMemory?(query: MemoryQuery): Promise<ScopedMemorySnapshot>;
  remember(thread: SourceThread, text: string): Promise<void>;
  rememberScoped?(request: MemoryWriteRequest): Promise<void>;
  forget(thread: SourceThread, selector: string): Promise<void>;
  forgetScoped?(request: MemoryForgetRequest): Promise<void>;
  getMemoryHistory?(query: MemoryHistoryQuery): Promise<MemoryHistory>;
  restoreScoped?(request: MemoryRestoreRequest): Promise<MemoryDocument>;
  exportMemory?(query?: MemoryExportQuery): Promise<MemoryExport>;
  diffMemory?(query: MemoryDiffQuery): Promise<MemoryDiff>;
  compactMemory?(query?: MemoryCompactionQuery): Promise<MemoryCompactionResult>;
  searchMemory?(query: MemorySearchQuery): Promise<MemorySearchResult>;
  listMemorySemanticIndex?(
    query: MemorySemanticIndexQuery,
  ): Promise<MemorySemanticIndexEntry[]>;
  getMemoryExpiry?(
    query: MemoryExpiryQuery,
  ): Promise<MemoryExpirySnapshot>;
  setMemoryExpiry?(
    input: MemoryExpiryUpdateInput,
  ): Promise<MemoryExpirySnapshot>;
  proposeMemory?(input: MemoryProposalInput): Promise<MemoryProposal>;
  listMemoryProposals?(
    query?: MemoryProposalListQuery,
  ): Promise<MemoryProposal[]>;
  getMemoryProposal?(id: string): Promise<MemoryProposal | undefined>;
  approveMemoryProposal?(
    input: MemoryProposalDecisionInput,
  ): Promise<MemoryProposal>;
  rejectMemoryProposal?(
    input: MemoryProposalDecisionInput,
  ): Promise<MemoryProposal>;
}

export interface ThreadConfigContext {
  workspace?: Workspace;
  project?: Project;
}

export interface ThreadConfigStore {
  getWorkspace?(thread: SourceThread): Promise<Workspace>;
  getProject?(thread: SourceThread, workspace?: Workspace): Promise<Project>;
  getIdentity(thread: SourceThread): Promise<AgentIdentity>;
  getAccessBundle(
    thread: SourceThread,
    context?: ThreadConfigContext,
  ): Promise<AccessBundle>;
}

export interface RuntimeDependencies {
  platform: PlatformAdapter;
  executor: Executor;
  executors?: Record<string, Executor>;
  executorRegistry?: ExecutorRegistry;
  memory: MemoryStore;
  memoryRetriever?: RuntimeMemoryRetriever;
  skills?: AgentSkillSource;
  delegatedAgents?: DelegatedAgentSource;
  knowledgeSources?: KnowledgeSourceStore;
  threadConfig: ThreadConfigStore;
  clock?: () => Date;
}

export interface RuntimeMemoryRetrievalInput {
  runId: string;
  workspace?: Workspace;
  project?: Project;
  thread: SourceThread;
  message: SourceMessage;
  access: AccessBundle;
  memorySnapshot: ScopedMemorySnapshot;
  transcript?: ThreadTranscriptSnapshot;
  abortSignal?: AbortSignal;
}

export type RuntimeMemoryRetrievalStrategy =
  | 'semantic'
  | 'indexed'
  | 'lexical'
  | 'recent'
  | 'empty';

export interface RuntimeMemoryRetrievalResult {
  snapshot: ScopedMemorySnapshot;
  strategy: RuntimeMemoryRetrievalStrategy;
  candidateLines: number;
  selectedLines: number;
  fallbackReason?: string;
  durationMs: number;
}

export interface RuntimeMemoryRetriever {
  retrieve(
    input: RuntimeMemoryRetrievalInput,
  ): Promise<RuntimeMemoryRetrievalResult>;
}
