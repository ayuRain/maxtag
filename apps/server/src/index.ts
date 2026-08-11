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
  FilePairingStore,
  FileThreadConfigStore,
  FileWorkspaceAccessStore,
  type ActorAuthorizationDecision,
  type ActorCapability,
  type PairingActivationMode,
  type ProjectAccessMode,
  type ProjectRole,
  type UpsertProjectAgentPolicyInput,
  type WorkspaceMemberIdentity,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '@opentag/config';
import {
  FileDeliveryStore,
  TrackedLarkTransport,
  TrackedTelegramTransport,
  TrackedTextPlatformAdapter,
  runDeliveryWorkerPass,
  type CancelOutboxOptions,
  type AgentRunRecord,
  type AgentRunSteeringRecord,
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
  RoutineCommandService,
  type ParsedRoutineCommand,
  type RoutineExecution,
  type RoutineSchedule,
  type UpsertRoutineInput,
} from '@opentag/routines';
import {
  createDurableSteeringProvider,
  monitorDurableRunCancellation,
  RoutineSchedulerService,
  WorkflowCoordinatorService,
  type RoutineTickResult,
  type WorkflowCoordinatorTickResult,
} from '@opentag/runtime-host';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';
import {
  FileWorkflowStore,
  type UpsertWorkflowInput,
  type WorkflowDestination,
  type WorkflowNode,
  type WorkflowTrigger,
} from '@opentag/workflows';
import {
  OperatorAuth,
  bearerTokenMatches,
  parseOperatorCredentials,
  type OperatorAuthentication,
  type OperatorPrincipal,
  type OperatorRole,
} from './operator-auth.js';

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
const larkRequireBinding = ['1', 'true', 'yes'].includes(
  String(process.env.OPENTAG_LARK_REQUIRE_BINDING || 'false').toLowerCase(),
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
const pairingTtlSeconds = Math.max(
  30,
  numberEnvironmentValue('OPENTAG_PAIRING_TTL_SECONDS', 300),
);
const agentWorkerMode = process.env.OPENTAG_AGENT_WORKER || 'inline';
const agentWorkerEnabled = agentWorkerMode !== 'manual';
const agentWorkerIntervalMs = Number(process.env.OPENTAG_AGENT_WORKER_INTERVAL_MS || 2000);
const runControlPollMs = Math.max(
  25,
  Number(process.env.OPENTAG_RUN_CONTROL_POLL_MS || 250),
);
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
const routineSchedulerMode = routineSchedulerModeValue(
  process.env.OPENTAG_ROUTINE_SCHEDULER,
  routinesEnabled,
);
const routineSchedulerInline =
  routinesEnabled && routineSchedulerMode === 'inline';
const routineTickIntervalMs = numberEnvironmentValue(
  'OPENTAG_ROUTINE_TICK_INTERVAL_MS',
  30_000,
);
const routineClaimStaleMs = numberEnvironmentValue(
  'OPENTAG_ROUTINE_CLAIM_STALE_MS',
  120_000,
);
const routineBatchSize = Math.min(
  100,
  numberEnvironmentValue('OPENTAG_ROUTINE_BATCH_SIZE', 100),
);
const defaultRoutineTimeZone =
  process.env.OPENTAG_DEFAULT_TIME_ZONE || 'Asia/Shanghai';
const workflowsEnabled = !['0', 'false', 'no'].includes(
  String(process.env.OPENTAG_WORKFLOWS_ENABLED || 'true').toLowerCase(),
);
const workflowCoordinatorMode = workflowCoordinatorModeValue(
  process.env.OPENTAG_WORKFLOW_COORDINATOR,
  workflowsEnabled,
);
const workflowCoordinatorInline =
  workflowsEnabled && workflowCoordinatorMode === 'inline';
const workflowTickIntervalMs = numberEnvironmentValue(
  'OPENTAG_WORKFLOW_TICK_INTERVAL_MS',
  2_000,
);
const workflowClaimStaleMs = numberEnvironmentValue(
  'OPENTAG_WORKFLOW_CLAIM_STALE_MS',
  120_000,
);
const workflowBatchSize = Math.min(
  100,
  numberEnvironmentValue('OPENTAG_WORKFLOW_BATCH_SIZE', 20),
);
const legacyOperatorWorkspaceIds = listEnvironmentValue(
  'OPENTAG_ADMIN_WORKSPACE_IDS',
) ?? [];
const operatorAuth = new OperatorAuth({
  token: process.env.OPENTAG_ADMIN_TOKEN,
  principal: {
    id: process.env.OPENTAG_ADMIN_PRINCIPAL_ID || 'installation-owner',
    displayName:
      process.env.OPENTAG_ADMIN_PRINCIPAL_NAME || 'Installation owner',
    role: operatorRoleValue(process.env.OPENTAG_ADMIN_ROLE) ?? 'owner',
    workspaceIds: legacyOperatorWorkspaceIds.length
      ? legacyOperatorWorkspaceIds
      : ['*'],
  },
  credentials: parseOperatorCredentials(
    process.env.OPENTAG_OPERATOR_PRINCIPALS_JSON,
  ),
  sessionSecret: process.env.OPENTAG_OPERATOR_SESSION_SECRET,
  sessionTtlSeconds: numberEnvironmentValue(
    'OPENTAG_ADMIN_SESSION_TTL_SECONDS',
    8 * 60 * 60,
  ),
  secureCookie: ['1', 'true', 'yes'].includes(
    String(process.env.OPENTAG_ADMIN_COOKIE_SECURE || 'false').toLowerCase(),
  ),
});
const clientIngressToken = process.env.OPENTAG_CLIENT_INGRESS_TOKEN;
const workflowIngressToken = process.env.OPENTAG_WORKFLOW_INGRESS_TOKEN;
const workflowIngressActor =
  process.env.OPENTAG_WORKFLOW_INGRESS_ACTOR?.trim() || 'workflow-ingress';
const storageDriver = storageDriverValue(process.env.OPENTAG_STORAGE_DRIVER);
const sqliteStorage =
  storageDriver === 'sqlite'
    ? new SqliteOpenTagStore({
        databasePath:
          process.env.OPENTAG_SQLITE_PATH || path.join(dataDir, 'opentag.sqlite'),
        pairingTtlMs: pairingTtlSeconds * 1000,
        busyTimeoutMs: numberEnvironmentValue(
          'OPENTAG_SQLITE_BUSY_TIMEOUT_MS',
          5_000,
        ),
        legacyDeliveryFile: path.join(
          dataDir,
          'delivery',
          'delivery-state.json',
        ),
        legacyPairingFile: path.join(
          dataDir,
          'pairing',
          'pairing-state.json',
        ),
        legacyAccessFile: path.join(
          dataDir,
          'access',
          'workspace-access.json',
        ),
        legacyMemoryDir: path.join(dataDir, 'memory'),
        legacyRoutineFile: path.join(
          dataDir,
          'routines',
          'routine-state.json',
        ),
        legacyWorkflowFile: path.join(
          dataDir,
          'workflows',
          'workflow-state.json',
        ),
      })
    : undefined;
const routineSchedulerId = `opentag-routines-${process.pid}`;
const deliveryStore =
  sqliteStorage?.deliveryStore ??
  new FileDeliveryStore(path.join(dataDir, 'delivery'));
const memoryStore =
  sqliteStorage?.memoryStore ??
  new ScopedFileMemoryStore(path.join(dataDir, 'memory'));
const routineStore =
  sqliteStorage?.routineStore ??
  new FileRoutineStore(path.join(dataDir, 'routines'));
const workflowStore =
  sqliteStorage?.workflowStore ??
  new FileWorkflowStore(path.join(dataDir, 'workflows'));
const routineCommandService = new RoutineCommandService(routineStore, {
  defaultTimeZone: defaultRoutineTimeZone,
});
const pairingStore =
  sqliteStorage?.pairingStore ??
  new FilePairingStore(path.join(dataDir, 'pairing'), {
    ttlMs: pairingTtlSeconds * 1000,
  });
const accessStore =
  sqliteStorage?.accessStore ??
  new FileWorkspaceAccessStore(path.join(dataDir, 'access'));
const activeRuns = new Map<string, AbortController>();
const pairingNoticeAt = new Map<string, number>();
const accessNoticeAt = new Map<string, number>();
let agentWorkerTimer: NodeJS.Timeout | undefined;
let agentWorkerPass: Promise<AgentWorkerPassResult> | undefined;
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
const routineScheduler = new RoutineSchedulerService({
  routineStore,
  deliveryStore,
  threadConfigStore,
  schedulerId: routineSchedulerId,
  claimStaleMs: routineClaimStaleMs,
  batchSize: routineBatchSize,
  transportModeForPlatform: (platform) => {
    if (platform === 'lark') return `lark-${String(larkTransportStatus().mode)}`;
    if (platform === 'telegram') {
      return `telegram-${telegramTransportStatus().mode}`;
    }
    return 'tracked-text';
  },
  onRunQueued: () => scheduleAgentWorkerPass(),
});
const workflowCoordinator = new WorkflowCoordinatorService({
  workflowStore,
  deliveryStore,
  threadConfigStore,
  coordinatorId: `opentag-workflows-${process.pid}`,
  claimStaleMs: workflowClaimStaleMs,
  batchSize: workflowBatchSize,
  transportModeForPlatform: (platform) => {
    if (platform === 'lark') return `lark-${String(larkTransportStatus().mode)}`;
    if (platform === 'telegram') {
      return `telegram-${telegramTransportStatus().mode}`;
    }
    return platform === 'workflow' ? 'workflow-internal' : 'tracked-text';
  },
  onRunQueued: () => scheduleAgentWorkerPass(),
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
      opentag: 'transactional global/workspace/project/thread documents with immutable revisions and restore',
      status: 'ready',
    },
    {
      capability: 'Channel binding',
      agentdock: 'chat/session routing and activation controls',
      opentag: 'admin-configured project route and activation mode',
      status: 'partial',
    },
    {
      capability: 'Self-service pairing',
      agentdock: 'one-time IM pairing codes bind chats to an owner workspace',
      opentag: 'one-time client/project invitations bind chats to workspace projects',
      status: 'partial',
    },
    {
      capability: 'Project agent policy',
      agentdock: 'agent templates, tool nodes, and per-session configuration',
      opentag: 'persisted identity, instructions, executor, project grants, network policy, and audit',
      status: 'partial',
    },
    {
      capability: 'Workspace governance',
      agentdock: 'owner-scoped sessions and operator permissions',
      opentag: 'workspace identities, project roles, and capability checks on every client ingress',
      status: 'partial',
    },
    {
      capability: 'Topic continuation',
      agentdock: 'mention starts a topic, follow-up messages continue the session',
      opentag: 'observed bindings plus a durable single-flight follow-up mailbox preserve thread order across processes',
      status: 'ready',
    },
    {
      capability: 'Shared task steering',
      agentdock: 'active session input can steer the current runtime turn',
      opentag: 'live steering executor contract; Codex and Claude one-shot CLIs continue follow-ups as durable next turns',
      status: 'partial',
    },
    {
      capability: 'Reliable delivery',
      agentdock: 'SQLite outbox and turn delivery tracking',
      opentag: 'SQLite WAL outbox, turn delivery tracking, and cross-process claims',
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
      opentag: 'SQLite routines and workflow DAGs with inline or independent coordination into the durable run queue',
      status: 'partial',
    },
  ],
};

function larkDomainValue(value: string | undefined): LarkOpenApiDomain {
  return value === 'lark' ? 'lark' : 'feishu';
}

function storageDriverValue(value: string | undefined): 'sqlite' | 'file' {
  const normalized = (value || 'sqlite').trim().toLowerCase();
  if (normalized === 'sqlite' || normalized === 'file') return normalized;
  throw new Error('OPENTAG_STORAGE_DRIVER must be sqlite or file.');
}

function routineSchedulerModeValue(
  value: string | undefined,
  enabled: boolean,
): 'inline' | 'external' | 'manual' {
  if (!enabled) return 'manual';
  const normalized = (value || 'inline').trim().toLowerCase();
  if (
    normalized === 'inline' ||
    normalized === 'external' ||
    normalized === 'manual'
  ) {
    return normalized;
  }
  throw new Error(
    'OPENTAG_ROUTINE_SCHEDULER must be inline, external, or manual.',
  );
}

function workflowCoordinatorModeValue(
  value: string | undefined,
  enabled: boolean,
): 'inline' | 'external' | 'manual' {
  if (!enabled) return 'manual';
  const normalized = (value || 'inline').trim().toLowerCase();
  if (
    normalized === 'inline' ||
    normalized === 'external' ||
    normalized === 'manual'
  ) {
    return normalized;
  }
  throw new Error(
    'OPENTAG_WORKFLOW_COORDINATOR must be inline, external, or manual.',
  );
}

function operatorRoleValue(value: string | undefined): OperatorRole | undefined {
  if (!value) return undefined;
  if (value === 'owner' || value === 'admin' || value === 'viewer') return value;
  throw new Error('OPENTAG_ADMIN_ROLE must be owner, admin, or viewer.');
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
      steeringMode: 'next_turn',
    },
    claude: {
      command: claudeCommand,
      model: claudeModel,
      maxBudgetUsd: claudeMaxBudgetUsd,
      steeringMode: 'next_turn',
    },
    runControlPollMs,
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
    verificationTokenConfigured: Boolean(larkVerificationToken),
    requireBinding: larkRequireBinding,
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
  headers: Record<string, string | string[]> = {},
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(body, null, 2));
}

function requiresCsrf(request: IncomingMessage): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method || 'GET');
}

function requireOperator(
  request: IncomingMessage,
  response: ServerResponse,
): OperatorAuthentication | undefined {
  const authentication = operatorAuth.authenticate(request);
  if (!authentication.authenticated) {
    sendJson(
      response,
      401,
      { error: 'operator_auth_required' },
      {
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer realm="OpenTag operator"',
      },
    );
    return undefined;
  }
  if (
    requiresCsrf(request) &&
    authentication.method === 'session' &&
    !authentication.csrfValid
  ) {
    sendJson(
      response,
      403,
      { error: 'operator_csrf_required' },
      { 'cache-control': 'no-store' },
    );
    return undefined;
  }
  if (
    requiresCsrf(request) &&
    authentication.principal?.role === 'viewer'
  ) {
    sendJson(
      response,
      403,
      { error: 'operator_write_required' },
      { 'cache-control': 'no-store' },
    );
    return undefined;
  }
  return authentication;
}

function operatorActor(authentication: OperatorAuthentication): string {
  return `operator:${authentication.principal?.id || 'unknown'}`;
}

function operatorCanAccessWorkspace(
  principal: OperatorPrincipal | undefined,
  workspaceId: string,
): boolean {
  return Boolean(
    principal &&
      (principal.workspaceIds.includes('*') ||
        principal.workspaceIds.includes(workspaceId)),
  );
}

function requireOperatorWorkspace(
  response: ServerResponse,
  authentication: OperatorAuthentication,
  workspaceId: string,
): boolean {
  if (operatorCanAccessWorkspace(authentication.principal, workspaceId)) {
    return true;
  }
  sendJson(
    response,
    403,
    { error: 'operator_workspace_forbidden', workspaceId },
    { 'cache-control': 'no-store' },
  );
  return false;
}

function requireInstallationOperator(
  response: ServerResponse,
  authentication: OperatorAuthentication,
): boolean {
  if (authentication.principal?.workspaceIds.includes('*')) return true;
  sendJson(
    response,
    403,
    { error: 'installation_operator_required' },
    { 'cache-control': 'no-store' },
  );
  return false;
}

function scopedOperatorWorkspace(
  authentication: OperatorAuthentication,
): string | undefined {
  const workspaceIds = authentication.principal?.workspaceIds ?? [];
  return workspaceIds.includes('*') || workspaceIds.length !== 1
    ? undefined
    : workspaceIds[0];
}

function operatorCollectionWorkspace(
  response: ServerResponse,
  authentication: OperatorAuthentication,
  requestedWorkspaceId?: string,
): { ok: true; workspaceId?: string } | { ok: false } {
  const workspaceId =
    requestedWorkspaceId?.trim() || scopedOperatorWorkspace(authentication);
  if (workspaceId) {
    return requireOperatorWorkspace(response, authentication, workspaceId)
      ? { ok: true, workspaceId }
      : { ok: false };
  }
  if (authentication.principal?.workspaceIds.includes('*')) {
    return { ok: true };
  }
  sendJson(
    response,
    400,
    { error: 'operator_workspace_required' },
    { 'cache-control': 'no-store' },
  );
  return { ok: false };
}

function genericClientIngressMode(): 'local-open' | 'bearer' | 'disabled' {
  if (clientIngressToken) return 'bearer';
  return operatorAuth.configured ? 'disabled' : 'local-open';
}

function workflowIngressMode(): 'local-open' | 'bearer' | 'disabled' {
  if (workflowIngressToken) return 'bearer';
  return operatorAuth.configured ? 'disabled' : 'local-open';
}

async function sendFileResponse(
  response: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  const content = await readFile(filePath);
  response.writeHead(200, {
    'content-type': contentType,
    'content-security-policy': [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "script-src 'self'",
      "style-src 'self'",
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
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

async function deliverySnapshot(
  limit = 50,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  const [summary, outbox, turnDeliveries, bindings, inboundEvents, steering] =
    await Promise.all([
      deliveryStore.summarize(workspaceId),
      deliveryStore.listOutbox({ limit, workspaceId }),
      deliveryStore.listTurnDeliveries({ limit, workspaceId }),
      deliveryStore.listThreadBindings(limit, workspaceId),
      deliveryStore.listInboundEvents({ limit, workspaceId }),
      deliveryStore.listAgentRunSteering({ limit, workspaceId }),
    ]);
  return {
    workspaceId,
    summary,
    outbox: outbox.map(stripPayload),
    turnDeliveries,
    bindings,
    inboundEvents,
    steering,
  };
}

async function workspaceSnapshot(
  workspaceId = 'dev-workspace',
): Promise<Record<string, unknown>> {
  const [
    workspacePolicies,
    projects,
    bindings,
    recentRuns,
    audit,
    routines,
    access,
  ] =
    await Promise.all([
      threadConfigStore.listWorkspacePolicies(),
      threadConfigStore.listProjectPolicies(workspaceId),
      deliveryStore.listThreadBindings(500),
      deliveryStore.listAgentRuns({ workspaceId, limit: 500 }),
      threadConfigStore.listAudit(25, workspaceId),
      routineStore.summarize(workspaceId),
      accessStore.snapshot(workspaceId, 10),
    ]);
  const workspacePolicy =
    workspacePolicies.find((item) => item.workspace.id === workspaceId);
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
      const accessPolicy = access.projectPolicies.find((policy) =>
        matchesProject(policy.projectId),
      );
      const projectMembers = access.projectMemberships.filter((membership) =>
        matchesProject(membership.projectId),
      );
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
        accessMode: accessPolicy?.mode ?? 'open',
        memberCount: projectMembers.length,
      };
    }),
    accessSummary: {
      members: access.members.length,
      activeMembers: access.members.filter((member) => member.status === 'active')
        .length,
      managedProjects: access.projectPolicies.filter(
        (policy) => policy.mode !== 'open',
      ).length,
    },
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
  };
}

function coerceWorkflowInput(
  body: Record<string, unknown>,
): UpsertWorkflowInput | { error: string } {
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const projectId = stringValue(body, 'projectId');
  const name = stringValue(body, 'name');
  const triggerBody = recordValue(body, 'trigger') || {};
  const triggerKind = stringValue(triggerBody, 'kind', 'manual');
  let trigger: WorkflowTrigger;
  if (triggerKind === 'manual') {
    trigger = { kind: 'manual' };
  } else if (triggerKind === 'event') {
    const eventType = stringValue(triggerBody, 'eventType');
    if (!eventType) return { error: 'workflow_event_type_required' };
    trigger = { kind: 'event', eventType };
  } else {
    return { error: 'workflow_trigger_invalid' };
  }
  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes)) return { error: 'workflow_nodes_required' };
  const nodes: WorkflowNode[] = [];
  for (const rawNode of rawNodes) {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
      return { error: 'workflow_node_invalid' };
    }
    const node = rawNode as Record<string, unknown>;
    const id = stringValue(node, 'id');
    const instructions = stringValue(node, 'instructions');
    if (!id || !instructions) {
      return { error: 'workflow_node_id_instructions_required' };
    }
    nodes.push({
      id,
      name: stringValue(node, 'name'),
      instructions,
      dependsOn: stringArrayValue(node, 'dependsOn'),
      publish: booleanValue(node, 'publish'),
    });
  }
  const destinationBody = recordValue(body, 'destination') || {};
  const platform = stringValue(destinationBody, 'platform', 'lark');
  const externalId = stringValue(destinationBody, 'externalId');
  if (!workspaceId || !projectId || !name || !platform || !externalId) {
    return {
      error: 'workflow_workspace_project_name_platform_destination_required',
    };
  }
  const destination: WorkflowDestination = {
    platform: platform as PlatformKind,
    externalId,
    channelId: stringValue(destinationBody, 'channelId', externalId),
    threadId: stringValue(destinationBody, 'threadId'),
    rootMessageId: stringValue(destinationBody, 'rootMessageId'),
    topicId: stringValue(destinationBody, 'topicId'),
    visibility: visibilityValue(destinationBody.visibility) || 'public',
    title: stringValue(destinationBody, 'title', name),
  };
  return {
    id: stringValue(body, 'id'),
    workspaceId,
    projectId,
    name,
    description: stringValue(body, 'description'),
    enabled: booleanValue(body, 'enabled', true),
    trigger,
    nodes,
    destination,
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

function workspaceRoleValue(value: unknown): WorkspaceRole | undefined {
  return value === 'owner' ||
    value === 'admin' ||
    value === 'member' ||
    value === 'guest'
    ? value
    : undefined;
}

function workspaceMemberStatusValue(
  value: unknown,
): WorkspaceMemberStatus | undefined {
  return value === 'active' || value === 'suspended' ? value : undefined;
}

function projectRoleValue(value: unknown): ProjectRole | undefined {
  return value === 'manager' ||
    value === 'contributor' ||
    value === 'viewer'
    ? value
    : undefined;
}

function projectAccessModeValue(value: unknown): ProjectAccessMode | undefined {
  return value === 'open' || value === 'workspace' || value === 'members'
    ? value
    : undefined;
}

function workspaceMemberIdentities(
  body: Record<string, unknown>,
): WorkspaceMemberIdentity[] {
  if (Array.isArray(body.identities)) {
    return body.identities.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const identity = entry as Record<string, unknown>;
      const platform = stringValue(identity, 'platform');
      const externalId = stringValue(identity, 'externalId');
      return platform && externalId
        ? [{ platform, externalId } as WorkspaceMemberIdentity]
        : [];
    });
  }
  const platform = stringValue(body, 'platform');
  const externalId =
    stringValue(body, 'externalId') || stringValue(body, 'platformUserId');
  return platform && externalId ? [{ platform, externalId }] : [];
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

function requiredActorCapability(input: {
  thread: SourceThread;
  message: SourceMessage;
}): ActorCapability {
  const memoryCommand = parseMemoryCommand(input.message.text, {
    defaultScope: memoryCommandDefaultScope(input.thread),
  });
  if (
    memoryCommand?.kind === 'remember' ||
    memoryCommand?.kind === 'forget'
  ) {
    return 'write_memory';
  }
  const routineCommand = routineCommandService.parse(input.message.text);
  if (
    routineCommand &&
    routineCommand.kind !== 'list' &&
    routineCommand.kind !== 'help'
  ) {
    return 'manage_routines';
  }
  return 'invoke_agent';
}

async function authorizeRoutedMessage(input: {
  thread: SourceThread;
  message: SourceMessage;
}): Promise<ActorAuthorizationDecision> {
  const decision = await accessStore.authorize({
    workspaceId: input.thread.workspaceId || 'dev-workspace',
    projectId:
      input.thread.projectId || input.thread.channelId || 'general',
    platform: input.thread.platform,
    actor: input.message.actor,
    capability: requiredActorCapability(input),
  });
  if (!decision.allowed) return decision;
  const memoryCommand = parseMemoryCommand(input.message.text, {
    defaultScope: memoryCommandDefaultScope(input.thread),
  });
  const mutatesMemory =
    memoryCommand?.kind === 'remember' || memoryCommand?.kind === 'forget';
  if (!mutatesMemory) return decision;
  const workspaceRole = decision.member?.role;
  const workspaceWriteAllowed =
    workspaceRole === 'owner' ||
    workspaceRole === 'admin' ||
    workspaceRole === 'member';
  if (
    memoryCommand.scope === 'global' ||
    (memoryCommand.scope === 'workspace' && !workspaceWriteAllowed)
  ) {
    return {
      ...decision,
      allowed: false,
      reason: 'memory_scope_not_granted',
      capabilities: decision.capabilities.filter(
        (capability) => capability !== 'write_memory',
      ),
    };
  }
  return decision;
}

function actorAuthorizationPayload(
  decision: ActorAuthorizationDecision,
): Record<string, unknown> {
  return {
    allowed: decision.allowed,
    capability: decision.capability,
    mode: decision.mode,
    reason: decision.reason,
    memberId: decision.member?.id,
    workspaceRole: decision.member?.role,
    projectRole: decision.projectMembership?.role,
    capabilities: decision.capabilities,
  };
}

async function accessDeniedNotice(input: {
  thread: SourceThread;
  message: SourceMessage;
}): Promise<{ mode?: string; error?: string; suppressed?: boolean }> {
  const key = `${input.thread.platform}:${input.thread.id}:${input.message.actor.id}`;
  const current = Date.now();
  const last = accessNoticeAt.get(key) ?? 0;
  if (current - last < 60_000) return { suppressed: true };
  accessNoticeAt.set(key, current);
  if (accessNoticeAt.size > 1_000) {
    for (const [entry, timestamp] of accessNoticeAt) {
      if (current - timestamp > 60_000) accessNoticeAt.delete(entry);
    }
  }
  return sendControlMessage(
    input.thread,
    input.message.id,
    'OpenTag access is not enabled for you in this project. Ask a workspace owner or project manager.',
  );
}

async function rejectUnauthorizedMessage(input: {
  inboundEventId: string;
  routed: {
    thread: SourceThread;
    message: SourceMessage;
    binding?: ThreadBinding;
    establishedThreadBinding?: ThreadBinding;
  };
  decision: ActorAuthorizationDecision;
}): Promise<Record<string, unknown>> {
  const authorization = actorAuthorizationPayload(input.decision);
  await deliveryStore.markInboundEventIgnored(
    input.inboundEventId,
    'actor_not_authorized',
    {
      workspaceId: input.routed.thread.workspaceId,
      projectId: input.routed.thread.projectId,
      threadId: input.routed.thread.id,
      messageId: input.routed.message.id,
      metadata: { authorization },
    },
  );
  const notice = await accessDeniedNotice(input.routed);
  return {
    accepted: false,
    reason: 'actor_not_authorized',
    authorization,
    notice,
    route: {
      workspaceId: input.routed.thread.workspaceId,
      projectId: input.routed.thread.projectId,
      threadId: input.routed.thread.id,
      platform: input.routed.thread.platform,
      bindingId: input.routed.binding?.id,
      establishedThreadBindingId:
        input.routed.establishedThreadBinding?.id,
    },
  };
}

function pairingCommandCode(text: string): string | undefined {
  return /^\s*\/pair(?:@[a-z0-9_]+)?\s+([a-z0-9-]{8,16})\s*$/iu.exec(
    text,
  )?.[1];
}

function requiresConfiguredBinding(platform: PlatformKind): boolean {
  if (platform === 'lark') return larkRequireBinding;
  if (platform === 'telegram') return telegramRequireBinding;
  return false;
}

function pairingFailureMessage(reason: string): string {
  if (reason === 'expired_code') return 'This pairing code has expired.';
  if (reason === 'consumed_code') return 'This pairing code has already been used.';
  if (reason === 'revoked_code') return 'This pairing code was revoked.';
  if (reason === 'platform_mismatch') {
    return 'This pairing code belongs to another client.';
  }
  return 'This pairing code is invalid.';
}

async function sendControlMessage(
  thread: SourceThread,
  messageId: string,
  text: string,
): Promise<{ mode?: string; error?: string }> {
  try {
    const runPlatform = createPlatformForRun(thread);
    await runPlatform.platform.sendMessage(thread, text, [], {
      replyToMessageId: messageId,
    });
    return { mode: runPlatform.transportMode };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function isStopCommand(text: string): boolean {
  const trimmed = text
    .trim()
    .replace(/^<at\b[^>]*>.*?<\/at>\s*/iu, '')
    .replace(/^@(?:opentag|_[a-z0-9]+)\s+/iu, '');
  return (
    /^\/(?:stop|cancel)(?:@[a-z0-9_]+)?$/iu.test(trimmed) ||
    /^(?:stop|cancel|停止|停止任务|取消任务)$/iu.test(trimmed)
  );
}

async function handleRunControlCommand(
  input: { thread: SourceThread; message: SourceMessage },
  inboundEventId: string,
): Promise<Record<string, unknown> | undefined> {
  if (!isStopCommand(input.message.text)) return undefined;
  const reason = `thread:${input.thread.platform}:${input.message.actor.id}:stop`;
  const cancelled = await deliveryStore.cancelActiveAgentRunsForThread(
    input.thread,
    reason,
  );
  for (const run of cancelled.runs) {
    activeRuns.get(run.id)?.abort(reason);
    await deliveryStore.cancelOutbox({ runId: run.id, reason });
  }
  const message = cancelled.runs.length
    ? `Cancellation requested for ${cancelled.runs.length} active task${
        cancelled.runs.length === 1 ? '' : 's'
      }.${
        cancelled.steering.length
          ? ` Cleared ${cancelled.steering.length} queued follow-up${
              cancelled.steering.length === 1 ? '' : 's'
            }.`
          : ''
      }`
    : 'No active task in this thread.';
  const notice = await sendControlMessage(
    input.thread,
    input.message.id,
    message,
  );
  await deliveryStore.markInboundEventProcessed(inboundEventId, {
    workspaceId: input.thread.workspaceId,
    projectId: input.thread.projectId,
    threadId: input.thread.id,
    messageId: input.message.id,
    metadata: {
      control: 'stop',
      actorId: input.message.actor.id,
      runIds: cancelled.runs.map((run) => run.id),
      steeringIds: cancelled.steering.map((item) => item.id),
    },
  });
  return {
    accepted: true,
    control: 'stop',
    cancelled,
    notice,
  };
}

async function handlePairingCommand(
  input: { thread: SourceThread; message: SourceMessage },
  inboundEventId: string,
): Promise<Record<string, unknown> | undefined> {
  const code = pairingCommandCode(input.message.text);
  if (!code) return undefined;
  const channelId = input.thread.channelId || input.thread.externalId;
  const consumeInput = {
    platform: input.thread.platform,
    code,
    channelId,
    threadExternalId: input.thread.externalId,
    actorId: input.message.actor.id,
  };
  const atomicPairing = sqliteStorage
    ? await sqliteStorage.consumePairingAndConfigureBinding({
        ...consumeInput,
        title: input.thread.title,
      })
    : undefined;
  const consumed =
    atomicPairing?.consumed ?? (await pairingStore.consumeCode(consumeInput));
  if (!consumed.ok) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      `pairing_${consumed.reason}`,
      {
        workspaceId: input.thread.workspaceId,
        projectId: input.thread.projectId,
        threadId: input.thread.id,
        messageId: input.message.id,
      },
    );
    const transport = await sendControlMessage(
      input.thread,
      input.message.id,
      pairingFailureMessage(consumed.reason),
    );
    return {
      accepted: false,
      paired: false,
      reason: consumed.reason,
      transport,
    };
  }

  const invitation = consumed.invitation;
  const binding =
    atomicPairing?.binding ??
    (await deliveryStore.configureThreadBinding({
      platform: input.thread.platform,
      externalId: channelId,
      workspaceId: invitation.workspaceId,
      projectId: invitation.projectId,
      scope: 'channel',
      source: 'configured',
      channelId,
      title: input.thread.title,
      activationMode: invitation.activationMode,
      requireMention: invitation.requireMention,
      metadata: {
        pairedAt: invitation.consumedAt,
        pairedBy: input.message.actor.id,
        pairingInvitationId: invitation.id,
      },
    }));
  const thread = applyBindingToThread(input.thread, binding);
  const policy = await threadConfigStore.resolveThreadPolicy(thread);
  const transport = await sendControlMessage(
    thread,
    input.message.id,
    `Connected to ${policy.workspace.name} / ${policy.project.name}.`,
  );
  await deliveryStore.markInboundEventProcessed(inboundEventId, {
    workspaceId: thread.workspaceId,
    projectId: thread.projectId,
    threadId: thread.id,
    messageId: input.message.id,
  });
  return {
    accepted: true,
    paired: true,
    invitation,
    binding,
    route: {
      workspaceId: thread.workspaceId,
      projectId: thread.projectId,
      threadId: thread.id,
      platform: thread.platform,
      bindingId: binding.id,
    },
    transport,
  };
}

async function pairingRequiredNotice(
  input: { thread: SourceThread; message: SourceMessage },
): Promise<{ notified: boolean; mode?: string; error?: string }> {
  const key = `${input.thread.platform}:${input.thread.channelId || input.thread.externalId}`;
  const current = Date.now();
  const last = pairingNoticeAt.get(key) ?? 0;
  if (current - last < 60_000) return { notified: false };
  pairingNoticeAt.set(key, current);
  if (pairingNoticeAt.size > 1_000) {
    for (const [entry, timestamp] of pairingNoticeAt) {
      if (current - timestamp > 60_000) pairingNoticeAt.delete(entry);
    }
  }
  const transport = await sendControlMessage(
    input.thread,
    input.message.id,
    'This chat is not connected. Create an invitation in OpenTag Connectors, then send /pair CODE.',
  );
  return { notified: true, ...transport };
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

function memoryActorForMessage(thread: SourceThread, actorId: string): string {
  return actorId.startsWith('operator:')
    ? actorId
    : `${thread.platform}:${actorId || 'unknown'}`;
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
  actorId?: string;
  source?: string;
}): Promise<Record<string, unknown>> {
  const { workspace, project } = await memoryContextForThread(input.thread);
  if (input.command.kind === 'remember') {
    await memoryStore.rememberScoped({
      thread: input.thread,
      workspace,
      project,
      scope: input.command.scope,
      text: input.command.value,
      actorId: input.actorId,
      source: input.source,
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
      actorId: input.actorId,
      source: input.source,
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
  disposition: 'created' | 'steered';
  run: AgentRunRecord;
  steering?: AgentRunSteeringRecord;
  authorization: Record<string, unknown>;
  route: Record<string, unknown>;
  memoryCommand?: {
    kind: ParsedMemoryCommand['kind'];
    scope: MemoryScopeKind;
  };
  routineCommand?: {
    kind: ParsedRoutineCommand['kind'];
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

async function enqueueMessageRun(input: {
  thread: SourceThread;
  message: SourceMessage;
}, options?: {
  inboundEventId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  authorization?: ActorAuthorizationDecision;
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
  const routineCommand = routineCommandService.parse(routed.message.text);
  const resolvedPolicy = await threadConfigStore.resolveThreadPolicy(routed.thread);
  const authorization = options?.authorization
    ? actorAuthorizationPayload(options.authorization)
    : { allowed: true, reason: 'operator_or_internal' };
  const staged = await deliveryStore.createAgentRunOrSteer({
    runId,
    thread: routed.thread,
    message: routed.message,
    inboundEventId: options?.inboundEventId,
    bindingId: routeBinding.id,
    executorId: routineCommand
      ? 'routine-command'
      : memoryCommand
        ? 'memory-command'
        : resolvedPolicy.identity.defaultExecutorId,
    transportMode,
    allowLiveSteering: !memoryCommand && !routineCommand,
    metadata: {
      ...options?.metadata,
      actorAuthorization: authorization,
      memoryCommand: memoryCommand
        ? { kind: memoryCommand.kind, scope: memoryCommand.scope }
        : undefined,
      routineCommand: routineCommand
        ? { kind: routineCommand.kind }
        : undefined,
      agentId: resolvedPolicy.identity.id,
      agentDisplayName: resolvedPolicy.identity.displayName,
      policyConfigured: resolvedPolicy.configured,
      grantKinds: resolvedPolicy.access.grants.map((grant) => grant.kind),
    },
  });

  return {
    disposition: staged.disposition,
    run: staged.run,
    steering: staged.steering,
    authorization,
    route,
    memoryCommand: memoryCommand
      ? { kind: memoryCommand.kind, scope: memoryCommand.scope }
      : undefined,
    routineCommand: routineCommand
      ? { kind: routineCommand.kind }
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

async function reconcileRoutineExecutions(): Promise<number> {
  return routineScheduler.reconcileExecutions();
}

async function runRoutineSchedulerTick(input?: {
  at?: Date;
  stageDue?: boolean;
}): Promise<RoutineTickResult> {
  return routineScheduler.tick(input);
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
      mode: routineSchedulerMode,
      tickIntervalMs: routineTickIntervalMs,
      claimStaleMs: routineClaimStaleMs,
      batchSize: routineBatchSize,
      running: routineScheduler.running,
      lastTickAt: routineScheduler.lastTickAt,
      lastTickResult: routineScheduler.lastTickResult,
    },
  };
}

async function runWorkflowCoordinatorTick(): Promise<WorkflowCoordinatorTickResult> {
  return workflowCoordinator.tick();
}

async function workflowSnapshot(
  workspaceId = 'dev-workspace',
  projectId?: string,
): Promise<Record<string, unknown>> {
  await workflowCoordinator.reconcileNodeRuns({ workspaceId, projectId });
  const [workflows, executions, summary, audit] = await Promise.all([
    workflowStore.listWorkflows({ workspaceId, projectId }),
    workflowStore.listExecutions({ workspaceId, projectId, limit: 200 }),
    workflowStore.summarize(workspaceId, projectId),
    workflowStore.listAudit({ workspaceId, projectId, limit: 50 }),
  ]);
  return {
    workflows,
    executions,
    summary,
    audit,
    coordinator: {
      enabled: workflowsEnabled,
      mode: workflowCoordinatorMode,
      tickIntervalMs: workflowTickIntervalMs,
      claimStaleMs: workflowClaimStaleMs,
      batchSize: workflowBatchSize,
      running: workflowCoordinator.running,
      lastTickAt: workflowCoordinator.lastTickAt,
      lastTickResult: workflowCoordinator.lastTickResult,
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
      delivery: await deliverySnapshot(20, initialRun.workspaceId),
    };
  }
  if (!options?.alreadyClaimed) {
    const runningRun = await deliveryStore.markAgentRunRunning(runId);
    if (runningRun?.status === 'cancelled') {
      return {
        run: runningRun,
        route: runRoute(runningRun),
        delivery: await deliverySnapshot(20, runningRun.workspaceId),
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
  const routineCommand = routineCommandService.parse(initialRun.message.text);
  if (routineCommand) {
    try {
      const commandResult = await routineCommandService.execute(
        routineCommand,
        initialRun.thread,
        initialRun.message.actor.id,
      );
      await deliveryStore.appendAgentRunEvent(runId, 'routine_command', {
        message: commandResult.summary,
        metadata: {
          action: commandResult.action,
          routineId: commandResult.routine?.id,
        },
      });
      await runPlatform.platform.sendMessage(
        initialRun.thread,
        commandResult.summary,
        [],
        { runId, replyToMessageId: initialRun.message.id },
      );
      await markRunInboundProcessed(initialRun);
      await deliveryStore.markAgentRunCompleted(runId, commandResult.summary);
      return {
        result: {
          summary: commandResult.summary,
          artifacts: [],
        },
        run: await deliveryStore.getAgentRun(runId),
        route: runRoute(initialRun),
        routineCommand: {
          kind: routineCommand.kind,
          ...commandResult,
        },
        delivery: await deliverySnapshot(20, initialRun.workspaceId),
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

  const memoryCommand = parseMemoryCommand(initialRun.message.text, {
    defaultScope: memoryCommandDefaultScope(initialRun.thread),
  });

  if (memoryCommand) {
    try {
      const commandResult = await applyMemoryCommand({
        command: memoryCommand,
        thread: initialRun.thread,
        actorId: memoryActorForMessage(
          initialRun.thread,
          initialRun.message.actor.id,
        ),
        source: `${initialRun.thread.platform}-command`,
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
        delivery: await deliverySnapshot(20, initialRun.workspaceId),
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
  const stopCancellationMonitor = monitorDurableRunCancellation({
    deliveryStore,
    runId,
    abortController,
    pollMs: runControlPollMs,
    onError: (error) => {
      console.error(`OpenTag cancellation poll failed for ${runId}`, error);
    },
  });
  try {
    const result = await runtime.handleMessage({
      runId,
      thread: initialRun.thread,
      message: initialRun.message,
      abortSignal: abortController.signal,
      steering: createDurableSteeringProvider({
        deliveryStore,
        runId,
        workerId: agentWorkerId,
        pollMs: runControlPollMs,
      }),
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
      delivery: await deliverySnapshot(20, initialRun.workspaceId),
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
    stopCancellationMonitor();
    activeRuns.delete(runId);
  }
}

async function runMessageSync(input: {
  thread: SourceThread;
  message: SourceMessage;
}, options?: {
  inboundEventId?: string;
  authorization?: ActorAuthorizationDecision;
}): Promise<Record<string, unknown>> {
  const queued = await enqueueMessageRun(input, options);
  if (queued.disposition === 'steered') {
    scheduleAgentWorkerPass();
    return {
      accepted: true,
      queued: true,
      steered: true,
      ...queued,
      delivery: await deliverySnapshot(20, queued.run.workspaceId),
    };
  }
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
        if (run.metadata?.source === 'workflow') {
          try {
            await workflowCoordinator.tick();
          } catch (error) {
            console.error('OpenTag workflow coordinator wake failed', error);
          }
        }
      }
    }
    return result;
  })();
  let result: AgentWorkerPassResult;
  try {
    result = await agentWorkerPass;
  } finally {
    agentWorkerPass = undefined;
  }
  const queued = await deliveryStore.listAgentRuns({
    status: 'queued',
    limit: 1,
  });
  if (queued.length > 0) scheduleAgentWorkerPass(10);
  return result;
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
    let operatorAuthentication: OperatorAuthentication | undefined;

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
        pairing: {
          ttlSeconds: pairingTtlSeconds,
          summary: await pairingStore.summarize(),
        },
        routines: {
          enabled: routinesEnabled,
          mode: routineSchedulerMode,
          batchSize: routineBatchSize,
          running: routineScheduler.running,
          lastTickAt: routineScheduler.lastTickAt,
        },
        workflows: {
          enabled: workflowsEnabled,
          mode: workflowCoordinatorMode,
          batchSize: workflowBatchSize,
          running: workflowCoordinator.running,
          lastTickAt: workflowCoordinator.lastTickAt,
        },
        storage: {
          driver: storageDriver,
          wal: Boolean(sqliteStorage),
          migration: sqliteStorage?.migration,
        },
        security: {
          operatorAuth: {
            configured: operatorAuth.configured,
            principalCount: operatorAuth.principalCount,
            sessionTtlSeconds: operatorAuth.sessionTtlSeconds,
          },
          clientIngress: {
            mode: genericClientIngressMode(),
          },
          workflowIngress: {
            mode: workflowIngressMode(),
          },
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

    if (request.method === 'GET' && url.pathname === '/v1/admin/session') {
      const authentication = operatorAuth.authenticate(request);
      sendJson(
        response,
        200,
        {
          configured: operatorAuth.configured,
          authenticated: authentication.authenticated,
          method: authentication.method,
          expiresAt: authentication.expiresAt,
          csrfToken: authentication.csrfToken,
          principal: authentication.principal,
        },
        { 'cache-control': 'no-store' },
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/admin/session') {
      if (!operatorAuth.configured) {
        const authentication = operatorAuth.authenticate(request);
        sendJson(
          response,
          200,
          {
            configured: false,
            authenticated: true,
            method: 'disabled',
            principal: authentication.principal,
          },
          { 'cache-control': 'no-store' },
        );
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const session = operatorAuth.createSession(stringValue(body, 'token') || '');
      if (!session) {
        sendJson(
          response,
          401,
          { error: 'invalid_operator_token' },
          {
            'cache-control': 'no-store',
            'www-authenticate': 'Bearer realm="OpenTag operator"',
          },
        );
        return;
      }
      sendJson(
        response,
        200,
        {
          configured: true,
          authenticated: true,
          method: 'session',
          expiresAt: session.expiresAt,
          csrfToken: session.csrfToken,
          principal: session.principal,
        },
        {
          'cache-control': 'no-store',
          'set-cookie': session.cookie,
        },
      );
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/v1/admin/session') {
      sendJson(
        response,
        200,
        { configured: operatorAuth.configured, authenticated: false },
        {
          'cache-control': 'no-store',
          'set-cookie': operatorAuth.clearSessionCookie(),
        },
      );
      return;
    }

    const isLarkIngress =
      request.method === 'POST' && url.pathname === '/v1/lark/events';
    const isTelegramIngress =
      request.method === 'POST' && url.pathname === '/v1/telegram/events';
    const isGenericClientIngress =
      request.method === 'POST' && url.pathname === '/v1/client/events';
    const isWorkflowIngress =
      request.method === 'POST' && url.pathname === '/v1/workflow-events';

    if (isGenericClientIngress) {
      const ingressMode = genericClientIngressMode();
      if (ingressMode === 'disabled') {
        sendJson(response, 503, {
          error: 'client_ingress_token_required',
          message:
            'Set OPENTAG_CLIENT_INGRESS_TOKEN before enabling generic client ingress.',
        });
        return;
      }
      if (
        ingressMode === 'bearer' &&
        !bearerTokenMatches(request, clientIngressToken)
      ) {
        sendJson(
          response,
          401,
          { error: 'client_ingress_auth_required' },
          { 'www-authenticate': 'Bearer realm="OpenTag client ingress"' },
        );
        return;
      }
    }

    if (isWorkflowIngress) {
      const ingressMode = workflowIngressMode();
      if (ingressMode === 'disabled') {
        sendJson(response, 503, {
          error: 'workflow_ingress_token_required',
          message:
            'Set OPENTAG_WORKFLOW_INGRESS_TOKEN before enabling workflow event ingress.',
        });
        return;
      }
      if (
        ingressMode === 'bearer' &&
        !bearerTokenMatches(request, workflowIngressToken)
      ) {
        sendJson(
          response,
          401,
          { error: 'workflow_ingress_auth_required' },
          { 'www-authenticate': 'Bearer realm="OpenTag workflow ingress"' },
        );
        return;
      }
    }

    if (
      url.pathname.startsWith('/v1/') &&
      !isLarkIngress &&
      !isTelegramIngress &&
      !isGenericClientIngress &&
      !isWorkflowIngress
    ) {
      operatorAuthentication = requireOperator(request, response);
      if (!operatorAuthentication) return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      sendJson(response, 200, {
        ...capabilityManifest,
        larkTransport: larkTransportStatus(),
        telegramTransport: telegramTransportStatus(),
        pairing: {
          ttlSeconds: pairingTtlSeconds,
          summary: await pairingStore.summarize(selection.workspaceId),
          command: '/pair CODE',
        },
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
          mode: routineSchedulerMode,
          tickIntervalMs: routineTickIntervalMs,
          claimStaleMs: routineClaimStaleMs,
          batchSize: routineBatchSize,
          running: routineScheduler.running,
          lastTickAt: routineScheduler.lastTickAt,
          lastTickResult: routineScheduler.lastTickResult,
        },
        workflows: {
          enabled: workflowsEnabled,
          mode: workflowCoordinatorMode,
          tickIntervalMs: workflowTickIntervalMs,
          claimStaleMs: workflowClaimStaleMs,
          batchSize: workflowBatchSize,
          running: workflowCoordinator.running,
          lastTickAt: workflowCoordinator.lastTickAt,
          lastTickResult: workflowCoordinator.lastTickResult,
          ingressMode: workflowIngressMode(),
        },
        storage: {
          driver: storageDriver,
          wal: Boolean(sqliteStorage),
          migration: sqliteStorage?.migration,
        },
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/workspace') {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      sendJson(
        response,
        200,
        await workspaceSnapshot(workspaceId),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/access') {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      const access = await accessStore.snapshot(
        workspaceId,
        Number(url.searchParams.get('auditLimit') || 50),
      );
      sendJson(
        response,
        200,
        { ...access },
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/access/members') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
      const displayName = stringValue(body, 'displayName');
      const role = workspaceRoleValue(body.role);
      const status = workspaceMemberStatusValue(body.status);
      const identities = workspaceMemberIdentities(body);
      if (!workspaceId || !displayName || !role || !identities.length) {
        sendJson(response, 400, {
          error:
            'workspace_member_workspace_displayName_role_identity_required',
        });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      try {
        const member = await accessStore.upsertMember({
          id: stringValue(body, 'id'),
          workspaceId,
          displayName,
          role,
          status,
          identities,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          member,
          access: await accessStore.snapshot(workspaceId),
        });
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (
      request.method === 'DELETE' &&
      url.pathname.startsWith('/v1/access/members/')
    ) {
      const memberId = decodeURIComponent(
        url.pathname.slice('/v1/access/members/'.length),
      );
      const workspaceId =
        url.searchParams.get('workspaceId') || 'dev-workspace';
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      try {
        const member = await accessStore.removeMember(
          workspaceId,
          memberId,
          operatorActor(operatorAuthentication!),
        );
        if (!member) {
          sendJson(response, 404, { error: 'workspace_member_not_found' });
          return;
        }
        sendJson(response, 200, {
          member,
          access: await accessStore.snapshot(workspaceId),
        });
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/v1/access/project-policy'
    ) {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
      const projectId = stringValue(body, 'projectId');
      const mode = projectAccessModeValue(body.mode);
      if (!workspaceId || !projectId || !mode) {
        sendJson(response, 400, {
          error: 'project_access_workspace_project_mode_required',
        });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      const projects = await threadConfigStore.listProjectPolicies(workspaceId);
      if (
        !projects.some(
          (project) =>
            project.projectId === projectId || project.id === projectId,
        )
      ) {
        sendJson(response, 404, { error: 'project_access_project_not_found' });
        return;
      }
      const policy = await accessStore.setProjectPolicy({
        workspaceId,
        projectId,
        mode,
        actor: operatorActor(operatorAuthentication!),
      });
      sendJson(response, 200, {
        policy,
        access: await accessStore.snapshot(workspaceId),
      });
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/v1/access/project-memberships'
    ) {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
      const projectId = stringValue(body, 'projectId');
      const memberId = stringValue(body, 'memberId');
      const role = projectRoleValue(body.role);
      if (!workspaceId || !projectId || !memberId || !role) {
        sendJson(response, 400, {
          error: 'project_member_workspace_project_member_role_required',
        });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      const projects = await threadConfigStore.listProjectPolicies(workspaceId);
      if (
        !projects.some(
          (project) =>
            project.projectId === projectId || project.id === projectId,
        )
      ) {
        sendJson(response, 404, { error: 'project_access_project_not_found' });
        return;
      }
      try {
        const membership = await accessStore.upsertProjectMembership({
          workspaceId,
          projectId,
          memberId,
          role,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          membership,
          access: await accessStore.snapshot(workspaceId),
        });
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (
      request.method === 'DELETE' &&
      url.pathname === '/v1/access/project-memberships'
    ) {
      const workspaceId =
        url.searchParams.get('workspaceId') || 'dev-workspace';
      const projectId = url.searchParams.get('projectId') || '';
      const memberId = url.searchParams.get('memberId') || '';
      if (!projectId || !memberId) {
        sendJson(response, 400, {
          error: 'project_member_project_member_required',
        });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      const membership = await accessStore.removeProjectMembership(
        workspaceId,
        projectId,
        memberId,
        operatorActor(operatorAuthentication!),
      );
      if (!membership) {
        sendJson(response, 404, { error: 'project_membership_not_found' });
        return;
      }
      sendJson(response, 200, {
        membership,
        access: await accessStore.snapshot(workspaceId),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/projects') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceProjectPolicyInput(body);
      if ('error' in input) {
        sendJson(response, 400, { error: input.error });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          input.workspaceId,
        )
      ) {
        return;
      }
      const project = await threadConfigStore.upsertProjectPolicy({
        ...input,
        actor: operatorActor(operatorAuthentication!),
      });
      sendJson(response, 200, {
        project,
        workspace: await workspaceSnapshot(project.workspaceId),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/config/audit') {
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      const audit = await threadConfigStore.listAudit(
        Number(url.searchParams.get('limit') || 50),
        selection.workspaceId,
      );
      sendJson(response, 200, {
        workspaceId: selection.workspaceId,
        audit,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/workflows') {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      sendJson(
        response,
        200,
        await workflowSnapshot(
          workspaceId,
          url.searchParams.get('projectId') || undefined,
        ),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/workflows/tick') {
      if (!requireInstallationOperator(response, operatorAuthentication!)) {
        return;
      }
      const result = await runWorkflowCoordinatorTick();
      sendJson(response, 200, {
        result,
        workflows: await workflowSnapshot(),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/workflows') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceWorkflowInput(body);
      if ('error' in input) {
        sendJson(response, 400, { error: input.error });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          input.workspaceId,
        )
      ) {
        return;
      }
      try {
        if (input.id) {
          const existing = await workflowStore.getWorkflow(input.id);
          if (!existing || existing.status === 'archived') {
            sendJson(response, 404, { error: 'workflow_not_found' });
            return;
          }
          if (
            !requireOperatorWorkspace(
              response,
              operatorAuthentication!,
              existing.workspaceId,
            )
          ) {
            return;
          }
          if (existing.workspaceId !== input.workspaceId) {
            sendJson(response, 400, { error: 'workflow_workspace_immutable' });
            return;
          }
        }
        const workflow = await workflowStore.upsertWorkflow({
          ...input,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          workflow,
          workflows: await workflowSnapshot(workflow.workspaceId),
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
      url.pathname.startsWith('/v1/workflows/') &&
      url.pathname.endsWith('/trigger')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/workflows/'.length, -'/trigger'.length),
      );
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      try {
        const workflow = await workflowStore.getWorkflow(id);
        if (!workflow || workflow.status === 'archived') {
          sendJson(response, 404, { error: 'workflow_not_found' });
          return;
        }
        if (
          !requireOperatorWorkspace(
            response,
            operatorAuthentication!,
            workflow.workspaceId,
          )
        ) {
          return;
        }
        const execution = await workflowStore.triggerWorkflow(id, {
          actor: operatorActor(operatorAuthentication!),
          payload: recordValue(body, 'input') || recordValue(body, 'payload'),
        });
        const tick = workflowCoordinatorInline
          ? await runWorkflowCoordinatorTick()
          : undefined;
        sendJson(response, 202, {
          accepted: true,
          execution:
            (await workflowStore.getExecution(execution.id)) || execution,
          tick,
          coordinatorMode: workflowCoordinatorMode,
          workflows: await workflowSnapshot(workflow.workspaceId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'workflow_not_found' ? 404 : 400, {
          error: message,
        });
      }
      return;
    }

    if (
      request.method === 'DELETE' &&
      url.pathname.startsWith('/v1/workflows/')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/workflows/'.length),
      );
      const existing = await workflowStore.getWorkflow(id);
      if (!existing || existing.status === 'archived') {
        sendJson(response, 404, { error: 'workflow_not_found' });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          existing.workspaceId,
        )
      ) {
        return;
      }
      const workflow = await workflowStore.archiveWorkflow(
        id,
        operatorActor(operatorAuthentication!),
      );
      sendJson(response, 200, {
        workflow,
        workflows: await workflowSnapshot(existing.workspaceId),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/routines') {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      sendJson(
        response,
        200,
        await routineSnapshot(
          workspaceId,
          url.searchParams.get('projectId') || undefined,
        ),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/routines/tick') {
      if (!requireInstallationOperator(response, operatorAuthentication!)) {
        return;
      }
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
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          input.workspaceId,
        )
      ) {
        return;
      }
      try {
        const routine = await routineStore.upsertRoutine({
          ...input,
          actor: operatorActor(operatorAuthentication!),
        });
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
      await readJsonBody(request);
      try {
        const routine = await routineStore.getRoutine(id);
        if (!routine) {
          sendJson(response, 404, { error: 'routine_not_found' });
          return;
        }
        if (
          !requireOperatorWorkspace(
            response,
            operatorAuthentication!,
            routine.workspaceId,
          )
        ) {
          return;
        }
        const execution = await routineStore.triggerRoutine(
          id,
          operatorActor(operatorAuthentication!),
        );
        const tick = routineSchedulerInline
          ? await runRoutineSchedulerTick({ stageDue: false })
          : undefined;
        const currentExecution = (
          await routineStore.listExecutions({ routineId: id, limit: 50 })
        ).find((item) => item.id === execution.id);
        sendJson(response, 202, {
          accepted: true,
          execution: currentExecution || execution,
          tick,
          schedulerMode: routineSchedulerMode,
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
      const existing = await routineStore.getRoutine(id);
      if (!existing) {
        sendJson(response, 404, { error: 'routine_not_found' });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          existing.workspaceId,
        )
      ) {
        return;
      }
      const routine = await routineStore.deleteRoutine(
        id,
        operatorActor(operatorAuthentication!),
      );
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
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      sendJson(
        response,
        200,
        await deliverySnapshot(limit, selection.workspaceId),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/bindings') {
      const limit = Number(url.searchParams.get('limit') || 20);
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      sendJson(response, 200, {
        workspaceId: selection.workspaceId,
        bindings: await deliveryStore.listThreadBindings(
          limit,
          selection.workspaceId,
        ),
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
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          input.workspaceId,
        )
      ) {
        return;
      }
      const binding = await deliveryStore.configureThreadBinding({
        ...input,
        metadata: {
          ...input.metadata,
          configuredBy: operatorActor(operatorAuthentication!),
        },
      });
      sendJson(response, 200, {
        binding,
        delivery: await deliverySnapshot(20, input.workspaceId),
      });
      return;
    }

    if (
      request.method === 'DELETE' &&
      url.pathname.startsWith('/v1/bindings/')
    ) {
      const id = decodeURIComponent(url.pathname.slice('/v1/bindings/'.length));
      const binding = await deliveryStore.getThreadBindingById(id);
      if (!binding) {
        sendJson(response, 404, { error: 'binding_not_found' });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          binding.workspaceId,
        )
      ) {
        return;
      }
      const removed = await deliveryStore.removeThreadBinding(id, {
        cascadeChannel: url.searchParams.get('cascade') !== 'false',
      });
      if (!removed.length) {
        sendJson(response, 404, { error: 'binding_not_found' });
        return;
      }
      sendJson(response, 200, {
        removed,
        delivery: await deliverySnapshot(20, binding.workspaceId),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/pairing-invitations') {
      const query = Object.fromEntries(url.searchParams.entries());
      const status = url.searchParams.get('status');
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      sendJson(response, 200, {
        invitations: await pairingStore.listInvitations({
          platform: url.searchParams.get('platform') || undefined,
          workspaceId: selection.workspaceId,
          projectId: url.searchParams.get('projectId') || undefined,
          status:
            status === 'pending' ||
            status === 'consumed' ||
            status === 'expired' ||
            status === 'revoked'
              ? status
              : undefined,
          limit: numberValue(query, 'limit', 100),
        }),
        summary: await pairingStore.summarize(
          selection.workspaceId,
        ),
        ttlSeconds: pairingTtlSeconds,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/pairing-invitations') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const platform = stringValue(body, 'platform');
      const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
      const projectId = stringValue(body, 'projectId');
      if (
        (platform !== 'lark' && platform !== 'telegram') ||
        !workspaceId ||
        !projectId
      ) {
        sendJson(response, 400, {
          error: 'pairing_platform_workspaceId_projectId_required',
        });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      const projects = await threadConfigStore.listProjectPolicies(workspaceId);
      const project = projects.find(
        (item) => item.projectId === projectId || item.id === projectId,
      );
      if (!project) {
        sendJson(response, 404, { error: 'pairing_project_not_found' });
        return;
      }
      const result = await pairingStore.createInvitation({
        platform,
        workspaceId,
        projectId: project.projectId,
        activationMode: (activationModeValue(body) ?? 'mention') as PairingActivationMode,
        requireMention: booleanValue(body, 'requireMention', true),
        createdBy: operatorActor(operatorAuthentication!),
      });
      sendJson(response, 201, { ...result });
      return;
    }

    if (
      request.method === 'DELETE' &&
      url.pathname.startsWith('/v1/pairing-invitations/')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/pairing-invitations/'.length),
      );
      const existing = await pairingStore.getInvitation(id);
      if (!existing) {
        sendJson(response, 404, { error: 'pairing_invitation_not_found' });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          existing.workspaceId,
        )
      ) {
        return;
      }
      const invitation = await pairingStore.revokeInvitation(
        id,
        operatorActor(operatorAuthentication!),
      );
      if (!invitation) {
        sendJson(response, 404, { error: 'pairing_invitation_not_found' });
        return;
      }
      sendJson(response, 200, {
        invitation,
        summary: await pairingStore.summarize(invitation.workspaceId),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/memory') {
      const query = Object.fromEntries(url.searchParams.entries());
      const thread = coerceMemoryThread(query);
      const { workspace, project } = await memoryContextForThread(thread);
      const scope = memoryScopeValue(query, 'project');
      const memoryAllowed =
        scope === 'global'
          ? requireInstallationOperator(response, operatorAuthentication!)
          : requireOperatorWorkspace(
              response,
              operatorAuthentication!,
              workspace?.id || thread.workspaceId || 'dev-workspace',
            );
      if (!memoryAllowed) return;
      const snapshot = await memoryStore.loadMemory({
        thread,
        workspace,
        project,
        scopes: [scope],
      });
      const history = await memoryStore.getMemoryHistory({
        thread,
        workspace,
        project,
        scope,
        limit: numberValue(query, 'historyLimit') || 20,
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
        history,
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
      const revisionId = stringValue(body, 'revisionId');
      if ((action === 'remember' || action === 'forget') && !value) {
        sendJson(response, 400, { error: 'memory_value_required' });
        return;
      }
      if (action === 'restore' && !revisionId) {
        sendJson(response, 400, { error: 'memory_revision_required' });
        return;
      }
      if (
        action !== 'remember' &&
        action !== 'forget' &&
        action !== 'show' &&
        action !== 'restore'
      ) {
        sendJson(response, 400, { error: 'unsupported_memory_action' });
        return;
      }
      const { workspace, project } = await memoryContextForThread(thread);
      const memoryAllowed =
        scope === 'global'
          ? requireInstallationOperator(response, operatorAuthentication!)
          : requireOperatorWorkspace(
              response,
              operatorAuthentication!,
              workspace?.id || thread.workspaceId || 'dev-workspace',
            );
      if (!memoryAllowed) return;
      if (action === 'restore') {
        try {
          const document = await memoryStore.restoreScoped({
            thread,
            workspace,
            project,
            scope,
            revisionId: revisionId!,
            actorId: operatorActor(operatorAuthentication!),
            source: 'operator-api',
          });
          sendJson(response, 200, {
            route: {
              workspaceId: workspace?.id,
              projectId: project?.id,
              threadId: thread.id,
              platform: thread.platform,
            },
            memoryCommand: {
              summary: `Restored ${formatMemoryScopeLabel(scope)} to version ${document.version}.`,
              action: 'restore',
              scope,
              document,
            },
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'memory_revision_not_found'
          ) {
            sendJson(response, 404, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      const result = await applyMemoryCommand({
        command: {
          kind: action,
          scope,
          value: value ?? '',
        },
        thread,
        actorId: operatorActor(operatorAuthentication!),
        source: 'operator-api',
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
      if (!requireInstallationOperator(response, operatorAuthentication!)) {
        return;
      }
      const result = await runDeliveryWorkerPass(deliveryStore, async (record) => {
        return record.externalId ?? record.target.cardId ?? record.target.chatId;
      });
      sendJson(response, 200, { result, delivery: await deliverySnapshot(20) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/deliveries/recover-stale') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceRecoverStaleInput(body);
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        input.workspaceId,
      );
      if (!selection.ok) return;
      input.workspaceId = selection.workspaceId;
      input.reason = `operator:${operatorAuthentication!.principal?.id || 'unknown'}:${
        input.reason || 'recover_stale_outbox'
      }`;
      const result = await deliveryStore.recoverStaleOutbox(
        input,
      );
      sendJson(response, 200, {
        result,
        delivery: await deliverySnapshot(20, selection.workspaceId),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/deliveries/cancel') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceOutboxFilter(body);
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        input.workspaceId,
      );
      if (!selection.ok) return;
      input.workspaceId = selection.workspaceId;
      input.reason = `operator:${operatorAuthentication!.principal?.id || 'unknown'}:${
        input.reason || 'cancel_outbox'
      }`;
      const result = await deliveryStore.cancelOutbox(input);
      sendJson(response, 200, {
        result,
        delivery: await deliverySnapshot(20, selection.workspaceId),
      });
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
      const record = await deliveryStore.getOutbox(id);
      if (!record) {
        sendJson(response, 404, { error: 'outbox_not_found' });
        return;
      }
      const recordAllowed = record.workspaceId
        ? requireOperatorWorkspace(
            response,
            operatorAuthentication!,
            record.workspaceId,
          )
        : requireInstallationOperator(response, operatorAuthentication!);
      if (!recordAllowed) return;
      sendJson(response, 200, {
        retried: await deliveryStore.retryFailedOutbox(id),
        delivery: await deliverySnapshot(20, record.workspaceId),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/runs/worker-pass') {
      if (!requireInstallationOperator(response, operatorAuthentication!)) {
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const result = await runAgentWorkerPass(numberValue(body, 'limit', 1));
      sendJson(response, 200, {
        result,
        delivery: await deliverySnapshot(20),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/runs/recover-stale') {
      if (!requireInstallationOperator(response, operatorAuthentication!)) {
        return;
      }
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
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        stringValue(query, 'workspaceId'),
      );
      if (!selection.ok) return;
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
          workspaceId: selection.workspaceId,
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
      const runAllowed = run.workspaceId
        ? requireOperatorWorkspace(
            response,
            operatorAuthentication!,
            run.workspaceId,
          )
        : requireInstallationOperator(response, operatorAuthentication!);
      if (!runAllowed) return;
      sendJson(response, 200, {
        run,
        events: await deliveryStore.listAgentRunEvents(
          id,
          Number(url.searchParams.get('limit') || 100),
        ),
        steering: await deliveryStore.listAgentRunSteering({
          runId: id,
          limit: Number(url.searchParams.get('limit') || 100),
        }),
      });
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/runs/') &&
      url.pathname.endsWith('/steer')
    ) {
      const id = decodeURIComponent(
        url.pathname.slice('/v1/runs/'.length, -'/steer'.length),
      );
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const text = stringValue(body, 'text')?.trim();
      if (!text) {
        sendJson(response, 400, { error: 'steering_text_required' });
        return;
      }
      const existing = await deliveryStore.getAgentRun(id);
      if (!existing || !existing.thread) {
        sendJson(response, 404, { error: 'run_not_found' });
        return;
      }
      const runAllowed = existing.workspaceId
        ? requireOperatorWorkspace(
            response,
            operatorAuthentication!,
            existing.workspaceId,
          )
        : requireInstallationOperator(response, operatorAuthentication!);
      if (!runAllowed) return;
      if (existing.status !== 'queued' && existing.status !== 'running') {
        sendJson(response, 409, { error: 'run_not_active', run: existing });
        return;
      }
      const messageId = `operator-steer:${randomUUID()}`;
      const inbound = await deliveryStore.recordInboundEvent({
        platform: existing.platform,
        externalId: messageId,
        eventType: 'operator.steering',
        workspaceId: existing.workspaceId,
        projectId: existing.projectId,
        threadId: existing.threadId,
        messageId,
        metadata: { targetRunId: id, ingress: 'operator' },
      });
      const steering = await deliveryStore.enqueueAgentRunSteering({
        targetRunId: id,
        inboundEventId: inbound.record.id,
        bindingId: existing.bindingId,
        executorId: existing.executorId,
        transportMode: existing.transportMode,
        message: {
          id: messageId,
          threadId: existing.threadId,
          platform: existing.platform,
          text,
          actor: {
            id: operatorActor(operatorAuthentication!),
            displayName: operatorAuthentication!.principal?.displayName,
          },
          createdAt: new Date().toISOString(),
          mentionsAgent: true,
          metadata: { ingress: 'operator', targetRunId: id },
        },
        metadata: {
          actorAuthorization: {
            allowed: true,
            reason: 'operator_control_plane',
          },
        },
      });
      if (!steering) {
        await deliveryStore.markInboundEventIgnored(
          inbound.record.id,
          'run_not_active',
        );
        sendJson(response, 409, { error: 'run_not_active' });
        return;
      }
      scheduleAgentWorkerPass();
      sendJson(response, 202, {
        accepted: true,
        steered: true,
        run: await deliveryStore.getAgentRun(id),
        steering,
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
      const existing = await deliveryStore.getAgentRun(id);
      if (!existing) {
        sendJson(response, 404, { error: 'run_not_found' });
        return;
      }
      const runAllowed = existing.workspaceId
        ? requireOperatorWorkspace(
            response,
            operatorAuthentication!,
            existing.workspaceId,
          )
        : requireInstallationOperator(response, operatorAuthentication!);
      if (!runAllowed) return;
      const reason = `operator:${operatorAuthentication!.principal?.id || 'unknown'}:${
        stringValue(body, 'reason', 'cancelled_run')
      }`;
      const run = await deliveryStore.requestAgentRunCancel(id, reason);
      activeRuns.get(id)?.abort(reason);
      const cancelledOutbox = await deliveryStore.cancelOutbox({
        runId: id,
        reason,
      });
      sendJson(response, 200, {
        run: await deliveryStore.getAgentRun(id),
        active: activeRuns.has(id),
        cancelledOutbox,
        delivery: await deliverySnapshot(20, existing.workspaceId),
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
      const workspaceId = normalized.thread.workspaceId || 'dev-workspace';
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          workspaceId,
        )
      ) {
        return;
      }
      const devMemoryCommand = parseMemoryCommand(normalized.message.text, {
        defaultScope: memoryCommandDefaultScope(normalized.thread),
      });
      if (
        devMemoryCommand?.scope === 'global' &&
        (devMemoryCommand.kind === 'remember' ||
          devMemoryCommand.kind === 'forget') &&
        !requireInstallationOperator(response, operatorAuthentication!)
      ) {
        return;
      }
      normalized.message.actor = {
        id: operatorActor(operatorAuthentication!),
        displayName: operatorAuthentication!.principal?.displayName,
      };
      const inbound = await deliveryStore.recordInboundEvent({
        platform: normalized.thread.platform,
        externalId: normalized.message.id,
        eventType: 'dev.message',
        workspaceId: normalized.thread.workspaceId,
        projectId: normalized.thread.projectId,
        threadId: normalized.thread.id,
        messageId: normalized.message.id,
      });
      const control = await handleRunControlCommand(
        normalized,
        inbound.record.id,
      );
      if (control) {
        sendJson(response, 200, control);
        return;
      }
      if (asyncRequested) {
        const queued = await enqueueMessageRun(normalized, {
          inboundEventId: inbound.record.id,
        });
        scheduleAgentWorkerPass();
        sendJson(response, 202, {
          accepted: true,
          queued: true,
          ...queued,
          delivery: await deliverySnapshot(20, workspaceId),
        });
        return;
      }
      sendJson(response, 200, await runMessageSync(normalized, {
        inboundEventId: inbound.record.id,
      }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/workflow-events') {
      if (!workflowsEnabled) {
        sendJson(response, 503, { error: 'workflows_disabled' });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId');
      const projectId = stringValue(body, 'projectId');
      const eventType = stringValue(body, 'eventType');
      const eventId = stringValue(body, 'eventId');
      if (!workspaceId || !projectId || !eventType || !eventId) {
        sendJson(response, 400, {
          error: 'workflow_event_workspace_project_type_id_required',
        });
        return;
      }
      try {
        const staged = await workflowStore.triggerEvent({
          workspaceId,
          projectId,
          eventType,
          eventId,
          payload: recordValue(body, 'payload'),
          actor: `${workflowIngressActor.slice(0, 120)}:${eventType}`,
        });
        const tick = workflowCoordinatorInline && staged.staged.length > 0
          ? await runWorkflowCoordinatorTick()
          : undefined;
        sendJson(response, 202, {
          accepted: true,
          matched: staged.matched,
          staged: staged.staged.map((execution) => ({
            id: execution.id,
            workflowId: execution.workflowId,
            status: execution.status,
          })),
          duplicates: staged.duplicates.map((execution) => ({
            id: execution.id,
            workflowId: execution.workflowId,
            status: execution.status,
          })),
          coordinatorMode: workflowCoordinatorMode,
          tick,
        });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

      const authorization = await authorizeRoutedMessage(routed);
      if (!authorization.allowed) {
        sendJson(
          response,
          202,
          await rejectUnauthorizedMessage({
            inboundEventId: inbound.record.id,
            routed,
            decision: authorization,
          }),
        );
        return;
      }

      const control = await handleRunControlCommand(
        routed,
        inbound.record.id,
      );
      if (control) {
        sendJson(response, 200, control);
        return;
      }

      if (asyncRequested) {
        const queued = await enqueueMessageRun(routed, {
          inboundEventId: inbound.record.id,
          authorization,
        });
        scheduleAgentWorkerPass();
        sendJson(response, 202, {
          accepted: true,
          queued: true,
          ...queued,
          delivery: await deliverySnapshot(20, routed.thread.workspaceId),
        });
        return;
      }

      sendJson(response, 200, await runMessageSync(routed, {
        inboundEventId: inbound.record.id,
        authorization,
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

      const pairing = await handlePairingCommand(
        normalized,
        inbound.record.id,
      );
      if (pairing) {
        sendJson(response, 200, pairing);
        return;
      }

      const routed = await routeMessage(normalized);
      if (
        requiresConfiguredBinding(routed.thread.platform) &&
        routed.binding?.source !== 'configured'
      ) {
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
        const notice = await pairingRequiredNotice(routed);
        sendJson(response, 202, {
          accepted: false,
          reason: 'binding_required',
          notice,
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

      const authorization = await authorizeRoutedMessage(routed);
      if (!authorization.allowed) {
        sendJson(
          response,
          202,
          await rejectUnauthorizedMessage({
            inboundEventId: inbound.record.id,
            routed,
            decision: authorization,
          }),
        );
        return;
      }

      const control = await handleRunControlCommand(
        routed,
        inbound.record.id,
      );
      if (control) {
        sendJson(response, 200, control);
        return;
      }

      const queued = await enqueueMessageRun(routed, {
        inboundEventId: inbound.record.id,
        authorization,
      });
      scheduleAgentWorkerPass();
      sendJson(response, 202, {
        accepted: true,
        queued: true,
        ...queued,
        delivery: await deliverySnapshot(20, routed.thread.workspaceId),
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
      const pairing = await handlePairingCommand(
        normalized,
        inbound.record.id,
      );
      if (pairing) {
        sendJson(response, 200, pairing);
        return;
      }
      const routed = await routeMessage(normalized);
      if (
        requiresConfiguredBinding(routed.thread.platform) &&
        routed.binding?.source !== 'configured'
      ) {
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
        const notice = await pairingRequiredNotice(routed);
        sendJson(response, 202, {
          accepted: false,
          reason: 'binding_required',
          notice,
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
      const authorization = await authorizeRoutedMessage(routed);
      if (!authorization.allowed) {
        sendJson(
          response,
          202,
          await rejectUnauthorizedMessage({
            inboundEventId: inbound.record.id,
            routed,
            decision: authorization,
          }),
        );
        return;
      }

      const control = await handleRunControlCommand(
        routed,
        inbound.record.id,
      );
      if (control) {
        sendJson(response, 200, control);
        return;
      }
      const queued = await enqueueMessageRun(routed, {
        inboundEventId: inbound.record.id,
        authorization,
      });
      scheduleAgentWorkerPass();
      sendJson(response, 202, {
        accepted: true,
        queued: true,
        ...queued,
        delivery: await deliverySnapshot(20, routed.thread.workspaceId),
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
  console.log(
    `OpenTag storage driver=${storageDriver}${
      sqliteStorage
        ? ` wal=true migrated_delivery=${sqliteStorage.migration.deliveryImported} migrated_pairing=${sqliteStorage.migration.pairingImported} migrated_access=${sqliteStorage.migration.accessImported} migrated_memory=${sqliteStorage.migration.memoryImported} migrated_routines=${sqliteStorage.migration.routinesImported} migrated_workflows=${sqliteStorage.migration.workflowsImported}`
        : ''
    }`,
  );
  console.log(
    `OpenTag operator auth configured=${operatorAuth.configured} principals=${operatorAuth.principalCount}`,
  );
  if (!operatorAuth.configured && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.warn(
      'OpenTag operator authentication is disabled on a non-loopback host. Set OPENTAG_ADMIN_TOKEN or OPENTAG_OPERATOR_PRINCIPALS_JSON before exposing the console.',
    );
  }
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
  if (routineSchedulerInline) {
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
  if (workflowCoordinatorInline) {
    void runWorkflowCoordinatorTick().catch((error) => {
      console.error('OpenTag workflow coordinator startup tick failed', error);
    });
    const workflowInterval = setInterval(() => {
      void runWorkflowCoordinatorTick().catch((error) => {
        console.error('OpenTag workflow coordinator tick failed', error);
      });
    }, workflowTickIntervalMs);
    workflowInterval.unref?.();
  }
});
