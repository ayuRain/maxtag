import path from 'node:path';
import {
  OPENTAG_REQUEUE_RUN_ABORT_REASON,
  isOpenTagLeaseLostAbort,
  isOpenTagRequeueAbort,
  memoryScopeGranted,
  memoryExpiryForAccess,
  memoryRetentionDaysFor,
  openTagAbortSummary,
  OpenTagRuntime,
  StaticExecutorRegistry,
  type AgentRunRequest,
  type AgentRunEvent,
  type AgentRunResult,
  type ExecutorDescriptor,
  type ExecutorRegistry,
  type MemoryApprovalAction,
  type MemoryApprovalPolicy,
  type MemoryProposal,
  type MemoryScopeKind,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformKind,
  type SourceMessage,
  type SourceThread,
  type Workspace,
  type Project,
  type ToolApprovalRecord,
} from '@opentag/core';
import {
  FileAgentSkillStore,
  FileDelegatedAgentStore,
  FileDelegatedAgentTaskStore,
  FileKnowledgeSourceStore,
  FileKnowledgeSourceRefreshStore,
  FileManagedConnectorStore,
  FileToolCredentialIdentityStore,
  FileThreadConfigStore,
} from '@opentag/config';
import {
  FileDeliveryStore,
  TrackedGitHubTransport,
  TrackedLarkTransport,
  TrackedSlackTransport,
  TrackedTelegramTransport,
  TrackedTextPlatformAdapter,
  type AgentRunRecord,
  type DeliveryStore,
  type RecoverStaleAgentRunsOptions,
  type UsageBudgetCheckResult,
} from '@opentag/delivery';
import { createCodexExecutor } from '@opentag/executor-codex';
import { createClaudeExecutor } from '@opentag/executor-claude';
import {
  ScopedFileMemoryStore,
  StateMemoryStore,
  parseMemoryCommand,
  type ParsedMemoryCommand,
} from '@opentag/memory';
import {
  GitHubPlatformAdapter,
  HttpGitHubTransport,
  MemoryGitHubTransport,
  type GitHubTokenProvider,
  type GitHubTransport,
} from '@opentag/platform-github';
import {
  HttpLarkTransport,
  LarkPlatformAdapter,
  MemoryLarkTransport,
  type LarkOpenApiDomain,
  type LarkTransport,
} from '@opentag/platform-lark';
import {
  HttpSlackTransport,
  MemorySlackTransport,
  SlackPlatformAdapter,
  type SlackTransport,
} from '@opentag/platform-slack';
import {
  HttpTelegramTransport,
  MemoryTelegramTransport,
  TelegramPlatformAdapter,
  type TelegramTransport,
} from '@opentag/platform-telegram';
import {
  FileRoutineStore,
  RoutineCommandService,
  type RoutineNotification,
} from '@opentag/routines';
import { FileWorkflowStore } from '@opentag/workflows';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';
import {
  createOpenTagToolBroker,
  externalMcpRegistryFromJson,
  type OpenTagToolBroker,
} from '@opentag/tool-broker';
import {
  WorkflowCoordinatorService,
  type WorkflowCoordinatorTickResult,
} from './workflow-coordinator.js';
import {
  createDurableSteeringProvider,
  monitorDurableRunCancellation,
  renewDurableRunLeaseOrAbort,
} from './run-control.js';
import { scheduleToolApprovalContinuation } from './tool-approval-continuation.js';
import {
  createDurableProviderSessionContext,
  defaultProviderSessionNamespace,
  loadDurableConversationContext,
} from './conversation-context.js';
import { hydrateLarkThreadContext } from './lark-thread-context.js';
import { MemoryAnalysisService } from './memory-analysis.js';
import { MemoryRetrievalService } from './memory-retrieval.js';
import { MemoryWrapupService } from './memory-wrapup.js';
import { LarkDocumentWatcherService } from './lark-document-watcher.js';
import { KnowledgeEnrichmentService } from './knowledge-enrichment.js';
import { KnowledgeSourceRefreshService } from './knowledge-source-refresh.js';
import { DelegatedAgentTaskService } from './delegated-agent-tasks.js';
import {
  parseThreadStatusCommand,
  ThreadStatusService,
} from './thread-status.js';

export * from './routine-scheduler.js';
export * from './run-control.js';
export * from './conversation-context.js';
export * from './knowledge-content-extraction.js';
export * from './knowledge-source-refresh.js';
export * from './thread-status.js';
export * from './lark-thread-context.js';
export * from './tool-approval-continuation.js';
export * from './workflow-coordinator.js';
export * from './managed-content-store.js';
export * from './metrics.js';
export * from './memory-analysis.js';
export * from './memory-retrieval.js';
export * from './memory-wrapup.js';
export * from './lark-document-watcher.js';
export * from './knowledge-enrichment.js';
export * from './delegated-agent-tasks.js';

export interface RuntimeHostLarkConfig {
  transportMode?: string;
  appId?: string;
  appSecret?: string;
  domain?: LarkOpenApiDomain;
  baseUrl?: string;
  botOpenId?: string;
  threadHistoryMaxMessages?: number;
  threadHistoryRetryMs?: number;
}

export interface RuntimeHostTelegramConfig {
  transportMode?: string;
  botToken?: string;
  baseUrl?: string;
}

export interface RuntimeHostSlackConfig {
  transportMode?: string;
  botToken?: string;
  baseUrl?: string;
  maxUploadBytes?: number;
}

export interface RuntimeHostGitHubConfig {
  transportMode?: string;
  token?: string;
  tokenProvider?: GitHubTokenProvider;
  baseUrl?: string;
}

export interface RuntimeHostExecutorConfig {
  mode?: 'dry-run' | 'local-cli';
  workspaceRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  inheritEnv?: string[];
  codexCommand?: string;
  codexModel?: string;
  codexAppServer?: boolean;
  codexContextCompactionThreshold?: number;
  codexHome?: string;
  codexAuthSourceHome?: string;
  claudeCommand?: string;
  claudeModel?: string;
  claudeMaxBudgetUsd?: number;
  sessionMode?: 'provider' | 'transcript';
  sessionNamespace?: string;
  transcriptMaxEntries?: number;
  transcriptMaxChars?: number;
  artifactRoot?: string;
  maxArtifactBytes?: number;
  maxArtifacts?: number;
  defaultExecutorId?: 'codex' | 'claude';
}

export function createDefaultExecutorRegistry(
  config: RuntimeHostExecutorConfig = {},
  toolSessions?: OpenTagToolBroker,
): ExecutorRegistry {
  const mode = config.mode ?? 'dry-run';
  const common = {
    mode,
    workspaceRoot: config.workspaceRoot,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    inheritEnv: config.inheritEnv,
    sessionMode: config.sessionMode,
    artifactRoot: config.artifactRoot,
    maxArtifactBytes: config.maxArtifactBytes,
    maxArtifacts: config.maxArtifacts,
    toolSessions,
  } as const;
  const codex = createCodexExecutor({
    ...common,
    command: config.codexCommand,
    model: config.codexModel,
    appServer: config.codexAppServer,
    contextCompactionThreshold: config.codexContextCompactionThreshold,
    codexHome: config.codexHome,
    codexAuthSourceHome: config.codexAuthSourceHome,
  });
  const claude = createClaudeExecutor({
    ...common,
    command: config.claudeCommand,
    model: config.claudeModel,
    maxBudgetUsd: config.claudeMaxBudgetUsd,
  });
  const sharedCapabilities = {
    providerSessions: true,
    transcriptFallback: true,
    brokeredTools: true,
    nativeTools: true,
    inputAttachments: true,
    managedArtifacts: true,
    automaticMemoryCandidates: true,
    contextRecovery: true,
  } as const;
  const descriptor = (
    id: 'codex' | 'claude',
    label: string,
    steering: 'live' | 'next_turn',
    model?: string,
    nativeCompaction = false,
  ): ExecutorDescriptor => ({
    id,
    label,
    provider: id,
    mode,
    model,
    status: mode === 'dry-run' ? 'dry-run' : 'ready',
    capabilities: { ...sharedCapabilities, steering, nativeCompaction },
  });
  return new StaticExecutorRegistry({
    defaultExecutorId: config.defaultExecutorId ?? 'codex',
    registrations: [
      {
        executor: codex,
        descriptor: descriptor(
          'codex',
          'Codex',
          codex.steeringMode ?? 'next_turn',
          config.codexModel,
          codex.steeringMode === 'live',
        ),
      },
      {
        executor: claude,
        descriptor: descriptor(
          'claude',
          'Claude',
          mode === 'local-cli' ? 'live' : 'next_turn',
          config.claudeModel,
        ),
      },
    ],
  });
}

export interface RuntimeHostRoutineConfig {
  defaultTimeZone?: string;
}

export interface RuntimeHostWorkflowConfig {
  claimStaleMs?: number;
  batchSize?: number;
  larkDocumentWatcherEnabled?: boolean;
  larkDocumentWatcherClaimStaleMs?: number;
  larkDocumentWatcherBatchSize?: number;
}

export interface RuntimeHostStorageConfig {
  driver?: 'file' | 'sqlite';
  databasePath?: string;
  busyTimeoutMs?: number;
}

export interface RuntimeHostToolBrokerConfig {
  githubToken?: string;
  githubTokenProvider?: GitHubTokenProvider;
  githubBaseUrl?: string;
  externalMcpServersJson?: string;
  maxCallsPerRun?: number;
  callTimeoutMs?: number;
  approvalTtlMs?: number;
}

export interface RuntimeHostConfig {
  dataDir: string;
  workerId?: string;
  lark?: RuntimeHostLarkConfig;
  telegram?: RuntimeHostTelegramConfig;
  slack?: RuntimeHostSlackConfig;
  github?: RuntimeHostGitHubConfig;
  executors?: RuntimeHostExecutorConfig;
  executorRegistry?: ExecutorRegistry;
  routines?: RuntimeHostRoutineConfig;
  workflows?: RuntimeHostWorkflowConfig;
  storage?: RuntimeHostStorageConfig;
  toolBroker?: RuntimeHostToolBrokerConfig;
  runControlPollMs?: number;
  runHeartbeatMs?: number;
  memoryAnalysis?: {
    executorId?: 'codex' | 'claude';
    model?: string;
    analysisModel?: string;
    queryModel?: string;
    retrievalModel?: string;
    wrapupModel?: string;
    timeoutMs?: number;
    maxEntries?: number;
    maxChars?: number;
    minConfidence?: number;
    retrievalEnabled?: boolean;
    retrievalTimeoutMs?: number;
    retrievalMaxCandidateLines?: number;
    retrievalMaxCandidateChars?: number;
    retrievalMaxSelectedLines?: number;
    retrievalMinConfidence?: number;
  };
  memoryWrapup?: {
    enabled?: boolean;
    debounceMs?: number;
    batchSize?: number;
    staleMs?: number;
    retryBaseMs?: number;
    maxAttempts?: number;
    retentionMs?: number;
    keepLatestPerThread?: number;
  };
  knowledgeEnrichment?: {
    enabled?: boolean;
    executorId?: 'codex' | 'claude';
    model?: string;
    timeoutMs?: number;
    batchSize?: number;
    leaseMs?: number;
    retryBaseMs?: number;
  };
  knowledgeRefresh?: {
    enabled?: boolean;
    batchSize?: number;
    leaseMs?: number;
    retryBaseMs?: number;
    timeoutMs?: number;
  };
  delegatedAgentTasks?: {
    enabled?: boolean;
    batchSize?: number;
    leaseMs?: number;
    retryBaseMs?: number;
  };
}

export interface AgentWorkerPassResult {
  claimed: number;
  completed: number;
  failed: number;
  requeued: number;
  superseded: number;
  runs: AgentRunRecord[];
}

function larkTransportStatus(config: RuntimeHostLarkConfig = {}): {
  requested: string;
  mode: 'memory' | 'http';
  hasCredentials: boolean;
  domain: LarkOpenApiDomain;
  baseUrl?: string;
} {
  const requested = config.transportMode || 'memory';
  const hasCredentials = Boolean(config.appId && config.appSecret);
  return {
    requested,
    mode:
      requested === 'http' || (requested === 'auto' && hasCredentials)
        ? 'http'
        : 'memory',
    hasCredentials,
    domain: config.domain || 'feishu',
    baseUrl: config.baseUrl,
  };
}

function telegramTransportStatus(config: RuntimeHostTelegramConfig = {}): {
  requested: string;
  mode: 'memory' | 'http';
  hasToken: boolean;
  baseUrl?: string;
} {
  const requested = config.transportMode || 'memory';
  const hasToken = Boolean(config.botToken);
  return {
    requested,
    mode:
      requested === 'http' || (requested === 'auto' && hasToken)
        ? 'http'
        : 'memory',
    hasToken,
    baseUrl: config.baseUrl,
  };
}

function slackTransportStatus(config: RuntimeHostSlackConfig = {}): {
  requested: string;
  mode: 'memory' | 'http';
  hasToken: boolean;
  baseUrl?: string;
} {
  const requested = config.transportMode || 'memory';
  const hasToken = Boolean(config.botToken);
  return {
    requested,
    mode:
      requested === 'http' || (requested === 'auto' && hasToken)
        ? 'http'
        : 'memory',
    hasToken,
    baseUrl: config.baseUrl,
  };
}

function githubTransportStatus(config: RuntimeHostGitHubConfig = {}): {
  requested: string;
  mode: 'memory' | 'http';
  hasToken: boolean;
  baseUrl?: string;
} {
  const requested = config.transportMode || 'memory';
  const hasToken = Boolean(config.token || config.tokenProvider);
  return {
    requested,
    mode:
      requested === 'http' || (requested === 'auto' && hasToken)
        ? 'http'
        : 'memory',
    hasToken,
    baseUrl: config.baseUrl,
  };
}

function genericClientCapabilities(
  _platform: PlatformKind,
): Partial<PlatformCapabilities> {
  return {};
}

function memoryCommandDefaultScope(thread: SourceThread): MemoryScopeKind {
  return thread.visibility === 'direct' ? 'thread' : 'project';
}

function memoryActorForMessage(thread: SourceThread, actorId: string): string {
  return actorId.startsWith('operator:')
    ? actorId
    : `${thread.platform}:${actorId || 'unknown'}`;
}

function memoryApprovalRequired(
  policy: MemoryApprovalPolicy | undefined,
  scope: MemoryScopeKind,
  action: MemoryApprovalAction,
): boolean {
  if (policy?.mode !== 'require_approval') return false;
  const scopes = policy.scopes?.length
    ? policy.scopes
    : (['workspace', 'project'] as MemoryScopeKind[]);
  const actions = policy.actions?.length
    ? policy.actions
    : (['remember', 'forget'] as MemoryApprovalAction[]);
  return scopes.includes(scope) && actions.includes(action);
}

function formatMemoryScopeLabel(scope: MemoryScopeKind): string {
  return `${scope} memory`;
}

function formatMemoryContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return 'No memory in this scope yet.';
  return trimmed.length <= 1500 ? trimmed : `${trimmed.slice(0, 1500)}...`;
}

function runUsageQuantity(result?: AgentRunResult): { runs: number; costUsd: number } {
  return {
    runs: result?.usage?.runs ?? 1,
    costUsd: result?.usage?.costUsd ?? 0,
  };
}

function formatUsageBudgetMessage(check: UsageBudgetCheckResult): string {
  const policy = check.policy;
  const scope = policy?.scope ?? check.violated?.scope ?? 'project';
  if (check.reason === 'cost_budget_exceeded') {
    return `Monthly ${scope} cost budget exceeded for ${check.period}.`;
  }
  if (check.reason === 'runs_budget_exceeded') {
    return `Monthly ${scope} run budget exceeded for ${check.period}.`;
  }
  return `Monthly ${scope} usage budget exceeded for ${check.period}.`;
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
  if (event.type === 'memory_proposal') {
    return {
      message: `Memory proposal for ${event.proposal.scope}`,
      metadata: { proposal: event.proposal },
    };
  }
  if (event.type === 'memory_retrieval') {
    return {
      message: `Memory retrieval selected ${event.selectedLines}/${event.candidateLines} line(s) with ${event.strategy}.`,
      metadata: {
        strategy: event.strategy,
        candidateLines: event.candidateLines,
        selectedLines: event.selectedLines,
        durationMs: event.durationMs,
        fallbackReason: event.fallbackReason,
      },
    };
  }
  if (event.type === 'text_delta') {
    return {
      message: event.text,
    };
  }
  if (event.type === 'tool_call') {
    return {
      message: `Calling ${event.call.title}`,
      metadata: { call: event.call },
    };
  }
  if (event.type === 'tool_result') {
    return {
      message: `${event.call.title} ${event.call.status}`,
      metadata: { call: event.call },
    };
  }
  if (event.type === 'tool_approval') {
    const status = event.approval.status;
    return {
      message:
        status === 'pending'
          ? `${event.approval.title} is waiting for approval`
          : `${event.approval.title} approval ${status}`,
      metadata: {
        approval: {
          id: event.approval.id,
          status: event.approval.status,
          name: event.approval.toolName,
          title: event.approval.title,
          grantKind: event.approval.grantKind,
          risk: event.approval.risk,
          arguments: event.approval.argumentSummary,
          argumentDigest: event.approval.argumentDigest,
          credentialIdentityId: event.approval.credentialIdentityId,
          credentialIdentityRevision: event.approval.credentialIdentityRevision,
          externalActor: event.approval.externalActor,
          expiresAt: event.approval.expiresAt,
          approvedBy: event.approval.approvedBy,
          rejectedBy: event.approval.rejectedBy,
        },
      },
    };
  }
  if (event.type === 'delegation') {
    return {
      message: `${event.agentId} delegation ${event.status}`,
      metadata: {
        invocationId: event.invocationId,
        agentId: event.agentId,
        executorId: event.executorId,
        status: event.status,
        taskPreview: event.taskPreview,
        summaryPreview: event.summaryPreview,
        usage: event.usage,
      },
    };
  }
  return {
    message: event.message,
    metadata: {
      level: event.level,
    },
  };
}

export class OpenTagWorkerHost {
  readonly deliveryStore: DeliveryStore;
  readonly memoryStore: StateMemoryStore;
  readonly routineStore: FileRoutineStore;
  readonly workflowStore: FileWorkflowStore;
  readonly workflowCoordinator: WorkflowCoordinatorService;
  readonly larkDocumentWatcher: LarkDocumentWatcherService;
  private readonly config: RuntimeHostConfig;
  readonly threadConfigStore: FileThreadConfigStore;
  readonly skillStore: FileAgentSkillStore;
  readonly delegatedAgentStore: FileDelegatedAgentStore;
  readonly delegatedAgentTaskStore: FileDelegatedAgentTaskStore;
  readonly knowledgeSourceStore: FileKnowledgeSourceStore;
  readonly knowledgeSourceRefreshStore: FileKnowledgeSourceRefreshStore;
  private readonly routineCommandService: RoutineCommandService;
  private readonly threadStatusService: ThreadStatusService;
  private readonly sqliteStorage?: SqliteOpenTagStore;
  private readonly toolBroker: OpenTagToolBroker;
  private readonly executorRegistry: ExecutorRegistry;
  readonly memoryAnalysisService: MemoryAnalysisService;
  readonly memoryRetrievalService: MemoryRetrievalService;
  readonly memoryWrapupService: MemoryWrapupService;
  readonly knowledgeEnrichmentService: KnowledgeEnrichmentService;
  readonly knowledgeSourceRefreshService: KnowledgeSourceRefreshService;
  readonly delegatedAgentTaskService: DelegatedAgentTaskService;
  private toolLarkTransport?: HttpLarkTransport;
  private readonly activeRuns = new Map<string, AbortController>();
  private workerPass: Promise<AgentWorkerPassResult> | undefined;
  private _shuttingDown = false;
  private shutdownReason = 'process_shutdown';
  private _passCount = 0;
  private _lastPassAt: string | undefined;
  private _lastPassResult: AgentWorkerPassResult | undefined;

  constructor(config: RuntimeHostConfig) {
    this.config = config;
    this.sqliteStorage =
      config.storage?.driver === 'sqlite'
        ? new SqliteOpenTagStore({
            databasePath:
              config.storage.databasePath ||
              path.join(config.dataDir, 'opentag.sqlite'),
            busyTimeoutMs: config.storage.busyTimeoutMs,
            legacyDeliveryFile: path.join(
              config.dataDir,
              'delivery',
              'delivery-state.json',
            ),
            legacyPairingFile: path.join(
              config.dataDir,
              'pairing',
              'pairing-state.json',
            ),
            legacyAccessFile: path.join(
              config.dataDir,
              'access',
              'workspace-access.json',
            ),
            legacyMemoryDir: path.join(config.dataDir, 'memory'),
            legacyRoutineFile: path.join(
              config.dataDir,
              'routines',
              'routine-state.json',
            ),
            legacyWorkflowFile: path.join(
              config.dataDir,
              'workflows',
              'workflow-state.json',
            ),
          })
        : undefined;
    this.deliveryStore =
      this.sqliteStorage?.deliveryStore ??
      new FileDeliveryStore(path.join(config.dataDir, 'delivery'));
    this.memoryStore =
      this.sqliteStorage?.memoryStore ??
      new ScopedFileMemoryStore(path.join(config.dataDir, 'memory'));
    this.routineStore =
      this.sqliteStorage?.routineStore ??
      new FileRoutineStore(path.join(config.dataDir, 'routines'));
    const managedConnectorStore = new FileManagedConnectorStore(
      path.join(config.dataDir, 'config'),
    );
    const toolCredentialIdentityStore = new FileToolCredentialIdentityStore(
      path.join(config.dataDir, 'config'),
    );
    this.skillStore = new FileAgentSkillStore(path.join(config.dataDir, 'config'));
    this.delegatedAgentStore = new FileDelegatedAgentStore(
      path.join(config.dataDir, 'config'),
    );
    this.delegatedAgentTaskStore = new FileDelegatedAgentTaskStore(
      path.join(config.dataDir, 'config'),
    );
    this.knowledgeSourceStore = new FileKnowledgeSourceStore(
      path.join(config.dataDir, 'config'),
    );
    this.knowledgeSourceRefreshStore = new FileKnowledgeSourceRefreshStore(
      path.join(config.dataDir, 'config'),
    );
    this.toolBroker = createOpenTagToolBroker({
      memory: this.memoryStore,
      approvalStore: this.deliveryStore,
      workspaceRoot: config.executors?.workspaceRoot,
      routines: this.routineStore,
      github: {
        token: config.toolBroker?.githubToken,
        tokenProvider: config.toolBroker?.githubTokenProvider,
        baseUrl: config.toolBroker?.githubBaseUrl || config.github?.baseUrl,
      },
      defaultCredentialIdentities: {
        lark:
          config.lark?.appId &&
          config.lark?.appSecret &&
          this.larkTransportStatus().mode === 'http'
            ? {
                id: 'lark-workspace-bot',
                displayName: 'Lark workspace bot',
                revision: 1,
                externalActor: config.lark.botOpenId || config.lark.appId,
              }
            : undefined,
        github: config.toolBroker?.githubToken || config.toolBroker?.githubTokenProvider
          ? {
              id: 'github-default',
              displayName: 'GitHub installation identity',
              revision: 1,
            }
          : undefined,
      },
      resolveCredentialIdentity: async (id) => {
        if (
          id === 'lark-workspace-bot' &&
          config.lark?.appId &&
          config.lark.appSecret
        ) {
          return {
            id,
            displayName: 'Lark workspace bot',
            provider: 'lark',
            revision: 1,
            externalActor: config.lark.botOpenId || config.lark.appId,
            lark: {
              baseUrl:
                this.larkTransportStatus().baseUrl ||
                (this.larkTransportStatus().domain === 'lark'
                  ? 'https://open.larksuite.com'
                  : 'https://open.feishu.cn'),
              request: (pathname, options) =>
                this.larkOpenApiTransport().openApiRequest(pathname, options),
            },
          };
        }
        if (
          id === 'github-default' &&
          (config.toolBroker?.githubToken || config.toolBroker?.githubTokenProvider)
        ) {
          return {
            id,
            displayName: 'GitHub installation identity',
            provider: 'github',
            revision: 1,
            github: {
              token: config.toolBroker.githubToken,
              tokenProvider: config.toolBroker.githubTokenProvider,
              baseUrl: config.toolBroker.githubBaseUrl || config.github?.baseUrl,
            },
          };
        }
        const identity = await toolCredentialIdentityStore.get(id);
        if (!identity?.enabled) return undefined;
        if (identity.provider === 'github') {
          const token = identity.envRefs.token
            ? process.env[identity.envRefs.token]?.trim()
            : undefined;
          if (!token) return undefined;
          return {
            id: identity.id,
            displayName: identity.displayName,
            provider: identity.provider,
            revision: identity.revision,
            externalActor: identity.externalActor,
            github: { token, baseUrl: identity.baseUrl },
          };
        }
        const appId = identity.envRefs.appId
          ? process.env[identity.envRefs.appId]?.trim()
          : undefined;
        const appSecret = identity.envRefs.appSecret
          ? process.env[identity.envRefs.appSecret]?.trim()
          : undefined;
        if (!appId || !appSecret) return undefined;
        const transport = new HttpLarkTransport({
          appId,
          appSecret,
          domain: config.lark?.domain,
          baseUrl: identity.baseUrl,
        });
        return {
          id: identity.id,
          displayName: identity.displayName,
          provider: identity.provider,
          revision: identity.revision,
          externalActor: identity.externalActor || appId,
          lark: {
            baseUrl: identity.baseUrl,
            request: (pathname, options) =>
              transport.openApiRequest(pathname, options),
          },
        };
      },
      externalMcp: externalMcpRegistryFromJson(
        config.toolBroker?.externalMcpServersJson,
        {
          timeoutMs: config.toolBroker?.callTimeoutMs,
          stateStore: managedConnectorStore,
        },
      ),
      skills: this.skillStore,
      knowledgeSources: this.knowledgeSourceStore,
      delegatedAgents: {
        source: this.delegatedAgentStore,
        tasks: this.delegatedAgentTaskStore,
        beforeInvoke: async ({ request }) => {
          const check = await this.deliveryStore.checkUsageBudget({
            thread: request.thread,
            policy: request.access.budgetPolicy,
            policies: request.access.budgetPolicies,
            expected: { runs: 0, costUsd: 0.000001 },
          });
          if (!check.allowed) {
            throw new Error(
              `usage_budget_denied:${formatUsageBudgetMessage(check)}`,
            );
          }
        },
        resolveExecutor: (definition) => {
          if (
            definition.executorId !== 'codex' &&
            definition.executorId !== 'claude'
          ) {
            return undefined;
          }
          return createDefaultExecutorRegistry(
            {
              ...config.executors,
              timeoutMs: definition.timeoutMs,
              sessionMode: 'transcript',
              artifactRoot: undefined,
              codexModel:
                definition.executorId === 'codex'
                  ? definition.model
                  : config.executors?.codexModel,
              codexAppServer: false,
              claudeModel:
                definition.executorId === 'claude'
                  ? definition.model
                  : config.executors?.claudeModel,
              defaultExecutorId: definition.executorId,
            },
            this.toolBroker,
          ).get(definition.executorId);
        },
      },
      lark:
        config.lark?.appId &&
        config.lark?.appSecret &&
        this.larkTransportStatus().mode === 'http'
          ? {
              baseUrl:
                this.larkTransportStatus().baseUrl ||
                (this.larkTransportStatus().domain === 'lark'
                  ? 'https://open.larksuite.com'
                  : 'https://open.feishu.cn'),
              request: (pathname, options) =>
                this.larkOpenApiTransport().openApiRequest(pathname, options),
            }
          : undefined,
      maxCallsPerRun: config.toolBroker?.maxCallsPerRun,
      callTimeoutMs: config.toolBroker?.callTimeoutMs,
      approvalTtlMs: config.toolBroker?.approvalTtlMs,
    });
    this.executorRegistry =
      config.executorRegistry ??
      createDefaultExecutorRegistry(
        {
          ...config.executors,
          artifactRoot:
            config.executors?.artifactRoot ||
            path.join(config.dataDir, 'artifacts'),
          codexHome:
            config.executors?.codexHome ||
            path.join(config.dataDir, 'providers', 'codex'),
        },
        this.toolBroker,
      );
    const memoryExecutorId = config.memoryAnalysis?.executorId ?? 'codex';
    const memoryModel =
      config.memoryAnalysis?.model ??
      (memoryExecutorId === 'codex' ? 'gpt-5.6-luna' : undefined);
    const memoryExecutorRegistry = (model = memoryModel) =>
      createDefaultExecutorRegistry({
        ...config.executors,
        timeoutMs:
          config.memoryAnalysis?.timeoutMs ?? config.executors?.timeoutMs,
        sessionMode: 'transcript',
        codexModel:
          memoryExecutorId === 'codex' ? model : config.executors?.codexModel,
        claudeModel:
          memoryExecutorId === 'claude' ? model : config.executors?.claudeModel,
        defaultExecutorId: memoryExecutorId,
        artifactRoot: undefined,
        codexAppServer: false,
      });
    const analysisExecutorRegistry = memoryExecutorRegistry(
      config.memoryAnalysis?.analysisModel,
    );
    const queryExecutorRegistry = memoryExecutorRegistry(
      config.memoryAnalysis?.queryModel,
    );
    const retrievalExecutorRegistry = memoryExecutorRegistry(
      config.memoryAnalysis?.retrievalModel,
    );
    const wrapupExecutorRegistry = memoryExecutorRegistry(
      config.memoryAnalysis?.wrapupModel,
    );
    const knowledgeExecutorId = config.knowledgeEnrichment?.executorId ?? memoryExecutorId;
    const knowledgeModel = config.knowledgeEnrichment?.model ?? memoryModel;
    const knowledgeExecutorRegistry = createDefaultExecutorRegistry({
      ...config.executors,
      timeoutMs: config.knowledgeEnrichment?.timeoutMs ?? config.memoryAnalysis?.timeoutMs ?? config.executors?.timeoutMs,
      sessionMode: 'transcript',
      codexModel: knowledgeExecutorId === 'codex' ? knowledgeModel : config.executors?.codexModel,
      claudeModel: knowledgeExecutorId === 'claude' ? knowledgeModel : config.executors?.claudeModel,
      defaultExecutorId: knowledgeExecutorId,
      artifactRoot: undefined,
      codexAppServer: false,
    });
    this.workflowStore =
      this.sqliteStorage?.workflowStore ??
      new FileWorkflowStore(path.join(config.dataDir, 'workflows'));
    this.routineCommandService = new RoutineCommandService(this.routineStore, {
      defaultTimeZone: config.routines?.defaultTimeZone || 'Asia/Shanghai',
    });
    this.threadConfigStore = new FileThreadConfigStore(
      path.join(config.dataDir, 'config'),
      {
        identity: {
          displayName: 'MaxTag',
          instructions:
            'You are MaxTag in a shared work thread. Keep progress visible and publish durable artifacts.',
          defaultExecutorId: this.executorRegistry.defaultExecutorId,
        },
        workspace: {
          id: 'dev-workspace',
          name: 'Development Workspace',
          defaultProjectId: 'opentag',
        },
      },
    );
    this.threadStatusService = new ThreadStatusService({
      threadConfigStore: this.threadConfigStore,
      skillStore: this.skillStore,
      delegatedAgentStore: this.delegatedAgentStore,
      knowledgeSourceStore: this.knowledgeSourceStore,
      routineCommandService: this.routineCommandService,
      deliveryStore: this.deliveryStore,
    });
    this.memoryAnalysisService = new MemoryAnalysisService({
      deliveryStore: this.deliveryStore,
      memoryStore: this.memoryStore,
      threadConfigStore: this.threadConfigStore,
      executorRegistry: analysisExecutorRegistry,
      executorId: memoryExecutorId,
      purposeExecutors: {
        memory_query: {
          executorRegistry: queryExecutorRegistry,
          executorId: memoryExecutorId,
        },
        memory_wrapup: {
          executorRegistry: wrapupExecutorRegistry,
          executorId: memoryExecutorId,
        },
      },
      maxEntries: config.memoryAnalysis?.maxEntries,
      maxChars: config.memoryAnalysis?.maxChars,
      minConfidence: config.memoryAnalysis?.minConfidence,
    });
    this.memoryRetrievalService = new MemoryRetrievalService({
      executorRegistry: retrievalExecutorRegistry,
      deliveryStore: this.deliveryStore,
      memoryStore: this.memoryStore,
      executorId: memoryExecutorId,
      enabled: config.memoryAnalysis?.retrievalEnabled,
      timeoutMs: config.memoryAnalysis?.retrievalTimeoutMs,
      maxCandidateLines: config.memoryAnalysis?.retrievalMaxCandidateLines,
      maxCandidateChars: config.memoryAnalysis?.retrievalMaxCandidateChars,
      maxSelectedLines: config.memoryAnalysis?.retrievalMaxSelectedLines,
      minConfidence: config.memoryAnalysis?.retrievalMinConfidence,
    });
    this.memoryWrapupService = new MemoryWrapupService({
      deliveryStore: this.deliveryStore,
      analysisService: this.memoryAnalysisService,
      workerId: `${this.workerId}-memory`,
      enabled: config.memoryWrapup?.enabled,
      debounceMs: config.memoryWrapup?.debounceMs,
      batchSize: config.memoryWrapup?.batchSize,
      staleMs: config.memoryWrapup?.staleMs,
      retryBaseMs: config.memoryWrapup?.retryBaseMs,
      maxAttempts: config.memoryWrapup?.maxAttempts,
      retentionMs: config.memoryWrapup?.retentionMs,
      keepLatestPerThread: config.memoryWrapup?.keepLatestPerThread,
      onProposals: async ({ job, proposals }) => {
        if (job.thread.platform !== 'lark') return;
        const runPlatform = this.createPlatformForRun(job.thread);
        if (!runPlatform.larkAdapter) return;
        const sourceRun = await this.deliveryStore.getAgentRun(job.sourceRunId);
        for (const proposal of proposals) {
          await runPlatform.larkAdapter.sendMemoryProposalCard(
            job.thread,
            proposal,
            {
              runId: job.sourceRunId,
              replyToMessageId: sourceRun?.message
                ? sourceReplyMessageId(sourceRun.message)
                : sourceRun?.messageId,
            },
          );
        }
      },
    });
    this.knowledgeEnrichmentService = new KnowledgeEnrichmentService({
      store: this.knowledgeSourceStore,
      executorRegistry: knowledgeExecutorRegistry,
      executorId: knowledgeExecutorId,
      workerId: `${this.workerId}-knowledge`,
      enabled: config.knowledgeEnrichment?.enabled ?? config.executors?.mode === 'local-cli',
      batchSize: config.knowledgeEnrichment?.batchSize,
      leaseMs: config.knowledgeEnrichment?.leaseMs,
      retryBaseMs: config.knowledgeEnrichment?.retryBaseMs,
    });
    this.knowledgeSourceRefreshService = new KnowledgeSourceRefreshService({
      store: this.knowledgeSourceRefreshStore,
      knowledgeStore: this.knowledgeSourceStore,
      workerId: `${this.workerId}-knowledge-refresh`,
      enabled: config.knowledgeRefresh?.enabled ?? true,
      batchSize: config.knowledgeRefresh?.batchSize,
      leaseMs: config.knowledgeRefresh?.leaseMs,
      retryBaseMs: config.knowledgeRefresh?.retryBaseMs,
      timeoutMs: config.knowledgeRefresh?.timeoutMs,
    });
    this.delegatedAgentTaskService = new DelegatedAgentTaskService({
      store: this.delegatedAgentTaskStore,
      agentStore: this.delegatedAgentStore,
      skillStore: this.skillStore,
      knowledgeStore: this.knowledgeSourceStore,
      memoryStore: this.memoryStore,
      threadConfigStore: this.threadConfigStore,
      deliveryStore: this.deliveryStore,
      workerId: `${this.workerId}-agent-tasks`,
      enabled: config.delegatedAgentTasks?.enabled ?? true,
      batchSize: config.delegatedAgentTasks?.batchSize,
      leaseMs: config.delegatedAgentTasks?.leaseMs,
      retryBaseMs: config.delegatedAgentTasks?.retryBaseMs,
      resolveExecutor: (definition) => {
        if (definition.executorId !== 'codex' && definition.executorId !== 'claude') return undefined;
        return createDefaultExecutorRegistry({
          ...config.executors,
          timeoutMs: definition.timeoutMs,
          sessionMode: 'transcript',
          artifactRoot: undefined,
          codexModel: definition.executorId === 'codex' ? definition.model : config.executors?.codexModel,
          codexAppServer: false,
          claudeModel: definition.executorId === 'claude' ? definition.model : config.executors?.claudeModel,
          defaultExecutorId: definition.executorId,
        }, this.toolBroker).get(definition.executorId);
      },
      onCompleted: async (task) => {
        const source = await this.deliveryStore.getAgentRun(task.parentRunId);
        if (!source?.thread) return undefined;
        const runId = `delegated-result:${task.id}`;
        const message = {
          id: runId,
          threadId: source.thread.id,
          platform: source.thread.platform,
          text: [
            `An asynchronous delegated task reached terminal status ${task.status}. Review the result or failure and respond to the user only if it is useful.`,
            `Task ID: ${task.id}`,
            `Agent: ${task.agentId}`,
            `Original task: ${task.task}`,
            `Result: ${task.summary || task.error || '(no result)'}`,
          ].join('\n'),
          actor: { id: `delegated:${task.agentId}`, displayName: task.agentId, isBot: true },
          createdAt: new Date().toISOString(),
          mentionsAgent: true,
          metadata: { delegatedAgentTaskId: task.id, parentRunId: task.parentRunId },
        };
        const staged = await this.deliveryStore.createAgentRunOrSteer({
          runId,
          thread: source.thread,
          message,
          bindingId: source.bindingId,
          executorId: source.executorId,
          transportMode: source.transportMode,
          allowLiveSteering: false,
          metadata: {
            ...source.metadata,
            source: 'delegated-agent-task',
            delegatedAgentTaskId: task.id,
            continuationOfRunId: source.id,
          },
        });
        return staged.steering ? `steering:${staged.steering.id}` : staged.run.id;
      },
    });
    this.workflowCoordinator = new WorkflowCoordinatorService({
      workflowStore: this.workflowStore,
      deliveryStore: this.deliveryStore,
      threadConfigStore: this.threadConfigStore,
      coordinatorId: `${this.workerId}-workflows`,
      claimStaleMs: config.workflows?.claimStaleMs,
      batchSize: config.workflows?.batchSize,
      transportModeForPlatform: (platform) => {
        if (platform === 'lark') {
          return `lark-${this.larkTransportStatus().mode}`;
        }
        if (platform === 'telegram') {
          return `telegram-${this.telegramTransportStatus().mode}`;
        }
        if (platform === 'slack') {
          return `slack-${this.slackTransportStatus().mode}`;
        }
        if (platform === 'github') {
          return `github-${this.githubTransportStatus().mode}`;
        }
        return platform === 'workflow' ? 'workflow-internal' : 'tracked-text';
      },
    });
    this.larkDocumentWatcher = new LarkDocumentWatcherService({
      workflowStore: this.workflowStore,
      threadConfigStore: this.threadConfigStore,
      watcherId: `${this.workerId}-lark-documents`,
      enabled: config.workflows?.larkDocumentWatcherEnabled,
      available:
        Boolean(config.lark?.appId && config.lark?.appSecret) &&
        this.larkTransportStatus().mode === 'http',
      claimStaleMs: config.workflows?.larkDocumentWatcherClaimStaleMs,
      batchSize: config.workflows?.larkDocumentWatcherBatchSize,
      request: (pathname, options) =>
        this.larkOpenApiTransport().openApiRequest(pathname, options),
    });
  }

  get workerId(): string {
    return this.config.workerId || `opentag-worker-${process.pid}`;
  }

  get activeRunCount(): number {
    return this.activeRuns.size;
  }

  get passRunning(): boolean {
    return Boolean(this.workerPass);
  }

  get shuttingDown(): boolean {
    return this._shuttingDown;
  }

  beginShutdown(reason = 'process_shutdown'): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    this.shutdownReason = reason;
    this.memoryWrapupService.beginShutdown();
    this.knowledgeEnrichmentService.beginShutdown();
    this.knowledgeSourceRefreshService.beginShutdown();
    this.delegatedAgentTaskService.beginShutdown();
    for (const controller of this.activeRuns.values()) {
      controller.abort(`${OPENTAG_REQUEUE_RUN_ABORT_REASON}:${reason}`);
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([
      this.workerPass,
      this.memoryWrapupService.waitForIdle(),
      this.knowledgeEnrichmentService.waitForIdle(),
      this.knowledgeSourceRefreshService.waitForIdle(),
      this.delegatedAgentTaskService.waitForIdle(),
    ]);
  }

  get passCount(): number {
    return this._passCount;
  }

  get lastPassAt(): string | undefined {
    return this._lastPassAt;
  }

  get lastPassResult(): AgentWorkerPassResult | undefined {
    return this._lastPassResult
      ? structuredClone(this._lastPassResult)
      : undefined;
  }

  storageStatus(): {
    driver: 'file' | 'sqlite';
    wal: boolean;
    migration?: {
      deliveryImported: boolean;
      pairingImported: boolean;
      accessImported: boolean;
      memoryImported: boolean;
      routinesImported: boolean;
      workflowsImported: boolean;
    };
  } {
    return {
      driver: this.sqliteStorage ? 'sqlite' : 'file',
      wal: Boolean(this.sqliteStorage),
      migration: this.sqliteStorage?.migration,
    };
  }

  close(): void {
    this.sqliteStorage?.close();
  }

  larkTransportStatus(): ReturnType<typeof larkTransportStatus> {
    return larkTransportStatus(this.config.lark);
  }

  telegramTransportStatus(): ReturnType<typeof telegramTransportStatus> {
    return telegramTransportStatus(this.config.telegram);
  }

  slackTransportStatus(): ReturnType<typeof slackTransportStatus> {
    return slackTransportStatus(this.config.slack);
  }

  githubTransportStatus(): ReturnType<typeof githubTransportStatus> {
    return githubTransportStatus(this.config.github);
  }

  executorStatus(): Record<string, unknown> {
    const config = this.config.executors ?? {};
    return {
      mode: config.mode ?? 'dry-run',
      workspaceRoot: path.resolve(config.workspaceRoot || process.cwd()),
      timeoutMs: config.timeoutMs ?? 20 * 60_000,
      maxOutputBytes: config.maxOutputBytes ?? 2_000_000,
      sessionMode: config.sessionMode ?? 'provider',
      sessionNamespace:
        config.sessionNamespace || defaultProviderSessionNamespace(),
      transcriptMaxEntries: config.transcriptMaxEntries ?? 40,
      transcriptMaxChars: config.transcriptMaxChars ?? 40_000,
      artifactRoot: path.resolve(
        config.artifactRoot || path.join(this.config.dataDir, 'artifacts'),
      ),
      maxArtifactBytes: config.maxArtifactBytes ?? 30 * 1024 * 1024,
      maxArtifacts: config.maxArtifacts ?? 10,
      defaultExecutorId: this.executorRegistry.defaultExecutorId,
      registered: this.executorRegistry.list(),
      runControlPollMs: this.config.runControlPollMs ?? 250,
      runHeartbeatMs: this.config.runHeartbeatMs ?? 15_000,
      memoryAnalysis: this.memoryAnalysisService.status(),
      memoryRetrieval: this.memoryRetrievalService.status(),
      memoryWrapup: {
        enabled: this.memoryWrapupService.enabled,
        running: this.memoryWrapupService.running,
      },
      knowledgeEnrichment: this.knowledgeEnrichmentService.status(),
      knowledgeRefresh: this.knowledgeSourceRefreshService.status(),
      delegatedAgentTasks: this.delegatedAgentTaskService.status(),
    };
  }

  async recoverStaleAgentRuns(
    options: RecoverStaleAgentRunsOptions,
  ): Promise<Awaited<ReturnType<DeliveryStore['recoverStaleAgentRuns']>>> {
    return this.deliveryStore.recoverStaleAgentRuns(options);
  }

  async recoverStaleToolApprovals(olderThanMs?: number): Promise<number> {
    const recovered = await this.deliveryStore.recoverStaleToolApprovals({
      olderThanMs,
    });
    return recovered.failed;
  }

  private async toolApprovalRunRequest(
    approval: ToolApprovalRecord,
  ): Promise<AgentRunRequest> {
    const resolved = await this.threadConfigStore.resolveThreadPolicy(
      approval.thread,
    );
    return {
      runId: approval.runId,
      workspace: resolved.workspace,
      project: resolved.project,
      thread: approval.thread,
      message: {
        id: `tool-approval:${approval.id}`,
        threadId: approval.thread.id,
        platform: approval.thread.platform,
        text: `Approved ${approval.title}`,
        actor: { id: approval.approvedBy || 'operator' },
        createdAt: new Date().toISOString(),
        mentionsAgent: false,
      },
      identity: resolved.identity,
      access: resolved.access,
      memory: '',
      onEvent: async (event) => {
        await this.deliveryStore.appendAgentRunEvent(
          approval.runId,
          event.type,
          agentRunEventSummary(event),
        );
        if (
          event.type === 'tool_approval' &&
          event.approval.status !== 'pending'
        ) {
          await this.updateDeliveredToolApprovalCard(event.approval);
        }
      },
    };
  }

  async runToolApprovalPass(limit = 10): Promise<{
    claimed: number;
    succeeded: number;
    failed: number;
  }> {
    const approvals = await this.deliveryStore.listToolApprovals({
      status: 'approved',
      limit,
    });
    const pendingContinuations = (
      await this.deliveryStore.listToolApprovals({
        status: 'succeeded',
        limit: Math.max(limit, 100),
      })
    ).filter((approval) => approval.continuationStatus === 'pending');
    const result = { claimed: 0, succeeded: 0, failed: 0 };
    for (const approval of approvals) {
      try {
        const execution = await this.toolBroker.executeApproved({
          approvalId: approval.id,
          request: await this.toolApprovalRunRequest(approval),
          claimedBy: `${this.workerId}:tool-approval`,
        });
        if (!execution.executed) continue;
        result.claimed += 1;
        if (execution.approval.status === 'succeeded') result.succeeded += 1;
        else result.failed += 1;
        try {
          await scheduleToolApprovalContinuation({
            deliveryStore: this.deliveryStore,
            approval: execution.approval,
          });
        } catch (error) {
          await this.deliveryStore
            .appendAgentRunEvent(execution.approval.runId, 'log', {
              message: `Tool succeeded; continuation will retry: ${
                error instanceof Error ? error.message : String(error)
              }`,
              metadata: {
                level: 'warn',
                approvalId: execution.approval.id,
                continuationStatus: 'pending',
              },
            })
            .catch(() => undefined);
        }
      } catch {
        result.failed += 1;
      }
    }
    for (const approval of pendingContinuations) {
      try {
        await scheduleToolApprovalContinuation({
          deliveryStore: this.deliveryStore,
          approval,
        });
      } catch (error) {
        await this.deliveryStore
          .appendAgentRunEvent(approval.runId, 'log', {
            message: `Tool continuation retry deferred: ${
              error instanceof Error ? error.message : String(error)
            }`,
            metadata: {
              level: 'warn',
              approvalId: approval.id,
              continuationStatus: 'pending',
            },
          })
          .catch(() => undefined);
      }
    }
    return result;
  }

  private async updateDeliveredToolApprovalCard(
    approval: ToolApprovalRecord,
  ): Promise<void> {
    if (approval.thread.platform !== 'lark') return;
    const receipt = (
      await this.deliveryStore.listOutbox({
        runId: approval.runId,
        limit: 100,
      })
    ).find(
      (candidate) =>
        candidate.kind === 'lark.card.create' &&
        candidate.status === 'delivered' &&
        candidate.payload.stage === 'tool-approval-card' &&
        candidate.payload.approvalId === approval.id &&
        candidate.externalId,
    );
    if (!receipt?.externalId) return;
    const platform = this.createPlatformForRun(approval.thread);
    await platform.larkAdapter?.updateToolApprovalCard({
      thread: approval.thread,
      approval,
      cardId: receipt.externalId,
      runId: approval.runId,
    });
  }

  async deliverySnapshot(limit = 50): Promise<Record<string, unknown>> {
    const [
      summary,
      outbox,
      turnDeliveries,
      bindings,
      inboundEvents,
      steering,
      sessions,
    ] =
      await Promise.all([
        this.deliveryStore.summarize(),
        this.deliveryStore.listOutbox({ limit }),
        this.deliveryStore.listTurnDeliveries({ limit }),
        this.deliveryStore.listThreadBindings(limit),
        this.deliveryStore.listInboundEvents({ limit }),
        this.deliveryStore.listAgentRunSteering({ limit }),
        this.deliveryStore.listAgentThreadSessions({ limit }),
      ]);
    return {
      summary,
      outbox: outbox.map(({ payload: _payload, ...rest }) => rest),
      turnDeliveries,
      bindings,
      inboundEvents,
      steering,
      sessions,
    };
  }

  async runAgentWorkerPass(limit = 1): Promise<AgentWorkerPassResult> {
    if (this.workerPass) return this.workerPass;
    if (this._shuttingDown) {
      return {
        claimed: 0,
        completed: 0,
        failed: 0,
        requeued: 0,
        superseded: 0,
        runs: [],
      };
    }
    this.workerPass = (async () => {
      await this.deliveryStore.recoverStaleToolApprovals();
      await this.runToolApprovalPass(Math.max(1, limit));
      const claimed = await this.deliveryStore.claimQueuedAgentRuns({
        limit,
        workerId: this.workerId,
      });
      const result: AgentWorkerPassResult = {
        claimed: claimed.length,
        completed: 0,
        failed: 0,
        requeued: 0,
        superseded: 0,
        runs: [],
      };
      for (const run of claimed) {
        try {
          if (this._shuttingDown) {
            const released = await this.deliveryStore.requeueAgentRun(run.id, {
              workerId: this.workerId,
              reason: 'worker_shutdown_before_execution',
            });
            if (released?.status === 'queued') result.requeued += 1;
            else result.failed += 1;
          } else {
            await this.executeAgentRun(run, { alreadyClaimed: true });
            result.completed += 1;
          }
        } catch {
          const latest = await this.deliveryStore.getAgentRun(run.id);
          if (latest?.status === 'queued') {
            result.requeued += 1;
          } else if (latest?.workerId && latest.workerId !== this.workerId) {
            result.superseded += 1;
          } else {
            result.failed += 1;
          }
        } finally {
          const latest = await this.deliveryStore.getAgentRun(run.id);
          if (latest) result.runs.push(latest);
          if (run.metadata?.source === 'workflow' && !this._shuttingDown) {
            await this.workflowCoordinator.tick();
          }
        }
      }
      this._passCount += 1;
      this._lastPassAt = new Date().toISOString();
      this._lastPassResult = structuredClone(result);
      return result;
    })();
    try {
      return await this.workerPass;
    } finally {
      this.workerPass = undefined;
    }
  }

  async runWorkflowCoordinatorTick(): Promise<WorkflowCoordinatorTickResult> {
    return this.workflowCoordinator.tick();
  }

  async runLarkDocumentWatcherTick(options: { force?: boolean } = {}): Promise<import('./lark-document-watcher.js').LarkDocumentWatcherTickResult> {
    return this.larkDocumentWatcher.tick(options);
  }

  async runMemoryWrapupPass(): Promise<import('./memory-wrapup.js').MemoryWrapupPassResult> {
    return this.memoryWrapupService.runPass();
  }

  async runKnowledgeEnrichmentPass(): Promise<import('./knowledge-enrichment.js').KnowledgeEnrichmentPassResult> {
    return this.knowledgeEnrichmentService.runPass();
  }

  async runKnowledgeSourceRefreshPass(): Promise<import('./knowledge-source-refresh.js').KnowledgeSourceRefreshPassResult> {
    return this.knowledgeSourceRefreshService.runPass();
  }

  async runDelegatedAgentTaskPass(): Promise<import('./delegated-agent-tasks.js').DelegatedAgentTaskPassResult> {
    return this.delegatedAgentTaskService.runPass();
  }

  async sendRoutineNotification(
    thread: SourceThread,
    notification: RoutineNotification,
  ): Promise<void> {
    const runPlatform = this.createPlatformForRun(thread);
    await runPlatform.platform.sendMessage(
      thread,
      notification.message,
      [],
      {
        runId: notification.runId,
        stage: 'routine-notification',
        notificationId: notification.id,
      },
    );
  }

  async executeAgentRun(
    initialRun: AgentRunRecord,
    options?: { alreadyClaimed?: boolean },
  ): Promise<Record<string, unknown>> {
    const runId = initialRun.id;
    if (!initialRun.thread || !initialRun.message) {
      const message = 'missing_saved_run_payload';
      await this.deliveryStore.markAgentRunFailed(runId, message);
      throw new Error(message);
    }
    if (initialRun.status === 'cancel_requested') {
      await this.deliveryStore.markAgentRunCancelled(
        runId,
        'cancel_requested_before_start',
      );
      return {
        run: await this.deliveryStore.getAgentRun(runId),
        route: this.runRoute(initialRun),
        delivery: await this.deliverySnapshot(20),
      };
    }
    if (!options?.alreadyClaimed) {
      const runningRun = await this.deliveryStore.markAgentRunRunning(runId, {
        workerId: this.workerId,
      });
      if (runningRun?.status === 'cancelled') {
        return {
          run: runningRun,
          route: this.runRoute(runningRun),
          delivery: await this.deliverySnapshot(20),
        };
      }
    }

    let runPlatform: ReturnType<OpenTagWorkerHost['createPlatformForRun']>;
    try {
      runPlatform = this.createPlatformForRun(initialRun.thread);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deliveryStore.markAgentRunFailed(runId, message);
      await this.markRunInboundFailed(initialRun, message);
      throw error;
    }

    const threadStatusCommand = parseThreadStatusCommand(
      initialRun.message.text,
    );
    if (threadStatusCommand) {
      try {
        const commandResult = await this.threadStatusService.execute(
          threadStatusCommand,
          initialRun.thread,
          initialRun.metadata?.actorAuthorization,
        );
        await this.deliveryStore.appendAgentRunEvent(runId, 'thread_status', {
          message: commandResult.summary,
          metadata: {
            action: commandResult.action,
            workspaceId: commandResult.workspaceId,
            projectId: commandResult.projectId,
            skills: commandResult.skillIds.length,
            agents: commandResult.agentIds.length,
            sources: commandResult.knowledgeSourceIds.length,
            routines: commandResult.routineIds.length,
            nextModelRunAllowed: commandResult.budget.allowed,
          },
        });
        await runPlatform.platform.sendMessage(
          initialRun.thread,
          commandResult.summary,
          [],
          { runId, replyToMessageId: sourceReplyMessageId(initialRun.message) },
        );
        await this.markRunInboundProcessed(initialRun);
        await this.deliveryStore.markAgentRunCompleted(
          runId,
          commandResult.summary,
        );
        return {
          result: { summary: commandResult.summary, artifacts: [] },
          run: await this.deliveryStore.getAgentRun(runId),
          route: this.runRoute(initialRun),
          threadStatus: commandResult,
          delivery: await this.deliverySnapshot(20),
          transport: {
            platform: runPlatform.platform.kind,
            mode: runPlatform.transportMode,
          },
          larkTransport: runPlatform.larkTransport,
          larkDryRun: this.larkDryRunPayload(runPlatform.larkDryRun),
          telegramTransport: runPlatform.telegramTransport,
          telegramDryRun: this.telegramDryRunPayload(
            runPlatform.telegramDryRun,
          ),
          slackTransport: runPlatform.slackTransport,
          slackDryRun: this.slackDryRunPayload(runPlatform.slackDryRun),
          githubTransport: runPlatform.githubTransport,
          githubDryRun: this.githubDryRunPayload(runPlatform.githubDryRun),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deliveryStore.markAgentRunFailed(runId, message);
        await this.markRunInboundFailed(initialRun, message);
        throw error;
      }
    }

    const routineCommand = this.routineCommandService.parse(
      initialRun.message.text,
    );
    if (routineCommand) {
      try {
        const commandResult = await this.routineCommandService.execute(
          routineCommand,
          initialRun.thread,
          initialRun.message.actor.id,
        );
        await this.deliveryStore.appendAgentRunEvent(runId, 'routine_command', {
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
          { runId, replyToMessageId: sourceReplyMessageId(initialRun.message) },
        );
        await this.markRunInboundProcessed(initialRun);
        await this.deliveryStore.markAgentRunCompleted(
          runId,
          commandResult.summary,
        );
        return {
          result: {
            summary: commandResult.summary,
            artifacts: [],
          },
          run: await this.deliveryStore.getAgentRun(runId),
          route: this.runRoute(initialRun),
          routineCommand: {
            kind: routineCommand.kind,
            ...commandResult,
          },
          delivery: await this.deliverySnapshot(20),
          transport: {
            platform: runPlatform.platform.kind,
            mode: runPlatform.transportMode,
          },
          larkTransport: runPlatform.larkTransport,
          larkDryRun: this.larkDryRunPayload(runPlatform.larkDryRun),
          telegramTransport: runPlatform.telegramTransport,
          telegramDryRun: this.telegramDryRunPayload(
            runPlatform.telegramDryRun,
          ),
          slackTransport: runPlatform.slackTransport,
          slackDryRun: this.slackDryRunPayload(runPlatform.slackDryRun),
          githubTransport: runPlatform.githubTransport,
          githubDryRun: this.githubDryRunPayload(runPlatform.githubDryRun),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deliveryStore.markAgentRunFailed(runId, message);
        await this.markRunInboundFailed(initialRun, message);
        throw error;
      }
    }

    const memoryCommand = parseMemoryCommand(initialRun.message.text, {
      defaultScope: memoryCommandDefaultScope(initialRun.thread),
    });

    if (memoryCommand) {
      try {
        const commandResult = await this.applyMemoryCommand({
          command: memoryCommand,
          thread: initialRun.thread,
          actorId: memoryActorForMessage(
            initialRun.thread,
            initialRun.message.actor.id,
          ),
          source: `${initialRun.thread.platform}-command`,
          workspaceMemoryWriteAllowed:
            initialRun.metadata?.workspaceMemoryWriteAllowed === true,
        });
        await this.deliveryStore.appendAgentRunEvent(runId, 'memory_command', {
          message: String(commandResult.summary),
          metadata: {
            kind: memoryCommand.kind,
            scope: memoryCommand.scope,
            action: commandResult.action,
            proposalId: commandResult.proposalId,
          },
        });
        const proposal = commandResult.proposal as MemoryProposal | undefined;
        if (
          commandResult.action === 'proposed' &&
          proposal &&
          runPlatform.larkAdapter
        ) {
          await runPlatform.larkAdapter.sendMemoryProposalCard(
            initialRun.thread,
            proposal,
            {
              runId,
              replyToMessageId: sourceReplyMessageId(initialRun.message),
            },
          );
        } else {
          await runPlatform.platform.sendMessage(
            initialRun.thread,
            String(commandResult.summary),
            [],
            {
              runId,
              replyToMessageId: sourceReplyMessageId(initialRun.message),
            },
          );
        }
        await this.markRunInboundProcessed(initialRun);
        await this.deliveryStore.markAgentRunCompleted(
          runId,
          String(commandResult.summary),
        );
        return {
          result: {
            summary: commandResult.summary,
            artifacts: [],
          },
          run: await this.deliveryStore.getAgentRun(runId),
          route: this.runRoute(initialRun),
          memoryCommand: {
            kind: memoryCommand.kind,
            scope: memoryCommand.scope,
            ...commandResult,
          },
          delivery: await this.deliverySnapshot(20),
          transport: {
            platform: runPlatform.platform.kind,
            mode: runPlatform.transportMode,
          },
          larkTransport: runPlatform.larkTransport,
          larkDryRun: this.larkDryRunPayload(runPlatform.larkDryRun),
          telegramTransport: runPlatform.telegramTransport,
          telegramDryRun: this.telegramDryRunPayload(
            runPlatform.telegramDryRun,
          ),
          slackTransport: runPlatform.slackTransport,
          slackDryRun: this.slackDryRunPayload(runPlatform.slackDryRun),
          githubTransport: runPlatform.githubTransport,
          githubDryRun: this.githubDryRunPayload(runPlatform.githubDryRun),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deliveryStore.markAgentRunFailed(runId, message);
        await this.markRunInboundFailed(initialRun, message);
        throw error;
      }
    }

    const budgetPolicy = await this.enforceRunBudget(initialRun);
    const runtime = this.createRuntimeForPlatform(runPlatform.platform);
    const publishResult =
      initialRun.metadata?.source !== 'routine' ||
      initialRun.metadata?.routineNotificationMode === 'every_result';
    const progressSurfaceId =
      publishResult
        ? await this.deliveryStore.getDeliveredProgressSurfaceId(
            runId,
            initialRun.thread.platform,
          )
        : undefined;
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);
    if (this._shuttingDown) {
      abortController.abort(
        `${OPENTAG_REQUEUE_RUN_ABORT_REASON}:${this.shutdownReason}`,
      );
    }
    const stopCancellationMonitor = monitorDurableRunCancellation({
      deliveryStore: this.deliveryStore,
      runId,
      abortController,
      workerId: this.workerId,
      pollMs: this.config.runControlPollMs,
      heartbeatMs: this.config.runHeartbeatMs,
    });
    try {
      await hydrateLarkThreadContext({
        deliveryStore: this.deliveryStore,
        run: initialRun,
        transport: runPlatform.larkHistoryTransport,
        botOpenId: this.config.lark?.botOpenId,
        maxMessages: this.config.lark?.threadHistoryMaxMessages,
        retryFailedAfterMs: this.config.lark?.threadHistoryRetryMs,
      });
      const transcript = await loadDurableConversationContext({
        deliveryStore: this.deliveryStore,
        run: initialRun,
        transcriptMaxEntries: this.config.executors?.transcriptMaxEntries,
        transcriptMaxChars: this.config.executors?.transcriptMaxChars,
      });
      const providerSession =
        (this.config.executors?.mode ?? 'dry-run') === 'local-cli' &&
        (this.config.executors?.sessionMode ?? 'provider') === 'provider'
          ? await createDurableProviderSessionContext({
              deliveryStore: this.deliveryStore,
              run: initialRun,
              providerId: initialRun.executorId || 'codex',
              namespace:
                this.config.executors?.sessionNamespace ||
                defaultProviderSessionNamespace(),
            })
          : undefined;
      const result = await runtime.handleMessage({
        runId,
        executorId: initialRun.executorId,
        thread: initialRun.thread,
        message: initialRun.message,
        workspaceMemoryWriteAllowed:
          initialRun.metadata?.workspaceMemoryWriteAllowed === true,
        transcript,
      providerSession,
      publishResult,
      abortSignal: abortController.signal,
        progressSurfaceId,
        assertActive: async () => {
          if (abortController.signal.aborted) {
            throw new Error(String(abortController.signal.reason));
          }
          const renewed = await renewDurableRunLeaseOrAbort({
            deliveryStore: this.deliveryStore,
            runId,
            workerId: this.workerId,
            abortController,
          });
          if (!renewed) {
            throw new Error(String(abortController.signal.reason));
          }
        },
        steering: createDurableSteeringProvider({
          deliveryStore: this.deliveryStore,
          runId,
          workerId: this.workerId,
          pollMs: this.config.runControlPollMs,
        }),
        onEvent: async (event) => {
          await this.deliveryStore.appendAgentRunEvent(
            runId,
            event.type,
            agentRunEventSummary(event),
          );
          if (event.type === 'delegation' && event.status === 'completed') {
            const resolved = await this.threadConfigStore.resolveThreadPolicy(
              initialRun.thread!,
            );
            await this.deliveryStore.recordAgentRunUsage({
              runId,
              recordKey: `delegation:${event.invocationId}`,
              purpose: 'delegation',
              thread: initialRun.thread!,
              quantity: {
                runs: 0,
                costUsd: event.usage?.costUsd ?? 0,
              },
              source: 'delegated-agent',
              policies: resolved.access.budgetPolicies,
              metadata: {
                purpose: 'delegation',
                agentId: event.agentId,
                executorId: event.executorId,
                inputTokens: event.usage?.inputTokens,
                outputTokens: event.usage?.outputTokens,
                costReported: typeof event.usage?.costUsd === 'number',
              },
            });
          }
          if (
            event.type === 'tool_approval' &&
            event.approval.status === 'pending' &&
            runPlatform.larkAdapter
          ) {
            try {
              await runPlatform.larkAdapter.sendToolApprovalCard(
                initialRun.thread!,
                event.approval,
                {
                  runId,
                  replyToMessageId: sourceReplyMessageId(initialRun.message),
                },
              );
            } catch (error) {
              await this.deliveryStore.appendAgentRunEvent(runId, 'log', {
                message: `Tool approval card delivery failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                metadata: { level: 'warn', approvalId: event.approval.id },
              });
            }
          }
        },
      });
      if (runPlatform.larkAdapter) {
        for (const proposal of result.memoryProposals ?? []) {
          try {
            await runPlatform.larkAdapter.sendMemoryProposalCard(
              initialRun.thread,
              proposal,
              {
                runId,
                replyToMessageId: sourceReplyMessageId(initialRun.message),
              },
            );
          } catch (error) {
            await this.deliveryStore.appendAgentRunEvent(runId, 'log', {
              message: `Memory proposal card delivery failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              metadata: { level: 'warn', proposalId: proposal.id },
            });
          }
        }
      }
      await this.recordRunUsage(initialRun, result);
      await this.markRunInboundProcessed(initialRun);
      await this.deliveryStore.markAgentRunCompleted(runId, result.summary);
      try {
        await this.memoryWrapupService.enqueueRun(initialRun);
      } catch (error) {
        await this.deliveryStore.appendAgentRunEvent(runId, 'log', {
          message: `Automatic memory wrapup enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
          metadata: { level: 'warn' },
        });
      }
      return {
        result,
        run: await this.deliveryStore.getAgentRun(runId),
        route: this.runRoute(initialRun),
        delivery: await this.deliverySnapshot(20),
        transport: {
          platform: runPlatform.platform.kind,
          mode: runPlatform.transportMode,
        },
        larkTransport: runPlatform.larkTransport,
        larkDryRun: this.larkDryRunPayload(runPlatform.larkDryRun),
        telegramTransport: runPlatform.telegramTransport,
        telegramDryRun: this.telegramDryRunPayload(
          runPlatform.telegramDryRun,
        ),
        slackTransport: runPlatform.slackTransport,
        slackDryRun: this.slackDryRunPayload(runPlatform.slackDryRun),
        githubTransport: runPlatform.githubTransport,
        githubDryRun: this.githubDryRunPayload(runPlatform.githubDryRun),
        budgetPolicy,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isOpenTagLeaseLostAbort(abortController.signal)) {
        // Another worker owns the durable lease; this process must not mutate it.
      } else if (isOpenTagRequeueAbort(abortController.signal)) {
        const requeued = await this.deliveryStore.requeueAgentRun(runId, {
          workerId: this.workerId,
          reason: String(abortController.signal.reason),
        });
        if (requeued?.status === 'cancel_requested') {
          await this.deliveryStore.markAgentRunCancelled(
            runId,
            requeued.lastError || 'durable_cancel_requested',
          );
          await this.markRunInboundFailed(initialRun, message);
        }
      } else if (abortController.signal.aborted) {
        await this.deliveryStore.markAgentRunCancelled(
          runId,
          openTagAbortSummary(abortController.signal, message),
        );
        await this.markRunInboundFailed(initialRun, message);
      } else {
        await this.deliveryStore.markAgentRunFailed(runId, message);
        await this.markRunInboundFailed(initialRun, message);
      }
      throw error;
    } finally {
      stopCancellationMonitor();
      this.activeRuns.delete(runId);
    }
  }

  private async memoryContextForThread(
    thread: SourceThread,
  ): Promise<{ workspace?: Workspace; project?: Project }> {
    const workspace = await this.threadConfigStore.getWorkspace(thread);
    const project = await this.threadConfigStore.getProject(thread, workspace);
    return { workspace, project };
  }

  private async applyMemoryCommand(input: {
    command: ParsedMemoryCommand;
    thread: SourceThread;
    actorId?: string;
    source?: string;
    workspaceMemoryWriteAllowed?: boolean;
  }): Promise<Record<string, unknown>> {
    const { workspace, project } = await this.memoryContextForThread(
      input.thread,
    );
    const access = await this.threadConfigStore.getAccessBundle(input.thread, {
      workspace,
      project,
    });
    const permission = input.command.kind === 'show' ? 'read' : 'write';
    if (
      input.command.scope === 'workspace' &&
      permission === 'write' &&
      input.workspaceMemoryWriteAllowed === false
    ) {
      throw new Error('memory_workspace_write_not_granted');
    }
    if (!memoryScopeGranted(access, input.command.scope, permission)) {
      throw new Error(`memory_${input.command.scope}_${permission}_not_granted`);
    }
    if (
      (input.command.kind === 'remember' || input.command.kind === 'forget') &&
      memoryApprovalRequired(
        access.memoryApprovalPolicy,
        input.command.scope,
        input.command.kind,
      )
    ) {
      if (!this.memoryStore.proposeMemory) {
        throw new Error('memory_proposals_unavailable');
      }
      const proposal = await this.memoryStore.proposeMemory({
        thread: input.thread,
        workspace,
        project,
        scope: input.command.scope,
        action: input.command.kind,
        value: input.command.value,
        actorId: input.actorId,
        source: input.source,
          reason: 'policy:memory_approval_required',
          retentionDays: memoryRetentionDaysFor(access, input.command.scope),
      });
      return {
        summary: `Queued ${input.command.kind} for ${formatMemoryScopeLabel(input.command.scope)} approval.`,
        action: 'proposed',
        proposalId: proposal.id,
        proposal,
        scope: input.command.scope,
        workspaceId: workspace?.id,
        projectId: project?.id,
        value: input.command.value,
      };
    }
    if (input.command.kind === 'remember') {
      await this.memoryStore.rememberScoped({
        thread: input.thread,
        workspace,
        project,
        scope: input.command.scope,
        text: input.command.value,
        expiresAt: memoryExpiryForAccess(access, input.command.scope),
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
      await this.memoryStore.forgetScoped({
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

    const snapshot = await this.memoryStore.loadMemory({
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

  private createRuntimeForPlatform(platform: PlatformAdapter): OpenTagRuntime {
    const defaultExecutor = this.executorRegistry.get(
      this.executorRegistry.defaultExecutorId,
    );
    if (!defaultExecutor) throw new Error('default_executor_not_available');
    return new OpenTagRuntime({
      platform,
      executor: defaultExecutor,
      executorRegistry: this.executorRegistry,
      memory: this.memoryStore,
      memoryRetriever: this.memoryRetrievalService,
      skills: this.skillStore,
      delegatedAgents: this.delegatedAgentStore,
      knowledgeSources: this.knowledgeSourceStore,
      threadConfig: this.threadConfigStore,
    });
  }

  private async enforceRunBudget(
    run: AgentRunRecord,
  ): Promise<UsageBudgetCheckResult['policy'] | undefined> {
    if (!run.thread) return undefined;
    const resolved = await this.threadConfigStore.resolveThreadPolicy(run.thread);
    const check = await this.deliveryStore.checkUsageBudget({
      thread: run.thread,
      policy: resolved.access.budgetPolicy,
      policies: resolved.access.budgetPolicies,
      expected: { runs: 1, costUsd: 0 },
    });
    if (check.allowed) return check.policy;

    const message = formatUsageBudgetMessage(check);
    await this.deliveryStore.appendAgentRunEvent(run.id, 'usage_budget_denied', {
      message,
      metadata: {
        reason: check.reason,
        period: check.period,
        policy: check.policy,
        current: check.current,
        projected: check.projected,
        violated: check.violated,
      },
    });
    if (run.metadata?.source === 'routine') {
      await this.deliveryStore.markAgentRunFailed(run.id, message);
    } else {
      await this.deliveryStore.markAgentRunCancelled(run.id, message);
    }
    throw new Error(`usage_budget_denied:${message}`);
  }

  private async recordRunUsage(
    run: AgentRunRecord,
    result?: AgentRunResult,
  ): Promise<void> {
    if (!run.thread) return;
    const resolved = await this.threadConfigStore.resolveThreadPolicy(run.thread);
    await this.deliveryStore.recordAgentRunUsage({
      runId: run.id,
      recordKey: 'agent',
      purpose: 'agent',
      thread: run.thread,
      quantity: runUsageQuantity(result),
      source: 'agent-run',
      policies: resolved.access.budgetPolicies,
      metadata: {
        executorId: run.executorId,
        transportMode: run.transportMode,
        inputTokens: result?.usage?.inputTokens,
        outputTokens: result?.usage?.outputTokens,
        costReported: typeof result?.usage?.costUsd === 'number',
      },
    });
  }

  private createPlatformForRun(thread: SourceThread): {
    platform: PlatformAdapter;
    transportMode: string;
    larkAdapter?: LarkPlatformAdapter;
    larkDryRun?: MemoryLarkTransport;
    larkTransport?: { mode: 'memory' | 'http' };
    larkHistoryTransport?: LarkTransport;
    telegramDryRun?: MemoryTelegramTransport;
    telegramTransport?: { mode: 'memory' | 'http' };
    slackDryRun?: MemorySlackTransport;
    slackTransport?: { mode: 'memory' | 'http' };
    githubDryRun?: MemoryGitHubTransport;
    githubTransport?: { mode: 'memory' | 'http' };
  } {
    if (thread.platform === 'lark') {
      const larkTransport = this.createLarkTransportForRun();
      const larkAdapter = new LarkPlatformAdapter(
        new TrackedLarkTransport(larkTransport.transport, this.deliveryStore),
      );
      return {
        platform: larkAdapter,
        larkAdapter,
        transportMode: `lark-${larkTransport.mode}`,
        larkDryRun: larkTransport.dryRun,
        larkTransport: { mode: larkTransport.mode },
        larkHistoryTransport: larkTransport.transport,
      };
    }

    if (thread.platform === 'telegram') {
      const telegramTransport = this.createTelegramTransportForRun();
      return {
        platform: new TelegramPlatformAdapter(
          new TrackedTelegramTransport(
            telegramTransport.transport,
            this.deliveryStore,
          ),
        ),
        transportMode: `telegram-${telegramTransport.mode}`,
        telegramDryRun: telegramTransport.dryRun,
        telegramTransport: { mode: telegramTransport.mode },
      };
    }

    if (thread.platform === 'slack') {
      const slackTransport = this.createSlackTransportForRun();
      return {
        platform: new SlackPlatformAdapter(
          new TrackedSlackTransport(slackTransport.transport, this.deliveryStore),
        ),
        transportMode: `slack-${slackTransport.mode}`,
        slackDryRun: slackTransport.dryRun,
        slackTransport: { mode: slackTransport.mode },
      };
    }

    if (thread.platform === 'github') {
      const githubTransport = this.createGitHubTransportForRun();
      return {
        platform: new GitHubPlatformAdapter(
          new TrackedGitHubTransport(
            githubTransport.transport,
            this.deliveryStore,
          ),
        ),
        transportMode: `github-${githubTransport.mode}`,
        githubDryRun: githubTransport.dryRun,
        githubTransport: { mode: githubTransport.mode },
      };
    }

    return {
      platform: new TrackedTextPlatformAdapter({
        kind: thread.platform,
        store: this.deliveryStore,
        capabilities: genericClientCapabilities(thread.platform),
      }),
      transportMode: 'tracked-text',
    };
  }

  private createLarkTransportForRun(): {
    transport: LarkTransport;
    dryRun?: MemoryLarkTransport;
    mode: 'memory' | 'http';
  } {
    const status = this.larkTransportStatus();
    if (status.mode === 'http') {
      if (!this.config.lark?.appId || !this.config.lark?.appSecret) {
        throw new Error(
          'OPENTAG_LARK_TRANSPORT=http requires OPENTAG_LARK_APP_ID and OPENTAG_LARK_APP_SECRET.',
        );
      }
      return {
        mode: 'http',
        transport: new HttpLarkTransport({
          appId: this.config.lark.appId,
          appSecret: this.config.lark.appSecret,
          domain: status.domain,
          baseUrl: status.baseUrl,
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

  private larkOpenApiTransport(): HttpLarkTransport {
    if (!this.config.lark?.appId || !this.config.lark?.appSecret) {
      throw new Error('lark_tool_provider_credentials_unavailable');
    }
    this.toolLarkTransport ??= new HttpLarkTransport({
      appId: this.config.lark.appId,
      appSecret: this.config.lark.appSecret,
      domain: this.larkTransportStatus().domain,
      baseUrl: this.config.lark.baseUrl,
    });
    return this.toolLarkTransport;
  }

  private createTelegramTransportForRun(): {
    transport: TelegramTransport;
    dryRun?: MemoryTelegramTransport;
    mode: 'memory' | 'http';
  } {
    const status = this.telegramTransportStatus();
    if (status.mode === 'http') {
      if (!this.config.telegram?.botToken) {
        throw new Error(
          'OPENTAG_TELEGRAM_TRANSPORT=http requires OPENTAG_TELEGRAM_BOT_TOKEN.',
        );
      }
      return {
        mode: 'http',
        transport: new HttpTelegramTransport({
          botToken: this.config.telegram.botToken,
          baseUrl: status.baseUrl,
        }),
      };
    }

    const dryRun = new MemoryTelegramTransport();
    return { mode: 'memory', transport: dryRun, dryRun };
  }

  private createGitHubTransportForRun(): {
    transport: GitHubTransport;
    dryRun?: MemoryGitHubTransport;
    mode: 'memory' | 'http';
  } {
    const status = this.githubTransportStatus();
    if (status.mode === 'http') {
      if (!this.config.github?.token && !this.config.github?.tokenProvider) {
        throw new Error(
          'OPENTAG_GITHUB_TRANSPORT=http requires a deployment token or GitHub App installation credentials.',
        );
      }
      return {
        mode: 'http',
        transport: new HttpGitHubTransport({
          token: this.config.github.token,
          tokenProvider: this.config.github.tokenProvider,
          baseUrl: status.baseUrl,
        }),
      };
    }

    const dryRun = new MemoryGitHubTransport();
    return { mode: 'memory', transport: dryRun, dryRun };
  }

  private createSlackTransportForRun(): {
    transport: SlackTransport;
    dryRun?: MemorySlackTransport;
    mode: 'memory' | 'http';
  } {
    const status = this.slackTransportStatus();
    if (status.mode === 'http') {
      if (!this.config.slack?.botToken) {
        throw new Error(
          'OPENTAG_SLACK_TRANSPORT=http requires OPENTAG_SLACK_BOT_TOKEN.',
        );
      }
      return {
        mode: 'http',
        transport: new HttpSlackTransport({
          botToken: this.config.slack.botToken,
          baseUrl: status.baseUrl,
          maxUploadBytes: this.config.slack.maxUploadBytes,
        }),
      };
    }
    const dryRun = new MemorySlackTransport();
    return { mode: 'memory', transport: dryRun, dryRun };
  }

  private larkDryRunPayload(
    dryRun: MemoryLarkTransport | undefined,
  ): Record<string, unknown> | undefined {
    return dryRun
      ? {
          texts: dryRun.texts,
          cards: dryRun.cards,
          files: dryRun.files,
        }
      : undefined;
  }

  private telegramDryRunPayload(
    dryRun: MemoryTelegramTransport | undefined,
  ): Record<string, unknown> | undefined {
    return dryRun
      ? {
          texts: dryRun.texts,
          edits: dryRun.edits,
          documents: dryRun.documents,
        }
      : undefined;
  }

  private githubDryRunPayload(
    dryRun: MemoryGitHubTransport | undefined,
  ): Record<string, unknown> | undefined {
    return dryRun
      ? {
          comments: dryRun.comments,
          updates: dryRun.updates,
        }
      : undefined;
  }

  private slackDryRunPayload(
    dryRun: MemorySlackTransport | undefined,
  ): Record<string, unknown> | undefined {
    return dryRun
      ? {
          texts: dryRun.texts,
          edits: dryRun.edits,
          files: dryRun.files,
        }
      : undefined;
  }

  private async markRunInboundProcessed(run: AgentRunRecord): Promise<void> {
    if (!run.inboundEventId || !run.thread || !run.message) return;
    await this.deliveryStore.markInboundEventProcessed(run.inboundEventId, {
      workspaceId: run.thread.workspaceId,
      projectId: run.thread.projectId,
      threadId: run.thread.id,
      messageId: run.message.id,
    });
  }

  private async markRunInboundFailed(
    run: AgentRunRecord,
    error: string,
  ): Promise<void> {
    if (!run.inboundEventId) return;
    await this.deliveryStore.markInboundEventFailed(run.inboundEventId, error);
  }

  private runRoute(run: AgentRunRecord): Record<string, unknown> {
    return {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      threadId: run.threadId,
      platform: run.platform,
      bindingId: run.bindingId,
      workerId: run.workerId,
    };
  }
}

function sourceReplyMessageId(
  message: SourceMessage | undefined,
): string | undefined {
  return message?.replyToMessageId || message?.id;
}

export function createOpenTagWorkerHost(
  config: RuntimeHostConfig,
): OpenTagWorkerHost {
  return new OpenTagWorkerHost(config);
}
