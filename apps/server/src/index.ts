import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  OpenTagRuntime,
  StaticThreadConfigStore,
  type SourceMessage,
  type SourceThread,
} from '@opentag/core';
import {
  FileDeliveryStore,
  TrackedLarkTransport,
  runDeliveryWorkerPass,
  type ConfigureThreadBindingInput,
  type ThreadActivationMode,
  type ThreadBinding,
  type ThreadBindingScope,
} from '@opentag/delivery';
import { createCodexExecutor } from '@opentag/executor-codex';
import { ScopedFileMemoryStore } from '@opentag/memory';
import {
  LarkPlatformAdapter,
  MemoryLarkTransport,
  larkCallbackEventType,
  larkCallbackExternalId,
  normalizeLarkEvent,
  parseAndValidateLarkCallback,
  type LarkIncomingEvent,
  type LarkTransport,
} from '@opentag/platform-lark';

const port = Number(process.env.OPENTAG_PORT || 3077);
const host = process.env.OPENTAG_HOST || '127.0.0.1';
const dataDir = process.env.OPENTAG_DATA_DIR || path.resolve('data');
const adminDir = path.resolve('apps/admin/public');
const botOpenId = process.env.OPENTAG_LARK_BOT_OPEN_ID;
const larkVerificationToken = process.env.OPENTAG_LARK_VERIFICATION_TOKEN;
const larkCallbackMaxSkewSeconds = Number(
  process.env.OPENTAG_LARK_CALLBACK_MAX_SKEW_SECONDS || 300,
);
const deliveryStore = new FileDeliveryStore(path.join(dataDir, 'delivery'));

const capabilityManifest = {
  product: 'OpenTag',
  principle: 'Lark first, not Lark only',
  workspaceBot: {
    status: 'partial',
    model: 'one workspace bot routes every client event into the same thread-agent runtime',
  },
  platforms: ['lark', 'telegram-placeholder', 'slack-planned', 'github-planned'],
  executors: ['codex-dry-run', 'claude-placeholder'],
  clients: [
    {
      id: 'lark',
      label: 'Lark / Feishu',
      status: 'ready',
      inbound: 'event callback',
      surface: 'progress card + thread reply',
    },
    {
      id: 'telegram',
      label: 'Telegram',
      status: 'partial',
      inbound: 'adapter stub',
      surface: 'text receipt',
    },
    {
      id: 'slack',
      label: 'Slack',
      status: 'planned',
      inbound: 'not wired',
      surface: 'planned',
    },
    {
      id: 'github',
      label: 'GitHub comments',
      status: 'planned',
      inbound: 'not wired',
      surface: 'planned',
    },
  ],
  memoryScopes: [
    {
      id: 'global',
      label: 'Global',
      status: 'ready',
      description: 'shared across the whole OpenTag installation',
    },
    {
      id: 'workspace',
      label: 'Workspace',
      status: 'ready',
      description: 'shared by every project under one workspace bot',
    },
    {
      id: 'project',
      label: 'Project',
      status: 'ready',
      description: 'separate group/project memory for a channel or repo',
    },
    {
      id: 'thread',
      label: 'Thread',
      status: 'ready',
      description: 'local context for one conversation root',
    },
  ],
  parity: [
    {
      capability: 'Multi-client routing',
      agentdock: 'Feishu, Telegram, QQ, Web adapters',
      opentag: 'shared client model, Lark ready, Telegram stub',
      status: 'partial',
    },
    {
      capability: 'Scoped memory',
      agentdock: 'session memory with async write queue',
      opentag: 'global/workspace/project/thread file scopes with channel bindings',
      status: 'partial',
    },
    {
      capability: 'Channel binding',
      agentdock: 'chat/session routing and activation controls',
      opentag: 'admin-configured project route and activation mode',
      status: 'partial',
    },
    {
      capability: 'Reliable delivery',
      agentdock: 'SQLite outbox and turn delivery tracking',
      opentag: 'file-backed outbox and turn delivery tracker',
      status: 'partial',
    },
    {
      capability: 'Inbound idempotency',
      agentdock: 'message cursor and turn delivery recovery',
      opentag: 'event ledger with duplicate short-circuit',
      status: 'partial',
    },
    {
      capability: 'Long-running work',
      agentdock: 'scheduled tasks and dynamic workflows',
      opentag: 'executor interface only',
      status: 'planned',
    },
  ],
};

async function readTextBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const text = await readTextBody(request);
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
}

async function sendFileResponse(
  response: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  const content = await readFile(filePath);
  response.writeHead(200, { 'content-type': contentType });
  response.end(content);
}

function stripPayload<T extends { payload?: unknown }>(
  item: T,
): Omit<T, 'payload'> {
  const { payload: _payload, ...rest } = item;
  return rest;
}

async function deliverySnapshot(limit = 50): Promise<Record<string, unknown>> {
  const [summary, outbox, turnDeliveries, bindings, inboundEvents] =
    await Promise.all([
      deliveryStore.summarize(),
      deliveryStore.listOutbox({ limit }),
      deliveryStore.listTurnDeliveries({ limit }),
      deliveryStore.listThreadBindings(limit),
      deliveryStore.listInboundEvents({ limit }),
    ]);
  return {
    summary,
    outbox: outbox.map(stripPayload),
    turnDeliveries,
    bindings,
    inboundEvents,
  };
}

function createRuntimeForDryRun(transport: LarkTransport): OpenTagRuntime {
  const platform = new LarkPlatformAdapter(transport);
  return new OpenTagRuntime({
    platform,
    executor: createCodexExecutor({ mode: 'dry-run' }),
    memory: new ScopedFileMemoryStore(path.join(dataDir, 'memory')),
    threadConfig: new StaticThreadConfigStore({
      identity: {
        displayName: 'OpenTag',
        instructions:
          'You are OpenTag in a shared work thread. Keep progress visible and publish durable artifacts.',
        defaultExecutorId: 'codex',
      },
      workspace: {
        id: 'dev-workspace',
        name: 'Development Workspace',
        defaultProjectId: 'opentag',
      },
    }),
  });
}

function coerceDevMessage(body: Record<string, unknown>): {
  thread: SourceThread;
  message: SourceMessage;
} {
  const text = typeof body.text === 'string' ? body.text : 'hello opentag';
  const thread: SourceThread = {
    id: 'lark:dev-chat:root',
    platform: 'lark',
    externalId: 'dev-chat:root',
    workspaceId: 'dev-workspace',
    projectId: 'opentag',
    channelId: 'dev-chat',
    rootMessageId: 'root',
    topicId: 'root',
    title: 'OpenTag Demo Project',
    visibility: 'public',
    metadata: {
      projectId: 'opentag',
    },
  };
  return {
    thread,
    message: {
      id: `dev-${Date.now()}`,
      threadId: thread.id,
      platform: 'lark',
      text,
      actor: {
        id: 'dev-user',
        displayName: 'Developer',
      },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
  };
}

function stringValue(
  body: Record<string, unknown>,
  key: string,
  fallback?: string,
): string | undefined {
  const value = body[key];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function booleanValue(
  body: Record<string, unknown>,
  key: string,
  fallback?: boolean,
): boolean | undefined {
  const value = body[key];
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function activationModeValue(
  body: Record<string, unknown>,
): ThreadActivationMode | undefined {
  const value = stringValue(body, 'activationMode');
  return value === 'always' || value === 'mention' ? value : undefined;
}

function bindingScopeValue(
  body: Record<string, unknown>,
): ThreadBindingScope | undefined {
  const value = stringValue(body, 'scope');
  return value === 'thread' || value === 'channel' ? value : undefined;
}

function coerceBindingInput(
  body: Record<string, unknown>,
): ConfigureThreadBindingInput | { error: string } {
  const platform = stringValue(body, 'platform', 'lark');
  const externalId = stringValue(body, 'externalId');
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const projectId = stringValue(body, 'projectId');
  if (!platform || !externalId || !workspaceId || !projectId) {
    return { error: 'platform_externalId_workspaceId_projectId_required' };
  }
  const scope = bindingScopeValue(body) ?? 'channel';
  return {
    platform,
    externalId,
    workspaceId,
    projectId,
    scope,
    source: 'configured',
    channelId: stringValue(body, 'channelId', scope === 'channel' ? externalId : undefined),
    title: stringValue(body, 'title'),
    activationMode: activationModeValue(body) ?? 'mention',
    requireMention: booleanValue(body, 'requireMention', scope !== 'thread'),
    metadata: {
      configuredVia: 'admin-api',
    },
  };
}

function applyBindingToThread(
  thread: SourceThread,
  binding: ThreadBinding,
): SourceThread {
  return {
    ...thread,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    title: binding.title || thread.title,
    metadata: {
      ...thread.metadata,
      bindingId: binding.id,
      bindingScope: binding.scope,
      bindingSource: binding.source,
    },
  };
}

async function routeMessage(input: {
  thread: SourceThread;
  message: SourceMessage;
}): Promise<{
  thread: SourceThread;
  message: SourceMessage;
  binding?: ThreadBinding;
}> {
  const binding = await deliveryStore.getThreadBindingForThread(input.thread);
  if (!binding) return input;
  const thread = applyBindingToThread(input.thread, binding);
  return {
    thread,
    message: {
      ...input.message,
      threadId: thread.id,
    },
    binding,
  };
}

function shouldHandleMessage(input: {
  thread: SourceThread;
  message: SourceMessage;
  binding?: ThreadBinding;
}): boolean {
  if (input.thread.visibility === 'direct') return true;
  if (input.binding?.activationMode === 'always') return true;
  const requireMention =
    input.binding?.requireMention ?? Boolean(botOpenId);
  return !requireMention || input.message.mentionsAgent;
}

async function runDryMessage(input: {
  thread: SourceThread;
  message: SourceMessage;
}, options?: {
  inboundEventId?: string;
}): Promise<Record<string, unknown>> {
  const memoryTransport = new MemoryLarkTransport();
  const trackedTransport = new TrackedLarkTransport(memoryTransport, deliveryStore);
  const runtime = createRuntimeForDryRun(trackedTransport);
  const runId = randomUUID();
  const routed = await routeMessage(input);
  const observedBinding = await deliveryStore.upsertThreadBinding({
    thread: routed.thread,
    workspaceId: routed.thread.workspaceId ?? 'default-workspace',
    projectId: routed.thread.projectId ?? 'general',
    activationMode: routed.binding?.activationMode,
    requireMention: routed.binding?.requireMention,
  });
  const routeBinding = routed.binding ?? observedBinding;
  let result;
  try {
    result = await runtime.handleMessage({
      runId,
      thread: routed.thread,
      message: routed.message,
    });
    if (options?.inboundEventId) {
      await deliveryStore.markInboundEventProcessed(options.inboundEventId, {
        workspaceId: observedBinding.workspaceId,
        projectId: observedBinding.projectId,
        threadId: routed.thread.id,
        messageId: routed.message.id,
      });
    }
  } catch (error) {
    if (options?.inboundEventId) {
      await deliveryStore.markInboundEventFailed(
        options.inboundEventId,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  const delivery = await deliverySnapshot(20);
  return {
    result,
    route: {
      workspaceId: routed.thread.workspaceId,
      projectId: routed.thread.projectId,
      threadId: routed.thread.id,
      platform: routed.thread.platform,
      bindingId: routeBinding.id,
      bindingScope: routeBinding.scope,
      activationMode: routeBinding.activationMode,
      observedBindingId: observedBinding.id,
    },
    delivery,
    larkDryRun: {
      texts: memoryTransport.texts,
      cards: memoryTransport.cards,
    },
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'opentag-server' });
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      await sendFileResponse(response, path.join(adminDir, 'index.html'), 'text/html; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/admin.css') {
      await sendFileResponse(response, path.join(adminDir, 'admin.css'), 'text/css; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/admin.js') {
      await sendFileResponse(response, path.join(adminDir, 'admin.js'), 'text/javascript; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
      sendJson(response, 200, capabilityManifest);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/deliveries') {
      const limit = Number(url.searchParams.get('limit') || 20);
      sendJson(response, 200, await deliverySnapshot(limit));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/bindings') {
      const limit = Number(url.searchParams.get('limit') || 20);
      sendJson(response, 200, {
        bindings: await deliveryStore.listThreadBindings(limit),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/bindings') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceBindingInput(body);
      if ('error' in input) {
        sendJson(response, 400, { error: input.error });
        return;
      }
      const binding = await deliveryStore.configureThreadBinding(input);
      sendJson(response, 200, {
        binding,
        delivery: await deliverySnapshot(20),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/deliveries/worker-pass') {
      const result = await runDeliveryWorkerPass(deliveryStore, async (record) => {
        return record.externalId ?? record.target.cardId ?? record.target.chatId;
      });
      sendJson(response, 200, { result, delivery: await deliverySnapshot(20) });
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/deliveries/') &&
      url.pathname.endsWith('/retry')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/deliveries/'.length, -'/retry'.length),
      );
      sendJson(response, 200, {
        retried: await deliveryStore.retryFailedOutbox(id),
        delivery: await deliverySnapshot(20),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/dev/messages') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const normalized = coerceDevMessage(body);
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'lark',
        externalId: normalized.message.id,
        eventType: 'dev.message',
        workspaceId: normalized.thread.workspaceId,
        projectId: normalized.thread.projectId,
        threadId: normalized.thread.id,
        messageId: normalized.message.id,
      });
      sendJson(
        response,
        200,
        await runDryMessage(normalized, { inboundEventId: inbound.record.id }),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/lark/events') {
      const rawBody = await readTextBody(request);
      const parsed = parseAndValidateLarkCallback(rawBody, request.headers, {
        verificationToken: larkVerificationToken,
        maxTimestampSkewSeconds: larkCallbackMaxSkewSeconds,
      });
      const body = parsed.body;
      const externalId = larkCallbackExternalId(body);
      const eventType = larkCallbackEventType(body);
      if (!parsed.validation.ok) {
        const rejected = await deliveryStore.recordInboundEvent({
          platform: 'lark',
          externalId: `rejected:${externalId}:${randomUUID()}`,
          eventType,
          metadata: {
            originalExternalId: externalId,
            reason: parsed.validation.reason,
            requestId: request.headers['x-lark-request-id'],
          },
        });
        await deliveryStore.markInboundEventRejected(
          rejected.record.id,
          parsed.validation.reason,
        );
        sendJson(response, parsed.validation.statusCode, {
          accepted: false,
          reason: parsed.validation.reason,
        });
        return;
      }
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'lark',
        externalId,
        eventType,
        metadata: {
          requestId: request.headers['x-lark-request-id'],
        },
      });
      if (inbound.duplicate) {
        sendJson(response, 200, {
          accepted: true,
          duplicate: true,
          inbound: inbound.record,
        });
        return;
      }
      if (typeof body.challenge === 'string') {
        await deliveryStore.markInboundEventProcessed(inbound.record.id);
        sendJson(response, 200, { challenge: body.challenge });
        return;
      }
      const normalized = normalizeLarkEvent(body as LarkIncomingEvent, { botOpenId });
      if (!normalized) {
        await deliveryStore.markInboundEventIgnored(
          inbound.record.id,
          'unsupported_lark_event',
        );
        sendJson(response, 202, { accepted: false, reason: 'unsupported_lark_event' });
        return;
      }
      const routed = await routeMessage(normalized);
      if (!shouldHandleMessage(routed)) {
        await deliveryStore.markInboundEventIgnored(
          inbound.record.id,
          'mention_required',
          {
            workspaceId: routed.thread.workspaceId,
            projectId: routed.thread.projectId,
            threadId: routed.thread.id,
            messageId: routed.message.id,
          },
        );
        sendJson(response, 202, {
          accepted: false,
          reason: 'mention_required',
          route: {
            workspaceId: routed.thread.workspaceId,
            projectId: routed.thread.projectId,
            threadId: routed.thread.id,
            platform: routed.thread.platform,
            bindingId: routed.binding?.id,
          },
        });
        return;
      }
      sendJson(
        response,
        200,
        {
          accepted: true,
          ...(await runDryMessage(routed, {
            inboundEventId: inbound.record.id,
          })),
        },
      );
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    sendJson(response, 500, {
      error: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`OpenTag server listening on http://${host}:${port}`);
});
