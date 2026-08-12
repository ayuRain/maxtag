import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  collectOpenTagMetricsSnapshot,
  createOpenTagWorkerHost,
  startOpenTagObservabilityServer,
  type AgentWorkerPassResult,
} from '@opentag/runtime-host';
import type { LarkOpenApiDomain } from '@opentag/platform-lark';

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function storageDriver(): 'file' | 'sqlite' {
  const value = (process.env.OPENTAG_STORAGE_DRIVER || 'sqlite').toLowerCase();
  if (value === 'file' || value === 'sqlite') return value;
  throw new Error('OPENTAG_STORAGE_DRIVER must be sqlite or file.');
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
    requeued: result.requeued,
    superseded: result.superseded,
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
  const startedAt = new Date().toISOString();
  const dataDir = process.env.OPENTAG_DATA_DIR || path.resolve('data');
  const intervalMs = numberEnv('OPENTAG_WORKER_INTERVAL_MS', 2000);
  const batchSize = numberEnv('OPENTAG_WORKER_BATCH', 1);
  const staleMs = numberEnv(
    'OPENTAG_WORKER_STALE_MS',
    numberEnv('OPENTAG_AGENT_WORKER_STALE_MS', 120_000),
  );
  const heartbeatMs = Math.max(
    250,
    Math.min(
      numberEnv('OPENTAG_AGENT_RUN_HEARTBEAT_MS', 15_000),
      Math.floor(staleMs / 3),
    ),
  );
  const once = booleanEnv('OPENTAG_WORKER_ONCE');
  const observabilityPort = optionalNumberEnv(
    'OPENTAG_WORKER_OBSERVABILITY_PORT',
  );
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
    telegram: {
      transportMode: process.env.OPENTAG_TELEGRAM_TRANSPORT,
      botToken: process.env.OPENTAG_TELEGRAM_BOT_TOKEN,
      baseUrl: process.env.OPENTAG_TELEGRAM_BASE_URL,
    },
    github: {
      transportMode: process.env.OPENTAG_GITHUB_TRANSPORT,
      token:
        process.env.OPENTAG_GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITHUB_TOKEN,
      baseUrl: process.env.OPENTAG_GITHUB_BASE_URL,
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
      sessionMode:
        process.env.OPENTAG_EXECUTOR_SESSION_MODE === 'transcript'
          ? 'transcript'
          : 'provider',
      sessionNamespace: process.env.OPENTAG_EXECUTOR_SESSION_NAMESPACE,
      transcriptMaxEntries: optionalNumberEnv(
        'OPENTAG_THREAD_CONTEXT_MAX_ENTRIES',
      ),
      transcriptMaxChars: optionalNumberEnv(
        'OPENTAG_THREAD_CONTEXT_MAX_CHARS',
      ),
      artifactRoot: process.env.OPENTAG_ARTIFACT_ROOT,
      maxArtifactBytes: optionalNumberEnv('OPENTAG_MAX_ARTIFACT_BYTES'),
      maxArtifacts: optionalNumberEnv('OPENTAG_MAX_ARTIFACTS'),
    },
    routines: {
      defaultTimeZone:
        process.env.OPENTAG_DEFAULT_TIME_ZONE || 'Asia/Shanghai',
    },
    storage: {
      driver: storageDriver(),
      databasePath: process.env.OPENTAG_SQLITE_PATH,
      busyTimeoutMs: optionalNumberEnv('OPENTAG_SQLITE_BUSY_TIMEOUT_MS'),
    },
    toolBroker: {
      githubToken:
        process.env.OPENTAG_GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITHUB_TOKEN,
      maxCallsPerRun: optionalNumberEnv('OPENTAG_TOOL_MAX_CALLS_PER_RUN'),
      callTimeoutMs: optionalNumberEnv('OPENTAG_TOOL_CALL_TIMEOUT_MS'),
    },
    runControlPollMs: optionalNumberEnv('OPENTAG_RUN_CONTROL_POLL_MS'),
    runHeartbeatMs: heartbeatMs,
  });

  let stopping = false;
  const stopController = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    stopController.abort();
    host.beginShutdown(signal.toLowerCase());
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  let observability:
    | Awaited<ReturnType<typeof startOpenTagObservabilityServer>>
    | undefined;
  try {
    observability = observabilityPort
      ? await startOpenTagObservabilityServer({
        host: process.env.OPENTAG_OBSERVABILITY_HOST,
        port: observabilityPort,
        service: 'opentag-worker',
        metricsToken: process.env.OPENTAG_METRICS_TOKEN,
        health: () => ({
          stopping,
          workerId: host.workerId,
          activeRuns: host.activeRunCount,
          passRunning: host.passRunning,
          passCount: host.passCount,
          lastPassAt: host.lastPassAt,
          storage: host.storageStatus(),
        }),
        metrics: () =>
          collectOpenTagMetricsSnapshot({
            process: {
              service: 'opentag-worker',
              startedAt,
              activeRuns: host.activeRunCount,
              storage: host.storageStatus(),
              loops: [
                {
                  name: 'agent_worker',
                  running: host.passRunning,
                  lastRunAt: host.lastPassAt,
                  iterations: host.passCount,
                  lastItems: host.lastPassResult
                    ? {
                        claimed: host.lastPassResult.claimed,
                        completed: host.lastPassResult.completed,
                        failed: host.lastPassResult.failed,
                        requeued: host.lastPassResult.requeued,
                        superseded: host.lastPassResult.superseded,
                      }
                    : undefined,
                },
              ],
            },
            deliveryStore: host.deliveryStore,
            routineStore: host.routineStore,
            workflowStore: host.workflowStore,
          }),
        })
      : undefined;

    log('started', {
      dataDir,
      workerId: host.workerId,
      intervalMs,
      batchSize,
      staleMs,
      heartbeatMs,
      once,
      larkTransport: host.larkTransportStatus(),
      telegramTransport: host.telegramTransportStatus(),
      githubTransport: host.githubTransportStatus(),
      executors: host.executorStatus(),
      storage: host.storageStatus(),
      observability: observability
        ? { host: observability.host, port: observability.port }
        : undefined,
    });

    if (!stopping) {
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
    }

    while (!stopping) {
      const result = await host.runAgentWorkerPass(batchSize);
      if (result.claimed > 0 || once) {
        log('worker_pass', passSummary(result));
      }
      if (once || stopping) break;
      try {
        await delay(intervalMs, undefined, { signal: stopController.signal });
      } catch (error) {
        if (!stopController.signal.aborted) throw error;
      }
    }
  } finally {
    const storage = host.storageStatus();
    host.beginShutdown('worker_loop_stopped');
    try {
      await host.waitForIdle();
    } finally {
      try {
        await observability?.close();
      } finally {
        host.close();
        log('stopped', {
          activeRuns: host.activeRunCount,
          storage,
        });
      }
    }
  }
}

main().catch((error) => {
  log('fatal', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
