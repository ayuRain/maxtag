import type { MemoryProposal } from '@opentag/core';
import type { AgentRunRecord, DeliveryStore, MemoryWrapupJobRecord } from '@opentag/delivery';
import { MemoryAnalysisService, type MemoryAnalysisReport } from './memory-analysis.js';

export interface MemoryWrapupServiceOptions {
  deliveryStore: DeliveryStore;
  analysisService: MemoryAnalysisService;
  workerId: string;
  enabled?: boolean;
  debounceMs?: number;
  batchSize?: number;
  staleMs?: number;
  retryBaseMs?: number;
  maxAttempts?: number;
  retentionMs?: number;
  keepLatestPerThread?: number;
  minEntries?: number;
  maxChars?: number;
  maxAgeMs?: number;
  rawGraceMs?: number;
  autoApprove?: (input: {
    job: MemoryWrapupJobRecord;
    proposal: MemoryProposal;
  }) => Promise<MemoryProposal>;
  onProposals?: (input: {
    job: MemoryWrapupJobRecord;
    report: MemoryAnalysisReport;
    proposals: MemoryProposal[];
  }) => Promise<void>;
}

export interface MemoryWrapupPassResult {
  staged: number;
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  proposals: number;
  pruned: number;
  purgedRawSummaries: number;
  purgedRawMessages: number;
  jobs: MemoryWrapupJobRecord[];
}

export class MemoryWrapupService {
  private pass: Promise<MemoryWrapupPassResult> | undefined;
  private shuttingDown = false;
  private passCount = 0;
  private lastPassAt: string | undefined;
  private lastPassResult: MemoryWrapupPassResult | undefined;

  constructor(private readonly options: MemoryWrapupServiceOptions) {}

  get enabled(): boolean {
    return (this.options.enabled ?? true) && this.options.analysisService.status().enabled;
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

  async status(): Promise<Record<string, unknown>> {
    const jobs = await this.options.deliveryStore.listMemoryWrapups({ limit: 500 });
    return {
      enabled: this.enabled,
      running: this.running,
      workerId: this.options.workerId,
      debounceMs: this.options.debounceMs ?? 15_000,
      batchSize: this.options.batchSize ?? 1,
      staleMs: this.options.staleMs ?? 10 * 60_000,
      minEntries: this.options.minEntries ?? 200,
      maxChars: this.options.maxChars ?? 100_000,
      maxAgeMs: this.options.maxAgeMs ?? 24 * 60 * 60_000,
      rawGraceMs: this.options.rawGraceMs ?? 7 * 24 * 60 * 60_000,
      passCount: this.passCount,
      lastPassAt: this.lastPassAt,
      lastPassResult: this.lastPassResult
        ? {
            staged: this.lastPassResult.staged,
            claimed: this.lastPassResult.claimed,
            completed: this.lastPassResult.completed,
            retried: this.lastPassResult.retried,
            failed: this.lastPassResult.failed,
            proposals: this.lastPassResult.proposals,
            purgedRawSummaries: this.lastPassResult.purgedRawSummaries,
            purgedRawMessages: this.lastPassResult.purgedRawMessages,
          }
        : undefined,
      jobs: {
        pending: jobs.filter((job) => job.status === 'pending').length,
        claimed: jobs.filter((job) => job.status === 'claimed').length,
        completed: jobs.filter((job) => job.status === 'completed').length,
        failed: jobs.filter((job) => job.status === 'failed').length,
      },
    };
  }

  async enqueueRun(run: AgentRunRecord): Promise<MemoryWrapupJobRecord | undefined> {
    if (!this.enabled || !run.thread || !run.message || !run.workspaceId) {
      return undefined;
    }
    const job = await this.enqueueThreadIfDue(run.thread, run.id);
    if (!job) return undefined;
    await this.options.deliveryStore.appendAgentRunEvent(
      run.id,
      'memory_wrapup_queued',
      {
        message: 'Automatic memory wrapup queued.',
        metadata: { memoryWrapupJobId: job.id, availableAt: job.availableAt },
      },
    );
    return job;
  }

  async observeThread(
    thread: MemoryWrapupJobRecord['thread'],
    sourceId: string,
  ): Promise<MemoryWrapupJobRecord | undefined> {
    if (!this.enabled || !thread.workspaceId) return undefined;
    return this.enqueueThreadIfDue(thread, `context:${sourceId}`);
  }

  private async enqueueThreadIfDue(
    thread: MemoryWrapupJobRecord['thread'],
    sourceRunId: string,
    now = new Date(),
  ): Promise<MemoryWrapupJobRecord | undefined> {
    const active = await this.options.deliveryStore.listMemoryWrapups({
      workspaceId: thread.workspaceId,
      projectId: thread.projectId,
      threadId: thread.id,
      limit: 20,
    });
    if (active.some((job) => job.status === 'pending' || job.status === 'claimed')) {
      return undefined;
    }
    const cursor = await this.options.deliveryStore.getMemoryWrapupCursor(thread);
    const minEntries = Math.max(2, Math.min(this.options.minEntries ?? 200, 200));
    const maxChars = Math.max(1_000, Math.min(this.options.maxChars ?? 100_000, 200_000));
    const transcript = await this.options.deliveryStore.loadThreadTranscript({
      thread,
      afterCursor: cursor,
      order: 'oldest',
      maxEntries: minEntries,
      maxChars,
      includeContextSummaries: false,
    });
    if (!transcript.entries.length) return undefined;
    const characterCount = transcript.entries.reduce(
      (total, entry) => total + entry.text.length,
      0,
    );
    const oldestAt = Date.parse(transcript.entries[0].at);
    const dueByAge = Number.isFinite(oldestAt) &&
      oldestAt <= now.getTime() - Math.max(60_000, this.options.maxAgeMs ?? 24 * 60 * 60_000);
    if (
      transcript.totalEntries < minEntries &&
      characterCount < maxChars &&
      !dueByAge
    ) {
      return undefined;
    }
    return this.options.deliveryStore.enqueueMemoryWrapup({
      thread,
      sourceRunId,
      debounceMs: this.options.debounceMs,
      maxAttempts: this.options.maxAttempts,
      now,
    });
  }

  private async stageEligibleThreads(): Promise<number> {
    const threads = await this.options.deliveryStore.listSourceThreads({ limit: 500 });
    let staged = 0;
    for (const thread of threads) {
      const job = await this.enqueueThreadIfDue(
        thread,
        `${thread.platform}:${thread.id}`,
      );
      if (job) staged += 1;
    }
    return staged;
  }

  async runPass(): Promise<MemoryWrapupPassResult> {
    if (this.pass) return this.pass;
    if (!this.enabled || this.shuttingDown) return this.emptyResult();
    this.pass = this.executePass();
    try {
      return await this.pass;
    } finally {
      this.pass = undefined;
    }
  }

  private emptyResult(): MemoryWrapupPassResult {
    return {
      staged: 0,
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      proposals: 0,
      pruned: 0,
      purgedRawSummaries: 0,
      purgedRawMessages: 0,
      jobs: [],
    };
  }

  private async executePass(): Promise<MemoryWrapupPassResult> {
    const staged = await this.stageEligibleThreads();
    const claimed = await this.options.deliveryStore.claimMemoryWrapups({
      workerId: this.options.workerId,
      limit: this.options.batchSize,
      staleMs: this.options.staleMs,
    });
    const result: MemoryWrapupPassResult = {
      ...this.emptyResult(),
      staged,
      claimed: claimed.length,
    };
    for (const job of claimed) {
      const sourceRun = await this.options.deliveryStore.getAgentRun(job.sourceRunId);
      const appendRunEvent = async (
        type: Parameters<DeliveryStore['appendAgentRunEvent']>[1],
        input: Parameters<DeliveryStore['appendAgentRunEvent']>[2],
      ): Promise<void> => {
        if (!sourceRun) return;
        await this.options.deliveryStore.appendAgentRunEvent(sourceRun.id, type, input);
      };
      try {
        if (this.shuttingDown) {
          const released = await this.options.deliveryStore.retryMemoryWrapup(job.id, {
            error: 'memory_wrapup_shutdown_before_analysis',
            retryDelayMs: 0,
          });
          if (released?.status === 'failed') result.failed += 1;
          else result.retried += 1;
          if (released) result.jobs.push(released);
          continue;
        }
        await appendRunEvent('memory_wrapup_started', {
          message: 'Automatic memory wrapup started.',
          metadata: { memoryWrapupJobId: job.id, attempt: job.attempts },
        });
        const status = this.options.analysisService.status();
        const pendingTranscript = await this.options.deliveryStore.loadThreadTranscript({
          thread: job.thread,
          maxEntries: status.maxEntries,
          maxChars: status.maxChars,
          afterCursor: job.cursor,
          order: 'oldest',
          includeContextSummaries: false,
        });
        if (!pendingTranscript.entries.length) {
          const completed = await this.options.deliveryStore.completeMemoryWrapup(
            job.id,
            {
              cursor: job.cursor,
              proposalIds: [],
              transcriptEntries: 0,
              transcriptOmittedEntries: 0,
            },
          );
          await appendRunEvent('memory_wrapup_completed', {
            message: 'Automatic memory wrapup found no new transcript entries.',
            metadata: { memoryWrapupJobId: job.id, transcriptEntries: 0 },
          });
          result.completed += 1;
          if (completed) result.jobs.push(completed);
          continue;
        }
        const report = await this.options.analysisService.analyze({
          workspaceId: job.workspaceId!,
          projectId: job.projectId,
          runId: sourceRun?.id,
          thread: job.thread,
          afterCursor: job.cursor,
          transcriptOrder: 'oldest',
          actorId: 'system:memory-wrapup',
          purpose: 'memory_wrapup',
          usageRecordKey: `memory_wrapup:${job.id}:attempt:${job.attempts}`,
          useProvidedThread: true,
        });
        if (!report.transcript.nextCursor) {
          throw new Error('memory_wrapup_cursor_missing');
        }
        if (!report.contextSummary?.trim()) {
          throw new Error('memory_wrapup_context_summary_missing');
        }
        const autoApproved: MemoryProposal[] = [];
        const pendingProposals: MemoryProposal[] = [];
        for (const proposal of report.proposed) {
          if (
            proposal.action === 'remember' &&
            proposal.scope === 'project' &&
            this.options.autoApprove
          ) {
            autoApproved.push(
              await this.options.autoApprove({ job, proposal }),
            );
          } else {
            pendingProposals.push(proposal);
          }
        }
        const contextSummary = await this.options.deliveryStore.recordThreadContextSummary({
          thread: job.thread,
          summary: report.contextSummary,
          entries: pendingTranscript.entries,
          fromCursor: job.cursor,
          toCursor: report.transcript.nextCursor,
          rawGraceMs: this.options.rawGraceMs,
        });
        const completed = await this.options.deliveryStore.completeMemoryWrapup(
          job.id,
          {
            cursor: report.transcript.nextCursor,
            proposalIds: report.proposed.map((proposal) => proposal.id),
            transcriptEntries: report.transcript.entries,
            transcriptOmittedEntries: report.transcript.omittedEntries,
            contextSummaryId: contextSummary.id,
            autoApprovedProposalIds: autoApproved.map((proposal) => proposal.id),
          },
        );
        await appendRunEvent('memory_wrapup_completed', {
          message: `Automatic memory wrapup consolidated ${report.transcript.entries} entries, auto-approved ${autoApproved.length} project fact(s), and queued ${pendingProposals.length} review(s).`,
          metadata: {
            memoryWrapupJobId: job.id,
            analysisId: report.id,
            contextSummaryId: contextSummary.id,
            proposalIds: report.proposed.map((proposal) => proposal.id),
            autoApprovedProposalIds: autoApproved.map((proposal) => proposal.id),
            transcriptEntries: report.transcript.entries,
            transcriptOmittedEntries: report.transcript.omittedEntries,
          },
        });
        result.completed += 1;
        result.proposals += report.proposed.length;
        if (completed) result.jobs.push(completed);
        if (pendingProposals.length && this.options.onProposals) {
          try {
            await this.options.onProposals({
              job: completed ?? job,
              report,
              proposals: pendingProposals,
            });
          } catch (error) {
            await appendRunEvent('log', {
              message: `Automatic memory proposal notification failed: ${error instanceof Error ? error.message : String(error)}`,
              metadata: {
                level: 'warn',
                memoryWrapupJobId: job.id,
                proposalIds: pendingProposals.map((proposal) => proposal.id),
              },
            });
          }
        }
        if (report.transcript.omittedEntries > 0) {
          await this.options.deliveryStore.enqueueMemoryWrapup({
            thread: job.thread,
            sourceRunId: job.sourceRunId,
            debounceMs: 0,
            maxAttempts: this.options.maxAttempts,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryDelayMs =
          (this.options.retryBaseMs ?? 30_000) *
          Math.max(1, 2 ** Math.max(0, job.attempts - 1));
        const retried = await this.options.deliveryStore.retryMemoryWrapup(job.id, {
          error: message,
          retryDelayMs,
        });
        const terminal = retried?.status === 'failed';
        await appendRunEvent(
          terminal ? 'memory_wrapup_failed' : 'memory_wrapup_retry',
          {
            message: terminal
              ? `Automatic memory wrapup failed: ${message}`
              : `Automatic memory wrapup will retry: ${message}`,
            metadata: {
              memoryWrapupJobId: job.id,
              attempt: job.attempts,
              retryAt: terminal ? undefined : retried?.availableAt,
            },
          },
        );
        if (terminal) result.failed += 1;
        else result.retried += 1;
        if (retried) result.jobs.push(retried);
      }
    }
    const pruned = await this.options.deliveryStore.pruneMemoryWrapups({
      terminalOlderThanMs: this.options.retentionMs,
      keepLatestPerThread: this.options.keepLatestPerThread,
    });
    result.pruned = pruned.removed;
    const purged = await this.options.deliveryStore.purgeThreadContextRaw();
    result.purgedRawSummaries = purged.summaries;
    result.purgedRawMessages =
      purged.sourceMessages + purged.runMessages + purged.steeringMessages;
    this.passCount += 1;
    this.lastPassAt = new Date().toISOString();
    this.lastPassResult = structuredClone(result);
    return result;
  }
}
