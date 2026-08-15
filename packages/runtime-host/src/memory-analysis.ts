import { randomUUID } from 'node:crypto';
import {
  memoryScopeGranted,
  memoryRetentionDaysFor,
  type AccessBundle,
  type AgentMemoryDecision,
  type ExecutorDescriptor,
  type ExecutorRegistry,
  type MemoryProposal,
  type MemoryScopeKind,
  type MemoryStore,
  type ScopedMemorySnapshot,
  type SourceThread,
  type ThreadConfigStore,
} from '@opentag/core';
import type { AgentRunRecord, DeliveryStore } from '@opentag/delivery';

const ANALYZABLE_SCOPES: MemoryScopeKind[] = [
  'workspace',
  'project',
];

function looksLikeEphemeralRecallValue(value: string): boolean {
  const text = value.trim();
  return (
    /(?:临时|测试|一次性).{0,12}(?:口令|密码|标记|代码|值)/u.test(text) ||
    /(?:temporary|one[- ]?time|test).{0,16}(?:code|token|marker|value)/iu.test(text) ||
    /^[A-Za-zＡ-Ｚａ-ｚ]\s*(?:的值)?\s*(?:是|=)\s*[A-Z][A-Z0-9_-]*-\d{2,}\b/u.test(text)
  );
}

export interface MemoryAnalysisServiceOptions {
  deliveryStore: DeliveryStore;
  memoryStore: MemoryStore;
  threadConfigStore: ThreadConfigStore;
  executorRegistry: ExecutorRegistry;
  executorId?: string;
  maxEntries?: number;
  maxChars?: number;
  minConfidence?: number;
  purposeExecutors?: Partial<
    Record<
      'memory_analysis' | 'memory_query' | 'memory_wrapup',
      { executorRegistry: ExecutorRegistry; executorId?: string }
    >
  >;
}

export interface AnalyzeThreadMemoryInput {
  workspaceId: string;
  projectId?: string;
  runId?: string;
  thread?: SourceThread;
  scopes?: MemoryScopeKind[];
  actorId?: string;
  purpose?: 'memory_analysis' | 'memory_wrapup';
  usageRecordKey?: string;
  afterCursor?: { at: string; entryId: string };
  transcriptOrder?: 'latest' | 'oldest';
  /** Analyze this exact persisted thread even when it has no agent run yet. */
  useProvidedThread?: boolean;
}

export interface MemoryAnalysisReport {
  id: string;
  status: 'completed';
  sourceRunId: string;
  thread: SourceThread;
  executor: ExecutorDescriptor;
  transcript: {
    entries: number;
    totalEntries: number;
    omittedEntries: number;
    truncated: boolean;
    nextCursor?: { at: string; entryId: string };
  };
  decisions: AgentMemoryDecision[];
  proposed: MemoryProposal[];
  skipped: Array<{ decision: AgentMemoryDecision; reason: string }>;
  contextSummary?: string;
  startedAt: string;
  completedAt: string;
  usage?: {
    runs?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface QueryMemoryInput extends AnalyzeThreadMemoryInput {
  query: string;
}

export interface MemoryQueryReport {
  id: string;
  sourceRunId: string;
  answer: string;
  executor: ExecutorDescriptor;
  scopes: MemoryScopeKind[];
  startedAt: string;
  completedAt: string;
  usage?: {
    runs?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

function containsSensitiveMemoryValue(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:api[_ -]?key|app[_ -]?secret|client[_ -]?secret|password|passwd|access[_ -]?token|refresh[_ -]?token|verification[_ -]?token)\b\s*[:=]\s*\S+/iu.test(
      value,
    )
  );
}

function sanitizedContextSummary(value: string): string | undefined {
  const summary = value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      '[sensitive credential omitted]',
    )
    .replace(
      /(\b(?:api[_ -]?key|app[_ -]?secret|client[_ -]?secret|password|passwd|access[_ -]?token|refresh[_ -]?token|verification[_ -]?token)\b\s*[:=]\s*)\S+/giu,
      '$1[sensitive value omitted]',
    )
    .trim();
  return summary ? summary.slice(0, 4_000) : undefined;
}

function normalizedValue(value: string | undefined): string {
  return value?.trim().replace(/\s+/gu, ' ') ?? '';
}

function approvedMemoryPrompt(snapshot: ScopedMemorySnapshot): string {
  return snapshot.scopes
    .map(({ scope, content, document }) =>
      [
        `## ${scope.kind} [documentKey=${document?.key ?? 'none'} version=${document?.version ?? 0}]`,
        content || '(empty)',
      ].join('\n'),
    )
    .join('\n\n');
}

function analysisAccess(
  thread: SourceThread,
  source: AccessBundle,
  scopes: MemoryScopeKind[],
  mode: 'read' | 'write' = 'write',
): AccessBundle {
  return {
    id: `memory-analysis:${source.id}`,
    threadId: thread.id,
    workspaceId: source.workspaceId ?? thread.workspaceId,
    projectId: source.projectId ?? thread.projectId,
    grants: scopes.map((scope) => ({
      id: `memory-analysis:${scope}`,
      kind: 'memory',
      scope,
      label: `${scope} memory analysis`,
      constraints: {
        permissions: mode === 'read' ? ['read'] : ['read', 'write'],
      },
    })),
    networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
  };
}

function availableScopes(
  requested: MemoryScopeKind[] | undefined,
  access: AccessBundle,
  thread: SourceThread,
): MemoryScopeKind[] {
  const desired = requested?.length ? requested : ANALYZABLE_SCOPES;
  return ANALYZABLE_SCOPES.filter(
    (scope) =>
      desired.includes(scope) &&
      memoryScopeGranted(access, scope, 'read') &&
      memoryScopeGranted(access, scope, 'write') &&
      (scope !== 'project' || Boolean(thread.projectId)) &&
      (scope !== 'channel' || Boolean(thread.channelId)),
  );
}

function lineContains(content: string, selector: string): boolean {
  return content.split('\n').some((line) => line.includes(selector));
}

export class MemoryAnalysisService {
  private readonly options: MemoryAnalysisServiceOptions;

  constructor(options: MemoryAnalysisServiceOptions) {
    this.options = options;
  }

  private runner(purpose: 'memory_analysis' | 'memory_query' | 'memory_wrapup') {
    const override = this.options.purposeExecutors?.[purpose];
    const executorRegistry = override?.executorRegistry ?? this.options.executorRegistry;
    const executorId =
      override?.executorId ??
      this.options.executorId ??
      executorRegistry.defaultExecutorId;
    return {
      executorId,
      executor: executorRegistry.get(executorId),
      descriptor: executorRegistry.describe(executorId),
    };
  }

  status(): {
    enabled: boolean;
    queryEnabled: boolean;
    wrapupEnabled: boolean;
    executor?: ExecutorDescriptor;
    queryExecutor?: ExecutorDescriptor;
    wrapupExecutor?: ExecutorDescriptor;
    maxEntries: number;
    maxChars: number;
    minConfidence: number;
  } {
    const executor = this.runner('memory_analysis').descriptor;
    const queryExecutor = this.runner('memory_query').descriptor;
    const wrapupExecutor = this.runner('memory_wrapup').descriptor;
    return {
      enabled: executor?.status === 'ready',
      queryEnabled: queryExecutor?.status === 'ready',
      wrapupEnabled: wrapupExecutor?.status === 'ready',
      executor,
      queryExecutor,
      wrapupExecutor,
      maxEntries: Math.max(2, Math.min(this.options.maxEntries ?? 200, 200)),
      maxChars: Math.max(
        1_000,
        Math.min(this.options.maxChars ?? 200_000, 200_000),
      ),
      minConfidence: Math.max(
        0,
        Math.min(this.options.minConfidence ?? 0.65, 1),
      ),
    };
  }

  private async sourceRun(
    input: AnalyzeThreadMemoryInput,
  ): Promise<AgentRunRecord | undefined> {
    if (input.runId) {
      const run = await this.options.deliveryStore.getAgentRun(input.runId);
      if (
        !run?.thread ||
        run.workspaceId !== input.workspaceId ||
        (input.projectId && run.projectId !== input.projectId)
      ) {
        throw new Error('memory_analysis_source_run_not_found');
      }
      return run;
    }
    const runs = await this.options.deliveryStore.listAgentRuns({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      limit: 100,
    });
    const run = runs.find(
      (candidate) =>
        candidate.thread &&
        candidate.message &&
        (!input.thread ||
          (candidate.thread.platform === input.thread.platform &&
            (candidate.thread.id === input.thread.id ||
              (!input.useProvidedThread &&
                Boolean(input.thread.channelId) &&
                candidate.thread.channelId === input.thread.channelId) ||
              candidate.thread.externalId === input.thread.externalId))),
    );
    if (!run?.thread && !input.thread) {
      throw new Error('memory_analysis_source_run_not_found');
    }
    return run;
  }

  async analyze(input: AnalyzeThreadMemoryInput): Promise<MemoryAnalysisReport> {
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    const sourceRun = await this.sourceRun(input);
    const thread = sourceRun?.thread ?? input.thread;
    if (!thread) throw new Error('memory_analysis_source_thread_not_found');
    const sourceRunId =
      sourceRun?.id ?? input.usageRecordKey ?? `history-import:${id}`;
    const purpose = input.purpose ?? 'memory_analysis';
    const { executorId, executor, descriptor } = this.runner(purpose);
    if (!executor || !descriptor || descriptor.status !== 'ready') {
      throw new Error('memory_analysis_executor_not_ready');
    }
    if (sourceRun) {
      await this.options.deliveryStore.appendAgentRunEvent(
        sourceRun.id,
        'memory_analysis_started',
        {
          message: `Memory analysis started with ${descriptor.label}${descriptor.model ? ` / ${descriptor.model}` : ''}.`,
          metadata: { analysisId: id, executor: descriptor },
        },
      );
    }
    try {
      const workspace = await this.options.threadConfigStore.getWorkspace?.(thread);
      const project = await this.options.threadConfigStore.getProject?.(
        thread,
        workspace,
      );
      const sourceAccess = await this.options.threadConfigStore.getAccessBundle(
        thread,
        { workspace, project },
      );
      const scopes = availableScopes(input.scopes, sourceAccess, thread);
      if (!scopes.length) throw new Error('memory_analysis_no_writable_scope');
      const memorySnapshot = await this.options.memoryStore.loadMemory?.({
        thread,
        workspace,
        project,
        scopes,
      });
      if (!memorySnapshot) {
        throw new Error('memory_analysis_snapshot_unavailable');
      }
      const status = this.status();
      const transcript = await this.options.deliveryStore.loadThreadTranscript({
        thread,
        maxEntries: status.maxEntries,
        maxChars: status.maxChars,
        afterCursor: input.afterCursor,
        order: input.transcriptOrder,
        includeContextSummaries: false,
      });
      if (!transcript.entries.length) {
        throw new Error('memory_analysis_transcript_empty');
      }
      const access = analysisAccess(thread, sourceAccess, scopes);
      const result = await executor.run({
        runId: `memory-analysis:${id}`,
        purpose,
        workspace,
        project,
        thread,
        message: {
          id: `memory-analysis:${id}`,
          threadId: thread.id,
          platform: thread.platform,
          text: 'Analyze the complete supplied transcript against approved memory and emit merge decisions only.',
          actor: { id: input.actorId ?? 'operator:memory-analysis' },
          createdAt: startedAt,
          mentionsAgent: true,
        },
        identity: {
          id: 'opentag-memory-analyst',
          displayName: 'MaxTag Memory Analyst',
          instructions: 'Perform one-shot, read-only, scope-aware memory analysis.',
          defaultExecutorId: executorId,
        },
        access,
        memory: approvedMemoryPrompt(memorySnapshot),
        memorySnapshot,
        transcript,
      });
      await this.options.deliveryStore.recordAgentRunUsage({
        runId: sourceRunId,
        recordKey: input.usageRecordKey ?? `${purpose}:${id}`,
        purpose,
        thread,
        quantity: { runs: 0, costUsd: result.usage?.costUsd ?? 0 },
        source: `memory-runner:${purpose}`,
        policies: sourceAccess.budgetPolicies,
        metadata: {
          executorId,
          model: descriptor.model,
          purpose,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          costReported: typeof result.usage?.costUsd === 'number',
        },
      });
      const decisions = result.memoryDecisions ?? [];
      const proposed: MemoryProposal[] = [];
      const skipped: MemoryAnalysisReport['skipped'] = [];
      const scopeSnapshot = new Map(
        memorySnapshot.scopes.map((entry) => [entry.scope.kind, entry]),
      );
      for (const decision of decisions) {
        const text = normalizedValue(decision.text);
        const selector = normalizedValue(decision.selector);
        const selectors = [
          ...new Set(
            (decision.selectors ?? [])
              .map((value) => normalizedValue(value))
              .filter(Boolean),
          ),
        ];
        const scope = scopeSnapshot.get(decision.scope);
        const confidence = decision.confidence ?? 0;
        let reason = '';
        if (decision.operation === 'skip') reason = 'model_skipped';
        else if (!scopes.includes(decision.scope)) reason = 'scope_not_allowed';
        else if (confidence < status.minConfidence) reason = 'low_confidence';
        else if (
          containsSensitiveMemoryValue(
            `${text}\n${selector}\n${selectors.join('\n')}\n${(decision.aliases ?? []).join('\n')}`,
          )
        ) {
          reason = 'sensitive_value';
        } else if (
          (decision.operation === 'remember' ||
            decision.operation === 'replace' ||
            decision.operation === 'merge') &&
          looksLikeEphemeralRecallValue(text)
        ) {
          reason = 'ephemeral_recall_value';
        } else if (
          (decision.operation === 'remember' ||
            decision.operation === 'replace' ||
            decision.operation === 'merge') &&
          !text
        ) {
          reason = 'text_required';
        } else if (
          (decision.operation === 'replace' ||
            decision.operation === 'forget' ||
            decision.operation === 'index') &&
          !selector
        ) {
          reason = 'selector_required';
        } else if (
          decision.operation === 'merge' &&
          selectors.length < 2
        ) {
          reason = 'merge_selectors_required';
        } else if (
          decision.operation === 'merge' &&
          selectors.length > 8
        ) {
          reason = 'merge_selectors_limit_exceeded';
        } else if (
          (decision.operation === 'replace' ||
            decision.operation === 'merge' ||
            decision.operation === 'forget' ||
            decision.operation === 'index') &&
          decision.expectedDocumentVersion !== (scope?.document?.version ?? 0)
        ) {
          reason = 'stale_document_version';
        } else if (
          decision.operation === 'merge' &&
          selectors.some((value) => !lineContains(scope?.content ?? '', value))
        ) {
          reason = 'merge_selector_not_found';
        } else if (
          (decision.operation === 'replace' ||
            decision.operation === 'forget' ||
            decision.operation === 'index') &&
          !lineContains(scope?.content ?? '', selector)
        ) {
          reason = 'selector_not_found';
        } else if (
          decision.operation === 'index' &&
          !decision.aliases?.length
        ) {
          reason = 'aliases_required';
        }
        if (reason) {
          skipped.push({ decision, reason });
          continue;
        }
        if (!this.options.memoryStore.proposeMemory) {
          throw new Error('memory_proposals_unavailable');
        }
        const source = `memory-analysis:${id}`;
        const proposal = await this.options.memoryStore.proposeMemory({
          thread,
          workspace,
          project,
          scope: decision.scope,
          action: decision.operation as
            | 'remember'
            | 'replace'
            | 'merge'
            | 'forget'
            | 'index',
          value:
            decision.operation === 'forget' || decision.operation === 'index'
              ? selector
              : text,
          selector: selector || undefined,
          selectors: selectors.length ? selectors : undefined,
          expectedDocumentVersion: scope?.document?.version ?? 0,
          actorId: `memory-runner:${executorId}`,
          source,
          reason: [decision.reason, `confidence:${confidence.toFixed(2)}`]
            .filter(Boolean)
            .join(' / '),
          searchAliases:
            decision.operation === 'remember' ||
            decision.operation === 'replace' ||
            decision.operation === 'merge' ||
            decision.operation === 'index'
              ? decision.aliases
              : undefined,
          retentionDays:
            decision.operation === 'remember' ||
            decision.operation === 'replace' ||
            decision.operation === 'merge'
              ? memoryRetentionDaysFor(sourceAccess, decision.scope)
              : undefined,
        });
        if (proposal.source === source) proposed.push(proposal);
      }
      const completedAt = new Date().toISOString();
      if (sourceRun) {
        await this.options.deliveryStore.appendAgentRunEvent(
          sourceRun.id,
          'memory_analysis_completed',
          {
            message: `Memory analysis queued ${proposed.length} proposal(s); ${skipped.length} decision(s) skipped.`,
            metadata: {
              analysisId: id,
              proposalIds: proposed.map((proposal) => proposal.id),
              decisions: decisions.length,
              skipped: skipped.length,
              transcriptEntries: transcript.entries.length,
              transcriptOmittedEntries: transcript.omittedEntries,
            },
          },
        );
      }
      return {
        id,
        status: 'completed',
        sourceRunId,
        thread,
        executor: descriptor,
        transcript: {
          entries: transcript.entries.length,
          totalEntries: transcript.totalEntries,
          omittedEntries: transcript.omittedEntries,
          truncated: transcript.truncated,
          nextCursor: transcript.nextCursor,
        },
        decisions,
        proposed,
        skipped,
        contextSummary: sanitizedContextSummary(result.summary),
        startedAt,
        completedAt,
        usage: result.usage,
      };
    } catch (error) {
      if (sourceRun) {
        await this.options.deliveryStore.appendAgentRunEvent(
          sourceRun.id,
          'memory_analysis_failed',
          {
            message:
              error instanceof Error ? error.message : 'memory_analysis_failed',
            metadata: { analysisId: id },
          },
        );
      }
      throw error;
    }
  }

  async query(input: QueryMemoryInput): Promise<MemoryQueryReport> {
    const query = input.query.trim();
    if (!query) throw new Error('memory_query_required');
    if (query.length > 2_000) throw new Error('memory_query_too_long');
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    const sourceRun = await this.sourceRun(input);
    if (!sourceRun?.thread) throw new Error('memory_analysis_source_run_not_found');
    const thread = sourceRun.thread;
    const { executorId, executor, descriptor } = this.runner('memory_query');
    if (!executor || !descriptor || descriptor.status !== 'ready') {
      throw new Error('memory_analysis_executor_not_ready');
    }
    await this.options.deliveryStore.appendAgentRunEvent(
      sourceRun.id,
      'memory_query_started',
      {
        message: `Semantic memory query started with ${descriptor.label}${descriptor.model ? ` / ${descriptor.model}` : ''}.`,
        metadata: { memoryQueryId: id },
      },
    );
    try {
      const workspace = await this.options.threadConfigStore.getWorkspace?.(thread);
      const project = await this.options.threadConfigStore.getProject?.(
        thread,
        workspace,
      );
      const sourceAccess = await this.options.threadConfigStore.getAccessBundle(
        thread,
        { workspace, project },
      );
      const desired = input.scopes?.length ? input.scopes : ANALYZABLE_SCOPES;
      const scopes = ANALYZABLE_SCOPES.filter(
        (scope) =>
          desired.includes(scope) &&
          memoryScopeGranted(sourceAccess, scope, 'read') &&
          (scope !== 'project' || Boolean(thread.projectId)) &&
          (scope !== 'channel' || Boolean(thread.channelId)),
      );
      if (!scopes.length) throw new Error('memory_query_no_readable_scope');
      const memorySnapshot = await this.options.memoryStore.loadMemory?.({
        thread,
        workspace,
        project,
        scopes,
      });
      if (!memorySnapshot) throw new Error('memory_query_snapshot_unavailable');
      const result = await executor.run({
        runId: `memory-query:${id}`,
        purpose: 'memory_query',
        workspace,
        project,
        thread,
        message: {
          id: `memory-query:${id}`,
          threadId: thread.id,
          platform: thread.platform,
          text: query,
          actor: { id: input.actorId ?? 'operator:memory-query' },
          createdAt: startedAt,
          mentionsAgent: true,
        },
        identity: {
          id: 'opentag-memory-query',
          displayName: 'MaxTag Memory Query',
          instructions: 'Perform one-shot, read-only synthesis over approved memory.',
          defaultExecutorId: executorId,
        },
        access: analysisAccess(thread, sourceAccess, scopes, 'read'),
        memory: approvedMemoryPrompt(memorySnapshot),
        memorySnapshot,
      });
      await this.options.deliveryStore.recordAgentRunUsage({
        runId: sourceRun.id,
        recordKey: `memory_query:${id}`,
        purpose: 'memory_query',
        thread,
        quantity: { runs: 0, costUsd: result.usage?.costUsd ?? 0 },
        source: 'memory-runner:memory_query',
        policies: sourceAccess.budgetPolicies,
        metadata: {
          executorId,
          model: descriptor.model,
          purpose: 'memory_query',
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          costReported: typeof result.usage?.costUsd === 'number',
        },
      });
      const answer = result.summary.trim();
      if (!answer) throw new Error('memory_query_empty_response');
      const completedAt = new Date().toISOString();
      await this.options.deliveryStore.appendAgentRunEvent(
        sourceRun.id,
        'memory_query_completed',
        {
          message: 'Semantic memory query completed.',
          metadata: { memoryQueryId: id, scopes },
        },
      );
      return {
        id,
        sourceRunId: sourceRun.id,
        answer,
        executor: descriptor,
        scopes,
        startedAt,
        completedAt,
        usage: result.usage,
      };
    } catch (error) {
      await this.options.deliveryStore.appendAgentRunEvent(
        sourceRun.id,
        'memory_query_failed',
        {
          message:
            error instanceof Error ? error.message : 'memory_query_failed',
          metadata: { memoryQueryId: id },
        },
      );
      throw error;
    }
  }
}
