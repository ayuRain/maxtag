import type { SourceThread, ThreadTranscriptCursor } from '@opentag/core';
import type {
  DeliveryStore,
  LarkHistoryImportJobRecord,
  ThreadBinding,
} from '@opentag/delivery';
import type { LarkTransport } from '@opentag/platform-lark';
import type { MemoryAnalysisService } from '@opentag/runtime-host';
import { backfillLarkHistory } from './lark-backfill.js';

const DAY_MS = 24 * 60 * 60_000;
const ANALYSIS_BATCH_WINDOW_MS = 7 * DAY_MS;

export interface LarkHistoryImportServiceOptions {
  deliveryStore: DeliveryStore;
  memoryAnalysisService: MemoryAnalysisService;
  transport(): LarkTransport | undefined;
  botOpenId?: string;
  workerId: string;
  enabled?: boolean;
  intervalWindowMs?: number;
  windowsPerPass?: number;
  maxMessagesPerWindow?: number;
  staleMs?: number;
  retryBaseMs?: number;
  onTerminal?: (job: LarkHistoryImportJobRecord) => Promise<void>;
}

export interface LarkHistoryPreview {
  channelId: string;
  since: string;
  until: string;
  scannedMessages: number;
  discoveredThreads: number;
  truncated: boolean;
  errors: Array<{ channelId: string; containerType: 'chat' | 'thread'; error: string }>;
}

export interface LarkHistoryImportPassResult {
  claimed: number;
  completed: number;
  released: number;
  retried: number;
  failed: number;
  importedMessages: number;
  proposals: number;
  jobs: LarkHistoryImportJobRecord[];
}

function channelBindings(
  bindings: ThreadBinding[],
  job: LarkHistoryImportJobRecord,
): ThreadBinding[] {
  const scoped = bindings.filter(
    (binding) =>
      binding.platform === 'lark' &&
      binding.workspaceId === job.workspaceId &&
      (binding.channelId === job.channelId ||
        (binding.scope === 'channel' && binding.externalId === job.channelId)),
  );
  if (scoped.length) return scoped;
  return [
    {
      id: `lark:${job.channelId}`,
      platform: 'lark',
      externalId: job.channelId,
      scope: 'channel',
      source: 'observed',
      channelId: job.channelId,
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      title: job.channelTitle,
      activationMode: 'mention',
      requireMention: true,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      metadata: { historyImportJobId: job.id },
    },
  ];
}

function emptyPass(): LarkHistoryImportPassResult {
  return {
    claimed: 0,
    completed: 0,
    released: 0,
    retried: 0,
    failed: 0,
    importedMessages: 0,
    proposals: 0,
    jobs: [],
  };
}

export class LarkHistoryImportService {
  private pass: Promise<LarkHistoryImportPassResult> | undefined;
  private shuttingDown = false;
  private passCount = 0;
  private lastPassAt: string | undefined;
  private lastPassResult: LarkHistoryImportPassResult | undefined;

  constructor(private readonly options: LarkHistoryImportServiceOptions) {}

  get enabled(): boolean {
    return (this.options.enabled ?? true) && Boolean(this.options.transport());
  }

  get running(): boolean {
    return Boolean(this.pass);
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async waitForIdle(): Promise<void> {
    await this.pass;
  }

  async status(workspaceId?: string): Promise<Record<string, unknown>> {
    const jobs = await this.options.deliveryStore.listLarkHistoryImports({
      workspaceId,
      limit: 500,
    });
    return {
      enabled: this.enabled,
      running: this.running,
      workerId: this.options.workerId,
      passCount: this.passCount,
      lastPassAt: this.lastPassAt,
      lastPassResult: this.lastPassResult
        ? {
            claimed: this.lastPassResult.claimed,
            completed: this.lastPassResult.completed,
            released: this.lastPassResult.released,
            retried: this.lastPassResult.retried,
            failed: this.lastPassResult.failed,
            importedMessages: this.lastPassResult.importedMessages,
            proposals: this.lastPassResult.proposals,
          }
        : undefined,
      jobs: {
        awaitingChoice: jobs.filter((job) => job.status === 'awaiting_choice').length,
        pending: jobs.filter((job) => job.status === 'pending').length,
        claimed: jobs.filter((job) => job.status === 'claimed').length,
        completed: jobs.filter((job) => job.status === 'completed').length,
        failed: jobs.filter((job) => job.status === 'failed').length,
        cancelled: jobs.filter((job) => job.status === 'cancelled').length,
      },
    };
  }

  async preview(input: {
    workspaceId: string;
    projectId: string;
    channelId: string;
    channelTitle?: string;
    since: Date;
    until: Date;
    maxMessages?: number;
  }): Promise<LarkHistoryPreview> {
    const transport = this.options.transport();
    if (!transport) throw new Error('lark_http_transport_required');
    const job = await this.previewJob(input);
    const bindings = channelBindings(
      await this.options.deliveryStore.listThreadBindings(5_000, input.workspaceId),
      job,
    );
    const result = await backfillLarkHistory({
      workspaceId: input.workspaceId,
      since: input.since,
      until: input.until,
      bindings,
      transport,
      botOpenId: this.options.botOpenId,
      maxMessages: Math.max(1, Math.min(input.maxMessages ?? 1_000, 5_000)),
      ingest: async () => ({ accepted: false, reason: 'preview_only' }),
    });
    return {
      channelId: input.channelId,
      since: input.since.toISOString(),
      until: input.until.toISOString(),
      scannedMessages: result.replayed,
      discoveredThreads: result.threads,
      truncated: result.truncated,
      errors: result.errors,
    };
  }

  private async previewJob(input: {
    workspaceId: string;
    projectId: string;
    channelId: string;
    channelTitle?: string;
    since: Date;
    until: Date;
  }): Promise<LarkHistoryImportJobRecord> {
    const timestamp = new Date().toISOString();
    return {
      id: 'preview',
      mode: 'history',
      status: 'pending',
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      channelId: input.channelId,
      channelTitle: input.channelTitle,
      thread: {
        id: `lark:${input.channelId}:main`,
        platform: 'lark',
        externalId: `${input.channelId}:main`,
        channelId: input.channelId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        title: input.channelTitle,
        visibility: 'private',
      },
      since: input.since.toISOString(),
      until: input.until.toISOString(),
      cursor: {
        windowSince: input.since.toISOString(),
        analysisWindowSince: input.since.toISOString(),
        analysis: {},
      },
      analyzeMemory: true,
      attempts: 0,
      maxAttempts: 1,
      availableAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      scannedMessages: 0,
      importedMessages: 0,
      duplicateMessages: 0,
      ignoredMessages: 0,
      discoveredThreads: 0,
      analyzedThreads: 0,
      proposalIds: [],
    };
  }

  async runPass(): Promise<LarkHistoryImportPassResult> {
    if (this.pass) return this.pass;
    if (!this.enabled || this.shuttingDown) return emptyPass();
    this.pass = this.executePass();
    try {
      return await this.pass;
    } finally {
      this.pass = undefined;
    }
  }

  private async executePass(): Promise<LarkHistoryImportPassResult> {
    const result = emptyPass();
    const jobs = await this.options.deliveryStore.claimLarkHistoryImports({
      workerId: this.options.workerId,
      limit: 1,
      staleMs: this.options.staleMs ?? 10 * 60_000,
    });
    result.claimed = jobs.length;
    for (const job of jobs) {
      try {
        const current = await this.processJob(job, result);
        if (current.status === 'completed') result.completed += 1;
        else result.released += 1;
        result.jobs.push(current);
        if (current.status === 'completed' && this.options.onTerminal) {
          await this.options.onTerminal(current).catch(() => undefined);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const delay =
          (this.options.retryBaseMs ?? 30_000) *
          Math.max(1, 2 ** Math.max(0, job.attempts - 1));
        const retried = await this.options.deliveryStore.retryLarkHistoryImport(job.id, {
          error: message,
          retryDelayMs: delay,
        });
        if (retried?.status === 'failed') {
          result.failed += 1;
          if (this.options.onTerminal) {
            await this.options.onTerminal(retried).catch(() => undefined);
          }
        } else result.retried += 1;
        if (retried) result.jobs.push(retried);
      }
    }
    this.passCount += 1;
    this.lastPassAt = new Date().toISOString();
    this.lastPassResult = structuredClone(result);
    return result;
  }

  private async processJob(
    original: LarkHistoryImportJobRecord,
    pass: LarkHistoryImportPassResult,
  ): Promise<LarkHistoryImportJobRecord> {
    const transport = this.options.transport();
    if (!transport) throw new Error('lark_http_transport_required');
    if (!original.since || !original.until || !original.cursor) {
      throw new Error('lark_history_import_bounded_range_required');
    }
    const until = new Date(original.until);
    let job = original;
    const bindings = channelBindings(
      await this.options.deliveryStore.listThreadBindings(5_000, job.workspaceId),
      job,
    );
    const windowMs = Math.max(60_000, this.options.intervalWindowMs ?? DAY_MS);
    const windowsPerPass = Math.max(1, Math.min(this.options.windowsPerPass ?? 7, 31));

    for (let index = 0; index < windowsPerPass; index += 1) {
      if (this.shuttingDown) break;
      const windowSince = new Date(job.cursor!.windowSince);
      if (windowSince.getTime() >= until.getTime()) {
        const memoryStatus = this.options.memoryAnalysisService.status();
        if (
          job.analyzeMemory &&
          memoryStatus.enabled &&
          new Date(job.cursor!.analysisWindowSince || job.since!).getTime() <
            until.getTime()
        ) {
          const analysis = structuredClone(job.cursor!.analysis);
          const analyzed = await this.analyzeThread(
            job,
            job.thread,
            analysis[job.thread.id],
          );
          if (analyzed.cursor) analysis[job.thread.id] = analyzed.cursor;
          const updated = await this.options.deliveryStore.updateLarkHistoryImportProgress(
            job.id,
            {
              cursor: {
                windowSince: job.cursor!.windowSince,
                analysisWindowSince: analyzed.drained
                  ? until.toISOString()
                  : job.cursor!.analysisWindowSince,
                analysis,
              },
              analyzedThreads: analyzed.analyzed ? 1 : 0,
              proposalIds: analyzed.proposalIds,
            },
          );
          if (!updated) throw new Error('lark_history_import_job_missing');
          job = updated;
          pass.proposals += analyzed.proposalIds.length;
          if (!analyzed.drained) {
            return (
              (await this.options.deliveryStore.releaseLarkHistoryImport(job.id, {
                delayMs: 0,
              })) ?? job
            );
          }
        }
        return (
          (await this.options.deliveryStore.completeLarkHistoryImport(job.id)) ?? job
        );
      }
      const windowUntil = new Date(
        Math.min(until.getTime(), windowSince.getTime() + windowMs),
      );
      let inserted = 0;
      let duplicates = 0;
      const batch = await backfillLarkHistory({
        workspaceId: job.workspaceId,
        since: windowSince,
        until: windowUntil,
        bindings,
        transport,
        botOpenId: this.options.botOpenId,
        maxMessages: Math.max(
          50,
          Math.min(this.options.maxMessagesPerWindow ?? 5_000, 5_000),
        ),
        ingest: async ({ thread, message }) => {
          const saved = await this.options.deliveryStore.upsertSourceThreadMessages({
            thread,
            messages: [message],
            origin: 'history',
          });
          inserted += saved.inserted;
          duplicates += saved.duplicates;
          if (thread.id !== job.thread.id) {
            await this.options.deliveryStore.upsertSourceThreadMessages({
              thread: job.thread,
              messages: [
                {
                  ...message,
                  threadId: job.thread.id,
                  metadata: {
                    ...message.metadata,
                    historyImportJobId: job.id,
                    historySourceThreadId: thread.id,
                    historySourceThreadExternalId: thread.externalId,
                    historySourceTopicId: thread.topicId,
                  },
                },
              ],
              origin: 'history',
            });
          }
          return { accepted: true, duplicate: saved.duplicates > 0 };
        },
      });
      if (!batch.complete) {
        const reason = batch.truncated
          ? 'lark_history_import_window_truncated'
          : batch.errors[0]?.error || 'lark_history_import_window_failed';
        throw new Error(reason);
      }

      const previousAnalysisWindowSince =
        job.cursor!.analysisWindowSince || job.since!;
      const analysis = structuredClone(job.cursor!.analysis);
      const archived = await this.options.deliveryStore.updateLarkHistoryImportProgress(
        job.id,
        {
          cursor: {
            windowSince: windowUntil.toISOString(),
            analysisWindowSince: previousAnalysisWindowSince,
            analysis,
          },
          scannedMessages: batch.scanned,
          importedMessages: inserted,
          duplicateMessages: duplicates,
          ignoredMessages: batch.ignored,
          discoveredThreads: batch.threads,
        },
      );
      if (!archived) throw new Error('lark_history_import_job_missing');
      job = archived;

      const proposalIds: string[] = [];
      let analyzedThreads = 0;
      let analysisDrained = true;
      const memoryStatus = this.options.memoryAnalysisService.status();
      let analysisDue =
        windowUntil.getTime() >= until.getTime() ||
        windowUntil.getTime() - new Date(previousAnalysisWindowSince).getTime() >=
          ANALYSIS_BATCH_WINDOW_MS;
      if (job.analyzeMemory && memoryStatus.enabled && !analysisDue) {
        const pending = await this.options.deliveryStore.loadThreadTranscript({
          thread: job.thread,
          maxEntries: memoryStatus.maxEntries,
          maxChars: memoryStatus.maxChars,
          afterCursor: analysis[job.thread.id],
          order: 'oldest',
        });
        analysisDue = pending.omittedEntries > 0;
      }
      if (job.analyzeMemory && memoryStatus.enabled && analysisDue) {
        const analyzed = await this.analyzeThread(
          job,
          job.thread,
          analysis[job.thread.id],
        );
        if (analyzed.cursor) analysis[job.thread.id] = analyzed.cursor;
        if (analyzed.analyzed) analyzedThreads = 1;
        analysisDrained = analyzed.drained;
        proposalIds.push(...analyzed.proposalIds);
      }
      const updated = await this.options.deliveryStore.updateLarkHistoryImportProgress(
        job.id,
        {
          cursor: {
            windowSince: windowUntil.toISOString(),
            analysisWindowSince: analysisDue && analysisDrained
              ? windowUntil.toISOString()
              : previousAnalysisWindowSince,
            analysis,
          },
          analyzedThreads,
          proposalIds,
        },
      );
      if (!updated) throw new Error('lark_history_import_job_missing');
      job = updated;
      pass.importedMessages += inserted;
      pass.proposals += proposalIds.length;
    }

    if (new Date(job.cursor!.windowSince).getTime() >= until.getTime()) {
      return (
        (await this.options.deliveryStore.completeLarkHistoryImport(job.id)) ?? job
      );
    }
    return (
      (await this.options.deliveryStore.releaseLarkHistoryImport(job.id, {
        delayMs: 0,
      })) ?? job
    );
  }

  private async analyzeThread(
    job: LarkHistoryImportJobRecord,
    thread: SourceThread,
    cursor?: ThreadTranscriptCursor,
  ): Promise<{
    analyzed: boolean;
    drained: boolean;
    cursor?: ThreadTranscriptCursor;
    proposalIds: string[];
  }> {
    const status = this.options.memoryAnalysisService.status();
    let currentCursor = cursor;
    let analyzed = false;
    let drained = true;
    const proposalIds: string[] = [];
    for (let batchIndex = 0; batchIndex < 25; batchIndex += 1) {
      const pending = await this.options.deliveryStore.loadThreadTranscript({
        thread,
        maxEntries: status.maxEntries,
        maxChars: status.maxChars,
        afterCursor: currentCursor,
        order: 'oldest',
      });
      if (!pending.entries.length) break;
      const report = await this.options.memoryAnalysisService.analyze({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        thread,
        scopes: ['project', 'workspace'],
        actorId: job.requestedBy || 'system:lark-history-import',
        afterCursor: currentCursor,
        transcriptOrder: 'oldest',
        purpose: 'memory_analysis',
        useProvidedThread: true,
        usageRecordKey: `lark_history_import:${job.id}:${thread.id}:${currentCursor?.entryId || 'start'}`,
      });
      analyzed = true;
      proposalIds.push(...report.proposed.map((proposal) => proposal.id));
      const nextCursor = report.transcript.nextCursor;
      drained = report.transcript.omittedEntries === 0;
      if (
        !nextCursor ||
        (currentCursor &&
          nextCursor.at === currentCursor.at &&
          nextCursor.entryId === currentCursor.entryId)
      ) {
        break;
      }
      currentCursor = nextCursor;
      const durableAnalysis = structuredClone(job.cursor!.analysis);
      durableAnalysis[thread.id] = currentCursor;
      const checkpoint =
        await this.options.deliveryStore.updateLarkHistoryImportProgress(job.id, {
          cursor: {
            windowSince: job.cursor!.windowSince,
            analysisWindowSince: job.cursor!.analysisWindowSince,
            analysis: durableAnalysis,
          },
          proposalIds: report.proposed.map((proposal) => proposal.id),
        });
      if (!checkpoint) throw new Error('lark_history_import_job_missing');
      if (drained) break;
    }
    return {
      analyzed,
      drained,
      cursor: currentCursor,
      proposalIds: [...new Set(proposalIds)],
    };
  }
}
