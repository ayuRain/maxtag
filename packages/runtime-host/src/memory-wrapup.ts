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
  onProposals?: (input: {
    job: MemoryWrapupJobRecord;
    report: MemoryAnalysisReport;
    proposals: MemoryProposal[];
  }) => Promise<void>;
}

export interface MemoryWrapupPassResult {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  proposals: number;
  pruned: number;
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
      passCount: this.passCount,
      lastPassAt: this.lastPassAt,
      lastPassResult: this.lastPassResult
        ? {
            claimed: this.lastPassResult.claimed,
            completed: this.lastPassResult.completed,
            retried: this.lastPassResult.retried,
            failed: this.lastPassResult.failed,
            proposals: this.lastPassResult.proposals,
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
    const job = await this.options.deliveryStore.enqueueMemoryWrapup({
      thread: run.thread,
      sourceRunId: run.id,
      debounceMs: this.options.debounceMs,
      maxAttempts: this.options.maxAttempts,
    });
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
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      proposals: 0,
      pruned: 0,
      jobs: [],
    };
  }

  private async executePass(): Promise<MemoryWrapupPassResult> {
    const claimed = await this.options.deliveryStore.claimMemoryWrapups({
      workerId: this.options.workerId,
      limit: this.options.batchSize,
      staleMs: this.options.staleMs,
    });
    const result: MemoryWrapupPassResult = {
      ...this.emptyResult(),
      claimed: claimed.length,
    };
    for (const job of claimed) {
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
        await this.options.deliveryStore.appendAgentRunEvent(
          job.sourceRunId,
          'memory_wrapup_started',
          {
            message: 'Automatic memory wrapup started.',
            metadata: { memoryWrapupJobId: job.id, attempt: job.attempts },
          },
        );
        const status = this.options.analysisService.status();
        const pendingTranscript = await this.options.deliveryStore.loadThreadTranscript({
          thread: job.thread,
          maxEntries: status.maxEntries,
          maxChars: status.maxChars,
          afterCursor: job.cursor,
          order: 'oldest',
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
          await this.options.deliveryStore.appendAgentRunEvent(
            job.sourceRunId,
            'memory_wrapup_completed',
            {
              message: 'Automatic memory wrapup found no new transcript entries.',
              metadata: { memoryWrapupJobId: job.id, transcriptEntries: 0 },
            },
          );
          result.completed += 1;
          if (completed) result.jobs.push(completed);
          continue;
        }
        const report = await this.options.analysisService.analyze({
          workspaceId: job.workspaceId!,
          projectId: job.projectId,
          runId: job.sourceRunId,
          thread: job.thread,
          afterCursor: job.cursor,
          transcriptOrder: 'oldest',
          actorId: 'system:memory-wrapup',
          purpose: 'memory_wrapup',
          usageRecordKey: `memory_wrapup:${job.id}:attempt:${job.attempts}`,
        });
        const completed = await this.options.deliveryStore.completeMemoryWrapup(
          job.id,
          {
            cursor: report.transcript.nextCursor,
            proposalIds: report.proposed.map((proposal) => proposal.id),
            transcriptEntries: report.transcript.entries,
            transcriptOmittedEntries: report.transcript.omittedEntries,
          },
        );
        await this.options.deliveryStore.appendAgentRunEvent(
          job.sourceRunId,
          'memory_wrapup_completed',
          {
            message: `Automatic memory wrapup queued ${report.proposed.length} proposal(s).`,
            metadata: {
              memoryWrapupJobId: job.id,
              analysisId: report.id,
              proposalIds: report.proposed.map((proposal) => proposal.id),
              transcriptEntries: report.transcript.entries,
              transcriptOmittedEntries: report.transcript.omittedEntries,
            },
          },
        );
        result.completed += 1;
        result.proposals += report.proposed.length;
        if (completed) result.jobs.push(completed);
        if (report.proposed.length && this.options.onProposals) {
          try {
            await this.options.onProposals({
              job: completed ?? job,
              report,
              proposals: report.proposed,
            });
          } catch (error) {
            await this.options.deliveryStore.appendAgentRunEvent(
              job.sourceRunId,
              'log',
              {
                message: `Automatic memory proposal notification failed: ${error instanceof Error ? error.message : String(error)}`,
                metadata: {
                  level: 'warn',
                  memoryWrapupJobId: job.id,
                  proposalIds: report.proposed.map((proposal) => proposal.id),
                },
              },
            );
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
        await this.options.deliveryStore.appendAgentRunEvent(
          job.sourceRunId,
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
    this.passCount += 1;
    this.lastPassAt = new Date().toISOString();
    this.lastPassResult = structuredClone(result);
    return result;
  }
}
