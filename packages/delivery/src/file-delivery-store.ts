import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ClaimToolApprovalInput,
  CompleteToolApprovalInput,
  DecideToolApprovalInput,
  FailToolApprovalInput,
  ListToolApprovalsOptions,
  MarkToolApprovalContinuationInput,
  ProposeToolApprovalInput,
  RecoverStaleToolApprovalsInput,
  RecoverStaleToolApprovalsResult,
  SourceMessage,
  SourceThread,
  ToolApprovalRecord,
  UsageBudgetPolicy,
} from '@opentag/core';
import type {
  AgentRunEventType,
  AgentRunRecord,
  AgentRunSteeringRecord,
  AgentRunSteeringStatus,
  AgentRunStatus,
  AgentRunTimelineEvent,
  AgentRunUsageRecord,
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
  ListAgentRunEventsOptions,
  LoadThreadTranscriptOptions,
  LoadedThreadTranscript,
  OutboxScopeFilter,
  OutboundEnvelope,
  OutboundStatus,
  RecordInboundEventInput,
  RecordInboundEventResult,
  RecordAgentThreadSessionInput,
  RecordThreadContextSyncInput,
  RecordAgentRunUsageInput,
  ReconcileUsageBudgetAlertsInput,
  RecoverStaleOutboxOptions,
  RecoverStaleOutboxResult,
  RecoverStaleAgentRunsOptions,
  RecoverStaleAgentRunsResult,
  RequeueAgentRunOptions,
  RenewAgentRunLeaseOptions,
  MarkAgentRunRunningOptions,
  ClaimMemoryWrapupsOptions,
  CompleteMemoryWrapupInput,
  EnqueueMemoryWrapupInput,
  ListMemoryWrapupsOptions,
  MemoryWrapupCursorRecord,
  MemoryWrapupJobRecord,
  PruneMemoryWrapupsOptions,
  PruneMemoryWrapupsResult,
  RetryMemoryWrapupInput,
  ListThreadBindingAuditOptions,
  RemoveThreadBindingOptions,
  ThreadBinding,
  ThreadBindingAuditRecord,
  ThreadBindingScope,
  ThreadContextSyncRecord,
  TurnDeliveryRecord,
  TurnDeliveryStatus,
  ListAgentRunsOptions,
  CancelThreadAgentRunsResult,
  UpsertThreadBindingInput,
  SourceThreadMessageRecord,
  ScopedAgentRunTimelineEvent,
  UpsertSourceThreadMessagesInput,
  UpsertSourceThreadMessagesResult,
  UsageBudgetCheckInput,
  UsageBudgetCheckResult,
  UsageBudgetAlert,
  UsageBudgetAlertMetric,
  UsageBudgetAlertThreshold,
  UsageBudgetLine,
  UsageBudgetScope,
  UsageQuantity,
  AgentUsagePurpose,
  UsagePurposeLine,
  UsageSnapshot,
  DataLifecycleAuditRecord,
  ListDataLifecycleAuditOptions,
  WorkspaceDataLifecycleCounts,
  WorkspaceDataLifecycleOptions,
  WorkspaceDataLifecyclePreserved,
  WorkspaceDataLifecycleResult,
} from './types.js';

const EMPTY_STATE: FileDeliveryState = {
  nextSequence: 1,
  nextSteeringSequence: 1,
  nextAgentRunEventSequence: 1,
  outbox: [],
  turnDeliveries: [],
  threadBindings: [],
  inboundEvents: [],
  agentRuns: [],
  agentRunEvents: [],
  agentRunSteering: [],
  agentThreadSessions: [],
  sourceThreadMessages: [],
  threadContextSyncs: [],
  usageRecords: [],
  usageAlerts: [],
  threadBindingAudit: [],
  memoryWrapupJobs: [],
  memoryWrapupCursors: [],
  toolApprovals: [],
  dataLifecycleAudit: [],
};

const SOURCE_THREAD_CONTEXT_MAX_PER_THREAD = 200;
const SOURCE_THREAD_CONTEXT_MAX_GLOBAL = 20_000;
const INBOUND_EVENT_MAX_RECORDS = 50_000;

function now(): string {
  return new Date().toISOString();
}

function cloneToolApproval(record: ToolApprovalRecord): ToolApprovalRecord {
  return {
    ...record,
    arguments: structuredClone(record.arguments),
    argumentSummary: structuredClone(record.argumentSummary),
    thread: structuredClone(record.thread),
  };
}

function expireToolApprovals(
  state: FileDeliveryState,
  timestamp: string,
): void {
  for (const approval of state.toolApprovals) {
    if (
      (approval.status === 'pending' || approval.status === 'approved') &&
      approval.expiresAt <= timestamp
    ) {
      approval.status = 'expired';
      approval.error = 'tool_approval_expired';
    }
  }
}

export function createEmptyDeliveryState(): FileDeliveryState {
  return {
    nextSequence: EMPTY_STATE.nextSequence,
    nextSteeringSequence: EMPTY_STATE.nextSteeringSequence,
    nextAgentRunEventSequence: EMPTY_STATE.nextAgentRunEventSequence,
    outbox: [],
    turnDeliveries: [],
    threadBindings: [],
    inboundEvents: [],
    agentRuns: [],
    agentRunEvents: [],
    agentRunSteering: [],
    agentThreadSessions: [],
    sourceThreadMessages: [],
    threadContextSyncs: [],
    usageRecords: [],
    usageAlerts: [],
    threadBindingAudit: [],
    memoryWrapupJobs: [],
    memoryWrapupCursors: [],
    toolApprovals: [],
    dataLifecycleAudit: [],
  };
}

export function normalizeDeliveryState(
  parsed: Partial<FileDeliveryState>,
): FileDeliveryState {
  let previousAgentRunEventSequence = 0;
  const agentRunEvents = (parsed.agentRunEvents ?? []).map((event) => {
    const sequence =
      Number.isSafeInteger(event.sequence) &&
      event.sequence > previousAgentRunEventSequence
        ? event.sequence
        : previousAgentRunEventSequence + 1;
    previousAgentRunEventSequence = sequence;
    return { ...event, sequence };
  });
  const highestAgentRunEventSequence = agentRunEvents.reduce(
    (highest, event) => Math.max(highest, event.sequence),
    0,
  );
  return {
    nextSequence: parsed.nextSequence ?? 1,
    nextSteeringSequence: parsed.nextSteeringSequence ?? 1,
    nextAgentRunEventSequence: Math.max(
      parsed.nextAgentRunEventSequence ?? 1,
      highestAgentRunEventSequence + 1,
    ),
    outbox: parsed.outbox ?? [],
    turnDeliveries: parsed.turnDeliveries ?? [],
    threadBindings: parsed.threadBindings ?? [],
    inboundEvents: parsed.inboundEvents ?? [],
    agentRuns: parsed.agentRuns ?? [],
    agentRunEvents,
    agentRunSteering: parsed.agentRunSteering ?? [],
    agentThreadSessions: parsed.agentThreadSessions ?? [],
    sourceThreadMessages: parsed.sourceThreadMessages ?? [],
    threadContextSyncs: parsed.threadContextSyncs ?? [],
    usageRecords: parsed.usageRecords ?? [],
    usageAlerts: parsed.usageAlerts ?? [],
    threadBindingAudit: parsed.threadBindingAudit ?? [],
    memoryWrapupJobs: parsed.memoryWrapupJobs ?? [],
    memoryWrapupCursors: parsed.memoryWrapupCursors ?? [],
    toolApprovals: parsed.toolApprovals ?? [],
    dataLifecycleAudit: parsed.dataLifecycleAudit ?? [],
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
    const before = copyBinding(existing);
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
    appendBindingAudit(state, {
      action: 'binding.updated',
      binding: existing,
      before,
      after: existing,
      actor: input.actor,
      reason: input.reason,
      at: timestamp,
    });
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
  appendBindingAudit(state, {
    action: 'binding.created',
    binding,
    after: binding,
    actor: input.actor,
    reason: input.reason,
    at: timestamp,
  });
  return copyBinding(binding);
}

function copyBinding(binding: ThreadBinding): ThreadBinding {
  return {
    ...binding,
    metadata: binding.metadata ? { ...binding.metadata } : undefined,
  };
}

function copyBindingAudit(record: ThreadBindingAuditRecord): ThreadBindingAuditRecord {
  return {
    ...record,
    before: record.before ? copyBinding(record.before) : undefined,
    after: record.after ? copyBinding(record.after) : undefined,
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}

function appendBindingAudit(
  state: FileDeliveryState,
  input: {
    action: ThreadBindingAuditRecord['action'];
    binding: ThreadBinding;
    before?: ThreadBinding;
    after?: ThreadBinding;
    actor?: string;
    reason?: string;
    at: string;
  },
): void {
  state.threadBindingAudit.push({
    id: randomUUID(),
    action: input.action,
    bindingId: input.binding.id,
    platform: input.binding.platform,
    externalId: input.binding.externalId,
    scope: input.binding.scope,
    source: input.binding.source,
    channelId: input.binding.channelId,
    workspaceId: input.binding.workspaceId,
    projectId: input.binding.projectId,
    actor: input.actor,
    reason: input.reason,
    at: input.at,
    before: input.before ? copyBinding(input.before) : undefined,
    after: input.after ? copyBinding(input.after) : undefined,
    metadata: input.binding.metadata ? { ...input.binding.metadata } : undefined,
  });
  if (state.threadBindingAudit.length > 2_000) {
    state.threadBindingAudit.splice(0, state.threadBindingAudit.length - 2_000);
  }
}

function copySourceMessage(message: SourceMessage): SourceMessage {
  return {
    ...message,
    actor: { ...message.actor },
    attachments: message.attachments?.map((attachment) => ({
      ...attachment,
      metadata: attachment.metadata ? { ...attachment.metadata } : undefined,
    })),
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

function transcriptTextForMessage(message: SourceMessage): string {
  const attachmentText = message.attachments
    ?.map((attachment) =>
      [attachment.kind, attachment.name, attachment.localPath || attachment.url]
        .filter(Boolean)
        .join(': '),
    )
    .filter(Boolean);
  return [
    message.text || '(no text)',
    attachmentText?.length ? `Attachments:\n${attachmentText.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function copySourceThreadMessage(
  record: SourceThreadMessageRecord,
): SourceThreadMessageRecord {
  return { ...record, message: copySourceMessage(record.message) };
}

function copyThreadContextSync(
  record: ThreadContextSyncRecord,
): ThreadContextSyncRecord {
  return {
    ...record,
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}

function copyUsageRecord(record: AgentRunUsageRecord): AgentRunUsageRecord {
  return {
    ...record,
    purpose: usagePurpose(record),
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}

function copyUsageAlert(alert: UsageBudgetAlert): UsageBudgetAlert {
  return { ...alert };
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
    message: run.message ? copySourceMessage(run.message) : undefined,
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
    message: copySourceMessage(steering.message),
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

function threadScopeKey(thread: SourceThread): string {
  return JSON.stringify([
    thread.platform,
    thread.workspaceId || '',
    thread.projectId || '',
    thread.id,
  ]);
}

function sourceThreadMessageId(
  thread: SourceThread,
  messageId: string,
): string {
  return `source-message:${createHash('sha256')
    .update(`${threadScopeKey(thread)}:${messageId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function threadContextSyncId(thread: SourceThread, source: string): string {
  return `thread-context-sync:${createHash('sha256')
    .update(`${threadScopeKey(thread)}:${source}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function usageRecordId(
  runId: string,
  period: string,
  recordKey?: string,
): string {
  return `usage:${createHash('sha256')
    .update(
      recordKey && recordKey !== 'agent'
        ? `${runId}:${recordKey}:${period}`
        : `${runId}:${period}`,
    )
    .digest('hex')
    .slice(0, 32)}`;
}

function usagePurpose(
  record: Pick<AgentRunUsageRecord, 'source' | 'purpose'> & {
    metadata?: Record<string, unknown>;
  },
): AgentUsagePurpose {
  const candidate = record.purpose ?? record.metadata?.purpose;
  if (
    candidate === 'delegation' ||
    candidate === 'memory_retrieval' ||
    candidate === 'memory_query' ||
    candidate === 'memory_analysis' ||
    candidate === 'memory_wrapup'
  ) {
    return candidate;
  }
  return 'agent';
}

function usagePurposeTotals(records: AgentRunUsageRecord[]): UsagePurposeLine[] {
  const totals = new Map<AgentUsagePurpose, UsagePurposeLine>();
  for (const record of records) {
    const purpose = usagePurpose(record);
    const line = totals.get(purpose) ?? {
      purpose,
      calls: 0,
      runs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      costReportedCalls: 0,
      tokenReportedCalls: 0,
    };
    line.calls += 1;
    line.runs += record.runs;
    line.costUsd += record.costUsd;
    if (record.metadata?.costReported === true) line.costReportedCalls += 1;
    const inputTokens = record.metadata?.inputTokens;
    const outputTokens = record.metadata?.outputTokens;
    if (typeof inputTokens === 'number') line.inputTokens += inputTokens;
    if (typeof outputTokens === 'number') line.outputTokens += outputTokens;
    if (typeof inputTokens === 'number' || typeof outputTokens === 'number') {
      line.tokenReportedCalls += 1;
    }
    totals.set(purpose, line);
  }
  const order: AgentUsagePurpose[] = [
    'agent',
    'delegation',
    'memory_retrieval',
    'memory_query',
    'memory_analysis',
    'memory_wrapup',
  ];
  return order.flatMap((purpose) => {
    const line = totals.get(purpose);
    return line ? [line] : [];
  });
}

function usagePeriod(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function usageQuantity(input?: Partial<UsageQuantity>): UsageQuantity {
  return {
    runs: Math.max(0, input?.runs ?? 1),
    costUsd: Math.max(0, input?.costUsd ?? 0),
  };
}

function usageScopeKeys(thread: SourceThread): UsageBudgetLine[] {
  return [
    {
      scope: 'workspace',
      workspaceId: thread.workspaceId,
      period: '',
      runs: 0,
      costUsd: 0,
    },
    {
      scope: 'project',
      workspaceId: thread.workspaceId,
      projectId: thread.projectId,
      period: '',
      runs: 0,
      costUsd: 0,
    },
    {
      scope: 'channel',
      workspaceId: thread.workspaceId,
      projectId: thread.projectId,
      channelId: thread.channelId || thread.externalId,
      period: '',
      runs: 0,
      costUsd: 0,
    },
    {
      scope: 'thread',
      workspaceId: thread.workspaceId,
      projectId: thread.projectId,
      threadId: thread.id,
      period: '',
      runs: 0,
      costUsd: 0,
    },
  ];
}

function sameUsageLine(record: AgentRunUsageRecord, line: UsageBudgetLine): boolean {
  if (record.period !== line.period) return false;
  if (line.scope === 'workspace') return record.workspaceId === line.workspaceId;
  if (line.scope === 'project') {
    return (
      record.workspaceId === line.workspaceId &&
      record.projectId === line.projectId
    );
  }
  if (line.scope === 'channel') {
    return (
      record.workspaceId === line.workspaceId &&
      record.projectId === line.projectId &&
      record.channelId === line.channelId
    );
  }
  return (
    record.workspaceId === line.workspaceId &&
    record.projectId === line.projectId &&
    record.threadId === line.threadId
  );
}

function usageTotalsForThread(
  records: AgentRunUsageRecord[],
  thread: SourceThread,
  period: string,
): UsageBudgetLine[] {
  return usageScopeKeys(thread).map((scope) => {
    const line: UsageBudgetLine = { ...scope, period };
    for (const record of records) {
      if (!sameUsageLine(record, line)) continue;
      line.runs += record.runs;
      line.costUsd += record.costUsd;
    }
    return line;
  });
}

function projectUsageLine(
  lines: UsageBudgetLine[],
  scope: UsageBudgetScope = 'project',
): UsageBudgetLine | undefined {
  return lines.find((line) => line.scope === scope);
}

function activeUsageBudgetPolicies(
  input: UsageBudgetCheckInput,
): UsageBudgetPolicy[] {
  const policies = input.policies?.length
    ? input.policies
    : input.policy
      ? [input.policy]
      : [];
  return policies.filter(
    (policy) => policy.mode !== 'disabled' && policy.mode !== 'inherit',
  );
}

function usageAlertId(input: {
  line: UsageBudgetLine;
  metric: UsageBudgetAlertMetric;
  thresholdPercent: UsageBudgetAlertThreshold;
}): string {
  return `usage-alert:${createHash('sha256')
    .update(
      JSON.stringify([
        input.line.period,
        input.line.scope,
        input.line.workspaceId,
        input.line.projectId,
        input.line.channelId,
        input.line.threadId,
        input.metric,
        input.thresholdPercent,
      ]),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

function reconcileUsageAlertsInState(
  state: FileDeliveryState,
  input: {
    runId: string;
    thread: SourceThread;
    policies?: UsageBudgetPolicy[];
    period: string;
    triggeredAt: string;
  },
): UsageBudgetAlert[] {
  const totals = usageTotalsForThread(state.usageRecords, input.thread, input.period);
  const created: UsageBudgetAlert[] = [];
  for (const policy of input.policies ?? []) {
    if (policy.mode === 'disabled' || policy.mode === 'inherit') continue;
    const line = projectUsageLine(totals, policy.scope ?? 'project');
    if (!line) continue;
    const metrics: Array<{
      metric: UsageBudgetAlertMetric;
      current: number;
      limit: number | undefined;
    }> = [
      { metric: 'runs', current: line.runs, limit: policy.maxRunsPerMonth },
      { metric: 'cost', current: line.costUsd, limit: policy.maxCostUsdPerMonth },
    ];
    for (const metric of metrics) {
      if (typeof metric.limit !== 'number' || metric.limit <= 0) continue;
      const ratio = metric.current / metric.limit;
      for (const thresholdPercent of [75, 95] as const) {
        if (ratio < thresholdPercent / 100) continue;
        const id = usageAlertId({ line, metric: metric.metric, thresholdPercent });
        if (state.usageAlerts.some((alert) => alert.id === id)) continue;
        const alert: UsageBudgetAlert = {
          id,
          runId: input.runId,
          period: input.period,
          metric: metric.metric,
          thresholdPercent,
          scope: line.scope,
          workspaceId: line.workspaceId,
          projectId: line.projectId,
          channelId: line.channelId,
          threadId: line.threadId,
          current: metric.current,
          limit: metric.limit,
          ratio,
          triggeredAt: input.triggeredAt,
        };
        state.usageAlerts.push(alert);
        created.push(alert);
      }
    }
  }
  return created;
}

function sameSourceThreadScope(
  record: Pick<
    SourceThreadMessageRecord,
    'platform' | 'threadId' | 'workspaceId' | 'projectId'
  >,
  thread: SourceThread,
): boolean {
  return (
    record.platform === thread.platform &&
    record.threadId === thread.id &&
    record.workspaceId === thread.workspaceId &&
    record.projectId === thread.projectId
  );
}

function trimSourceThreadMessages(
  state: FileDeliveryState,
  thread: SourceThread,
): void {
  const sortedForThread = state.sourceThreadMessages
    .filter((record) => sameSourceThreadScope(record, thread))
    .sort(
      (a, b) =>
        b.message.createdAt.localeCompare(a.message.createdAt) ||
        b.lastObservedAt.localeCompare(a.lastObservedAt),
    );
  const keepForThread = new Set(
    sortedForThread
      .slice(0, SOURCE_THREAD_CONTEXT_MAX_PER_THREAD)
      .map((record) => record.id),
  );
  state.sourceThreadMessages = state.sourceThreadMessages.filter(
    (record) => !sameSourceThreadScope(record, thread) || keepForThread.has(record.id),
  );
  if (state.sourceThreadMessages.length <= SOURCE_THREAD_CONTEXT_MAX_GLOBAL) {
    return;
  }
  const keepGlobal = new Set(
    [...state.sourceThreadMessages]
      .sort(
        (a, b) =>
          b.lastObservedAt.localeCompare(a.lastObservedAt) ||
          b.message.createdAt.localeCompare(a.message.createdAt),
      )
      .slice(0, SOURCE_THREAD_CONTEXT_MAX_GLOBAL)
      .map((record) => record.id),
  );
  state.sourceThreadMessages = state.sourceThreadMessages.filter((record) =>
    keepGlobal.has(record.id),
  );
}

function trimUsageRecords(state: FileDeliveryState): void {
  const keep = new Set(
    [...state.usageRecords]
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, 50_000)
      .map((record) => record.id),
  );
  state.usageRecords = state.usageRecords.filter((record) =>
    keep.has(record.id),
  );
  state.usageAlerts = [...state.usageAlerts]
    .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
    .slice(0, 10_000);
}

export function trimInboundEventState(
  state: FileDeliveryState,
  maxRecords = INBOUND_EVENT_MAX_RECORDS,
): void {
  const active = state.inboundEvents.filter(
    (event) => event.status === 'received',
  );
  const terminalLimit = Math.max(0, maxRecords - active.length);
  const keepTerminal = new Set(
    state.inboundEvents
      .filter((event) => event.status !== 'received')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, terminalLimit)
      .map((event) => event.id),
  );
  state.inboundEvents = state.inboundEvents.filter(
    (event) => event.status === 'received' || keepTerminal.has(event.id),
  );
}

function transcriptEntryOrder(
  source: LoadedThreadTranscript['entries'][number]['source'],
  role: LoadedThreadTranscript['entries'][number]['role'],
): number {
  if (role === 'assistant') return 3;
  if (source === 'source_message') return 0;
  if (source === 'run') return 1;
  return 2;
}

function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function emptyLifecycleCounts(): WorkspaceDataLifecycleCounts {
  return {
    agentRuns: 0,
    agentRunEvents: 0,
    outbox: 0,
    turnDeliveries: 0,
    steering: 0,
    invalidatedSessions: 0,
    memoryWrapups: 0,
    toolApprovals: 0,
  };
}

function workspaceDataLifecyclePlan(
  state: FileDeliveryState,
  options: WorkspaceDataLifecycleOptions,
): { result: WorkspaceDataLifecycleResult; runIds: Set<string> } {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId || workspaceId.length > 160) {
    throw new Error('workspace_data_lifecycle_workspace_invalid');
  }
  const retentionDays = Math.floor(options.retentionDays ?? 90);
  if (retentionDays < 1 || retentionDays > 3_650) {
    throw new Error('workspace_data_lifecycle_retention_invalid');
  }
  const keepLatestPerThread = Math.floor(options.keepLatestPerThread ?? 20);
  if (keepLatestPerThread < 1 || keepLatestPerThread > 500) {
    throw new Error('workspace_data_lifecycle_keep_latest_invalid');
  }
  const timestamp = options.now ?? new Date();
  const cutoff = new Date(
    timestamp.getTime() - retentionDays * 24 * 60 * 60_000,
  ).toISOString();
  const workspaceRuns = state.agentRuns.filter(
    (run) => run.workspaceId === workspaceId,
  );
  const terminalRuns = workspaceRuns.filter((run) => isTerminalRunStatus(run.status));
  const terminalByThread = new Map<string, AgentRunRecord[]>();
  for (const run of terminalRuns) {
    const key = `${run.platform}:${run.threadId}`;
    const runs = terminalByThread.get(key) ?? [];
    runs.push(run);
    terminalByThread.set(key, runs);
  }
  const latestRunIds = new Set<string>();
  for (const runs of terminalByThread.values()) {
    runs
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, keepLatestPerThread)
      .forEach((run) => latestRunIds.add(run.id));
  }
  const referencedRunIds = new Set(
    (options.protectedRunIds ?? []).map((runId) => runId.trim()).filter(Boolean),
  );
  for (const item of state.outbox) {
    if (item.runId && (item.status === 'pending' || item.status === 'sending')) {
      referencedRunIds.add(item.runId);
    }
  }
  for (const item of state.turnDeliveries) {
    if (item.status === 'queued' || item.status === 'accepted') {
      referencedRunIds.add(item.runId);
    }
  }
  for (const item of state.agentRunSteering) {
    if (item.status === 'pending' || item.status === 'claimed' || item.status === 'scheduled') {
      referencedRunIds.add(item.targetRunId);
      if (item.continuationRunId) referencedRunIds.add(item.continuationRunId);
    }
  }
  for (const item of state.agentThreadSessions) {
    if (item.status === 'active') {
      referencedRunIds.add(item.startedByRunId);
      referencedRunIds.add(item.lastRunId);
    }
  }
  for (const item of state.memoryWrapupJobs) {
    if (item.status === 'pending' || item.status === 'claimed') {
      referencedRunIds.add(item.sourceRunId);
    }
  }
  for (const item of state.memoryWrapupCursors) {
    referencedRunIds.add(item.sourceRunId);
  }
  for (const item of state.toolApprovals) {
    if (item.status === 'pending' || item.status === 'approved' || item.status === 'executing') {
      referencedRunIds.add(item.runId);
    }
  }
  const managedArtifactRunIds = new Set(
    state.agentRunEvents.flatMap((item) => {
      if (item.type !== 'artifact') return [];
      const artifact = item.metadata?.artifact;
      const metadata =
        artifact && typeof artifact === 'object' && !Array.isArray(artifact)
          ? (artifact as Record<string, unknown>).metadata
          : undefined;
      return metadata &&
        typeof metadata === 'object' &&
        !Array.isArray(metadata) &&
        (metadata as Record<string, unknown>).managed === true
        ? [item.runId]
        : [];
    }),
  );
  managedArtifactRunIds.forEach((runId) => referencedRunIds.add(runId));
  const oldTerminalRuns = terminalRuns.filter((run) => run.updatedAt < cutoff);
  const runIds = new Set(
    oldTerminalRuns
      .filter((run) => !latestRunIds.has(run.id) && !referencedRunIds.has(run.id))
      .map((run) => run.id),
  );
  let referenceClosureChanged: boolean;
  do {
    referenceClosureChanged = false;
    for (const item of state.agentThreadSessions) {
      if (item.status !== 'invalidated') continue;
      const startedEligible = runIds.has(item.startedByRunId);
      const lastEligible = runIds.has(item.lastRunId);
      if (startedEligible !== lastEligible) {
        referenceClosureChanged =
          runIds.delete(item.startedByRunId) || referenceClosureChanged;
        referenceClosureChanged =
          runIds.delete(item.lastRunId) || referenceClosureChanged;
      }
    }
    for (const item of state.agentRunSteering) {
      if (
        item.status === 'pending' ||
        item.status === 'claimed' ||
        item.status === 'scheduled' ||
        !item.continuationRunId
      ) continue;
      const targetEligible = runIds.has(item.targetRunId);
      const continuationEligible = runIds.has(item.continuationRunId);
      if (targetEligible !== continuationEligible) {
        referenceClosureChanged =
          runIds.delete(item.targetRunId) || referenceClosureChanged;
        referenceClosureChanged =
          runIds.delete(item.continuationRunId) || referenceClosureChanged;
      }
    }
  } while (referenceClosureChanged);
  const removed = emptyLifecycleCounts();
  removed.agentRuns = runIds.size;
  removed.agentRunEvents = state.agentRunEvents.filter((item) => runIds.has(item.runId)).length;
  removed.outbox = state.outbox.filter((item) => item.runId && runIds.has(item.runId)).length;
  removed.turnDeliveries = state.turnDeliveries.filter((item) => runIds.has(item.runId)).length;
  removed.steering = state.agentRunSteering.filter(
    (item) => runIds.has(item.targetRunId) || Boolean(item.continuationRunId && runIds.has(item.continuationRunId)),
  ).length;
  removed.invalidatedSessions = state.agentThreadSessions.filter(
    (item) =>
      item.status === 'invalidated' &&
      runIds.has(item.startedByRunId) &&
      runIds.has(item.lastRunId),
  ).length;
  removed.memoryWrapups = state.memoryWrapupJobs.filter(
    (item) => runIds.has(item.sourceRunId),
  ).length;
  removed.toolApprovals = state.toolApprovals.filter(
    (item) => runIds.has(item.runId),
  ).length;
  const preserved: WorkspaceDataLifecyclePreserved = {
    activeRuns: workspaceRuns.filter((run) => !isTerminalRunStatus(run.status)).length,
    recentTerminalRuns: terminalRuns.length - oldTerminalRuns.length +
      oldTerminalRuns.filter((run) => latestRunIds.has(run.id)).length,
    referencedTerminalRuns: oldTerminalRuns.filter(
      (run) => !latestRunIds.has(run.id) && referencedRunIds.has(run.id),
    ).length,
    inboundEvents: state.inboundEvents.filter((item) => item.workspaceId === workspaceId).length,
    usageRecords: state.usageRecords.filter((item) => item.workspaceId === workspaceId).length,
    sourceMessages: state.sourceThreadMessages.filter((item) => item.workspaceId === workspaceId).length,
    managedArtifactRuns: terminalRuns.filter((run) => managedArtifactRunIds.has(run.id)).length,
  };
  return {
    runIds,
    result: {
      dryRun: options.dryRun !== false,
      workspaceId,
      retentionDays,
      cutoff,
      keepLatestPerThread,
      scannedRuns: workspaceRuns.length,
      eligibleTerminalRuns: oldTerminalRuns.length,
      removed,
      preserved,
    },
  };
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
    toolApprovals: {
      pending: 0,
      approved: 0,
      executing: 0,
      succeeded: 0,
      failed: 0,
      rejected: 0,
      expired: 0,
    },
    workflowProducers: {
      received: 0,
      staged: 0,
      unmatched: 0,
      duplicates: 0,
      ignored: 0,
      failed: 0,
    },
    bindings: 0,
    usage: {
      records: 0,
      currentPeriodRuns: 0,
      currentPeriodCostUsd: 0,
    },
    oldestStatusUpdatedAt: {
      outbox: {},
      turnDeliveries: {},
      inboundEvents: {},
      agentRuns: {},
      steering: {},
      sessions: {},
      toolApprovals: {},
    },
  };
}

function recordOldestStatus<K extends string>(
  target: Partial<Record<K, string>>,
  status: K,
  updatedAt: string,
): void {
  const current = target[status];
  if (!current || updatedAt < current) target[status] = updatedAt;
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
      // Card updates are replaceable state snapshots, not append-only events.
      // If a transient API error left an older snapshot queued, retrying it
      // after a newer snapshot would move the visible card backwards. Keep
      // only the newest pending update for an exact card target.
      if (input.kind === 'lark.card.update' && input.target.cardId) {
        for (const previous of state.outbox) {
          if (
            previous.kind !== input.kind ||
            previous.target.platform !== input.target.platform ||
            previous.target.cardId !== input.target.cardId ||
            previous.status !== 'pending'
          ) {
            continue;
          }
          previous.status = 'cancelled';
          previous.lastError = 'superseded_by_newer_card_update';
          previous.updatedAt = timestamp;
          this.updateTurnDelivery(
            state,
            previous.id,
            'cancelled',
            previous.lastError,
          );
        }
      }
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

      const active = input.forceNewRun
        ? undefined
        : this.activeRunForThread(state, {
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
        if (threadAlreadyRunning && run.executorId !== 'thread-status') continue;
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
        run.lastError = undefined;
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

    const sourceMessageIds = new Set<string>();
    const sourceRecords = state.sourceThreadMessages
      .filter((record) => sameSourceThreadScope(record, options.thread))
      .filter((record) => !record.message.actor.isBot)
      .filter(
        (record) =>
          !excludedRun || record.message.createdAt <= excludedRun.createdAt,
      )
      .filter(
        (record) =>
          !excludedRun?.messageId || record.message.id !== excludedRun.messageId,
      )
      .sort(
        (a, b) =>
          a.message.createdAt.localeCompare(b.message.createdAt) ||
          a.firstObservedAt.localeCompare(b.firstObservedAt),
      );
    for (const record of sourceRecords) {
      sourceMessageIds.add(record.message.id);
      entries.push({
        id: `transcript:${record.id}:source`,
        role: 'user',
        text: transcriptTextForMessage(record.message),
        at: record.message.createdAt || record.firstObservedAt,
        source: 'source_message',
        actor: record.message.actor,
        messageId: record.message.id,
      });
    }

    for (const run of runs) {
      if (run.message && !sourceMessageIds.has(run.message.id)) {
        entries.push({
          id: `transcript:${run.id}:user`,
          runId: run.id,
          role: 'user',
          text: transcriptTextForMessage(run.message),
          at: run.message.createdAt || run.createdAt,
          source: 'run',
          actor: run.message.actor,
          messageId: run.message.id,
        });
      }
      for (const steering of (liveSteeringByRun.get(run.id) ?? []).sort(
        (a, b) => a.sequence - b.sequence,
      )) {
        if (sourceMessageIds.has(steering.message.id)) continue;
        entries.push({
          id: `transcript:${steering.id}:live`,
          runId: steering.targetRunId,
          role: 'user',
          text: transcriptTextForMessage(steering.message),
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
                : 'MaxTag',
            isBot: true,
          },
        });
      }
    }
    entries.sort(
      (a, b) =>
        a.at.localeCompare(b.at) ||
        transcriptEntryOrder(a.source, a.role) -
          transcriptEntryOrder(b.source, b.role) ||
        a.id.localeCompare(b.id),
    );
    const afterCursor = options.afterCursor;
    const cursorIndex = afterCursor
      ? entries.findIndex(
          (entry) =>
            entry.at === afterCursor.at && entry.id === afterCursor.entryId,
        )
      : -1;
    const incremental = !afterCursor
      ? entries
      : cursorIndex >= 0
        ? entries.slice(cursorIndex + 1)
        : entries.filter(
            (entry) =>
              entry.at > afterCursor.at ||
              (entry.at === afterCursor.at && entry.id > afterCursor.entryId),
          );
    let truncated = false;
    const bounded = incremental.map((entry) => {
      if (entry.text.length <= 12_000) return entry;
      truncated = true;
      return { ...entry, text: `${entry.text.slice(0, 12_000)}\n[truncated]` };
    });
    const selected: LoadedThreadTranscript['entries'] = [];
    let chars = 0;
    const oldestFirst = options.order === 'oldest';
    const indexes = oldestFirst
      ? bounded.map((_, index) => index)
      : bounded.map((_, index) => bounded.length - index - 1);
    for (const index of indexes) {
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
    if (!oldestFirst) selected.reverse();
    const omittedEntries = incremental.length - selected.length;
    const lastEntry = selected.at(-1);
    return {
      threadId: options.thread.id,
      loadedAt: now(),
      entries: selected,
      totalEntries: incremental.length,
      omittedEntries,
      truncated: truncated || omittedEntries > 0,
      nextCursor: lastEntry
        ? { at: lastEntry.at, entryId: lastEntry.id }
        : afterCursor,
    };
  }

  async enqueueMemoryWrapup(
    input: EnqueueMemoryWrapupInput,
  ): Promise<MemoryWrapupJobRecord> {
    return this.mutate((state) => {
      const timestamp = input.now ?? new Date();
      const availableAt = new Date(
        timestamp.getTime() + Math.max(0, input.debounceMs ?? 15_000),
      ).toISOString();
      const existing = state.memoryWrapupJobs.find(
        (job) =>
          job.platform === input.thread.platform &&
          job.threadId === input.thread.id &&
          job.workspaceId === input.thread.workspaceId &&
          job.projectId === input.thread.projectId &&
          job.status === 'pending',
      );
      if (existing) {
        const existingRun = state.agentRuns.find(
          (run) => run.id === existing.sourceRunId,
        );
        const candidateRun = state.agentRuns.find(
          (run) => run.id === input.sourceRunId,
        );
        if (
          !existingRun ||
          !candidateRun ||
          candidateRun.createdAt >= existingRun.createdAt
        ) {
          existing.sourceRunId = input.sourceRunId;
        }
        existing.thread = { ...input.thread };
        existing.updatedAt = timestamp.toISOString();
        if (existing.status === 'pending') existing.availableAt = availableAt;
        return structuredClone(existing);
      }
      const cursor = state.memoryWrapupCursors.find(
        (item) =>
          item.platform === input.thread.platform &&
          item.threadId === input.thread.id &&
          item.workspaceId === input.thread.workspaceId &&
          item.projectId === input.thread.projectId,
      );
      const job: MemoryWrapupJobRecord = {
        id: randomUUID(),
        status: 'pending',
        platform: input.thread.platform,
        thread: { ...input.thread },
        threadId: input.thread.id,
        workspaceId: input.thread.workspaceId,
        projectId: input.thread.projectId,
        sourceRunId: input.sourceRunId,
        attempts: 0,
        maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 5, 20)),
        availableAt,
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString(),
        cursor: cursor ? structuredClone(cursor) : undefined,
      };
      state.memoryWrapupJobs.push(job);
      return structuredClone(job);
    });
  }

  async claimMemoryWrapups(
    options: ClaimMemoryWrapupsOptions,
  ): Promise<MemoryWrapupJobRecord[]> {
    return this.mutate((state) => {
      const timestamp = options.now ?? new Date();
      const staleBefore = new Date(
        timestamp.getTime() - Math.max(1_000, options.staleMs ?? 10 * 60_000),
      ).toISOString();
      for (const job of state.memoryWrapupJobs) {
        if (job.status === 'claimed' && (job.claimedAt ?? '') <= staleBefore) {
          job.status = 'pending';
          job.claimedAt = undefined;
          job.claimedBy = undefined;
          job.lastError = 'memory_wrapup_stale_claim_recovered';
          job.availableAt = timestamp.toISOString();
          job.updatedAt = timestamp.toISOString();
        }
      }
      const jobs = state.memoryWrapupJobs
        .filter(
          (job) =>
            job.status === 'pending' &&
            job.attempts < job.maxAttempts &&
            job.availableAt <= timestamp.toISOString() &&
            !state.memoryWrapupJobs.some(
              (active) =>
                active.status === 'claimed' &&
                active.platform === job.platform &&
                active.threadId === job.threadId &&
                active.workspaceId === job.workspaceId &&
                active.projectId === job.projectId,
            ),
        )
        .sort(
          (left, right) =>
            left.availableAt.localeCompare(right.availableAt) ||
            left.createdAt.localeCompare(right.createdAt),
        )
        .slice(0, Math.max(1, Math.min(options.limit ?? 1, 20)));
      for (const job of jobs) {
        job.cursor = state.memoryWrapupCursors.find(
          (item) =>
            item.platform === job.platform &&
            item.threadId === job.threadId &&
            item.workspaceId === job.workspaceId &&
            item.projectId === job.projectId,
        );
        job.status = 'claimed';
        job.attempts += 1;
        job.claimedAt = timestamp.toISOString();
        job.claimedBy = options.workerId;
        job.updatedAt = timestamp.toISOString();
      }
      return jobs.map((job) => structuredClone(job));
    });
  }

  async completeMemoryWrapup(
    id: string,
    input: CompleteMemoryWrapupInput = {},
  ): Promise<MemoryWrapupJobRecord | undefined> {
    return this.mutate((state) => {
      const job = state.memoryWrapupJobs.find((item) => item.id === id);
      if (!job || job.status !== 'claimed') return undefined;
      const timestamp = (input.now ?? new Date()).toISOString();
      job.status = 'completed';
      job.completedAt = timestamp;
      job.updatedAt = timestamp;
      job.proposalIds = input.proposalIds;
      job.transcriptEntries = input.transcriptEntries;
      job.transcriptOmittedEntries = input.transcriptOmittedEntries;
      job.lastError = undefined;
      if (input.cursor) {
        const cursorId = `${job.platform}:${job.workspaceId ?? ''}:${job.projectId ?? ''}:${job.threadId}`;
        const cursor: MemoryWrapupCursorRecord = {
          id: cursorId,
          platform: job.platform,
          threadId: job.threadId,
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          sourceRunId: job.sourceRunId,
          at: input.cursor.at,
          entryId: input.cursor.entryId,
          updatedAt: timestamp,
        };
        const index = state.memoryWrapupCursors.findIndex(
          (item) => item.id === cursorId,
        );
        if (index >= 0) state.memoryWrapupCursors[index] = cursor;
        else state.memoryWrapupCursors.push(cursor);
        job.cursor = structuredClone(cursor);
      }
      return structuredClone(job);
    });
  }

  async retryMemoryWrapup(
    id: string,
    input: RetryMemoryWrapupInput,
  ): Promise<MemoryWrapupJobRecord | undefined> {
    return this.mutate((state) => {
      const job = state.memoryWrapupJobs.find((item) => item.id === id);
      if (!job || job.status !== 'claimed') return undefined;
      const timestamp = input.now ?? new Date();
      job.status = job.attempts >= job.maxAttempts ? 'failed' : 'pending';
      job.failedAt =
        job.status === 'failed' ? timestamp.toISOString() : undefined;
      job.availableAt = new Date(
        timestamp.getTime() + Math.max(0, input.retryDelayMs ?? 30_000),
      ).toISOString();
      job.claimedAt = undefined;
      job.claimedBy = undefined;
      job.lastError = input.error.slice(0, 2_000);
      job.updatedAt = timestamp.toISOString();
      return structuredClone(job);
    });
  }

  async listMemoryWrapups(
    options: ListMemoryWrapupsOptions = {},
  ): Promise<MemoryWrapupJobRecord[]> {
    const state = await this.readState();
    return state.memoryWrapupJobs
      .filter((job) => !options.status || job.status === options.status)
      .filter(
        (job) => !options.workspaceId || job.workspaceId === options.workspaceId,
      )
      .filter((job) => !options.projectId || job.projectId === options.projectId)
      .filter((job) => !options.threadId || job.threadId === options.threadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(options.limit ?? 100, 500)))
      .map((job) => structuredClone(job));
  }

  async pruneMemoryWrapups(
    options: PruneMemoryWrapupsOptions = {},
  ): Promise<PruneMemoryWrapupsResult> {
    return this.mutate((state) => {
      const timestamp = options.now ?? new Date();
      const terminalBefore = new Date(
        timestamp.getTime() -
          Math.max(60_000, options.terminalOlderThanMs ?? 7 * 24 * 60 * 60_000),
      ).toISOString();
      const keepLatest = Math.max(
        1,
        Math.min(options.keepLatestPerThread ?? 20, 500),
      );
      const retainedIds = new Set<string>();
      const byThread = new Map<string, MemoryWrapupJobRecord[]>();
      for (const job of state.memoryWrapupJobs) {
        const key = `${job.platform}:${job.workspaceId ?? ''}:${job.projectId ?? ''}:${job.threadId}`;
        const jobs = byThread.get(key) ?? [];
        jobs.push(job);
        byThread.set(key, jobs);
      }
      for (const jobs of byThread.values()) {
        jobs
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, keepLatest)
          .forEach((job) => retainedIds.add(job.id));
      }
      const before = state.memoryWrapupJobs.length;
      state.memoryWrapupJobs = state.memoryWrapupJobs.filter(
        (job) =>
          job.status === 'pending' ||
          job.status === 'claimed' ||
          retainedIds.has(job.id) ||
          job.updatedAt >= terminalBefore,
      );
      return {
        removed: before - state.memoryWrapupJobs.length,
        retained: state.memoryWrapupJobs.length,
      };
    });
  }

  async pruneWorkspaceData(
    options: WorkspaceDataLifecycleOptions,
  ): Promise<WorkspaceDataLifecycleResult> {
    if (options.dryRun !== false) {
      const state = await this.readState();
      return workspaceDataLifecyclePlan(state, {
        ...options,
        dryRun: true,
      }).result;
    }
    return this.mutate((state) => {
      const { result, runIds } = workspaceDataLifecyclePlan(state, options);
      if (result.dryRun) return result;
      state.agentRuns = state.agentRuns.filter((item) => !runIds.has(item.id));
      state.agentRunEvents = state.agentRunEvents.filter(
        (item) => !runIds.has(item.runId),
      );
      state.outbox = state.outbox.filter(
        (item) => !item.runId || !runIds.has(item.runId),
      );
      state.turnDeliveries = state.turnDeliveries.filter(
        (item) => !runIds.has(item.runId),
      );
      state.agentRunSteering = state.agentRunSteering.filter(
        (item) =>
          !runIds.has(item.targetRunId) &&
          (!item.continuationRunId || !runIds.has(item.continuationRunId)),
      );
      state.agentThreadSessions = state.agentThreadSessions.filter(
        (item) =>
          item.status !== 'invalidated' ||
          !runIds.has(item.startedByRunId) ||
          !runIds.has(item.lastRunId),
      );
      state.memoryWrapupJobs = state.memoryWrapupJobs.filter(
        (item) => !runIds.has(item.sourceRunId),
      );
      state.toolApprovals = state.toolApprovals.filter(
        (item) => !runIds.has(item.runId),
      );
      const actor = options.actor?.replace(/[\0\r\n]/gu, '').trim().slice(0, 200);
      const audit: DataLifecycleAuditRecord = {
        id: randomUUID(),
        action: 'workspace.data_lifecycle.applied',
        workspaceId: result.workspaceId,
        actor: actor || 'operator:unknown',
        at: (options.now ?? new Date()).toISOString(),
        retentionDays: result.retentionDays,
        cutoff: result.cutoff,
        keepLatestPerThread: result.keepLatestPerThread,
        removed: structuredClone(result.removed),
        preserved: structuredClone(result.preserved),
      };
      state.dataLifecycleAudit.push(audit);
      if (state.dataLifecycleAudit.length > 500) {
        state.dataLifecycleAudit.splice(0, state.dataLifecycleAudit.length - 500);
      }
      return { ...result, dryRun: false };
    });
  }

  async listDataLifecycleAudit(
    options: ListDataLifecycleAuditOptions = {},
  ): Promise<DataLifecycleAuditRecord[]> {
    const state = await this.readState();
    return state.dataLifecycleAudit
      .filter(
        (item) => !options.workspaceId || item.workspaceId === options.workspaceId,
      )
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, Math.max(1, Math.min(options.limit ?? 100, 500)))
      .map((item) => structuredClone(item));
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

  async requeueAgentRun(
    id: string,
    options: RequeueAgentRunOptions = {},
  ): Promise<AgentRunRecord | undefined> {
    return this.mutate((state) => {
      const run = state.agentRuns.find((item) => item.id === id);
      if (!run) return undefined;
      if (run.status !== 'running') return copyRun(run);
      if (options.workerId && run.workerId !== options.workerId) {
        return copyRun(run);
      }

      const timestamp = (options.now ?? new Date()).toISOString();
      const reason = options.reason ?? 'worker_released_run';
      run.status = 'queued';
      run.workerId = undefined;
      run.claimedAt = undefined;
      run.lastError = reason;
      run.updatedAt = timestamp;
      this.appendAgentRunEventInState(state, run.id, 'log', {
        message: reason,
        metadata: {
          requeuedFrom: 'running',
          releasedBy: options.workerId,
        },
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
          steering.updatedAt = timestamp;
        }
      }
      return copyRun(run);
    });
  }

  async renewAgentRunLease(
    id: string,
    options: RenewAgentRunLeaseOptions,
  ): Promise<boolean> {
    return this.mutate((state) => {
      const run = state.agentRuns.find((item) => item.id === id);
      if (
        !run ||
        run.status !== 'running' ||
        run.workerId !== options.workerId
      ) {
        return false;
      }
      run.updatedAt = (options.now ?? new Date()).toISOString();
      return true;
    });
  }

  async markAgentRunRunning(
    id: string,
    options: MarkAgentRunRunningOptions = {},
  ): Promise<AgentRunRecord | undefined> {
    const timestamp = (options.now ?? new Date()).toISOString();
    return this.updateAgentRun(id, 'running', {
      startedAt: timestamp,
      claimedAt: timestamp,
      workerId: options.workerId,
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
    options?: {
      runId?: string;
      humanTakeover?: {
        actorId: string;
        actorDisplayName?: string;
        cardMessageId: string;
        receiptId: string;
        authorization: Record<string, unknown>;
      };
    },
  ): Promise<CancelThreadAgentRunsResult> {
    return this.mutate((state) => {
      const timestamp = now();
      const scope = {
        platform: thread.platform,
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        projectId: thread.projectId,
      };
      if (options?.humanTakeover) {
        const takeover = options.humanTakeover;
        for (const run of state.agentRuns) {
          if (!sameThread(run, scope) || !isActiveRunStatus(run.status)) continue;
          if (options.runId && run.id !== options.runId) continue;
          run.metadata = {
            ...run.metadata,
            humanTakeover: {
              actorId: takeover.actorId,
              actorDisplayName: takeover.actorDisplayName,
              at: timestamp,
              cardMessageId: takeover.cardMessageId,
              receiptId: takeover.receiptId,
            },
          };
          this.appendAgentRunEventInState(state, run.id, 'human_takeover', {
            message: `${takeover.actorDisplayName || 'A project member'} took over this task`,
            metadata: {
              control: 'human_takeover',
              actorId: takeover.actorId,
              actorDisplayName: takeover.actorDisplayName,
              cardMessageId: takeover.cardMessageId,
              receiptId: takeover.receiptId,
              authorization: takeover.authorization,
            },
          });
        }
      }
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

  async proposeToolApproval(
    input: ProposeToolApprovalInput,
  ): Promise<ToolApprovalRecord> {
    return this.mutate((state) => {
      const requestedAt = (input.now ?? new Date()).toISOString();
      expireToolApprovals(state, requestedAt);
      const existing = state.toolApprovals.find(
        (approval) =>
          approval.runId === input.runId &&
          approval.toolName === input.toolName &&
          approval.argumentDigest === input.argumentDigest &&
          approval.credentialIdentityId === input.credentialIdentityId &&
          approval.credentialIdentityRevision === input.credentialIdentityRevision,
      );
      if (existing) return cloneToolApproval(existing);
      const ttlMs = Math.max(
        60_000,
        Math.min(input.ttlMs ?? 15 * 60_000, 24 * 60 * 60_000),
      );
      const approval: ToolApprovalRecord = {
        id: randomUUID(),
        status: 'pending',
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        title: input.title,
        grantKind: input.grantKind,
        risk: input.risk,
        arguments: structuredClone(input.arguments),
        argumentSummary: structuredClone(input.argumentSummary),
        argumentDigest: input.argumentDigest,
        credentialIdentityId: input.credentialIdentityId,
        credentialIdentityRevision: input.credentialIdentityRevision,
        externalActor: input.externalActor,
        platform: input.thread.platform,
        thread: structuredClone(input.thread),
        threadId: input.thread.id,
        workspaceId: input.thread.workspaceId,
        projectId: input.thread.projectId,
        channelId: input.thread.channelId,
        requestedBy: input.requestedBy,
        requestedAt,
        expiresAt: new Date(Date.parse(requestedAt) + ttlMs).toISOString(),
        continuationStatus: 'pending',
      };
      state.toolApprovals.push(approval);
      if (state.toolApprovals.length > 2_000) {
        const terminal = new Set([
          'succeeded',
          'failed',
          'rejected',
          'expired',
        ]);
        const removable = state.toolApprovals
          .filter((item) => terminal.has(item.status))
          .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
        for (const item of removable.slice(0, state.toolApprovals.length - 2_000)) {
          state.toolApprovals.splice(state.toolApprovals.indexOf(item), 1);
        }
      }
      return cloneToolApproval(approval);
    });
  }

  async getToolApproval(
    id: string,
    at = new Date(),
  ): Promise<ToolApprovalRecord | undefined> {
    return this.mutate((state) => {
      expireToolApprovals(state, at.toISOString());
      const approval = state.toolApprovals.find((item) => item.id === id);
      return approval ? cloneToolApproval(approval) : undefined;
    });
  }

  async listToolApprovals(
    options: ListToolApprovalsOptions = {},
  ): Promise<ToolApprovalRecord[]> {
    return this.mutate((state) => {
      expireToolApprovals(state, (options.now ?? new Date()).toISOString());
      return state.toolApprovals
        .filter((item) => !options.status || item.status === options.status)
        .filter(
          (item) => !options.workspaceId || item.workspaceId === options.workspaceId,
        )
        .filter((item) => !options.projectId || item.projectId === options.projectId)
        .filter((item) => !options.threadId || item.threadId === options.threadId)
        .filter((item) => !options.runId || item.runId === options.runId)
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
        .slice(0, Math.max(1, Math.min(options.limit ?? 100, 500)))
        .map(cloneToolApproval);
    });
  }

  async approveToolApproval(
    input: DecideToolApprovalInput,
  ): Promise<ToolApprovalRecord> {
    return this.mutate((state) => {
      const timestamp = (input.now ?? new Date()).toISOString();
      expireToolApprovals(state, timestamp);
      const approval = state.toolApprovals.find((item) => item.id === input.id);
      if (!approval) throw new Error('tool_approval_not_found');
      if (approval.status === 'approved') return cloneToolApproval(approval);
      if (approval.status !== 'pending') {
        throw new Error(`tool_approval_not_pending:${approval.status}`);
      }
      approval.status = 'approved';
      approval.approvedAt = timestamp;
      approval.approvedBy = input.actorId;
      return cloneToolApproval(approval);
    });
  }

  async rejectToolApproval(
    input: DecideToolApprovalInput,
  ): Promise<ToolApprovalRecord> {
    return this.mutate((state) => {
      const timestamp = (input.now ?? new Date()).toISOString();
      expireToolApprovals(state, timestamp);
      const approval = state.toolApprovals.find((item) => item.id === input.id);
      if (!approval) throw new Error('tool_approval_not_found');
      if (approval.status === 'rejected') return cloneToolApproval(approval);
      if (approval.status !== 'pending' && approval.status !== 'approved') {
        throw new Error(`tool_approval_not_rejectable:${approval.status}`);
      }
      approval.status = 'rejected';
      approval.rejectedAt = timestamp;
      approval.rejectedBy = input.actorId;
      return cloneToolApproval(approval);
    });
  }

  async claimToolApproval(
    input: ClaimToolApprovalInput,
  ): Promise<ToolApprovalRecord | undefined> {
    return this.mutate((state) => {
      const timestamp = (input.now ?? new Date()).toISOString();
      expireToolApprovals(state, timestamp);
      const approval = state.toolApprovals.find((item) => item.id === input.id);
      if (
        !approval ||
        approval.status !== 'approved' ||
        approval.argumentDigest !== input.expectedArgumentDigest
      ) {
        return undefined;
      }
      approval.status = 'executing';
      approval.claimedAt = timestamp;
      approval.claimedBy = input.claimedBy;
      return cloneToolApproval(approval);
    });
  }

  async completeToolApproval(
    input: CompleteToolApprovalInput,
  ): Promise<ToolApprovalRecord> {
    return this.mutate((state) => {
      const approval = state.toolApprovals.find((item) => item.id === input.id);
      if (!approval) throw new Error('tool_approval_not_found');
      if (
        approval.status !== 'executing' ||
        approval.claimedBy !== input.claimedBy
      ) {
        throw new Error('tool_approval_claim_lost');
      }
      approval.status = 'succeeded';
      approval.completedAt = (input.now ?? new Date()).toISOString();
      approval.resultPreview = input.resultPreview?.slice(0, 300);
      return cloneToolApproval(approval);
    });
  }

  async markToolApprovalContinuationScheduled(
    input: MarkToolApprovalContinuationInput,
  ): Promise<ToolApprovalRecord> {
    return this.mutate((state) => {
      const approval = state.toolApprovals.find((item) => item.id === input.id);
      if (!approval) throw new Error('tool_approval_not_found');
      if (approval.status !== 'succeeded') {
        throw new Error(`tool_approval_not_succeeded:${approval.status}`);
      }
      if (approval.continuationStatus === 'scheduled') {
        return cloneToolApproval(approval);
      }
      approval.continuationStatus = 'scheduled';
      approval.continuationRunId = input.runId;
      approval.continuationScheduledAt = (input.now ?? new Date()).toISOString();
      return cloneToolApproval(approval);
    });
  }

  async failToolApproval(
    input: FailToolApprovalInput,
  ): Promise<ToolApprovalRecord> {
    return this.mutate((state) => {
      const approval = state.toolApprovals.find((item) => item.id === input.id);
      if (!approval) throw new Error('tool_approval_not_found');
      if (
        approval.status !== 'executing' ||
        approval.claimedBy !== input.claimedBy
      ) {
        throw new Error('tool_approval_claim_lost');
      }
      approval.status = 'failed';
      approval.failedAt = (input.now ?? new Date()).toISOString();
      approval.error = input.error.slice(0, 500);
      return cloneToolApproval(approval);
    });
  }

  async recoverStaleToolApprovals(
    input: RecoverStaleToolApprovalsInput = {},
  ): Promise<RecoverStaleToolApprovalsResult> {
    return this.mutate((state) => {
      const timestamp = (input.now ?? new Date()).toISOString();
      const cutoff = new Date(
        Date.parse(timestamp) - Math.max(1_000, input.olderThanMs ?? 5 * 60_000),
      ).toISOString();
      const candidates = state.toolApprovals
        .filter(
          (approval) =>
            approval.status === 'executing' &&
            Boolean(approval.claimedAt) &&
            approval.claimedAt! <= cutoff,
        )
        .sort((left, right) =>
          (left.claimedAt || '').localeCompare(right.claimedAt || ''),
        )
        .slice(0, Math.max(1, Math.min(input.limit ?? 100, 500)));
      for (const approval of candidates) {
        approval.status = 'failed';
        approval.failedAt = timestamp;
        approval.error = 'execution_outcome_unknown';
      }
      return {
        failed: candidates.length,
        records: candidates.map(cloneToolApproval),
      };
    });
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
    const searchTerms = options.query
      ?.normalize('NFKC')
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 8);
    return state.agentRuns
      .filter((item) => !options.status || item.status === options.status)
      .filter((item) => !options.workspaceId || item.workspaceId === options.workspaceId)
      .filter((item) => !options.projectId || item.projectId === options.projectId)
      .filter((item) => !options.threadId || item.threadId === options.threadId)
      .filter((item) => {
        if (!searchTerms?.length) return true;
        const searchable = [
          item.id,
          item.status,
          item.platform,
          item.title,
          item.threadId,
          item.threadExternalId,
          item.workspaceId,
          item.projectId,
          item.messageId,
          item.actorId,
          item.executorId,
          item.transportMode,
          item.summary,
          item.lastError,
          item.thread?.title,
          item.thread?.externalId,
          item.thread?.channelId,
          item.thread?.rootMessageId,
          item.thread?.topicId,
          item.message?.text,
          item.message?.actor.id,
          item.message?.actor.displayName,
          item.message?.actor.platformUserId,
          ...(item.message?.attachments?.map((attachment) => attachment.name) ?? []),
        ]
          .filter((value): value is string => typeof value === 'string')
          .join('\n')
          .normalize('NFKC')
          .toLocaleLowerCase();
        return searchTerms.every((term) => searchable.includes(term));
      })
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
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-limit)
      .map((item) => ({ ...item }));
  }

  async listScopedAgentRunEvents(
    options: ListAgentRunEventsOptions = {},
  ): Promise<ScopedAgentRunTimelineEvent[]> {
    const state = await this.readState();
    const runs = new Map(
      state.agentRuns
        .filter((run) => !options.workspaceId || run.workspaceId === options.workspaceId)
        .filter((run) => !options.projectId || run.projectId === options.projectId)
        .filter((run) => !options.threadId || run.threadId === options.threadId)
        .filter((run) => !options.runId || run.id === options.runId)
        .map((run) => [run.id, run] as const),
    );
    const types = options.types?.length ? new Set(options.types) : undefined;
    return state.agentRunEvents
      .filter((event) => runs.has(event.runId))
      .filter((event) => !types || types.has(event.type))
      .map((event) => {
        const run = runs.get(event.runId)!;
        return {
          ...event,
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          channelId: run.thread?.channelId,
          threadId: run.threadId,
          platform: run.platform,
          actorId:
            event.type === 'human_takeover' &&
            typeof event.metadata?.actorId === 'string'
              ? event.metadata.actorId
              : run.actorId,
          runStatus: run.status,
        };
      })
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, Math.max(1, Math.min(options.limit ?? 500, 2_000)));
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

  async getDeliveredProgressSurfaceId(
    runId: string,
    platform: OutboundEnvelope['target']['platform'],
  ): Promise<string | undefined> {
    const state = await this.readState();
    const createKind =
      platform === 'lark'
        ? 'lark.card.create'
        : `${platform}.progress.create`;
    return state.outbox
      .filter(
        (item) =>
          item.runId === runId &&
          item.target.platform === platform &&
          item.kind === createKind &&
          item.status === 'delivered' &&
          Boolean(item.externalId),
      )
      .sort((left, right) => right.sequence - left.sequence)[0]?.externalId;
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
    options: RemoveThreadBindingOptions = {},
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
      for (const binding of removed) {
        appendBindingAudit(state, {
          action: 'binding.removed',
          binding,
          before: binding,
          actor: options.actor,
          reason: options.reason,
          at: now(),
        });
      }
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

  async upsertSourceThreadMessages(
    input: UpsertSourceThreadMessagesInput,
  ): Promise<UpsertSourceThreadMessagesResult> {
    return this.mutate((state) => {
      const timestamp = (input.observedAt ?? new Date()).toISOString();
      const result: UpsertSourceThreadMessagesResult = {
        inserted: 0,
        updated: 0,
        duplicates: 0,
        records: [],
      };
      for (const sourceMessage of input.messages) {
        if (!sourceMessage.id || sourceMessage.actor.isBot) continue;
        const message: SourceMessage = {
          ...copySourceMessage(sourceMessage),
          threadId: input.thread.id,
          platform: input.thread.platform,
        };
        const id = sourceThreadMessageId(input.thread, message.id);
        const existing = state.sourceThreadMessages.find(
          (record) => record.id === id,
        );
        if (existing) {
          result.duplicates += 1;
          existing.message = message;
          existing.origin =
            existing.origin === 'event' || input.origin === 'history'
              ? existing.origin
              : input.origin;
          existing.lastObservedAt = timestamp;
          existing.threadExternalId = input.thread.externalId;
          existing.workspaceId = input.thread.workspaceId;
          existing.projectId = input.thread.projectId;
          result.updated += 1;
          result.records.push(copySourceThreadMessage(existing));
          continue;
        }

        const record: SourceThreadMessageRecord = {
          id,
          platform: input.thread.platform,
          threadId: input.thread.id,
          threadExternalId: input.thread.externalId,
          workspaceId: input.thread.workspaceId,
          projectId: input.thread.projectId,
          message,
          origin: input.origin,
          firstObservedAt: timestamp,
          lastObservedAt: timestamp,
        };
        state.sourceThreadMessages.push(record);
        result.inserted += 1;
        result.records.push(copySourceThreadMessage(record));
      }
      trimSourceThreadMessages(state, input.thread);
      return result;
    });
  }

  async listSourceThreadMessages(options: {
    thread: SourceThread;
    before?: string | Date;
    limit?: number;
  }): Promise<SourceThreadMessageRecord[]> {
    const state = await this.readState();
    const before =
      options.before instanceof Date
        ? options.before.toISOString()
        : options.before;
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1_000));
    return state.sourceThreadMessages
      .filter((record) => sameSourceThreadScope(record, options.thread))
      .filter((record) => !before || record.message.createdAt <= before)
      .sort(
        (a, b) =>
          b.message.createdAt.localeCompare(a.message.createdAt) ||
          b.lastObservedAt.localeCompare(a.lastObservedAt),
      )
      .slice(0, limit)
      .reverse()
      .map(copySourceThreadMessage);
  }

  async getThreadContextSync(
    thread: SourceThread,
    source: string,
  ): Promise<ThreadContextSyncRecord | undefined> {
    const state = await this.readState();
    const id = threadContextSyncId(thread, source);
    const record = state.threadContextSyncs.find((item) => item.id === id);
    return record ? copyThreadContextSync(record) : undefined;
  }

  async recordThreadContextSync(
    input: RecordThreadContextSyncInput,
  ): Promise<ThreadContextSyncRecord> {
    return this.mutate((state) => {
      const timestamp = (input.attemptedAt ?? new Date()).toISOString();
      const id = threadContextSyncId(input.thread, input.source);
      const existing = state.threadContextSyncs.find((item) => item.id === id);
      const record: ThreadContextSyncRecord = existing ?? {
        id,
        source: input.source,
        status: input.status,
        platform: input.thread.platform,
        threadId: input.thread.id,
        threadExternalId: input.thread.externalId,
        workspaceId: input.thread.workspaceId,
        projectId: input.thread.projectId,
        attemptedAt: timestamp,
        importedMessages: 0,
        duplicateMessages: 0,
        truncated: false,
      };
      record.status = input.status;
      record.source = input.source;
      record.platform = input.thread.platform;
      record.threadId = input.thread.id;
      record.threadExternalId = input.thread.externalId;
      record.workspaceId = input.thread.workspaceId;
      record.projectId = input.thread.projectId;
      record.attemptedAt = timestamp;
      record.completedAt = input.status === 'completed' ? timestamp : undefined;
      record.importedMessages = input.importedMessages ?? 0;
      record.duplicateMessages = input.duplicateMessages ?? 0;
      record.truncated = input.truncated ?? false;
      record.lastError = input.error;
      record.metadata = input.metadata;
      if (!existing) state.threadContextSyncs.push(record);
      return copyThreadContextSync(record);
    });
  }

  async checkUsageBudget(
    input: UsageBudgetCheckInput,
  ): Promise<UsageBudgetCheckResult> {
    const policies = activeUsageBudgetPolicies(input);
    const policy = policies.at(-1) ?? input.policy;
    const period = usagePeriod(input.at ?? new Date());
    const state = await this.readState();
    const current = usageTotalsForThread(
      state.usageRecords,
      input.thread,
      period,
    );
    const expected = usageQuantity(input.expected);
    const projected = current.map((line) => ({
      ...line,
      runs: line.runs + expected.runs,
      costUsd: line.costUsd + expected.costUsd,
    }));
    if (!policies.length) {
      return { allowed: true, period, policy, current, projected };
    }
    for (const candidate of policies) {
      const checkLine =
        projectUsageLine(projected, candidate.scope ?? 'project') ?? projected[0];
      if (
        typeof candidate.maxRunsPerMonth === 'number' &&
        checkLine.runs > candidate.maxRunsPerMonth
      ) {
        return {
          allowed: false,
          reason: 'runs_budget_exceeded',
          period,
          policy: candidate,
          current,
          projected,
          violated: checkLine,
        };
      }
      if (
        typeof candidate.maxCostUsdPerMonth === 'number' &&
        checkLine.costUsd > candidate.maxCostUsdPerMonth
      ) {
        return {
          allowed: false,
          reason: 'cost_budget_exceeded',
          period,
          policy: candidate,
          current,
          projected,
          violated: checkLine,
        };
      }
    }
    return { allowed: true, period, policy, current, projected };
  }

  async recordAgentRunUsage(
    input: RecordAgentRunUsageInput,
  ): Promise<AgentRunUsageRecord> {
    return this.mutate((state) => {
      const recordedAt = (input.at ?? new Date()).toISOString();
      const period = usagePeriod(input.at ?? new Date());
      const id = usageRecordId(input.runId, period, input.recordKey);
      const quantity = usageQuantity(input.quantity);
      const existing = state.usageRecords.find((record) => record.id === id);
      const record: AgentRunUsageRecord = existing ?? {
        id,
        runId: input.runId,
        recordKey: input.recordKey,
        purpose: input.purpose ?? 'agent',
        platform: input.thread.platform,
        threadId: input.thread.id,
        threadExternalId: input.thread.externalId,
        workspaceId: input.thread.workspaceId,
        projectId: input.thread.projectId,
        channelId: input.thread.channelId || input.thread.externalId,
        period,
        source: input.source ?? 'agent-run',
        runs: 0,
        costUsd: 0,
        recordedAt,
      };
      record.platform = input.thread.platform;
      record.recordKey = input.recordKey ?? record.recordKey;
      record.purpose = input.purpose ?? usagePurpose(record);
      record.threadId = input.thread.id;
      record.threadExternalId = input.thread.externalId;
      record.workspaceId = input.thread.workspaceId;
      record.projectId = input.thread.projectId;
      record.channelId = input.thread.channelId || input.thread.externalId;
      record.period = period;
      record.source = input.source ?? record.source;
      record.runs = quantity.runs;
      record.costUsd = quantity.costUsd;
      record.recordedAt = recordedAt;
      record.metadata = input.metadata;
      if (!existing) state.usageRecords.push(record);
      this.appendAgentRunEventInState(state, input.runId, 'usage_recorded', {
        message: `Usage recorded: ${record.runs} run(s), $${record.costUsd.toFixed(4)}`,
        metadata: {
          period,
          runs: record.runs,
          costUsd: record.costUsd,
          source: record.source,
          purpose: record.purpose,
        },
      });
      const alerts = reconcileUsageAlertsInState(state, {
        runId: input.runId,
        thread: input.thread,
        policies: input.policies,
        period,
        triggeredAt: recordedAt,
      });
      for (const alert of alerts) {
        this.appendAgentRunEventInState(state, input.runId, 'usage_threshold_alert', {
          message: `${alert.scope} ${alert.metric} usage reached ${alert.thresholdPercent}% of the monthly limit`,
          metadata: { ...alert },
        });
      }
      trimUsageRecords(state);
      return copyUsageRecord(record);
    });
  }

  async usageSnapshot(input?: {
    thread?: SourceThread;
    workspaceId?: string;
    projectId?: string;
    period?: string;
    limit?: number;
  }): Promise<UsageSnapshot> {
    const state = await this.readState();
    const period = input?.period ?? usagePeriod();
    const limit = Math.max(1, Math.min(input?.limit ?? 100, 1_000));
    const filteredRecords = state.usageRecords
      .filter((record) => record.period === period)
      .filter((record) => !input?.workspaceId || record.workspaceId === input.workspaceId)
      .filter((record) => !input?.projectId || record.projectId === input.projectId)
      .filter((record) => !input?.thread || record.threadId === input.thread.id)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    const records = filteredRecords
      .slice(0, limit)
      .map(copyUsageRecord);
    const alerts = state.usageAlerts
      .filter((alert) => alert.period === period)
      .filter((alert) => !input?.workspaceId || alert.workspaceId === input.workspaceId)
      .filter((alert) => !input?.projectId || alert.projectId === input.projectId)
      .filter(
        (alert) =>
          !input?.thread ||
          alert.threadId === input.thread.id ||
          (alert.scope !== 'thread' &&
            alert.workspaceId === input.thread.workspaceId &&
            (alert.scope === 'workspace' ||
              alert.projectId === input.thread.projectId) &&
            (alert.scope !== 'channel' ||
              alert.channelId ===
                (input.thread.channelId || input.thread.externalId))),
      )
      .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
      .slice(0, limit)
      .map(copyUsageAlert);
    const totals = input?.thread
      ? usageTotalsForThread(state.usageRecords, input.thread, period)
      : filteredRecords.reduce<UsageBudgetLine[]>((lines, record) => {
          const thread: SourceThread = {
            id: record.threadId,
            platform: record.platform,
            externalId: record.threadExternalId,
            workspaceId: record.workspaceId,
            projectId: record.projectId,
            channelId: record.channelId,
            visibility: 'public',
          };
          for (const line of usageTotalsForThread([record], thread, period)) {
            const key = JSON.stringify([
              line.scope,
              line.workspaceId,
              line.projectId,
              line.channelId,
              line.threadId,
              line.period,
            ]);
            const existing = lines.find(
              (candidate) =>
                JSON.stringify([
                  candidate.scope,
                  candidate.workspaceId,
                  candidate.projectId,
                  candidate.channelId,
                  candidate.threadId,
                  candidate.period,
                ]) === key,
            );
            if (existing) {
              existing.runs += line.runs;
              existing.costUsd += line.costUsd;
            } else {
              lines.push({ ...line });
            }
          }
          return lines;
        }, []);
    return {
      period,
      records,
      recordCount: filteredRecords.length,
      costReportedRecords: filteredRecords.filter(
        (record) => record.metadata?.costReported === true,
      ).length,
      tokenReportedRecords: filteredRecords.filter(
        (record) =>
          typeof record.metadata?.inputTokens === 'number' ||
          typeof record.metadata?.outputTokens === 'number',
      ).length,
      totals,
      purposeTotals: usagePurposeTotals(filteredRecords),
      alerts,
    };
  }

  async reconcileUsageBudgetAlerts(
    input: ReconcileUsageBudgetAlertsInput,
  ): Promise<UsageBudgetAlert[]> {
    return this.mutate((state) => {
      const at = input.at ?? new Date();
      const created = reconcileUsageAlertsInState(state, {
        runId: input.runId ?? `policy:${input.thread.id}`,
        thread: input.thread,
        policies: input.policies,
        period: usagePeriod(at),
        triggeredAt: at.toISOString(),
      });
      trimUsageRecords(state);
      return created.map(copyUsageAlert);
    });
  }

  async recordInboundEvent(
    input: RecordInboundEventInput,
  ): Promise<RecordInboundEventResult> {
    return this.mutate((state) => {
      const id = inboundEventId(input.platform, input.externalId);
      const existing = state.inboundEvents.find(
        (event) =>
          event.id === id ||
          (Boolean(input.messageId) &&
            event.platform === input.platform &&
            event.messageId === input.messageId),
      );
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
      trimInboundEventState(state);
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

  async listThreadBindingAudit(
    options?: ListThreadBindingAuditOptions,
  ): Promise<ThreadBindingAuditRecord[]> {
    const state = await this.readState();
    const limit = options?.limit ?? 100;
    return state.threadBindingAudit
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !options?.workspaceId || item.workspaceId === options.workspaceId)
      .filter(({ item }) => !options?.projectId || item.projectId === options.projectId)
      .filter(({ item }) => !options?.bindingId || item.bindingId === options.bindingId)
      .filter(({ item }) => !options?.platform || item.platform === options.platform)
      .sort((a, b) => b.item.at.localeCompare(a.item.at) || b.index - a.index)
      .slice(0, Math.max(1, Math.min(limit, 500)))
      .map(({ item }) => copyBindingAudit(item));
  }

  async summarize(workspaceId?: string): Promise<DeliverySummary> {
    const state = await this.readState();
    const summary = emptySummary();
    for (const item of state.outbox) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.outbox[item.status] += 1;
        recordOldestStatus(
          summary.oldestStatusUpdatedAt.outbox,
          item.status,
          item.updatedAt,
        );
      }
    }
    for (const item of state.turnDeliveries) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.turnDeliveries[item.status] += 1;
        recordOldestStatus(
          summary.oldestStatusUpdatedAt.turnDeliveries,
          item.status,
          item.updatedAt,
        );
      }
    }
    for (const item of state.inboundEvents) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.inboundEvents[item.status] += 1;
        summary.inboundEvents.duplicates += item.duplicateCount;
        recordOldestStatus(
          summary.oldestStatusUpdatedAt.inboundEvents,
          item.status,
          item.updatedAt,
        );
        if (typeof item.metadata?.producer === 'string') {
          summary.workflowProducers.received += 1;
          summary.workflowProducers.duplicates += item.duplicateCount;
          const staged = Number(item.metadata.workflowStaged || 0);
          const matched = Number(item.metadata.workflowMatched || 0);
          if (Number.isFinite(staged) && staged > 0) {
            summary.workflowProducers.staged += staged;
          }
          if (Number.isFinite(matched) && matched === 0) {
            summary.workflowProducers.unmatched += 1;
          }
          if (item.status === 'ignored' || item.status === 'rejected') {
            summary.workflowProducers.ignored += 1;
          }
          if (item.status === 'failed') summary.workflowProducers.failed += 1;
        }
      }
    }
    for (const item of state.agentRuns) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.agentRuns[item.status] += 1;
        recordOldestStatus(
          summary.oldestStatusUpdatedAt.agentRuns,
          item.status,
          item.updatedAt,
        );
      }
    }
    for (const item of state.agentRunSteering) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.steering[item.status] += 1;
        recordOldestStatus(
          summary.oldestStatusUpdatedAt.steering,
          item.status,
          item.updatedAt,
        );
      }
    }
    for (const item of state.agentThreadSessions) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.sessions[item.status] += 1;
        recordOldestStatus(
          summary.oldestStatusUpdatedAt.sessions,
          item.status,
          item.updatedAt,
        );
      }
    }
    for (const item of state.toolApprovals) {
      if (!workspaceId || item.workspaceId === workspaceId) {
        summary.toolApprovals[item.status] += 1;
        recordOldestStatus(
          summary.oldestStatusUpdatedAt.toolApprovals,
          item.status,
          item.completedAt || item.failedAt || item.claimedAt || item.requestedAt,
        );
      }
    }
    summary.bindings = state.threadBindings.filter(
      (item) => !workspaceId || item.workspaceId === workspaceId,
    ).length;
    const currentPeriod = usagePeriod();
    for (const item of state.usageRecords) {
      if (workspaceId && item.workspaceId !== workspaceId) continue;
      summary.usage.records += 1;
      if (item.period !== currentPeriod) continue;
      summary.usage.currentPeriodRuns += item.runs;
      summary.usage.currentPeriodCostUsd += item.costUsd;
    }
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
      sequence: state.nextAgentRunEventSequence,
      runId,
      type,
      at: now(),
      message: input?.message,
      metadata: input?.metadata,
    };
    state.nextAgentRunEventSequence += 1;
    state.agentRunEvents.push(event);
    return { ...event };
  }

  private async updateAgentRun(
    id: string,
    status: AgentRunStatus,
    input?: {
      startedAt?: string;
      claimedAt?: string;
      workerId?: string;
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
      run.claimedAt = input?.claimedAt ?? run.claimedAt;
      run.workerId = input?.workerId ?? run.workerId;
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
