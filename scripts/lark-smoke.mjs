#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildLarkProgressCard } from '../packages/ui-cards/dist/index.js';
import { HttpLarkTransport, LarkApiError } from '../packages/platform-lark/dist/index.js';

function argValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function now() {
  return new Date().toISOString();
}

function redact(value) {
  if (!value) return undefined;
  if (value.length <= 8) return '<configured>';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function larkDomain(value) {
  return value === 'lark' ? 'lark' : 'feishu';
}

function callbackUrl() {
  return (
    argValue('--callback-url') ||
    env('OPENTAG_PUBLIC_CALLBACK_URL') ||
    env('OPENTAG_LARK_CALLBACK_URL')
  );
}

function smokeRunId() {
  return (
    argValue('--smoke-run-id') ||
    env('OPENTAG_SMOKE_RUN_ID') ||
    `lark-smoke-${Date.now()}`
  );
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function eventMode(value) {
  return value === 'webhook' ? 'webhook' : 'long-connection';
}

function config() {
  const appId = env('OPENTAG_LARK_APP_ID');
  const appSecret = env('OPENTAG_LARK_APP_SECRET');
  return {
    runId: smokeRunId(),
    appId,
    appSecret,
    botOpenId: env('OPENTAG_LARK_BOT_OPEN_ID'),
    verificationToken: env('OPENTAG_LARK_VERIFICATION_TOKEN'),
    encryptKey: env('OPENTAG_LARK_ENCRYPT_KEY'),
    domain: larkDomain(env('OPENTAG_LARK_DOMAIN')),
    baseUrl: env('OPENTAG_LARK_BASE_URL'),
    chatId: argValue('--chat-id') || env('OPENTAG_LARK_SMOKE_CHAT_ID'),
    threadId: argValue('--thread-id') || env('OPENTAG_LARK_SMOKE_THREAD_ID'),
    callbackUrl: callbackUrl(),
    eventMode: eventMode(argValue('--event-mode') || env('OPENTAG_LARK_EVENT_MODE')),
    consumeEvents:
      hasFlag('--consume-events') || env('OPENTAG_LARK_SMOKE_CONSUME_EVENTS') === '1',
    eventTimeoutMs: positiveInt(
      argValue('--event-timeout-ms') || env('OPENTAG_LARK_EVENT_TIMEOUT_MS'),
      30000,
    ),
    larkCliProfile:
      argValue('--lark-cli-profile') || env('OPENTAG_LARK_CLI_PROFILE'),
    bridgeHealthUrl:
      argValue('--bridge-health-url') || env('OPENTAG_LARK_BRIDGE_HEALTH_URL'),
    send: hasFlag('--send') || env('OPENTAG_LARK_SMOKE_SEND') === '1',
    history: hasFlag('--history') || env('OPENTAG_LARK_SMOKE_HISTORY') === '1',
    file: hasFlag('--file') || env('OPENTAG_LARK_SMOKE_FILE') === '1',
    image: hasFlag('--image') || env('OPENTAG_LARK_SMOKE_IMAGE') === '1',
    milestoneCallbackUrl:
      argValue('--milestone-callback-url') || env('OPENTAG_SMOKE_CALLBACK_URL'),
    milestoneCallbackToken:
      argValue('--milestone-callback-token') || env('OPENTAG_SMOKE_CALLBACK_TOKEN'),
    milestoneCallbackTimeoutMs: positiveInt(
      argValue('--milestone-callback-timeout-ms') ||
        env('OPENTAG_SMOKE_CALLBACK_TIMEOUT_MS'),
      5000,
    ),
    evidenceJsonl:
      argValue('--evidence-jsonl') || env('OPENTAG_SMOKE_EVIDENCE_JSONL'),
    json: hasFlag('--json'),
  };
}

function pass(id, message, evidence = {}) {
  return { id, status: 'pass', message, evidence };
}

function fail(id, message, evidence = {}) {
  return { id, status: 'fail', message, evidence };
}

function skip(id, message, evidence = {}) {
  return { id, status: 'skip', message, evidence };
}

function manual(id, message, evidence = {}) {
  return { id, status: 'manual', message, evidence };
}

function errorEvidence(error) {
  if (error instanceof LarkApiError) {
    return {
      name: error.name,
      code: error.code,
      statusCode: error.statusCode,
      requestId: error.requestId,
      message: error.message,
    };
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function runCheck(id, fn) {
  try {
    return await fn();
  } catch (error) {
    return fail(id, `${id} failed`, errorEvidence(error));
  }
}

function progressCard(runId, status, summary) {
  return buildLarkProgressCard({
    runId,
    title: 'MaxTag Lark Smoke',
    status,
    summary,
    updatedAt: now(),
    checklist: [
      { id: 'token', label: 'Tenant token', status: 'done' },
      { id: 'message', label: 'Bot message delivery', status },
      { id: 'card', label: 'Progress card update', status },
    ],
  });
}

async function larkBotInfo(transport) {
  return transport.openApiRequest('/open-apis/bot/v3/info', { method: 'GET' });
}

async function larkVisibleChats(transport) {
  return transport.openApiRequest('/open-apis/im/v1/chats', {
    method: 'GET',
    query: { page_size: 20 },
  });
}

async function smokeFile() {
  const file = path.join(os.tmpdir(), `opentag-lark-smoke-${process.pid}.txt`);
  await fs.writeFile(file, `MaxTag Lark smoke ${now()}\n`, 'utf8');
  return file;
}

async function smokeImage() {
  const file = path.join(os.tmpdir(), `opentag-lark-smoke-${process.pid}.png`);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+cv6WAAAAAElFTkSuQmCC',
    'base64',
  );
  await fs.writeFile(file, png);
  return file;
}

function publicUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

function chatSummary(chat) {
  return {
    chatId: redact(chat.chat_id),
    name: chat.name,
    chatType: chat.chat_type,
    memberCount: chat.member_count,
  };
}

async function postJson(url, body, token, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Milestone callback returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function milestoneEvent(cfg, check, sequence) {
  return {
    event: 'opentag.smoke.milestone',
    schemaVersion: 1,
    tool: 'opentag-lark-smoke',
    platform: 'lark',
    runId: cfg.runId,
    generatedAt: now(),
    sequence,
    milestone: check,
  };
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

async function appendEvidenceJsonl(cfg, entries) {
  const target = evidencePath(cfg.evidenceJsonl);
  if (!target) {
    return skip(
      'M0_LOCAL_EVIDENCE',
      'Skipped local smoke evidence file. Set OPENTAG_SMOKE_EVIDENCE_JSONL to write JSONL evidence.',
    );
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(
    target,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  return pass('M0_LOCAL_EVIDENCE', 'Wrote local smoke evidence JSONL.', {
    path: path.relative(process.cwd(), target),
    records: entries.length,
  });
}

async function deliverMilestoneCallbacks(cfg, checks) {
  if (!cfg.milestoneCallbackUrl) {
    return skip(
      'M0_MILESTONE_CALLBACKS',
      'Skipped milestone callback delivery. Set OPENTAG_SMOKE_CALLBACK_URL to publish evidence.',
    );
  }
  let delivered = 0;
  try {
    for (const [index, check] of checks.entries()) {
      await postJson(
        cfg.milestoneCallbackUrl,
        milestoneEvent(cfg, check, index + 1),
        cfg.milestoneCallbackToken,
        cfg.milestoneCallbackTimeoutMs,
      );
      delivered += 1;
    }
    const callbackCheck = pass(
      'M0_MILESTONE_CALLBACKS',
      'Delivered smoke milestone callbacks.',
      {
        delivered,
        url: publicUrl(cfg.milestoneCallbackUrl),
        auth: cfg.milestoneCallbackToken ? 'bearer' : 'none',
      },
    );
    await postJson(
      cfg.milestoneCallbackUrl,
      milestoneEvent(cfg, callbackCheck, checks.length + 1),
      cfg.milestoneCallbackToken,
      cfg.milestoneCallbackTimeoutMs,
    );
    return callbackCheck;
  } catch (error) {
    return fail('M0_MILESTONE_CALLBACKS', 'Failed to deliver smoke milestone callbacks.', {
      delivered,
      url: publicUrl(cfg.milestoneCallbackUrl),
      ...errorEvidence(error),
    });
  }
}

function eventTimeoutFlag(timeoutMs) {
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

function parseNdjson(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runLarkCli(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function larkCliBaseArgs(cfg) {
  const args = [];
  if (cfg.larkCliProfile) args.push('--profile', cfg.larkCliProfile);
  return args;
}

function cliErrorEvidence(result) {
  return {
    exitCode: result.code,
    stderr: result.stderr.trim().slice(0, 1000),
  };
}

function bridgeHealthUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function checkLarkCliProfile(cfg) {
  const result = await runLarkCli([
    ...larkCliBaseArgs(cfg),
    'event',
    'schema',
    'im.message.receive_v1',
    '--json',
  ]);
  if (result.code !== 0) {
    return manual(
      'M1_LARK_CLI_PROFILE',
      'lark-cli profile is not ready for long-connection event checks.',
      {
        profile: cfg.larkCliProfile || 'default',
        ...cliErrorEvidence(result),
      },
    );
  }
  return pass('M1_LARK_CLI_PROFILE', 'lark-cli profile can inspect Lark event schema.', {
    profile: cfg.larkCliProfile || 'default',
  });
}

async function checkBridgeHealth(cfg) {
  if (!cfg.bridgeHealthUrl) {
    return skip(
      'M1_LARK_BRIDGE_HEALTH',
      'Skipped Lark bridge health check. Set OPENTAG_LARK_BRIDGE_HEALTH_URL when the supervised bridge is running.',
    );
  }
  const response = await fetch(cfg.bridgeHealthUrl);
  const body = await response.json();
  const eventKeys = Array.isArray(body.eventKeys) ? body.eventKeys : [];
  const required = ['im.message.receive_v1', 'card.action.trigger'];
  const missing = required.filter(
    (eventKey) =>
      !eventKeys.some(
        (item) => item.eventKey === eventKey && item.running === true && item.ready === true,
      ),
  );
  if (!response.ok || body.ok !== true || missing.length) {
    return fail(
      'M1_LARK_BRIDGE_HEALTH',
      'Lark bridge health check failed.',
      {
        url: bridgeHealthUrl(cfg.bridgeHealthUrl),
        status: response.status,
        ok: body.ok,
        missing,
        eventKeys: eventKeys.map((item) => ({
          eventKey: item.eventKey,
          running: item.running,
          ready: item.ready,
          lastExitCode: item.lastExitCode,
        })),
      },
    );
  }
  return pass('M1_LARK_BRIDGE_HEALTH', 'Lark bridge is healthy for required event keys.', {
    url: bridgeHealthUrl(cfg.bridgeHealthUrl),
    eventKeys: eventKeys
      .filter((item) => required.includes(item.eventKey))
      .map((item) => ({
        eventKey: item.eventKey,
        running: item.running,
        ready: item.ready,
      })),
  });
}

async function consumeLarkMessageEvent(cfg) {
  const args = [
    ...larkCliBaseArgs(cfg),
    'event',
    'consume',
    'im.message.receive_v1',
    '--as',
    'bot',
    '--max-events',
    '1',
    '--timeout',
    eventTimeoutFlag(cfg.eventTimeoutMs),
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `lark-cli exited with ${code}`));
        return;
      }
      try {
        const events = parseNdjson(stdout);
        resolve({
          events,
          ready: stderr.includes('[event] ready event_key=im.message.receive_v1'),
          stderr,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function buildResult(cfg, checks) {
  const failed = checks.filter((check) => check.status === 'fail').length;
  const passed = checks.filter((check) => check.status === 'pass').length;
  const skipped = checks.filter((check) => check.status === 'skip').length;
  const manualCount = checks.filter((check) => check.status === 'manual').length;
  return {
    tool: 'opentag-lark-smoke',
    platform: 'lark',
    runId: cfg.runId,
    generatedAt: now(),
    ok: failed === 0,
    summary: {
      passed,
      failed,
      skipped,
      manual: manualCount,
    },
    checks,
  };
}

async function main() {
  const cfg = config();
  const checks = [];
  checks.push(
    cfg.appId && cfg.appSecret
      ? pass('M1_TOKEN_CONFIGURED', 'Lark app credentials are configured.', {
          appId: redact(cfg.appId),
          domain: cfg.domain,
          baseUrl: cfg.baseUrl,
          eventMode: cfg.eventMode,
          larkCliProfile: cfg.larkCliProfile,
        })
      : fail('M1_TOKEN_CONFIGURED', 'Set OPENTAG_LARK_APP_ID and OPENTAG_LARK_APP_SECRET.'),
  );
  checks.push(
    cfg.botOpenId
      ? pass('M1_BOT_ID_CONFIGURED', 'Bot open_id is configured.', {
          botOpenId: redact(cfg.botOpenId),
        })
      : fail('M1_BOT_ID_CONFIGURED', 'Set OPENTAG_LARK_BOT_OPEN_ID.'),
  );
  if (cfg.eventMode === 'webhook') {
    checks.push(
      cfg.verificationToken
        ? pass('M1_VERIFICATION_TOKEN_CONFIGURED', 'Verification token is configured.')
        : fail('M1_VERIFICATION_TOKEN_CONFIGURED', 'Set OPENTAG_LARK_VERIFICATION_TOKEN.'),
    );
    checks.push(
      cfg.encryptKey
        ? pass('M1_ENCRYPT_KEY_CONFIGURED', 'Encrypt Key is configured.')
        : fail('M1_ENCRYPT_KEY_CONFIGURED', 'Set OPENTAG_LARK_ENCRYPT_KEY.'),
    );
    checks.push(
      cfg.callbackUrl
        ? manual('M1_CALLBACK_URL_REGISTERED', 'Register this URL in Lark event and card callbacks.', {
            callbackUrl: cfg.callbackUrl,
          })
        : fail(
            'M1_CALLBACK_URL_REGISTERED',
            'Set OPENTAG_PUBLIC_CALLBACK_URL or OPENTAG_LARK_CALLBACK_URL to the public HTTPS /v1/lark/events endpoint.',
          ),
    );
  } else {
    checks.push(
      skip(
        'M1_WEBHOOK_CALLBACK_CONFIGURED',
        'Skipped webhook callback checks because event mode is long-connection.',
        {
          verificationTokenConfigured: Boolean(cfg.verificationToken),
          encryptKeyConfigured: Boolean(cfg.encryptKey),
          callbackUrlConfigured: Boolean(cfg.callbackUrl),
        },
      ),
    );
    checks.push(await checkLarkCliProfile(cfg));
    checks.push(await runCheck('M1_LARK_BRIDGE_HEALTH', () => checkBridgeHealth(cfg)));
    checks.push(
      cfg.consumeEvents
        ? await runCheck('M1_LONG_CONNECTION_EVENT', async () => {
            const result = await consumeLarkMessageEvent(cfg);
            return result.events.length
              ? pass(
                  'M1_LONG_CONNECTION_EVENT',
                  'Consumed one Lark IM event over the long connection.',
                  {
                    count: result.events.length,
                    readyMarker: result.ready,
                    timeoutMs: cfg.eventTimeoutMs,
                  },
                )
              : manual(
                  'M1_LONG_CONNECTION_EVENT',
                  'Long connection opened, but no IM event arrived before timeout.',
                  {
                    count: 0,
                    readyMarker: result.ready,
                    timeoutMs: cfg.eventTimeoutMs,
                  },
                );
          })
        : manual(
            'M1_LONG_CONNECTION_EVENT',
            'Run with --consume-events and mention the bot in a test group to prove Lark long-connection ingress.',
            { timeoutMs: cfg.eventTimeoutMs },
          ),
    );
  }

  const canUseOpenApi = Boolean(cfg.appId && cfg.appSecret);
  const transport = canUseOpenApi
    ? new HttpLarkTransport({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain: cfg.domain,
        baseUrl: cfg.baseUrl,
      })
    : undefined;
  let visibleChats = [];
  let targetChatVisible = !cfg.chatId;

  if (transport) {
    checks.push(
      await runCheck('M1_TENANT_TOKEN', async () => {
        await transport.readiness();
        return pass('M1_TENANT_TOKEN', 'Lark OpenAPI credentials are accepted.');
      }),
    );
    checks.push(
      await runCheck('M1_BOT_INFO', async () => {
        const info = await larkBotInfo(transport);
        return pass('M1_BOT_INFO', 'Fetched Lark bot profile.', {
          openId: redact(info.bot?.open_id),
          appName: info.bot?.app_name,
          activateStatus: info.bot?.activate_status,
          configuredBotMatches:
            !cfg.botOpenId || !info.bot?.open_id
              ? undefined
              : cfg.botOpenId === info.bot.open_id,
        });
      }),
    );
    checks.push(
      await runCheck('M1_VISIBLE_CHATS', async () => {
        const page = await larkVisibleChats(transport);
        visibleChats = Array.isArray(page.items) ? page.items : [];
        return visibleChats.length
          ? pass('M1_VISIBLE_CHATS', 'Bot can see at least one Lark chat.', {
              count: visibleChats.length,
              sample: visibleChats.slice(0, 5).map(chatSummary),
            })
          : manual(
              'M1_VISIBLE_CHATS',
              'Add the bot to a test group before running --send live delivery.',
              { count: 0 },
            );
      }),
    );
    checks.push(
      cfg.chatId
        ? await runCheck('M1_TARGET_CHAT_VISIBLE', async () => {
            const found = visibleChats.find((chat) => chat.chat_id === cfg.chatId);
            targetChatVisible = Boolean(found);
            return found
              ? pass('M1_TARGET_CHAT_VISIBLE', 'Target Lark chat is visible to the bot.', {
                  chat: chatSummary(found),
                })
              : fail(
                  'M1_TARGET_CHAT_VISIBLE',
                  'Target Lark chat is not visible to the bot. Add the bot to the chat before live send/card/history smoke.',
                  {
                    chatId: redact(cfg.chatId),
                    visibleCount: visibleChats.length,
                  },
                );
          })
        : skip(
            'M1_TARGET_CHAT_VISIBLE',
            'Skipped target chat visibility check. Re-run with --chat-id=oc_xxx.',
          ),
    );
  } else {
    checks.push(skip('M1_TENANT_TOKEN', 'Skipped because app credentials are missing.'));
    checks.push(skip('M1_BOT_INFO', 'Skipped because app credentials are missing.'));
    checks.push(skip('M1_VISIBLE_CHATS', 'Skipped because app credentials are missing.'));
    checks.push(skip('M1_TARGET_CHAT_VISIBLE', 'Skipped because app credentials are missing.'));
  }

  if (!cfg.send) {
    checks.push(
      skip('M2_TEXT_DELIVERY', 'Skipped live send. Re-run with --send and --chat-id=oc_xxx.'),
      skip('M2_PROGRESS_CARD', 'Skipped live card. Re-run with --send and --chat-id=oc_xxx.'),
    );
  } else if (!transport || !cfg.chatId) {
    checks.push(
      fail('M2_TEXT_DELIVERY', 'Live send requires credentials and --chat-id or OPENTAG_LARK_SMOKE_CHAT_ID.'),
      fail('M2_PROGRESS_CARD', 'Live card requires credentials and --chat-id or OPENTAG_LARK_SMOKE_CHAT_ID.'),
    );
  } else if (!targetChatVisible) {
    checks.push(
      fail('M2_TEXT_DELIVERY', 'Blocked live send because the target Lark chat is not visible to the bot.', {
        chatId: redact(cfg.chatId),
      }),
      fail('M2_PROGRESS_CARD', 'Blocked live card smoke because the target Lark chat is not visible to the bot.', {
        chatId: redact(cfg.chatId),
      }),
    );
  } else {
    checks.push(
      await runCheck('M2_TEXT_DELIVERY', async () => {
        await transport.sendText({
          chatId: cfg.chatId,
          text: `MaxTag smoke text ${now()}`,
          metadata: { runId: `smoke-text-${Date.now()}`, stage: 'thread-reply' },
        });
        return pass('M2_TEXT_DELIVERY', 'Sent a Lark text message through the app bot.', {
          chatId: cfg.chatId,
        });
      }),
    );
    checks.push(
      await runCheck('M2_PROGRESS_CARD', async () => {
        const runId = `lark-smoke-${Date.now()}`;
        const created = await transport.createCard({
          chatId: cfg.chatId,
          card: progressCard(runId, 'running', 'Creating smoke card.'),
          metadata: { runId, stage: 'progress-card' },
        });
        await transport.updateCard({
          cardId: created.cardId,
          card: progressCard(runId, 'completed', 'Smoke card update completed.'),
          metadata: { runId, stage: 'progress-card' },
        });
        return pass('M2_PROGRESS_CARD', 'Created and updated a Lark progress card.', {
          chatId: cfg.chatId,
          cardId: created.cardId,
        });
      }),
    );
  }

  if (cfg.history) {
    if (!transport || !cfg.threadId) {
      checks.push(
        fail('M3_THREAD_HISTORY', 'Thread history smoke requires --thread-id or OPENTAG_LARK_SMOKE_THREAD_ID.'),
      );
    } else {
      checks.push(
        await runCheck('M3_THREAD_HISTORY', async () => {
          const page = await transport.listMessages({
            containerType: 'thread',
            containerId: cfg.threadId,
            pageSize: 5,
          });
          return pass('M3_THREAD_HISTORY', 'Fetched Lark thread history.', {
            threadId: cfg.threadId,
            count: page.items.length,
            hasMore: page.hasMore,
          });
        }),
      );
    }
  } else {
    checks.push(skip('M3_THREAD_HISTORY', 'Skipped. Re-run with --history and --thread-id=om_xxx.'));
  }

  if (cfg.file) {
    if (!cfg.send || !transport || !cfg.chatId) {
      checks.push(fail('M6_FILE_DELIVERY', 'File smoke requires --send and --chat-id=oc_xxx.'));
    } else if (!targetChatVisible) {
      checks.push(
        fail('M6_FILE_DELIVERY', 'Blocked file smoke because the target Lark chat is not visible to the bot.', {
          chatId: redact(cfg.chatId),
        }),
      );
    } else {
      checks.push(
        await runCheck('M6_FILE_DELIVERY', async () => {
          const file = await smokeFile();
          try {
            const sent = await transport.sendFile({
              chatId: cfg.chatId,
              file: { path: file, name: 'maxtag-lark-smoke.txt', mimeType: 'text/plain' },
              metadata: {
                runId: `lark-smoke-file-${Date.now()}`,
                stage: 'artifact',
                artifactId: 'smoke-file',
              },
            });
            return pass('M6_FILE_DELIVERY', 'Uploaded and sent a Lark file artifact.', sent);
          } finally {
            await fs.rm(file, { force: true });
          }
        }),
      );
    }
  } else {
    checks.push(skip('M6_FILE_DELIVERY', 'Skipped. Re-run with --file --send and --chat-id=oc_xxx.'));
  }

  if (cfg.image) {
    if (!cfg.send || !transport || !cfg.chatId) {
      checks.push(fail('M6_IMAGE_DELIVERY', 'Image smoke requires --send and --chat-id=oc_xxx.'));
    } else if (!targetChatVisible) {
      checks.push(
        fail('M6_IMAGE_DELIVERY', 'Blocked image smoke because the target Lark chat is not visible to the bot.', {
          chatId: redact(cfg.chatId),
        }),
      );
    } else {
      checks.push(
        await runCheck('M6_IMAGE_DELIVERY', async () => {
          const file = await smokeImage();
          try {
            const sent = await transport.sendFile({
              chatId: cfg.chatId,
              file: { path: file, name: 'opentag-lark-smoke.png', mimeType: 'image/png' },
              metadata: {
                runId: `lark-smoke-image-${Date.now()}`,
                stage: 'artifact',
                artifactId: 'smoke-image',
              },
            });
            if (sent.messageType !== 'image') {
              return fail('M6_IMAGE_DELIVERY', 'Lark sent the smoke image through the file fallback.', sent);
            }
            return pass('M6_IMAGE_DELIVERY', 'Uploaded and sent a native Lark image artifact.', sent);
          } finally {
            await fs.rm(file, { force: true });
          }
        }),
      );
    }
  } else {
    checks.push(skip('M6_IMAGE_DELIVERY', 'Skipped. Re-run with --image --send and --chat-id=oc_xxx.'));
  }

  checks.push(
    manual(
      'M4_CARD_ACTION_STOP',
      cfg.eventMode === 'webhook'
        ? 'After server callback is registered, click Stop on a real MaxTag progress card and verify the run becomes cancelled.'
        : 'After the long-connection consumer bridge is running, click Stop on a real MaxTag progress card and verify the run becomes cancelled.',
    ),
    manual(
      'M7_WORKER_RESTART',
      'Run server + worker + scheduler with shared storage, kill the worker mid-run, and verify replacement patches the same card.',
    ),
  );
  checks.push(await deliverMilestoneCallbacks(cfg, checks));

  const result = buildResult(cfg, checks);
  const localEvidenceCheck = await appendEvidenceJsonl(cfg, [
    ...checks.map((check, index) => milestoneEvent(cfg, check, index + 1)),
    {
      event: 'opentag.smoke.summary',
      schemaVersion: 1,
      tool: 'opentag-lark-smoke',
      platform: 'lark',
      runId: cfg.runId,
      generatedAt: now(),
      result,
    },
  ]);
  checks.push(localEvidenceCheck);
  const finalResult = buildResult(cfg, checks);

  if (cfg.json) {
    console.log(JSON.stringify(finalResult, null, 2));
  } else {
    console.log(`MaxTag Lark smoke: ${finalResult.ok ? 'ready' : 'not ready'}`);
    for (const check of checks) {
      console.log(`[${check.status}] ${check.id}: ${check.message}`);
    }
    console.log(JSON.stringify(finalResult, null, 2));
  }
  process.exitCode = finalResult.ok ? 0 : 1;
}

await main();
