import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  OpenTagRuntime,
  StaticThreadConfigStore,
  type AgentRunEvent,
  type MemoryScopeKind,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformKind,
  type Project,
  type SourceAttachment,
  type SourceMessage,
  type SourceThread,
  type Workspace,
} from '@opentag/core';
import {
  FileDeliveryStore,
  TrackedLarkTransport,
  TrackedTextPlatformAdapter,
  runDeliveryWorkerPass,
  type CancelOutboxOptions,
  type AgentRunRecord,
  type ConfigureThreadBindingInput,
  type RecoverStaleAgentRunsOptions,
  type RecoverStaleOutboxOptions,
  type ThreadActivationMode,
  type ThreadBinding,
  type ThreadBindingScope,
} from '@opentag/delivery';
import { createCodexExecutor } from '@opentag/executor-codex';
import {
  ScopedFileMemoryStore,
  parseMemoryCommand,
  type ParsedMemoryCommand,
} from '@opentag/memory';
import {
  HttpLarkTransport,
  LarkPlatformAdapter,
  MemoryLarkTransport,
  larkCallbackEventType,
  larkCallbackExternalId,
  normalizeLarkEvent,
  parseAndValidateLarkCallback,
  type LarkIncomingEvent,
  type LarkOpenApiDomain,
  type LarkTransport,
} from '@opentag/platform-lark';

const port = Number(process.env.OPENTAG_PORT || 3077);
const host = process.env.OPENTAG_HOST || '127.0.0.1';
const dataDir = process.env.OPENTAG_DATA_DIR || path.resolve('data');
const adminDir = path.resolve('apps/admin/public');
const botOpenId = process.env.OPENTAG_LARK_BOT_OPEN_ID;
const larkTransportMode = process.env.OPENTAG_LARK_TRANSPORT || 'memory';
const larkAppId = process.env.OPENTAG_LARK_APP_ID;
const larkAppSecret = process.env.OPENTAG_LARK_APP_SECRET;
const larkDomain = larkDomainValue(process.env.OPENTAG_LARK_DOMAIN);
const larkBaseUrl = process.env.OPENTAG_LARK_BASE_URL;
const larkVerificationToken = process.env.OPENTAG_LARK_VERIFICATION_TOKEN;
const larkCallbackMaxSkewSeconds = Number(
  process.env.OPENTAG_LARK_CALLBACK_MAX_SKEW_SECONDS || 300,
);
const agentWorkerMode = process.env.OPENTAG_AGENT_WORKER || 'inline';
const agentWorkerEnabled = agentWorkerMode !== 'manual';
const agentWorkerIntervalMs = Number(process.env.OPENTAG_AGENT_WORKER_INTERVAL_MS || 2000);
const agentWorkerStaleMs = Number(process.env.OPENTAG_AGENT_WORKER_STALE_MS || 120_000);
const agentWorkerId = `opentag-${process.pid}`;
const deliveryStore = new FileDeliveryStore(path.join(dataDir, 'delivery'));
const memoryStore = new ScopedFileMemoryStore(path.join(dataDir, 'memory'));
const activeRuns = new Map<string, AbortController>();
let agentWorkerTimer: NodeJS.Timeout | undefined;
let agentWorkerPass: Promise<AgentWorkerPassResult> | undefined;
const threadConfigStore = new StaticThreadConfigStore({
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
});

const capabilityManifest = {
  product: 'OpenTag',
  principle: 'Lark first, not Lark only',
  workspaceBot: {
    status: 'partial',
    model: 'one workspace bot routes every client event into the same thread-agent runtime',
  },
  platforms: ['lark', 'telegram-generic', 'slack-planned', 'github-planned'],
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
      inbound: 'generic client event envelope',
      surface: 'tracked text receipt',
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
      opentag: 'shared client event ingress, Lark callback, Telegram-style tracked text delivery',
      status: 'partial',
    },
    {
      capability: 'Scoped memory',
      agentdock: 'session memory with async write queue',
      opentag: 'global/workspace/project/thread scopes with remember/forget commands',
      status: 'partial',
    },
    {
      capability: 'Channel binding',
      agentdock: 'chat/session routing and activation controls',
      opentag: 'admin-configured project route and activation mode',
      status: 'partial',
    },
    {
      capability: 'Topic continuation',
      agentdock: 'mention starts a topic, follow-up messages continue the session',
      opentag: 'observed thread binding lets established Lark topics continue without repeated mentions',
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
      opentag: 'durable run queue with inline or standalone worker and stale recovery',
      status: 'partial',
    },
  ],
};

function larkDomainValue(value: string | undefined): LarkOpenApiDomain {
  return value === 'lark' ? 'lark' : 'feishu';
}

function larkTransportStatus(): Record<string, unknown> {
  const requested = larkTransportMode;
  const hasCredentials = Boolean(larkAppId && larkAppSecret);
  const mode =
    requested === 'http' || (requested === 'auto' && hasCredentials)
      ? 'http'
      : 'memory';
  return {
    requested,
    mode,
    hasCredentials,
    domain: larkDomain,
    baseUrl: larkBaseUrl || undefined,
  };
}

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

function createLarkTransportForRun(): {
  transport: LarkTransport;
  dryRun?: MemoryLarkTransport;
  mode: 'memory' | 'http';
} {
  const status = larkTransportStatus();
  if (status.mode === 'http') {
    if (!larkAppId || !larkAppSecret) {
      throw new Error(
        'OPENTAG_LARK_TRANSPORT=http requires OPENTAG_LARK_APP_ID and OPENTAG_LARK_APP_SECRET.',
      );
    }
    return {
      mode: 'http',
      transport: new HttpLarkTransport({
        appId: larkAppId,
        appSecret: larkAppSecret,
        domain: larkDomain,
        baseUrl: larkBaseUrl,
      }),
    };
  }

  const dryRun = new MemoryLarkTransport();
  return {
    mode: 'memory',
    transport: dryRun,
    dryRun,
  };
}

function genericClientCapabilities(
  platform: PlatformKind,
): Partial<PlatformCapabilities> {
  if (platform === 'telegram') {
    return {
      supportsThreads: false,
      supportsCards: false,
      supportsFiles: true,
      supportsReactions: false,
      supportsMentions: true,
    };
  }
  return {};
}

function createPlatformForRun(thread: SourceThread): {
  platform: PlatformAdapter;
  transportMode: string;
  larkDryRun?: MemoryLarkTransport;
  larkTransport?: { mode: 'memory' | 'http' };
} {
  if (thread.platform === 'lark') {
    const larkTransport = createLarkTransportForRun();
    return {
      platform: new LarkPlatformAdapter(
        new TrackedLarkTransport(larkTransport.transport, deliveryStore),
      ),
      transportMode: `lark-${larkTransport.mode}`,
      larkDryRun: larkTransport.dryRun,
      larkTransport: { mode: larkTransport.mode },
    };
  }

  return {
    platform: new TrackedTextPlatformAdapter({
      kind: thread.platform,
      store: deliveryStore,
      capabilities: genericClientCapabilities(thread.platform),
    }),
    transportMode: 'tracked-text',
  };
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

function createRuntimeForPlatform(platform: PlatformAdapter): OpenTagRuntime {
  return new OpenTagRuntime({
    platform,
    executor: createCodexExecutor({ mode: 'dry-run' }),
    memory: memoryStore,
    threadConfig: threadConfigStore,
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

function recordValue(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = body[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function numberValue(
  body: Record<string, unknown>,
  key: string,
  fallback?: number,
): number | undefined {
  const value = body[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoDateValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(timestamp).toISOString();
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function visibilityValue(value: unknown): SourceThread['visibility'] | undefined {
  return value === 'public' || value === 'private' || value === 'direct'
    ? value
    : undefined;
}

function attachmentKindValue(value: unknown): SourceAttachment['kind'] {
  return value === 'image' ||
    value === 'file' ||
    value === 'audio' ||
    value === 'video' ||
    value === 'link'
    ? value
    : 'file';
}

function coerceAttachments(value: unknown): SourceAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value
    .map((item, index): SourceAttachment | undefined => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return undefined;
      }
      const body = item as Record<string, unknown>;
      const id =
        stringValue(body, 'id') ||
        stringValue(body, 'fileKey') ||
        stringValue(body, 'url') ||
        `attachment-${index + 1}`;
      return {
        id,
        kind: attachmentKindValue(body.kind),
        name: stringValue(body, 'name'),
        mimeType: stringValue(body, 'mimeType'),
        sizeBytes: numberValue(body, 'sizeBytes'),
        url: stringValue(body, 'url'),
        localPath: stringValue(body, 'localPath'),
        metadata: {
          clientPayload: body,
        },
      };
    })
    .filter((item): item is SourceAttachment => Boolean(item));
  return attachments.length ? attachments : undefined;
}

function inferredAgentMention(text: string, visibility: SourceThread['visibility']): boolean {
  return visibility === 'direct' || /^\s*(\/opentag\b|@opentag\b)/i.test(text);
}

function coerceClientEvent(
  body: Record<string, unknown>,
): {
  eventId: string;
  eventType: string;
  thread: SourceThread;
  message: SourceMessage;
} | { error: string } {
  const threadBody = recordValue(body, 'thread') || {};
  const messageBody = recordValue(body, 'message') || {};
  const actorBody =
    recordValue(messageBody, 'actor') || recordValue(body, 'actor') || {};
  const platform =
    stringValue(body, 'platform') ||
    stringValue(threadBody, 'platform') ||
    stringValue(messageBody, 'platform');
  const channelId =
    stringValue(threadBody, 'channelId') ||
    stringValue(body, 'channelId') ||
    stringValue(threadBody, 'chatId') ||
    stringValue(body, 'chatId');
  const rootMessageId =
    stringValue(threadBody, 'rootMessageId') ||
    stringValue(body, 'rootMessageId') ||
    stringValue(threadBody, 'topicId') ||
    stringValue(body, 'topicId');
  const externalId =
    stringValue(threadBody, 'externalId') ||
    stringValue(body, 'externalId') ||
    (channelId && rootMessageId ? `${channelId}:${rootMessageId}` : channelId);
  if (!platform || !externalId) {
    return { error: 'platform_and_thread_externalId_required' };
  }

  const messageId =
    stringValue(messageBody, 'id') ||
    stringValue(body, 'messageId') ||
    randomUUID();
  const text =
    stringValue(messageBody, 'text') ||
    stringValue(body, 'text') ||
    '';
  const attachments = coerceAttachments(
    messageBody.attachments ?? body.attachments,
  );
  if (!text && !attachments?.length) {
    return { error: 'message_text_or_attachments_required' };
  }

  const visibility =
    visibilityValue(threadBody.visibility) ||
    visibilityValue(body.visibility) ||
    'public';
  const platformKind = platform as PlatformKind;
  const threadId =
    stringValue(threadBody, 'id') ||
    stringValue(body, 'threadId') ||
    `${platform}:${externalId}`;
  const eventId =
    stringValue(body, 'eventId') ||
    stringValue(messageBody, 'eventId') ||
    `${externalId}:${messageId}`;
  const eventType =
    stringValue(body, 'eventType') ||
    stringValue(messageBody, 'eventType') ||
    'client.message';
  const thread: SourceThread = {
    id: threadId,
    platform: platformKind,
    externalId,
    workspaceId:
      stringValue(threadBody, 'workspaceId') ||
      stringValue(body, 'workspaceId') ||
      'dev-workspace',
    projectId:
      stringValue(threadBody, 'projectId') ||
      stringValue(body, 'projectId') ||
      channelId ||
      `${platform}-general`,
    channelId,
    rootMessageId,
    topicId:
      stringValue(threadBody, 'topicId') ||
      stringValue(body, 'topicId') ||
      rootMessageId,
    title:
      stringValue(threadBody, 'title') ||
      stringValue(body, 'title') ||
      `${platform} ${channelId || externalId}`,
    visibility,
    permalink: stringValue(threadBody, 'permalink') || stringValue(body, 'permalink'),
    metadata: {
      clientIngress: true,
      clientThread: threadBody,
    },
  };

  return {
    eventId,
    eventType,
    thread,
    message: {
      id: messageId,
      threadId: thread.id,
      platform: platformKind,
      text,
      actor: {
        id:
          stringValue(actorBody, 'id') ||
          stringValue(messageBody, 'actorId') ||
          stringValue(body, 'actorId') ||
          'unknown',
        displayName:
          stringValue(actorBody, 'displayName') ||
          stringValue(messageBody, 'actorDisplayName') ||
          stringValue(body, 'actorDisplayName'),
        platformUserId:
          stringValue(actorBody, 'platformUserId') ||
          stringValue(messageBody, 'platformUserId') ||
          stringValue(body, 'platformUserId'),
        isBot: booleanValue(actorBody, 'isBot'),
      },
      createdAt:
        isoDateValue(messageBody.createdAt) ||
        isoDateValue(body.createdAt) ||
        new Date().toISOString(),
      mentionsAgent: booleanValue(
        { ...body, ...messageBody },
        'mentionsAgent',
        inferredAgentMention(text, visibility),
      ) ?? false,
      replyToMessageId:
        stringValue(messageBody, 'replyToMessageId') ||
        stringValue(body, 'replyToMessageId'),
      attachments,
      metadata: {
        eventId,
        eventType,
        clientMessage: messageBody,
      },
    },
  };
}

function coerceOutboxFilter(
  body: Record<string, unknown>,
): CancelOutboxOptions {
  return {
    runId: stringValue(body, 'runId'),
    threadId: stringValue(body, 'threadId'),
    workspaceId: stringValue(body, 'workspaceId'),
    projectId: stringValue(body, 'projectId'),
    targetId: stringValue(body, 'targetId'),
    kind: stringValue(body, 'kind'),
    limit: numberValue(body, 'limit', 100),
    reason: stringValue(body, 'reason'),
  };
}

function coerceRecoverStaleInput(
  body: Record<string, unknown>,
): RecoverStaleOutboxOptions {
  return {
    ...coerceOutboxFilter(body),
    olderThanMs: numberValue(body, 'olderThanMs', 120_000),
  };
}

function coerceRecoverStaleAgentRunsInput(
  body: Record<string, unknown>,
): RecoverStaleAgentRunsOptions {
  return {
    olderThanMs: numberValue(body, 'olderThanMs', agentWorkerStaleMs),
    limit: numberValue(body, 'limit', 100),
    reason: stringValue(body, 'reason'),
  };
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

function canUseEstablishedThreadBinding(thread: SourceThread): boolean {
  return Boolean(thread.rootMessageId || thread.topicId);
}

async function routeMessage(input: {
  thread: SourceThread;
  message: SourceMessage;
}): Promise<{
  thread: SourceThread;
  message: SourceMessage;
  binding?: ThreadBinding;
  establishedThreadBinding?: ThreadBinding;
}> {
  const [binding, establishedThreadBinding] = await Promise.all([
    deliveryStore.getThreadBindingForThread(input.thread),
    deliveryStore.getThreadBinding(input.thread.platform, input.thread.externalId),
  ]);
  if (!binding) {
    return {
      ...input,
      establishedThreadBinding:
        establishedThreadBinding?.scope === 'thread' &&
        canUseEstablishedThreadBinding(input.thread)
          ? establishedThreadBinding
          : undefined,
    };
  }
  const thread = applyBindingToThread(input.thread, binding);
  return {
    thread,
    message: {
      ...input.message,
      threadId: thread.id,
    },
    binding,
    establishedThreadBinding:
      establishedThreadBinding?.scope === 'thread' &&
      canUseEstablishedThreadBinding(thread)
        ? establishedThreadBinding
        : undefined,
  };
}

function shouldHandleMessage(input: {
  thread: SourceThread;
  message: SourceMessage;
  binding?: ThreadBinding;
  establishedThreadBinding?: ThreadBinding;
}): boolean {
  if (input.thread.visibility === 'direct') return true;
  if (input.binding?.activationMode === 'always') return true;
  if (
    input.establishedThreadBinding?.source === 'observed' ||
    input.establishedThreadBinding?.source === 'configured'
  ) {
    return true;
  }
  const requireMention =
    input.binding?.requireMention ??
    (input.thread.platform === 'lark' ? Boolean(botOpenId) : true);
  return !requireMention || input.message.mentionsAgent;
}

async function memoryContextForThread(
  thread: SourceThread,
): Promise<{ workspace?: Workspace; project?: Project }> {
  const workspace = await threadConfigStore.getWorkspace(thread);
  const project = await threadConfigStore.getProject(thread, workspace);
  return { workspace, project };
}

function memoryScopeValue(
  body: Record<string, unknown>,
  fallback: MemoryScopeKind = 'project',
): MemoryScopeKind {
  const value = stringValue(body, 'scope');
  return value === 'global' ||
    value === 'workspace' ||
    value === 'project' ||
    value === 'thread'
    ? value
    : fallback;
}

function coerceMemoryThread(body: Record<string, unknown>): SourceThread {
  const platform = stringValue(body, 'platform', 'lark') || 'lark';
  const externalId =
    stringValue(body, 'externalId') ||
    stringValue(body, 'channelId') ||
    stringValue(body, 'threadId') ||
    'admin';
  const channelId = stringValue(body, 'channelId', externalId) || externalId;
  const threadId =
    stringValue(body, 'threadId', `${platform}:${externalId}`) ||
    `${platform}:${externalId}`;
  return {
    id: threadId,
    platform,
    externalId,
    workspaceId: stringValue(body, 'workspaceId', 'dev-workspace'),
    projectId: stringValue(body, 'projectId', 'opentag'),
    channelId,
    title: stringValue(body, 'title', externalId),
    visibility: 'public',
  };
}

function memoryCommandDefaultScope(thread: SourceThread): MemoryScopeKind {
  return thread.visibility === 'direct' ? 'thread' : 'project';
}

function formatMemoryScopeLabel(scope: MemoryScopeKind): string {
  return `${scope} memory`;
}

function formatMemoryContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return 'No memory in this scope yet.';
  return trimmed.length <= 1500 ? trimmed : `${trimmed.slice(0, 1500)}...`;
}

function agentRunEventSummary(event: AgentRunEvent): {
  message?: string;
  metadata?: Record<string, unknown>;
} {
  if (event.type === 'progress') {
    return {
      message: event.message ?? event.item.label,
      metadata: {
        item: event.item,
      },
    };
  }
  if (event.type === 'artifact') {
    return {
      message: event.artifact.title,
      metadata: {
        artifact: event.artifact,
      },
    };
  }
  if (event.type === 'text_delta') {
    return {
      message: event.text,
    };
  }
  return {
    message: event.message,
    metadata: {
      level: event.level,
    },
  };
}

async function applyMemoryCommand(input: {
  command: ParsedMemoryCommand;
  thread: SourceThread;
}): Promise<Record<string, unknown>> {
  const { workspace, project } = await memoryContextForThread(input.thread);
  if (input.command.kind === 'remember') {
    await memoryStore.rememberScoped({
      thread: input.thread,
      workspace,
      project,
      scope: input.command.scope,
      text: input.command.value,
    });
    return {
      summary: `Remembered in ${formatMemoryScopeLabel(input.command.scope)}.`,
      scope: input.command.scope,
      workspaceId: workspace?.id,
      projectId: project?.id,
      value: input.command.value,
    };
  }

  if (input.command.kind === 'forget') {
    await memoryStore.forgetScoped({
      thread: input.thread,
      workspace,
      project,
      scope: input.command.scope,
      selector: input.command.value,
    });
    return {
      summary: `Removed matching lines from ${formatMemoryScopeLabel(input.command.scope)}.`,
      scope: input.command.scope,
      workspaceId: workspace?.id,
      projectId: project?.id,
      selector: input.command.value,
    };
  }

  const snapshot = await memoryStore.loadMemory({
    thread: input.thread,
    workspace,
    project,
    scopes: [input.command.scope],
  });
  const content = snapshot.scopes[0]?.content ?? '';
  return {
    summary: `${formatMemoryScopeLabel(input.command.scope)}\n${formatMemoryContent(content)}`,
    scope: input.command.scope,
    workspaceId: workspace?.id,
    projectId: project?.id,
    content,
  };
}

interface QueuedMessageRun {
  run: AgentRunRecord;
  route: Record<string, unknown>;
  memoryCommand?: {
    kind: ParsedMemoryCommand['kind'];
    scope: MemoryScopeKind;
  };
  transport: {
    platform: PlatformKind;
    mode: string;
  };
  larkTransport?: {
    mode: 'memory' | 'http';
  };
}

interface AgentWorkerPassResult {
  claimed: number;
  completed: number;
  failed: number;
  runs: AgentRunRecord[];
}

async function enqueueMessageRun(input: {
  thread: SourceThread;
  message: SourceMessage;
}, options?: {
  inboundEventId?: string;
  runId?: string;
}): Promise<QueuedMessageRun> {
  const runId = options?.runId ?? randomUUID();
  const routed = await routeMessage(input);
  const observedBinding = await deliveryStore.upsertThreadBinding({
    thread: routed.thread,
    workspaceId: routed.thread.workspaceId ?? 'default-workspace',
    projectId: routed.thread.projectId ?? 'general',
    activationMode: routed.binding?.activationMode,
    requireMention: routed.binding?.requireMention,
  });
  const routeBinding = routed.binding ?? observedBinding;
  const larkTransport =
    routed.thread.platform === 'lark' ? larkTransportStatus() : undefined;
  const transportMode = larkTransport
    ? `lark-${String(larkTransport.mode)}`
    : 'tracked-text';
  const route = {
    workspaceId: routed.thread.workspaceId,
    projectId: routed.thread.projectId,
    threadId: routed.thread.id,
    platform: routed.thread.platform,
    bindingId: routeBinding.id,
    bindingScope: routeBinding.scope,
    activationMode: routeBinding.activationMode,
    observedBindingId: observedBinding.id,
    establishedThreadBindingId: routed.establishedThreadBinding?.id,
  };
  const memoryCommand = parseMemoryCommand(routed.message.text, {
    defaultScope: memoryCommandDefaultScope(routed.thread),
  });
  const run = await deliveryStore.createAgentRun({
    runId,
    thread: routed.thread,
    message: routed.message,
    inboundEventId: options?.inboundEventId,
    bindingId: routeBinding.id,
    executorId: memoryCommand ? 'memory-command' : 'codex',
    transportMode,
    metadata: {
      memoryCommand: memoryCommand
        ? { kind: memoryCommand.kind, scope: memoryCommand.scope }
        : undefined,
    },
  });

  return {
    run,
    route,
    memoryCommand: memoryCommand
      ? { kind: memoryCommand.kind, scope: memoryCommand.scope }
      : undefined,
    transport: {
      platform: routed.thread.platform,
      mode: transportMode,
    },
    larkTransport: larkTransport
      ? { mode: larkTransport.mode as 'memory' | 'http' }
      : undefined,
  };
}

async function markRunInboundProcessed(run: AgentRunRecord): Promise<void> {
  if (!run.inboundEventId || !run.thread || !run.message) return;
  await deliveryStore.markInboundEventProcessed(run.inboundEventId, {
    workspaceId: run.thread.workspaceId,
    projectId: run.thread.projectId,
    threadId: run.thread.id,
    messageId: run.message.id,
  });
}

async function markRunInboundFailed(
  run: AgentRunRecord,
  error: string,
): Promise<void> {
  if (!run.inboundEventId) return;
  await deliveryStore.markInboundEventFailed(run.inboundEventId, error);
}

function runRoute(run: AgentRunRecord): Record<string, unknown> {
  return {
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    threadId: run.threadId,
    platform: run.platform,
    bindingId: run.bindingId,
    workerId: run.workerId,
  };
}

async function executeAgentRun(
  initialRun: AgentRunRecord,
  options?: { alreadyClaimed?: boolean },
): Promise<Record<string, unknown>> {
  const runId = initialRun.id;
  if (!initialRun.thread || !initialRun.message) {
    const message = 'missing_saved_run_payload';
    await deliveryStore.markAgentRunFailed(runId, message);
    throw new Error(message);
  }
  if (initialRun.status === 'cancel_requested') {
    await deliveryStore.markAgentRunCancelled(runId, 'cancel_requested_before_start');
    return {
      run: await deliveryStore.getAgentRun(runId),
      route: runRoute(initialRun),
      delivery: await deliverySnapshot(20),
    };
  }
  if (!options?.alreadyClaimed) {
    const runningRun = await deliveryStore.markAgentRunRunning(runId);
    if (runningRun?.status === 'cancelled') {
      return {
        run: runningRun,
        route: runRoute(runningRun),
        delivery: await deliverySnapshot(20),
      };
    }
  }

  let runPlatform: ReturnType<typeof createPlatformForRun>;
  try {
    runPlatform = createPlatformForRun(initialRun.thread);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deliveryStore.markAgentRunFailed(runId, message);
    await markRunInboundFailed(initialRun, message);
    throw error;
  }
  const memoryCommand = parseMemoryCommand(initialRun.message.text, {
    defaultScope: memoryCommandDefaultScope(initialRun.thread),
  });

  if (memoryCommand) {
    try {
      const commandResult = await applyMemoryCommand({
        command: memoryCommand,
        thread: initialRun.thread,
      });
      await deliveryStore.appendAgentRunEvent(runId, 'memory_command', {
        message: String(commandResult.summary),
        metadata: {
          kind: memoryCommand.kind,
          scope: memoryCommand.scope,
        },
      });
      await runPlatform.platform.sendMessage(
        initialRun.thread,
        String(commandResult.summary),
        [],
        { runId, replyToMessageId: initialRun.message.id },
      );
      await markRunInboundProcessed(initialRun);
      await deliveryStore.markAgentRunCompleted(
        runId,
        String(commandResult.summary),
      );
      return {
        result: {
          summary: commandResult.summary,
          artifacts: [],
        },
        run: await deliveryStore.getAgentRun(runId),
        route: runRoute(initialRun),
        memoryCommand: {
          kind: memoryCommand.kind,
          scope: memoryCommand.scope,
          ...commandResult,
        },
        delivery: await deliverySnapshot(20),
        transport: {
          platform: runPlatform.platform.kind,
          mode: runPlatform.transportMode,
        },
        larkTransport: runPlatform.larkTransport,
        larkDryRun: runPlatform.larkDryRun
          ? {
              texts: runPlatform.larkDryRun.texts,
              cards: runPlatform.larkDryRun.cards,
            }
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deliveryStore.markAgentRunFailed(runId, message);
      await markRunInboundFailed(initialRun, message);
      throw error;
    }
  }

  const runtime = createRuntimeForPlatform(runPlatform.platform);
  const abortController = new AbortController();
  activeRuns.set(runId, abortController);
  try {
    const result = await runtime.handleMessage({
      runId,
      thread: initialRun.thread,
      message: initialRun.message,
      abortSignal: abortController.signal,
      onEvent: async (event) => {
        await deliveryStore.appendAgentRunEvent(
          runId,
          event.type,
          agentRunEventSummary(event),
        );
      },
    });
    await markRunInboundProcessed(initialRun);
    await deliveryStore.markAgentRunCompleted(runId, result.summary);
    return {
      result,
      run: await deliveryStore.getAgentRun(runId),
      route: runRoute(initialRun),
      delivery: await deliverySnapshot(20),
      transport: {
        platform: runPlatform.platform.kind,
        mode: runPlatform.transportMode,
      },
      larkTransport: runPlatform.larkTransport,
      larkDryRun: runPlatform.larkDryRun
        ? {
            texts: runPlatform.larkDryRun.texts,
            cards: runPlatform.larkDryRun.cards,
          }
        : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (abortController.signal.aborted) {
      await deliveryStore.markAgentRunCancelled(runId, message);
    } else {
      await deliveryStore.markAgentRunFailed(runId, message);
    }
    await markRunInboundFailed(initialRun, message);
    throw error;
  } finally {
    activeRuns.delete(runId);
  }
}

async function runMessageSync(input: {
  thread: SourceThread;
  message: SourceMessage;
}, options?: {
  inboundEventId?: string;
}): Promise<Record<string, unknown>> {
  const queued = await enqueueMessageRun(input, options);
  const result = await executeAgentRun(queued.run);
  return {
    ...result,
    route: queued.route,
  };
}

async function runAgentWorkerPass(
  limit = 1,
): Promise<AgentWorkerPassResult> {
  if (agentWorkerPass) return agentWorkerPass;
  agentWorkerPass = (async () => {
    const claimed = await deliveryStore.claimQueuedAgentRuns({
      limit,
      workerId: agentWorkerId,
    });
    const result: AgentWorkerPassResult = {
      claimed: claimed.length,
      completed: 0,
      failed: 0,
      runs: [],
    };
    for (const run of claimed) {
      try {
        await executeAgentRun(run, { alreadyClaimed: true });
        result.completed += 1;
      } catch {
        result.failed += 1;
      } finally {
        const latest = await deliveryStore.getAgentRun(run.id);
        if (latest) result.runs.push(latest);
      }
    }
    return result;
  })();
  try {
    return await agentWorkerPass;
  } finally {
    agentWorkerPass = undefined;
  }
}

function scheduleAgentWorkerPass(delayMs = 0): void {
  if (!agentWorkerEnabled || agentWorkerTimer || agentWorkerPass) return;
  agentWorkerTimer = setTimeout(() => {
    agentWorkerTimer = undefined;
    void runAgentWorkerPass(1).catch((error) => {
      console.error('OpenTag agent worker pass failed', error);
    });
  }, delayMs);
  agentWorkerTimer.unref?.();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        service: 'opentag-server',
        worker: {
          mode: agentWorkerMode,
          enabled: agentWorkerEnabled,
          activeRuns: activeRuns.size,
          passRunning: Boolean(agentWorkerPass),
        },
      });
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
      sendJson(response, 200, {
        ...capabilityManifest,
        larkTransport: larkTransportStatus(),
        runWorker: {
          mode: agentWorkerMode,
          enabled: agentWorkerEnabled,
          intervalMs: agentWorkerIntervalMs,
          staleMs: agentWorkerStaleMs,
          activeRuns: activeRuns.size,
          passRunning: Boolean(agentWorkerPass),
        },
      });
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

    if (request.method === 'GET' && url.pathname === '/v1/memory') {
      const query = Object.fromEntries(url.searchParams.entries());
      const thread = coerceMemoryThread(query);
      const { workspace, project } = await memoryContextForThread(thread);
      const scope = memoryScopeValue(query, 'project');
      const snapshot = await memoryStore.loadMemory({
        thread,
        workspace,
        project,
        scopes: [scope],
      });
      sendJson(response, 200, {
        route: {
          workspaceId: workspace?.id,
          projectId: project?.id,
          threadId: thread.id,
          platform: thread.platform,
        },
        scope,
        snapshot,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/memory') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const action = stringValue(body, 'action', 'remember');
      const thread = coerceMemoryThread(body);
      const scope = memoryScopeValue(body, 'project');
      const value =
        stringValue(body, 'text') ||
        stringValue(body, 'value') ||
        stringValue(body, 'selector');
      if ((action === 'remember' || action === 'forget') && !value) {
        sendJson(response, 400, { error: 'memory_value_required' });
        return;
      }
      if (action !== 'remember' && action !== 'forget' && action !== 'show') {
        sendJson(response, 400, { error: 'unsupported_memory_action' });
        return;
      }
      const result = await applyMemoryCommand({
        command: {
          kind: action,
          scope,
          value: value ?? '',
        },
        thread,
      });
      sendJson(response, 200, {
        route: {
          workspaceId: result.workspaceId,
          projectId: result.projectId,
          threadId: thread.id,
          platform: thread.platform,
        },
        memoryCommand: result,
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

    if (request.method === 'POST' && url.pathname === '/v1/deliveries/recover-stale') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const result = await deliveryStore.recoverStaleOutbox(
        coerceRecoverStaleInput(body),
      );
      sendJson(response, 200, { result, delivery: await deliverySnapshot(20) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/deliveries/cancel') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const result = await deliveryStore.cancelOutbox(coerceOutboxFilter(body));
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

    if (request.method === 'POST' && url.pathname === '/v1/runs/worker-pass') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const result = await runAgentWorkerPass(numberValue(body, 'limit', 1));
      sendJson(response, 200, {
        result,
        delivery: await deliverySnapshot(20),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/runs/recover-stale') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const result = await deliveryStore.recoverStaleAgentRuns(
        coerceRecoverStaleAgentRunsInput(body),
      );
      if (result.requeued > 0) scheduleAgentWorkerPass();
      sendJson(response, 200, {
        result,
        delivery: await deliverySnapshot(20),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/runs') {
      const query = Object.fromEntries(url.searchParams.entries());
      sendJson(response, 200, {
        runs: await deliveryStore.listAgentRuns({
          status:
            query.status === 'queued' ||
            query.status === 'running' ||
            query.status === 'cancel_requested' ||
            query.status === 'completed' ||
            query.status === 'failed' ||
            query.status === 'cancelled'
              ? query.status
              : undefined,
          workspaceId: stringValue(query, 'workspaceId'),
          projectId: stringValue(query, 'projectId'),
          threadId: stringValue(query, 'threadId'),
          limit: numberValue(query, 'limit', 20),
        }),
      });
      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/v1/runs/') &&
      url.pathname.endsWith('/events')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/runs/'.length, -'/events'.length),
      );
      const run = await deliveryStore.getAgentRun(id);
      if (!run) {
        sendJson(response, 404, { error: 'run_not_found' });
        return;
      }
      sendJson(response, 200, {
        run,
        events: await deliveryStore.listAgentRunEvents(
          id,
          Number(url.searchParams.get('limit') || 100),
        ),
      });
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/runs/') &&
      url.pathname.endsWith('/cancel')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/runs/'.length, -'/cancel'.length),
      );
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const reason = stringValue(body, 'reason', 'operator_cancelled_run');
      const run = await deliveryStore.requestAgentRunCancel(id, reason);
      if (!run) {
        sendJson(response, 404, { error: 'run_not_found' });
        return;
      }
      activeRuns.get(id)?.abort(reason);
      const cancelledOutbox = await deliveryStore.cancelOutbox({
        runId: id,
        reason,
      });
      sendJson(response, 200, {
        run: await deliveryStore.getAgentRun(id),
        active: activeRuns.has(id),
        cancelledOutbox,
        delivery: await deliverySnapshot(20),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/dev/messages') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const query = Object.fromEntries(url.searchParams.entries());
      const asyncRequested =
        booleanValue({ ...query, ...body }, 'async', false) ||
        stringValue(body, 'mode') === 'async';
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
      if (asyncRequested) {
        const queued = await enqueueMessageRun(normalized, {
          inboundEventId: inbound.record.id,
        });
        scheduleAgentWorkerPass();
        sendJson(response, 202, {
          accepted: true,
          queued: true,
          ...queued,
          delivery: await deliverySnapshot(20),
        });
        return;
      }
      sendJson(response, 200, await runMessageSync(normalized, {
        inboundEventId: inbound.record.id,
      }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/client/events') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const normalized = coerceClientEvent(body);
      if ('error' in normalized) {
        sendJson(response, 400, {
          accepted: false,
          reason: normalized.error,
        });
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const asyncRequested =
        stringValue({ ...query, ...body }, 'mode') === 'sync'
          ? false
          : booleanValue({ ...query, ...body }, 'async', true) ?? true;
      const inbound = await deliveryStore.recordInboundEvent({
        platform: normalized.thread.platform,
        externalId: normalized.eventId,
        eventType: normalized.eventType,
        workspaceId: normalized.thread.workspaceId,
        projectId: normalized.thread.projectId,
        threadId: normalized.thread.id,
        messageId: normalized.message.id,
        metadata: {
          ingress: 'client',
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
            establishedThreadBindingId: routed.establishedThreadBinding?.id,
          },
        });
        return;
      }

      if (asyncRequested) {
        const queued = await enqueueMessageRun(routed, {
          inboundEventId: inbound.record.id,
        });
        scheduleAgentWorkerPass();
        sendJson(response, 202, {
          accepted: true,
          queued: true,
          ...queued,
          delivery: await deliverySnapshot(20),
        });
        return;
      }

      sendJson(response, 200, await runMessageSync(routed, {
        inboundEventId: inbound.record.id,
      }));
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
            establishedThreadBindingId: routed.establishedThreadBinding?.id,
          },
        });
        return;
      }
      const queued = await enqueueMessageRun(routed, {
        inboundEventId: inbound.record.id,
      });
      scheduleAgentWorkerPass();
      sendJson(response, 202, {
        accepted: true,
        queued: true,
        ...queued,
        delivery: await deliverySnapshot(20),
      });
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
  void deliveryStore.recoverStaleAgentRuns({
    olderThanMs: agentWorkerStaleMs,
    reason: 'server_startup_recovered_stale_run',
  }).then((result) => {
    if (result.requeued > 0 || result.cancelled > 0) {
      console.log(
        `OpenTag recovered agent runs requeued=${result.requeued} cancelled=${result.cancelled}`,
      );
    }
    scheduleAgentWorkerPass();
  }).catch((error) => {
    console.error('OpenTag failed to recover stale agent runs', error);
  });
  if (agentWorkerEnabled) {
    const interval = setInterval(() => {
      scheduleAgentWorkerPass();
    }, agentWorkerIntervalMs);
    interval.unref?.();
  }
});
