#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

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
  const control = argValue('--control') === 'takeover' ? 'takeover' : 'stop';
  return {
    control,
    serverUrl: (argValue('--server-url') || env('OPENTAG_SERVER_URL', 'http://127.0.0.1:3077')).replace(/\/$/u, ''),
    bridgeHealthUrl:
      argValue('--bridge-health-url') ||
      env('OPENTAG_LARK_BRIDGE_HEALTH_URL', 'http://127.0.0.1:3080/health'),
    workspaceId:
      argValue('--workspace-id') || env('OPENTAG_LARK_WORKSPACE_ID', 'dev-workspace'),
    projectId: argValue('--project-id') || env('OPENTAG_LARK_PROJECT_ID'),
    chatId: argValue('--chat-id') || env('OPENTAG_LARK_SMOKE_CHAT_ID'),
    runId: argValue('--run-id'),
    verifyExisting: process.argv.includes('--verify-existing'),
    token: argValue('--token') || env('OPENTAG_OPERATOR_TOKEN'),
    timeoutMs: positiveInt(
      argValue('--timeout-ms') || env('OPENTAG_LARK_STOP_SMOKE_TIMEOUT_MS'),
      180_000,
    ),
    pollMs: positiveInt(
      argValue('--poll-ms') || env('OPENTAG_LARK_STOP_SMOKE_POLL_MS'),
      500,
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

async function getJson(url, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    throw new Error(body.error || body.message || `HTTP ${response.status}`);
  }
  return body;
}

async function waitFor(label, cfg, deadline, probe) {
  let latest;
  while (Date.now() < deadline) {
    latest = await probe();
    if (latest?.ready) return latest.value;
    await sleep(cfg.pollMs);
  }
  throw new Error(`${label}_timeout`);
}

function actionConsumer(health) {
  return health?.eventKeys?.find((item) => item.eventKey === 'card.action.trigger');
}

async function bridgeHealth(cfg) {
  const health = await getJson(cfg.bridgeHealthUrl);
  const action = actionConsumer(health);
  if (!health.ok || !action?.running || !action?.ready) {
    throw new Error('lark_card_action_consumer_not_ready');
  }
  return { health, action };
}

function runsUrl(cfg) {
  const url = new URL(`${cfg.serverUrl}/v1/runs`);
  url.searchParams.set('workspaceId', cfg.workspaceId);
  if (cfg.projectId) url.searchParams.set('projectId', cfg.projectId);
  url.searchParams.set('limit', '100');
  return url;
}

function deliveriesUrl(cfg) {
  const url = new URL(`${cfg.serverUrl}/v1/deliveries`);
  url.searchParams.set('workspaceId', cfg.workspaceId);
  url.searchParams.set('limit', '200');
  return url;
}

function runDetailUrl(cfg, runId) {
  return `${cfg.serverUrl}/v1/runs/${encodeURIComponent(runId)}/events?limit=200`;
}

function auditUrl(cfg) {
  const url = new URL(`${cfg.serverUrl}/v1/audit`);
  url.searchParams.set('workspaceId', cfg.workspaceId);
  if (cfg.projectId) url.searchParams.set('projectId', cfg.projectId);
  url.searchParams.set('action', 'human_takeover');
  url.searchParams.set('limit', '100');
  return url;
}

function activeStatus(status) {
  return status === 'queued' || status === 'running' || status === 'cancel_requested';
}

function findTargetRun(runs, cfg, startedAt) {
  if (cfg.runId) return runs.find((run) => run.id === cfg.runId);
  const threshold = Date.parse(startedAt) - 2_000;
  return runs.find(
    (run) =>
      run.platform === 'lark' &&
      (!cfg.chatId || run.thread?.channelId === cfg.chatId) &&
      Date.parse(run.createdAt) >= threshold &&
      activeStatus(run.status),
  );
}

function progressReceipt(snapshot, runId) {
  return snapshot.outbox?.find(
    (item) =>
      item.runId === runId &&
      item.kind === 'lark.card.create' &&
      item.status === 'delivered' &&
      item.externalId,
  );
}

function terminalCardUpdate(snapshot, runId, cardId, actionDeliveredAt) {
  const threshold = Date.parse(actionDeliveredAt || '1970-01-01T00:00:00.000Z') - 1_000;
  return snapshot.outbox?.find(
    (item) =>
      item.runId === runId &&
      item.kind === 'lark.card.update' &&
      item.status === 'delivered' &&
      item.target?.cardId === cardId &&
      Date.parse(item.updatedAt || item.createdAt) >= threshold,
  );
}

function takeoverHandoff(snapshot, run, actionDeliveredAt) {
  const threshold = Date.parse(actionDeliveredAt || '1970-01-01T00:00:00.000Z') - 1_000;
  return snapshot.outbox?.find(
    (item) =>
      item.runId === run.id &&
      item.kind === 'lark.text' &&
      item.status === 'delivered' &&
      item.threadId === run.threadId &&
      item.target?.chatId === run.thread?.channelId &&
      item.target?.rootId === run.thread?.rootMessageId &&
      Date.parse(item.updatedAt || item.createdAt) >= threshold,
  );
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

async function main() {
  const cfg = config();
  if (!cfg.chatId && !cfg.runId) {
    throw new Error('set --chat-id=oc_xxx or --run-id=RUN_ID');
  }
  const startedAt = now();
  const deadline = Date.now() + cfg.timeoutMs;
  const baseline = await bridgeHealth(cfg);
  const baselineAction = {
    received: baseline.action.received || 0,
    delivered: baseline.action.delivered || 0,
    failed: baseline.action.failed || 0,
  };

  progress(cfg, 'Waiting for a new active Lark run...');
  const run = await waitFor('active_lark_run', cfg, deadline, async () => {
    const snapshot = await getJson(runsUrl(cfg), cfg.token);
    const found = findTargetRun(snapshot.runs || [], cfg, startedAt);
    if (found && !cfg.verifyExisting && !activeStatus(found.status)) {
      throw new Error(`target_run_finished_before_${cfg.control}:${found.status}`);
    }
    return { ready: Boolean(found), value: found };
  });

  const receipt = await waitFor('progress_card_receipt', cfg, deadline, async () => {
    const snapshot = await getJson(deliveriesUrl(cfg), cfg.token);
    const found = progressReceipt(snapshot, run.id);
    return { ready: Boolean(found), value: found };
  });
  let followUpSteering;
  if (cfg.control === 'takeover') {
    const baselineDetail = await getJson(runDetailUrl(cfg, run.id), cfg.token);
    const baselineSteeringIds = new Set(
      (baselineDetail.steering || []).map((item) => item.id),
    );
    if (!cfg.verifyExisting) {
      progress(
        cfg,
        `Run ${run.id} has active card ${receipt.externalId}. Send one follow-up in the same topic before taking over.`,
      );
    }
    followUpSteering = await waitFor('follow_up_steering', cfg, deadline, async () => {
      const detail = await getJson(runDetailUrl(cfg, run.id), cfg.token);
      const found = detail.steering?.find(
        (item) =>
          (cfg.verifyExisting ||
            (!cfg.runId && Date.parse(item.receivedAt) >= Date.parse(startedAt)) ||
            !baselineSteeringIds.has(item.id)) &&
          (item.status === 'pending' ||
            item.status === 'claimed' ||
            item.status === 'applied' ||
            item.status === 'cancelled'),
      );
      return { ready: Boolean(found), value: found };
    });
    if (!cfg.verifyExisting) {
      progress(
        cfg,
        `Follow-up ${followUpSteering.id} was observed (${followUpSteering.status}). Click Take over now.`,
      );
    }
  } else {
    progress(
      cfg,
      `Run ${run.id} has active card ${receipt.externalId}. Click Stop on that card now.`,
    );
  }

  const action = await waitFor('card_action_callback', cfg, deadline, async () => {
    const current = await bridgeHealth(cfg);
    if ((current.action.failed || 0) > baselineAction.failed) {
      throw new Error('card_action_callback_failed');
    }
    const received = cfg.verifyExisting
      ? (current.action.received || 0) > 0
      : (current.action.received || 0) > baselineAction.received;
    const delivered = cfg.verifyExisting
      ? (current.action.delivered || 0) > 0
      : (current.action.delivered || 0) > baselineAction.delivered;
    return { ready: received && delivered, value: current.action };
  });

  const cancelled = await waitFor('cancelled_run', cfg, deadline, async () => {
    const snapshot = await getJson(runsUrl(cfg), cfg.token);
    const found = snapshot.runs?.find((item) => item.id === run.id);
    if (
      found &&
      !cfg.verifyExisting &&
      (found.status === 'completed' || found.status === 'failed')
    ) {
      throw new Error(`target_run_finished_before_cancel:${found.status}`);
    }
    return { ready: found?.status === 'cancelled', value: found };
  });
  const expectedControl = cfg.control === 'takeover' ? 'human_takeover' : 'stop';
  const expectedCardSuffix = `:${receipt.externalId}:${expectedControl}`;
  const cancelledDetail = await getJson(runDetailUrl(cfg, run.id), cfg.token);
  const cardCancelEvent = cancelledDetail.events?.find(
    (item) =>
      item.type === 'cancel_requested' &&
      item.message?.startsWith('lark-card:') &&
      item.message.endsWith(expectedCardSuffix),
  );
  if (!cardCancelEvent) {
    throw new Error('target_run_cancelled_by_non_card_action');
  }

  const delivery = await waitFor('terminal_card_update', cfg, deadline, async () => {
    const snapshot = await getJson(deliveriesUrl(cfg), cfg.token);
    const update = terminalCardUpdate(
      snapshot,
      run.id,
      receipt.externalId,
      cardCancelEvent.at,
    );
    const failed = (snapshot.outbox || []).filter(
      (item) => item.runId === run.id && item.status === 'failed',
    );
    if (failed.length) throw new Error('run_delivery_failed');
    return { ready: Boolean(update), value: { update, failed: failed.length } };
  });

  let takeover;
  if (cfg.control === 'takeover') {
    takeover = await waitFor('human_takeover_evidence', cfg, deadline, async () => {
      const [detail, deliveries, audit] = await Promise.all([
        getJson(runDetailUrl(cfg, run.id), cfg.token),
        getJson(deliveriesUrl(cfg), cfg.token),
        getJson(auditUrl(cfg), cfg.token),
      ]);
      const event = detail.events?.find(
        (item) =>
          item.type === 'human_takeover' &&
          item.metadata?.cardMessageId === receipt.externalId,
      );
      const actorId = event?.metadata?.actorId;
      const finalSteering = detail.steering?.find(
        (item) => item.id === followUpSteering.id,
      );
      const followUpEvent =
        event &&
        finalSteering?.status === 'cancelled' &&
        finalSteering.lastError?.endsWith(`:${receipt.externalId}:human_takeover`)
          ? detail.events?.find(
              (item) =>
                item.type === 'steering_cancelled' &&
                item.metadata?.steeringId === followUpSteering.id &&
                item.sequence > event.sequence,
            )
          : event && finalSteering?.status === 'applied'
            ? detail.events?.find(
                (item) =>
                  item.type === 'steering_applied' &&
                  item.metadata?.steeringId === followUpSteering.id &&
                  item.sequence < event.sequence,
              )
            : undefined;
      const handoff = takeoverHandoff(deliveries, cancelled, cardCancelEvent.at);
      const auditEntry = audit.entries?.find(
        (item) =>
          item.runId === run.id &&
          item.action === 'human_takeover' &&
          item.actor === `lark:${actorId}` &&
          item.outcome === 'changed',
      );
      return {
        ready: Boolean(
          event && actorId && finalSteering && followUpEvent && handoff && auditEntry,
        ),
        value: {
          event,
          actorId,
          finalSteering,
          followUpEvent,
          handoff,
          auditEntry,
        },
      };
    });
  }

  const result = {
    event:
      cfg.control === 'takeover'
        ? 'opentag.smoke.lark-human-takeover'
        : 'opentag.smoke.lark-stop',
    schemaVersion: 1,
    tool:
      cfg.control === 'takeover'
        ? 'opentag-lark-takeover-smoke'
        : 'opentag-lark-stop-smoke',
    platform: 'lark',
    ok: true,
    startedAt,
    completedAt: now(),
    route: {
      workspaceId: cancelled.workspaceId,
      projectId: cancelled.projectId,
      chatId: cancelled.thread?.channelId,
      threadId: cancelled.threadId,
    },
    run: {
      id: cancelled.id,
      status: cancelled.status,
      cancellationSource:
        cfg.control === 'takeover'
          ? 'lark-card-human-takeover'
          : 'lark-card-action',
    },
    card: {
      messageId: receipt.externalId,
      createDeliveryId: receipt.id,
      terminalUpdateDeliveryId: delivery.update.id,
    },
    callback: {
      eventKey: 'card.action.trigger',
      evidenceMode: cfg.verifyExisting ? 'durable-replay' : 'live-counter-delta',
      baseline: baselineAction,
      final: {
        received: action.received || 0,
        delivered: action.delivered || 0,
        failed: action.failed || 0,
        lastDeliveredAt: action.lastDeliveredAt,
      },
    },
    ...(takeover
      ? {
          takeover: {
            actorId: takeover.actorId,
            actorDisplayName: takeover.event.metadata?.actorDisplayName,
            eventId: takeover.event.id,
            followUpSteeringId: followUpSteering.id,
            followUpStatusAtObservation: followUpSteering.status,
            followUpFinalStatus: takeover.finalSteering.status,
            followUpEvidenceEventId: takeover.followUpEvent.id,
            handoffDeliveryId: takeover.handoff.id,
            auditEntryId: takeover.auditEntry.id,
          },
        }
      : {}),
    checks: [
      'active_lark_run',
      'progress_card_receipt',
      ...(cfg.control === 'takeover' ? ['new_follow_up_observed'] : []),
      'card_action_callback',
      'cancelled_run',
      'same_card_terminal_update',
      ...(cfg.control === 'takeover'
        ? [
            'human_takeover_actor',
            'follow_up_fenced_before_takeover',
            'same_topic_handoff',
            'organization_audit',
          ]
        : []),
      'zero_failed_deliveries',
    ],
  };
  result.evidenceJsonl = await writeEvidence(cfg, result);
  process.stdout.write(`${JSON.stringify(result, null, cfg.json ? 2 : 2)}\n`);
}

main().catch(async (error) => {
  const cfg = config();
  const result = {
    event:
      cfg.control === 'takeover'
        ? 'opentag.smoke.lark-human-takeover'
        : 'opentag.smoke.lark-stop',
    schemaVersion: 1,
    tool:
      cfg.control === 'takeover'
        ? 'opentag-lark-takeover-smoke'
        : 'opentag-lark-stop-smoke',
    platform: 'lark',
    ok: false,
    failedAt: now(),
    error: error instanceof Error ? error.message : String(error),
  };
  try {
    result.evidenceJsonl = await writeEvidence(cfg, result);
  } catch (writeError) {
    result.evidenceError = writeError instanceof Error ? writeError.message : String(writeError);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
});
