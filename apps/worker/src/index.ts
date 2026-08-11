import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createOpenTagWorkerHost,
  type AgentWorkerPassResult,
} from '@opentag/runtime-host';
import type { LarkOpenApiDomain } from '@opentag/platform-lark';

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

function optionalNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function listEnv(name: string): string[] | undefined {
  const values = process.env[name]
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values?.length ? values : undefined;
}

function executorMode(): 'dry-run' | 'local-cli' {
  return process.env.OPENTAG_EXECUTOR_MODE === 'local-cli'
    ? 'local-cli'
    : 'dry-run';
}

function larkDomainValue(value: string | undefined): LarkOpenApiDomain {
  return value === 'lark' ? 'lark' : 'feishu';
}

function log(event: string, payload: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      service: 'opentag-worker',
      event,
      ...payload,
    })}\n`,
  );
}

function passSummary(result: AgentWorkerPassResult): Record<string, unknown> {
  return {
    claimed: result.claimed,
    completed: result.completed,
    failed: result.failed,
    runs: result.runs.map((run) => ({
      id: run.id,
      status: run.status,
      platform: run.platform,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      threadId: run.threadId,
    })),
  };
}

async function main(): Promise<void> {
  const dataDir = process.env.OPENTAG_DATA_DIR || path.resolve('data');
  const intervalMs = numberEnv('OPENTAG_WORKER_INTERVAL_MS', 2000);
  const batchSize = numberEnv('OPENTAG_WORKER_BATCH', 1);
  const staleMs = numberEnv('OPENTAG_WORKER_STALE_MS', 120_000);
  const once = booleanEnv('OPENTAG_WORKER_ONCE');
  const host = createOpenTagWorkerHost({
    dataDir,
    workerId: process.env.OPENTAG_WORKER_ID,
    lark: {
      transportMode: process.env.OPENTAG_LARK_TRANSPORT,
      appId: process.env.OPENTAG_LARK_APP_ID,
      appSecret: process.env.OPENTAG_LARK_APP_SECRET,
      domain: larkDomainValue(process.env.OPENTAG_LARK_DOMAIN),
      baseUrl: process.env.OPENTAG_LARK_BASE_URL,
    },
    executors: {
      mode: executorMode(),
      workspaceRoot: process.env.OPENTAG_EXECUTOR_WORKSPACE_ROOT,
      timeoutMs: optionalNumberEnv('OPENTAG_EXECUTOR_TIMEOUT_MS'),
      maxOutputBytes: optionalNumberEnv('OPENTAG_EXECUTOR_MAX_OUTPUT_BYTES'),
      inheritEnv: listEnv('OPENTAG_EXECUTOR_INHERIT_ENV'),
      codexCommand: process.env.OPENTAG_CODEX_COMMAND,
      codexModel: process.env.OPENTAG_CODEX_MODEL,
      claudeCommand: process.env.OPENTAG_CLAUDE_COMMAND,
      claudeModel: process.env.OPENTAG_CLAUDE_MODEL,
      claudeMaxBudgetUsd: optionalNumberEnv('OPENTAG_CLAUDE_MAX_BUDGET_USD'),
    },
  });

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  log('started', {
    dataDir,
    workerId: host.workerId,
    intervalMs,
    batchSize,
    staleMs,
    once,
    larkTransport: host.larkTransportStatus(),
    executors: host.executorStatus(),
  });

  const recovered = await host.recoverStaleAgentRuns({
    olderThanMs: staleMs,
    reason: 'standalone_worker_startup_recovered_stale_run',
  });
  if (recovered.requeued > 0 || recovered.cancelled > 0) {
    log('startup_recovery', {
      requeued: recovered.requeued,
      cancelled: recovered.cancelled,
      runs: recovered.records.map((run) => run.id),
    });
  }

  do {
    const result = await host.runAgentWorkerPass(batchSize);
    if (result.claimed > 0 || once) {
      log('worker_pass', passSummary(result));
    }
    if (once || stopping) break;
    await delay(intervalMs);
  } while (!stopping);

  log('stopped', {
    activeRuns: host.activeRunCount,
  });
}

main().catch((error) => {
  log('fatal', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
