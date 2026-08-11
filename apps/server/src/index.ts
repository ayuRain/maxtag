import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  OpenTagRuntime,
  type AgentRunEvent,
  type MemoryScopeKind,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformKind,
  type Project,
  type SourceAttachment,
  type SourceMessage,
  type SourceThread,
  type ToolGrant,
  type ToolGrantKind,
  type Workspace,
} from '@opentag/core';
import {
  FileThreadConfigStore,
  type UpsertProjectAgentPolicyInput,
} from '@opentag/config';
import {
  FileDeliveryStore,
  TrackedLarkTransport,
  TrackedTelegramTransport,
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
import { createClaudeExecutor } from '@opentag/executor-claude';
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
import {
  HttpTelegramTransport,
  MemoryTelegramTransport,
  TelegramPlatformAdapter,
  normalizeTelegramUpdate,
  parseAndValidateTelegramCallback,
  telegramCallbackEventType,
  telegramCallbackExternalId,
  type TelegramTransport,
  type TelegramUpdate,
} from '@opentag/platform-telegram';
import {
  FileRoutineStore,
  type Routine,
  type RoutineClaim,
  type RoutineExecution,
  type RoutineSchedule,
  type UpsertRoutineInput,
} from '@opentag/routines';

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
const telegramTransportMode = process.env.OPENTAG_TELEGRAM_TRANSPORT || 'memory';
const telegramBotToken = process.env.OPENTAG_TELEGRAM_BOT_TOKEN;
const telegramBotUsername = process.env.OPENTAG_TELEGRAM_BOT_USERNAME;
const telegramWebhookSecret = process.env.OPENTAG_TELEGRAM_WEBHOOK_SECRET;
const telegramBaseUrl = process.env.OPENTAG_TELEGRAM_BASE_URL;
const telegramWorkspaceId =
  process.env.OPENTAG_TELEGRAM_WORKSPACE_ID || 'dev-workspace';
const telegramRequireBinding = ['1', 'true', 'yes'].includes(
  String(process.env.OPENTAG_TELEGRAM_REQUIRE_BINDING || 'false').toLowerCase(),
);
const agentWorkerMode = process.env.OPENTAG_AGENT_WORKER || 'inline';
const agentWorkerEnabled = agentWorkerMode !== 'manual';
const agentWorkerIntervalMs = Number(process.env.OPENTAG_AGENT_WORKER_INTERVAL_MS || 2000);
const agentWorkerStaleMs = Number(process.env.OPENTAG_AGENT_WORKER_STALE_MS || 120_000);
const agentWorkerId = `opentag-${process.pid}`;
const executorMode =
  process.env.OPENTAG_EXECUTOR_MODE === 'local-cli' ? 'local-cli' : 'dry-run';
const executorWorkspaceRoot =
  process.env.OPENTAG_EXECUTOR_WORKSPACE_ROOT || process.cwd();
const executorTimeoutMs = numberEnvironmentValue(
  'OPENTAG_EXECUTOR_TIMEOUT_MS',
  20 * 60_000,
);
const executorMaxOutputBytes = numberEnvironmentValue(
  'OPENTAG_EXECUTOR_MAX_OUTPUT_BYTES',
  2_000_000,
);
const executorInheritEnv = listEnvironmentValue('OPENTAG_EXECUTOR_INHERIT_ENV');
const codexCommand = process.env.OPENTAG_CODEX_COMMAND || 'codex';
const codexModel = process.env.OPENTAG_CODEX_MODEL;
const claudeCommand = process.env.OPENTAG_CLAUDE_COMMAND || 'claude';
const claudeModel = process.env.OPENTAG_CLAUDE_MODEL;
const claudeMaxBudgetUsd = optionalNumberEnvironmentValue(
  'OPENTAG_CLAUDE_MAX_BUDGET_USD',
);
const routinesEnabled = !['0', 'false', 'no'].includes(
  String(process.env.OPENTAG_ROUTINES_ENABLED || 'true').toLowerCase(),
);
const routineTickIntervalMs = numberEnvironmentValue(
  'OPENTAG_ROUTINE_TICK_INTERVAL_MS',
  30_000,
);
const routineClaimStaleMs = numberEnvironmentValue(
  'OPENTAG_ROUTINE_CLAIM_STALE_MS',
  120_000,
);
const defaultRoutineTimeZone =
  process.env.OPENTAG_DEFAULT_TIME_ZONE || 'Asia/Shanghai';
const routineSchedulerId = `opentag-routines-${process.pid}`;
const deliveryStore = new FileDeliveryStore(path.join(dataDir, 'delivery'));
const memoryStore = new ScopedFileMemoryStore(path.join(dataDir, 'memory'));
const routineStore = new FileRoutineStore(path.join(dataDir, 'routines'));
const activeRuns = new Map<string, AbortController>();
let agentWorkerTimer: NodeJS.Timeout | undefined;
let agentWorkerPass: Promise<AgentWorkerPassResult> | undefined;
let routineTickPass: Promise<RoutineTickResult> | undefined;
let routineLastTickAt: string | undefined;
let routineLastTickResult: RoutineTickResult | undefined;
const threadConfigStore = new FileThreadConfigStore(path.join(dataDir, 'config'), {
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
  platforms: ['lark', 'telegram', 'slack-planned', 'github-planned'],
  executors: [`codex-${executorMode}`, `claude-${executorMode}`],
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
      status: 'ready',
      inbound: 'native Bot API webhook',
      surface: 'editable progress message + topic reply + files',
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
      opentag: 'shared client ingress plus native Lark and Telegram adapters',
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
      capability: 'Project agent policy',
      agentdock: 'agent templates, tool nodes, and per-session configuration',
      opentag: 'persisted identity, instructions, executor, project grants, network policy, and audit',
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
      opentag: 'durable run queue plus interval/daily workspace routines with manual triggers',
      status: 'partial',
    },
  ],
};

function larkDomainValue(value: string | undefined): LarkOpenApiDomain {
  return value === 'lark' ? 'lark' : 'feishu';
}

function numberEnvironmentValue(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNumberEnvironmentValue(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function listEnvironmentValue(name: string): string[] | undefined {
  const values = process.env[name]
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values?.length ? values : undefined;
}

function executorStatus(): Record<string, unknown> {
  return {
    mode: executorMode,
    workspaceRoot: path.resolve(executorWorkspaceRoot),
    timeoutMs: executorTimeoutMs,
    maxOutputBytes: executorMaxOutputBytes,
    codex: {
      command: codexCommand,
      model: codexModel,
    },
    claude: {
      command: claudeCommand,
      model: claudeModel,
      maxBudgetUsd: claudeMaxBudgetUsd,
    },
  };
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

function telegramTransportStatus(): {
  requested: string;
  mode: 'memory' | 'http';
  hasToken: boolean;
  botUsername?: string;
  baseUrl?: string;
  webhookSecretConfigured: boolean;
  workspaceId: string;
  requireBinding: boolean;
} {
  const requested = telegramTransportMode;
  const hasToken = Boolean(telegramBotToken);
  return {
    requested,
    mode:
      requested === 'http' || (requested === 'auto' && hasToken)
        ? 'http'
        : 'memory',
    hasToken,
    botUsername: telegramBotUsername,
    baseUrl: telegramBaseUrl || undefined,
    webhookSecretConfigured: Boolean(telegramWebhookSecret),
    workspaceId: telegramWorkspaceId,
    requireBinding: telegramRequireBinding,
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

function createTelegramTransportForRun(): {
  transport: TelegramTransport;
  dryRun?: MemoryTelegramTransport;
  mode: 'memory' | 'http';
} {
  const status = telegramTransportStatus();
  if (status.mode === 'http') {
    if (!telegramBotToken) {
      throw new Error(
        'OPENTAG_TELEGRAM_TRANSPORT=http requires OPENTAG_TELEGRAM_BOT_TOKEN.',
      );
    }
    return {
      mode: 'http',
      transport: new HttpTelegramTransport({
        botToken: telegramBotToken,
        baseUrl: telegramBaseUrl,
      }),
    };
  }

  const dryRun = new MemoryTelegramTransport();
  return { mode: 'memory', transport: dryRun, dryRun };
}

function genericClientCapabilities(
  _platform: PlatformKind,
): Partial<PlatformCapabilities> {
  return {};
}

function createPlatformForRun(thread: SourceThread): {
  platform: PlatformAdapter;
  transportMode: string;
  larkDryRun?: MemoryLarkTransport;
  larkTransport?: { mode: 'memory' | 'http' };
  telegramDryRun?: MemoryTelegramTransport;
  telegramTransport?: { mode: 'memory' | 'http' };
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

  if (thread.platform === 'telegram') {
    const telegramTransport = createTelegramTransportForRun();
    return {
      platform: new TelegramPlatformAdapter(
        new TrackedTelegramTransport(
          telegramTransport.transport,
          deliveryStore,
        ),
      ),
      transportMode: `telegram-${telegramTransport.mode}`,
      telegramDryRun: telegramTransport.dryRun,
      telegramTransport: { mode: telegramTransport.mode },
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

async function workspaceSnapshot(
  workspaceId = 'dev-workspace',
): Promise<Record<string, unknown>> {
  const [workspacePolicies, projects, bindings, recentRuns, audit, routines] =
    await Promise.all([
      threadConfigStore.listWorkspacePolicies(),
      threadConfigStore.listProjectPolicies(workspaceId),
      deliveryStore.listThreadBindings(500),
      deliveryStore.listAgentRuns({ workspaceId, limit: 500 }),
      threadConfigStore.listAudit(25),
      routineStore.summarize(workspaceId),
    ]);
  const workspacePolicy =
    workspacePolicies.find((item) => item.workspace.id === workspaceId) ??
    workspacePolicies[0];
  return {
    workspace: workspacePolicy,
    projects: projects.map((project) => {
      const matchesProject = (value?: string): boolean =>
        value === project.projectId || value === project.id;
      const projectBindings = bindings.filter(
        (binding) =>
          binding.workspaceId === project.workspaceId &&
          matchesProject(binding.projectId),
      );
      const projectRuns = recentRuns.filter((run) => matchesProject(run.projectId));
      const runSummary = {
        queued: 0,
        running: 0,
        cancel_requested: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };
      for (const run of projectRuns) runSummary[run.status] += 1;
      return {
        ...project,
        clients: [...new Set(projectBindings.map((binding) => binding.platform))],
        bindingCount: projectBindings.length,
        runSummary,
        lastRunAt: projectRuns[0]?.updatedAt,
      };
    }),
    availableTools: Object.entries(PROJECT_TOOL_LABELS).map(([id, label]) => ({
      id,
      label,
    })),
    executors: [
      { id: 'codex', label: 'Codex', mode: executorMode },
      { id: 'claude', label: 'Claude', mode: executorMode },
    ],
    audit,
    routines,
  };
}

function createRuntimeForPlatform(platform: PlatformAdapter): OpenTagRuntime {
  const common = {
    mode: executorMode,
    workspaceRoot: executorWorkspaceRoot,
    timeoutMs: executorTimeoutMs,
    maxOutputBytes: executorMaxOutputBytes,
    inheritEnv: executorInheritEnv,
  } as const;
  const codex = createCodexExecutor({
    ...common,
    command: codexCommand,
    model: codexModel,
  });
  const claude = createClaudeExecutor({
    ...common,
    command: claudeCommand,
    model: claudeModel,
    maxBudgetUsd: claudeMaxBudgetUsd,
  });
  return new OpenTagRuntime({
    platform,
    executor: codex,
    executors: { codex, claude },
    memory: memoryStore,
    threadConfig: threadConfigStore,
  });
}

function coerceDevMessage(body: Record<string, unknown>): {
  thread: SourceThread;
  message: SourceMessage;
} {
  const text = typeof body.text === 'string' ? body.text : 'hello opentag';
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const projectId = stringValue(body, 'projectId', 'opentag');
  const projectName = stringValue(body, 'projectName', projectId);
  const platform = (stringValue(body, 'platform', 'lark') || 'lark') as PlatformKind;
  const channelId = `dev-${projectId}`;
  const topicId = platform === 'telegram' ? '1' : 'root';
  const externalId = `${channelId}:${topicId}`;
  const thread: SourceThread = {
    id: `${platform}:${externalId}`,
    platform,
    externalId,
    workspaceId,
    projectId,
    channelId,
    rootMessageId: platform === 'lark' ? 'root' : undefined,
    topicId,
    title: projectName,
    visibility: 'public',
    metadata: {
      projectId,
    },
  };
  return {
    thread,
    message: {
      id: `dev-${Date.now()}`,
      threadId: thread.id,
      platform,
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

function stringArrayValue(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

const PROJECT_TOOL_LABELS: Record<string, string> = {
  github: 'GitHub',
  'lark-docs': 'Lark Docs',
  'lark-base': 'Lark Base',
  browser: 'Browser',
  shell: 'Shell',
};

function coerceProjectPolicyInput(
  body: Record<string, unknown>,
): UpsertProjectAgentPolicyInput | { error: string } {
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const projectId = stringValue(body, 'projectId');
  if (!workspaceId || !projectId) return { error: 'workspace_and_project_required' };

  const executorId = stringValue(body, 'executorId');
  if (executorId && executorId !== 'codex' && executorId !== 'claude') {
    return { error: 'unsupported_executor' };
  }

  const tools = stringArrayValue(body, 'tools');
  const unsupportedTool = tools?.find((tool) => !PROJECT_TOOL_LABELS[tool]);
  if (unsupportedTool) return { error: `unsupported_tool:${unsupportedTool}` };
  const grants: ToolGrant[] | undefined = tools?.map((tool) => ({
    id: `project:${workspaceId}:${projectId}:${tool}`,
    kind: tool as ToolGrantKind,
    scope: 'project',
    label: PROJECT_TOOL_LABELS[tool],
  }));

  const networkMode = stringValue(body, 'networkMode');
  if (
    networkMode &&
    networkMode !== 'deny-by-default' &&
    networkMode !== 'restricted' &&
    networkMode !== 'allow-all'
  ) {
    return { error: 'unsupported_network_mode' };
  }
  const allowedHosts = stringArrayValue(body, 'allowedHosts');

  const identityValues = {
    id: stringValue(body, 'agentId'),
    displayName: stringValue(body, 'agentName'),
    description: stringValue(body, 'agentDescription'),
    instructions: stringValue(body, 'instructions'),
    defaultExecutorId: executorId,
  };
  const identity = Object.fromEntries(
    Object.entries(identityValues).filter(([, value]) => value !== undefined),
  );

  return {
    workspaceId,
    projectId,
    name: stringValue(body, 'name'),
    description:
      typeof body.description === 'string' ? body.description : undefined,
    identity: Object.keys(identity).length
      ? (identity as UpsertProjectAgentPolicyInput['identity'])
      : undefined,
    grants,
    networkPolicy:
      networkMode || allowedHosts
        ? {
            mode: networkMode as
              | 'deny-by-default'
              | 'restricted'
              | 'allow-all'
              | undefined,
            allowedHosts,
          }
        : undefined,
    actor: stringValue(body, 'actor', 'admin-console'),
  };
}

function coerceRoutineSchedule(
  body: Record<string, unknown>,
): RoutineSchedule | { error: string } {
  const schedule = recordValue(body, 'schedule') || body;
  const kind = stringValue(schedule, 'kind', 'interval');
  if (kind === 'interval') {
    const everyMinutes = numberValue(schedule, 'everyMinutes');
    if (!everyMinutes) return { error: 'routine_interval_minutes_required' };
    return { kind, everyMinutes };
  }
  if (kind === 'daily') {
    const time = stringValue(schedule, 'time');
    const timeZone = stringValue(
      schedule,
      'timeZone',
      defaultRoutineTimeZone,
    );
    if (!time || !timeZone) return { error: 'routine_daily_time_required' };
    return { kind, time, timeZone };
  }
  return { error: 'unsupported_routine_schedule' };
}

function coerceRoutineInput(
  body: Record<string, unknown>,
): UpsertRoutineInput | { error: string } {
  const schedule = coerceRoutineSchedule(body);
  if ('error' in schedule) return schedule;
  const destination = recordValue(body, 'destination') || body;
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const name = stringValue(body, 'name');
  const instructions = stringValue(body, 'instructions');
  const platform = stringValue(destination, 'platform', 'lark');
  const externalId = stringValue(destination, 'externalId');
  if (!workspaceId || !name || !instructions || !platform || !externalId) {
    return {
      error:
        'routine_workspace_name_instructions_platform_destination_required',
    };
  }
  return {
    id: stringValue(body, 'id'),
    workspaceId,
    projectId: stringValue(body, 'projectId'),
    name,
    instructions,
    enabled: booleanValue(body, 'enabled', true),
    schedule,
    destination: {
      platform: platform as PlatformKind,
      externalId,
      channelId: stringValue(destination, 'channelId', externalId),
      threadId: stringValue(destination, 'threadId'),
      rootMessageId: stringValue(destination, 'rootMessageId'),
      topicId: stringValue(destination, 'topicId'),
      visibility: visibilityValue(destination.visibility) || 'public',
      title: stringValue(destination, 'title', name),
    },
    actor: stringValue(body, 'actor', 'admin-console'),
  };
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
  telegramTransport?: {
    mode: 'memory' | 'http';
  };
}

interface AgentWorkerPassResult {
  claimed: number;
  completed: number;
  failed: number;
  runs: AgentRunRecord[];
}

interface RoutineTickResult {
  at: string;
  staged: number;
  claimed: number;
  queued: number;
  failed: number;
  reconciled: number;
  executionIds: string[];
  runIds: string[];
}

async function enqueueMessageRun(input: {
  thread: SourceThread;
  message: SourceMessage;
}, options?: {
  inboundEventId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
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
  const telegramTransport =
    routed.thread.platform === 'telegram'
      ? telegramTransportStatus()
      : undefined;
  const transportMode = larkTransport
    ? `lark-${String(larkTransport.mode)}`
    : telegramTransport
      ? `telegram-${telegramTransport.mode}`
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
  const resolvedPolicy = await threadConfigStore.resolveThreadPolicy(routed.thread);
  const run = await deliveryStore.createAgentRun({
    runId,
    thread: routed.thread,
    message: routed.message,
    inboundEventId: options?.inboundEventId,
    bindingId: routeBinding.id,
    executorId: memoryCommand
      ? 'memory-command'
      : resolvedPolicy.identity.defaultExecutorId,
    transportMode,
    metadata: {
      ...options?.metadata,
      memoryCommand: memoryCommand
        ? { kind: memoryCommand.kind, scope: memoryCommand.scope }
        : undefined,
      agentId: resolvedPolicy.identity.id,
      agentDisplayName: resolvedPolicy.identity.displayName,
      policyConfigured: resolvedPolicy.configured,
      grantKinds: resolvedPolicy.access.grants.map((grant) => grant.kind),
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
    telegramTransport: telegramTransport
      ? { mode: telegramTransport.mode }
      : undefined,
  };
}

async function routineProjectId(routine: Routine): Promise<string> {
  if (routine.projectId) return routine.projectId;
  const workspaces = await threadConfigStore.listWorkspacePolicies();
  return (
    workspaces.find((item) => item.workspace.id === routine.workspaceId)
      ?.workspace.defaultProjectId || 'opentag'
  );
}

async function routineRunInput(claim: RoutineClaim): Promise<{
  thread: SourceThread;
  message: SourceMessage;
}> {
  const routine = claim.routine;
  const destination = routine.destination;
  const projectId = await routineProjectId(routine);
  const threadId =
    destination.threadId ||
    `${destination.platform}:${destination.externalId}:routine:${routine.id}`;
  const thread: SourceThread = {
    id: threadId,
    platform: destination.platform,
    externalId: destination.externalId,
    workspaceId: routine.workspaceId,
    projectId,
    channelId: destination.channelId || destination.externalId,
    rootMessageId: destination.rootMessageId,
    topicId: destination.topicId,
    title: destination.title || routine.name,
    visibility: destination.visibility,
    metadata: {
      routineId: routine.id,
      routineExecutionId: claim.execution.id,
      routineTrigger: claim.execution.trigger,
    },
  };
  return {
    thread,
    message: {
      id: `routine:${claim.execution.id}`,
      threadId,
      platform: destination.platform,
      text: routine.instructions,
      actor: {
        id: `routine:${routine.id}`,
        displayName: routine.name,
        isBot: true,
      },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
      metadata: {
        routineId: routine.id,
        routineExecutionId: claim.execution.id,
        scheduledFor: claim.execution.scheduledFor,
      },
    },
  };
}

async function reconcileRoutineExecutions(): Promise<number> {
  const executions = await routineStore.listExecutions({ limit: 500 });
  let reconciled = 0;
  for (const execution of executions) {
    if (!execution.runId) continue;
    if (
      execution.status === 'completed' ||
      execution.status === 'failed' ||
      execution.status === 'cancelled'
    ) {
      continue;
    }
    const run = await deliveryStore.getAgentRun(execution.runId);
    if (!run) continue;
    const status =
      run.status === 'cancel_requested' ? 'running' : run.status;
    await routineStore.reconcileRun({
      runId: run.id,
      status,
      summary: run.summary,
      error: run.lastError,
    });
    reconciled += 1;
  }
  return reconciled;
}

async function enqueueRoutineClaim(claim: RoutineClaim): Promise<string> {
  const input = await routineRunInput(claim);
  const queued = await enqueueMessageRun(input, {
    runId: `routine:${claim.execution.id}`,
    metadata: {
      source: 'routine',
      routineId: claim.routine.id,
      routineName: claim.routine.name,
      routineExecutionId: claim.execution.id,
      routineTrigger: claim.execution.trigger,
      routineScheduledFor: claim.execution.scheduledFor,
    },
  });
  await routineStore.markExecutionQueued(
    claim.execution.id,
    queued.run.id,
  );
  scheduleAgentWorkerPass();
  return queued.run.id;
}

async function runRoutineSchedulerTick(input?: {
  at?: Date;
  stageDue?: boolean;
}): Promise<RoutineTickResult> {
  if (routineTickPass) return routineTickPass;
  routineTickPass = (async () => {
    const at = input?.at ?? new Date();
    const reconciledBefore = await reconcileRoutineExecutions();
    const staged = input?.stageDue === false
      ? []
      : await routineStore.stageDue(at, 100);
    const claims = await routineStore.claimExecutions({
      claimerId: routineSchedulerId,
      limit: 100,
      staleAfterMs: routineClaimStaleMs,
      at,
    });
    const result: RoutineTickResult = {
      at: at.toISOString(),
      staged: staged.length,
      claimed: claims.length,
      queued: 0,
      failed: 0,
      reconciled: reconciledBefore,
      executionIds: claims.map((claim) => claim.execution.id),
      runIds: [],
    };
    for (const claim of claims) {
      try {
        const runId = await enqueueRoutineClaim(claim);
        result.queued += 1;
        result.runIds.push(runId);
      } catch (error) {
        result.failed += 1;
        await routineStore.markExecutionFailed(
          claim.execution.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    result.reconciled += await reconcileRoutineExecutions();
    routineLastTickAt = result.at;
    routineLastTickResult = result;
    return result;
  })();
  try {
    return await routineTickPass;
  } finally {
    routineTickPass = undefined;
  }
}

async function routineSnapshot(
  workspaceId = 'dev-workspace',
  projectId?: string,
): Promise<Record<string, unknown>> {
  await reconcileRoutineExecutions();
  const [routines, executions, summary, audit] = await Promise.all([
    routineStore.listRoutines({ workspaceId, projectId }),
    routineStore.listExecutions({ workspaceId, projectId, limit: 200 }),
    routineStore.summarize(workspaceId, projectId),
    routineStore.listAudit({ workspaceId, projectId, limit: 50 }),
  ]);
  return {
    routines,
    executions,
    summary,
    audit,
    scheduler: {
      enabled: routinesEnabled,
      tickIntervalMs: routineTickIntervalMs,
      claimStaleMs: routineClaimStaleMs,
      running: Boolean(routineTickPass),
      lastTickAt: routineLastTickAt,
      lastTickResult: routineLastTickResult,
    },
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
        telegramTransport: runPlatform.telegramTransport,
        telegramDryRun: runPlatform.telegramDryRun
          ? {
              texts: runPlatform.telegramDryRun.texts,
              edits: runPlatform.telegramDryRun.edits,
              documents: runPlatform.telegramDryRun.documents,
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
      telegramTransport: runPlatform.telegramTransport,
      telegramDryRun: runPlatform.telegramDryRun
        ? {
            texts: runPlatform.telegramDryRun.texts,
            edits: runPlatform.telegramDryRun.edits,
            documents: runPlatform.telegramDryRun.documents,
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
        executors: executorStatus(),
        clients: {
          lark: larkTransportStatus(),
          telegram: telegramTransportStatus(),
        },
        routines: {
          enabled: routinesEnabled,
          running: Boolean(routineTickPass),
          lastTickAt: routineLastTickAt,
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
        telegramTransport: telegramTransportStatus(),
        runWorker: {
          mode: agentWorkerMode,
          enabled: agentWorkerEnabled,
          intervalMs: agentWorkerIntervalMs,
          staleMs: agentWorkerStaleMs,
          activeRuns: activeRuns.size,
          passRunning: Boolean(agentWorkerPass),
        },
        executorRuntime: executorStatus(),
        routines: {
          enabled: routinesEnabled,
          tickIntervalMs: routineTickIntervalMs,
          claimStaleMs: routineClaimStaleMs,
          running: Boolean(routineTickPass),
          lastTickAt: routineLastTickAt,
          lastTickResult: routineLastTickResult,
        },
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/workspace') {
      sendJson(
        response,
        200,
        await workspaceSnapshot(
          url.searchParams.get('workspaceId') || 'dev-workspace',
        ),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/projects') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceProjectPolicyInput(body);
      if ('error' in input) {
        sendJson(response, 400, { error: input.error });
        return;
      }
      const project = await threadConfigStore.upsertProjectPolicy(input);
      sendJson(response, 200, {
        project,
        workspace: await workspaceSnapshot(project.workspaceId),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/config/audit') {
      sendJson(response, 200, {
        audit: await threadConfigStore.listAudit(
          Number(url.searchParams.get('limit') || 50),
        ),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/routines') {
      sendJson(
        response,
        200,
        await routineSnapshot(
          url.searchParams.get('workspaceId') || 'dev-workspace',
          url.searchParams.get('projectId') || undefined,
        ),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/routines/tick') {
      const result = await runRoutineSchedulerTick();
      sendJson(response, 200, {
        result,
        routines: await routineSnapshot(),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/routines') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceRoutineInput(body);
      if ('error' in input) {
        sendJson(response, 400, { error: input.error });
        return;
      }
      try {
        const routine = await routineStore.upsertRoutine(input);
        sendJson(response, 200, {
          routine,
          routines: await routineSnapshot(routine.workspaceId),
        });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/routines/') &&
      url.pathname.endsWith('/trigger')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/routines/'.length, -'/trigger'.length),
      );
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      try {
        const execution = await routineStore.triggerRoutine(
          id,
          stringValue(body, 'actor', 'admin-console'),
        );
        const tick = await runRoutineSchedulerTick({ stageDue: false });
        const currentExecution = (
          await routineStore.listExecutions({ routineId: id, limit: 50 })
        ).find((item) => item.id === execution.id);
        sendJson(response, 202, {
          accepted: true,
          execution: currentExecution || execution,
          tick,
          routines: await routineSnapshot(execution.routine.workspaceId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'routine_not_found' ? 404 : 400, {
          error: message,
        });
      }
      return;
    }

    if (
      request.method === 'DELETE' &&
      url.pathname.startsWith('/v1/routines/')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/routines/'.length),
      );
      const routine = await routineStore.deleteRoutine(id, 'admin-console');
      if (!routine) {
        sendJson(response, 404, { error: 'routine_not_found' });
        return;
      }
      sendJson(response, 200, {
        routine,
        routines: await routineSnapshot(routine.workspaceId),
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
        platform: normalized.thread.platform,
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

    if (request.method === 'POST' && url.pathname === '/v1/telegram/events') {
      const rawBody = await readTextBody(request);
      const parsed = parseAndValidateTelegramCallback(
        rawBody,
        request.headers,
        { webhookSecret: telegramWebhookSecret },
      );
      const body = parsed.body;
      const externalId = telegramCallbackExternalId(body);
      const eventType = telegramCallbackEventType(body);
      if (!parsed.validation.ok) {
        const rejected = await deliveryStore.recordInboundEvent({
          platform: 'telegram',
          externalId: `rejected:${externalId}:${randomUUID()}`,
          eventType,
          metadata: {
            ingress: 'telegram-webhook',
            originalExternalId: externalId,
            reason: parsed.validation.reason,
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

      const normalized = normalizeTelegramUpdate(body as TelegramUpdate, {
        botUsername: telegramBotUsername,
        workspaceId: telegramWorkspaceId,
      });
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'telegram',
        externalId,
        eventType,
        workspaceId: normalized?.thread.workspaceId,
        projectId: normalized?.thread.projectId,
        threadId: normalized?.thread.id,
        messageId: normalized?.message.id,
        metadata: { ingress: 'telegram-webhook' },
      });
      if (inbound.duplicate) {
        sendJson(response, 200, {
          accepted: true,
          duplicate: true,
          inbound: inbound.record,
        });
        return;
      }
      if (!normalized) {
        await deliveryStore.markInboundEventIgnored(
          inbound.record.id,
          'unsupported_telegram_update',
        );
        sendJson(response, 202, {
          accepted: false,
          reason: 'unsupported_telegram_update',
        });
        return;
      }

      const routed = await routeMessage(normalized);
      if (telegramRequireBinding && routed.binding?.source !== 'configured') {
        await deliveryStore.markInboundEventIgnored(
          inbound.record.id,
          'binding_required',
          {
            workspaceId: routed.thread.workspaceId,
            projectId: routed.thread.projectId,
            threadId: routed.thread.id,
            messageId: routed.message.id,
          },
        );
        sendJson(response, 202, {
          accepted: false,
          reason: 'binding_required',
          route: {
            workspaceId: routed.thread.workspaceId,
            projectId: routed.thread.projectId,
            threadId: routed.thread.id,
            platform: routed.thread.platform,
          },
        });
        return;
      }
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
  if (routinesEnabled) {
    void runRoutineSchedulerTick().catch((error) => {
      console.error('OpenTag routine startup tick failed', error);
    });
    const routineInterval = setInterval(() => {
      void runRoutineSchedulerTick().catch((error) => {
        console.error('OpenTag routine tick failed', error);
      });
    }, routineTickIntervalMs);
    routineInterval.unref?.();
  }
});
