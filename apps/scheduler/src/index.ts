import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlatformKind } from '@opentag/core';
import type { LarkOpenApiDomain } from '@opentag/platform-lark';
import {
  RoutineSchedulerService,
  createOpenTagWorkerHost,
  type RoutineTickResult,
  type WorkflowCoordinatorTickResult,
} from '@opentag/runtime-host';

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

function larkDomainValue(value: string | undefined): LarkOpenApiDomain {
  return value === 'lark' ? 'lark' : 'feishu';
}

function log(event: string, payload: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      at: new Date().toISOString(),
      service: 'opentag-scheduler',
      event,
      ...payload,
    })}\n`,
  );
}

function tickSummary(result: RoutineTickResult): Record<string, unknown> {
  return {
    tickAt: result.at,
    staged: result.staged,
    claimed: result.claimed,
    queued: result.queued,
    failed: result.failed,
    reconciled: result.reconciled,
    executionIds: result.executionIds,
    runIds: result.runIds,
  };
}

function workflowTickSummary(
  result: WorkflowCoordinatorTickResult,
): Record<string, unknown> {
  return {
    tickAt: result.at,
    claimed: result.claimed,
    queued: result.queued,
    failed: result.failed,
    reconciled: result.reconciled,
    executionIds: result.executionIds,
    nodeExecutionIds: result.nodeExecutionIds,
    runIds: result.runIds,
  };
}

async function main(): Promise<void> {
  const routinesEnabled = booleanEnv('OPENTAG_ROUTINES_ENABLED', true);
  const workflowsEnabled = booleanEnv('OPENTAG_WORKFLOWS_ENABLED', true);
  if (!routinesEnabled && !workflowsEnabled) {
    log('disabled');
    return;
  }
  const storageDriver = (
    process.env.OPENTAG_STORAGE_DRIVER || 'sqlite'
  ).toLowerCase();
  if (storageDriver !== 'sqlite') {
    throw new Error('standalone_scheduler_requires_sqlite_storage');
  }
  const dataDir = process.env.OPENTAG_DATA_DIR || path.resolve('data');
  const routineIntervalMs = numberEnv(
    'OPENTAG_ROUTINE_TICK_INTERVAL_MS',
    30_000,
  );
  const workflowIntervalMs = numberEnv(
    'OPENTAG_WORKFLOW_TICK_INTERVAL_MS',
    2_000,
  );
  const claimStaleMs = numberEnv(
    'OPENTAG_ROUTINE_CLAIM_STALE_MS',
    120_000,
  );
  const batchSize = Math.min(
    100,
    numberEnv('OPENTAG_ROUTINE_BATCH_SIZE', 100),
  );
  const workflowClaimStaleMs = numberEnv(
    'OPENTAG_WORKFLOW_CLAIM_STALE_MS',
    120_000,
  );
  const workflowBatchSize = Math.min(
    100,
    numberEnv('OPENTAG_WORKFLOW_BATCH_SIZE', 20),
  );
  const once = booleanEnv('OPENTAG_SCHEDULER_ONCE');
  const host = createOpenTagWorkerHost({
    dataDir,
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
    routines: {
      defaultTimeZone:
        process.env.OPENTAG_DEFAULT_TIME_ZONE || 'Asia/Shanghai',
    },
    workflows: {
      claimStaleMs: workflowClaimStaleMs,
      batchSize: workflowBatchSize,
    },
    storage: {
      driver: 'sqlite',
      databasePath: process.env.OPENTAG_SQLITE_PATH,
      busyTimeoutMs: numberEnv('OPENTAG_SQLITE_BUSY_TIMEOUT_MS', 5_000),
    },
  });
  const transportModeForPlatform = (platform: PlatformKind): string => {
    if (platform === 'lark') {
      return `lark-${host.larkTransportStatus().mode}`;
    }
    if (platform === 'telegram') {
      return `telegram-${host.telegramTransportStatus().mode}`;
    }
    return 'tracked-text';
  };
  const scheduler = new RoutineSchedulerService({
    routineStore: host.routineStore,
    deliveryStore: host.deliveryStore,
    threadConfigStore: host.threadConfigStore,
    schedulerId:
      process.env.OPENTAG_SCHEDULER_ID || `opentag-scheduler-${process.pid}`,
    claimStaleMs,
    batchSize,
    transportModeForPlatform,
  });

  let stopping = false;
  const stopController = new AbortController();
  const stop = (): void => {
    stopping = true;
    stopController.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  log('started', {
    dataDir,
    schedulerId:
      process.env.OPENTAG_SCHEDULER_ID || `opentag-scheduler-${process.pid}`,
    routineIntervalMs,
    workflowIntervalMs,
    claimStaleMs,
    batchSize,
    routinesEnabled,
    workflowsEnabled,
    workflowClaimStaleMs,
    workflowBatchSize,
    once,
    storage: host.storageStatus(),
  });

  let nextRoutineTickAt = 0;
  let nextWorkflowTickAt = 0;
  do {
    const now = Date.now();
    if (routinesEnabled && (once || now >= nextRoutineTickAt)) {
      const result = await scheduler.tick();
      nextRoutineTickAt = Date.now() + routineIntervalMs;
      if (
        once ||
        result.staged > 0 ||
        result.claimed > 0 ||
        result.reconciled > 0
      ) {
        log('scheduler_tick', tickSummary(result));
      }
    }
    if (workflowsEnabled && (once || now >= nextWorkflowTickAt)) {
      const result = await host.runWorkflowCoordinatorTick();
      nextWorkflowTickAt = Date.now() + workflowIntervalMs;
      if (
        once ||
        result.claimed > 0 ||
        result.reconciled > 0
      ) {
        log('workflow_tick', workflowTickSummary(result));
      }
    }
    if (once || stopping) break;
    const nextTickAt = Math.min(
      ...(routinesEnabled ? [nextRoutineTickAt] : []),
      ...(workflowsEnabled ? [nextWorkflowTickAt] : []),
    );
    const waitMs = Math.max(50, nextTickAt - Date.now());
    try {
      await delay(waitMs, undefined, { signal: stopController.signal });
    } catch (error) {
      if (!stopController.signal.aborted) throw error;
    }
  } while (!stopping);

  const storage = host.storageStatus();
  host.close();
  log('stopped', { storage });
}

main().catch((error) => {
  log('fatal', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
