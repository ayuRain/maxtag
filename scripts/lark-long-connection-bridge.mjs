#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FileLarkBotCredentialStore } from '@opentag/config';

function argValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function argValues(name) {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .filter((arg) => arg.startsWith(prefix))
    .flatMap((arg) => arg.slice(prefix.length).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function createdAt(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

function now() {
  return new Date().toISOString();
}

function log(event, payload = {}) {
  process.stdout.write(
    `${JSON.stringify({
      at: now(),
      service: 'opentag-lark-bridge',
      event,
      ...payload,
    })}\n`,
  );
}

function escapeLabel(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function labelSet(labels) {
  const entries = Object.entries(labels || {})
    .filter((entry) => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length
    ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`
    : '';
}

function timestampSeconds(value) {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined;
}

function prometheusLine(name, labels, value) {
  return `${name}${labelSet(labels)} ${Number.isFinite(value) ? value : 0}`;
}

function createBridgeState(startedAt = now()) {
  return {
    startedAt,
    stopping: false,
    children: new Set(),
    eventKeys: new Map(),
    backfill: {
      enabled: false,
      running: false,
      attempts: 0,
      completed: 0,
      failed: 0,
      replayed: 0,
      duplicates: 0,
      truncated: false,
    },
  };
}

export { createBridgeState };

export function eventKeyState(state, eventKey) {
  if (!state.eventKeys.has(eventKey)) {
    state.eventKeys.set(eventKey, {
      eventKey,
      running: false,
      ready: false,
      restarts: 0,
      received: 0,
      delivered: 0,
      failed: 0,
      lastEventAt: undefined,
      lastDeliveredAt: undefined,
      lastErrorAt: undefined,
      lastError: undefined,
      lastExitCode: undefined,
    });
  }
  return state.eventKeys.get(eventKey);
}

export function bridgeHealth(state) {
  const eventKeys = [...state.eventKeys.values()];
  const ready = eventKeys.length > 0 && eventKeys.every((item) => item.ready);
  const running = eventKeys.length > 0 && eventKeys.every((item) => item.running);
  return {
    ok: !state.stopping && ready && running,
    service: 'opentag-lark-bridge',
    startedAt: state.startedAt,
    stopping: state.stopping,
    eventKeys,
    backfill: state.backfill,
  };
}

export function renderBridgeMetrics(state, at = new Date()) {
  const service = 'opentag-lark-bridge';
  const startedAt = timestampSeconds(state.startedAt);
  const lines = [
    '# HELP opentag_process_up Whether the MaxTag process is running.',
    '# TYPE opentag_process_up gauge',
    prometheusLine('opentag_process_up', { service }, 1),
  ];
  if (startedAt !== undefined) {
    lines.push(
      '# HELP opentag_process_start_time_seconds Unix timestamp when the MaxTag process started.',
      '# TYPE opentag_process_start_time_seconds gauge',
      prometheusLine('opentag_process_start_time_seconds', { service }, startedAt),
      '# HELP opentag_process_uptime_seconds MaxTag process uptime in seconds.',
      '# TYPE opentag_process_uptime_seconds gauge',
      prometheusLine(
        'opentag_process_uptime_seconds',
        { service },
        Math.max(0, at.getTime() / 1000 - startedAt),
      ),
    );
  }
  const eventKeys = [...state.eventKeys.values()];
  lines.push(
    '# HELP opentag_lark_bridge_event_key_running Whether a Lark bridge consumer process is running.',
    '# TYPE opentag_lark_bridge_event_key_running gauge',
    ...eventKeys.map((item) =>
      prometheusLine(
        'opentag_lark_bridge_event_key_running',
        { service, event_key: item.eventKey },
        item.running ? 1 : 0,
      ),
    ),
    '# HELP opentag_lark_bridge_event_key_ready Whether a Lark bridge consumer reached the ready marker.',
    '# TYPE opentag_lark_bridge_event_key_ready gauge',
    ...eventKeys.map((item) =>
      prometheusLine(
        'opentag_lark_bridge_event_key_ready',
        { service, event_key: item.eventKey },
        item.ready ? 1 : 0,
      ),
    ),
    '# HELP opentag_lark_bridge_events_received_total Lark long-connection events read by the bridge.',
    '# TYPE opentag_lark_bridge_events_received_total counter',
    ...eventKeys.map((item) =>
      prometheusLine(
        'opentag_lark_bridge_events_received_total',
        { service, event_key: item.eventKey },
        item.received,
      ),
    ),
    '# HELP opentag_lark_bridge_events_delivered_total Lark long-connection events delivered to MaxTag.',
    '# TYPE opentag_lark_bridge_events_delivered_total counter',
    ...eventKeys.map((item) =>
      prometheusLine(
        'opentag_lark_bridge_events_delivered_total',
        { service, event_key: item.eventKey },
        item.delivered,
      ),
    ),
    '# HELP opentag_lark_bridge_events_failed_total Lark long-connection events that failed bridge processing.',
    '# TYPE opentag_lark_bridge_events_failed_total counter',
    ...eventKeys.map((item) =>
      prometheusLine(
        'opentag_lark_bridge_events_failed_total',
        { service, event_key: item.eventKey },
        item.failed,
      ),
    ),
    '# HELP opentag_lark_bridge_backfill_running Whether periodic message recovery is running.',
    '# TYPE opentag_lark_bridge_backfill_running gauge',
    prometheusLine(
      'opentag_lark_bridge_backfill_running',
      { service },
      state.backfill.running ? 1 : 0,
    ),
    '# HELP opentag_lark_bridge_backfill_attempts_total Periodic message recovery attempts.',
    '# TYPE opentag_lark_bridge_backfill_attempts_total counter',
    prometheusLine(
      'opentag_lark_bridge_backfill_attempts_total',
      { service },
      state.backfill.attempts,
    ),
    '# HELP opentag_lark_bridge_backfill_completed_total Complete periodic message recoveries.',
    '# TYPE opentag_lark_bridge_backfill_completed_total counter',
    prometheusLine(
      'opentag_lark_bridge_backfill_completed_total',
      { service },
      state.backfill.completed,
    ),
    '# HELP opentag_lark_bridge_backfill_failed_total Failed or truncated periodic recoveries.',
    '# TYPE opentag_lark_bridge_backfill_failed_total counter',
    prometheusLine(
      'opentag_lark_bridge_backfill_failed_total',
      { service },
      state.backfill.failed,
    ),
    '# HELP opentag_lark_bridge_backfill_replayed_total Messages replayed through idempotent ingress.',
    '# TYPE opentag_lark_bridge_backfill_replayed_total counter',
    prometheusLine(
      'opentag_lark_bridge_backfill_replayed_total',
      { service },
      state.backfill.replayed,
    ),
    '# HELP opentag_lark_bridge_backfill_duplicates_total Replayed messages already present at ingress.',
    '# TYPE opentag_lark_bridge_backfill_duplicates_total counter',
    prometheusLine(
      'opentag_lark_bridge_backfill_duplicates_total',
      { service },
      state.backfill.duplicates,
    ),
  );
  return `${lines.join('\n')}\n`;
}

function bearerToken(request) {
  const match = /^Bearer\s+([^\s]+)$/iu.exec(request.headers.authorization || '');
  return match?.[1];
}

async function startObservabilityServer(cfg, state) {
  if (!cfg.observabilityPort) return undefined;
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const health = bridgeHealth(state);
      response.writeHead(health.ok ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(health));
      return;
    }
    if (request.url === '/metrics') {
      if (cfg.metricsToken && bearerToken(request) !== cfg.metricsToken) {
        response.writeHead(401, {
          'www-authenticate': 'Bearer realm="MaxTag metrics"',
        });
        response.end('metrics auth required\n');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(renderBridgeMetrics(state));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      cfg.observabilityPort,
      cfg.observabilityHost,
      () => resolve(),
    );
  });
  return {
    host: cfg.observabilityHost,
    port: cfg.observabilityPort,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseMentions(value) {
  return Array.isArray(value)
    ? value
        .map((mention) =>
          mention && typeof mention === 'object'
            ? {
                id: cleanString(mention.id),
                key: cleanString(mention.key),
                name: cleanString(mention.name),
              }
            : undefined,
        )
        .filter(Boolean)
    : [];
}

export function configuredEventKeys() {
  const explicit = argValues('--event-key');
  if (explicit.length) return explicit;
  const raw =
    env('OPENTAG_LARK_BRIDGE_EVENT_KEYS') ||
    env('OPENTAG_LARK_BRIDGE_EVENT_KEY');
  if (raw) {
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return ['im.message.receive_v1', 'card.action.trigger'];
}

export function larkEventToClientEvent(event, options = {}) {
  if (!event || typeof event !== 'object') {
    throw new Error('invalid_lark_event');
  }
  const chatId = cleanString(event.chat_id);
  const messageId = cleanString(event.message_id) || cleanString(event.id);
  if (!chatId || !messageId) {
    throw new Error('lark_chat_id_and_message_id_required');
  }
  const rootId =
    cleanString(event.root_id) ||
    cleanString(event.reply_to) ||
    messageId;
  const chatType = cleanString(event.chat_type);
  const isDirect = chatType === 'p2p';
  const externalId = isDirect ? chatId : `${chatId}:${rootId}`;
  const text = cleanString(event.content) || '';
  const mentions = parseMentions(event.mentions);
  const botOpenId = options.botOpenId;
  const mentionsAgent =
    chatType === 'p2p' ||
    (botOpenId
      ? mentions.some((mention) => mention.id === botOpenId)
      : /(^|\s)@(maxtag|opentag)\b/i.test(text));

  return {
    platform: 'lark',
    eventId: cleanString(event.event_id) || messageId,
    eventType: cleanString(event.type) || 'im.message.receive_v1',
    async: options.async ?? true,
    thread: {
      id: `lark:${externalId}`,
      platform: 'lark',
      externalId,
      workspaceId: options.workspaceId || 'dev-workspace',
      projectId: options.projectId,
      channelId: chatId,
      rootMessageId: isDirect ? undefined : rootId,
      topicId: isDirect ? undefined : cleanString(event.thread_id) || rootId,
      visibility: isDirect ? 'direct' : 'public',
      title: `Lark ${chatId}`,
      metadata: {
        ingress: 'lark-long-connection',
        chatType,
        larkThreadId: cleanString(event.thread_id),
        larkRootId: cleanString(event.root_id),
      },
    },
    message: {
      id: messageId,
      platform: 'lark',
      text,
      actor: {
        id: cleanString(event.sender_id) || 'unknown',
        platformUserId: cleanString(event.sender_id),
        isBot: cleanString(event.sender_type) === 'bot',
      },
      createdAt: createdAt(event.create_time || event.timestamp),
      mentionsAgent,
      replyToMessageId: cleanString(event.reply_to),
      metadata: {
        messageType: cleanString(event.message_type),
        mentions,
      },
    },
  };
}

function config() {
  const dataDir = env('OPENTAG_DATA_DIR') || path.resolve('data');
  return {
    dataDir,
    serverUrl:
      argValue('--server-url') ||
      env('OPENTAG_SERVER_URL') ||
      'http://127.0.0.1:3077',
    token:
      argValue('--token') ||
      env('OPENTAG_CLIENT_INGRESS_TOKEN') ||
      env('OPENTAG_OPERATOR_TOKEN'),
    workspaceId:
      argValue('--workspace-id') || env('OPENTAG_LARK_WORKSPACE_ID') || 'dev-workspace',
    projectId: argValue('--project-id') || env('OPENTAG_LARK_PROJECT_ID'),
    botOpenId:
      argValue('--bot-open-id') ||
      env('OPENTAG_LARK_BOT_OPEN_ID') ||
      env('OPENTAG_BOT_OPEN_ID'),
    maxEvents: positiveInt(
      argValue('--max-events') || env('OPENTAG_LARK_BRIDGE_MAX_EVENTS'),
      0,
    ),
    timeout:
      argValue('--timeout') ||
      env('OPENTAG_LARK_BRIDGE_TIMEOUT') ||
      undefined,
    eventKeys: configuredEventKeys(),
    larkCliProfile:
      argValue('--lark-cli-profile') || env('OPENTAG_LARK_CLI_PROFILE'),
    observabilityHost:
      argValue('--observability-host') ||
      env('OPENTAG_OBSERVABILITY_HOST') ||
      '127.0.0.1',
    observabilityPort: optionalPositiveInt(
      argValue('--observability-port') ||
        env('OPENTAG_LARK_BRIDGE_OBSERVABILITY_PORT'),
    ),
    metricsToken: env('OPENTAG_METRICS_TOKEN'),
    backfillEnabled: booleanValue(
      argValue('--backfill-enabled') ?? env('OPENTAG_LARK_BACKFILL_ENABLED'),
      true,
    ),
    backfillLookbackMs: positiveInt(
      argValue('--backfill-lookback-ms') ||
        env('OPENTAG_LARK_BACKFILL_LOOKBACK_MS'),
      10 * 60_000,
    ),
    backfillIntervalMs: positiveInt(
      argValue('--backfill-interval-ms') ||
        env('OPENTAG_LARK_BACKFILL_INTERVAL_MS'),
      60_000,
    ),
    backfillMaxMessages: positiveInt(
      argValue('--backfill-max-messages') ||
        env('OPENTAG_LARK_BACKFILL_MAX_MESSAGES'),
      1_000,
    ),
    backfillStateFile:
      argValue('--backfill-state-file') ||
      env('OPENTAG_LARK_BACKFILL_STATE_FILE') ||
      path.join(dataDir, 'lark-bridge-checkpoint.json'),
    dryRun: hasFlag('--dry-run'),
    json: hasFlag('--json'),
  };
}

async function runLarkCliConfig(args, input, home) {
  const child = spawn('lark-cli', args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-1_024);
  });
  child.stdin.end(input);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `lark_managed_profile_init_failed:${result.code ?? result.signal ?? 'unknown'}:${stderr.trim()}`,
    );
  }
}

export async function prepareManagedLarkProfile(cfg) {
  const credential = await new FileLarkBotCredentialStore(cfg.dataDir).get();
  if (!credential) return cfg;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'maxtag-lark-cli-'));
  try {
    await runLarkCliConfig(
      [
        'config',
        'init',
        '--name',
        'maxtag-managed',
        '--app-id',
        credential.appId,
        '--app-secret-stdin',
        '--brand',
        credential.domain,
        '--lang',
        'en',
      ],
      `${credential.appSecret}\n`,
      home,
    );
    return {
      ...cfg,
      larkCliProfile: 'maxtag-managed',
      larkCliHome: home,
      managedCredentialRevision: credential.revision,
    };
  } catch (error) {
    await fs.rm(home, { recursive: true, force: true });
    throw error;
  }
}

async function readBackfillCheckpoints(filePath, fallback) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const legacy = cleanString(parsed?.checkpoint);
    const defaultSince =
      legacy && Number.isFinite(Date.parse(legacy)) ? legacy : fallback;
    const checkpoints = {};
    if (
      parsed?.checkpoints &&
      typeof parsed.checkpoints === 'object' &&
      !Array.isArray(parsed.checkpoints)
    ) {
      for (const [channelId, value] of Object.entries(parsed.checkpoints)) {
        const checkpoint = cleanString(value);
        if (checkpoint && Number.isFinite(Date.parse(checkpoint))) {
          checkpoints[channelId] = checkpoint;
        }
      }
    }
    return { defaultSince, checkpoints };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { defaultSince: fallback, checkpoints: {} };
    }
    throw error;
  }
}

async function writeBackfillCheckpoints(filePath, checkpoints) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(
    temporary,
    JSON.stringify({ checkpoints, updatedAt: now() }, null, 2),
    'utf8',
  );
  await fs.rename(temporary, filePath);
}

async function waitForConsumersReady(state, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!state.stopping && Date.now() < deadline) {
    const entries = [...state.eventKeys.values()];
    if (entries.length && entries.every((item) => item.running && item.ready)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function runStartupBackfill(cfg, state) {
  state.backfill.enabled = cfg.backfillEnabled;
  if (!cfg.backfillEnabled || cfg.dryRun) return { skipped: true };
  const ready = await waitForConsumersReady(state);
  if (!ready) {
    if (!state.stopping) {
      state.backfill.failed += 1;
      state.backfill.lastError = 'lark_consumers_not_ready';
      state.backfill.lastErrorAt = now();
    }
    return { skipped: true, reason: 'lark_consumers_not_ready' };
  }

  const until = now();
  const fallback = new Date(
    Date.parse(until) - cfg.backfillLookbackMs,
  ).toISOString();
  let checkpointState;
  try {
    checkpointState = await readBackfillCheckpoints(
      cfg.backfillStateFile,
      fallback,
    );
  } catch (error) {
    state.backfill.failed += 1;
    state.backfill.lastError =
      error instanceof Error ? error.message : String(error);
    state.backfill.lastErrorAt = now();
    return { skipped: true, reason: 'checkpoint_read_failed' };
  }

  state.backfill.running = true;
  state.backfill.attempts += 1;
  state.backfill.lastStartedAt = now();
  state.backfill.since = checkpointState.defaultSince;
  state.backfill.until = until;
  log('backfill-started', {
    since: checkpointState.defaultSince,
    until,
    checkpointChannels: Object.keys(checkpointState.checkpoints).length,
  });
  try {
    const headers = { 'content-type': 'application/json' };
    if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
    const requestController = new AbortController();
    const timeout = setTimeout(
      () => requestController.abort('lark_backfill_timeout'),
      120_000,
    );
    const stopping = setInterval(() => {
      if (state.stopping) requestController.abort('lark_bridge_stopping');
    }, 50);
    timeout.unref?.();
    stopping.unref?.();
    let response;
    try {
      response = await fetch(
      `${cfg.serverUrl.replace(/\/$/, '')}/v1/lark/backfill`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspaceId: cfg.workspaceId,
          since: checkpointState.defaultSince,
          until,
          checkpoints: checkpointState.checkpoints,
          maxMessages: cfg.backfillMaxMessages,
        }),
        signal: requestController.signal,
      },
    );
    } finally {
      clearTimeout(timeout);
      clearInterval(stopping);
    }
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : { error: await response.text() };
    const complete = response.ok && body.complete === true && !body.truncated;
    const channelResults = Array.isArray(body.channelResults)
      ? body.channelResults
      : [];
    const nextCheckpoints = { ...checkpointState.checkpoints };
    let advancedChannels = 0;
    for (const result of channelResults) {
      const channelId = cleanString(result?.channelId);
      const channelUntil = cleanString(result?.until);
      if (
        !channelId ||
        result?.complete !== true ||
        !channelUntil ||
        !Number.isFinite(Date.parse(channelUntil))
      ) {
        continue;
      }
      nextCheckpoints[channelId] = channelUntil;
      advancedChannels += 1;
    }
    if (advancedChannels > 0 || complete) {
      await writeBackfillCheckpoints(cfg.backfillStateFile, nextCheckpoints);
    }
    state.backfill.replayed += Number(body.replayed || 0);
    state.backfill.duplicates += Number(body.duplicates || 0);
    state.backfill.truncated = body.truncated === true;
    state.backfill.lastResult = {
      complete,
      channels: Number(body.channels || 0),
      scanned: Number(body.scanned || 0),
      replayed: Number(body.replayed || 0),
      duplicates: Number(body.duplicates || 0),
      ignored: Number(body.ignored || 0),
      failed: Number(body.failed || 0),
      truncated: body.truncated === true,
      advancedChannels,
      failedChannels: channelResults.filter((result) => result?.complete !== true).length,
    };
    if (!complete) {
      throw new Error(
        cleanString(body.reason) ||
          cleanString(body.error) ||
          `lark_backfill_incomplete_http_${response.status}`,
      );
    }
    state.backfill.completed += 1;
    state.backfill.checkpointChannels = Object.keys(nextCheckpoints).length;
    state.backfill.lastCompletedAt = now();
    state.backfill.lastError = undefined;
    log('backfill-completed', state.backfill.lastResult);
    return body;
  } catch (error) {
    state.backfill.failed += 1;
    state.backfill.lastError =
      error instanceof Error ? error.message : String(error);
    state.backfill.lastErrorAt = now();
    log('backfill-failed', {
      since: checkpointState.defaultSince,
      until,
      error: state.backfill.lastError,
      checkpointChannelsAdvanced:
        state.backfill.lastResult?.advancedChannels || 0,
    });
    return { complete: false, error: state.backfill.lastError };
  } finally {
    state.backfill.running = false;
  }
}

async function waitForBackfillInterval(state, intervalMs) {
  const deadline = Date.now() + intervalMs;
  while (!state.stopping && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))),
    );
  }
}

export async function runBackfillLoop(cfg, state) {
  if (!cfg.backfillEnabled || cfg.dryRun) {
    state.backfill.enabled = cfg.backfillEnabled;
    return;
  }
  while (!state.stopping) {
    await runStartupBackfill(cfg, state);
    if (state.stopping) break;
    await waitForBackfillInterval(state, cfg.backfillIntervalMs);
  }
}

async function postClientEvent(cfg, payload) {
  if (cfg.dryRun) return { accepted: true, dryRun: true };
  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const response = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/v1/client/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    throw new Error(body.message || body.reason || body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function postLarkCardAction(cfg, event) {
  if (cfg.dryRun) return { accepted: true, dryRun: true };
  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const response = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/v1/lark/card-actions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(event),
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    throw new Error(body.message || body.reason || body.error || `HTTP ${response.status}`);
  }
  return body;
}

function larkCliArgs(cfg, eventKey) {
  const args = [];
  if (cfg.larkCliProfile) args.push('--profile', cfg.larkCliProfile);
  args.push('event', 'consume', eventKey, '--as', 'bot');
  if (cfg.maxEvents > 0) args.push('--max-events', String(cfg.maxEvents));
  if (cfg.timeout) args.push('--timeout', cfg.timeout);
  return args;
}

export function larkConsumerExitError(stderr, eventKey, profile) {
  const detail = String(stderr || '').trim().slice(-512);
  if (/Incorrect domain name/iu.test(detail)) {
    return [
      'lark_websocket_profile_domain_mismatch',
      `event_key=${eventKey}`,
      `profile=${profile || 'default'}`,
      'The lark-cli profile brand controls WebSocket ingress independently of OPENTAG_LARK_DOMAIN, which controls OpenAPI delivery. Recreate or select a profile with the app\'s correct feishu/lark brand.',
    ].join(': ');
  }
  return detail
    ? `lark_consumer_exited: event_key=${eventKey}: ${detail}`
    : `lark_consumer_exited: event_key=${eventKey}`;
}

export async function handleEvent(cfg, event) {
  if (event?.type === 'card.action.trigger') {
    const result = await postLarkCardAction(cfg, event);
    return {
      eventId: cleanString(event.event_id),
      messageId: cleanString(event.message_id),
      target: 'lark.card-action',
      accepted: result.accepted,
      duplicate: result.duplicate,
      toast: result.toast,
      dryRun: result.dryRun,
    };
  }
  const payload = larkEventToClientEvent(event, {
    workspaceId: cfg.workspaceId,
    projectId: cfg.projectId,
    botOpenId: cfg.botOpenId,
  });
  const result = await postClientEvent(cfg, payload);
  return {
    eventId: payload.eventId,
    messageId: payload.message.id,
    target: 'client.event',
    accepted: result.accepted,
    duplicate: result.duplicate,
    dryRun: result.dryRun,
  };
}

async function consumeKey(cfg, state, eventKey) {
  const keyState = eventKeyState(state, eventKey);
  keyState.running = true;
  keyState.restarts += 1;
  const child = spawn('lark-cli', larkCliArgs(cfg, eventKey), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(cfg.larkCliHome ? { HOME: cfg.larkCliHome } : {}),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  state.children.add(child);
  child.stdin?.on('error', () => {});
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
    keyState.failed += 1;
    keyState.lastErrorAt = now();
    keyState.lastError = error instanceof Error ? error.message : String(error);
  });

  let stderrBuffer = '';
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    stderrBuffer = `${stderrBuffer}${text}`.slice(-512);
    if (stderrBuffer.includes(`[event] ready event_key=${eventKey}`)) {
      keyState.ready = true;
    }
    process.stderr.write(`[${eventKey}] ${text}`);
  });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  let delivered = 0;
  for await (const chunk of child.stdout) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const event = JSON.parse(line);
          const typedEvent =
            event && typeof event === 'object'
              ? {
                  ...event,
                  type: cleanString(event.type) || eventKey,
                }
              : event;
          keyState.received += 1;
          keyState.lastEventAt = now();
          const result = await handleEvent(cfg, typedEvent);
          delivered += 1;
          keyState.delivered += 1;
          keyState.lastDeliveredAt = now();
          const summary = {
            id: randomUUID(),
            eventKey,
            delivered,
            eventId: result.eventId,
            messageId: result.messageId,
            target: result.target,
            accepted: result.accepted,
            duplicate: result.duplicate,
            toast: result.toast,
            dryRun: result.dryRun,
          };
          console.log(JSON.stringify(summary));
        } catch (error) {
          keyState.failed += 1;
          keyState.lastErrorAt = now();
          keyState.lastError =
            error instanceof Error ? error.message : String(error);
          console.error(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              line,
            }),
          );
        }
      }
      newline = buffer.indexOf('\n');
    }
  }
  const { code, signal } = await new Promise((resolve) =>
    child.on('close', (exitCode, exitSignal) =>
      resolve({ code: exitCode, signal: exitSignal }),
    ),
  );
  state.children.delete(child);
  keyState.running = false;
  const normalizedExitCode = code ?? (spawnError ? 1 : 0);
  keyState.lastExitCode = normalizedExitCode;
  if (signal && !state.stopping) {
    keyState.lastErrorAt = now();
    keyState.lastError = `consumer exited by ${signal}`;
  }
  const boundedRun = cfg.timeout || cfg.maxEvents > 0;
  const expectedExit = state.stopping || boundedRun;
  if (spawnError || normalizedExitCode !== 0 || !expectedExit) {
    if (!spawnError && !expectedExit) {
      keyState.lastErrorAt = now();
      keyState.lastError = larkConsumerExitError(
        stderrBuffer,
        eventKey,
        cfg.larkCliProfile,
      );
      log('consumer-exited', {
        eventKey,
        profile: cfg.larkCliProfile || 'default',
        exitCode: normalizedExitCode,
        error: keyState.lastError,
      });
    }
    process.exitCode = normalizedExitCode || 1;
  }
  if (!expectedExit) {
    state.stopping = true;
    for (const runningChild of state.children) {
      runningChild.kill('SIGTERM');
    }
  }
}

export async function isMainModule(
  moduleUrl = import.meta.url,
  argvEntry = process.argv[1],
) {
  if (!argvEntry) return false;
  try {
    const [invokedPath, modulePath] = await Promise.all([
      fs.realpath(argvEntry),
      fs.realpath(fileURLToPath(moduleUrl)),
    ]);
    return invokedPath === modulePath;
  } catch {
    return pathToFileURL(path.resolve(argvEntry)).href === moduleUrl;
  }
}

if (await isMainModule()) {
  const cfg = await prepareManagedLarkProfile(config());
  const state = createBridgeState();
  state.backfill.enabled = cfg.backfillEnabled;
  for (const eventKey of cfg.eventKeys) eventKeyState(state, eventKey);
  const observability = await startObservabilityServer(cfg, state);
  log('started', {
    serverUrl: cfg.serverUrl,
    workspaceId: cfg.workspaceId,
    projectId: cfg.projectId,
    eventKeys: cfg.eventKeys,
    dryRun: cfg.dryRun,
    observability,
  });
  const stop = () => {
    state.stopping = true;
    for (const child of state.children) {
      child.stdin?.end();
      child.kill('SIGTERM');
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const consumers = Promise.all(
      cfg.eventKeys.map((eventKey) => consumeKey(cfg, state, eventKey)),
    ).finally(() => {
      state.stopping = true;
    });
    const backfill = runBackfillLoop(cfg, state);
    await Promise.all([consumers, backfill]);
  } finally {
    state.stopping = true;
    await observability?.close();
    if (cfg.larkCliHome) {
      await fs.rm(cfg.larkCliHome, { recursive: true, force: true });
    }
    log('stopped', { eventKeys: [...state.eventKeys.values()] });
  }
}
