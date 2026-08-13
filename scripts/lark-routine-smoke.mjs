#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

let createdRoutineId;
let executionObserved = false;

function argValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function config() {
  const chatId = argValue('--chat-id') || env('OPENTAG_LARK_SMOKE_CHAT_ID');
  const rootMessageId =
    argValue('--root-message-id') ||
    argValue('--thread-id') ||
    env('OPENTAG_LARK_SMOKE_THREAD_ID');
  return {
    serverUrl: (
      argValue('--server-url') ||
      env('OPENTAG_SERVER_URL', 'http://127.0.0.1:3077')
    ).replace(/\/$/u, ''),
    bridgeHealthUrl:
      argValue('--bridge-health-url') ||
      env('OPENTAG_LARK_BRIDGE_HEALTH_URL', 'http://127.0.0.1:3080/health'),
    workspaceId:
      argValue('--workspace-id') ||
      env('OPENTAG_LARK_WORKSPACE_ID', 'dev-workspace'),
    projectId:
      argValue('--project-id') || env('OPENTAG_LARK_PROJECT_ID', 'opentag'),
    chatId,
    rootMessageId,
    openTagThreadId:
      argValue('--opentag-thread-id') ||
      (chatId && rootMessageId ? `lark:${chatId}:${rootMessageId}` : undefined),
    visibility: argValue('--visibility') || 'private',
    token: argValue('--token') || env('OPENTAG_OPERATOR_TOKEN'),
    send: process.argv.includes('--send'),
    tick: process.argv.includes('--tick'),
    skipBridge: process.argv.includes('--skip-bridge'),
    delayMs: positiveInt(
      argValue('--delay-ms') || env('OPENTAG_LARK_ROUTINE_SMOKE_DELAY_MS'),
      3_000,
    ),
    timeoutMs: positiveInt(
      argValue('--timeout-ms') || env('OPENTAG_LARK_ROUTINE_SMOKE_TIMEOUT_MS'),
      10 * 60_000,
    ),
    pollMs: positiveInt(
      argValue('--poll-ms') || env('OPENTAG_LARK_ROUTINE_SMOKE_POLL_MS'),
      1_000,
    ),
    evidenceJsonl:
      argValue('--evidence-jsonl') || env('OPENTAG_SMOKE_EVIDENCE_JSONL'),
    json: process.argv.includes('--json'),
  };
}

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const headers = {
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.body ? { 'content-type': 'application/json' } : {}),
  };
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    throw new Error(body.error || body.message || `HTTP ${response.status}`);
  }
  return body;
}

function apiUrl(cfg, pathname, query = {}) {
  const url = new URL(`${cfg.serverUrl}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function waitFor(label, cfg, probe) {
  const deadline = Date.now() + cfg.timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await probe();
    if (latest?.ready) return latest.value;
    await sleep(cfg.pollMs);
  }
  throw new Error(`${label}_timeout`);
}

function evidencePath(value) {
  if (!value) return undefined;
  const resolved = path.resolve(process.cwd(), value);
  const relative = path.relative(process.cwd(), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('evidence_jsonl_must_be_inside_worktree');
  }
  return resolved;
}

async function writeEvidence(cfg, result) {
  const target = evidencePath(cfg.evidenceJsonl);
  if (!target) return undefined;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${JSON.stringify(result)}\n`, 'utf8');
  return path.relative(process.cwd(), target);
}

function progress(cfg, message) {
  if (!cfg.json) process.stderr.write(`${message}\n`);
}

function bridgeConsumersReady(health) {
  const keys = new Map(
    (health.eventKeys || []).map((item) => [item.eventKey, item]),
  );
  return ['im.message.receive_v1', 'card.action.trigger'].every(
    (key) => keys.get(key)?.running && keys.get(key)?.ready,
  );
}

async function preflight(cfg) {
  const health = await requestJson(`${cfg.serverUrl}/health`, { token: cfg.token });
  if (!health.ok) throw new Error('opentag_server_not_ready');
  if (health.clients?.lark?.mode !== 'http' || !health.clients?.lark?.hasCredentials) {
    throw new Error('opentag_lark_http_transport_not_ready');
  }
  let bridge;
  if (!cfg.skipBridge) {
    bridge = await requestJson(cfg.bridgeHealthUrl);
    if (!bridge.ok || !bridgeConsumersReady(bridge)) {
      throw new Error('opentag_lark_bridge_not_ready');
    }
  }
  const routines = await requestJson(
    apiUrl(cfg, '/v1/routines', {
      workspaceId: cfg.workspaceId,
      projectId: cfg.projectId,
    }),
    { token: cfg.token },
  );
  return { health, bridge, routines };
}

function assertRoute(run, cfg) {
  if (
    run.workspaceId !== cfg.workspaceId ||
    run.projectId !== cfg.projectId ||
    run.threadId !== cfg.openTagThreadId ||
    run.thread?.channelId !== cfg.chatId ||
    run.thread?.rootMessageId !== cfg.rootMessageId ||
    run.thread?.topicId !== cfg.rootMessageId ||
    run.thread?.visibility !== cfg.visibility
  ) {
    throw new Error('routine_run_route_mismatch');
  }
}

async function main() {
  const cfg = config();
  const startedAt = now();
  const preflightResult = await preflight(cfg);
  const scheduler = preflightResult.routines.scheduler || {};
  const base = {
    event: 'opentag.smoke.lark-routine',
    schemaVersion: 1,
    tool: 'opentag-lark-routine-smoke',
    platform: 'lark',
    startedAt,
    route: {
      workspaceId: cfg.workspaceId,
      projectId: cfg.projectId,
      chatId: cfg.chatId,
      rootMessageId: cfg.rootMessageId,
      threadId: cfg.openTagThreadId,
      visibility: cfg.visibility,
    },
    scheduler: {
      enabled: Boolean(scheduler.enabled),
      mode: scheduler.mode,
      tickIntervalMs: scheduler.tickIntervalMs,
    },
    bridge: preflightResult.bridge
      ? {
          ready: true,
          eventKeys: preflightResult.bridge.eventKeys.map((item) => ({
            eventKey: item.eventKey,
            running: item.running,
            ready: item.ready,
            received: item.received,
            delivered: item.delivered,
            failed: item.failed,
          })),
        }
      : { skipped: true },
  };

  if (!cfg.send) {
    const result = {
      ...base,
      ok: true,
      sent: false,
      completedAt: now(),
      checks: ['server_ready', 'lark_transport_ready', 'bridge_ready', 'scheduler_observed'],
    };
    result.evidenceJsonl = await writeEvidence(cfg, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (!cfg.chatId || !cfg.rootMessageId || !cfg.openTagThreadId) {
    throw new Error('live_send_requires_chat_root_and_opentag_thread');
  }
  if ((!scheduler.enabled || scheduler.mode === 'manual') && !cfg.tick) {
    throw new Error('manual_scheduler_requires_explicit_tick');
  }
  if (cfg.tick) {
    const dueExisting = (preflightResult.routines.routines || []).find(
      (routine) =>
        routine.enabled &&
        routine.nextRunAt &&
        Date.parse(routine.nextRunAt) <= Date.now() + cfg.delayMs + 2_000,
    );
    if (dueExisting) throw new Error('manual_tick_would_advance_existing_due_routine');
  }

  const dueAt = new Date(Date.now() + cfg.delayMs).toISOString();
  const name = `MaxTag Lark routine smoke ${startedAt}`;
  progress(cfg, `Creating one-time follow-up for ${dueAt}...`);
  const created = await requestJson(apiUrl(cfg, '/v1/routines'), {
    method: 'POST',
    token: cfg.token,
    body: {
      workspaceId: cfg.workspaceId,
      projectId: cfg.projectId,
      name,
      instructions:
        '这是 MaxTag 一次性 follow-up 实机验证。请简短确认任务已按时执行，并说明当前 workspace、project 与 Lark topic 路由。',
      enabled: true,
      schedule: { kind: 'once', at: dueAt },
      destination: {
        platform: 'lark',
        externalId: `${cfg.chatId}:${cfg.rootMessageId}`,
        channelId: cfg.chatId,
        threadId: cfg.openTagThreadId,
        rootMessageId: cfg.rootMessageId,
        topicId: cfg.rootMessageId,
        visibility: cfg.visibility,
        title: 'MaxTag',
      },
    },
  });
  const routine = created.routine;
  createdRoutineId = routine.id;

  const waitMs = Math.max(0, Date.parse(dueAt) - Date.now() + 50);
  if (waitMs) await sleep(waitMs);
  if (cfg.tick) {
    progress(cfg, 'Advancing the manual development scheduler once...');
    await requestJson(apiUrl(cfg, '/v1/routines/tick'), {
      method: 'POST',
      token: cfg.token,
      body: {},
    });
  }

  progress(cfg, 'Waiting for the scheduled execution and agent run...');
  const settled = await waitFor('routine_execution', cfg, async () => {
    const snapshot = await requestJson(
      apiUrl(cfg, '/v1/routines', {
        workspaceId: cfg.workspaceId,
        projectId: cfg.projectId,
      }),
      { token: cfg.token },
    );
    const executions = (snapshot.executions || []).filter(
      (item) => item.routineId === routine.id,
    );
    if (executions.length > 1) throw new Error('one_time_routine_executed_more_than_once');
    const execution = executions[0];
    if (execution) executionObserved = true;
    if (execution?.status === 'failed' || execution?.status === 'cancelled') {
      throw new Error(`routine_execution_${execution.status}:${execution.error || ''}`);
    }
    return {
      ready: execution?.status === 'completed',
      value: { snapshot, execution },
    };
  });
  const finalRoutine = settled.snapshot.routines.find((item) => item.id === routine.id);
  if (!finalRoutine || finalRoutine.enabled || finalRoutine.nextRunAt) {
    throw new Error('one_time_routine_not_atomically_disabled');
  }

  const run = await waitFor('routine_agent_run', cfg, async () => {
    const snapshot = await requestJson(
      apiUrl(cfg, '/v1/runs', {
        workspaceId: cfg.workspaceId,
        projectId: cfg.projectId,
        limit: 100,
      }),
      { token: cfg.token },
    );
    const found = (snapshot.runs || []).find(
      (item) => item.id === settled.execution.runId,
    );
    if (found?.status === 'failed' || found?.status === 'cancelled') {
      throw new Error(`routine_agent_run_${found.status}:${found.lastError || ''}`);
    }
    return { ready: found?.status === 'completed', value: found };
  });
  assertRoute(run, cfg);

  const delivery = await waitFor('routine_lark_delivery', cfg, async () => {
    const snapshot = await requestJson(
      apiUrl(cfg, '/v1/deliveries', {
        workspaceId: cfg.workspaceId,
        limit: 200,
      }),
      { token: cfg.token },
    );
    const failed = (snapshot.outbox || []).filter(
      (item) => item.runId === run.id && item.status === 'failed',
    );
    if (failed.length) throw new Error('routine_lark_delivery_failed');
    const text = (snapshot.outbox || []).find(
      (item) =>
        item.runId === run.id &&
        item.kind === 'lark.text' &&
        item.status === 'delivered' &&
        item.target?.chatId === cfg.chatId &&
        item.target?.rootId === cfg.rootMessageId,
    );
    return { ready: Boolean(text), value: { text, failed } };
  });

  const result = {
    ...base,
    ok: true,
    sent: true,
    completedAt: now(),
    routine: {
      id: finalRoutine.id,
      schedule: finalRoutine.schedule,
      enabled: finalRoutine.enabled,
      executionCount: 1,
    },
    execution: {
      id: settled.execution.id,
      status: settled.execution.status,
      trigger: settled.execution.trigger,
      runId: settled.execution.runId,
    },
    run: { id: run.id, status: run.status },
    delivery: { id: delivery.text.id, kind: delivery.text.kind, status: delivery.text.status },
    checks: [
      'server_ready',
      'lark_transport_ready',
      'bridge_ready',
      'one_time_routine_created',
      'one_time_routine_disabled_after_stage',
      'single_execution_observed',
      'agent_run_completed',
      'workspace_project_topic_route_preserved',
      'lark_text_delivered_to_original_topic',
      'zero_failed_run_deliveries',
    ],
  };
  result.evidenceJsonl = await writeEvidence(cfg, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(async (error) => {
  const cfg = config();
  let cleanup;
  if (createdRoutineId && !executionObserved) {
    try {
      await requestJson(apiUrl(cfg, `/v1/routines/${encodeURIComponent(createdRoutineId)}`), {
        method: 'DELETE',
        token: cfg.token,
      });
      cleanup = 'unexecuted_routine_deleted';
    } catch (cleanupError) {
      cleanup = `cleanup_failed:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
  }
  const result = {
    event: 'opentag.smoke.lark-routine',
    schemaVersion: 1,
    tool: 'opentag-lark-routine-smoke',
    platform: 'lark',
    ok: false,
    failedAt: now(),
    routineId: createdRoutineId,
    cleanup,
    error: error instanceof Error ? error.message : String(error),
  };
  try {
    result.evidenceJsonl = await writeEvidence(cfg, result);
  } catch (writeError) {
    result.evidenceError =
      writeError instanceof Error ? writeError.message : String(writeError);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
});
