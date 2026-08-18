import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolveHostedReportByToken } from '@opentag/executor-cli';
import {
  createHttpProjectRunner,
  parseProjectRunnerRoutesJson,
} from '@opentag/project-runner';
import {
  memoryScopeGranted,
  memoryExpiryForAccess,
  memoryRetentionDaysFor,
  OPENTAG_APPROVE_MEMORY_PROPOSAL_ACTION,
  OPENTAG_APPROVE_TOOL_ACTION,
  OPENTAG_REJECT_MEMORY_PROPOSAL_ACTION,
  OPENTAG_REJECT_TOOL_ACTION,
  OPENTAG_REQUEUE_RUN_ABORT_REASON,
  OPENTAG_SET_THREAD_ACTIVATION_ACTION,
  OPENTAG_STOP_RUN_ACTION,
  OPENTAG_TAKE_OVER_RUN_ACTION,
  OpenTagRuntime,
  isOpenTagLeaseLostAbort,
  isOpenTagRequeueAbort,
  openTagAbortSummary,
  type AgentRunEvent,
  type AgentRunRequest,
  type DelegatedAgentTask,
  type Artifact,
  type MemoryApprovalAction,
  type MemoryApprovalPolicy,
  type MemoryRetentionPolicy,
  type MemoryProposal,
  type MemoryProposalStatus,
  type MemoryScopeKind,
  type KnowledgeSourceExtraction,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformKind,
  type Project,
  type SourceAttachment,
  type SourceMessage,
  type SourceThread,
  type ToolGrant,
  type ToolGrantKind,
  type ToolApprovalRecord,
  type ToolApprovalPolicy,
  type ToolApprovalStatus,
  type Workspace,
  type UsageBudgetPolicy,
} from '@opentag/core';
import {
  AgentSkillRevisionConflictError,
  DelegatedAgentRevisionConflictError,
  FileAgentSkillStore,
  FileDelegatedAgentStore,
  FileDelegatedAgentTaskStore,
  FileKnowledgeSourceStore,
  FileKnowledgeSourceRefreshStore,
  FileLarkBotCredentialStore,
  FileExecutorCredentialStore,
  FileOperatorCredentialStore,
  FileToolCredentialIdentityStore,
  knowledgeSourceNextRefreshAt,
  KnowledgeSourceRevisionConflictError,
  LarkBotCredentialRevisionConflictError,
  ExecutorCredentialRevisionConflictError,
  managedExecutorRuntimeSettings,
  normalizeManagedExecutorBaseUrl,
  FilePairingStore,
  FileManagedConnectorStore,
  FileThreadConfigStore,
  FileWorkspaceAccessStore,
  ManagedConnectorRevisionConflictError,
  OperatorCredentialRevisionConflictError,
  ToolCredentialIdentityRevisionConflictError,
  CapabilityBundleRevisionConflictError,
  type CapabilityBundlePreset,
  type ActorAuthorizationDecision,
  type ActorCapability,
  type PairingActivationMode,
  type ProjectAccessMode,
  type ProjectRole,
  type UpsertChannelAgentPolicyInput,
  type UpsertCapabilityBundleInput,
  type UpsertProjectAgentPolicyInput,
  type UpsertWorkspaceAgentPolicyInput,
  type WorkspaceMemberIdentity,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '@opentag/config';
import {
  FileDeliveryStore,
  TrackedGitHubTransport,
  TrackedLarkTransport,
  TrackedSlackTransport,
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
  type ThreadBindingSource,
  type LarkHistoryImportJobRecord,
  type UsageBudgetCheckResult,
  type UsageBudgetLine,
  type AgentRunEventType,
  type ScopedAgentRunTimelineEvent,
  type WorkspaceDataLifecycleResult,
} from '@opentag/delivery';
import {
  ScopedFileMemoryStore,
  parseMemoryCommand,
  type ParsedMemoryCommand,
} from '@opentag/memory';
import {
  GitHubPlatformAdapter,
  GitHubAppInstallationTokenProvider,
  HttpGitHubTransport,
  MemoryGitHubTransport,
  githubCallbackEventType,
  githubCallbackExternalId,
  GITHUB_WORKFLOW_EVENT_CATALOG,
  normalizeGitHubWebhook,
  normalizeGitHubWorkflowEvent,
  parseAndValidateGitHubCallback,
  type GitHubTransport,
  type GitHubWebhookPayload,
} from '@opentag/platform-github';
import {
  HttpLarkTransport,
  LarkPlatformAdapter,
  MemoryLarkTransport,
  applyLarkChatInfo,
  applyUnavailableLarkChatInfo,
  larkCallbackEventType,
  larkCallbackExternalId,
  normalizeLarkCardAction,
  normalizeLarkEvent,
  parseAndValidateLarkCallback,
  type LarkIncomingEvent,
  type LarkCardAction,
  type LarkCardActionResponse,
  type LarkChatInfo,
  type LarkOpenApiDomain,
  type LarkTransport,
} from '@opentag/platform-lark';
import {
  HttpSlackTransport,
  MemorySlackTransport,
  SlackPlatformAdapter,
  normalizeSlackEvent,
  parseAndValidateSlackCallback,
  slackCallbackEventType,
  slackCallbackExternalId,
  type SlackEventEnvelope,
  type SlackTransport,
} from '@opentag/platform-slack';
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
  createDurableProviderSessionContext,
  defaultProviderSessionNamespace,
  hydrateLarkThreadContext,
  loadDurableConversationContext,
  monitorDurableRunCancellation,
  renewDurableRunLeaseOrAbort,
  RoutineSchedulerService,
  WorkflowCoordinatorService,
  LarkDocumentWatcherService,
  KnowledgeEnrichmentService,
  KnowledgeSourceRefreshService,
  decodeKnowledgeContentBase64,
  extractKnowledgeContent,
  DelegatedAgentTaskService,
  ManagedContentError,
  ManagedContentStore,
  MemoryAnalysisService,
  MemoryRetrievalService,
  MemoryWrapupService,
  parseThreadStatusCommand,
  ThreadStatusService,
  collectOpenTagMetricsSnapshot,
  createDefaultExecutorRegistry,
  pathIsWithin,
  renderOpenTagPrometheusMetrics,
  scheduleToolApprovalContinuation,
  type RoutineTickResult,
  type WorkflowCoordinatorTickResult,
} from '@opentag/runtime-host';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';
import {
  createOpenTagToolBroker,
  externalMcpRegistryFromJson,
} from '@opentag/tool-broker';
import {
  ALERTMANAGER_WORKFLOW_EVENT_CATALOG,
  FileWorkflowStore,
  LARK_DOCUMENT_WORKFLOW_EVENT_CATALOG,
  normalizeAlertmanagerWorkflowEvent,
  type UpsertWorkflowProducerRouteInput,
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
import {
  assertServerStartupSecurity,
  larkEventModeValue,
} from './startup-security.js';
import { backfillLarkHistory } from './lark-backfill.js';
import { LarkHistoryImportService } from './lark-history-import.js';

const port = Number(process.env.OPENTAG_PORT || 3077);
const host = process.env.OPENTAG_HOST || '127.0.0.1';
const processStartedAt = new Date().toISOString();
const dataDir = process.env.OPENTAG_DATA_DIR || path.resolve('data');
const adminDir = path.resolve('apps/admin/public');
const larkBotCredentialStore = new FileLarkBotCredentialStore(dataDir);
const managedLarkBotCredential = await larkBotCredentialStore.get();
const executorCredentialStore = new FileExecutorCredentialStore(dataDir);
const managedExecutorCredential = await executorCredentialStore.get();
const managedExecutorSettings = managedExecutorCredential
  ? managedExecutorRuntimeSettings(managedExecutorCredential)
  : undefined;
const metricsToken = process.env.OPENTAG_METRICS_TOKEN?.trim();
const shutdownTimeoutMs = numberEnvironmentValue(
  'OPENTAG_SHUTDOWN_TIMEOUT_MS',
  25_000,
);
const botOpenId = process.env.OPENTAG_LARK_BOT_OPEN_ID;
const larkTransportMode = managedLarkBotCredential
  ? 'http'
  : process.env.OPENTAG_LARK_TRANSPORT || 'memory';
const larkAppId = managedLarkBotCredential?.appId || process.env.OPENTAG_LARK_APP_ID;
const larkAppSecret =
  managedLarkBotCredential?.appSecret || process.env.OPENTAG_LARK_APP_SECRET;
const larkDomain = managedLarkBotCredential?.domain ||
  larkDomainValue(process.env.OPENTAG_LARK_DOMAIN);
const larkBaseUrl = process.env.OPENTAG_LARK_BASE_URL;
const larkVerificationToken =
  managedLarkBotCredential?.verificationToken ||
  process.env.OPENTAG_LARK_VERIFICATION_TOKEN;
const larkEncryptKey =
  managedLarkBotCredential?.encryptKey || process.env.OPENTAG_LARK_ENCRYPT_KEY;
const larkEventMode = larkEventModeValue(process.env.OPENTAG_LARK_EVENT_MODE);
const larkCallbackMaxSkewSeconds = Number(
  process.env.OPENTAG_LARK_CALLBACK_MAX_SKEW_SECONDS || 300,
);
const larkCallbackMaxBytes = numberEnvironmentValue(
  'OPENTAG_LARK_CALLBACK_MAX_BYTES',
  1024 * 1024,
);
const larkRequireBinding = ['1', 'true', 'yes'].includes(
  String(process.env.OPENTAG_LARK_REQUIRE_BINDING || 'false').toLowerCase(),
);
const larkThreadHistoryMaxMessages = numberEnvironmentValue(
  'OPENTAG_LARK_THREAD_HISTORY_MAX_MESSAGES',
  50,
);
const larkThreadHistoryRetryMs = numberEnvironmentValue(
  'OPENTAG_LARK_THREAD_HISTORY_RETRY_MS',
  60 * 60_000,
);
const larkChatInfoTimeoutMs = numberEnvironmentValue(
  'OPENTAG_LARK_CHAT_INFO_TIMEOUT_MS',
  10_000,
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
const slackTransportMode = process.env.OPENTAG_SLACK_TRANSPORT || 'memory';
const slackBotToken = process.env.OPENTAG_SLACK_BOT_TOKEN;
const slackBotUserId = process.env.OPENTAG_SLACK_BOT_USER_ID;
const slackSigningSecret = process.env.OPENTAG_SLACK_SIGNING_SECRET;
const slackBaseUrl = process.env.OPENTAG_SLACK_BASE_URL;
const slackWorkspaceId =
  process.env.OPENTAG_SLACK_WORKSPACE_ID || 'dev-workspace';
const slackCallbackMaxSkewSeconds = numberEnvironmentValue(
  'OPENTAG_SLACK_CALLBACK_MAX_SKEW_SECONDS',
  300,
);
const slackCallbackMaxBytes = numberEnvironmentValue(
  'OPENTAG_SLACK_CALLBACK_MAX_BYTES',
  1024 * 1024,
);
const slackRequireBinding = ['1', 'true', 'yes'].includes(
  String(process.env.OPENTAG_SLACK_REQUIRE_BINDING || 'true').toLowerCase(),
);
const githubTransportMode = process.env.OPENTAG_GITHUB_TRANSPORT || 'memory';
const githubToken =
  process.env.OPENTAG_GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN;
const githubAppId = process.env.OPENTAG_GITHUB_APP_ID?.trim();
const githubAppInstallationId =
  process.env.OPENTAG_GITHUB_APP_INSTALLATION_ID?.trim();
const githubAppPrivateKeyFile =
  process.env.OPENTAG_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
const githubAppTokenProvider = (() => {
  const configured = [
    githubAppId,
    githubAppInstallationId,
    githubAppPrivateKeyFile,
  ].filter(Boolean).length;
  if (!configured) return undefined;
  if (configured !== 3) throw new Error('github_app_configuration_incomplete');
  if (githubToken) throw new Error('github_credential_configuration_ambiguous');
  return new GitHubAppInstallationTokenProvider({
    appId: githubAppId!,
    installationId: githubAppInstallationId!,
    privateKeyFile: githubAppPrivateKeyFile!,
    baseUrl: process.env.OPENTAG_GITHUB_BASE_URL,
  });
})();
const githubBotLogin = process.env.OPENTAG_GITHUB_BOT_LOGIN;
const githubWebhookSecret = process.env.OPENTAG_GITHUB_WEBHOOK_SECRET;
const githubBaseUrl = process.env.OPENTAG_GITHUB_BASE_URL;
const githubWorkspaceId =
  process.env.OPENTAG_GITHUB_WORKSPACE_ID || 'dev-workspace';
const githubRequireBinding = ['1', 'true', 'yes'].includes(
  String(process.env.OPENTAG_GITHUB_REQUIRE_BINDING || 'true').toLowerCase(),
);
const pairingTtlSeconds = Math.max(
  30,
  numberEnvironmentValue('OPENTAG_PAIRING_TTL_SECONDS', 300),
);
const agentWorkerMode = process.env.OPENTAG_AGENT_WORKER || 'inline';
const agentWorkerEnabled = agentWorkerMode !== 'manual';
const agentWorkerIntervalMs = Number(process.env.OPENTAG_AGENT_WORKER_INTERVAL_MS || 2000);
const delegatedAgentTasksEnabled =
  agentWorkerEnabled &&
  !['0', 'false', 'no'].includes(
    String(process.env.OPENTAG_DELEGATED_AGENT_TASKS_ENABLED || 'true').toLowerCase(),
  );
const delegatedAgentTaskIntervalMs = numberEnvironmentValue(
  'OPENTAG_DELEGATED_AGENT_TASKS_INTERVAL_MS',
  1_000,
);
const agentWorkerStaleMs = Math.max(
  1_000,
  Number(process.env.OPENTAG_AGENT_WORKER_STALE_MS || 120_000),
);
const agentRunHeartbeatMs = Math.max(
  250,
  Math.min(
    numberEnvironmentValue('OPENTAG_AGENT_RUN_HEARTBEAT_MS', 15_000),
    Math.floor(agentWorkerStaleMs / 3),
  ),
);
const runControlPollMs = Math.max(
  25,
  Number(process.env.OPENTAG_RUN_CONTROL_POLL_MS || 250),
);
const assistantStreamPollMs = Math.max(
  50,
  Number(process.env.OPENTAG_ASSISTANT_STREAM_POLL_MS || 250),
);
const agentWorkerId = `opentag-${process.pid}`;
const executorMode = managedExecutorSettings?.mode ||
  (process.env.OPENTAG_EXECUTOR_MODE === 'local-cli' ? 'local-cli' : 'dry-run');
const executorWorkspaceRoot =
  process.env.OPENTAG_EXECUTOR_WORKSPACE_ROOT || process.cwd();
const executorTimeoutMs = numberEnvironmentValue(
  'OPENTAG_EXECUTOR_TIMEOUT_MS',
  2 * 60 * 60_000,
);
const executorMaxOutputBytes = numberEnvironmentValue(
  'OPENTAG_EXECUTOR_MAX_OUTPUT_BYTES',
  2_000_000,
);
const executorArtifactRoot =
  process.env.OPENTAG_ARTIFACT_ROOT || path.join(dataDir, 'artifacts');
const hostedReportBaseUrl =
  process.env.OPENTAG_HOSTED_REPORT_BASE_URL ||
  process.env.OPENTAG_PUBLIC_BASE_URL;
const executorMaxArtifactBytes = numberEnvironmentValue(
  'OPENTAG_MAX_ARTIFACT_BYTES',
  30 * 1024 * 1024,
);
const executorMaxArtifacts = numberEnvironmentValue(
  'OPENTAG_MAX_ARTIFACTS',
  10,
);
const maxAttachmentBytes = numberEnvironmentValue(
  'OPENTAG_MAX_ATTACHMENT_BYTES',
  30 * 1024 * 1024,
);
const clientIngressBodyMaxBytes =
  Math.ceil(maxAttachmentBytes / 3) * 4 + 256 * 1024;
const managedContentStore = new ManagedContentStore({
  rootDir: path.join(dataDir, 'content'),
  maxBytes: maxAttachmentBytes,
});
let inboundLarkTransport: HttpLarkTransport | undefined;
const larkChatInfoCache = new Map<
  string,
  { expiresAt: number; value?: LarkChatInfo }
>();
let inboundTelegramTransport: HttpTelegramTransport | undefined;
let inboundSlackTransport: HttpSlackTransport | undefined;
const executorInheritEnv = listEnvironmentValue('OPENTAG_EXECUTOR_INHERIT_ENV');
const executorSessionMode =
  managedExecutorSettings?.sessionMode ||
  (process.env.OPENTAG_EXECUTOR_SESSION_MODE === 'transcript'
    ? 'transcript'
    : 'provider');
const executorSessionNamespace =
  process.env.OPENTAG_EXECUTOR_SESSION_NAMESPACE ||
  defaultProviderSessionNamespace();
const transcriptMaxEntries = numberEnvironmentValue(
  'OPENTAG_THREAD_CONTEXT_MAX_ENTRIES',
  40,
);
const transcriptMaxChars = numberEnvironmentValue(
  'OPENTAG_THREAD_CONTEXT_MAX_CHARS',
  40_000,
);
const codexCommand = process.env.OPENTAG_CODEX_COMMAND || 'codex';
const codexModel = managedExecutorSettings?.codexModel || process.env.OPENTAG_CODEX_MODEL;
const codexCommandPrefixArgs = managedExecutorSettings?.codexCommandPrefixArgs;
const codexEnvironment = managedExecutorSettings?.codexEnvironment;
const codexAppServer =
  process.env.OPENTAG_CODEX_APP_SERVER !== undefined
    ? !['0', 'false', 'no'].includes(
        process.env.OPENTAG_CODEX_APP_SERVER.toLowerCase(),
      )
    : ['codex', 'codex.exe'].includes(path.basename(codexCommand));
const codexContextCompactionThreshold = optionalNumberEnvironmentValue(
  'OPENTAG_CODEX_CONTEXT_COMPACTION_THRESHOLD',
);
const codexHome =
  process.env.OPENTAG_CODEX_HOME || path.join(dataDir, 'providers', 'codex');
const codexAuthSourceHome = process.env.OPENTAG_CODEX_AUTH_SOURCE_HOME;
const claudeCommand = process.env.OPENTAG_CLAUDE_COMMAND || 'claude';
const claudeModel = managedExecutorSettings?.claudeModel || process.env.OPENTAG_CLAUDE_MODEL;
const claudeEnvironment = managedExecutorSettings?.claudeEnvironment;
const claudeMaxBudgetUsd = optionalNumberEnvironmentValue(
  'OPENTAG_CLAUDE_MAX_BUDGET_USD',
);
const memoryExecutorId = managedExecutorSettings?.defaultExecutorId ||
  (process.env.OPENTAG_MEMORY_EXECUTOR === 'claude' ? 'claude' : 'codex');
const memoryModel =
  process.env.OPENTAG_MEMORY_MODEL ||
  managedExecutorCredential?.model ||
  (memoryExecutorId === 'codex' ? 'gpt-5.6-luna' : undefined);
const memoryAnalysisModel =
  process.env.OPENTAG_MEMORY_ANALYSIS_MODEL || memoryModel;
const memoryQueryModel = process.env.OPENTAG_MEMORY_QUERY_MODEL || memoryModel;
const memoryRetrievalModel =
  process.env.OPENTAG_MEMORY_RETRIEVAL_MODEL || memoryModel;
const memoryWrapupModel = process.env.OPENTAG_MEMORY_WRAPUP_MODEL || memoryModel;
const knowledgeExecutorId = managedExecutorSettings?.defaultExecutorId ||
  (process.env.OPENTAG_KNOWLEDGE_EXECUTOR === 'claude' ? 'claude' : 'codex');
const knowledgeModel =
  process.env.OPENTAG_KNOWLEDGE_MODEL ||
  managedExecutorCredential?.model ||
  (knowledgeExecutorId === 'codex' ? 'gpt-5.6-luna' : undefined);
const knowledgeEnrichmentEnabled = !['0', 'false', 'no'].includes(
  String(
    process.env.OPENTAG_KNOWLEDGE_ENRICHMENT_ENABLED ||
      (executorMode === 'local-cli' ? 'true' : 'false'),
  ).toLowerCase(),
);
const knowledgeEnrichmentIntervalMs = numberEnvironmentValue(
  'OPENTAG_KNOWLEDGE_ENRICHMENT_INTERVAL_MS',
  2_000,
);
const knowledgeEnrichmentBatchSize = Math.min(
  20,
  numberEnvironmentValue('OPENTAG_KNOWLEDGE_ENRICHMENT_BATCH_SIZE', 2),
);
const knowledgeRefreshEnabled = !['0', 'false', 'no'].includes(
  String(process.env.OPENTAG_KNOWLEDGE_REFRESH_ENABLED || 'true').toLowerCase(),
);
const knowledgeRefreshIntervalMs = numberEnvironmentValue(
  'OPENTAG_KNOWLEDGE_REFRESH_INTERVAL_MS',
  2_000,
);
const knowledgeRefreshBatchSize = Math.min(
  20,
  numberEnvironmentValue('OPENTAG_KNOWLEDGE_REFRESH_BATCH_SIZE', 2),
);
const memoryAnalysisMaxEntries = numberEnvironmentValue(
  'OPENTAG_MEMORY_ANALYSIS_MAX_ENTRIES',
  200,
);
const memoryAnalysisMaxChars = numberEnvironmentValue(
  'OPENTAG_MEMORY_ANALYSIS_MAX_CHARS',
  200_000,
);
const memoryAnalysisMinConfidence = Number.isFinite(
  Number(process.env.OPENTAG_MEMORY_ANALYSIS_MIN_CONFIDENCE),
)
  ? Math.max(
      0,
      Math.min(
        Number(process.env.OPENTAG_MEMORY_ANALYSIS_MIN_CONFIDENCE),
        1,
      ),
    )
  : 0.65;
const memoryRetrievalEnabled = !['0', 'false', 'no'].includes(
  String(process.env.OPENTAG_MEMORY_RETRIEVAL_ENABLED || 'true').toLowerCase(),
);
const memoryRetrievalTimeoutMs = numberEnvironmentValue(
  'OPENTAG_MEMORY_RETRIEVAL_TIMEOUT_MS',
  15_000,
);
const memoryRetrievalMaxCandidateLines = numberEnvironmentValue(
  'OPENTAG_MEMORY_RETRIEVAL_MAX_CANDIDATE_LINES',
  120,
);
const memoryRetrievalMaxCandidateChars = numberEnvironmentValue(
  'OPENTAG_MEMORY_RETRIEVAL_MAX_CANDIDATE_CHARS',
  48_000,
);
const memoryRetrievalMaxSelectedLines = numberEnvironmentValue(
  'OPENTAG_MEMORY_RETRIEVAL_MAX_SELECTED_LINES',
  16,
);
const memoryRetrievalMinConfidence = Number.isFinite(
  Number(process.env.OPENTAG_MEMORY_RETRIEVAL_MIN_CONFIDENCE),
)
  ? Math.max(
      0,
      Math.min(Number(process.env.OPENTAG_MEMORY_RETRIEVAL_MIN_CONFIDENCE), 1),
    )
  : 0.5;
const memoryWrapupEnabled = !['0', 'false', 'no'].includes(
  String(
    process.env.OPENTAG_MEMORY_WRAPUP_ENABLED ||
      (executorMode === 'local-cli' ? 'true' : 'false'),
  ).toLowerCase(),
);
const memoryWrapupIntervalMs = numberEnvironmentValue(
  'OPENTAG_MEMORY_WRAPUP_INTERVAL_MS',
  2_000,
);
const memoryWrapupDebounceMs = numberEnvironmentValue(
  'OPENTAG_MEMORY_WRAPUP_DEBOUNCE_MS',
  15_000,
);
const memoryWrapupBatchSize = Math.min(
  20,
  numberEnvironmentValue('OPENTAG_MEMORY_WRAPUP_BATCH_SIZE', 1),
);
const memoryWrapupStaleMs = numberEnvironmentValue(
  'OPENTAG_MEMORY_WRAPUP_STALE_MS',
  10 * 60_000,
);
const memoryWrapupRetryBaseMs = numberEnvironmentValue(
  'OPENTAG_MEMORY_WRAPUP_RETRY_BASE_MS',
  30_000,
);
const memoryWrapupMaxAttempts = Math.min(
  20,
  numberEnvironmentValue('OPENTAG_MEMORY_WRAPUP_MAX_ATTEMPTS', 5),
);
const memoryWrapupRetentionMs = numberEnvironmentValue(
  'OPENTAG_MEMORY_WRAPUP_RETENTION_MS',
  7 * 24 * 60 * 60_000,
);
const memoryWrapupMinEntries = Math.min(
  200,
  numberEnvironmentValue('OPENTAG_MEMORY_WRAPUP_MIN_ENTRIES', 200),
);
const memoryWrapupMaxChars = Math.min(
  200_000,
  numberEnvironmentValue('OPENTAG_MEMORY_WRAPUP_MAX_CHARS', 100_000),
);
const memoryWrapupMaxAgeMs = numberEnvironmentValue(
  'OPENTAG_MEMORY_WRAPUP_MAX_AGE_MS',
  24 * 60 * 60_000,
);
const memoryWrapupRawGraceMs = numberEnvironmentValue(
  'OPENTAG_MEMORY_RAW_GRACE_MS',
  7 * 24 * 60 * 60_000,
);
const larkHistoryImportEnabled = !['0', 'false', 'no'].includes(
  String(process.env.OPENTAG_LARK_HISTORY_IMPORT_ENABLED || 'true').toLowerCase(),
);
const larkHistoryImportIntervalMs = numberEnvironmentValue(
  'OPENTAG_LARK_HISTORY_IMPORT_INTERVAL_MS',
  2_000,
);
const larkHistoryImportWindowMs = numberEnvironmentValue(
  'OPENTAG_LARK_HISTORY_IMPORT_WINDOW_MS',
  24 * 60 * 60_000,
);
const larkHistoryImportWindowsPerPass = Math.min(
  31,
  numberEnvironmentValue('OPENTAG_LARK_HISTORY_IMPORT_WINDOWS_PER_PASS', 7),
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
const larkDocumentWatcherEnabled = workflowsEnabled && ![
  '0',
  'false',
  'no',
].includes(
  String(process.env.OPENTAG_LARK_DOCUMENT_WATCHER_ENABLED || 'true').toLowerCase(),
);
const larkDocumentWatcherIntervalMs = numberEnvironmentValue(
  'OPENTAG_LARK_DOCUMENT_WATCHER_TICK_INTERVAL_MS',
  5_000,
);
const larkDocumentWatcherClaimStaleMs = numberEnvironmentValue(
  'OPENTAG_LARK_DOCUMENT_WATCHER_CLAIM_STALE_MS',
  120_000,
);
const larkDocumentWatcherBatchSize = Math.min(
  20,
  numberEnvironmentValue('OPENTAG_LARK_DOCUMENT_WATCHER_BATCH_SIZE', 5),
);
const legacyOperatorWorkspaceIds = listEnvironmentValue(
  'OPENTAG_ADMIN_WORKSPACE_IDS',
) ?? [];
const operatorCredentialStore = new FileOperatorCredentialStore(
  path.join(dataDir, 'config'),
);
const persistentOperatorCredentials = await operatorCredentialStore.list();
const persistentOperatorCredentialCount = persistentOperatorCredentials.length;
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
  sessionSecret:
    process.env.OPENTAG_OPERATOR_SESSION_SECRET ||
    (await operatorCredentialStore.sessionSecret()),
  persistentCredentials: operatorCredentialStore,
  persistentCredentialCount: persistentOperatorCredentialCount,
  sessionTtlSeconds: numberEnvironmentValue(
    'OPENTAG_ADMIN_SESSION_TTL_SECONDS',
    8 * 60 * 60,
  ),
  secureCookie: ['1', 'true', 'yes'].includes(
    String(process.env.OPENTAG_ADMIN_COOKIE_SECURE || 'false').toLowerCase(),
  ),
});
for (const credential of persistentOperatorCredentials) {
  if (operatorAuth.hasStaticPrincipal(credential.id)) {
    throw new Error(`operator_principal_${credential.id}_duplicate`);
  }
}
assertServerStartupSecurity({
  host,
  operatorAuthConfigured: operatorAuth.configured,
  larkEventMode,
  larkVerificationTokenConfigured: Boolean(larkVerificationToken),
  larkEncryptKeyConfigured: Boolean(larkEncryptKey),
});
const clientIngressToken = process.env.OPENTAG_CLIENT_INGRESS_TOKEN;
const workflowIngressToken = process.env.OPENTAG_WORKFLOW_INGRESS_TOKEN;
const knowledgeIngressPrincipals = parseKnowledgeIngressPrincipals(
  process.env.OPENTAG_KNOWLEDGE_INGRESS_PRINCIPALS_JSON,
);
const workflowIngressActor =
  process.env.OPENTAG_WORKFLOW_INGRESS_ACTOR?.trim() || 'workflow-ingress';
const alertmanagerIngressToken =
  process.env.OPENTAG_ALERTMANAGER_INGRESS_TOKEN;
const alertmanagerIngressBodyMaxBytes = numberEnvironmentValue(
  'OPENTAG_ALERTMANAGER_INGRESS_MAX_BYTES',
  256 * 1024,
);
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
const toolCallTimeoutMs = optionalNumberEnvironmentValue(
  'OPENTAG_TOOL_CALL_TIMEOUT_MS',
);
const managedConnectorStore = new FileManagedConnectorStore(
  path.join(dataDir, 'config'),
);
const toolCredentialIdentityStore = new FileToolCredentialIdentityStore(
  path.join(dataDir, 'config'),
);
const skillStore = new FileAgentSkillStore(path.join(dataDir, 'config'));
const delegatedAgentStore = new FileDelegatedAgentStore(
  path.join(dataDir, 'config'),
);
const delegatedAgentTaskStore = new FileDelegatedAgentTaskStore(
  path.join(dataDir, 'config'),
);
const knowledgeSourceStore = new FileKnowledgeSourceStore(
  path.join(dataDir, 'config'),
);
const knowledgeSourceRefreshStore = new FileKnowledgeSourceRefreshStore(
  path.join(dataDir, 'config'),
);
const externalMcpRegistry = externalMcpRegistryFromJson(
  process.env.OPENTAG_EXTERNAL_MCP_SERVERS_JSON,
  {
    timeoutMs: toolCallTimeoutMs,
    stateStore: managedConnectorStore,
  },
);
const defaultLarkToolIdentity =
  larkAppId && larkAppSecret && larkTransportStatus().mode === 'http'
  ? {
      id: 'lark-workspace-bot',
      displayName: 'Lark workspace bot',
      revision: 1,
      externalActor: botOpenId || larkAppId,
    }
  : undefined;
const defaultGitHubToolIdentity = githubToken || githubAppTokenProvider
  ? {
      id: 'github-default',
      displayName: 'GitHub installation identity',
      revision: 1,
      externalActor:
        githubBotLogin ||
        (githubAppId && githubAppInstallationId
          ? `github-app:${githubAppId}:installation:${githubAppInstallationId}`
          : undefined),
    }
  : undefined;
const toolBroker = createOpenTagToolBroker({
  memory: memoryStore,
  approvalStore: deliveryStore,
  workspaceRoot: executorWorkspaceRoot,
  projectRunner:
    process.env.OPENTAG_PROJECT_RUNNER_URL && process.env.OPENTAG_PROJECT_RUNNER_TOKEN
      ? createHttpProjectRunner({
          baseUrl: process.env.OPENTAG_PROJECT_RUNNER_URL,
          token: process.env.OPENTAG_PROJECT_RUNNER_TOKEN,
          routes: parseProjectRunnerRoutesJson(
            process.env.OPENTAG_PROJECT_RUNNER_ROUTES_JSON,
          ),
        })
      : undefined,
  localBoundaryCommands: (process.env.OPENTAG_LOCAL_BOUNDARY_COMMANDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  routines: routineStore,
  github: {
    token: githubToken,
    tokenProvider: githubAppTokenProvider,
    baseUrl: process.env.OPENTAG_GITHUB_BASE_URL,
  },
  defaultCredentialIdentities: {
    lark: defaultLarkToolIdentity,
    github: defaultGitHubToolIdentity,
  },
  async resolveCredentialIdentity(id) {
    if (id === defaultLarkToolIdentity?.id && larkAppId && larkAppSecret) {
      return {
        ...defaultLarkToolIdentity,
        provider: 'lark',
        lark: {
          baseUrl:
            larkBaseUrl ||
            (larkDomain === 'lark'
              ? 'https://open.larksuite.com'
              : 'https://open.feishu.cn'),
          request: (pathname, options) =>
            larkResourceTransport().openApiRequest(pathname, options),
        },
      };
    }
    if (
      id === defaultGitHubToolIdentity?.id &&
      (githubToken || githubAppTokenProvider)
    ) {
      return {
        ...defaultGitHubToolIdentity,
        provider: 'github',
        github: {
          token: githubToken,
          tokenProvider: githubAppTokenProvider,
          baseUrl: githubBaseUrl,
        },
      };
    }
    const identity = await toolCredentialIdentityStore.get(id);
    if (!identity?.enabled) return undefined;
    if (identity.provider === 'github') {
      const tokenRef = identity.envRefs.token;
      const token = tokenRef ? process.env[tokenRef]?.trim() : undefined;
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
    const appIdRef = identity.envRefs.appId;
    const appSecretRef = identity.envRefs.appSecret;
    const appId = appIdRef ? process.env[appIdRef]?.trim() : undefined;
    const appSecret = appSecretRef ? process.env[appSecretRef]?.trim() : undefined;
    if (!appId || !appSecret) return undefined;
    const transport = new HttpLarkTransport({
      appId,
      appSecret,
      domain: larkDomain,
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
  externalMcp: externalMcpRegistry,
  skills: skillStore,
  knowledgeSources: knowledgeSourceStore,
  delegatedAgents: {
    source: delegatedAgentStore,
    tasks: delegatedAgentTaskStore,
    async beforeInvoke({ request }) {
      const check = await deliveryStore.checkUsageBudget({
        thread: request.thread,
        policy: request.access.budgetPolicy,
        policies: request.access.budgetPolicies,
        expected: { runs: 0, costUsd: 0.000001 },
      });
      if (!check.allowed) {
        throw new Error(`usage_budget_denied:${formatUsageBudgetMessage(check)}`);
      }
    },
    resolveExecutor(definition) {
      if (
        definition.executorId !== 'codex' &&
        definition.executorId !== 'claude'
      ) {
        return undefined;
      }
      if (
        managedExecutorSettings?.enabledExecutorIds &&
        !managedExecutorSettings.enabledExecutorIds.includes(definition.executorId)
      ) {
        return undefined;
      }
      return createDefaultExecutorRegistry(
        {
          mode: executorMode,
          workspaceRoot: executorWorkspaceRoot,
          timeoutMs: definition.timeoutMs,
          maxOutputBytes: executorMaxOutputBytes,
          inheritEnv: executorInheritEnv,
          sessionMode: 'transcript',
          codexCommand,
          codexCommandPrefixArgs,
          codexEnvironment,
          codexModel:
            definition.executorId === 'codex' ? definition.model : codexModel,
          codexAppServer: false,
          codexHome,
          codexAuthSourceHome,
          claudeCommand,
          claudeEnvironment,
          claudeModel:
            definition.executorId === 'claude' ? definition.model : claudeModel,
          claudeMaxBudgetUsd,
          defaultExecutorId: definition.executorId,
          enabledExecutorIds: managedExecutorSettings?.enabledExecutorIds,
        },
        toolBroker,
      ).get(definition.executorId);
    },
  },
  lark:
    larkAppId && larkAppSecret && larkTransportStatus().mode === 'http'
      ? {
          baseUrl:
            larkBaseUrl ||
            (larkDomain === 'lark'
              ? 'https://open.larksuite.com'
              : 'https://open.feishu.cn'),
          request: (pathname, options) =>
            larkResourceTransport().openApiRequest(pathname, options),
        }
      : undefined,
  maxCallsPerRun: optionalNumberEnvironmentValue(
    'OPENTAG_TOOL_MAX_CALLS_PER_RUN',
  ),
  callTimeoutMs: toolCallTimeoutMs,
  approvalTtlMs: optionalNumberEnvironmentValue('OPENTAG_TOOL_APPROVAL_TTL_MS'),
});
const toolCatalog = toolBroker.catalog();
const executorRegistry = createDefaultExecutorRegistry(
  {
    mode: executorMode,
    workspaceRoot: executorWorkspaceRoot,
    timeoutMs: executorTimeoutMs,
    maxOutputBytes: executorMaxOutputBytes,
    inheritEnv: executorInheritEnv,
    sessionMode: executorSessionMode,
    artifactRoot: executorArtifactRoot,
    hostedReportBaseUrl,
    maxArtifactBytes: executorMaxArtifactBytes,
    maxArtifacts: executorMaxArtifacts,
    codexCommand,
    codexCommandPrefixArgs,
    codexEnvironment,
    codexModel,
    codexAppServer,
    codexContextCompactionThreshold,
    codexHome,
    codexAuthSourceHome,
    claudeCommand,
    claudeEnvironment,
    claudeModel,
    claudeMaxBudgetUsd,
    defaultExecutorId: managedExecutorSettings?.defaultExecutorId,
    enabledExecutorIds: managedExecutorSettings?.enabledExecutorIds,
  },
  toolBroker,
);
const createMemoryExecutorRegistry = (model: string | undefined) =>
  createDefaultExecutorRegistry({
    mode: executorMode,
    workspaceRoot: executorWorkspaceRoot,
    timeoutMs: optionalNumberEnvironmentValue(
      'OPENTAG_MEMORY_ANALYSIS_TIMEOUT_MS',
    ) ?? executorTimeoutMs,
    maxOutputBytes: executorMaxOutputBytes,
    inheritEnv: executorInheritEnv,
    sessionMode: 'transcript',
    codexCommand,
    codexCommandPrefixArgs,
    codexEnvironment,
    codexModel: memoryExecutorId === 'codex' ? model : codexModel,
    codexAppServer: false,
    claudeCommand,
    claudeEnvironment,
    claudeModel: memoryExecutorId === 'claude' ? model : claudeModel,
    claudeMaxBudgetUsd,
    defaultExecutorId: memoryExecutorId,
    enabledExecutorIds: managedExecutorSettings?.enabledExecutorIds,
  });
const memoryAnalysisExecutorRegistry = createMemoryExecutorRegistry(
  memoryAnalysisModel,
);
const memoryQueryExecutorRegistry = createMemoryExecutorRegistry(memoryQueryModel);
const memoryRetrievalExecutorRegistry = createMemoryExecutorRegistry(
  memoryRetrievalModel,
);
const memoryWrapupExecutorRegistry = createMemoryExecutorRegistry(
  memoryWrapupModel,
);
const knowledgeExecutorRegistry = createDefaultExecutorRegistry({
  mode: executorMode,
  workspaceRoot: executorWorkspaceRoot,
  timeoutMs:
    optionalNumberEnvironmentValue('OPENTAG_KNOWLEDGE_ENRICHMENT_TIMEOUT_MS') ??
    executorTimeoutMs,
  maxOutputBytes: executorMaxOutputBytes,
  inheritEnv: executorInheritEnv,
  sessionMode: 'transcript',
  codexCommand,
  codexCommandPrefixArgs,
  codexEnvironment,
  codexModel: knowledgeExecutorId === 'codex' ? knowledgeModel : codexModel,
  codexAppServer: false,
  claudeCommand,
  claudeEnvironment,
  claudeModel: knowledgeExecutorId === 'claude' ? knowledgeModel : claudeModel,
  claudeMaxBudgetUsd,
  defaultExecutorId: knowledgeExecutorId,
  enabledExecutorIds: managedExecutorSettings?.enabledExecutorIds,
});
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
const activeAssistantStreams = new Set<ServerResponse>();
const pairingNoticeAt = new Map<string, number>();
const accessNoticeAt = new Map<string, number>();
let agentWorkerTimer: NodeJS.Timeout | undefined;
let agentWorkerInterval: NodeJS.Timeout | undefined;
let routineSchedulerInterval: NodeJS.Timeout | undefined;
let workflowCoordinatorInterval: NodeJS.Timeout | undefined;
let larkDocumentWatcherInterval: NodeJS.Timeout | undefined;
let memoryWrapupInterval: NodeJS.Timeout | undefined;
let larkHistoryImportInterval: NodeJS.Timeout | undefined;
let knowledgeEnrichmentInterval: NodeJS.Timeout | undefined;
let knowledgeRefreshInterval: NodeJS.Timeout | undefined;
let delegatedAgentTaskInterval: NodeJS.Timeout | undefined;
let agentWorkerPass: Promise<AgentWorkerPassResult> | undefined;
let startupRecoveryPass: Promise<void> | undefined;
let serverShuttingDown = false;
let agentWorkerPassCount = 0;
let agentWorkerLastPassAt: string | undefined;
let agentWorkerLastPassResult: AgentWorkerPassResult | undefined;
const threadConfigStore = new FileThreadConfigStore(path.join(dataDir, 'config'), {
  identity: {
    displayName: 'MaxTag',
    instructions:
      'You are MaxTag in a shared work thread. Keep progress visible and publish durable artifacts.',
    defaultExecutorId: managedExecutorSettings?.defaultExecutorId || 'codex',
  },
  workspace: {
    id: 'dev-workspace',
    name: 'Development Workspace',
    defaultProjectId: 'opentag',
  },
});
const threadStatusService = new ThreadStatusService({
  threadConfigStore,
  skillStore,
  delegatedAgentStore,
  knowledgeSourceStore,
  routineCommandService,
  deliveryStore,
});
const memoryAnalysisService = new MemoryAnalysisService({
  deliveryStore,
  memoryStore,
  threadConfigStore,
  executorRegistry: memoryAnalysisExecutorRegistry,
  executorId: memoryExecutorId,
  purposeExecutors: {
    memory_query: {
      executorRegistry: memoryQueryExecutorRegistry,
      executorId: memoryExecutorId,
    },
    memory_wrapup: {
      executorRegistry: memoryWrapupExecutorRegistry,
      executorId: memoryExecutorId,
    },
  },
  maxEntries: memoryAnalysisMaxEntries,
  maxChars: memoryAnalysisMaxChars,
  minConfidence: memoryAnalysisMinConfidence,
});
const larkHistoryImportService = new LarkHistoryImportService({
  deliveryStore,
  memoryAnalysisService,
  workerId: `${agentWorkerId}-lark-history`,
  enabled: larkHistoryImportEnabled,
  intervalWindowMs: larkHistoryImportWindowMs,
  windowsPerPass: larkHistoryImportWindowsPerPass,
  transport: () => {
    if (larkTransportStatus().mode !== 'http') return undefined;
    try {
      return larkResourceTransport();
    } catch {
      return undefined;
    }
  },
  botOpenId,
  onStatus: updateLarkHistoryImportStatusCard,
  onTerminal: async (job) => {
    if (job.cardMessageId) return;
    const platform = createPlatformForRun(job.thread).platform;
    const message = job.status === 'completed'
      ? `历史初始化完成：已扫描 ${job.scannedMessages} 条消息，导入 ${job.importedMessages} 条，生成 ${job.proposalIds.length} 条待审核记忆。管理员可在 MaxTag「记忆」页面批量审核。`
      : `历史初始化失败：${job.lastError || '未知错误'}。进度已保存，管理员可在 MaxTag 平台重试。`;
    await platform.sendMessage(job.thread, message);
  },
});
const memoryRetrievalService = new MemoryRetrievalService({
  executorRegistry: memoryRetrievalExecutorRegistry,
  deliveryStore,
  memoryStore,
  executorId: memoryExecutorId,
  enabled: memoryRetrievalEnabled,
  timeoutMs: memoryRetrievalTimeoutMs,
  maxCandidateLines: memoryRetrievalMaxCandidateLines,
  maxCandidateChars: memoryRetrievalMaxCandidateChars,
  maxSelectedLines: memoryRetrievalMaxSelectedLines,
  minConfidence: memoryRetrievalMinConfidence,
});
const memoryWrapupService = new MemoryWrapupService({
  deliveryStore,
  analysisService: memoryAnalysisService,
  workerId: `${agentWorkerId}-memory`,
  enabled: memoryWrapupEnabled,
  debounceMs: memoryWrapupDebounceMs,
  batchSize: memoryWrapupBatchSize,
  staleMs: memoryWrapupStaleMs,
  retryBaseMs: memoryWrapupRetryBaseMs,
  maxAttempts: memoryWrapupMaxAttempts,
  retentionMs: memoryWrapupRetentionMs,
  minEntries: memoryWrapupMinEntries,
  maxChars: memoryWrapupMaxChars,
  maxAgeMs: memoryWrapupMaxAgeMs,
  rawGraceMs: memoryWrapupRawGraceMs,
  autoApprove: async ({ proposal }) => {
    if (!memoryStore.approveMemoryProposal) {
      throw new Error('memory_proposals_unavailable');
    }
    return memoryStore.approveMemoryProposal({
      id: proposal.id,
      actorId: 'system:memory-wrapup',
      reason: 'Automatically approved a non-destructive Project fact from consolidated context.',
    });
  },
  onProposals: async ({ job, proposals }) => {
    if (job.thread.platform !== 'lark') return;
    const runPlatform = createPlatformForRun(job.thread);
    if (!runPlatform.larkAdapter) return;
    const sourceRun = await deliveryStore.getAgentRun(job.sourceRunId);
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
const knowledgeEnrichmentService = new KnowledgeEnrichmentService({
  store: knowledgeSourceStore,
  executorRegistry: knowledgeExecutorRegistry,
  executorId: knowledgeExecutorId,
  workerId: `${agentWorkerId}-knowledge`,
  enabled: knowledgeEnrichmentEnabled,
  batchSize: knowledgeEnrichmentBatchSize,
  leaseMs: optionalNumberEnvironmentValue(
    'OPENTAG_KNOWLEDGE_ENRICHMENT_LEASE_MS',
  ),
  retryBaseMs: optionalNumberEnvironmentValue(
    'OPENTAG_KNOWLEDGE_ENRICHMENT_RETRY_BASE_MS',
  ),
});
const knowledgeSourceRefreshService = new KnowledgeSourceRefreshService({
  store: knowledgeSourceRefreshStore,
  knowledgeStore: knowledgeSourceStore,
  workerId: `${agentWorkerId}-knowledge-refresh`,
  enabled: knowledgeRefreshEnabled,
  batchSize: knowledgeRefreshBatchSize,
  leaseMs: optionalNumberEnvironmentValue('OPENTAG_KNOWLEDGE_REFRESH_LEASE_MS'),
  retryBaseMs: optionalNumberEnvironmentValue('OPENTAG_KNOWLEDGE_REFRESH_RETRY_BASE_MS'),
  timeoutMs: optionalNumberEnvironmentValue('OPENTAG_KNOWLEDGE_REFRESH_TIMEOUT_MS'),
});
const delegatedAgentTaskService = new DelegatedAgentTaskService({
  store: delegatedAgentTaskStore,
  agentStore: delegatedAgentStore,
  skillStore,
  knowledgeStore: knowledgeSourceStore,
  memoryStore,
  threadConfigStore,
  deliveryStore,
  workerId: `${agentWorkerId}-agent-tasks`,
  enabled: delegatedAgentTasksEnabled,
  batchSize: optionalNumberEnvironmentValue(
    'OPENTAG_DELEGATED_AGENT_TASKS_BATCH_SIZE',
  ),
  leaseMs: optionalNumberEnvironmentValue('OPENTAG_DELEGATED_AGENT_TASKS_LEASE_MS'),
  retryBaseMs: optionalNumberEnvironmentValue(
    'OPENTAG_DELEGATED_AGENT_TASKS_RETRY_BASE_MS',
  ),
  resolveExecutor: (definition) => {
    if (definition.executorId !== 'codex' && definition.executorId !== 'claude') {
      return undefined;
    }
    if (
      managedExecutorSettings?.enabledExecutorIds &&
      !managedExecutorSettings.enabledExecutorIds.includes(definition.executorId)
    ) {
      return undefined;
    }
    return createDefaultExecutorRegistry(
      {
        mode: executorMode,
        workspaceRoot: executorWorkspaceRoot,
        timeoutMs: definition.timeoutMs,
        maxOutputBytes: executorMaxOutputBytes,
        inheritEnv: executorInheritEnv,
        sessionMode: 'transcript',
        codexCommand,
        codexCommandPrefixArgs,
        codexEnvironment,
        codexModel: definition.executorId === 'codex' ? definition.model : codexModel,
        codexAppServer: false,
        codexHome,
        codexAuthSourceHome,
        claudeCommand,
        claudeEnvironment,
        claudeModel: definition.executorId === 'claude' ? definition.model : claudeModel,
        claudeMaxBudgetUsd,
        defaultExecutorId: definition.executorId,
        enabledExecutorIds: managedExecutorSettings?.enabledExecutorIds,
      },
      toolBroker,
    ).get(definition.executorId);
  },
  onCompleted: async (task) => {
    const source = await deliveryStore.getAgentRun(task.parentRunId);
    if (!source?.thread) return undefined;
    const runId = `delegated-result:${task.id}`;
    const staged = await deliveryStore.createAgentRunOrSteer({
      runId,
      thread: source.thread,
      message: {
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
        actor: {
          id: `delegated:${task.agentId}`,
          displayName: task.agentId,
          isBot: true,
        },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
        metadata: {
          delegatedAgentTaskId: task.id,
          parentRunId: task.parentRunId,
        },
      },
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
    scheduleAgentWorkerPass();
    return staged.steering ? `steering:${staged.steering.id}` : staged.run.id;
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
    if (platform === 'slack') return `slack-${slackTransportStatus().mode}`;
    if (platform === 'github') return `github-${githubTransportStatus().mode}`;
    return 'tracked-text';
  },
  onRunQueued: () => scheduleAgentWorkerPass(),
  sendNotification: async (thread, notification) => {
    const runPlatform = createPlatformForRun(thread);
    await runPlatform.platform.sendMessage(thread, notification.message, [], {
      runId: notification.runId,
      stage: 'routine-notification',
      notificationId: notification.id,
    });
  },
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
    if (platform === 'slack') return `slack-${slackTransportStatus().mode}`;
    if (platform === 'github') return `github-${githubTransportStatus().mode}`;
    return platform === 'workflow' ? 'workflow-internal' : 'tracked-text';
  },
  onRunQueued: () => scheduleAgentWorkerPass(),
});
const larkDocumentWatcher = new LarkDocumentWatcherService({
  workflowStore,
  threadConfigStore,
  watcherId: `opentag-lark-documents-${process.pid}`,
  enabled: larkDocumentWatcherEnabled,
  available:
    Boolean(larkAppId && larkAppSecret) && larkTransportStatus().mode === 'http',
  claimStaleMs: larkDocumentWatcherClaimStaleMs,
  batchSize: larkDocumentWatcherBatchSize,
  request: (pathname, options) =>
    larkResourceTransport().openApiRequest(pathname, options),
});

const capabilityManifest = {
  product: 'MaxTag',
  principle: 'Lark first, not Lark only',
  workspaceBot: {
    status: 'partial',
    model: 'one workspace bot routes every client event into the same thread-agent runtime',
  },
  platforms: ['lark', 'telegram', 'github', 'slack', 'web'],
  executors: executorRegistry.list().map((runner) => `${runner.id}-${runner.mode}`),
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
      id: 'github',
      label: 'GitHub',
      status: 'ready',
      inbound: 'native comments + PR / issue / Actions webhooks',
      surface: 'editable issue/PR replies + project workflow producers',
      producers: ['pull_request', 'issues', 'workflow_run'],
    },
    {
      id: 'slack',
      label: 'Slack',
      status: 'ready',
      inbound: 'signed Events API callback',
      surface: 'editable progress message + thread reply + files',
    },
    {
      id: 'web',
      label: 'Web Assistant',
      status: 'ready',
      inbound: 'authenticated assistant session',
      surface: 'durable conversation + progress + files',
    },
  ],
  memoryScopes: [
    {
      id: 'global',
      label: 'Installation',
      status: 'ready',
      description: 'operator-controlled defaults, excluded from project runs by default',
    },
    {
      id: 'workspace',
      label: 'Workspace',
      status: 'ready',
      description: 'shared by projects using the workspace memory profile',
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
      opentag: 'shared client ingress plus native Lark, Telegram, Slack, GitHub comments, and Web Assistant adapters',
      status: 'ready',
    },
    {
      capability: 'Scoped memory',
      agentdock: 'session memory with async write queue',
      opentag: 'transactional global/workspace/project/channel/thread documents with immutable revisions and restore',
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
      opentag: 'durable thread transcript plus provider session resume and a single-flight follow-up mailbox across processes',
      status: 'ready',
    },
    {
      capability: 'Shared task steering',
      agentdock: 'active session input can steer the current runtime turn',
      opentag: 'Claude receives live stream input; Codex resumes the same provider session on the next durable turn',
      status: 'partial',
    },
    {
      capability: 'Reliable delivery',
      agentdock: 'SQLite outbox and turn delivery tracking',
      opentag: 'SQLite WAL outbox, turn delivery tracking, and cross-process claims',
      status: 'partial',
    },
    {
      capability: 'Files and artifacts',
      agentdock: 'inbound workspace files and outgoing file/image tools',
      opentag: 'isolated managed inputs, native Lark/Telegram transfer, durable artifact events, and authenticated downloads',
      status: 'ready',
    },
    {
      capability: 'Scoped tools',
      agentdock: 'runner MCP plugins and user-configured MCP servers',
      opentag: 'per-run MCP broker with resource allowlists, host credentials, validation, limits, and durable call audit',
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

const workflowEventCatalog = [
  ...GITHUB_WORKFLOW_EVENT_CATALOG,
  ...ALERTMANAGER_WORKFLOW_EVENT_CATALOG,
  ...LARK_DOCUMENT_WORKFLOW_EVENT_CATALOG,
];

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

interface KnowledgeIngressPrincipal {
  id: string;
  workspaceId: string;
  token: string;
}

function parseKnowledgeIngressPrincipals(
  raw: string | undefined,
): KnowledgeIngressPrincipal[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'OPENTAG_KNOWLEDGE_INGRESS_PRINCIPALS_JSON must be valid JSON.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      'OPENTAG_KNOWLEDGE_INGRESS_PRINCIPALS_JSON must be an array.',
    );
  }
  const principals = parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`knowledge_ingress_principal_${index}_invalid`);
    }
    const value = item as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const workspaceId =
      typeof value.workspaceId === 'string' ? value.workspaceId.trim() : '';
    const token = typeof value.token === 'string' ? value.token : '';
    if (!id || id.length > 120) {
      throw new Error(`knowledge_ingress_principal_${index}_id_invalid`);
    }
    if (
      !workspaceId || workspaceId.length > 160 ||
      !/^[a-zA-Z0-9_.:-]+$/u.test(workspaceId)
    ) {
      throw new Error(`knowledge_ingress_principal_${index}_workspace_invalid`);
    }
    if (token.length < 24) {
      throw new Error(`knowledge_ingress_principal_${index}_token_too_short`);
    }
    return { id, workspaceId, token };
  });
  if (new Set(principals.map(({ id }) => id)).size !== principals.length) {
    throw new Error('knowledge_ingress_principal_id_duplicate');
  }
  if (new Set(principals.map(({ token }) => token)).size !== principals.length) {
    throw new Error('knowledge_ingress_principal_token_duplicate');
  }
  return principals;
}

function authenticateKnowledgeIngress(
  request: IncomingMessage,
): KnowledgeIngressPrincipal | undefined {
  return knowledgeIngressPrincipals.find((principal) =>
    bearerTokenMatches(request, principal.token),
  );
}

function knowledgeEnrichmentResponse(
  job: Awaited<ReturnType<FileKnowledgeSourceStore['getEnrichment']>>,
): Record<string, unknown> | undefined {
  if (!job) return undefined;
  const { passages, dedupeHash: _dedupeHash, ...status } = job;
  return { ...status, passageCount: passages.length };
}

function knowledgeRefreshResponse(
  job: Awaited<ReturnType<FileKnowledgeSourceRefreshStore['get']>>,
): Record<string, unknown> | undefined {
  if (!job) return undefined;
  const { etag: _etag, lastModified: _lastModified, ...status } = job;
  return status;
}

function knowledgeSourceResponse(
  source: Awaited<ReturnType<FileKnowledgeSourceStore['get']>>,
): Record<string, unknown> | undefined {
  if (!source) return undefined;
  const { content: _content, ...summary } = source;
  return summary;
}

function delegatedAgentTaskResponse(
  task: DelegatedAgentTask,
): Record<string, unknown> {
  const { task: _task, ...summary } = task;
  return summary;
}

function executorStatus(): Record<string, unknown> {
  return {
    mode: executorMode,
    workspaceRoot: path.resolve(executorWorkspaceRoot),
    timeoutMs: executorTimeoutMs,
    maxOutputBytes: executorMaxOutputBytes,
    artifactRoot: path.resolve(executorArtifactRoot),
    maxArtifactBytes: executorMaxArtifactBytes,
    maxArtifacts: executorMaxArtifacts,
    sessionMode: executorSessionMode,
    sessionNamespace: executorSessionNamespace,
    transcriptMaxEntries,
    transcriptMaxChars,
    defaultExecutorId: executorRegistry.defaultExecutorId,
    registered: executorRegistry.list(),
    runControlPollMs,
    runHeartbeatMs: agentRunHeartbeatMs,
    memoryAnalysis: memoryAnalysisService.status(),
    memoryRetrieval: memoryRetrievalService.status(),
    memoryWrapup: {
      enabled: memoryWrapupService.enabled,
      running: memoryWrapupService.running,
    },
    knowledgeEnrichment: knowledgeEnrichmentService.status(),
    knowledgeRefresh: knowledgeSourceRefreshService.status(),
    delegatedAgentTasks: delegatedAgentTaskService.status(),
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
    credentialSource: managedLarkBotCredential ? 'managed' : hasCredentials ? 'environment' : 'none',
    domain: larkDomain,
    baseUrl: larkBaseUrl || undefined,
    verificationTokenConfigured: Boolean(larkVerificationToken),
    encryptionKeyConfigured: Boolean(larkEncryptKey),
    eventMode: larkEventMode,
    callbackMaxSkewSeconds: larkCallbackMaxSkewSeconds,
    callbackMaxBytes: larkCallbackMaxBytes,
    requireBinding: larkRequireBinding,
    onboardingMode: larkRequireBinding ? 'pairing-code' : 'add-bot-and-mention',
    threadHistoryMaxMessages: larkThreadHistoryMaxMessages,
    threadHistoryRetryMs: larkThreadHistoryRetryMs,
    chatInfoTimeoutMs: larkChatInfoTimeoutMs,
  };
}

async function larkReadinessSnapshot(): Promise<Record<string, unknown>> {
  const transport = larkTransportStatus() as {
    mode: 'memory' | 'http';
    hasCredentials: boolean;
    eventMode: 'webhook' | 'long-connection';
    verificationTokenConfigured: boolean;
    encryptionKeyConfigured: boolean;
    onboardingMode: string;
  };
  const executorReady = executorRegistry
    .list()
    .some((executor) => executor.status === 'ready' || executor.mode === 'local-cli');
  let bridgeReady = false;
  let bridgeStatus: number | undefined;
  if (transport.eventMode === 'long-connection') {
    const bridgePort = numberEnvironmentValue(
      'OPENTAG_LARK_BRIDGE_OBSERVABILITY_PORT',
      3080,
    );
    try {
      const bridgeResponse = await fetch(`http://127.0.0.1:${bridgePort}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      bridgeStatus = bridgeResponse.status;
      const body = bridgeResponse.ok
        ? (await bridgeResponse.json()) as Record<string, unknown>
        : {};
      bridgeReady = bridgeResponse.ok && body.ok !== false;
    } catch {
      bridgeReady = false;
    }
  }
  const ingressReady = transport.eventMode === 'long-connection'
    ? bridgeReady
    : transport.verificationTokenConfigured || transport.encryptionKeyConfigured;
  const cardActionsReady =
    transport.verificationTokenConfigured || transport.encryptionKeyConfigured;
  const ready =
    transport.mode === 'http' &&
    transport.hasCredentials &&
    ingressReady &&
    cardActionsReady &&
    executorReady &&
    transport.onboardingMode === 'add-bot-and-mention';
  return {
    ready,
    checkedAt: new Date().toISOString(),
    message: ready
      ? '飞书接入已就绪'
      : '请完成应用凭据、消息连接、卡片回调和真实执行器配置',
    credentialsReady: transport.hasCredentials && transport.mode === 'http',
    ingressReady,
    cardActionsReady,
    executorReady,
    onboardingReady: transport.onboardingMode === 'add-bot-and-mention',
    eventMode: transport.eventMode,
    bridgeReady,
    bridgeStatus,
  };
}

async function validateManagedLarkBotCredential(input: {
  appId: string;
  appSecret: string;
  domain: LarkOpenApiDomain;
  baseUrl?: string;
}): Promise<void> {
  const transport = new HttpLarkTransport(input);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      transport.readiness(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('lark_bot_connection_timeout')),
          10_000,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runExecutorProbe(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (value: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-64 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => finish({ code, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: null, stdout, stderr: 'executor_probe_timeout' });
    }, timeoutMs);
    timer.unref?.();
  });
}

function executorModelsEndpoint(provider: 'codex' | 'claude', baseUrl?: string): string {
  const root = (baseUrl ||
    (provider === 'codex'
      ? 'https://api.openai.com/v1'
      : 'https://api.anthropic.com')).replace(/\/+$/u, '');
  if (provider === 'codex') return `${root}/models`;
  return `${root.endsWith('/v1') ? root : `${root}/v1`}/models?limit=1`;
}

async function validateManagedExecutorCredential(input: {
  provider: 'codex' | 'claude';
  authMode: 'cli' | 'api-key';
  baseUrl?: string;
  apiKey?: string;
}): Promise<void> {
  const command = input.provider;
  let version;
  try {
    version = await runExecutorProbe(command, ['--version'], process.env, 5_000);
  } catch {
    throw new Error(`executor_${input.provider}_cli_not_installed`);
  }
  if (version.code !== 0) {
    throw new Error(`executor_${input.provider}_cli_not_installed`);
  }
  if (input.authMode === 'cli') {
    const args = input.provider === 'codex'
      ? ['doctor', '--json']
      : ['auth', 'status', '--json'];
    const status = await runExecutorProbe(command, args, process.env, 15_000);
    if (status.code !== 0) {
      throw new Error(`executor_${input.provider}_cli_not_authenticated`);
    }
    if (input.provider === 'codex') {
      try {
        const report = JSON.parse(status.stdout) as {
          checks?: Record<string, { status?: string }>;
        };
        if (report.checks?.['auth.credentials']?.status !== 'ok') {
          throw new Error('not_authenticated');
        }
      } catch {
        throw new Error('executor_codex_cli_not_authenticated');
      }
    }
    return;
  }
  if (!input.apiKey) throw new Error('executor_api_key_required');
  const headers: Record<string, string> = input.provider === 'codex'
    ? { authorization: `Bearer ${input.apiKey}` }
    : {
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
      };
  let response: Response;
  try {
    response = await fetch(executorModelsEndpoint(input.provider, input.baseUrl), {
      headers,
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error('executor_api_connection_failed');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('executor_api_key_rejected');
  }
  if (!response.ok) {
    throw new Error(`executor_api_connection_http_${response.status}`);
  }
}

async function executorInstallationStatus(): Promise<Record<string, unknown>> {
  const statuses = await Promise.all(
    (['codex', 'claude'] as const).map(async (provider) => {
      try {
        const result = await runExecutorProbe(provider, ['--version'], process.env, 5_000);
        return [provider, {
          installed: result.code === 0,
          version: result.code === 0
            ? (result.stdout || result.stderr).trim().slice(0, 160)
            : undefined,
        }] as const;
      } catch {
        return [provider, { installed: false }] as const;
      }
    }),
  );
  return Object.fromEntries(statuses);
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

function slackTransportStatus(): {
  requested: string;
  mode: 'memory' | 'http';
  hasToken: boolean;
  botUserId?: string;
  baseUrl?: string;
  signingSecretConfigured: boolean;
  callbackMaxSkewSeconds: number;
  callbackMaxBytes: number;
  workspaceId: string;
  requireBinding: boolean;
} {
  const requested = slackTransportMode;
  const hasToken = Boolean(slackBotToken);
  return {
    requested,
    mode:
      requested === 'http' || (requested === 'auto' && hasToken)
        ? 'http'
        : 'memory',
    hasToken,
    botUserId: slackBotUserId,
    baseUrl: slackBaseUrl || undefined,
    signingSecretConfigured: Boolean(slackSigningSecret),
    callbackMaxSkewSeconds: slackCallbackMaxSkewSeconds,
    callbackMaxBytes: slackCallbackMaxBytes,
    workspaceId: slackWorkspaceId,
    requireBinding: slackRequireBinding,
  };
}

function githubTransportStatus(): {
  requested: string;
  mode: 'memory' | 'http';
  hasToken: boolean;
  botLogin?: string;
  baseUrl?: string;
  webhookSecretConfigured: boolean;
  workspaceId: string;
  requireBinding: boolean;
  workflowProducers: {
    enabled: boolean;
    requireConfiguredBinding: true;
    eventFamilies: string[];
  };
} {
  const requested = githubTransportMode;
  const hasToken = Boolean(githubToken || githubAppTokenProvider);
  return {
    requested,
    mode:
      requested === 'http' || (requested === 'auto' && hasToken)
        ? 'http'
        : 'memory',
    hasToken,
    botLogin: githubBotLogin,
    baseUrl: githubBaseUrl || undefined,
    webhookSecretConfigured: Boolean(githubWebhookSecret),
    workspaceId: githubWorkspaceId,
    requireBinding: githubRequireBinding,
    workflowProducers: {
      enabled: workflowsEnabled && Boolean(githubWebhookSecret),
      requireConfiguredBinding: true,
      eventFamilies: ['pull_request', 'issues', 'workflow_run'],
    },
  };
}

async function readTextBody(
  request: IncomingMessage,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      request.resume();
      throw new ManagedContentError(
        'request_body_too_large',
        `Request body exceeds the ${maxBytes} byte limit.`,
        413,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes?: number,
): Promise<unknown> {
  const text = await readTextBody(request, maxBytes);
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

async function requireOperator(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<OperatorAuthentication | undefined> {
  const authentication = await operatorAuth.authenticate(request);
  if (!authentication.authenticated) {
    sendJson(
      response,
      401,
      { error: 'operator_auth_required' },
      {
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer realm="MaxTag operator"',
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

function requireInstallationOwner(
  response: ServerResponse,
  authentication: OperatorAuthentication,
): boolean {
  if (
    authentication.principal?.role === 'owner' &&
    authentication.principal.workspaceIds.includes('*')
  ) return true;
  sendJson(
    response,
    403,
    { error: 'installation_owner_required' },
    { 'cache-control': 'no-store' },
  );
  return false;
}

function requireOperatorOwner(
  response: ServerResponse,
  authentication: OperatorAuthentication,
): boolean {
  if (authentication.principal?.role === 'owner') return true;
  sendJson(
    response,
    403,
    { error: 'operator_owner_required' },
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

function alertmanagerIngressMode(): 'bearer' | 'disabled' {
  return alertmanagerIngressToken ? 'bearer' : 'disabled';
}

async function sendFileResponse(
  response: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  const content = await readFile(filePath);
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
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

function createGitHubTransportForRun(): {
  transport: GitHubTransport;
  dryRun?: MemoryGitHubTransport;
  mode: 'memory' | 'http';
} {
  const status = githubTransportStatus();
  if (status.mode === 'http') {
    if (!githubToken && !githubAppTokenProvider) {
      throw new Error(
        'OPENTAG_GITHUB_TRANSPORT=http requires a deployment token or GitHub App installation credentials.',
      );
    }
    return {
      mode: 'http',
      transport: new HttpGitHubTransport({
        token: githubToken,
        tokenProvider: githubAppTokenProvider,
        baseUrl: githubBaseUrl,
      }),
    };
  }

  const dryRun = new MemoryGitHubTransport();
  return { mode: 'memory', transport: dryRun, dryRun };
}

function createSlackTransportForRun(): {
  transport: SlackTransport;
  dryRun?: MemorySlackTransport;
  mode: 'memory' | 'http';
} {
  const status = slackTransportStatus();
  if (status.mode === 'http') {
    if (!slackBotToken) {
      throw new Error(
        'OPENTAG_SLACK_TRANSPORT=http requires OPENTAG_SLACK_BOT_TOKEN.',
      );
    }
    return {
      mode: 'http',
      transport: new HttpSlackTransport({
        botToken: slackBotToken,
        baseUrl: slackBaseUrl,
        maxUploadBytes: executorMaxArtifactBytes,
      }),
    };
  }
  const dryRun = new MemorySlackTransport();
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
    const larkTransport = createLarkTransportForRun();
    const larkAdapter = new LarkPlatformAdapter(
      new TrackedLarkTransport(larkTransport.transport, deliveryStore),
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

  if (thread.platform === 'github') {
    const githubTransport = createGitHubTransportForRun();
    return {
      platform: new GitHubPlatformAdapter(
        new TrackedGitHubTransport(githubTransport.transport, deliveryStore),
      ),
      transportMode: `github-${githubTransport.mode}`,
      githubDryRun: githubTransport.dryRun,
      githubTransport: { mode: githubTransport.mode },
    };
  }

  if (thread.platform === 'slack') {
    const slackTransport = createSlackTransportForRun();
    return {
      platform: new SlackPlatformAdapter(
        new TrackedSlackTransport(slackTransport.transport, deliveryStore),
      ),
      transportMode: `slack-${slackTransport.mode}`,
      slackDryRun: slackTransport.dryRun,
      slackTransport: { mode: slackTransport.mode },
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
      deliveryStore.summarize(workspaceId),
      deliveryStore.listOutbox({ limit, workspaceId }),
      deliveryStore.listTurnDeliveries({ limit, workspaceId }),
      deliveryStore.listThreadBindings(limit, workspaceId),
      deliveryStore.listInboundEvents({ limit, workspaceId }),
      deliveryStore.listAgentRunSteering({ limit, workspaceId }),
      deliveryStore.listAgentThreadSessions({ limit, workspaceId }),
    ]);
  return {
    workspaceId,
    summary,
    outbox: outbox.map(stripPayload),
    turnDeliveries,
    bindings,
    inboundEvents,
    steering,
    sessions,
  };
}

function webAssistantSessionId(binding: ThreadBinding): string {
  const configured = binding.metadata?.webAssistantSessionId;
  if (typeof configured === 'string' && configured) return configured;
  return binding.externalId.replace(/^assistant:/u, '');
}

function webAssistantThread(binding: ThreadBinding): SourceThread {
  const configuredThreadId = binding.metadata?.webAssistantThreadId;
  return {
    id:
      typeof configuredThreadId === 'string' && configuredThreadId
        ? configuredThreadId
        : `web:${binding.externalId}`,
    platform: 'web',
    externalId: binding.externalId,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    channelId:
      binding.channelId || `web:${binding.workspaceId}:${binding.projectId}`,
    title: binding.title || 'New conversation',
    visibility: 'private',
    metadata: {
      ...binding.metadata,
      bindingId: binding.id,
      bindingScope: binding.scope,
      bindingSource: binding.source,
      webAssistant: true,
    },
  };
}

function isWebAssistantBinding(binding: ThreadBinding): boolean {
  return (
    binding.platform === 'web' &&
    binding.scope === 'thread' &&
    binding.metadata?.webAssistant === true
  );
}

function webAssistantSessionSummary(
  binding: ThreadBinding,
  runs: AgentRunRecord[],
): Record<string, unknown> {
  const thread = webAssistantThread(binding);
  const threadRuns = runs.filter(
    (run) =>
      run.workspaceId === binding.workspaceId &&
      run.projectId === binding.projectId &&
      run.threadId === thread.id,
  );
  const activeRun = threadRuns.find((run) =>
    ['queued', 'running', 'cancel_requested'].includes(run.status),
  );
  return {
    id: webAssistantSessionId(binding),
    title: binding.title || 'New conversation',
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    threadId: thread.id,
    channelId: thread.channelId,
    createdAt: binding.createdAt,
    updatedAt: threadRuns[0]?.updatedAt || binding.updatedAt,
    runCount: threadRuns.length,
    activeRunId: activeRun?.id,
    activeRunStatus: activeRun?.status,
    preview:
      threadRuns[0]?.summary ||
      threadRuns[0]?.message?.text ||
      'No messages yet',
  };
}

async function webAssistantSessionSnapshot(
  binding: ThreadBinding,
): Promise<Record<string, unknown>> {
  const thread = webAssistantThread(binding);
  const [runs, transcript, timeline] = await Promise.all([
    deliveryStore.listAgentRuns({
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
      threadId: thread.id,
      limit: 200,
    }),
    deliveryStore.loadThreadTranscript({
      thread,
      maxEntries: 200,
      maxChars: 200_000,
    }),
    deliveryStore.listScopedAgentRunEvents({
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
      threadId: thread.id,
      limit: 2_000,
    }),
  ]);
  const artifactEntries = await Promise.all(
    runs.slice(0, 50).map(async (run) => ({
      runId: run.id,
      artifacts: await runArtifacts(run.id),
    })),
  );
  const activeRun = runs.find((run) =>
    ['queued', 'running', 'cancel_requested'].includes(run.status),
  );
  const orderedTimeline = timeline.sort((a, b) => a.sequence - b.sequence);
  const eventCursor = orderedTimeline.reduce(
    (highest, event) => Math.max(highest, event.sequence),
    0,
  );
  const activeDraft = activeRun
    ? orderedTimeline
        .filter(
          (event) =>
            event.runId === activeRun.id && event.type === 'text_delta',
        )
        .map((event) => event.message || '')
        .join('')
        .slice(0, 200_000)
    : '';
  return {
    session: webAssistantSessionSummary(binding, runs),
    thread,
    transcript,
    runs,
    artifacts: artifactEntries.flatMap(({ runId, artifacts }) =>
      artifacts.map((artifact) => ({ ...artifact, runId })),
    ),
    timeline: orderedTimeline
      .filter((event) =>
        [
          'progress',
          'tool_call',
          'tool_result',
          'tool_approval',
          'artifact',
          'memory_retrieval',
          'delegation',
        ].includes(event.type),
      )
      .map(safeAssistantRunEvent),
    eventCursor,
    drafts:
      activeRun && activeDraft ? { [activeRun.id]: activeDraft } : {},
    activeRun,
  };
}

function assistantStreamCursor(
  request: IncomingMessage,
  url: URL,
): number {
  const header = request.headers['last-event-id'];
  const raw =
    (Array.isArray(header) ? header[0] : header) ||
    url.searchParams.get('cursor') ||
    '0';
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeAssistantToolMetadata(
  event: ScopedAgentRunTimelineEvent,
): Record<string, unknown> | undefined {
  const key = event.type === 'tool_approval' ? 'approval' : 'call';
  const value = recordValue(event.metadata ?? {}, key);
  if (!value) return undefined;
  const tool: Record<string, unknown> = {};
  for (const field of [
    'id',
    'status',
    'name',
    'title',
    'grantKind',
    'risk',
    'source',
    'provider',
    'expiresAt',
  ]) {
    const selected = stringValue(value, field);
    if (selected) tool[field] = selected;
  }
  const durationMs = numberValue(value, 'durationMs');
  if (durationMs !== undefined) tool.durationMs = durationMs;
  return tool;
}

function safeAssistantRunEvent(
  event: ScopedAgentRunTimelineEvent,
): Record<string, unknown> {
  let message: string | undefined;
  let metadata: Record<string, unknown> | undefined;
  if (event.type === 'text_delta') {
    message = event.message?.slice(0, 20_000);
  } else if (event.type === 'progress') {
    const item = recordValue(event.metadata ?? {}, 'item');
    message = event.message?.slice(0, 2_000);
    metadata = item
      ? {
          item: {
            id: stringValue(item, 'id'),
            label: stringValue(item, 'label'),
            status: stringValue(item, 'status'),
          },
        }
      : undefined;
  } else if (
    event.type === 'tool_call' ||
    event.type === 'tool_result' ||
    event.type === 'tool_approval'
  ) {
    const tool = safeAssistantToolMetadata(event);
    const title = stringValue(tool ?? {}, 'title') || stringValue(tool ?? {}, 'name');
    const status = stringValue(tool ?? {}, 'status');
    message = [title || 'Tool', status].filter(Boolean).join(' / ');
    metadata = tool ? { tool } : undefined;
  } else if (event.type === 'artifact') {
    const artifact = recordValue(event.metadata ?? {}, 'artifact');
    if (artifact) {
      metadata = {
        artifact: {
          id: stringValue(artifact, 'id'),
          kind: stringValue(artifact, 'kind'),
          title: stringValue(artifact, 'title'),
        },
      };
      message = stringValue(artifact, 'title') || 'Artifact ready';
    }
  } else if (event.type === 'memory_retrieval') {
    metadata = {
      strategy: stringValue(event.metadata ?? {}, 'strategy'),
      candidateLines: numberValue(event.metadata ?? {}, 'candidateLines'),
      selectedLines: numberValue(event.metadata ?? {}, 'selectedLines'),
      durationMs: numberValue(event.metadata ?? {}, 'durationMs'),
    };
    message = 'Relevant memory selected';
  } else if (event.type === 'delegation') {
    const usageValue = recordValue(event.metadata ?? {}, 'usage');
    const usage: Record<string, number> = {};
    for (const field of ['runs', 'costUsd', 'inputTokens', 'outputTokens']) {
      const selected = numberValue(usageValue ?? {}, field);
      if (selected !== undefined) usage[field] = selected;
    }
    const agentId = (stringValue(event.metadata ?? {}, 'agentId') || '').slice(0, 120);
    const status = (stringValue(event.metadata ?? {}, 'status') || '').slice(0, 32);
    metadata = {
      invocationId: (stringValue(event.metadata ?? {}, 'invocationId') || '').slice(0, 160),
      agentId,
      executorId: (stringValue(event.metadata ?? {}, 'executorId') || '').slice(0, 120),
      status,
      taskPreview: (stringValue(event.metadata ?? {}, 'taskPreview') || '').slice(0, 180),
      summaryPreview: (stringValue(event.metadata ?? {}, 'summaryPreview') || '').slice(0, 300),
      ...(Object.keys(usage).length ? { usage } : {}),
    };
    message = `${agentId || 'Agent'} / ${status || 'delegated'}`;
  } else if (event.type === 'completed') {
    message = event.message?.slice(0, 20_000) || 'Run completed';
  } else if (event.type === 'failed') {
    message = 'Run failed';
  } else if (event.type === 'cancelled') {
    message = 'Run cancelled';
  } else if (event.type === 'cancel_requested') {
    message = 'Cancellation requested';
  } else if (event.type === 'log') {
    message = 'Runtime status updated';
    metadata = { level: stringValue(event.metadata ?? {}, 'level') };
  } else {
    message = event.type.replaceAll('_', ' ');
  }
  return {
    id: event.id,
    sequence: event.sequence,
    runId: event.runId,
    type: event.type,
    at: event.at,
    runStatus: event.runStatus,
    message,
    metadata,
  };
}

function writeAssistantSse(
  response: ServerResponse,
  event: string,
  data: Record<string, unknown>,
  id?: number,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamWebAssistantEvents(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  binding: ThreadBinding;
}): Promise<void> {
  const { request, response, url, binding } = input;
  const thread = webAssistantThread(binding);
  let cursor = assistantStreamCursor(request, url);
  let closed = false;
  let lastHeartbeatAt = Date.now();
  const close = () => {
    closed = true;
  };
  request.once('close', close);
  response.once('close', close);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  response.write('retry: 1000\n\n');
  activeAssistantStreams.add(response);
  try {
    const snapshot = await webAssistantSessionSnapshot(binding);
    writeAssistantSse(response, 'assistant_ready', {
      cursor,
      session: snapshot.session,
    });
    while (!closed && !serverShuttingDown) {
      const events = await deliveryStore.listScopedAgentRunEvents({
        workspaceId: binding.workspaceId,
        projectId: binding.projectId,
        threadId: thread.id,
        limit: 2_000,
      });
      for (const event of events
        .filter((candidate) => candidate.sequence > cursor)
        .sort((a, b) => a.sequence - b.sequence)) {
        writeAssistantSse(
          response,
          'run_event',
          { event: safeAssistantRunEvent(event) },
          event.sequence,
        );
        cursor = event.sequence;
      }
      if (Date.now() - lastHeartbeatAt >= 15_000) {
        response.write(`: heartbeat ${Date.now()}\n\n`);
        lastHeartbeatAt = Date.now();
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, assistantStreamPollMs);
        timer.unref?.();
      });
    }
  } catch {
    writeAssistantSse(response, 'stream_error', {
      error: 'assistant_stream_unavailable',
    });
  } finally {
    activeAssistantStreams.delete(response);
    request.removeListener('close', close);
    response.removeListener('close', close);
    if (!response.writableEnded) response.end();
  }
}

async function workspaceSnapshot(
  workspaceId = 'dev-workspace',
): Promise<Record<string, unknown>> {
  const [
    workspacePolicies,
    projects,
    bindings,
    channelPolicies,
    recentRuns,
    audit,
    routines,
    access,
    managedConnectors,
    capabilityBundles,
  ] =
    await Promise.all([
      threadConfigStore.listWorkspacePolicies(),
      threadConfigStore.listProjectPolicies(workspaceId),
      deliveryStore.listThreadBindings(500),
      threadConfigStore.listChannelPolicies(workspaceId),
      deliveryStore.listAgentRuns({ workspaceId, limit: 500 }),
      threadConfigStore.listAudit(25, workspaceId),
      routineStore.summarize(workspaceId),
      accessStore.snapshot(workspaceId, 10),
      managedConnectorStore.list(
        externalMcpRegistry?.servers.map((server) => server.id) ?? [],
      ),
      threadConfigStore.listCapabilityBundles(workspaceId),
    ]);
  const managedConnectorById = new Map(
    managedConnectors.map((connector) => [connector.id, connector]),
  );
  const workspacePolicy =
    workspacePolicies.find((item) => item.workspace.id === workspaceId);
  return {
    workspace: workspacePolicy,
    capabilityBundles: capabilityBundles.map((bundle) => ({
      ...bundle,
      assignedProjectCount: projects.filter(
        (project) =>
          project.capabilityMode === 'custom' &&
          project.bundleIds.includes(bundle.id),
      ).length,
      assignedChannelCount: channelPolicies.filter(
        (channel) =>
          channel.capabilityMode !== 'inherit' &&
          channel.bundleIds.includes(bundle.id),
      ).length,
    })),
    projects: projects.map((project) => {
      const effectiveBundleIds =
        project.capabilityMode === 'inherit'
          ? workspacePolicy?.bundleIds ?? []
          : project.bundleIds;
      const bundleGrants = capabilityBundles
        .filter(
          (bundle) => bundle.enabled && effectiveBundleIds.includes(bundle.id),
        )
        .flatMap((bundle) => bundle.grants);
      const effectiveGrants =
        project.capabilityMode === 'inherit'
          ? [...(workspacePolicy?.grants ?? []), ...bundleGrants]
          : [...project.grants, ...bundleGrants];
      const matchesProject = (value?: string): boolean =>
        value === project.projectId || value === project.id;
      const projectBindings = bindings.filter(
        (binding) =>
          binding.workspaceId === project.workspaceId &&
          matchesProject(binding.projectId),
      );
      const projectChannelPolicies = channelPolicies.filter(
        (policy) =>
          policy.workspaceId === project.workspaceId &&
          matchesProject(policy.projectId),
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
        channelPolicyCount: projectChannelPolicies.length,
        runSummary,
        lastRunAt: projectRuns[0]?.updatedAt,
        accessMode: accessPolicy?.mode ?? 'open',
        memberCount: projectMembers.length,
        toolCount: effectiveGrants.reduce(
          (total, grant) => {
            const entry = toolCatalog.find(
              (candidate) => candidate.grantKind === grant.kind,
            );
          if (!entry) return total;
          const writeEnabled = Array.isArray(grant.constraints?.permissions)
            ? grant.constraints.permissions.includes('write')
            : grant.kind === 'shell';
          const unavailableCommandTools =
            grant.kind === 'shell' &&
            !(
              Array.isArray(grant.constraints?.commands) &&
              grant.constraints.commands.some(
                (command) =>
                  command === '*' ||
                  (typeof command === 'string' &&
                    /^[a-zA-Z0-9_.+-]+$/u.test(command)),
              )
            )
              ? 1
              : 0;
          return (
            total +
            entry.toolCount -
            (writeEnabled ? 0 : entry.writeToolCount ?? 0) -
            unavailableCommandTools
          );
          },
          0,
        ),
      };
    }),
    channelPolicies,
    accessSummary: {
      members: access.members.length,
      activeMembers: access.members.filter((member) => member.status === 'active')
        .length,
      managedProjects: access.projectPolicies.filter(
        (policy) => policy.mode !== 'open',
      ).length,
    },
    availableTools: toolCatalog.map((tool) => ({
      id: tool.grantKind,
      label: tool.label,
      description: tool.description,
      toolCount: tool.toolCount,
      readToolCount: tool.toolCount - (tool.writeToolCount ?? 0),
      writeToolCount: tool.writeToolCount ?? 0,
      constraints: tool.constraints,
      tools: tool.tools,
      providerStatus:
        tool.grantKind.startsWith('mcp:') &&
        managedConnectorById.get(tool.grantKind.slice(4))?.enabled === false
          ? 'disabled'
          : tool.providerStatus ??
        (tool.grantKind === 'lark-docs' || tool.grantKind === 'lark-base'
          ? larkAppId && larkAppSecret && larkTransportStatus().mode === 'http'
            ? 'ready'
            : 'credentials-required'
          : tool.grantKind === 'github'
            ? githubToken || githubAppTokenProvider
              ? 'ready'
              : 'public-only'
            : 'ready'),
    })),
    executors: executorRegistry.list(),
    audit,
    routines,
  };
}

async function managedConnectorsSnapshot(
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const servers = externalMcpRegistry?.servers ?? [];
  const [states, workspacePolicies, projects] = await Promise.all([
    managedConnectorStore.list(servers.map((server) => server.id)),
    threadConfigStore.listWorkspacePolicies(),
    threadConfigStore.listProjectPolicies(workspaceId),
  ]);
  const stateById = new Map(states.map((state) => [state.id, state]));
  const workspacePolicy = workspacePolicies.find(
    (policy) => policy.workspace.id === workspaceId,
  );
  return {
    workspaceId,
    definitionSource: 'deployment',
    connectors: servers.map((server) => {
      const state = stateById.get(server.id) ?? {
        id: server.id,
        enabled: true,
        revision: 0,
      };
      const grantKind = `mcp:${server.id}`;
      const assignedProjects = projects
        .filter((project) => {
          const grants =
            project.capabilityMode === 'inherit'
              ? workspacePolicy?.grants ?? []
              : project.grants;
          return grants.some((grant) => grant.kind === grantKind);
        })
        .map((project) => project.projectId);
      return {
        id: server.id,
        grantKind,
        label: server.label,
        description:
          server.description ||
          'Deployment-approved MCP server governed by MaxTag policy and approvals.',
        enabled: state.enabled,
        revision: state.revision,
        updatedAt: state.updatedAt,
        credentialsAvailable: externalMcpRegistry?.credentialsAvailable(server.id),
        requiredSecretCount: Object.keys(server.envRefs).length,
        tools: server.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          risk: tool.risk,
        })),
        assignedProjectCount: assignedProjects.length,
        assignedProjects,
        lastCheck: state.lastCheck,
      };
    }),
  };
}

async function toolCredentialIdentitiesSnapshot(input: {
  includeEnvRefs: boolean;
}): Promise<Record<string, unknown>> {
  const configured = await toolCredentialIdentityStore.list();
  const identities = await availableToolCredentialIdentities();
  const configuredById = new Map(configured.map((identity) => [identity.id, identity]));
  return {
    identities: identities.map((identity) => {
      const stored = configuredById.get(identity.id);
      return {
        ...identity,
        ...(input.includeEnvRefs && stored
          ? {
              envRefs: { ...stored.envRefs },
              baseUrl: stored.baseUrl,
            }
          : {}),
      };
    }),
  };
}

async function agentSkillsSnapshot(
  workspaceId: string,
  includeAudit = false,
): Promise<Record<string, unknown>> {
  const [skills, workspaces, projects, channels, audit] = await Promise.all([
    skillStore.list({ includeDisabled: true }),
    threadConfigStore.listWorkspacePolicies(),
    threadConfigStore.listProjectPolicies(workspaceId),
    threadConfigStore.listChannelPolicies(workspaceId),
    includeAudit ? skillStore.listAudit(200) : Promise.resolve([]),
  ]);
  const workspace = workspaces.find(
    (policy) => policy.workspace.id === workspaceId,
  );
  return {
    workspaceId,
    catalogScope: 'installation',
    canManageCatalog: includeAudit,
    skills: skills.map(({ content: _content, createdAt, ...skill }) => {
      const assignedProjects = projects
        .filter((project) => project.skillIds.includes(skill.id))
        .map((project) => project.projectId);
      const assignedChannels = channels.filter((channel) =>
        channel.skillIds.includes(skill.id),
      );
      return {
        ...skill,
        assignedWorkspace: Boolean(workspace?.skillIds.includes(skill.id)),
        assignedProjectCount: assignedProjects.length,
        assignedProjects,
        assignedChannelCount: assignedChannels.length,
      };
    }),
    ...(includeAudit ? { audit } : {}),
  };
}

async function delegatedAgentsSnapshot(
  workspaceId: string,
  includeAudit = false,
): Promise<Record<string, unknown>> {
  const [agents, workspaces, projects, channels, audit, tasks] = await Promise.all([
    delegatedAgentStore.list({ includeDisabled: true }),
    threadConfigStore.listWorkspacePolicies(),
    threadConfigStore.listProjectPolicies(workspaceId),
    threadConfigStore.listChannelPolicies(workspaceId),
    includeAudit ? delegatedAgentStore.listAudit(200) : Promise.resolve([]),
    delegatedAgentTaskStore.list({ workspaceId, limit: 100 }),
  ]);
  const workspace = workspaces.find(
    (policy) => policy.workspace.id === workspaceId,
  );
  const grantCatalog = [
    ...new Map(
      toolCatalog
        .filter(
          (tool) =>
            tool.grantKind !== 'agents' &&
            tool.grantKind !== 'skills' &&
            tool.grantKind !== 'memory',
        )
        .map((tool) => [tool.grantKind, tool]),
    ).values(),
  ];
  return {
    workspaceId,
    catalogScope: 'installation',
    canManageCatalog: includeAudit,
    executors: executorRegistry
      .list()
      .filter((executor) => executor.id === 'codex' || executor.id === 'claude')
      .map(({ id, label }) => ({ id, label })),
    grantCatalog: grantCatalog
      .map(({ grantKind: kind, label, description }) => ({
        kind,
        label,
        description,
      })),
    agents: agents.map(
      ({
        instructions: _instructions,
        model: _model,
        skillIds: _skillIds,
        grantKinds: _grantKinds,
        memoryScopes: _memoryScopes,
        networkHosts: _networkHosts,
        createdAt: _createdAt,
        ...agent
      }) => {
        const assignedProjects = projects
          .filter((project) => project.agentIds.includes(agent.id))
          .map((project) => project.projectId);
        const assignedChannels = channels.filter((channel) =>
          channel.agentIds.includes(agent.id),
        );
        return {
          ...agent,
          assignedWorkspace: Boolean(workspace?.agentIds.includes(agent.id)),
          assignedProjectCount: assignedProjects.length,
          assignedProjects,
          assignedChannelCount: assignedChannels.length,
        };
      },
    ),
    tasks: tasks.map(delegatedAgentTaskResponse),
    ...(includeAudit ? { audit } : {}),
  };
}

async function knowledgeSourcesSnapshot(
  workspaceId: string,
  includeAudit = false,
): Promise<Record<string, unknown>> {
  const [sources, workspaces, projects, channels, audit, enrichments, refreshJobs] = await Promise.all([
    knowledgeSourceStore.list({ workspaceId, includeDisabled: true }),
    threadConfigStore.listWorkspacePolicies(),
    threadConfigStore.listProjectPolicies(workspaceId),
    threadConfigStore.listChannelPolicies(workspaceId),
    includeAudit
      ? knowledgeSourceStore.listAudit(workspaceId, 200)
      : Promise.resolve([]),
    knowledgeSourceStore.listEnrichments({ workspaceId, limit: 500 }),
    knowledgeSourceRefreshStore.list({ workspaceId, limit: 500 }),
  ]);
  const workspace = workspaces.find(
    (policy) => policy.workspace.id === workspaceId,
  );
  return {
    workspaceId,
    catalogScope: 'workspace',
    canManageCatalog: includeAudit,
    sources: sources.map(({ content: _content, createdAt: _createdAt, ...source }) => {
      const enrichment = enrichments.find((job) =>
        job.sourceId === source.id && job.sourceRevision === source.revision &&
        job.contentHash === source.contentHash,
      );
      const refresh = refreshJobs.find((job) => job.sourceId === source.id);
      const assignedProjects = projects
        .filter((project) => project.knowledgeSourceIds.includes(source.id))
        .map((project) => project.projectId);
      const assignedChannels = channels.filter((channel) =>
        channel.knowledgeSourceIds.includes(source.id),
      );
      return {
        ...source,
        assignedWorkspace: Boolean(
          workspace?.knowledgeSourceIds.includes(source.id),
        ),
        assignedProjectCount: assignedProjects.length,
        assignedProjects,
        assignedChannelCount: assignedChannels.length,
        enrichmentStatus: enrichment?.status,
        semanticPassageCount: enrichment?.passages.length ?? 0,
        refresh: knowledgeRefreshResponse(refresh),
        nextRefreshAt: knowledgeSourceNextRefreshAt(source, refreshJobs),
        enrichmentUpdatedAt: enrichment?.updatedAt,
      };
    }),
    ...(includeAudit ? { audit } : {}),
  };
}

function spendUsageLine(
  totals: UsageBudgetLine[],
  scope: UsageBudgetLine['scope'],
  input: { workspaceId: string; projectId?: string; channelId?: string },
): UsageBudgetLine {
  return (
    totals.find(
      (line) =>
        line.scope === scope &&
        line.workspaceId === input.workspaceId &&
        (scope === 'workspace' || line.projectId === input.projectId) &&
        (scope !== 'channel' || line.channelId === input.channelId),
    ) ?? {
      scope,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      channelId: input.channelId,
      period: new Date().toISOString().slice(0, 7),
      runs: 0,
      costUsd: 0,
    }
  );
}

function spendUtilization(
  policy: UsageBudgetPolicy | undefined,
  usage: UsageBudgetLine,
): { runs?: number; cost?: number; highest?: number } {
  if (!policy || policy.mode !== 'custom') return {};
  const runs =
    typeof policy.maxRunsPerMonth === 'number' && policy.maxRunsPerMonth > 0
      ? usage.runs / policy.maxRunsPerMonth
      : undefined;
  const cost =
    typeof policy.maxCostUsdPerMonth === 'number' &&
    policy.maxCostUsdPerMonth > 0
      ? usage.costUsd / policy.maxCostUsdPerMonth
      : undefined;
  const values = [runs, cost].filter(
    (value): value is number => typeof value === 'number',
  );
  return { runs, cost, highest: values.length ? Math.max(...values) : undefined };
}

async function spendSnapshot(
  workspaceId: string,
  period?: string,
): Promise<Record<string, unknown>> {
  const [workspacePolicies, projects, channelPolicies, bindings, usage] =
    await Promise.all([
      threadConfigStore.listWorkspacePolicies(),
      threadConfigStore.listProjectPolicies(workspaceId),
      threadConfigStore.listChannelPolicies(workspaceId),
      deliveryStore.listThreadBindings(2_000, workspaceId),
      deliveryStore.usageSnapshot({ workspaceId, period, limit: 1_000 }),
    ]);
  const workspace = workspacePolicies.find(
    (policy) => policy.workspace.id === workspaceId,
  );
  const workspaceUsage = spendUsageLine(usage.totals, 'workspace', {
    workspaceId,
  });
  const projectRows = projects.map((project) => {
    const line = spendUsageLine(usage.totals, 'project', {
      workspaceId,
      projectId: project.projectId,
    });
    return {
      workspaceId,
      projectId: project.projectId,
      name: project.name,
      policy: project.budgetPolicy ?? { mode: 'inherit' },
      usage: line,
      utilization: spendUtilization(project.budgetPolicy, line),
    };
  });
  const channelRows = new Map<string, Record<string, unknown>>();
  let legacyChannels = 0;
  for (const item of [...bindings, ...channelPolicies]) {
    const routeProjectId = item.projectId;
    const platform = item.platform;
    const channelId = item.channelId || ('externalId' in item ? item.externalId : '');
    if (!routeProjectId || !channelId) continue;
    const project = projects.find(
      (candidate) =>
        candidate.projectId === routeProjectId || candidate.id === routeProjectId,
    );
    if (!project) {
      legacyChannels += 1;
      continue;
    }
    const projectId = project.projectId;
    const key = `${projectId}:${platform}:${channelId}`;
    const binding = bindings.find(
      (candidate) =>
        (candidate.projectId === projectId || candidate.projectId === project.id) &&
        candidate.platform === platform &&
        (candidate.channelId || candidate.externalId) === channelId,
    );
    const channelPolicy = channelPolicies.find(
      (candidate) =>
        (candidate.projectId === projectId || candidate.projectId === project.id) &&
        candidate.platform === platform &&
        candidate.channelId === channelId,
    );
    const configuredPolicy = channelPolicy?.budgetPolicy ?? { mode: 'inherit' as const };
    const inheritedDefault =
      project?.defaultChannelBudgetPolicy?.mode === 'custom'
        ? project.defaultChannelBudgetPolicy
        : project?.defaultChannelBudgetPolicy?.mode === 'disabled'
          ? undefined
          : workspace?.defaultChannelBudgetPolicy?.mode === 'custom'
            ? workspace.defaultChannelBudgetPolicy
            : undefined;
    const effectivePolicy =
      configuredPolicy.mode === 'custom'
        ? configuredPolicy
        : configuredPolicy.mode === 'disabled'
          ? undefined
          : inheritedDefault;
    const line = spendUsageLine(usage.totals, 'channel', {
      workspaceId,
      projectId,
      channelId,
    });
    channelRows.set(key, {
      workspaceId,
      projectId,
      projectName: project?.name ?? projectId,
      platform,
      channelId,
      title: channelPolicy?.title || binding?.title || channelId,
      policy: configuredPolicy,
      effectivePolicy,
      policySource:
        configuredPolicy.mode === 'custom'
          ? 'channel'
          : effectivePolicy
            ? project?.defaultChannelBudgetPolicy?.mode === 'custom'
              ? 'project-default'
              : 'workspace-default'
            : 'none',
      usage: line,
      utilization: spendUtilization(effectivePolicy, line),
    });
  }
  return {
    period: usage.period,
    workspace: {
      workspaceId,
      name: workspace?.workspace.name ?? workspaceId,
      policy: workspace?.budgetPolicy ?? { mode: 'disabled' },
      defaultChannelPolicy:
        workspace?.defaultChannelBudgetPolicy ?? { mode: 'disabled' },
      usage: workspaceUsage,
      utilization: spendUtilization(workspace?.budgetPolicy, workspaceUsage),
    },
    projects: projectRows,
    channels: [...channelRows.values()].sort((a, b) =>
      String(a.title).localeCompare(String(b.title)),
    ),
    purposes: usage.purposeTotals,
    alerts: usage.alerts,
    coverage: {
      records: usage.recordCount,
      costReported: usage.costReportedRecords,
      tokensReported: usage.tokenReportedRecords,
      detailTruncated: usage.recordCount > usage.records.length,
      legacyChannels,
    },
  };
}

type OrganizationAuditCategory =
  | 'task'
  | 'agent'
  | 'tool'
  | 'policy'
  | 'knowledge'
  | 'access'
  | 'binding'
  | 'routine'
  | 'workflow';

interface OrganizationAuditEntry {
  id: string;
  source:
    | 'run'
    | 'config'
    | 'access'
    | 'binding'
    | 'routine'
    | 'workflow'
    | 'connector'
    | 'operator_credential'
    | 'tool_identity'
    | 'lifecycle'
    | 'skill'
    | 'knowledge'
    | 'agent';
  category: OrganizationAuditCategory;
  action: string;
  outcome: 'started' | 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'changed';
  actor: string;
  at: string;
  workspaceId: string;
  projectId?: string;
  channelId?: string;
  threadId?: string;
  platform?: string;
  summary: string;
  referenceId?: string;
  runId?: string;
  toolSource?: string;
  toolProvider?: string;
  destination?: string;
  resultUrl?: string;
  agentIdentityId?: string;
  credentialIdentityId?: string;
  credentialIdentityRevision?: number;
  externalActor?: string;
  tool?: {
    name?: string;
    title?: string;
    grantKind?: string;
    risk?: string;
    source?: string;
    provider?: string;
    destination?: string;
    resultUrl?: string;
    agentIdentityId?: string;
    credentialIdentityId?: string;
    credentialIdentityRevision?: number;
    externalActor?: string;
    argumentKeys?: string[];
    durationMs?: number;
  };
}

function auditOutcomeForRunEvent(
  event: ScopedAgentRunTimelineEvent,
): OrganizationAuditEntry['outcome'] {
  if (event.type === 'failed') return 'failed';
  if (event.type === 'human_takeover') return 'changed';
  if (event.type === 'cancelled' || event.type === 'cancel_requested') {
    return 'cancelled';
  }
  if (event.type === 'usage_budget_denied') return 'denied';
  if (event.type === 'created' || event.type === 'started') return 'started';
  if (event.type === 'tool_call') return 'started';
  if (event.type === 'tool_result') {
    const call = recordValue(event.metadata ?? {}, 'call');
    const status = stringValue(call ?? {}, 'status');
    if (status === 'pending_approval') return 'started';
    return status === 'failed'
      ? 'failed'
      : status === 'denied'
        ? 'denied'
        : 'succeeded';
  }
  if (event.type === 'tool_approval') {
    const approval = recordValue(event.metadata ?? {}, 'approval');
    const status = stringValue(approval ?? {}, 'status');
    if (status === 'succeeded') return 'succeeded';
    if (status === 'failed') return 'failed';
    if (status === 'rejected') return 'denied';
    if (status === 'expired') return 'cancelled';
    return 'started';
  }
  if (event.type === 'delegation') {
    const status = stringValue(event.metadata ?? {}, 'status');
    if (status === 'running') return 'started';
    if (status === 'failed') return 'failed';
  }
  return 'succeeded';
}

function auditSummaryForRunEvent(
  event: ScopedAgentRunTimelineEvent,
  tool?: OrganizationAuditEntry['tool'],
): string {
  const toolLabel = tool?.title || tool?.name || 'Tool';
  switch (event.type) {
    case 'created':
      return 'Agent run created';
    case 'started':
      return 'Agent run started';
    case 'completed':
      return 'Agent run completed';
    case 'failed':
      return 'Agent run failed';
    case 'human_takeover':
      return 'Human took over the task';
    case 'cancel_requested':
      return 'Agent run cancellation requested';
    case 'cancelled':
      return 'Agent run cancelled';
    case 'usage_budget_denied':
      return 'Usage budget denied the run';
    case 'usage_threshold_alert':
      return 'Usage threshold alert emitted';
    case 'thread_status':
      return 'Thread capability status inspected';
    case 'tool_call':
      return `${toolLabel} requested`;
    case 'tool_approval':
      return `${toolLabel} approval ${stringValue(recordValue(event.metadata ?? {}, 'approval') ?? {}, 'status') || 'recorded'}`;
    case 'tool_result':
      return tool?.name &&
        stringValue(recordValue(event.metadata ?? {}, 'call') ?? {}, 'status') ===
          'pending_approval'
        ? `${toolLabel} is waiting for approval`
        : `${toolLabel} finished`;
    case 'delegation': {
      const metadata = event.metadata ?? {};
      const agentId = stringValue(metadata, 'agentId', 'Agent');
      const status = stringValue(metadata, 'status', 'recorded');
      return `${agentId} delegation ${status}`;
    }
  }
  return 'Agent run event recorded';
}

function auditDestination(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  const mcp = /^mcp\+stdio:\/\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/u.exec(
    candidate.toLowerCase(),
  );
  if (mcp) return `mcp+stdio://${mcp[1]}`;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password
    ) return undefined;
    return url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function auditResultUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 2_048) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    if (
      [...url.searchParams.keys()].some((key) =>
        /(?:^|[_-])(token|secret|password|credential|signature|api[_-]?key|auth)(?:$|[_-])/iu.test(
          key,
        ),
      )
    ) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function organizationRunAuditEntry(
  workspaceId: string,
  event: ScopedAgentRunTimelineEvent,
): OrganizationAuditEntry {
  const call =
    recordValue(event.metadata ?? {}, 'call') ??
    recordValue(event.metadata ?? {}, 'approval');
  const callArguments = call ? recordValue(call, 'arguments') : undefined;
  const toolSource = call ? stringValue(call, 'source') : undefined;
  const tool = call
    ? {
        name: stringValue(call, 'name'),
        title: stringValue(call, 'title'),
        grantKind: stringValue(call, 'grantKind'),
        risk: stringValue(call, 'risk'),
        source: toolSource,
        provider: stringValue(call, 'provider'),
        destination:
          toolSource === 'broker'
            ? auditDestination(stringValue(call, 'destination'))
            : undefined,
        resultUrl:
          toolSource === 'broker'
            ? auditResultUrl(stringValue(call, 'resultUrl'))
            : undefined,
        agentIdentityId: stringValue(call, 'agentIdentityId'),
        credentialIdentityId: stringValue(call, 'credentialIdentityId'),
        credentialIdentityRevision: numberValue(
          call,
          'credentialIdentityRevision',
        ),
        externalActor: stringValue(call, 'externalActor'),
        argumentKeys: callArguments ? Object.keys(callArguments).sort() : undefined,
        durationMs: numberValue(call, 'durationMs'),
      }
    : undefined;
  return {
    id: `run:${event.id}`,
    source: 'run',
    category:
      event.type === 'tool_call' ||
      event.type === 'tool_approval' ||
      event.type === 'tool_result'
        ? 'tool'
        : event.type === 'delegation'
          ? 'agent'
        : 'task',
    action: event.type === 'tool_call' || event.type === 'tool_approval' || event.type === 'tool_result'
      ? tool?.name || event.type
      : event.type,
    outcome: auditOutcomeForRunEvent(event),
    actor: event.actorId ? `${event.platform}:${event.actorId}` : 'system',
    at: event.at,
    workspaceId,
    projectId: event.projectId,
    channelId: event.channelId,
    threadId: event.threadId,
    platform: event.platform,
    summary: auditSummaryForRunEvent(event, tool),
    referenceId: event.id,
    runId: event.runId,
    toolSource: tool?.source,
    toolProvider: tool?.provider,
    destination: tool?.destination,
    resultUrl: tool?.resultUrl,
    agentIdentityId: tool?.agentIdentityId,
    credentialIdentityId: tool?.credentialIdentityId,
    credentialIdentityRevision: tool?.credentialIdentityRevision,
    externalActor: tool?.externalActor,
    tool,
  };
}

function csvField(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function organizationAuditCsv(entries: OrganizationAuditEntry[]): string {
  const keys = [
    'at',
    'source',
    'category',
    'action',
    'outcome',
    'actor',
    'workspaceId',
    'projectId',
    'channelId',
    'threadId',
    'platform',
    'summary',
    'referenceId',
    'runId',
    'toolSource',
    'toolProvider',
    'destination',
    'resultUrl',
    'agentIdentityId',
    'credentialIdentityId',
    'credentialIdentityRevision',
    'externalActor',
  ] as const;
  return [
    keys.map(csvField).join(','),
    ...entries.map((entry) => keys.map((key) => csvField(entry[key])).join(',')),
  ].join('\n');
}

async function workspaceDataLifecycleResult(input: {
  workspaceId: string;
  retentionDays: number;
  keepLatestPerThread: number;
  dryRun: boolean;
  actor?: string;
}): Promise<WorkspaceDataLifecycleResult> {
  const [routineRunIds, workflowRunIds, delegatedRunIds] = await Promise.all([
    routineStore.referencedRunIds(input.workspaceId),
    workflowStore.referencedRunIds(input.workspaceId),
    delegatedAgentTaskStore.referencedRunIds(input.workspaceId),
  ]);
  return deliveryStore.pruneWorkspaceData({
    ...input,
    protectedRunIds: [
      ...new Set([...routineRunIds, ...workflowRunIds, ...delegatedRunIds]),
    ],
  });
}

async function organizationAuditSnapshot(input: {
  workspaceId: string;
  projectId?: string;
  actor?: string;
  action?: string;
  destination?: string;
  category?: OrganizationAuditCategory;
  outcome?: OrganizationAuditEntry['outcome'];
  from?: string;
  to?: string;
  limit?: number;
  includeInstallation?: boolean;
}): Promise<{ entries: OrganizationAuditEntry[]; total: number; truncated: boolean }> {
  const runTypes: AgentRunEventType[] = [
    'created',
    'started',
    'completed',
    'failed',
    'human_takeover',
    'cancel_requested',
    'cancelled',
    'usage_budget_denied',
    'usage_threshold_alert',
    'thread_status',
    'tool_call',
    'tool_approval',
    'tool_result',
    'delegation',
  ];
  const [
    runEvents,
    config,
    access,
    binding,
    routine,
    workflow,
    producer,
    connector,
    operatorCredential,
    toolIdentity,
    skill,
    knowledge,
    agent,
    lifecycle,
  ] = await Promise.all([
    deliveryStore.listScopedAgentRunEvents({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      types: runTypes,
      limit: 2_000,
    }),
    threadConfigStore.listAudit(200, input.workspaceId),
    accessStore.snapshot(input.workspaceId, 200),
    deliveryStore.listThreadBindingAudit({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      limit: 500,
    }),
    routineStore.listAudit({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      limit: 200,
    }),
    workflowStore.listAudit({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      limit: 200,
    }),
    workflowStore.listProducerAudit({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      limit: 200,
    }),
    managedConnectorStore.listAudit(200),
    operatorCredentialStore.listAudit(200),
    toolCredentialIdentityStore.listAudit(200),
    skillStore.listAudit(200),
    knowledgeSourceStore.listAudit(input.workspaceId, 200),
    delegatedAgentStore.listAudit(200),
    deliveryStore.listDataLifecycleAudit({
      workspaceId: input.workspaceId,
      limit: 200,
    }),
  ]);
  const entries: OrganizationAuditEntry[] = [
    ...runEvents.map((event) => organizationRunAuditEntry(input.workspaceId, event)),
    ...config.map((record) => ({
      id: `config:${record.id}`,
      source: 'config' as const,
      category: 'policy' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      channelId: record.channelId,
      platform: record.platform,
      summary: record.action,
      referenceId: record.id,
    })),
    ...access.audit.map((record) => ({
      id: `access:${record.id}`,
      source: 'access' as const,
      category: 'access' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      summary: record.memberId ? `${record.action}: ${record.memberId}` : record.action,
      referenceId: record.id,
    })),
    ...binding.map((record) => ({
      id: `binding:${record.id}`,
      source: 'binding' as const,
      category: 'binding' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor || 'system',
      at: record.at,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      channelId: record.channelId,
      platform: record.platform,
      summary: `${record.action}: ${record.externalId}`,
      referenceId: record.bindingId,
    })),
    ...routine.map((record) => ({
      id: `routine:${record.id}`,
      source: 'routine' as const,
      category: 'routine' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      platform: record.snapshot.destination.platform,
      channelId: record.snapshot.destination.channelId,
      summary: `${record.action}: ${record.snapshot.name}`,
      referenceId: record.routineId,
    })),
    ...workflow.map((record) => ({
      id: `workflow:${record.id}`,
      source: 'workflow' as const,
      category: 'workflow' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      platform: record.snapshot.destination.platform,
      channelId: record.snapshot.destination.channelId,
      summary:
        record.action === 'workflow.event.staged'
          ? `${record.eventType || 'event'} -> ${record.snapshot.name}`
          : record.action === 'workflow.node.retried'
            ? `Retry ${record.nodeId || 'node'} attempt ${record.attempt || '?'} -> ${record.snapshot.name}`
            : record.action === 'workflow.execution.cancelled'
              ? `Cancel execution -> ${record.snapshot.name}`
          : `${record.action}: ${record.snapshot.name}`,
      referenceId: record.executionId || record.workflowId,
    })),
    ...producer.map((record) => ({
      id: `workflow-producer:${record.id}`,
      source: 'workflow' as const,
      category: 'workflow' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      summary: `${record.action}: ${record.snapshot.name}`,
      referenceId: record.routeId,
    })),
    ...(input.includeInstallation ? connector : []).map((record) => ({
      id: `connector:${record.id}`,
      source: 'connector' as const,
      category: 'tool' as const,
      action: record.action,
      outcome:
        record.action === 'connector.checked'
          ? record.snapshot.lastCheck?.status === 'ready'
            ? ('succeeded' as const)
            : ('failed' as const)
          : ('changed' as const),
      actor: record.actor,
      at: record.at,
      workspaceId: input.workspaceId,
      summary:
        record.action === 'connector.checked'
          ? `${record.connectorId}: ${record.snapshot.lastCheck?.status || 'unknown'}`
          : `${record.connectorId}: ${record.snapshot.enabled ? 'enabled' : 'disabled'}`,
      referenceId: record.connectorId,
      toolProvider: `mcp:${record.connectorId}`,
    })),
    ...(input.includeInstallation ? operatorCredential : []).map((record) => ({
      id: `operator-credential:${record.id}`,
      source: 'operator_credential' as const,
      category: 'access' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: input.workspaceId,
      summary: `${record.action}: ${record.credentialId} r${record.revision}`,
      referenceId: record.credentialId,
    })),
    ...(input.includeInstallation ? toolIdentity : []).map((record) => ({
      id: `tool-identity:${record.id}`,
      source: 'tool_identity' as const,
      category: 'tool' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: input.workspaceId,
      summary: `${record.action}: ${record.identityId} r${record.snapshot.revision}`,
      referenceId: record.identityId,
      toolProvider: `opentag:${record.snapshot.provider}`,
      credentialIdentityId: record.identityId,
      credentialIdentityRevision: record.snapshot.revision,
      externalActor: record.snapshot.externalActor,
    })),
    ...(input.includeInstallation ? skill : []).map((record) => ({
      id: `skill:${record.id}`,
      source: 'skill' as const,
      category: 'policy' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: input.workspaceId,
      summary: `${record.action}: ${record.skillId} v${record.revision}`,
      referenceId: record.skillId,
    })),
    ...knowledge.map((record) => ({
      id: `knowledge:${record.id}`,
      source: 'knowledge' as const,
      category: 'knowledge' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: record.workspaceId,
      summary: `${record.action}: ${record.sourceId} r${record.revision} / ${record.contentHash.slice(0, 12)}`,
      referenceId: record.sourceId,
    })),
    ...(input.includeInstallation ? agent : []).map((record) => ({
      id: `agent:${record.id}`,
      source: 'agent' as const,
      category: 'agent' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: input.workspaceId,
      summary: `${record.action}: ${record.agentId} v${record.revision}`,
      referenceId: record.agentId,
    })),
    ...lifecycle.map((record) => ({
      id: `lifecycle:${record.id}`,
      source: 'lifecycle' as const,
      category: 'policy' as const,
      action: record.action,
      outcome: 'changed' as const,
      actor: record.actor,
      at: record.at,
      workspaceId: record.workspaceId,
      summary: `Removed ${record.removed.agentRuns} terminal runs and ${record.removed.agentRunEvents} timeline events older than ${record.retentionDays} days`,
      referenceId: record.id,
    })),
  ];
  const query = input.action?.trim().toLowerCase();
  const destination = auditDestination(input.destination);
  const filtered = entries
    .filter((entry) => !input.projectId || entry.projectId === input.projectId)
    .filter((entry) => !input.actor || entry.actor.toLowerCase().includes(input.actor.toLowerCase()))
    .filter((entry) => !input.category || entry.category === input.category)
    .filter((entry) => !input.outcome || entry.outcome === input.outcome)
    .filter(
      (entry) =>
        !destination || entry.destination?.toLowerCase() === destination,
    )
    .filter((entry) => !input.from || entry.at >= input.from)
    .filter((entry) => !input.to || entry.at <= input.to)
    .filter(
      (entry) =>
        !query ||
        entry.action.toLowerCase().includes(query) ||
        entry.summary.toLowerCase().includes(query),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
  return {
    entries: filtered.slice(0, limit),
    total: filtered.length,
    truncated: filtered.length > limit,
  };
}

async function reconcileSpendPolicyAlerts(input: {
  workspaceId: string;
  target: string;
  projectId?: string;
  platform?: PlatformKind;
  channelId?: string;
}): Promise<void> {
  const [workspaces, projects, bindings] = await Promise.all([
    threadConfigStore.listWorkspacePolicies(),
    threadConfigStore.listProjectPolicies(input.workspaceId),
    deliveryStore.listThreadBindings(2_000, input.workspaceId),
  ]);
  const workspace = workspaces.find(
    (candidate) => candidate.workspace.id === input.workspaceId,
  );
  const project = projects.find(
    (candidate) =>
      candidate.projectId === input.projectId || candidate.id === input.projectId,
  );
  const routableBindings = bindings.filter((binding) =>
    projects.some(
      (candidate) =>
        candidate.projectId === binding.projectId ||
        candidate.id === binding.projectId,
    ),
  );
  const matchingBindings = routableBindings.filter((binding) => {
    if (input.target === 'workspace') return true;
    if (
      input.target === 'project' ||
      input.target === 'project-default-channel'
    ) {
      return (
        binding.projectId === project?.projectId ||
        binding.projectId === project?.id
      );
    }
    if (
      input.target === 'channel' ||
      input.target === 'workspace-default-channel'
    ) {
      return (
        (!input.projectId ||
          binding.projectId === project?.projectId ||
          binding.projectId === project?.id) &&
        (!input.platform || binding.platform === input.platform) &&
        (!input.channelId ||
          (binding.channelId || binding.externalId) === input.channelId)
      );
    }
    return false;
  });
  const candidates = matchingBindings.length
    ? matchingBindings
    : [
        {
          platform: input.platform ?? ('custom-chat' as const),
          externalId: input.channelId ?? `spend:${project?.projectId || 'workspace'}`,
          channelId: input.channelId,
          workspaceId: input.workspaceId,
          projectId:
            project?.projectId || workspace?.workspace.defaultProjectId || 'general',
        },
      ];
  for (const binding of candidates) {
    const channelId = binding.channelId || binding.externalId;
    const thread: SourceThread = {
      id: `${binding.platform}:${channelId}:spend-policy`,
      platform: binding.platform,
      externalId: `${channelId}:spend-policy`,
      workspaceId: input.workspaceId,
      projectId: binding.projectId,
      channelId,
      visibility: 'private',
    };
    const resolved = await threadConfigStore.resolveThreadPolicy(thread);
    await deliveryStore.reconcileUsageBudgetAlerts({
      thread,
      policies: resolved.access.budgetPolicies,
    });
  }
}

function createRuntimeForPlatform(platform: PlatformAdapter): OpenTagRuntime {
  const defaultExecutor = executorRegistry.get(executorRegistry.defaultExecutorId);
  if (!defaultExecutor) throw new Error('default_executor_not_available');
  return new OpenTagRuntime({
    platform,
    executor: defaultExecutor,
    executorRegistry,
    memory: memoryStore,
    memoryRetriever: memoryRetrievalService,
    skills: skillStore,
    delegatedAgents: delegatedAgentStore,
    knowledgeSources: knowledgeSourceStore,
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
  const channelId = platform === 'github' ? 'opentag/dev-preview' : `dev-${projectId}`;
  const topicId = platform === 'telegram' || platform === 'github' ? '1' : 'root';
  const externalId =
    platform === 'github' ? `${channelId}#${topicId}` : `${channelId}:${topicId}`;
  const thread: SourceThread = {
    id: `${platform}:${externalId}`,
    platform,
    externalId,
    workspaceId,
    projectId,
    channelId,
    rootMessageId: platform === 'lark' ? 'root' : platform === 'github' ? topicId : undefined,
    topicId,
    title: projectName,
    visibility: 'public',
    metadata: {
      projectId,
      ...(platform === 'github'
        ? {
            owner: 'opentag',
            repo: 'dev-preview',
            repository: channelId,
            issueNumber: 1,
          }
        : {}),
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

function skillIdArrayValue(
  body: Record<string, unknown>,
): string[] | undefined | { error: string } {
  if (body.skillIds === undefined) return undefined;
  if (!Array.isArray(body.skillIds)) return { error: 'agent_skill_ids_invalid' };
  const values = stringArrayValue(body, 'skillIds') ?? [];
  if (values.length !== body.skillIds.length) {
    return { error: 'agent_skill_ids_invalid' };
  }
  const skillIds = [...new Set(values.map((value) => value.toLowerCase()))];
  const invalid = skillIds.find(
    (value) => !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value),
  );
  return invalid ? { error: `agent_skill_invalid_id:${invalid}` } : skillIds;
}

function delegatedAgentIdArrayValue(
  body: Record<string, unknown>,
): string[] | undefined | { error: string } {
  if (body.agentIds === undefined) return undefined;
  if (!Array.isArray(body.agentIds)) {
    return { error: 'delegated_agent_ids_invalid' };
  }
  const values = stringArrayValue(body, 'agentIds') ?? [];
  if (values.length !== body.agentIds.length) {
    return { error: 'delegated_agent_ids_invalid' };
  }
  const agentIds = [...new Set(values.map((value) => value.toLowerCase()))];
  const invalid = agentIds.find(
    (value) => !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value),
  );
  return invalid
    ? { error: `delegated_agent_invalid_id:${invalid}` }
    : agentIds;
}

function capabilityBundleIdArrayValue(
  body: Record<string, unknown>,
): string[] | undefined | { error: string } {
  if (body.bundleIds === undefined) return undefined;
  if (!Array.isArray(body.bundleIds)) {
    return { error: 'capability_bundle_ids_invalid' };
  }
  const values = stringArrayValue(body, 'bundleIds') ?? [];
  if (values.length !== body.bundleIds.length) {
    return { error: 'capability_bundle_ids_invalid' };
  }
  const bundleIds = [...new Set(values.map((value) => value.toLowerCase()))];
  const invalid = bundleIds.find(
    (value) => !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value),
  );
  return invalid
    ? { error: `capability_bundle_invalid_id:${invalid}` }
    : bundleIds;
}

function knowledgeSourceIdArrayValue(
  body: Record<string, unknown>,
): string[] | undefined | { error: string } {
  if (body.knowledgeSourceIds === undefined) return undefined;
  if (!Array.isArray(body.knowledgeSourceIds)) {
    return { error: 'knowledge_source_ids_invalid' };
  }
  const values = stringArrayValue(body, 'knowledgeSourceIds') ?? [];
  if (values.length !== body.knowledgeSourceIds.length) {
    return { error: 'knowledge_source_ids_invalid' };
  }
  const sourceIds = [...new Set(values.map((value) => value.toLowerCase()))];
  const invalid = sourceIds.find(
    (value) => !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value),
  );
  return invalid
    ? { error: `knowledge_source_invalid_id:${invalid}` }
    : sourceIds;
}

function delegatedAgentGrantKindsValue(
  body: Record<string, unknown>,
): ToolGrantKind[] | { error: string } {
  if (body.grantKinds === undefined) return [];
  if (!Array.isArray(body.grantKinds)) {
    return { error: 'delegated_agent_grant_kinds_invalid' };
  }
  const values = stringArrayValue(body, 'grantKinds') ?? [];
  if (values.length !== body.grantKinds.length) {
    return { error: 'delegated_agent_grant_kinds_invalid' };
  }
  const grantKinds = [...new Set(values.map((value) => value.toLowerCase()))];
  const available = new Set(
    toolCatalog
      .map((tool) => tool.grantKind)
      .filter((kind) => kind !== 'agents' && kind !== 'skills' && kind !== 'memory'),
  );
  const invalid = grantKinds.find((kind) => !available.has(kind));
  return invalid
    ? { error: `delegated_agent_grant_kind_not_available:${invalid}` }
    : grantKinds;
}

function delegatedAgentMemoryScopesValue(
  body: Record<string, unknown>,
): MemoryScopeKind[] | { error: string } {
  if (body.memoryScopes === undefined) return [];
  if (!Array.isArray(body.memoryScopes)) {
    return { error: 'delegated_agent_memory_scopes_invalid' };
  }
  const values = stringArrayValue(body, 'memoryScopes') ?? [];
  if (values.length !== body.memoryScopes.length) {
    return { error: 'delegated_agent_memory_scopes_invalid' };
  }
  const allowed = new Set<MemoryScopeKind>([
    'workspace',
    'project',
    'channel',
    'thread',
  ]);
  const invalid = values.find((scope) => !allowed.has(scope as MemoryScopeKind));
  return invalid
    ? { error: `delegated_agent_memory_scope_invalid:${invalid}` }
    : ([...new Set(values)] as MemoryScopeKind[]);
}

async function invalidAssignedSkill(
  skillIds: string[] | undefined,
  existingSkillIds: string[] = [],
): Promise<{ id: string; reason: 'not_found' | 'not_enabled' } | undefined> {
  if (!skillIds?.length) return undefined;
  const known = new Map(
    (await skillStore.list({ ids: skillIds, includeDisabled: true })).map(
      (skill) => [skill.id, skill],
    ),
  );
  const existing = new Set(existingSkillIds);
  for (const id of skillIds) {
    const skill = known.get(id);
    if (!skill) return { id, reason: 'not_found' };
    if (!skill.enabled && !existing.has(id)) return { id, reason: 'not_enabled' };
  }
  return undefined;
}

async function invalidAssignedDelegatedAgent(
  agentIds: string[] | undefined,
  existingAgentIds: string[] = [],
): Promise<{ id: string; reason: 'not_found' | 'not_enabled' } | undefined> {
  if (!agentIds?.length) return undefined;
  const known = new Map(
    (
      await delegatedAgentStore.list({ ids: agentIds, includeDisabled: true })
    ).map((agent) => [agent.id, agent]),
  );
  const existing = new Set(existingAgentIds);
  for (const id of agentIds) {
    const agent = known.get(id);
    if (!agent) return { id, reason: 'not_found' };
    if (!agent.enabled && !existing.has(id)) {
      return { id, reason: 'not_enabled' };
    }
  }
  return undefined;
}

async function invalidAssignedKnowledgeSource(
  workspaceId: string,
  sourceIds: string[] | undefined,
  existingSourceIds: string[] = [],
): Promise<{ id: string; reason: 'not_found' | 'not_enabled' } | undefined> {
  if (!sourceIds?.length) return undefined;
  const known = new Map(
    (
      await knowledgeSourceStore.list({
        workspaceId,
        ids: sourceIds,
        includeDisabled: true,
      })
    ).map((source) => [source.id, source]),
  );
  const existing = new Set(existingSourceIds);
  for (const id of sourceIds) {
    const source = known.get(id);
    if (!source) return { id, reason: 'not_found' };
    if (!source.enabled && !existing.has(id)) return { id, reason: 'not_enabled' };
  }
  return undefined;
}

const PROJECT_TOOL_LABELS: Record<string, string> = Object.fromEntries(
  toolCatalog.map((tool) => [tool.grantKind, tool.label]),
);
const PROJECT_TOOL_CATALOG = new Map(
  toolCatalog.map((tool) => [tool.grantKind, tool]),
);

function coerceCapabilityPolicy(
  body: Record<string, unknown>,
  scope: 'workspace' | 'project' | 'channel',
  grantPrefix: string,
):
  | Pick<UpsertProjectAgentPolicyInput, 'grants' | 'networkPolicy'>
  | { error: string } {
  const tools = stringArrayValue(body, 'tools');
  const unsupportedTool = tools?.find((tool) => !PROJECT_TOOL_LABELS[tool]);
  if (unsupportedTool) return { error: `unsupported_tool:${unsupportedTool}` };
  const rawConstraints = recordValue(body, 'toolConstraints') ?? {};
  const grants: ToolGrant[] | undefined = tools ? [] : undefined;
  for (const tool of tools ?? []) {
    const catalogEntry = PROJECT_TOOL_CATALOG.get(tool);
    const raw = recordValue(rawConstraints, tool) ?? {};
    const credentialIdentityId = stringValue(raw, 'credentialIdentityId');
    const allowedKeys = [
      ...(catalogEntry?.constraints?.map((constraint) => constraint.key) ?? []),
      ...(catalogEntry?.writeToolCount ? ['permissions'] : []),
      ...(
        tool === 'github' || tool === 'lark-docs' || tool === 'lark-base'
          ? ['credentialIdentityId']
          : []
      ),
    ];
    const unsupportedConstraint = Object.keys(raw).find(
      (key) => !allowedKeys.includes(key),
    );
    if (unsupportedConstraint) {
      return { error: `unsupported_tool_constraint:${tool}:${unsupportedConstraint}` };
    }
    const constraints: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (key === 'credentialIdentityId') continue;
      const values = stringArrayValue(raw, key) ?? [];
      if (key === 'permissions') {
        if (values.some((value) => value !== 'read' && value !== 'write')) {
          return { error: `invalid_tool_constraint:${tool}:${key}` };
        }
        constraints.permissions = values.includes('write')
          ? ['read', 'write']
          : ['read'];
        continue;
      }
      if (values.length > 100 || values.some((value) => value.length > 200)) {
        return { error: `invalid_tool_constraint:${tool}:${key}` };
      }
      if (
        key === 'commands' &&
        values.some(
          (value) => value === '*' || !/^[a-zA-Z0-9_.+-]+$/u.test(value),
        )
      ) {
        return { error: `invalid_tool_constraint:${tool}:${key}` };
      }
      const allowedValues = catalogEntry?.constraints?.find(
        (constraint) => constraint.key === key,
      )?.allowedValues;
      if (allowedValues && values.length === 0) {
        return { error: `invalid_tool_constraint:${tool}:${key}` };
      }
      if (allowedValues && values.some((value) => !allowedValues.includes(value))) {
        return { error: `invalid_tool_constraint:${tool}:${key}` };
      }
      constraints[key] = [...new Set(values)];
    }
    grants?.push({
      id: `${grantPrefix}:${tool}`,
      kind: tool as ToolGrantKind,
      scope,
      label: PROJECT_TOOL_LABELS[tool],
      credentialIdentityId: credentialIdentityId || undefined,
      constraints: Object.keys(constraints).length ? constraints : undefined,
    });
  }

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
  return {
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

async function availableToolCredentialIdentities(): Promise<Array<{
  id: string;
  displayName: string;
  provider: 'lark' | 'github';
  revision: number;
  externalActor?: string;
  enabled: boolean;
  credentialsAvailable: boolean;
  builtin: boolean;
}>> {
  const configured = await toolCredentialIdentityStore.list();
  return [
    ...(defaultLarkToolIdentity
      ? [{
          ...defaultLarkToolIdentity,
          provider: 'lark' as const,
          enabled: true,
          credentialsAvailable: true,
          builtin: true,
        }]
      : []),
    ...(defaultGitHubToolIdentity
      ? [{
          ...defaultGitHubToolIdentity,
          provider: 'github' as const,
          enabled: true,
          credentialsAvailable: true,
          builtin: true,
        }]
      : []),
    ...configured.map((identity) => ({
      id: identity.id,
      displayName: identity.displayName,
      provider: identity.provider,
      revision: identity.revision,
      externalActor: identity.externalActor,
      enabled: identity.enabled,
      credentialsAvailable:
        identity.provider === 'github'
          ? Boolean(identity.envRefs.token && process.env[identity.envRefs.token])
          : Boolean(
              identity.envRefs.appId &&
                identity.envRefs.appSecret &&
                process.env[identity.envRefs.appId] &&
                process.env[identity.envRefs.appSecret],
            ),
      builtin: false,
    })),
  ];
}

async function invalidAssignedToolCredentialIdentity(
  grants: ToolGrant[] | undefined,
  existingGrants: ToolGrant[] = [],
): Promise<{ id: string; reason: 'not_found' | 'not_enabled' | 'provider_mismatch' } | undefined> {
  const assigned = (grants ?? []).filter((grant) => grant.credentialIdentityId);
  if (!assigned.length) return undefined;
  const identities = new Map(
    (await availableToolCredentialIdentities()).map((identity) => [identity.id, identity]),
  );
  const existing = new Set(
    existingGrants.flatMap((grant) =>
      grant.credentialIdentityId ? [grant.credentialIdentityId] : [],
    ),
  );
  for (const grant of assigned) {
    const id = grant.credentialIdentityId!;
    const identity = identities.get(id);
    if (!identity) return { id, reason: 'not_found' };
    if ((!identity.enabled || !identity.credentialsAvailable) && !existing.has(id)) {
      return { id, reason: 'not_enabled' };
    }
    const provider = grant.kind === 'github'
      ? 'github'
      : grant.kind === 'lark-docs' || grant.kind === 'lark-base'
        ? 'lark'
        : undefined;
    if (!provider || identity.provider !== provider) {
      return { id, reason: 'provider_mismatch' };
    }
  }
  return undefined;
}

function coerceBudgetPolicy(
  body: Record<string, unknown>,
  defaultMode: UsageBudgetPolicy['mode'],
  defaultScope: NonNullable<UsageBudgetPolicy['scope']>,
): UsageBudgetPolicy | undefined | { error: string } {
  const rawPolicy = recordValue(body, 'budgetPolicy');
  const source = rawPolicy ?? body;
  const hasBudgetInput =
    Boolean(rawPolicy) ||
    body.budgetMode !== undefined ||
    body.budgetScope !== undefined ||
    body.maxRunsPerMonth !== undefined ||
    body.maxCostUsdPerMonth !== undefined;
  if (!hasBudgetInput) return undefined;

  const mode = stringValue(source, 'mode', stringValue(body, 'budgetMode', defaultMode));
  if (mode !== 'inherit' && mode !== 'custom' && mode !== 'disabled') {
    return { error: 'unsupported_budget_mode' };
  }
  const scope = stringValue(
    source,
    'scope',
    stringValue(body, 'budgetScope', defaultScope),
  );
  if (
    scope !== 'workspace' &&
    scope !== 'project' &&
    scope !== 'channel' &&
    scope !== 'thread'
  ) {
    return { error: 'unsupported_budget_scope' };
  }
  const maxRunsPerMonth = numberValue(
    source,
    'maxRunsPerMonth',
    numberValue(body, 'maxRunsPerMonth'),
  );
  const maxCostUsdPerMonth = numberValue(
    source,
    'maxCostUsdPerMonth',
    numberValue(body, 'maxCostUsdPerMonth'),
  );
  if (
    (maxRunsPerMonth !== undefined && maxRunsPerMonth < 0) ||
    (maxCostUsdPerMonth !== undefined && maxCostUsdPerMonth < 0)
  ) {
    return { error: 'invalid_budget_limit' };
  }
  if (mode === 'disabled') return { mode: 'disabled' };
  if (mode === 'inherit') return { mode: 'inherit' };
  return {
    mode,
    scope,
    maxRunsPerMonth,
    maxCostUsdPerMonth,
  };
}

function coerceNamedBudgetPolicy(
  body: Record<string, unknown>,
  key: string,
  defaultMode: UsageBudgetPolicy['mode'],
  defaultScope: NonNullable<UsageBudgetPolicy['scope']>,
): UsageBudgetPolicy | undefined | { error: string } {
  const policy = recordValue(body, key);
  return policy
    ? coerceBudgetPolicy({ budgetPolicy: policy }, defaultMode, defaultScope)
    : undefined;
}

function coerceChannelPolicyInput(
  body: Record<string, unknown>,
): UpsertChannelAgentPolicyInput | { error: string } {
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const projectId = stringValue(body, 'projectId');
  const platform = platformValue(stringValue(body, 'platform', 'lark'));
  const channelId = stringValue(body, 'channelId');
  if (!workspaceId || !projectId || !platform || !channelId) {
    return {
      error: 'workspace_project_platform_channel_required',
    };
  }

  const instructionMode = stringValue(body, 'instructionMode');
  if (
    instructionMode &&
    instructionMode !== 'inherit' &&
    instructionMode !== 'append' &&
    instructionMode !== 'replace'
  ) {
    return { error: 'unsupported_channel_instruction_mode' };
  }
  const capabilityMode = stringValue(body, 'capabilityMode');
  if (
    capabilityMode &&
    capabilityMode !== 'inherit' &&
    capabilityMode !== 'extend' &&
    capabilityMode !== 'custom'
  ) {
    return { error: 'unsupported_channel_capability_mode' };
  }

  const capabilityPolicy = coerceCapabilityPolicy(
    body,
    'channel',
    `channel:${workspaceId}:${platform}:${channelId}`,
  );
  if ('error' in capabilityPolicy) return capabilityPolicy;
  const skillIds = skillIdArrayValue(body);
  if (skillIds && 'error' in skillIds) return skillIds;
  const agentIds = delegatedAgentIdArrayValue(body);
  if (agentIds && 'error' in agentIds) return agentIds;
  const knowledgeSourceIds = knowledgeSourceIdArrayValue(body);
  if (knowledgeSourceIds && 'error' in knowledgeSourceIds) return knowledgeSourceIds;
  const bundleIds = capabilityBundleIdArrayValue(body);
  if (bundleIds && 'error' in bundleIds) return bundleIds;
  const budgetPolicy = coerceBudgetPolicy(body, 'inherit', 'channel');
  if (budgetPolicy && 'error' in budgetPolicy) return budgetPolicy;
  const memoryApprovalPolicy = coerceMemoryApprovalPolicy(body, 'inherit');
  if (memoryApprovalPolicy && 'error' in memoryApprovalPolicy) {
    return memoryApprovalPolicy;
  }
  const toolApprovalPolicy = coerceToolApprovalPolicy(body, 'inherit');
  if (toolApprovalPolicy && 'error' in toolApprovalPolicy) {
    return toolApprovalPolicy;
  }
  const resolvedCapabilityMode =
    capabilityMode ||
    (capabilityPolicy.grants || capabilityPolicy.networkPolicy
      ? 'custom'
      : undefined);

  return {
    workspaceId,
    projectId,
    platform,
    channelId,
    title: stringValue(body, 'title'),
    instructionMode:
      instructionMode as UpsertChannelAgentPolicyInput['instructionMode'],
    instructions:
      instructionMode === 'inherit'
        ? undefined
        : typeof body.instructions === 'string'
          ? body.instructions
          : undefined,
    capabilityMode:
      resolvedCapabilityMode as UpsertChannelAgentPolicyInput['capabilityMode'],
    skillIds,
    agentIds,
    knowledgeSourceIds,
    bundleIds,
    grants:
      resolvedCapabilityMode === 'inherit' ? undefined : capabilityPolicy.grants,
    networkPolicy:
      resolvedCapabilityMode === 'inherit'
        ? undefined
        : capabilityPolicy.networkPolicy,
    budgetPolicy,
    memoryApprovalPolicy,
    toolApprovalPolicy,
  };
}

function coerceMemoryApprovalPolicy(
  body: Record<string, unknown>,
  defaultMode: NonNullable<MemoryApprovalPolicy['mode']>,
): MemoryApprovalPolicy | undefined | { error: string } {
  const rawPolicy = recordValue(body, 'memoryApprovalPolicy');
  const source = rawPolicy ?? body;
  const hasPolicyInput =
    Boolean(rawPolicy) ||
    body.memoryApprovalMode !== undefined ||
    body.memoryApprovalScopes !== undefined ||
    body.memoryApprovalActions !== undefined;
  if (!hasPolicyInput) return undefined;

  const mode = stringValue(
    source,
    'mode',
    stringValue(body, 'memoryApprovalMode', defaultMode),
  );
  if (mode !== 'inherit' && mode !== 'require_approval' && mode !== 'disabled') {
    return { error: 'unsupported_memory_approval_mode' };
  }
  if (mode === 'disabled') return { mode: 'disabled' };
  if (mode === 'inherit') return { mode: 'inherit' };

  const scopes = memoryScopeListValue(
    source.scopes ?? body.memoryApprovalScopes,
  )?.filter((scope) => scope !== 'global');
  if (
    (source.scopes !== undefined || body.memoryApprovalScopes !== undefined) &&
    !scopes?.length
  ) {
    return { error: 'invalid_memory_approval_scopes' };
  }
  const actions = memoryApprovalActionListValue(
    source.actions ?? body.memoryApprovalActions,
  );
  if (
    (source.actions !== undefined || body.memoryApprovalActions !== undefined) &&
    !actions?.length
  ) {
    return { error: 'invalid_memory_approval_actions' };
  }
  return {
    mode: 'require_approval',
    scopes,
    actions,
  };
}

function coerceToolApprovalPolicy(
  body: Record<string, unknown>,
  defaultMode: NonNullable<ToolApprovalPolicy['mode']>,
): ToolApprovalPolicy | undefined | { error: string } {
  const rawPolicy = recordValue(body, 'toolApprovalPolicy');
  const source = rawPolicy ?? body;
  const hasPolicyInput =
    Boolean(rawPolicy) || body.toolApprovalMode !== undefined;
  if (!hasPolicyInput) return undefined;
  const mode = stringValue(
    source,
    'mode',
    stringValue(body, 'toolApprovalMode', defaultMode),
  );
  if (mode !== 'inherit' && mode !== 'require_approval' && mode !== 'disabled') {
    return { error: 'unsupported_tool_approval_mode' };
  }
  if (mode === 'inherit' || mode === 'disabled') return { mode };
  const risks = Array.isArray(source.risks)
    ? source.risks.filter((risk): risk is 'write' => risk === 'write')
    : ['write'];
  if (!risks.length) return { error: 'invalid_tool_approval_risks' };
  return { mode: 'require_approval', risks: ['write'] };
}

function coerceMemoryRetentionPolicy(
  body: Record<string, unknown>,
  defaultMode: NonNullable<MemoryRetentionPolicy['mode']>,
): MemoryRetentionPolicy | undefined | { error: string } {
  const rawPolicy = recordValue(body, 'memoryRetentionPolicy');
  const source = rawPolicy ?? body;
  const hasPolicyInput =
    Boolean(rawPolicy) ||
    body.memoryRetentionMode !== undefined ||
    body.memoryRetentionDays !== undefined;
  if (!hasPolicyInput) return undefined;
  const mode = stringValue(
    source,
    'mode',
    stringValue(body, 'memoryRetentionMode', defaultMode),
  );
  if (mode !== 'inherit' && mode !== 'keep' && mode !== 'custom') {
    return { error: 'unsupported_memory_retention_mode' };
  }
  if (mode === 'inherit') return { mode: 'inherit' };
  if (mode === 'keep') return { mode: 'keep' };
  const days = numberValue(
    source,
    'days',
    numberValue(body, 'memoryRetentionDays'),
  );
  if (!Number.isInteger(days) || days! < 1 || days! > 3_650) {
    return { error: 'invalid_memory_retention_days' };
  }
  return { mode: 'custom', days };
}

function memoryApprovalActionListValue(
  value: unknown,
): MemoryApprovalAction[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const actions: MemoryApprovalAction[] = raw.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const action = item.trim();
    return action === 'remember' || action === 'forget'
      ? [action as MemoryApprovalAction]
      : [];
  });
  return actions.length ? [...new Set(actions)] : undefined;
}

function coerceProjectPolicyInput(
  body: Record<string, unknown>,
): UpsertProjectAgentPolicyInput | { error: string } {
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const projectId = stringValue(body, 'projectId');
  if (!workspaceId || !projectId) return { error: 'workspace_and_project_required' };

  const executorId = stringValue(body, 'executorId');
  if (executorId && !executorRegistry.has(executorId)) {
    return { error: 'unsupported_executor' };
  }

  const capabilityPolicy = coerceCapabilityPolicy(
    body,
    'project',
    `project:${workspaceId}:${projectId}`,
  );
  if ('error' in capabilityPolicy) return capabilityPolicy;
  const skillIds = skillIdArrayValue(body);
  if (skillIds && 'error' in skillIds) return skillIds;
  const agentIds = delegatedAgentIdArrayValue(body);
  if (agentIds && 'error' in agentIds) return agentIds;
  const knowledgeSourceIds = knowledgeSourceIdArrayValue(body);
  if (knowledgeSourceIds && 'error' in knowledgeSourceIds) return knowledgeSourceIds;
  const bundleIds = capabilityBundleIdArrayValue(body);
  if (bundleIds && 'error' in bundleIds) return bundleIds;
  const budgetPolicy = coerceBudgetPolicy(body, 'inherit', 'project');
  if (budgetPolicy && 'error' in budgetPolicy) return budgetPolicy;
  const defaultChannelBudgetPolicy = coerceNamedBudgetPolicy(
    body,
    'defaultChannelBudgetPolicy',
    'inherit',
    'channel',
  );
  if (defaultChannelBudgetPolicy && 'error' in defaultChannelBudgetPolicy) {
    return defaultChannelBudgetPolicy;
  }
  const memoryApprovalPolicy = coerceMemoryApprovalPolicy(body, 'inherit');
  if (memoryApprovalPolicy && 'error' in memoryApprovalPolicy) {
    return memoryApprovalPolicy;
  }
  const toolApprovalPolicy = coerceToolApprovalPolicy(body, 'inherit');
  if (toolApprovalPolicy && 'error' in toolApprovalPolicy) {
    return toolApprovalPolicy;
  }
  const memoryRetentionPolicy = coerceMemoryRetentionPolicy(body, 'inherit');
  if (memoryRetentionPolicy && 'error' in memoryRetentionPolicy) {
    return memoryRetentionPolicy;
  }
  const memoryMode = stringValue(body, 'memoryMode');
  if (
    memoryMode &&
    memoryMode !== 'workspace' &&
    memoryMode !== 'isolated'
  ) {
    return { error: 'unsupported_project_memory_mode' };
  }
  const agentMode = stringValue(body, 'agentMode');
  if (agentMode && agentMode !== 'inherit' && agentMode !== 'custom') {
    return { error: 'unsupported_project_agent_mode' };
  }
  const capabilityMode = stringValue(body, 'capabilityMode');
  if (
    capabilityMode &&
    capabilityMode !== 'inherit' &&
    capabilityMode !== 'custom'
  ) {
    return { error: 'unsupported_project_capability_mode' };
  }

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
  const resolvedAgentMode =
    agentMode || (Object.keys(identity).length ? 'custom' : undefined);
  const resolvedCapabilityMode =
    capabilityMode ||
    (capabilityPolicy.grants || capabilityPolicy.networkPolicy
      ? 'custom'
      : undefined);

  return {
    workspaceId,
    projectId,
    name: stringValue(body, 'name'),
    description:
      typeof body.description === 'string' ? body.description : undefined,
    identity: resolvedAgentMode !== 'inherit' && Object.keys(identity).length
      ? (identity as UpsertProjectAgentPolicyInput['identity'])
      : undefined,
    grants:
      resolvedCapabilityMode === 'inherit' ? undefined : capabilityPolicy.grants,
    agentMode:
      resolvedAgentMode as UpsertProjectAgentPolicyInput['agentMode'],
    capabilityMode:
      resolvedCapabilityMode as UpsertProjectAgentPolicyInput['capabilityMode'],
    skillIds,
    agentIds,
    knowledgeSourceIds,
    bundleIds,
    memoryMode:
      memoryMode as UpsertProjectAgentPolicyInput['memoryMode'],
    networkPolicy:
      resolvedCapabilityMode === 'inherit'
        ? undefined
        : capabilityPolicy.networkPolicy,
    budgetPolicy,
    defaultChannelBudgetPolicy,
    memoryApprovalPolicy,
    toolApprovalPolicy,
    memoryRetentionPolicy,
  };
}

function coerceWorkspacePolicyInput(
  body: Record<string, unknown>,
): UpsertWorkspaceAgentPolicyInput | { error: string } {
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  if (!workspaceId) return { error: 'workspace_required' };
  const executorId = stringValue(body, 'executorId');
  if (executorId && !executorRegistry.has(executorId)) {
    return { error: 'unsupported_executor' };
  }
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
  const capabilityPolicy = coerceCapabilityPolicy(
    body,
    'workspace',
    `workspace:${workspaceId}`,
  );
  if ('error' in capabilityPolicy) return capabilityPolicy;
  const skillIds = skillIdArrayValue(body);
  if (skillIds && 'error' in skillIds) return skillIds;
  const agentIds = delegatedAgentIdArrayValue(body);
  if (agentIds && 'error' in agentIds) return agentIds;
  const knowledgeSourceIds = knowledgeSourceIdArrayValue(body);
  if (knowledgeSourceIds && 'error' in knowledgeSourceIds) return knowledgeSourceIds;
  const bundleIds = capabilityBundleIdArrayValue(body);
  if (bundleIds && 'error' in bundleIds) return bundleIds;
  const budgetPolicy = coerceBudgetPolicy(body, 'disabled', 'workspace');
  if (budgetPolicy && 'error' in budgetPolicy) return budgetPolicy;
  const defaultChannelBudgetPolicy = coerceNamedBudgetPolicy(
    body,
    'defaultChannelBudgetPolicy',
    'disabled',
    'channel',
  );
  if (defaultChannelBudgetPolicy && 'error' in defaultChannelBudgetPolicy) {
    return defaultChannelBudgetPolicy;
  }
  const memoryApprovalPolicy = coerceMemoryApprovalPolicy(body, 'disabled');
  if (memoryApprovalPolicy && 'error' in memoryApprovalPolicy) {
    return memoryApprovalPolicy;
  }
  const toolApprovalPolicy = coerceToolApprovalPolicy(
    body,
    'require_approval',
  );
  if (toolApprovalPolicy && 'error' in toolApprovalPolicy) {
    return toolApprovalPolicy;
  }
  const memoryRetentionPolicy = coerceMemoryRetentionPolicy(body, 'keep');
  if (memoryRetentionPolicy && 'error' in memoryRetentionPolicy) {
    return memoryRetentionPolicy;
  }
  return {
    workspaceId,
    name: stringValue(body, 'name'),
    defaultProjectId: stringValue(body, 'defaultProjectId'),
    identity: Object.keys(identity).length
      ? (identity as UpsertWorkspaceAgentPolicyInput['identity'])
      : undefined,
    skillIds,
    agentIds,
    knowledgeSourceIds,
    bundleIds,
    grants: capabilityPolicy.grants,
    networkPolicy: capabilityPolicy.networkPolicy,
    budgetPolicy,
    defaultChannelBudgetPolicy,
    memoryApprovalPolicy,
    toolApprovalPolicy,
    memoryRetentionPolicy,
  };
}

function coerceCapabilityBundleInput(
  body: Record<string, unknown>,
): UpsertCapabilityBundleInput | { error: string } {
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const id = (stringValue(body, 'id') || '').toLowerCase();
  const name = stringValue(body, 'name');
  if (!workspaceId || !id || !name) {
    return { error: 'capability_bundle_workspace_id_name_required' };
  }
  const rawPreset = stringValue(body, 'preset', 'custom');
  if (
    rawPreset !== 'custom' &&
    rawPreset !== 'data-readonly' &&
    rawPreset !== 'platform-monitoring' &&
    rawPreset !== 'github-write'
  ) {
    return { error: 'unsupported_capability_bundle_preset' };
  }
  const capabilityPolicy = coerceCapabilityPolicy(
    body,
    'workspace',
    `bundle:${workspaceId}:${id}`,
  );
  if ('error' in capabilityPolicy) return capabilityPolicy;
  const skillIds = skillIdArrayValue(body);
  if (skillIds && 'error' in skillIds) return skillIds;
  const agentIds = delegatedAgentIdArrayValue(body);
  if (agentIds && 'error' in agentIds) return agentIds;
  const knowledgeSourceIds = knowledgeSourceIdArrayValue(body);
  if (knowledgeSourceIds && 'error' in knowledgeSourceIds) return knowledgeSourceIds;
  return {
    workspaceId,
    id,
    name,
    description:
      typeof body.description === 'string' ? body.description : undefined,
    preset: rawPreset as CapabilityBundlePreset,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    expectedRevision: numberValue(body, 'expectedRevision'),
    skillIds,
    agentIds,
    knowledgeSourceIds,
    grants: capabilityPolicy.grants,
    networkPolicy: capabilityPolicy.networkPolicy,
  };
}

function coerceRoutineSchedule(
  body: Record<string, unknown>,
): RoutineSchedule | { error: string } {
  const schedule = recordValue(body, 'schedule') || body;
  const kind = stringValue(schedule, 'kind', 'interval');
  if (kind === 'once') {
    const at = stringValue(schedule, 'at');
    if (!at) return { error: 'routine_once_at_required' };
    return { kind, at };
  }
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

function githubThreadAddress(
  value: string,
): { repository: string; issueNumber: string } | undefined {
  const match = /^([^/#\s]+\/[^/#\s]+)#([1-9]\d*)$/u.exec(value.trim());
  return match
    ? { repository: match[1], issueNumber: match[2] }
    : undefined;
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
  const githubDestination =
    platform === 'github' ? githubThreadAddress(externalId) : undefined;
  if (platform === 'github' && !githubDestination) {
    return { error: 'github_destination_must_be_owner_repo_issue' };
  }
  const notificationInput = recordValue(body, 'notifications');
  const notificationMode = stringValue(
    notificationInput || body,
    notificationInput ? 'mode' : 'notificationMode',
  );
  if (
    notificationMode &&
    notificationMode !== 'every_result' &&
    notificationMode !== 'failures_only' &&
    notificationMode !== 'silent'
  ) {
    return { error: 'unsupported_routine_notification_mode' };
  }
  const failureThreshold = numberValue(
    notificationInput || body,
    'failureThreshold',
  );
  if (
    failureThreshold !== undefined &&
    (!Number.isInteger(failureThreshold) ||
      failureThreshold < 1 ||
      failureThreshold > 10)
  ) {
    return { error: 'routine_failure_threshold_must_be_between_1_and_10' };
  }
  return {
    id: stringValue(body, 'id'),
    workspaceId,
    projectId: stringValue(body, 'projectId'),
    name,
    instructions,
    enabled: booleanValue(body, 'enabled', true),
    schedule,
    notifications:
      notificationInput || notificationMode || failureThreshold !== undefined
        ? {
            mode: (notificationMode || 'every_result') as
              | 'every_result'
              | 'failures_only'
              | 'silent',
            failureThreshold: failureThreshold ?? 1,
            recovery: booleanValue(notificationInput || body, 'recovery', true),
          }
        : undefined,
    destination: {
      platform: platform as PlatformKind,
      externalId,
      channelId:
        githubDestination?.repository ||
        stringValue(destination, 'channelId', externalId),
      threadId: stringValue(destination, 'threadId'),
      rootMessageId:
        githubDestination?.issueNumber ||
        stringValue(destination, 'rootMessageId'),
      topicId:
        githubDestination?.issueNumber || stringValue(destination, 'topicId'),
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
  const githubDestination =
    platform === 'github' ? githubThreadAddress(externalId) : undefined;
  if (platform === 'github' && !githubDestination) {
    return { error: 'github_destination_must_be_owner_repo_issue' };
  }
  const destination: WorkflowDestination = {
    platform: platform as PlatformKind,
    externalId,
    channelId:
      githubDestination?.repository ||
      stringValue(destinationBody, 'channelId', externalId),
    threadId: stringValue(destinationBody, 'threadId'),
    rootMessageId:
      githubDestination?.issueNumber ||
      stringValue(destinationBody, 'rootMessageId'),
    topicId:
      githubDestination?.issueNumber ||
      stringValue(destinationBody, 'topicId'),
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

function coerceWorkflowProducerRouteInput(
  body: Record<string, unknown>,
): UpsertWorkflowProducerRouteInput | { error: string } {
  const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
  const projectId = stringValue(body, 'projectId');
  const name = stringValue(body, 'name');
  const kind = stringValue(body, 'kind', 'alertmanager');
  if (!workspaceId || !projectId || !name) {
    return { error: 'workflow_producer_workspace_project_name_required' };
  }
  if (kind !== 'alertmanager' && kind !== 'lark-document') {
    return { error: 'workflow_producer_kind_invalid' };
  }
  const documentId = stringValue(body, 'documentId');
  if (kind === 'lark-document' && !documentId) {
    return { error: 'workflow_producer_document_id_required' };
  }
  return {
    id: stringValue(body, 'id'),
    kind,
    workspaceId,
    projectId,
    name,
    documentId: kind === 'lark-document' ? documentId : undefined,
    pollIntervalSeconds:
      kind === 'lark-document'
        ? numberValue(body, 'pollIntervalSeconds', 60)
        : undefined,
    enabled: booleanValue(body, 'enabled', true),
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

function httpAttachmentUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizedClientMessage(
  message: Record<string, unknown>,
  fallbackAttachments: unknown,
): Record<string, unknown> {
  const result = { ...message };
  const attachments = message.attachments ?? fallbackAttachments;
  if (!Array.isArray(attachments)) return result;
  result.attachments = attachments.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const attachment = { ...(value as Record<string, unknown>) };
    delete attachment.contentBase64;
    delete attachment.localPath;
    return attachment;
  });
  return result;
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
      const requestedUrl = stringValue(body, 'url');
      const url = httpAttachmentUrl(requestedUrl);
      return {
        id,
        kind: attachmentKindValue(body.kind),
        name: stringValue(body, 'name'),
        mimeType: stringValue(body, 'mimeType'),
        sizeBytes: numberValue(body, 'sizeBytes'),
        url,
        metadata: {
          clientIngress: true,
          clientContentBase64: stringValue(body, 'contentBase64'),
          clientLocalPathRejected: Boolean(stringValue(body, 'localPath')),
          clientUrlRejected: Boolean(requestedUrl && !url),
          clientAttachmentId: stringValue(body, 'id'),
        },
      };
    })
    .filter((item): item is SourceAttachment => Boolean(item));
  return attachments.length ? attachments : undefined;
}

function larkResourceTransport(): HttpLarkTransport {
  if (!larkAppId || !larkAppSecret || larkTransportStatus().mode !== 'http') {
    throw new ManagedContentError(
      'lark_attachment_download_unavailable',
      'Lark attachments require OPENTAG_LARK_TRANSPORT=http and app credentials.',
      503,
    );
  }
  inboundLarkTransport ??= new HttpLarkTransport({
    appId: larkAppId,
    appSecret: larkAppSecret,
    domain: larkDomain,
    baseUrl: larkBaseUrl,
  });
  return inboundLarkTransport;
}

async function resolveLarkChatInfo(
  thread: SourceThread,
): Promise<LarkChatInfo | undefined> {
  if (
    thread.platform !== 'lark' ||
    thread.visibility === 'direct' ||
    !thread.channelId ||
    larkTransportStatus().mode !== 'http'
  ) {
    return undefined;
  }
  const cached = larkChatInfoCache.get(thread.channelId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const value = await larkResourceTransport().getChat(thread.channelId, {
      signal: AbortSignal.timeout(larkChatInfoTimeoutMs),
    });
    larkChatInfoCache.set(thread.channelId, {
      expiresAt: Date.now() + 6 * 60 * 60_000,
      value,
    });
    return value;
  } catch {
    larkChatInfoCache.set(thread.channelId, {
      expiresAt: Date.now() + 5 * 60_000,
    });
    return undefined;
  }
}

async function enrichLarkThreadIdentity(
  thread: SourceThread,
): Promise<SourceThread> {
  const chat = await resolveLarkChatInfo(thread);
  if (chat) return applyLarkChatInfo(thread, chat);
  if (
    thread.platform !== 'lark' ||
    thread.visibility === 'direct' ||
    !thread.channelId ||
    larkTransportStatus().mode !== 'http'
  ) {
    return thread;
  }
  return applyUnavailableLarkChatInfo(thread);
}

function telegramResourceTransport(): HttpTelegramTransport {
  if (!telegramBotToken || telegramTransportStatus().mode !== 'http') {
    throw new ManagedContentError(
      'telegram_attachment_download_unavailable',
      'Telegram attachments require OPENTAG_TELEGRAM_TRANSPORT=http and a bot token.',
      503,
    );
  }
  inboundTelegramTransport ??= new HttpTelegramTransport({
    botToken: telegramBotToken,
    baseUrl: telegramBaseUrl,
  });
  return inboundTelegramTransport;
}

function slackResourceTransport(): HttpSlackTransport {
  if (!slackBotToken || slackTransportStatus().mode !== 'http') {
    throw new ManagedContentError(
      'slack_attachment_download_unavailable',
      'Slack attachments require OPENTAG_SLACK_TRANSPORT=http and a bot token.',
      503,
    );
  }
  inboundSlackTransport ??= new HttpSlackTransport({
    botToken: slackBotToken,
    baseUrl: slackBaseUrl,
    maxUploadBytes: executorMaxArtifactBytes,
  });
  return inboundSlackTransport;
}

async function materializeMessageAttachments(input: {
  thread: SourceThread;
  message: SourceMessage;
}): Promise<SourceMessage> {
  if (!input.message.attachments?.length) return input.message;
  const attachments: SourceAttachment[] = [];
  for (const attachment of input.message.attachments) {
    if (attachment.localPath) {
      throw new ManagedContentError(
        'attachment_local_path_not_allowed',
        'Inbound clients cannot submit host local paths.',
        400,
      );
    }
    if (
      typeof attachment.metadata?.clientContentBase64 === 'string' ||
      attachment.metadata?.clientLocalPathRejected
    ) {
      attachments.push(
        await managedContentStore.materializeClientAttachment({
          thread: input.thread,
          message: input.message,
          attachment,
        }),
      );
      continue;
    }

    if (attachment.metadata?.clientIngress === true) {
      if (attachment.metadata.clientUrlRejected) {
        throw new ManagedContentError(
          'attachment_url_not_allowed',
          'Generic attachment URLs must use HTTP or HTTPS.',
          400,
        );
      }
      if (attachment.url) {
        attachments.push(attachment);
        continue;
      }
      throw new ManagedContentError(
        'attachment_content_required',
        'Generic file attachments require contentBase64 or a URL.',
        400,
      );
    }

    const larkMessageId = attachment.metadata?.larkMessageId;
    const larkFileKey = attachment.metadata?.larkFileKey;
    const larkResourceType = attachment.metadata?.larkResourceType;
    if (
      input.thread.platform === 'lark' &&
      typeof larkMessageId === 'string' &&
      typeof larkFileKey === 'string' &&
      (larkResourceType === 'file' || larkResourceType === 'image')
    ) {
      const resource = await larkResourceTransport().downloadMessageResource({
        messageId: larkMessageId,
        fileKey: larkFileKey,
        type: larkResourceType,
        maxBytes: maxAttachmentBytes,
      });
      attachments.push(
        await managedContentStore.materializeAttachment({
          thread: input.thread,
          message: input.message,
          attachment,
          bytes: resource.bytes,
          name: resource.name || attachment.name,
          mimeType: resource.mimeType || attachment.mimeType,
          source: 'lark',
        }),
      );
      continue;
    }

    const telegramFileId = attachment.metadata?.telegramFileId;
    if (input.thread.platform === 'telegram' && typeof telegramFileId === 'string') {
      const resource = await telegramResourceTransport().downloadFile({
        fileId: telegramFileId,
        maxBytes: maxAttachmentBytes,
      });
      attachments.push(
        await managedContentStore.materializeAttachment({
          thread: input.thread,
          message: input.message,
          attachment,
          bytes: resource.bytes,
          name: attachment.name || resource.name,
          mimeType: attachment.mimeType,
          source: 'telegram',
        }),
      );
      continue;
    }
    const slackDownloadUrl = attachment.metadata?.slackDownloadUrl;
    if (
      input.thread.platform === 'slack' &&
      typeof slackDownloadUrl === 'string'
    ) {
      const resource = await slackResourceTransport().downloadFile({
        url: slackDownloadUrl,
        name: attachment.name,
        mimeType: attachment.mimeType,
        expectedSizeBytes: attachment.sizeBytes,
        maxBytes: maxAttachmentBytes,
      });
      attachments.push(
        await managedContentStore.materializeAttachment({
          thread: input.thread,
          message: input.message,
          attachment,
          bytes: resource.bytes,
          name: resource.name || attachment.name,
          mimeType: resource.mimeType || attachment.mimeType,
          source: 'slack',
        }),
      );
      continue;
    }
    attachments.push(attachment);
  }
  return { ...input.message, attachments };
}

function inferredAgentMention(text: string, visibility: SourceThread['visibility']): boolean {
  return visibility === 'direct' || /^\s*(\/(?:maxtag|opentag)\b|@(?:maxtag|opentag)\b)/i.test(text);
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
      stringValue(body, 'projectId'),
    channelId,
    rootMessageId,
    topicId:
      stringValue(threadBody, 'topicId') ||
      stringValue(body, 'topicId') ||
      (platformKind === 'lark' ? undefined : rootMessageId),
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
        clientMessage: sanitizedClientMessage(
          messageBody,
          body.attachments,
        ),
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
  // The old "questions" mode guessed intent from punctuation/wording and
  // could interrupt ordinary group chat. Keep accepting its stored/API value
  // for compatibility, but normalize it to explicit mention activation.
  if (value === 'questions') return 'mention';
  return value === 'always' || value === 'mention' ? value : undefined;
}

function bindingScopeValue(
  body: Record<string, unknown>,
): ThreadBindingScope | undefined {
  const value = stringValue(body, 'scope');
  return value === 'thread' || value === 'channel' ? value : undefined;
}

function platformValue(value: unknown): PlatformKind | undefined {
  return value === 'lark' ||
    value === 'telegram' ||
    value === 'github' ||
    value === 'slack'
    ? value
    : undefined;
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
  const platform = platformValue(stringValue(body, 'platform', 'lark'));
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

interface BindingExportEntry {
  platform: PlatformKind;
  externalId: string;
  scope: ThreadBindingScope;
  channelId?: string;
  workspaceId: string;
  projectId: string;
  title?: string;
  activationMode: ThreadActivationMode;
  requireMention: boolean;
  metadata?: Record<string, unknown>;
}

interface BindingImportRowResult {
  index: number;
  input?: ConfigureThreadBindingInput;
  error?: string;
}

function bindingSourceValue(value: unknown): ThreadBindingSource | undefined {
  return value === 'observed' || value === 'configured' ? value : undefined;
}

function includeQueryFlag(url: URL, key: string): boolean {
  return url.searchParams.get(key) === 'true';
}

function bindingExportEntry(
  binding: ThreadBinding,
  includeMetadata: boolean,
): BindingExportEntry {
  const entry: BindingExportEntry = {
    platform: binding.platform,
    externalId: binding.externalId,
    scope: binding.scope ?? 'channel',
    channelId: binding.channelId,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    title: binding.title,
    activationMode: binding.activationMode,
    requireMention: binding.requireMention,
  };
  if (includeMetadata && binding.metadata) {
    entry.metadata = binding.metadata;
  }
  return entry;
}

function bindingImportPreview(
  input: ConfigureThreadBindingInput,
): BindingExportEntry {
  const scope = input.scope ?? 'channel';
  return {
    platform: input.platform,
    externalId: input.externalId,
    scope,
    channelId: input.channelId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    title: input.title,
    activationMode: input.activationMode ?? 'mention',
    requireMention: input.requireMention ?? scope !== 'thread',
  };
}

function bindingImportRows(body: Record<string, unknown>): unknown[] {
  const raw = body.bindings;
  return Array.isArray(raw) ? raw : [];
}

async function knownProjectIds(workspaceId: string): Promise<Set<string>> {
  const projects = await threadConfigStore.listProjectPolicies(workspaceId);
  const ids = new Set<string>();
  for (const project of projects) {
    ids.add(project.projectId);
    ids.add(project.id);
  }
  return ids;
}

async function resolvedProjectMemoryId(
  workspaceId: string | undefined,
  projectId: string | undefined,
): Promise<string | undefined> {
  if (!workspaceId || !projectId) return projectId;
  const projects = await threadConfigStore.listProjectPolicies(workspaceId);
  const project = projects.find(
    (item) => item.projectId === projectId || item.id === projectId,
  );
  return project?.id ?? projectId;
}

function coerceBindingImportRow(
  raw: unknown,
  index: number,
  workspaceId: string,
  projects: Set<string>,
  actor: string,
): BindingImportRowResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { index, error: 'binding_row_invalid' };
  }
  const row = raw as Record<string, unknown>;
  const rowWorkspaceId = stringValue(row, 'workspaceId', workspaceId);
  if (rowWorkspaceId !== workspaceId) {
    return { index, error: 'binding_workspace_mismatch' };
  }
  const projectId = stringValue(row, 'projectId');
  if (!projectId || !projects.has(projectId)) {
    return { index, error: 'binding_project_not_found' };
  }
  const platform = platformValue(stringValue(row, 'platform'));
  const externalId = stringValue(row, 'externalId');
  if (!platform || !externalId) {
    return { index, error: 'binding_platform_externalId_required' };
  }
  const scope = bindingScopeValue(row) ?? 'channel';
  const source = bindingSourceValue(row.source) ?? 'configured';
  if (source !== 'configured') {
    return { index, error: 'binding_source_must_be_configured' };
  }
  return {
    index,
    input: {
      platform,
      externalId,
      workspaceId,
      projectId,
      scope,
      source,
      channelId: stringValue(row, 'channelId', scope === 'channel' ? externalId : undefined),
      title: stringValue(row, 'title'),
      activationMode: activationModeValue(row) ?? 'mention',
      requireMention: booleanValue(row, 'requireMention', scope !== 'thread'),
      metadata: {
        ...(recordValue(row, 'metadata') ?? {}),
        configuredVia: 'binding-import',
        configuredBy: actor,
      },
      actor,
      reason: stringValue(row, 'reason', 'binding_import'),
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
  // A Lark group "main" conversation has one durable transcript id, while
  // rootMessageId is set to each individual top-level message id. Treating
  // that as an established topic makes every later piece of channel chatter
  // bypass mention-required activation after the first @MaxTag invocation.
  // Only a real Lark topic/thread may continue without another mention.
  if (thread.platform === 'lark') {
    return !thread.externalId.endsWith(':main') && Boolean(thread.topicId);
  }
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
    const routedThread = input.thread.projectId
      ? input.thread
      : {
          ...input.thread,
          projectId:
            (await threadConfigStore.getWorkspace(input.thread)).defaultProjectId ||
            'general',
        };
    const thread = await enrichLarkThreadIdentity(routedThread);
    return {
      thread,
      message: {
        ...input.message,
        threadId: thread.id,
      },
      establishedThreadBinding:
        establishedThreadBinding?.scope === 'thread' &&
        canUseEstablishedThreadBinding(thread)
          ? establishedThreadBinding
          : undefined,
    };
  }
  const thread = await enrichLarkThreadIdentity(
    applyBindingToThread(input.thread, binding),
  );
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
  if (input.message.mentionsAgent) return true;
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
  return !requireMention;
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
  if (!memoryCommand) return decision;
  const mutatesMemory =
    memoryCommand.kind === 'remember' || memoryCommand.kind === 'forget';
  const resolvedPolicy = await threadConfigStore.resolveThreadPolicy(input.thread);
  if (
    !memoryScopeGranted(
      resolvedPolicy.access,
      memoryCommand.scope,
      mutatesMemory ? 'write' : 'read',
    )
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

function canWriteWorkspaceMemory(
  decision?: ActorAuthorizationDecision,
): boolean {
  if (!decision) return true;
  return (
    decision.member?.role === 'owner' ||
    decision.member?.role === 'admin' ||
    decision.member?.role === 'member'
  );
}

function runCanWriteWorkspaceMemory(run: AgentRunRecord): boolean {
  return run.metadata?.workspaceMemoryWriteAllowed === true;
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
    'MaxTag access is not enabled for you in this project. Ask a workspace owner or project manager.',
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
  if (platform === 'slack') return slackRequireBinding;
  if (platform === 'github') return githubRequireBinding;
  return false;
}

function pairingFailureMessage(reason: string): string {
  if (reason === 'expired_code') return 'This pairing code has expired.';
  if (reason === 'consumed_code') return 'This pairing code has already been used.';
  if (reason === 'revoked_code') return 'This pairing code was revoked.';
  if (reason === 'actor_not_allowed') {
    return 'This pairing code is restricted to another user.';
  }
  if (reason === 'platform_mismatch') {
    return 'This pairing code belongs to another client.';
  }
  return 'This pairing code is invalid.';
}

async function sendControlMessage(
  thread: SourceThread,
  messageId: string,
  text: string,
  options?: { runId?: string },
): Promise<{ mode?: string; error?: string }> {
  try {
    const runPlatform = createPlatformForRun(thread);
    await runPlatform.platform.sendMessage(thread, text, [], {
      replyToMessageId: messageId,
      runId: options?.runId,
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
    .replace(/^@(?:maxtag|opentag|_[a-z0-9]+)\s+/iu, '');
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

function larkCardActionResponse(
  type: LarkCardActionResponse['toast']['type'],
  content: string,
  card?: Record<string, unknown>,
): LarkCardActionResponse {
  return {
    toast: { type, content },
    ...(card ? { card: { type: 'raw', data: card } } : {}),
  };
}

const MAXTAG_HISTORY_FROM_NOW_ACTION = 'maxtag.history.from_now';
const MAXTAG_HISTORY_IMPORT_30_ACTION = 'maxtag.history.import_30_days';
const MAXTAG_HISTORY_IMPORT_90_ACTION = 'maxtag.history.import_90_days';
const MAXTAG_HISTORY_IMPORT_180_ACTION = 'maxtag.history.import_180_days';
const MAXTAG_HISTORY_SELECT_PROJECT_ACTION = 'maxtag.history.select_project';
const MAXTAG_HISTORY_CREATE_PROJECT_ACTION = 'maxtag.history.create_project';

const MAXTAG_HISTORY_ACTION_DAYS = new Map<string, number>([
  [MAXTAG_HISTORY_IMPORT_30_ACTION, 30],
  [MAXTAG_HISTORY_IMPORT_90_ACTION, 90],
  [MAXTAG_HISTORY_IMPORT_180_ACTION, 180],
]);

function larkPlainText(content: string): Record<string, unknown> {
  return { tag: 'plain_text', content };
}

function buildLarkHistoryOnboardingCard(input?: {
  selected?: 'from_now' | 'history';
  historyDays?: number;
  projectId?: string;
  channelTitle?: string;
  projects?: Array<{ projectId: string; name: string }>;
}): Record<string, unknown> {
  const selected = input?.selected;
  const historyDays = input?.historyDays ?? 90;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: selected
        ? selected === 'history'
          ? `**已开始导入最近 ${historyDays} 天历史。**\n<font color="grey">任务会在后台断点续传；原消息先作为聊天档案，候选记忆仍需管理员审核。</font>`
          : '**已选择从现在开始。**\n<font color="grey">MaxTag 不会读取旧消息，之后的新对话会自动积累。</font>'
        : [
            '**这个群已经可以使用 MaxTag。**',
            `当前群：${input?.channelTitle || '本群'}`,
            `归属 Project：${input?.projectId || '当前绑定项目'}`,
            '请选择这个群从什么时候开始积累上下文；每个群独立初始化，多个群可以共享同一个 Project 的记忆和 Skills。',
          ].join('\n'),
    },
  ];
  if (!selected) {
    if (input?.projects?.length) {
      elements.push({
        tag: 'markdown',
        content: '**先确认这个群属于哪个 Project**',
      });
      for (let index = 0; index < input.projects.length; index += 2) {
        elements.push({
          tag: 'column_set',
          flex_mode: 'stretch',
          horizontal_spacing: 'small',
          columns: input.projects.slice(index, index + 2).map((project) => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [{
              tag: 'button',
              type: project.projectId === input.projectId ? 'primary' : 'default',
              size: 'small',
              text: larkPlainText(
                `${project.projectId === input.projectId ? '✓ ' : ''}${project.name}`,
              ),
              behaviors: [{
                type: 'callback',
                value: {
                  action: MAXTAG_HISTORY_SELECT_PROJECT_ACTION,
                  project_id: project.projectId,
                },
              }],
            }],
          })),
        });
      }
    }
    elements.push({
      tag: 'input',
      element_id: 'new_project_name',
      width: 'fill',
      max_length: 80,
      input_type: 'text',
      label: larkPlainText('新建 Project（输入名称后点击右侧发送）'),
      placeholder: larkPlainText('例如：移动端重构'),
      behaviors: [{
        type: 'callback',
        value: { action: MAXTAG_HISTORY_CREATE_PROJECT_ACTION },
      }],
    });
    elements.push({
      tag: 'markdown',
      content: '**再选择这个群从什么时候开始积累上下文**',
    });
    elements.push({
      tag: 'column_set',
      flex_mode: 'stretch',
      horizontal_spacing: 'small',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{
            tag: 'button',
            type: 'default',
            size: 'small',
            text: larkPlainText('从现在开始'),
            behaviors: [{ type: 'callback', value: { action: MAXTAG_HISTORY_FROM_NOW_ACTION } }],
          }],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{
            tag: 'button',
            type: 'default',
            size: 'small',
            text: larkPlainText('导入最近 30 天'),
            behaviors: [{ type: 'callback', value: { action: MAXTAG_HISTORY_IMPORT_30_ACTION } }],
            confirm: {
              title: larkPlainText('导入这个群的历史？'),
              text: larkPlainText('MaxTag 会读取最近 30 天消息并提炼待审核记忆；不会自动写入长期记忆。'),
            },
          }],
        },
      ],
    });
    elements.push({
      tag: 'column_set',
      flex_mode: 'stretch',
      horizontal_spacing: 'small',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{
            tag: 'button',
            type: 'primary',
            size: 'small',
            text: larkPlainText('导入最近 90 天'),
            behaviors: [{ type: 'callback', value: { action: MAXTAG_HISTORY_IMPORT_90_ACTION } }],
            confirm: {
              title: larkPlainText('导入这个群的历史？'),
              text: larkPlainText('MaxTag 会读取最近 90 天消息并提炼待审核记忆；不会自动写入长期记忆。'),
            },
          }],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{
            tag: 'button',
            type: 'default',
            size: 'small',
            text: larkPlainText('导入最近 180 天'),
            behaviors: [{ type: 'callback', value: { action: MAXTAG_HISTORY_IMPORT_180_ACTION } }],
            confirm: {
              title: larkPlainText('导入这个群的历史？'),
              text: larkPlainText('MaxTag 会读取最近 180 天消息并提炼待审核记忆；不会自动写入长期记忆。'),
            },
          }],
        },
      ],
    });
    elements.push({
      tag: 'markdown',
      content: '<font color="grey">需要指定日期时，可在 MaxTag 平台使用“自定义时间”。初始化完成后，可为 Project 启用绘图、文档分析等 Skills，绑定到该 Project 的群会共同复用。</font>',
    });
  }
  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward_interaction: false,
      summary: { content: 'MaxTag · 群聊接入' },
    },
    header: {
      title: larkPlainText('MaxTag'),
      subtitle: larkPlainText(selected ? '群聊接入已完成' : '首次接入'),
      template: selected === 'history' ? 'blue' : selected ? 'green' : 'wathet',
      icon: { tag: 'standard_icon', token: selected ? 'yes_outlined' : 'history_outlined' },
    },
    body: { direction: 'vertical', padding: '12px 16px 14px 16px', elements },
  };
}

function larkHistoryImportProgress(job: LarkHistoryImportJobRecord): number {
  if (job.status === 'completed') return 100;
  if (!job.since || !job.until || !job.cursor?.windowSince) return 0;
  const start = Date.parse(job.since);
  const end = Date.parse(job.until);
  const current = Date.parse(job.cursor.windowSince);
  if (![start, end, current].every(Number.isFinite) || end <= start) return 0;
  return Math.max(0, Math.min(99, Math.floor(((current - start) / (end - start)) * 100)));
}

function larkHistoryImportError(lastError?: string): string | undefined {
  if (!lastError) return undefined;
  if (lastError.includes('im:message.group_msg')) {
    return '缺少飞书权限 `im:message.group_msg`。请在开放平台添加权限并发布应用版本；MaxTag 会自动重试。';
  }
  if (lastError === 'codex_no_final_response') {
    return '聊天记录已归档；本轮没有提炼出候选记忆，可安全重试提炼。';
  }
  return lastError.replace(/[\0\r\n]+/gu, ' ').trim().slice(0, 240);
}

function buildLarkHistoryImportStatusCard(
  job: LarkHistoryImportJobRecord,
): Record<string, unknown> {
  const progress = larkHistoryImportProgress(job);
  const terminal = job.status === 'completed' || job.status === 'failed';
  const status = job.status === 'completed'
    ? '导入完成'
    : job.status === 'failed'
      ? '导入失败'
      : job.status === 'claimed'
        ? '正在导入'
        : job.lastError
          ? '等待重试'
          : '排队中';
  const barLength = 10;
  const filled = Math.round((progress / 100) * barLength);
  const progressBar = `${'█'.repeat(filled)}${'░'.repeat(barLength - filled)}`;
  const error = larkHistoryImportError(job.lastError);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: [
        `**${status} · ${progress}%**`,
        `\`${progressBar}\``,
        `Project：${job.projectId}`,
        `扫描 ${job.scannedMessages} 条 · 导入 ${job.importedMessages} 条 · 重复 ${job.duplicateMessages} 条`,
        `已发现 ${job.discoveredThreads} 个话题 · 待审核记忆 ${job.proposalIds.length} 条`,
        `尝试 ${job.attempts}/${job.maxAttempts}`,
      ].join('\n'),
    },
  ];
  if (error) {
    elements.push({
      tag: 'markdown',
      content: `<font color="${job.status === 'failed' ? 'red' : 'orange'}">${error}</font>`,
    });
  }
  elements.push({
    tag: 'markdown',
    content: terminal
      ? '<font color="grey">这是本次历史初始化的最终结果，可在 MaxTag「记忆」页面审核候选记忆。</font>'
      : '<font color="grey">本卡片会随后台任务自动更新；无需停留在页面。</font>',
  });
  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward_interaction: false,
      summary: { content: `MaxTag · 历史初始化 ${status}` },
    },
    header: {
      title: larkPlainText('MaxTag'),
      subtitle: larkPlainText('群聊历史初始化'),
      template: job.status === 'completed'
        ? 'green'
        : job.status === 'failed'
          ? 'red'
          : job.lastError
            ? 'orange'
            : 'blue',
      icon: {
        tag: 'standard_icon',
        token: job.status === 'completed'
          ? 'yes_outlined'
          : job.status === 'failed'
            ? 'warning_outlined'
            : 'history_outlined',
      },
    },
    body: { direction: 'vertical', padding: '12px 16px 14px 16px', elements },
  };
}

async function updateLarkHistoryImportStatusCard(
  job: LarkHistoryImportJobRecord,
): Promise<void> {
  if (!job.cardMessageId) return;
  await larkResourceTransport().updateCard({
    cardId: job.cardMessageId,
    card: buildLarkHistoryImportStatusCard(job),
    metadata: { thread: job.thread, stage: 'onboarding-card' },
  });
}

async function refreshActiveLarkHistoryImportStatusCards(): Promise<void> {
  const jobs = await deliveryStore.listLarkHistoryImports({ limit: 500 });
  await Promise.allSettled(
    jobs
      .filter((job) =>
        Boolean(job.cardMessageId) &&
        (job.status === 'pending' || job.status === 'claimed'),
      )
      .map((job) => updateLarkHistoryImportStatusCard(job)),
  );
}

function larkProjectIdForName(
  name: string,
  existingProjectIds: Set<string>,
): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 54);
  let candidate = base || `project-${randomUUID().slice(0, 8)}`;
  while (existingProjectIds.has(candidate)) {
    candidate = `${base || 'project'}-${randomUUID().slice(0, 8)}`.slice(0, 63);
  }
  return candidate;
}

async function bindLarkHistoryOnboardingProject(
  job: LarkHistoryImportJobRecord,
  action: LarkCardAction,
  projectId: string,
): Promise<LarkHistoryImportJobRecord | undefined> {
  const currentBinding = await deliveryStore.getThreadBindingForThread({
    platform: 'lark',
    externalId: job.channelId,
    channelId: job.channelId,
  });
  await deliveryStore.configureThreadBinding({
    platform: 'lark',
    externalId: job.channelId,
    scope: 'channel',
    source: 'configured',
    channelId: job.channelId,
    workspaceId: job.workspaceId,
    projectId,
    title: job.channelTitle,
    activationMode: currentBinding?.activationMode ?? 'mention',
    requireMention: currentBinding?.requireMention ?? true,
    actor: `lark:${action.actorId}`,
    reason: 'lark_history_onboarding_project_selected',
    metadata: {
      ...currentBinding?.metadata,
      historyImportJobId: job.id,
      configuredBy: `lark:${action.actorId}`,
    },
  });
  return deliveryStore.updateLarkHistoryImportOnboarding(job.id, {
    projectId,
    cardMessageId: action.cardMessageId,
  });
}

async function larkHistoryProjectOptions(
  workspaceId: string,
  selectedProjectId: string,
): Promise<Array<{ projectId: string; name: string }>> {
  const policies = await threadConfigStore.listProjectPolicies(workspaceId);
  const projects = new Map(
    policies.map((policy) => [
      policy.projectId,
      { projectId: policy.projectId, name: policy.name || policy.projectId },
    ]),
  );
  if (!projects.has(selectedProjectId)) {
    projects.set(selectedProjectId, { projectId: selectedProjectId, name: selectedProjectId });
  }
  return [...projects.values()]
    .sort((left, right) => {
      if (left.projectId === selectedProjectId && right.projectId !== selectedProjectId) {
        return -1;
      }
      if (right.projectId === selectedProjectId && left.projectId !== selectedProjectId) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, 8);
}

async function handleLarkHistoryOnboardingAction(
  action: LarkCardAction,
  inboundEventId: string,
): Promise<LarkCardActionResponse> {
  const receipt = await deliveryStore.getDeliveredOutboundByExternalId({
    platform: 'lark',
    externalId: action.cardMessageId,
    kind: 'lark.card.create',
  });
  if (
    !receipt ||
    receipt.target.chatId !== action.chatId ||
    receipt.payload.stage !== 'onboarding-card'
  ) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'invalid_lark_history_onboarding_receipt',
      { metadata: { actorId: action.actorId, cardMessageId: action.cardMessageId } },
    );
    return larkCardActionResponse('warning', '这张接入卡已不可用。');
  }
  const jobs = await deliveryStore.listLarkHistoryImports({
    channelId: action.chatId,
    limit: 20,
  });
  const job = jobs.find((item) => item.status === 'awaiting_choice') || jobs[0];
  if (!job) {
    return larkCardActionResponse('warning', '没有找到对应的群聊接入记录。');
  }
  if (job.status !== 'awaiting_choice') {
    const completedCard = job.mode === 'from_now'
      ? buildLarkHistoryOnboardingCard({
          selected: 'from_now',
          projectId: job.projectId,
          channelTitle: job.channelTitle,
        })
      : buildLarkHistoryImportStatusCard(job);
    return larkCardActionResponse(
      'info',
      '这个群已经完成过初始化选择。',
      completedCard,
    );
  }
  const authorization = await accessStore.authorize({
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    platform: 'lark',
    actor: { id: action.actorId, platformUserId: action.actorId },
    capability: 'invoke_agent',
  });
  const managedMembership = Boolean(
    authorization.member || authorization.projectMembership,
  );
  const mayInitialize =
    authorization.allowed &&
    (!managedMembership ||
      authorization.member?.role === 'owner' ||
      authorization.member?.role === 'admin' ||
      authorization.projectMembership?.role === 'manager');
  if (!mayInitialize) {
    await deliveryStore.markInboundEventIgnored(inboundEventId, 'lark_history_import_admin_required', {
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      threadId: job.thread.id,
      metadata: { actorId: action.actorId, authorization: actorAuthorizationPayload(authorization) },
    });
    return larkCardActionResponse('error', '请由公司管理员或项目管理员完成历史初始化。');
  }
  if (action.action === MAXTAG_HISTORY_SELECT_PROJECT_ACTION) {
    const projects = await threadConfigStore.listProjectPolicies(job.workspaceId);
    const target = projects.find(
      (project) =>
        project.projectId === action.projectId || project.id === action.projectId,
    );
    if (!target) {
      return larkCardActionResponse('error', '目标 Project 不存在或已停用。');
    }
    const targetAuthorization = await accessStore.authorize({
      workspaceId: job.workspaceId,
      projectId: target.projectId,
      platform: 'lark',
      actor: { id: action.actorId, platformUserId: action.actorId },
      capability: 'invoke_agent',
    });
    const targetManagedMembership = Boolean(
      targetAuthorization.member || targetAuthorization.projectMembership,
    );
    const maySelectTarget =
      targetAuthorization.allowed &&
      (!targetManagedMembership ||
        targetAuthorization.member?.role === 'owner' ||
        targetAuthorization.member?.role === 'admin' ||
        targetAuthorization.projectMembership?.role === 'manager');
    if (!maySelectTarget) {
      return larkCardActionResponse('error', '你没有管理目标 Project 的权限。');
    }
    const updated = await bindLarkHistoryOnboardingProject(
      job,
      action,
      target.projectId,
    );
    if (!updated || updated.status !== 'awaiting_choice') {
      return larkCardActionResponse('warning', '群聊接入状态已变化，请刷新后重试。');
    }
    // Return the replacement card in the callback response instead of waiting
    // for a second Lark API request. Card callbacks must finish within three
    // seconds; the external update previously pushed successful bindings over
    // that limit and made Lark show error 200341 even though state was saved.
    const responseCard = buildLarkHistoryOnboardingCard({
      projectId: updated.projectId,
      channelTitle: updated.channelTitle,
      projects: await larkHistoryProjectOptions(
        updated.workspaceId,
        updated.projectId,
      ),
    });
    await deliveryStore.markInboundEventProcessed(inboundEventId, {
      workspaceId: updated.workspaceId,
      projectId: updated.projectId,
      threadId: updated.thread.id,
      messageId: action.cardMessageId,
      metadata: {
        control: 'lark_history_project_selected',
        actorId: action.actorId,
        historyImportJobId: updated.id,
      },
    });
    return larkCardActionResponse(
      'success',
      `已切换到 Project：${target.name}。`,
      responseCard,
    );
  }
  if (action.action === MAXTAG_HISTORY_CREATE_PROJECT_ACTION) {
    const mayCreateProject =
      authorization.allowed &&
      (!managedMembership ||
        authorization.member?.role === 'owner' ||
        authorization.member?.role === 'admin');
    if (!mayCreateProject) {
      return larkCardActionResponse('error', '请由公司 Owner 或管理员新建 Project。');
    }
    const projectName = (action.inputValue || '')
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!projectName) {
      return larkCardActionResponse('warning', '请输入 Project 名称。');
    }
    if (
      Array.from(projectName).length > 80 ||
      /[\u0000-\u001f\u007f]/u.test(projectName)
    ) {
      return larkCardActionResponse('error', 'Project 名称需为 1–80 个可见字符。');
    }
    const projects = await threadConfigStore.listProjectPolicies(job.workspaceId);
    const duplicate = projects.find(
      (project) =>
        project.name.normalize('NFKC').toLocaleLowerCase() ===
        projectName.toLocaleLowerCase(),
    );
    if (duplicate) {
      return larkCardActionResponse('warning', `Project「${duplicate.name}」已存在，请直接选择。`);
    }
    const projectId = larkProjectIdForName(
      projectName,
      new Set(projects.map((project) => project.projectId)),
    );
    const created = await threadConfigStore.upsertProjectPolicy({
      workspaceId: job.workspaceId,
      projectId,
      name: projectName,
      agentMode: 'inherit',
      capabilityMode: 'inherit',
      memoryMode: 'workspace',
      actor: `lark:${action.actorId}`,
    });
    const updated = await bindLarkHistoryOnboardingProject(
      job,
      action,
      created.projectId,
    );
    if (!updated || updated.status !== 'awaiting_choice') {
      return larkCardActionResponse('warning', 'Project 已创建，但群聊接入状态已变化。');
    }
    const responseCard = buildLarkHistoryOnboardingCard({
      projectId: updated.projectId,
      channelTitle: updated.channelTitle,
      projects: await larkHistoryProjectOptions(
        updated.workspaceId,
        updated.projectId,
      ),
    });
    await deliveryStore.markInboundEventProcessed(inboundEventId, {
      workspaceId: updated.workspaceId,
      projectId: updated.projectId,
      threadId: updated.thread.id,
      messageId: action.cardMessageId,
      metadata: {
        control: 'lark_history_project_created',
        actorId: action.actorId,
        historyImportJobId: updated.id,
        createdProjectId: created.projectId,
      },
    });
    return larkCardActionResponse(
      'success',
      `已创建并绑定 Project：${created.name}。`,
      responseCard,
    );
  }
  const historyDays = MAXTAG_HISTORY_ACTION_DAYS.get(action.action);
  const history = typeof historyDays === 'number';
  const until = new Date();
  const configured = await deliveryStore.configureLarkHistoryImport(job.id, {
    mode: history ? 'history' : 'from_now',
    since: history
      ? new Date(until.getTime() - historyDays * 24 * 60 * 60_000)
      : undefined,
    until: history ? until : undefined,
    analyzeMemory: true,
    requestedBy: `lark:${action.actorId}`,
    cardMessageId: action.cardMessageId,
  });
  if (!configured) {
    return larkCardActionResponse('warning', '群聊接入状态已变化，请刷新后重试。');
  }
  const responseCard = buildLarkHistoryOnboardingCard({
    selected: history ? 'history' : 'from_now',
    historyDays,
    projectId: job.projectId,
    channelTitle: job.channelTitle,
  });
  await deliveryStore.markInboundEventProcessed(inboundEventId, {
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    threadId: job.thread.id,
    messageId: action.cardMessageId,
    metadata: {
      control: history ? 'lark_history_import_90_days' : 'lark_history_from_now',
      actorId: action.actorId,
      historyImportJobId: job.id,
    },
  });
  if (history) {
    setTimeout(() => {
      void larkHistoryImportService.runPass().catch((error) => {
        console.error('MaxTag Lark history import pass failed', error);
      });
    }, 0).unref?.();
  }
  return larkCardActionResponse(
    'success',
    history ? `已开始后台导入最近 ${historyDays} 天历史。` : '已从现在开始使用。',
    responseCard,
  );
}

function threadActivationModeLabel(
  mode: 'mention' | 'questions' | 'always',
): string {
  if (mode === 'always') return '持续响应';
  if (mode === 'questions') return '回答明确问题';
  return '仅被 @ 时';
}

async function handleLarkThreadActivationAction(
  action: LarkCardAction & {
    activationMode: 'mention' | 'questions' | 'always';
  },
  inboundEventId: string,
): Promise<LarkCardActionResponse> {
  const receipt = await deliveryStore.getDeliveredOutboundByExternalId({
    platform: 'lark',
    externalId: action.cardMessageId,
    kind: 'lark.card.create',
  });
  const run = receipt?.runId
    ? await deliveryStore.getAgentRun(receipt.runId)
    : undefined;
  const validReceipt = Boolean(
    receipt &&
      receipt.payload.stage === 'thread-status-card' &&
      run?.thread &&
      run.platform === 'lark' &&
      receipt.threadId === run.threadId &&
      receipt.workspaceId === run.workspaceId &&
      receipt.projectId === run.projectId &&
      receipt.target.chatId === action.chatId &&
      run.thread.channelId === action.chatId,
  );
  if (!validReceipt || !run?.thread) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'invalid_lark_thread_status_receipt',
      {
        metadata: {
          action: action.action,
          actorId: action.actorId,
          cardMessageId: action.cardMessageId,
          activationMode: action.activationMode,
          receiptId: receipt?.id,
        },
      },
    );
    return larkCardActionResponse('warning', '这张设置卡已失效，请重新发送「@MaxTag 状态」。');
  }

  const authorization = await accessStore.authorize({
    workspaceId: run.thread.workspaceId || 'dev-workspace',
    projectId: run.thread.projectId || run.thread.channelId || 'general',
    platform: 'lark',
    actor: { id: action.actorId, platformUserId: action.actorId },
    capability: 'manage_routines',
  });
  const workspaceManager =
    authorization.member?.status === 'active' &&
    (authorization.member.role === 'owner' ||
      authorization.member.role === 'admin');
  const projectManager =
    authorization.member?.status === 'active' &&
    authorization.projectMembership?.role === 'manager';
  if (!authorization.allowed || (!workspaceManager && !projectManager)) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'actor_not_authorized',
      {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        threadId: run.threadId,
        messageId: action.cardMessageId,
        metadata: {
          control: 'thread_activation',
          actorId: action.actorId,
          activationMode: action.activationMode,
          authorization: actorAuthorizationPayload(authorization),
        },
      },
    );
    return larkCardActionResponse('error', '只有工作区管理员或 Project 管理员可以修改响应方式。');
  }

  const existing = await deliveryStore.getThreadBindingForThread(run.thread);
  const configured = await deliveryStore.configureThreadBinding({
    platform: run.thread.platform,
    externalId: existing?.externalId || run.thread.externalId,
    workspaceId: run.thread.workspaceId || existing?.workspaceId || 'dev-workspace',
    projectId:
      run.thread.projectId ||
      existing?.projectId ||
      run.thread.channelId ||
      'general',
    scope:
      existing?.scope ||
      (run.thread.topicId || run.thread.rootMessageId ? 'thread' : 'channel'),
    source: 'configured',
    channelId: run.thread.channelId || existing?.channelId,
    title: existing?.title || run.thread.title,
    activationMode: action.activationMode,
    requireMention: action.activationMode !== 'always',
    metadata: existing?.metadata || run.thread.metadata,
    actor: `lark:${action.actorId}`,
    reason: 'thread_status_card_activation_change',
  });
  const commandResult = await threadStatusService.execute(
    { kind: 'status' },
    run.thread,
    actorAuthorizationPayload(authorization),
  );
  const transport = new TrackedLarkTransport(
    createLarkTransportForRun().transport,
    deliveryStore,
  );
  await transport.updateCard({
    cardId: action.cardMessageId,
    card: commandResult.card,
    metadata: {
      runId: run.id,
      thread: run.thread,
      stage: 'thread-status-card',
    },
  });
  await deliveryStore.markInboundEventProcessed(inboundEventId, {
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    threadId: run.threadId,
    messageId: action.cardMessageId,
    metadata: {
      control: 'thread_activation',
      actorId: action.actorId,
      activationMode: action.activationMode,
      bindingId: configured.id,
      receiptId: receipt!.id,
      authorization: actorAuthorizationPayload(authorization),
    },
  });
  return larkCardActionResponse(
    'success',
    `响应方式已切换为「${threadActivationModeLabel(action.activationMode)}」。`,
  );
}

async function handleLarkCardAction(
  body: LarkIncomingEvent & Record<string, unknown>,
  inboundEventId: string,
): Promise<LarkCardActionResponse> {
  const action = normalizeLarkCardAction(body);
  if (
    action?.approvalId &&
    (action.action === OPENTAG_APPROVE_TOOL_ACTION ||
      action.action === OPENTAG_REJECT_TOOL_ACTION)
  ) {
    return handleLarkToolApprovalAction(action, inboundEventId);
  }
  if (
    action?.proposalId &&
    (action.action === OPENTAG_APPROVE_MEMORY_PROPOSAL_ACTION ||
      action.action === OPENTAG_REJECT_MEMORY_PROPOSAL_ACTION)
  ) {
    return handleLarkMemoryProposalAction(action, inboundEventId);
  }
  if (
    action &&
    (action.action === MAXTAG_HISTORY_FROM_NOW_ACTION ||
      action.action === MAXTAG_HISTORY_SELECT_PROJECT_ACTION ||
      action.action === MAXTAG_HISTORY_CREATE_PROJECT_ACTION ||
      MAXTAG_HISTORY_ACTION_DAYS.has(action.action))
  ) {
    return handleLarkHistoryOnboardingAction(action, inboundEventId);
  }
  if (
    action?.action === OPENTAG_SET_THREAD_ACTIVATION_ACTION &&
    action.activationMode
  ) {
    return handleLarkThreadActivationAction(
      action as LarkCardAction & {
        activationMode: 'mention' | 'questions' | 'always';
      },
      inboundEventId,
    );
  }
  const isStopAction = action?.action === OPENTAG_STOP_RUN_ACTION;
  const isTakeOverAction = action?.action === OPENTAG_TAKE_OVER_RUN_ACTION;
  if (!action || (!isStopAction && !isTakeOverAction) || !action.runId) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'unsupported_lark_card_action',
      {
        metadata: {
          action: action?.action,
          actorId: action?.actorId,
          cardMessageId: action?.cardMessageId,
          requestedRunId: action?.runId,
        },
      },
    );
    return larkCardActionResponse('warning', 'This action is no longer available.');
  }
  const control = isTakeOverAction ? 'human_takeover' : 'stop';
  const actionLabel = isTakeOverAction ? 'take over' : 'stop';

  const receipt = await deliveryStore.getDeliveredOutboundByExternalId({
    platform: 'lark',
    externalId: action.cardMessageId,
    kind: 'lark.card.create',
  });
  const run = receipt?.runId
    ? await deliveryStore.getAgentRun(receipt.runId)
    : undefined;
  const runChatId = run?.thread?.channelId;
  const validReceipt = Boolean(
    receipt &&
      run?.thread &&
      run.platform === 'lark' &&
      action.runId === receipt.runId &&
      action.runId === run.id &&
      receipt.threadId === run.threadId &&
      receipt.workspaceId === run.workspaceId &&
      receipt.projectId === run.projectId &&
      receipt.target.chatId === action.chatId &&
      runChatId === action.chatId,
  );
  if (!validReceipt || !run?.thread) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'invalid_lark_card_receipt',
      {
        workspaceId: receipt?.workspaceId,
        projectId: receipt?.projectId,
        threadId: receipt?.threadId,
        metadata: {
          action: action.action,
          actorId: action.actorId,
          cardMessageId: action.cardMessageId,
          requestedRunId: action.runId,
          receiptId: receipt?.id,
        },
      },
    );
    return larkCardActionResponse('warning', 'This action is no longer available.');
  }

  const decision = await authorizeRoutedMessage({
    thread: run.thread,
    message: {
      id: `lark-card:${inboundEventId}`,
      threadId: run.thread.id,
      platform: 'lark',
      text: isTakeOverAction ? '/takeover' : '/stop',
      actor: {
        id: action.actorId,
        platformUserId: action.actorId,
      },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
      metadata: {
        ingress: 'lark-card-action',
        cardMessageId: action.cardMessageId,
        runId: run.id,
      },
    },
  });
  if (!decision.allowed) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'actor_not_authorized',
      {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        threadId: run.threadId,
        messageId: action.cardMessageId,
        metadata: {
          control,
          ingress: 'lark-card-action',
          actorId: action.actorId,
          runId: run.id,
          cardMessageId: action.cardMessageId,
          authorization: actorAuthorizationPayload(decision),
        },
      },
    );
    return larkCardActionResponse(
      'error',
      `You do not have permission to ${actionLabel} this task.`,
    );
  }

  if (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled' ||
    run.status === 'cancel_requested'
  ) {
    await deliveryStore.markInboundEventProcessed(inboundEventId, {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      threadId: run.threadId,
      messageId: action.cardMessageId,
      metadata: {
        control,
        ingress: 'lark-card-action',
        actorId: action.actorId,
        runId: run.id,
        cardMessageId: action.cardMessageId,
        alreadyFinished: true,
      },
    });
    return larkCardActionResponse('info', 'This task has already finished.');
  }

  const reason = `lark-card:${action.actorId}:${action.cardMessageId}:${control}`;
  const authorization = actorAuthorizationPayload(decision);
  const cancelled = await deliveryStore.cancelActiveAgentRunsForThread(
    run.thread,
    reason,
    {
      runId: run.id,
      humanTakeover: isTakeOverAction
        ? {
            actorId: action.actorId,
            actorDisplayName: decision.member?.displayName,
            cardMessageId: action.cardMessageId,
            receiptId: receipt!.id,
            authorization,
          }
        : undefined,
    },
  );
  if (!cancelled.runs.length) {
    await deliveryStore.markInboundEventProcessed(inboundEventId, {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      threadId: run.threadId,
      messageId: action.cardMessageId,
      metadata: {
        control,
        ingress: 'lark-card-action',
        actorId: action.actorId,
        runId: run.id,
        cardMessageId: action.cardMessageId,
        alreadyFinished: true,
        racedWithCompletion: true,
      },
    });
    return larkCardActionResponse('info', 'This task has already finished.');
  }
  await deliveryStore.cancelOutbox({ runId: run.id, reason });
  activeRuns.get(run.id)?.abort(reason);
  const handoff = isTakeOverAction
    ? await sendControlMessage(
        run.thread,
        sourceReplyMessageId(run.message) || action.cardMessageId,
        `${decision.member?.displayName || 'A project member'} took over this task. MaxTag stopped the active run${
          cancelled.steering.length
            ? ` and cleared ${cancelled.steering.length} queued follow-up${
                cancelled.steering.length === 1 ? '' : 's'
              }`
            : ''
        }.`,
        { runId: run.id },
      )
    : undefined;
  await deliveryStore.markInboundEventProcessed(inboundEventId, {
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    threadId: run.threadId,
    messageId: action.cardMessageId,
    metadata: {
      control,
      ingress: 'lark-card-action',
      actorId: action.actorId,
      runId: run.id,
      cardMessageId: action.cardMessageId,
      receiptId: receipt!.id,
      runIds: cancelled.runs.map((item) => item.id),
      steeringIds: cancelled.steering.map((item) => item.id),
      authorization,
      handoff,
    },
  });
  return isTakeOverAction
    ? larkCardActionResponse('success', 'Task handed over to you.')
    : larkCardActionResponse('success', 'Cancellation requested.');
}

async function authorizeLarkMemoryProposalDecision(input: {
  proposal: MemoryProposal;
  actorId: string;
}): Promise<{
  allowed: boolean;
  authorization: ActorAuthorizationDecision;
  approvalRole?: 'workspace-owner' | 'workspace-admin' | 'project-manager';
}> {
  const workspaceId =
    input.proposal.scopeRef.workspaceId ||
    input.proposal.thread.workspaceId ||
    'dev-workspace';
  const projectId =
    input.proposal.scopeRef.projectId ||
    input.proposal.thread.projectId ||
    input.proposal.thread.channelId ||
    'general';
  const authorization = await accessStore.authorize({
    workspaceId,
    projectId,
    platform: 'lark',
    actor: {
      id: input.actorId,
      platformUserId: input.actorId,
    },
    capability: 'write_memory',
  });
  const workspaceRole = authorization.member?.role;
  if (
    authorization.allowed &&
    authorization.member?.status === 'active' &&
    (workspaceRole === 'owner' || workspaceRole === 'admin')
  ) {
    return {
      allowed: true,
      authorization,
      approvalRole:
        workspaceRole === 'owner' ? 'workspace-owner' : 'workspace-admin',
    };
  }
  if (
    !authorization.allowed ||
    !authorization.member ||
    authorization.member.status !== 'active' ||
    input.proposal.scope === 'workspace' ||
    input.proposal.scope === 'global'
  ) {
    return { allowed: false, authorization };
  }
  const access = await accessStore.snapshot(workspaceId);
  const isProjectManager = access.projectMemberships.some(
    (membership) =>
      membership.projectId === projectId &&
      membership.memberId === authorization.member?.id &&
      membership.role === 'manager',
  );
  return {
    allowed: isProjectManager,
    authorization,
    approvalRole: isProjectManager ? 'project-manager' : undefined,
  };
}

async function authorizeLarkToolApprovalDecision(input: {
  approval: ToolApprovalRecord;
  actorId: string;
}): Promise<{
  allowed: boolean;
  authorization: ActorAuthorizationDecision;
  approvalRole?: 'workspace-owner' | 'workspace-admin' | 'project-manager';
}> {
  const workspaceId = input.approval.workspaceId || 'dev-workspace';
  const projectId =
    input.approval.projectId || input.approval.channelId || 'general';
  const authorization = await accessStore.authorize({
    workspaceId,
    projectId,
    platform: 'lark',
    actor: { id: input.actorId, platformUserId: input.actorId },
    capability: 'invoke_agent',
  });
  const workspaceRole = authorization.member?.role;
  if (
    authorization.allowed &&
    authorization.member?.status === 'active' &&
    (workspaceRole === 'owner' || workspaceRole === 'admin')
  ) {
    return {
      allowed: true,
      authorization,
      approvalRole:
        workspaceRole === 'owner' ? 'workspace-owner' : 'workspace-admin',
    };
  }
  if (
    !authorization.allowed ||
    !authorization.member ||
    authorization.member.status !== 'active'
  ) {
    return { allowed: false, authorization };
  }
  const access = await accessStore.snapshot(workspaceId);
  const isProjectManager = access.projectMemberships.some(
    (membership) =>
      membership.projectId === projectId &&
      membership.memberId === authorization.member?.id &&
      membership.role === 'manager',
  );
  return {
    allowed: isProjectManager,
    authorization,
    approvalRole: isProjectManager ? 'project-manager' : undefined,
  };
}

function matchesToolApprovalDecision(
  action: string,
  status: ToolApprovalStatus,
): boolean {
  if (action === OPENTAG_APPROVE_TOOL_ACTION || action === 'approve') {
    return ['approved', 'executing', 'succeeded', 'failed'].includes(status);
  }
  if (action === OPENTAG_REJECT_TOOL_ACTION || action === 'reject') {
    return status === 'rejected';
  }
  return false;
}

async function updateDeliveredToolApprovalCard(
  approval: ToolApprovalRecord,
): Promise<string | undefined> {
  const receipt = (
    await deliveryStore.listOutbox({
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
  if (!receipt?.externalId) return undefined;
  const runPlatform = createPlatformForRun(approval.thread);
  if (!runPlatform.larkAdapter) return undefined;
  await runPlatform.larkAdapter.updateToolApprovalCard({
    thread: approval.thread,
    approval,
    cardId: receipt.externalId,
    runId: approval.runId,
  });
  return receipt.externalId;
}

async function handleLarkToolApprovalAction(
  action: LarkCardAction,
  inboundEventId: string,
): Promise<LarkCardActionResponse> {
  const approval = action.approvalId
    ? await deliveryStore.getToolApproval(action.approvalId)
    : undefined;
  const receipt = await deliveryStore.getDeliveredOutboundByExternalId({
    platform: 'lark',
    externalId: action.cardMessageId,
    kind: 'lark.card.create',
  });
  const validReceipt = Boolean(
    approval &&
      approval.thread.platform === 'lark' &&
      receipt &&
      receipt.payload.stage === 'tool-approval-card' &&
      receipt.payload.approvalId === approval.id &&
      receipt.runId === approval.runId &&
      receipt.threadId === approval.thread.id &&
      receipt.workspaceId === approval.workspaceId &&
      receipt.projectId === approval.projectId &&
      receipt.target.chatId === action.chatId &&
      (approval.thread.channelId || approval.thread.externalId) === action.chatId,
  );
  if (!approval || !receipt || !validReceipt) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'invalid_lark_tool_approval_receipt',
    );
    return larkCardActionResponse('warning', 'This approval is no longer available.');
  }
  const authorization = await authorizeLarkToolApprovalDecision({
    approval,
    actorId: action.actorId,
  });
  if (!authorization.allowed) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'actor_not_authorized',
      {
        workspaceId: approval.workspaceId,
        projectId: approval.projectId,
        threadId: approval.threadId,
        messageId: action.cardMessageId,
        metadata: {
          control: 'tool-approval-decision',
          actorId: action.actorId,
          approvalId: approval.id,
          authorization: actorAuthorizationPayload(authorization.authorization),
        },
      },
    );
    return larkCardActionResponse(
      'error',
      'Only a workspace owner, admin, or project manager can decide this operation.',
    );
  }

  const actorId = `lark:${action.actorId}`;
  let decided: ToolApprovalRecord;
  let executed = false;
  try {
    if (action.action === OPENTAG_REJECT_TOOL_ACTION) {
      decided = await deliveryStore.rejectToolApproval({
        id: approval.id,
        actorId,
      });
      await deliveryStore.appendAgentRunEvent(
        decided.runId,
        'tool_approval',
        agentRunEventSummary({ type: 'tool_approval', approval: decided }),
      );
    } else {
      const approved = await deliveryStore.approveToolApproval({
        id: approval.id,
        actorId,
      });
      await deliveryStore.appendAgentRunEvent(
        approved.runId,
        'tool_approval',
        agentRunEventSummary({ type: 'tool_approval', approval: approved }),
      );
      const result = await executeApprovedTool(approved, actorId);
      decided = result.approval;
      executed = result.executed;
    }
  } catch (error) {
    decided = (await deliveryStore.getToolApproval(approval.id)) || approval;
    if (decided.status === 'pending' || decided.status === 'approved') {
      throw error;
    }
    if (!matchesToolApprovalDecision(action.action, decided.status)) {
      await deliveryStore.markInboundEventIgnored(
        inboundEventId,
        'tool_approval_decision_conflict',
      );
      return larkCardActionResponse(
        'warning',
        `This operation is already ${decided.status}.`,
      );
    }
  }
  let cardUpdateError: string | undefined;
  try {
    await updateDeliveredToolApprovalCard(decided);
  } catch (error) {
    cardUpdateError = error instanceof Error ? error.message : String(error);
  }
  await deliveryStore.markInboundEventProcessed(inboundEventId, {
    workspaceId: approval.workspaceId,
    projectId: approval.projectId,
    threadId: approval.threadId,
    messageId: action.cardMessageId,
    metadata: {
      control: 'tool-approval-decision',
      action: action.action,
      actorId: action.actorId,
      approvalId: approval.id,
      status: decided.status,
      executed,
      cardUpdateError,
      approvalRole: authorization.approvalRole,
    },
  });
  return larkCardActionResponse(
    cardUpdateError ? 'warning' : decided.status === 'succeeded' ? 'success' : 'info',
    decided.status === 'succeeded'
      ? 'Approved and completed.'
      : decided.status === 'rejected'
        ? 'Rejected.'
        : decided.status === 'failed'
          ? 'The approved operation failed. Review the card for details.'
          : `This operation is ${decided.status}.`,
  );
}

async function handleLarkMemoryProposalAction(
  action: LarkCardAction,
  inboundEventId: string,
): Promise<LarkCardActionResponse> {
  const proposalId = action.proposalId;
  if (!proposalId) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'unsupported_lark_card_action',
    );
    return larkCardActionResponse('warning', 'This action is no longer available.');
  }
  const proposal = await memoryStore.getMemoryProposal?.(proposalId);
  const receipt = await deliveryStore.getDeliveredOutboundByExternalId({
    platform: 'lark',
    externalId: action.cardMessageId,
    kind: 'lark.card.create',
  });
  const validReceipt = Boolean(
    proposal &&
      proposal.thread.platform === 'lark' &&
      proposal.scope !== 'global' &&
      receipt &&
      receipt.payload.stage === 'memory-proposal-card' &&
      receipt.payload.proposalId === proposal.id &&
      receipt.threadId === proposal.thread.id &&
      receipt.workspaceId === proposal.scopeRef.workspaceId &&
      receipt.projectId === proposal.thread.projectId &&
      receipt.target.chatId === action.chatId &&
      (proposal.thread.channelId || proposal.thread.externalId) === action.chatId,
  );
  if (!validReceipt || !proposal || !receipt) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'invalid_lark_memory_proposal_receipt',
      {
        workspaceId: receipt?.workspaceId,
        projectId: receipt?.projectId,
        threadId: receipt?.threadId,
        messageId: action.cardMessageId,
        metadata: {
          ingress: 'lark-card-action',
          action: action.action,
          actorId: action.actorId,
          requestedProposalId: proposalId,
          receiptId: receipt?.id,
          receiptProposalId: receipt?.payload.proposalId,
        },
      },
    );
    return larkCardActionResponse('warning', 'This action is no longer available.');
  }

  const approval = await authorizeLarkMemoryProposalDecision({
    proposal,
    actorId: action.actorId,
  });
  if (!approval.allowed) {
    await deliveryStore.markInboundEventIgnored(
      inboundEventId,
      'actor_not_authorized',
      {
        workspaceId: receipt.workspaceId,
        projectId: receipt.projectId,
        threadId: receipt.threadId,
        messageId: action.cardMessageId,
        metadata: {
          control: 'memory-proposal-decision',
          ingress: 'lark-card-action',
          action: action.action,
          actorId: action.actorId,
          proposalId: proposal.id,
          cardMessageId: action.cardMessageId,
          authorization: actorAuthorizationPayload(approval.authorization),
        },
      },
    );
    return larkCardActionResponse(
      'error',
      'Only a workspace owner, admin, or project manager can decide this change.',
    );
  }

  let decided = proposal;
  let alreadyDecided = proposal.status !== 'pending';
  if (!alreadyDecided) {
    const decide =
      action.action === OPENTAG_APPROVE_MEMORY_PROPOSAL_ACTION
        ? memoryStore.approveMemoryProposal
        : memoryStore.rejectMemoryProposal;
    if (!decide) throw new Error('memory_proposal_decisions_unavailable');
    try {
      decided = await decide.call(memoryStore, {
        id: proposal.id,
        actorId: `lark:${action.actorId}`,
        reason: `lark-card:${action.cardMessageId}`,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'memory_proposal_already_decided'
      ) {
        throw error;
      }
      alreadyDecided = true;
      decided =
        (await memoryStore.getMemoryProposal?.(proposal.id)) || proposal;
    }
  }

  let cardUpdateError: string | undefined;
  try {
    const runPlatform = createPlatformForRun(proposal.thread);
    if (!runPlatform.larkAdapter) throw new Error('lark_adapter_unavailable');
    await runPlatform.larkAdapter.updateMemoryProposalCard({
      thread: proposal.thread,
      proposal: decided,
      cardId: action.cardMessageId,
      runId: receipt.runId,
    });
  } catch (error) {
    cardUpdateError = error instanceof Error ? error.message : String(error);
  }

  await deliveryStore.markInboundEventProcessed(inboundEventId, {
    workspaceId: receipt.workspaceId,
    projectId: receipt.projectId,
    threadId: receipt.threadId,
    messageId: action.cardMessageId,
    metadata: {
      control: 'memory-proposal-decision',
      ingress: 'lark-card-action',
      action: action.action,
      actorId: action.actorId,
      proposalId: proposal.id,
      proposalStatus: decided.status,
      appliedRevisionId: decided.appliedRevisionId,
      alreadyDecided,
      cardMessageId: action.cardMessageId,
      cardUpdateError,
      receiptId: receipt.id,
      approvalRole: approval.approvalRole,
      authorization: actorAuthorizationPayload(approval.authorization),
    },
  });
  if (alreadyDecided) {
    return larkCardActionResponse(
      'info',
      `This change was already ${decided.status}.`,
    );
  }
  const verb = decided.status === 'approved' ? 'approved' : 'rejected';
  return larkCardActionResponse(
    cardUpdateError ? 'warning' : 'success',
    cardUpdateError
      ? `Memory change ${verb}; card refresh is pending.`
      : `Memory change ${verb}.`,
  );
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
      actor: input.message.actor.id ? `pairing:${input.message.actor.id}` : 'pairing',
      reason: 'pairing_consumed',
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
    'This chat is not connected. Create an invitation in MaxTag Connectors, then send /pair CODE.',
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

async function toolApprovalRunRequest(
  approval: ToolApprovalRecord,
  actorId: string,
): Promise<AgentRunRequest> {
  const resolved = await threadConfigStore.resolveThreadPolicy(approval.thread);
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
      actor: { id: actorId, displayName: actorId },
      createdAt: new Date().toISOString(),
      mentionsAgent: false,
    },
    identity: resolved.identity,
    access: resolved.access,
    memory: '',
    onEvent: async (event) => {
      await deliveryStore.appendAgentRunEvent(
        approval.runId,
        event.type,
        agentRunEventSummary(event),
      );
      if (
        event.type === 'tool_approval' &&
        event.approval.status !== 'pending'
      ) {
        await updateDeliveredToolApprovalCard(event.approval);
      }
    },
  };
}

async function executeApprovedTool(
  approval: ToolApprovalRecord,
  actorId: string,
): Promise<Awaited<ReturnType<typeof toolBroker.executeApproved>>> {
  const result = await toolBroker.executeApproved({
    approvalId: approval.id,
    request: await toolApprovalRunRequest(approval, actorId),
    claimedBy: `${actorId}:${process.pid}`,
  });
  if (result.executed) {
    try {
      const continuation = await scheduleToolApprovalContinuation({
        deliveryStore,
        approval: result.approval,
      });
      if (continuation) scheduleAgentWorkerPass();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `MaxTag tool approval ${result.approval.id} continuation deferred`,
        error,
      );
      await deliveryStore
        .appendAgentRunEvent(result.approval.runId, 'log', {
          message: `Tool succeeded; continuation will retry: ${message}`,
          metadata: {
            level: 'warn',
            approvalId: result.approval.id,
            continuationStatus: 'pending',
          },
        })
        .catch(() => undefined);
      scheduleAgentWorkerPass(10);
    }
  }
  return result;
}

function memoryScopeValue(
  body: Record<string, unknown>,
  fallback: MemoryScopeKind = 'project',
): MemoryScopeKind {
  const value = stringValue(body, 'scope');
  return value === 'global' ||
    value === 'workspace' ||
    value === 'project' ||
    value === 'channel' ||
    value === 'thread'
    ? value
    : fallback;
}

function memoryScopeOptionalValue(value: unknown): MemoryScopeKind | undefined {
  return value === 'global' ||
    value === 'workspace' ||
    value === 'project' ||
    value === 'channel' ||
    value === 'thread'
    ? value
    : undefined;
}

function memoryScopeListValue(value: unknown): MemoryScopeKind[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const scopes: MemoryScopeKind[] = raw.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const scope = item.trim();
    return scope === 'global' ||
      scope === 'workspace' ||
      scope === 'project' ||
      scope === 'channel' ||
      scope === 'thread'
      ? [scope as MemoryScopeKind]
      : [];
  });
  return scopes.length ? [...new Set(scopes)] : undefined;
}

function memoryProposalStatusValue(value: unknown): MemoryProposalStatus | undefined {
  return value === 'pending' || value === 'approved' || value === 'rejected'
    ? value
    : undefined;
}

function toolApprovalStatusValue(value: unknown): ToolApprovalStatus | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim();
  if (
    normalized === 'pending' ||
    normalized === 'approved' ||
    normalized === 'executing' ||
    normalized === 'succeeded' ||
    normalized === 'failed' ||
    normalized === 'rejected' ||
    normalized === 'expired'
  ) {
    return normalized;
  }
  throw new Error('unsupported_tool_approval_status');
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

function requireMemoryProposalWorkspace(
  response: ServerResponse,
  authentication: OperatorAuthentication,
  scope: MemoryScopeKind,
  workspaceId?: string,
): boolean {
  return scope === 'global'
    ? requireInstallationOperator(response, authentication)
    : requireOperatorWorkspace(
        response,
        authentication,
        workspaceId || 'dev-workspace',
      );
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
          resultUrl: event.approval.resultUrl,
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

function shouldPersistAgentRunEvent(
  event: AgentRunEvent,
  platform: PlatformKind | undefined,
): boolean {
  if (platform !== 'web' && event.type === 'text_delta') return false;
  if (platform !== 'web' && event.type === 'progress') return false;
  return true;
}

function recordedArtifact(value: unknown): Artifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  if (
    typeof artifact.id !== 'string' ||
    typeof artifact.kind !== 'string' ||
    typeof artifact.title !== 'string'
  ) {
    return undefined;
  }
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    path: typeof artifact.path === 'string' ? artifact.path : undefined,
    url: typeof artifact.url === 'string' ? artifact.url : undefined,
    metadata:
      artifact.metadata &&
      typeof artifact.metadata === 'object' &&
      !Array.isArray(artifact.metadata)
        ? (artifact.metadata as Record<string, unknown>)
        : undefined,
  };
}

async function runArtifacts(runId: string): Promise<Array<Artifact & {
  downloadUrl?: string;
  sizeBytes?: number;
  mimeType?: string;
}>> {
  const events = await deliveryStore.listAgentRunEvents(runId, 500);
  const byId = new Map<string, Artifact>();
  for (const event of events) {
    if (event.type !== 'artifact') continue;
    const artifact = recordedArtifact(event.metadata?.artifact);
    if (artifact) byId.set(artifact.id, artifact);
  }
  return [...byId.values()].map((artifact) => ({
    ...artifact,
    path: undefined,
    downloadUrl:
      artifact.path && artifact.metadata?.managed === true
        ? `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`
        : undefined,
    sizeBytes:
      typeof artifact.metadata?.sizeBytes === 'number'
        ? artifact.metadata.sizeBytes
        : undefined,
    mimeType:
      typeof artifact.metadata?.mimeType === 'string'
        ? artifact.metadata.mimeType
        : undefined,
  }));
}

async function managedArtifactBytes(input: {
  runId: string;
  artifactId: string;
}): Promise<{
  bytes: Buffer;
  filename: string;
  mimeType: string;
} | undefined> {
  const events = await deliveryStore.listAgentRunEvents(input.runId, 500);
  const artifact = events
    .filter((event) => event.type === 'artifact')
    .map((event) => recordedArtifact(event.metadata?.artifact))
    .find((candidate) => candidate?.id === input.artifactId);
  if (!artifact?.path || artifact.metadata?.managed !== true) return undefined;
  const root = path.resolve(executorArtifactRoot);
  if (!pathIsWithin(root, artifact.path)) return undefined;
  let resolved: string;
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
    resolved = await realpath(artifact.path);
  } catch {
    return undefined;
  }
  if (!pathIsWithin(resolvedRoot, resolved)) return undefined;
  const bytes = await readFile(resolved);
  if (!bytes.byteLength || bytes.byteLength > executorMaxArtifactBytes) {
    return undefined;
  }
  const expectedHash = artifact.metadata.sha256;
  if (
    typeof expectedHash === 'string' &&
    createHash('sha256').update(bytes).digest('hex') !== expectedHash
  ) {
    return undefined;
  }
  return {
    bytes,
    filename:
      typeof artifact.metadata.filename === 'string'
        ? path.basename(artifact.metadata.filename)
        : path.basename(resolved),
    mimeType:
      typeof artifact.metadata.mimeType === 'string' &&
      /^[\w.+-]+\/[\w.+-]+$/u.test(artifact.metadata.mimeType)
        ? artifact.metadata.mimeType
        : 'application/octet-stream',
  };
}

async function applyMemoryCommand(input: {
  command: ParsedMemoryCommand;
  thread: SourceThread;
  actorId?: string;
  source?: string;
  expiresAt?: string;
  useDefaultRetention?: boolean;
  workspaceMemoryWriteAllowed?: boolean;
  bypassApproval?: boolean;
}): Promise<Record<string, unknown>> {
  const { workspace, project } = await memoryContextForThread(input.thread);
  const access = await threadConfigStore.getAccessBundle(input.thread, {
    workspace,
    project,
  });
  const defaultRetentionDays = memoryRetentionDaysFor(
    access,
    input.command.scope,
  );
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
    !input.bypassApproval &&
    (input.command.kind === 'remember' || input.command.kind === 'forget') &&
    memoryApprovalRequired(
      access.memoryApprovalPolicy,
      input.command.scope,
      input.command.kind,
    )
  ) {
    if (!memoryStore.proposeMemory) {
      throw new Error('memory_proposals_unavailable');
    }
    const proposal = await memoryStore.proposeMemory({
      thread: input.thread,
      workspace,
      project,
      scope: input.command.scope,
      action: input.command.kind,
      value: input.command.value,
      actorId: input.actorId,
      source: input.source,
      reason: 'policy:memory_approval_required',
      retentionDays:
        input.useDefaultRetention === false || input.expiresAt
          ? undefined
          : defaultRetentionDays,
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
    await memoryStore.rememberScoped({
      thread: input.thread,
      workspace,
      project,
      scope: input.command.scope,
      text: input.command.value,
      expiresAt:
        input.expiresAt ??
        (input.useDefaultRetention === false
          ? undefined
          : memoryExpiryForAccess(access, input.command.scope)),
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
  disposition: 'created' | 'steered' | 'denied';
  run?: AgentRunRecord;
  steering?: AgentRunSteeringRecord;
  authorization: Record<string, unknown>;
  route: Record<string, unknown>;
  accepted?: boolean;
  queued?: boolean;
  reason?: string;
  message?: string;
  memoryCommand?: {
    kind: ParsedMemoryCommand['kind'];
    scope: MemoryScopeKind;
  };
  routineCommand?: {
    kind: ParsedRoutineCommand['kind'];
  };
  threadStatusCommand?: {
    kind: 'status';
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
  slackTransport?: {
    mode: 'memory' | 'http';
  };
  githubTransport?: {
    mode: 'memory' | 'http';
  };
}

interface AgentWorkerPassResult {
  claimed: number;
  completed: number;
  failed: number;
  requeued: number;
  superseded: number;
  runs: AgentRunRecord[];
}

async function ensureLarkHistoryOnboarding(input: {
  thread: SourceThread;
  message: SourceMessage;
}): Promise<boolean> {
  const { thread, message } = input;
  if (
    thread.platform !== 'lark' ||
    thread.visibility === 'direct' ||
    !thread.channelId ||
    larkTransportStatus().mode !== 'http'
  ) {
    return false;
  }
  const existing = await deliveryStore.listLarkHistoryImports({
    workspaceId: thread.workspaceId,
    channelId: thread.channelId,
    limit: 20,
  });
  let job = existing.find((candidate) => candidate.status === 'awaiting_choice');
  const awaitingChoiceAlreadyExisted = Boolean(job);
  if (!job && existing.some((candidate) => candidate.status !== 'cancelled')) {
    return false;
  }
  const mainThread: SourceThread = {
    ...thread,
    id: `lark:${thread.channelId}:main`,
    externalId: `${thread.channelId}:main`,
    rootMessageId: undefined,
    topicId: undefined,
    metadata: {
      ...thread.metadata,
      larkConversationMode: 'main',
      historyInitialization: true,
    },
  };
  job ??= await deliveryStore.createLarkHistoryImport({
    workspaceId: thread.workspaceId || 'dev-workspace',
    projectId: thread.projectId || 'general',
    channelId: thread.channelId,
    channelTitle: thread.title,
    thread: mainThread,
    mode: 'awaiting_choice',
    analyzeMemory: true,
    requestedBy: `lark:${message.actor.id}`,
  });
  try {
    const transport = new TrackedLarkTransport(
      createLarkTransportForRun().transport,
      deliveryStore,
    );
    const projects = await larkHistoryProjectOptions(job.workspaceId, job.projectId);
    const card = buildLarkHistoryOnboardingCard({
      projectId: job.projectId,
      channelTitle: job.channelTitle,
      projects,
    });
    let cardMessageId = await larkHistoryOnboardingCardId(job);
    if (cardMessageId) {
      await transport.updateCard({
        cardId: cardMessageId,
        card,
        metadata: { thread: job.thread, stage: 'onboarding-card' },
      });
    } else {
      const created = await transport.createCard({
        chatId: thread.channelId,
        replyToMessageId: sourceReplyMessageId(message) || message.id,
        card,
        metadata: { thread: job.thread, stage: 'onboarding-card' },
      });
      cardMessageId = created.cardId;
    }
    await deliveryStore.updateLarkHistoryImportOnboarding(job.id, {
      cardMessageId,
    });
    if (awaitingChoiceAlreadyExisted) {
      await transport.sendText({
        chatId: thread.channelId,
        replyToMessageId: sourceReplyMessageId(message) || message.id,
        text: '接入尚未完成：请打开上一次「MaxTag · 群聊接入」卡片，先选择或新建 Project，再选择历史范围。完成后我就会正常回复。',
        metadata: { thread: job.thread, stage: 'thread-reply' },
      });
    }
    return true;
  } catch (error) {
    const wasExisting = existing.some((candidate) => candidate.id === job!.id);
    if (wasExisting) {
      const transport = new TrackedLarkTransport(
        createLarkTransportForRun().transport,
        deliveryStore,
      );
      await transport.sendText({
        chatId: thread.channelId,
        replyToMessageId: sourceReplyMessageId(message) || message.id,
        text: '这个群还差一步初始化：请打开上一次「MaxTag · 群聊接入」卡片完成 Project 和历史范围选择。',
        metadata: { thread: job.thread, stage: 'thread-reply' },
      }).catch(() => undefined);
    }
    if (!wasExisting) {
      await deliveryStore.cancelLarkHistoryImport(
        job.id,
        `onboarding_card_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.warn('MaxTag Lark history onboarding card failed', error);
    return wasExisting;
  }
}

async function larkHistoryOnboardingCardId(
  job: LarkHistoryImportJobRecord,
): Promise<string | undefined> {
  if (job.cardMessageId) return job.cardMessageId;
  const receipts = await deliveryStore.listOutbox({
    workspaceId: job.workspaceId,
    status: 'delivered',
    limit: 500,
  });
  return receipts.find(
    (receipt) =>
      receipt.kind === 'lark.card.create' &&
      receipt.target.chatId === job.channelId &&
      receipt.payload.stage === 'onboarding-card' &&
      Boolean(receipt.externalId),
  )?.externalId;
}

async function refreshLarkHistoryOnboardingCards(): Promise<void> {
  if (larkTransportStatus().mode !== 'http') return;
  const jobs = await deliveryStore.listLarkHistoryImports({
    status: 'awaiting_choice',
    limit: 100,
  });
  if (!jobs.length) return;
  const transport = new TrackedLarkTransport(
    createLarkTransportForRun().transport,
    deliveryStore,
  );
  for (const job of jobs) {
    try {
      const cardMessageId = await larkHistoryOnboardingCardId(job);
      if (!cardMessageId) continue;
      await transport.updateCard({
        cardId: cardMessageId,
        card: buildLarkHistoryOnboardingCard({
          projectId: job.projectId,
          channelTitle: job.channelTitle,
          projects: await larkHistoryProjectOptions(job.workspaceId, job.projectId),
        }),
        metadata: { thread: job.thread, stage: 'onboarding-card' },
      });
      await deliveryStore.updateLarkHistoryImportOnboarding(job.id, {
        cardMessageId,
      });
    } catch (error) {
      console.warn('MaxTag Lark onboarding card refresh failed', error);
    }
  }
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
  const routedBase = await routeMessage(input);
  let materializedMessage: SourceMessage;
  try {
    materializedMessage = await materializeMessageAttachments({
      thread: routedBase.thread,
      message: routedBase.message,
    });
  } catch (error) {
    if (options?.inboundEventId) {
      await deliveryStore.markInboundEventFailed(
        options.inboundEventId,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  const routed = { ...routedBase, message: materializedMessage };
  await recordSourceThreadMessage(routed);
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
  const githubTransport =
    routed.thread.platform === 'github' ? githubTransportStatus() : undefined;
  const slackTransport =
    routed.thread.platform === 'slack' ? slackTransportStatus() : undefined;
  const transportMode = larkTransport
    ? `lark-${String(larkTransport.mode)}`
    : telegramTransport
      ? `telegram-${telegramTransport.mode}`
      : githubTransport
        ? `github-${githubTransport.mode}`
        : slackTransport
          ? `slack-${slackTransport.mode}`
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
  const threadStatusCommand = parseThreadStatusCommand(routed.message.text);
  const resolvedPolicy = await threadConfigStore.resolveThreadPolicy(routed.thread);
  const authorization = options?.authorization
    ? actorAuthorizationPayload(options.authorization)
    : { allowed: true, reason: 'operator_or_internal' };
  const onboardingRequired = await ensureLarkHistoryOnboarding(routed);
  if (onboardingRequired) {
    if (options?.inboundEventId) {
      await deliveryStore.markInboundEventProcessed(options.inboundEventId, {
        workspaceId: routed.thread.workspaceId,
        projectId: routed.thread.projectId,
        threadId: routed.thread.id,
        messageId: routed.message.id,
        metadata: { control: 'lark_history_onboarding_required' },
      });
    }
    return {
      disposition: 'denied',
      accepted: true,
      queued: false,
      reason: 'lark_history_onboarding_required',
      authorization,
      route,
      transport: { platform: routed.thread.platform, mode: transportMode },
      larkTransport: larkTransport
        ? { mode: larkTransport.mode as 'memory' | 'http' }
        : undefined,
      telegramTransport: telegramTransport
        ? { mode: telegramTransport.mode }
        : undefined,
      githubTransport: githubTransport
        ? { mode: githubTransport.mode }
        : undefined,
      slackTransport: slackTransport
        ? { mode: slackTransport.mode }
        : undefined,
    };
  }
  const budgetCheck =
    !memoryCommand && !routineCommand && !threadStatusCommand
      ? await deliveryStore.checkUsageBudget({
          thread: routed.thread,
          policy: resolvedPolicy.access.budgetPolicy,
          policies: resolvedPolicy.access.budgetPolicies,
          expected: { runs: 1, costUsd: 0 },
        })
      : undefined;
  if (budgetCheck && !budgetCheck.allowed) {
    const message = formatUsageBudgetMessage(budgetCheck);
    if (options?.inboundEventId) {
      await deliveryStore.markInboundEventIgnored(options.inboundEventId, message);
    }
    const runPlatform = createPlatformForRun(routed.thread);
    await runPlatform.platform.sendMessage(routed.thread, message, [], {
      replyToMessageId: routed.message.id,
    });
    return {
      disposition: 'denied',
      accepted: false,
      queued: false,
      reason: 'usage_budget_denied',
      message,
      authorization,
      route,
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
      githubTransport: githubTransport
        ? { mode: githubTransport.mode }
        : undefined,
      slackTransport: slackTransport
        ? { mode: slackTransport.mode }
        : undefined,
    };
  }
  const staged = await deliveryStore.createAgentRunOrSteer({
    runId,
    thread: routed.thread,
    message: routed.message,
    inboundEventId: options?.inboundEventId,
    bindingId: routeBinding.id,
    executorId: threadStatusCommand
      ? 'thread-status'
      : routineCommand
      ? 'routine-command'
      : memoryCommand
        ? 'memory-command'
        : managedExecutorSettings?.defaultExecutorId ||
          resolvedPolicy.identity.defaultExecutorId,
    transportMode,
    allowLiveSteering: !memoryCommand && !routineCommand && !threadStatusCommand,
    forceNewRun: Boolean(threadStatusCommand),
    metadata: {
      ...options?.metadata,
      actorAuthorization: authorization,
      workspaceMemoryWriteAllowed: canWriteWorkspaceMemory(
        options?.authorization,
      ),
      memoryCommand: memoryCommand
        ? { kind: memoryCommand.kind, scope: memoryCommand.scope }
        : undefined,
      routineCommand: routineCommand
        ? { kind: routineCommand.kind }
        : undefined,
      threadStatusCommand: threadStatusCommand
        ? { kind: threadStatusCommand.kind }
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
    threadStatusCommand: threadStatusCommand
      ? { kind: threadStatusCommand.kind }
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
    githubTransport: githubTransport
      ? { mode: githubTransport.mode }
      : undefined,
    slackTransport: slackTransport
      ? { mode: slackTransport.mode }
      : undefined,
  };
}

async function recordSourceThreadMessage(input: {
  thread: SourceThread;
  message: SourceMessage;
}): Promise<void> {
  await deliveryStore.upsertSourceThreadMessages({
    thread: input.thread,
    messages: [input.message],
    origin: 'event',
  });
  try {
    await memoryWrapupService.observeThread(input.thread, input.message.id);
  } catch (error) {
    console.warn('MaxTag context consolidation staging failed', error);
  }
}

async function queuedMessageRunResponse(
  queued: QueuedMessageRun,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  return {
    accepted: queued.accepted ?? queued.disposition !== 'denied',
    queued: queued.queued ?? queued.disposition !== 'denied',
    ...queued,
    delivery: await deliverySnapshot(20, workspaceId),
  };
}

type NormalizedClientEvent = {
  eventId: string;
  eventType: string;
  thread: SourceThread;
  message: SourceMessage;
};

async function ingestClientEvent(
  normalized: NormalizedClientEvent,
  options: {
    asyncRequested: boolean;
    ingress: string;
    includeDelivery?: boolean;
  },
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const inbound = await deliveryStore.recordInboundEvent({
    platform: normalized.thread.platform,
    externalId: normalized.eventId,
    eventType: normalized.eventType,
    workspaceId: normalized.thread.workspaceId,
    projectId: normalized.thread.projectId,
    threadId: normalized.thread.id,
    messageId: normalized.message.id,
    metadata: { ingress: options.ingress },
  });
  if (inbound.duplicate) {
    return {
      statusCode: 200,
      body: {
        accepted: true,
        duplicate: true,
        inbound: inbound.record,
      },
    };
  }

  const routed = await routeMessage(normalized);
  await recordSourceThreadMessage(routed);
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
    return {
      statusCode: 202,
      body: {
        accepted: false,
        reason: 'mention_required',
        route: {
          workspaceId: routed.thread.workspaceId,
          projectId: routed.thread.projectId,
          threadId: routed.thread.id,
          platform: routed.thread.platform,
          channelId: routed.thread.channelId,
          rootMessageId: routed.thread.rootMessageId,
          topicId: routed.thread.topicId,
          title: routed.thread.title,
          visibility: routed.thread.visibility,
          larkChatInfoStatus: routed.thread.metadata?.larkChatInfoStatus,
          bindingId: routed.binding?.id,
          establishedThreadBindingId: routed.establishedThreadBinding?.id,
        },
      },
    };
  }

  const authorization = await authorizeRoutedMessage(routed);
  if (!authorization.allowed) {
    return {
      statusCode: 202,
      body: await rejectUnauthorizedMessage({
        inboundEventId: inbound.record.id,
        routed,
        decision: authorization,
      }),
    };
  }

  const control = await handleRunControlCommand(routed, inbound.record.id);
  if (control) return { statusCode: 200, body: control };

  if (options.asyncRequested) {
    const queued = await enqueueMessageRun(routed, {
      inboundEventId: inbound.record.id,
      authorization,
      metadata: {
        recoveredIngress: options.ingress !== 'client' ? options.ingress : undefined,
      },
    });
    if (queued.disposition !== 'denied') scheduleAgentWorkerPass();
    const body = options.includeDelivery
      ? await queuedMessageRunResponse(queued, routed.thread.workspaceId)
      : {
          accepted: queued.accepted ?? queued.disposition !== 'denied',
          queued: queued.queued ?? queued.disposition !== 'denied',
          disposition: queued.disposition,
          run: queued.run,
          steering: queued.steering,
          reason: queued.reason,
        };
    return { statusCode: 202, body };
  }

  return {
    statusCode: 200,
    body: await runMessageSync(routed, {
      inboundEventId: inbound.record.id,
      authorization,
    }),
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
  const [routines, executions, notifications, summary, audit] = await Promise.all([
    routineStore.listRoutines({ workspaceId, projectId }),
    routineStore.listExecutions({ workspaceId, projectId, limit: 200 }),
    routineStore.listNotifications({ workspaceId, projectId, limit: 200 }),
    routineStore.summarize(workspaceId, projectId),
    routineStore.listAudit({ workspaceId, projectId, limit: 50 }),
  ]);
  return {
    routines,
    executions,
    notifications,
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

async function runLarkDocumentWatcherTick(options: { force?: boolean } = {}) {
  const watcher = await larkDocumentWatcher.tick(options);
  const coordinator =
    watcher.staged > 0 ? await workflowCoordinator.tick() : undefined;
  return { watcher, coordinator };
}

async function workflowSnapshot(
  workspaceId = 'dev-workspace',
  projectId?: string,
): Promise<Record<string, unknown>> {
  await workflowCoordinator.reconcileNodeRuns({ workspaceId, projectId });
  const [
    workflows,
    executions,
    producerRoutes,
    producerRuntime,
    summary,
    audit,
    producerAudit,
  ] = await Promise.all([
    workflowStore.listWorkflows({ workspaceId, projectId }),
    workflowStore.listExecutions({ workspaceId, projectId, limit: 200 }),
    workflowStore.listProducerRoutes({ workspaceId, projectId }),
    workflowStore.listProducerRuntime({ workspaceId, projectId }),
    workflowStore.summarize(workspaceId, projectId),
    workflowStore.listAudit({ workspaceId, projectId, limit: 50 }),
    workflowStore.listProducerAudit({ workspaceId, projectId, limit: 50 }),
  ]);
  return {
    workflows,
    executions,
    producerRoutes,
    producerRuntime,
    summary,
    audit,
    producerAudit,
    producerIngress: {
      alertmanager: {
        mode: alertmanagerIngressMode(),
        maxBytes: alertmanagerIngressBodyMaxBytes,
        receiverPathTemplate: '/v1/alertmanager/{routeId}/events',
      },
      larkDocument: {
        enabled: larkDocumentWatcher.enabled,
        available: larkDocumentWatcher.available,
        tickIntervalMs: larkDocumentWatcherIntervalMs,
        running: larkDocumentWatcher.running,
        lastTickAt: larkDocumentWatcher.lastTickAt,
        lastTickResult: larkDocumentWatcher.lastTickResult,
      },
    },
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

function sourceReplyMessageId(
  message: SourceMessage | undefined,
): string | undefined {
  return message?.replyToMessageId || message?.id;
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
    const runningRun = await deliveryStore.markAgentRunRunning(runId, {
      workerId: agentWorkerId,
    });
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
  const threadStatusCommand = parseThreadStatusCommand(
    initialRun.message.text,
  );
  if (threadStatusCommand) {
    try {
      const commandResult = await threadStatusService.execute(
        threadStatusCommand,
        initialRun.thread,
        initialRun.metadata?.actorAuthorization,
      );
      await deliveryStore.appendAgentRunEvent(runId, 'thread_status', {
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
      if (
        runPlatform.platform.kind === 'lark' &&
        runPlatform.platform.sendCard
      ) {
        await runPlatform.platform.sendCard(
          initialRun.thread,
          commandResult.card,
          {
            runId,
            replyToMessageId: sourceReplyMessageId(initialRun.message),
            stage: 'thread-status-card',
          },
        );
      } else {
        await runPlatform.platform.sendMessage(
          initialRun.thread,
          commandResult.summary,
          [],
          { runId, replyToMessageId: sourceReplyMessageId(initialRun.message) },
        );
      }
      await markRunInboundProcessed(initialRun);
      await deliveryStore.markAgentRunCompleted(runId, commandResult.summary);
      return {
        result: { summary: commandResult.summary, artifacts: [] },
        run: await deliveryStore.getAgentRun(runId),
        route: runRoute(initialRun),
        threadStatus: commandResult,
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
              files: runPlatform.larkDryRun.files,
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
        slackTransport: runPlatform.slackTransport,
        slackDryRun: runPlatform.slackDryRun
          ? {
              texts: runPlatform.slackDryRun.texts,
              edits: runPlatform.slackDryRun.edits,
              files: runPlatform.slackDryRun.files,
            }
          : undefined,
        githubTransport: runPlatform.githubTransport,
        githubDryRun: runPlatform.githubDryRun
          ? {
              comments: runPlatform.githubDryRun.comments,
              updates: runPlatform.githubDryRun.updates,
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
        { runId, replyToMessageId: sourceReplyMessageId(initialRun.message) },
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
              files: runPlatform.larkDryRun.files,
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
        slackTransport: runPlatform.slackTransport,
        slackDryRun: runPlatform.slackDryRun
          ? {
              texts: runPlatform.slackDryRun.texts,
              edits: runPlatform.slackDryRun.edits,
              files: runPlatform.slackDryRun.files,
            }
          : undefined,
        githubTransport: runPlatform.githubTransport,
        githubDryRun: runPlatform.githubDryRun
          ? {
              comments: runPlatform.githubDryRun.comments,
              updates: runPlatform.githubDryRun.updates,
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
        workspaceMemoryWriteAllowed:
          runCanWriteWorkspaceMemory(initialRun),
      });
      await deliveryStore.appendAgentRunEvent(runId, 'memory_command', {
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
          { runId, replyToMessageId: sourceReplyMessageId(initialRun.message) },
        );
      } else {
        await runPlatform.platform.sendMessage(
          initialRun.thread,
          String(commandResult.summary),
          [],
          { runId, replyToMessageId: sourceReplyMessageId(initialRun.message) },
        );
      }
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
              files: runPlatform.larkDryRun.files,
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
        slackTransport: runPlatform.slackTransport,
        slackDryRun: runPlatform.slackDryRun
          ? {
              texts: runPlatform.slackDryRun.texts,
              edits: runPlatform.slackDryRun.edits,
              files: runPlatform.slackDryRun.files,
            }
          : undefined,
        githubTransport: runPlatform.githubTransport,
        githubDryRun: runPlatform.githubDryRun
          ? {
              comments: runPlatform.githubDryRun.comments,
              updates: runPlatform.githubDryRun.updates,
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

  const resolvedPolicy = await threadConfigStore.resolveThreadPolicy(initialRun.thread);
  const budgetCheck = await deliveryStore.checkUsageBudget({
    thread: initialRun.thread,
    policy: resolvedPolicy.access.budgetPolicy,
    policies: resolvedPolicy.access.budgetPolicies,
    expected: { runs: 1, costUsd: 0 },
  });
  if (!budgetCheck.allowed) {
    const message = formatUsageBudgetMessage(budgetCheck);
    await deliveryStore.appendAgentRunEvent(runId, 'usage_budget_denied', {
      message,
      metadata: {
        reason: budgetCheck.reason,
        period: budgetCheck.period,
        policy: budgetCheck.policy,
        current: budgetCheck.current,
        projected: budgetCheck.projected,
        violated: budgetCheck.violated,
      },
    });
    if (initialRun.metadata?.source === 'routine') {
      await deliveryStore.markAgentRunFailed(runId, message);
    } else {
      await deliveryStore.markAgentRunCancelled(runId, message);
    }
    if (
      initialRun.metadata?.source !== 'routine' ||
      initialRun.metadata?.routineNotificationMode === 'every_result'
    ) {
      await runPlatform.platform.sendMessage(initialRun.thread, message, [], {
        runId,
        replyToMessageId: sourceReplyMessageId(initialRun.message),
      });
    }
    throw new Error(`usage_budget_denied:${message}`);
  }

  const runtime = createRuntimeForPlatform(runPlatform.platform);
  const publishResult =
    initialRun.metadata?.source !== 'routine' ||
    initialRun.metadata?.routineNotificationMode === 'every_result';
  const progressSurfaceId = publishResult
    ? await deliveryStore.getDeliveredProgressSurfaceId(
        runId,
        initialRun.thread.platform,
      )
    : undefined;
  const abortController = new AbortController();
  activeRuns.set(runId, abortController);
  if (serverShuttingDown) {
    abortController.abort(
      `${OPENTAG_REQUEUE_RUN_ABORT_REASON}:shutdown_after_claim`,
    );
  }
  const stopCancellationMonitor = monitorDurableRunCancellation({
    deliveryStore,
    runId,
    abortController,
    workerId: agentWorkerId,
    pollMs: runControlPollMs,
    heartbeatMs: agentRunHeartbeatMs,
    onError: (error) => {
      console.error(`MaxTag cancellation poll failed for ${runId}`, error);
    },
  });
  try {
    await hydrateLarkThreadContext({
      deliveryStore,
      run: initialRun,
      transport: runPlatform.larkHistoryTransport,
      botOpenId,
      maxMessages: larkThreadHistoryMaxMessages,
      retryFailedAfterMs: larkThreadHistoryRetryMs,
    });
    const transcript = await loadDurableConversationContext({
      deliveryStore,
      run: initialRun,
      transcriptMaxEntries,
      transcriptMaxChars,
    });
    const providerSession =
      executorMode === 'local-cli' && executorSessionMode === 'provider'
        ? await createDurableProviderSessionContext({
            deliveryStore,
            run: initialRun,
            providerId: initialRun.executorId || 'codex',
            namespace: executorSessionNamespace,
          })
        : undefined;
    const result = await runtime.handleMessage({
      runId,
      executorId: initialRun.executorId,
      thread: initialRun.thread,
      message: initialRun.message,
      workspaceMemoryWriteAllowed:
        runCanWriteWorkspaceMemory(initialRun),
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
          deliveryStore,
          runId,
          workerId: agentWorkerId,
          abortController,
        });
        if (!renewed) {
          throw new Error(String(abortController.signal.reason));
        }
      },
      steering: createDurableSteeringProvider({
        deliveryStore,
        runId,
        workerId: agentWorkerId,
        pollMs: runControlPollMs,
      }),
      onEvent: async (event) => {
        if (shouldPersistAgentRunEvent(event, initialRun.platform)) {
          await deliveryStore.appendAgentRunEvent(
            runId,
            event.type,
            agentRunEventSummary(event),
          );
        }
        if (event.type === 'delegation' && event.status === 'completed') {
          await deliveryStore.recordAgentRunUsage({
            runId,
            recordKey: `delegation:${event.invocationId}`,
            purpose: 'delegation',
            thread: initialRun.thread!,
            quantity: {
              runs: 0,
              costUsd: event.usage?.costUsd ?? 0,
            },
            source: 'delegated-agent',
            policies: resolvedPolicy.access.budgetPolicies,
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
            await deliveryStore.appendAgentRunEvent(runId, 'log', {
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
          await deliveryStore.appendAgentRunEvent(runId, 'log', {
            message: `Memory proposal card delivery failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            metadata: { level: 'warn', proposalId: proposal.id },
          });
        }
      }
    }
    await deliveryStore.recordAgentRunUsage({
      runId,
      recordKey: 'agent',
      purpose: 'agent',
      thread: initialRun.thread,
      quantity: {
        runs: result.usage?.runs ?? 1,
        costUsd: result.usage?.costUsd ?? 0,
      },
      source: 'agent-run',
      policies: resolvedPolicy.access.budgetPolicies,
      metadata: {
        executorId: initialRun.executorId,
        transportMode: initialRun.transportMode,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        costReported: typeof result.usage?.costUsd === 'number',
      },
    });
    await markRunInboundProcessed(initialRun);
    await deliveryStore.markAgentRunCompleted(runId, result.summary);
    try {
      await memoryWrapupService.enqueueRun(initialRun);
    } catch (error) {
      await deliveryStore.appendAgentRunEvent(runId, 'log', {
        message: `Automatic memory wrapup enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { level: 'warn' },
      });
    }
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
            files: runPlatform.larkDryRun.files,
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
      slackTransport: runPlatform.slackTransport,
      slackDryRun: runPlatform.slackDryRun
        ? {
            texts: runPlatform.slackDryRun.texts,
            edits: runPlatform.slackDryRun.edits,
            files: runPlatform.slackDryRun.files,
          }
        : undefined,
      githubTransport: runPlatform.githubTransport,
      githubDryRun: runPlatform.githubDryRun
        ? {
            comments: runPlatform.githubDryRun.comments,
            updates: runPlatform.githubDryRun.updates,
          }
        : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isOpenTagLeaseLostAbort(abortController.signal)) {
      // Another worker owns the durable lease; this process must not mutate it.
    } else if (isOpenTagRequeueAbort(abortController.signal)) {
      const requeued = await deliveryStore.requeueAgentRun(runId, {
        workerId: agentWorkerId,
        reason: String(abortController.signal.reason),
      });
      if (requeued?.status === 'cancel_requested') {
        await deliveryStore.markAgentRunCancelled(
          runId,
          requeued.lastError || 'durable_cancel_requested',
        );
        await markRunInboundFailed(initialRun, message);
      }
    } else if (abortController.signal.aborted) {
      await deliveryStore.markAgentRunCancelled(
        runId,
        openTagAbortSummary(abortController.signal, message),
      );
      await markRunInboundFailed(initialRun, message);
    } else {
      await deliveryStore.markAgentRunFailed(runId, message);
      await markRunInboundFailed(initialRun, message);
    }
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
  if (queued.disposition === 'denied') {
    return queuedMessageRunResponse(queued, input.thread.workspaceId);
  }
  if (queued.disposition === 'steered') {
    scheduleAgentWorkerPass();
    return {
      steered: true,
      ...(await queuedMessageRunResponse(queued, queued.run?.workspaceId)),
    };
  }
  const result = await executeAgentRun(queued.run!);
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
    await deliveryStore.recoverStaleToolApprovals({
      olderThanMs: Math.max(agentWorkerStaleMs, 60_000),
    });
    const approved = await deliveryStore.listToolApprovals({
      status: 'approved',
      limit: Math.max(1, limit),
    });
    for (const approval of approved) {
      try {
        await executeApprovedTool(
          approval,
          approval.approvedBy || `worker:${agentWorkerId}`,
        );
      } catch (error) {
        console.error(`MaxTag tool approval ${approval.id} failed`, error);
      }
    }
    const pendingContinuations = (
      await deliveryStore.listToolApprovals({
        status: 'succeeded',
        limit: Math.max(100, limit),
      })
    ).filter((approval) => approval.continuationStatus === 'pending');
    for (const approval of pendingContinuations) {
      try {
        await scheduleToolApprovalContinuation({ deliveryStore, approval });
      } catch (error) {
        console.error(
          `MaxTag tool approval ${approval.id} continuation failed`,
          error,
        );
      }
    }
    const claimed = await deliveryStore.claimQueuedAgentRuns({
      limit,
      workerId: agentWorkerId,
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
        if (serverShuttingDown) {
          const released = await deliveryStore.requeueAgentRun(run.id, {
            workerId: agentWorkerId,
            reason: 'server_shutdown_before_execution',
          });
          if (released?.status === 'queued') result.requeued += 1;
          else result.failed += 1;
        } else {
          await executeAgentRun(run, { alreadyClaimed: true });
          result.completed += 1;
        }
      } catch {
        const latest = await deliveryStore.getAgentRun(run.id);
        if (latest?.status === 'queued') {
          result.requeued += 1;
        } else if (latest?.workerId && latest.workerId !== agentWorkerId) {
          result.superseded += 1;
        } else {
          result.failed += 1;
        }
      } finally {
        const latest = await deliveryStore.getAgentRun(run.id);
        if (latest) result.runs.push(latest);
        if (run.metadata?.source === 'workflow' && !serverShuttingDown) {
          try {
            await workflowCoordinator.tick();
          } catch (error) {
            console.error('MaxTag workflow coordinator wake failed', error);
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
  agentWorkerPassCount += 1;
  agentWorkerLastPassAt = new Date().toISOString();
  agentWorkerLastPassResult = structuredClone(result);
  const queued = await deliveryStore.listAgentRuns({
    status: 'queued',
    limit: 1,
  });
  if (queued.length > 0 && !serverShuttingDown) scheduleAgentWorkerPass(10);
  return result;
}

function scheduleAgentWorkerPass(delayMs = 0): void {
  if (
    serverShuttingDown ||
    !agentWorkerEnabled ||
    agentWorkerTimer ||
    agentWorkerPass
  ) {
    return;
  }
  agentWorkerTimer = setTimeout(() => {
    agentWorkerTimer = undefined;
    void runAgentWorkerPass(1).catch((error) => {
      console.error('MaxTag agent worker pass failed', error);
    });
  }, delayMs);
  agentWorkerTimer.unref?.();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    let operatorAuthentication: OperatorAuthentication | undefined;
    let knowledgeIngressPrincipal: KnowledgeIngressPrincipal | undefined;

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        service: 'opentag-server',
        worker: {
          mode: agentWorkerMode,
          enabled: agentWorkerEnabled,
          shuttingDown: serverShuttingDown,
          activeRuns: activeRuns.size,
          passRunning: Boolean(agentWorkerPass),
        },
        executors: executorStatus(),
        clients: {
          lark: larkTransportStatus(),
          telegram: telegramTransportStatus(),
          slack: slackTransportStatus(),
          github: githubTransportStatus(),
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
          larkDocumentWatcher: {
            enabled: larkDocumentWatcher.enabled,
            available: larkDocumentWatcher.available,
            running: larkDocumentWatcher.running,
            lastTickAt: larkDocumentWatcher.lastTickAt,
          },
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
          alertmanagerIngress: {
            mode: alertmanagerIngressMode(),
          },
        },
      });
      return;
    }

    const hostedReportMatch =
      request.method === 'GET'
        ? /^\/r\/([0-9a-f]{32})$/u.exec(url.pathname)
        : undefined;
    if (hostedReportMatch) {
      const report = await resolveHostedReportByToken({
        artifactRoot: executorArtifactRoot,
        token: hostedReportMatch[1]!,
        maxBytes: executorMaxArtifactBytes,
      });
      if (!report) {
        response.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end('Report not found\n');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(report.bytes.byteLength),
        'cache-control': 'no-store',
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'x-maxtag-report-revision': String(report.revision),
        'content-security-policy': [
          "default-src 'none'",
          "script-src 'unsafe-inline'",
          "style-src 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self' data:",
          "connect-src 'none'",
          "media-src 'self' data:",
          "object-src 'none'",
          "frame-src 'none'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          'sandbox allow-scripts',
        ].join('; '),
      });
      response.end(report.bytes);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/metrics') {
      if (metricsToken && !bearerTokenMatches(request, metricsToken)) {
        response.writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'www-authenticate': 'Bearer realm="MaxTag metrics"',
        });
        response.end('metrics_auth_required\n');
        return;
      }
      const snapshot = await collectOpenTagMetricsSnapshot({
        process: {
          service: 'opentag-server',
          startedAt: processStartedAt,
          activeRuns: activeRuns.size,
          storage: {
            driver: storageDriver,
            wal: Boolean(sqliteStorage),
          },
          loops: [
            {
              name: 'agent_worker',
              running: Boolean(agentWorkerPass),
              lastRunAt: agentWorkerLastPassAt,
              iterations: agentWorkerPassCount,
              lastItems: agentWorkerLastPassResult
                ? {
                    claimed: agentWorkerLastPassResult.claimed,
                    completed: agentWorkerLastPassResult.completed,
                    failed: agentWorkerLastPassResult.failed,
                    requeued: agentWorkerLastPassResult.requeued,
                    superseded: agentWorkerLastPassResult.superseded,
                  }
                : undefined,
            },
            {
              name: 'routine_scheduler',
              running: routineScheduler.running,
              lastRunAt: routineScheduler.lastTickAt,
              iterations: routineScheduler.tickCount,
              lastItems: routineScheduler.lastTickResult
                ? {
                    staged: routineScheduler.lastTickResult.staged,
                    claimed: routineScheduler.lastTickResult.claimed,
                    queued: routineScheduler.lastTickResult.queued,
                    failed: routineScheduler.lastTickResult.failed,
                    reconciled: routineScheduler.lastTickResult.reconciled,
                    notificationsClaimed:
                      routineScheduler.lastTickResult.notificationsClaimed,
                    notificationsDelivered:
                      routineScheduler.lastTickResult.notificationsDelivered,
                    notificationsFailed:
                      routineScheduler.lastTickResult.notificationsFailed,
                  }
                : undefined,
            },
            {
              name: 'workflow_coordinator',
              running: workflowCoordinator.running,
              lastRunAt: workflowCoordinator.lastTickAt,
              iterations: workflowCoordinator.tickCount,
              lastItems: workflowCoordinator.lastTickResult
                ? {
                    claimed: workflowCoordinator.lastTickResult.claimed,
                    queued: workflowCoordinator.lastTickResult.queued,
                    failed: workflowCoordinator.lastTickResult.failed,
                    reconciled: workflowCoordinator.lastTickResult.reconciled,
                  }
                : undefined,
            },
            {
              name: 'lark_document_watcher',
              running: larkDocumentWatcher.running,
              lastRunAt: larkDocumentWatcher.lastTickAt,
              iterations: larkDocumentWatcher.tickCount,
              lastItems: larkDocumentWatcher.lastTickResult
                ? {
                    claimed: larkDocumentWatcher.lastTickResult.claimed,
                    changed: larkDocumentWatcher.lastTickResult.changed,
                    staged: larkDocumentWatcher.lastTickResult.staged,
                    failed: larkDocumentWatcher.lastTickResult.failed,
                  }
                : undefined,
            },
            {
              name: 'delegated_agent_tasks',
              running: delegatedAgentTaskService.running,
              lastRunAt: delegatedAgentTaskService.lastPassAt,
              iterations: delegatedAgentTaskService.passCount,
              lastItems: delegatedAgentTaskService.lastPassResult
                ? {
                    claimed: delegatedAgentTaskService.lastPassResult.claimed,
                    completed: delegatedAgentTaskService.lastPassResult.completed,
                    stale: delegatedAgentTaskService.lastPassResult.stale,
                    cancelled: delegatedAgentTaskService.lastPassResult.cancelled,
                    retried: delegatedAgentTaskService.lastPassResult.retried,
                    failed: delegatedAgentTaskService.lastPassResult.failed,
                  }
                : undefined,
            },
            {
              name: 'knowledge_source_refresh',
              running: knowledgeSourceRefreshService.running,
              lastRunAt: knowledgeSourceRefreshService.lastPassAt,
              iterations: knowledgeSourceRefreshService.passCount,
              lastItems: knowledgeSourceRefreshService.lastPassResult
                ? {
                    scheduled: knowledgeSourceRefreshService.lastPassResult.scheduled,
                    claimed: knowledgeSourceRefreshService.lastPassResult.claimed,
                    updated: knowledgeSourceRefreshService.lastPassResult.updated,
                    unchanged: knowledgeSourceRefreshService.lastPassResult.unchanged,
                    notModified: knowledgeSourceRefreshService.lastPassResult.notModified,
                    stale: knowledgeSourceRefreshService.lastPassResult.stale,
                    retried: knowledgeSourceRefreshService.lastPassResult.retried,
                    failed: knowledgeSourceRefreshService.lastPassResult.failed,
                  }
                : undefined,
            },
          ],
        },
        deliveryStore,
        routineStore,
        workflowStore,
        delegatedAgentTaskStore,
        knowledgeSourceRefreshStore,
      });
      response.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(renderOpenTagPrometheusMetrics(snapshot));
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

    if (request.method === 'GET' && url.pathname === '/vendor/marked.js') {
      await sendFileResponse(
        response,
        path.resolve('node_modules/marked/lib/marked.esm.js'),
        'text/javascript; charset=utf-8',
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/vendor/dompurify.js') {
      await sendFileResponse(
        response,
        path.resolve('node_modules/dompurify/dist/purify.es.mjs'),
        'text/javascript; charset=utf-8',
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/admin/session') {
      const authentication = await operatorAuth.authenticate(request);
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
        const authentication = await operatorAuth.authenticate(request);
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
      const session = await operatorAuth.createSession(
        stringValue(body, 'token') || '',
      );
      if (!session) {
        sendJson(
          response,
          401,
          { error: 'invalid_operator_token' },
          {
            'cache-control': 'no-store',
            'www-authenticate': 'Bearer realm="MaxTag operator"',
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

    if (request.method === 'GET' && url.pathname === '/v1/operator-credentials') {
      operatorAuthentication = await requireOperator(request, response);
      if (
        !operatorAuthentication ||
        !requireInstallationOwner(response, operatorAuthentication)
      ) return;
      sendJson(
        response,
        200,
        {
          credentials: await operatorCredentialStore.list(),
          bootstrapOwnerConfigured: operatorAuth.hasStaticInstallationOwner(),
        },
        { 'cache-control': 'no-store' },
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/operator-credentials') {
      operatorAuthentication = await requireOperator(request, response);
      if (
        !operatorAuthentication ||
        !requireInstallationOwner(response, operatorAuthentication)
      ) return;
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const id = stringValue(body, 'id');
      const displayName = stringValue(body, 'displayName');
      const role = operatorRoleValue(stringValue(body, 'role'));
      const workspaceIds = Array.isArray(body.workspaceIds)
        ? body.workspaceIds.filter(
            (workspaceId): workspaceId is string => typeof workspaceId === 'string',
          )
        : [];
      if (!id || !displayName || !role || !workspaceIds.length) {
        sendJson(response, 400, {
          error: 'operator_credential_id_display_name_role_scope_required',
        });
        return;
      }
      if (operatorAuth.hasStaticPrincipal(id.trim().toLowerCase())) {
        sendJson(response, 409, { error: 'operator_credential_id_reserved' });
        return;
      }
      try {
        const wasConfigured = operatorAuth.configured;
        const existingCredentials = await operatorCredentialStore.list();
        if (
          !operatorAuth.hasStaticInstallationOwner() &&
          !existingCredentials.some(
            (credential) =>
              credential.status === 'active' &&
              credential.role === 'owner' &&
              credential.workspaceIds.includes('*'),
          ) &&
          (role !== 'owner' || !workspaceIds.includes('*'))
        ) {
          sendJson(response, 409, {
            error: 'operator_credential_first_owner_required',
          });
          return;
        }
        const created = await operatorCredentialStore.create({
          id,
          displayName,
          role,
          workspaceIds,
          actor: operatorActor(operatorAuthentication),
        });
        operatorAuth.setPersistentCredentialCount(
          (await operatorCredentialStore.list()).length,
        );
        const bootstrapSession = !wasConfigured
          ? await operatorAuth.createSession(created.token)
          : undefined;
        sendJson(
          response,
          201,
          {
            ...created,
            session: bootstrapSession
              ? {
                  configured: true,
                  authenticated: true,
                  method: 'session',
                  expiresAt: bootstrapSession.expiresAt,
                  csrfToken: bootstrapSession.csrfToken,
                  principal: bootstrapSession.principal,
                }
              : undefined,
          },
          {
            'cache-control': 'no-store',
            ...(bootstrapSession ? { 'set-cookie': bootstrapSession.cookie } : {}),
          },
        );
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const operatorCredentialAction = /^\/v1\/operator-credentials\/([^/]+)\/(rotate|revoke)$/u.exec(
      url.pathname,
    );
    if (request.method === 'POST' && operatorCredentialAction) {
      operatorAuthentication = await requireOperator(request, response);
      if (
        !operatorAuthentication ||
        !requireInstallationOwner(response, operatorAuthentication)
      ) return;
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (
        expectedRevision === undefined ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 1
      ) {
        sendJson(response, 400, {
          error: 'operator_credential_expected_revision_required',
        });
        return;
      }
      const id = decodeURIComponent(operatorCredentialAction[1]);
      const actor = operatorActor(operatorAuthentication);
      try {
        if (operatorCredentialAction[2] === 'rotate') {
          const rotated = await operatorCredentialStore.rotate({
            id,
            expectedRevision,
            actor,
          });
          sendJson(response, 200, rotated, { 'cache-control': 'no-store' });
        } else {
          const credential = await operatorCredentialStore.revoke({
            id,
            expectedRevision,
            actor,
            preserveInstallationOwner:
              !operatorAuth.hasStaticInstallationOwner(),
          });
          operatorAuth.setPersistentCredentialCount(
            (await operatorCredentialStore.list()).length,
          );
          sendJson(
            response,
            200,
            { credential },
            { 'cache-control': 'no-store' },
          );
        }
      } catch (error) {
        if (error instanceof OperatorCredentialRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(
            response,
            message === 'operator_credential_not_found' ? 404 : 409,
            { error: message },
          );
        }
      }
      return;
    }

    const isLarkIngress =
      request.method === 'POST' && url.pathname === '/v1/lark/events';
    const isLarkCardActionBridge =
      request.method === 'POST' && url.pathname === '/v1/lark/card-actions';
    const isTelegramIngress =
      request.method === 'POST' && url.pathname === '/v1/telegram/events';
    const isSlackIngress =
      request.method === 'POST' && url.pathname === '/v1/slack/events';
    const isGitHubIngress =
      request.method === 'POST' && url.pathname === '/v1/github/events';
    const isGenericClientIngress =
      request.method === 'POST' && url.pathname === '/v1/client/events';
    const isLarkBackfill =
      request.method === 'POST' && url.pathname === '/v1/lark/backfill';
    const isWorkflowIngress =
      request.method === 'POST' && url.pathname === '/v1/workflow-events';
    const knowledgeIngressStatusMatch =
      request.method === 'GET'
        ? /^\/v1\/knowledge\/ingest\/([^/]+)$/u.exec(url.pathname)
        : null;
    const isKnowledgeIngress =
      (request.method === 'POST' && url.pathname === '/v1/knowledge/ingest') ||
      Boolean(knowledgeIngressStatusMatch);
    const alertmanagerIngressMatch =
      request.method === 'POST'
        ? /^\/v1\/alertmanager\/([^/]+)\/events$/u.exec(url.pathname)
        : null;
    const isAlertmanagerIngress = Boolean(alertmanagerIngressMatch);

    if (isGenericClientIngress || isLarkCardActionBridge || isLarkBackfill) {
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
          { 'www-authenticate': 'Bearer realm="MaxTag client ingress"' },
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
          { 'www-authenticate': 'Bearer realm="MaxTag workflow ingress"' },
        );
        return;
      }
    }

    if (isAlertmanagerIngress) {
      if (!alertmanagerIngressToken) {
        sendJson(response, 503, {
          accepted: false,
          reason: 'alertmanager_ingress_token_required',
          message:
            'Set OPENTAG_ALERTMANAGER_INGRESS_TOKEN before enabling Alertmanager ingress.',
        });
        return;
      }
      if (!bearerTokenMatches(request, alertmanagerIngressToken)) {
        sendJson(
          response,
          401,
          { accepted: false, reason: 'alertmanager_ingress_auth_required' },
          { 'www-authenticate': 'Bearer realm="MaxTag Alertmanager ingress"' },
        );
        return;
      }
    }

    if (isKnowledgeIngress) {
      if (!knowledgeIngressPrincipals.length) {
        sendJson(response, 503, {
          error: 'knowledge_ingress_credentials_required',
          message:
            'Set OPENTAG_KNOWLEDGE_INGRESS_PRINCIPALS_JSON before enabling knowledge ingress.',
        });
        return;
      }
      knowledgeIngressPrincipal = authenticateKnowledgeIngress(request);
      if (!knowledgeIngressPrincipal) {
        sendJson(
          response,
          401,
          { error: 'knowledge_ingress_auth_required' },
          { 'www-authenticate': 'Bearer realm="MaxTag knowledge ingress"' },
        );
        return;
      }
    }

    if (
      url.pathname.startsWith('/v1/') &&
      !isLarkIngress &&
      !isLarkCardActionBridge &&
      !isTelegramIngress &&
      !isSlackIngress &&
      !isGitHubIngress &&
      !isGenericClientIngress &&
      !isWorkflowIngress &&
      !isAlertmanagerIngress &&
      !isKnowledgeIngress
    ) {
      operatorAuthentication = await requireOperator(request, response);
      if (!operatorAuthentication) return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/knowledge/ingest') {
      const body = (await readJsonBody(request, 14 * 1024 * 1024)) as Record<string, unknown>;
      const requestedWorkspace = stringValue(body, 'workspaceId');
      if (
        requestedWorkspace &&
        requestedWorkspace !== knowledgeIngressPrincipal!.workspaceId
      ) {
        sendJson(response, 403, { error: 'knowledge_ingress_workspace_denied' });
        return;
      }
      const id = stringValue(body, 'id');
      const name = stringValue(body, 'name');
      const description = stringValue(body, 'description');
      const kind = stringValue(body, 'kind', 'text');
      let content = typeof body.content === 'string' ? body.content : undefined;
      let mediaType = stringValue(body, 'mediaType');
      let extraction: KnowledgeSourceExtraction | undefined;
      if (typeof body.content === 'string' && typeof body.contentBase64 === 'string') {
        sendJson(response, 400, { error: 'knowledge_extraction_input_ambiguous' });
        return;
      }
      if (typeof body.contentBase64 === 'string') {
        try {
          const extracted = await extractKnowledgeContent({
            buffer: decodeKnowledgeContentBase64(body.contentBase64),
            mediaType: mediaType || 'application/octet-stream',
            fileName: stringValue(body, 'fileName'),
          });
          content = extracted.content;
          mediaType = extracted.mediaType;
          extraction = extracted.extraction;
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      if (!id || !name || !description || !content?.trim()) {
        sendJson(response, 400, { error: 'knowledge_source_fields_required' });
        return;
      }
      if (kind !== 'text' && kind !== 'file' && kind !== 'url') {
        sendJson(response, 400, { error: 'knowledge_source_invalid_kind' });
        return;
      }
      try {
        const ingested = await knowledgeSourceStore.ingest({
          workspaceId: knowledgeIngressPrincipal!.workspaceId,
          id,
          name,
          description,
          kind,
          sourceUri: stringValue(body, 'sourceUri', stringValue(body, 'url')),
          mediaType,
          extraction,
          content,
          dedupeKey: stringValue(body, 'dedupeKey'),
          actor: `knowledge-ingress:${knowledgeIngressPrincipal!.id}`,
        });
        let job = ingested.job;
        if (booleanValue(body, 'wait', false) && !['completed', 'failed', 'stale'].includes(job.status)) {
          const waitMs = Math.max(
            1_000,
            Math.min(numberValue(body, 'waitMs', 15_000) ?? 15_000, 30_000),
          );
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline && !['completed', 'failed', 'stale'].includes(job.status)) {
            await knowledgeEnrichmentService.runPass(1);
            job = (await knowledgeSourceStore.getEnrichment(job.id)) ?? job;
            if (!['completed', 'failed', 'stale'].includes(job.status)) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
        }
        const terminal = ['completed', 'failed', 'stale'].includes(job.status);
        sendJson(response, ingested.duplicate || terminal ? 200 : 202, {
          accepted: true,
          duplicate: ingested.duplicate,
          source: knowledgeSourceResponse(ingested.source),
          enrichment: knowledgeEnrichmentResponse(job),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message.includes('credentials_not_allowed') ? 422 : 400, {
          error: message,
        });
      }
      return;
    }

    if (knowledgeIngressStatusMatch) {
      const job = await knowledgeSourceStore.getEnrichment(
        decodeURIComponent(knowledgeIngressStatusMatch[1]),
      );
      if (!job || job.workspaceId !== knowledgeIngressPrincipal!.workspaceId) {
        sendJson(response, 404, { error: 'knowledge_enrichment_not_found' });
        return;
      }
      sendJson(response, 200, {
        enrichment: knowledgeEnrichmentResponse(job),
      });
      return;
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
        slackTransport: slackTransportStatus(),
        githubTransport: githubTransportStatus(),
        workflowEventCatalog,
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
        memoryWrapup: await memoryWrapupService.status(),
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
          producers: {
            alertmanager: {
              ingressMode: alertmanagerIngressMode(),
              maxBytes: alertmanagerIngressBodyMaxBytes,
              routeCount: (
                await workflowStore.listProducerRoutes({
                  workspaceId: selection.workspaceId,
                  kind: 'alertmanager',
                })
              ).length,
            },
            larkDocument: {
              enabled: larkDocumentWatcher.enabled,
              available: larkDocumentWatcher.available,
              tickIntervalMs: larkDocumentWatcherIntervalMs,
              running: larkDocumentWatcher.running,
              lastTickAt: larkDocumentWatcher.lastTickAt,
              lastTickResult: larkDocumentWatcher.lastTickResult,
              routeCount: (
                await workflowStore.listProducerRoutes({
                  workspaceId: selection.workspaceId,
                  kind: 'lark-document',
                })
              ).length,
            },
          },
        },
        storage: {
          driver: storageDriver,
          wal: Boolean(sqliteStorage),
          migration: sqliteStorage?.migration,
        },
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/lark/readiness') {
      sendJson(response, 200, await larkReadinessSnapshot());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/config/lark') {
      if (!requireInstallationOwner(response, operatorAuthentication!)) return;
      sendJson(
        response,
        200,
        {
          config: await larkBotCredentialStore.getSummary(),
          active: larkTransportStatus(),
        },
        { 'cache-control': 'no-store' },
      );
      return;
    }

    if (request.method === 'PUT' && url.pathname === '/v1/config/lark') {
      if (!requireInstallationOwner(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request, 16 * 1024)) as Record<string, unknown>;
      const current = await larkBotCredentialStore.get();
      const appId = stringValue(body, 'appId') || current?.appId;
      const providedSecret =
        typeof body.appSecret === 'string' ? body.appSecret.trim() : '';
      const appSecret = providedSecret || current?.appSecret;
      const providedVerificationToken =
        typeof body.verificationToken === 'string'
          ? body.verificationToken.trim()
          : '';
      const verificationToken =
        providedVerificationToken || current?.verificationToken;
      const providedEncryptKey =
        typeof body.encryptKey === 'string' ? body.encryptKey.trim() : '';
      const encryptKey = providedEncryptKey || current?.encryptKey;
      const domainValue = stringValue(body, 'domain', current?.domain || 'feishu');
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (!appId || !appSecret) {
        sendJson(response, 400, { error: 'lark_bot_app_id_and_secret_required' });
        return;
      }
      if (domainValue !== 'feishu' && domainValue !== 'lark') {
        sendJson(response, 400, { error: 'lark_bot_invalid_domain' });
        return;
      }
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      ) {
        sendJson(response, 400, { error: 'lark_bot_invalid_revision' });
        return;
      }
      try {
        await validateManagedLarkBotCredential({
          appId,
          appSecret,
          domain: domainValue,
          baseUrl: larkBaseUrl,
        });
        const config = await larkBotCredentialStore.save({
          appId,
          appSecret,
          domain: domainValue,
          verificationToken,
          encryptKey,
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(
          response,
          200,
          {
            config,
            reloadPending: true,
            message: verificationToken || encryptKey
              ? '飞书凭据与卡片回调配置已保存，连接服务正在重新加载'
              : '飞书凭据已保存；请继续配置卡片回调后再使用交互卡片',
          },
          { 'cache-control': 'no-store' },
        );
      } catch (error) {
        if (error instanceof LarkBotCredentialRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendJson(
          response,
          message.startsWith('lark_bot_invalid_') ? 400 : 422,
          {
            error: message === 'lark_bot_connection_timeout'
              ? message
              : 'lark_bot_credentials_rejected',
            message: message === 'lark_bot_connection_timeout'
              ? '连接飞书开放平台超时，请稍后重试'
              : 'App ID 或 App Secret 无效，飞书开放平台拒绝了连接',
          },
        );
      }
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/v1/config/lark') {
      if (!requireInstallationOwner(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request, 4 * 1024)) as Record<string, unknown>;
      const expectedRevision = numberValue(body, 'expectedRevision');
      try {
        const config = await larkBotCredentialStore.remove({ expectedRevision });
        sendJson(
          response,
          200,
          {
            config,
            reloadPending: true,
            message: '飞书 Bot 已停用，连接服务正在重新加载',
          },
          { 'cache-control': 'no-store' },
        );
      } catch (error) {
        if (error instanceof LarkBotCredentialRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/config/executor') {
      if (!requireInstallationOwner(response, operatorAuthentication!)) return;
      sendJson(
        response,
        200,
        {
          config: await executorCredentialStore.getSummary(),
          installations: await executorInstallationStatus(),
          active: {
            mode: executorMode,
            defaultExecutorId: executorRegistry.defaultExecutorId,
            executors: executorRegistry.list(),
          },
        },
        { 'cache-control': 'no-store' },
      );
      return;
    }

    if (request.method === 'PUT' && url.pathname === '/v1/config/executor') {
      if (!requireInstallationOwner(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request, 24 * 1024)) as Record<string, unknown>;
      const current = await executorCredentialStore.get();
      const provider = stringValue(body, 'provider', current?.provider || 'codex');
      const authMode = stringValue(body, 'authMode', current?.authMode || 'cli');
      const model = stringValue(body, 'model');
      let baseUrl: string | undefined;
      const providedApiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const apiKey = providedApiKey || (
        current?.provider === provider &&
        current?.authMode === 'api-key'
          ? current.apiKey
          : undefined
      );
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (provider !== 'codex' && provider !== 'claude') {
        sendJson(response, 400, { error: 'executor_invalid_provider' });
        return;
      }
      if (authMode !== 'cli' && authMode !== 'api-key') {
        sendJson(response, 400, { error: 'executor_invalid_auth_mode' });
        return;
      }
      try {
        baseUrl = normalizeManagedExecutorBaseUrl(stringValue(body, 'baseUrl'));
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
          message: 'Base URL 必须是有效的 HTTPS 地址',
        });
        return;
      }
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      ) {
        sendJson(response, 400, { error: 'executor_invalid_revision' });
        return;
      }
      try {
        await validateManagedExecutorCredential({
          provider,
          authMode,
          baseUrl,
          apiKey,
        });
        const config = await executorCredentialStore.save({
          provider,
          authMode,
          model,
          baseUrl,
          apiKey,
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(
          response,
          200,
          {
            config,
            reloadPending: true,
            message: `${provider === 'codex' ? 'Codex' : 'Claude'} 执行器验证成功，服务正在重新加载`,
          },
          { 'cache-control': 'no-store' },
        );
      } catch (error) {
        if (error instanceof ExecutorCredentialRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const badInput = message.startsWith('executor_invalid_') ||
          message === 'executor_api_key_required';
        sendJson(response, badInput ? 400 : 422, {
          error: message,
          message: message.endsWith('_cli_not_installed')
            ? '这台机器尚未安装所选 CLI'
            : message.endsWith('_cli_not_authenticated')
              ? '所选 CLI 尚未在 MaxTag 服务账号下登录，请改用 API Key 或先完成 CLI 登录'
              : message === 'executor_api_key_rejected'
                ? 'API Key 无效或没有模型访问权限'
                : message === 'executor_api_connection_failed'
                  ? '连接模型 API 超时或失败，请检查 Base URL'
                  : '执行器配置验证失败',
        });
      }
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/v1/config/executor') {
      if (!requireInstallationOwner(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request, 4 * 1024)) as Record<string, unknown>;
      const expectedRevision = numberValue(body, 'expectedRevision');
      try {
        const config = await executorCredentialStore.remove({ expectedRevision });
        sendJson(
          response,
          200,
          {
            config,
            reloadPending: true,
            message: '真实执行器已停用，服务正在重新加载',
          },
          { 'cache-control': 'no-store' },
        );
      } catch (error) {
        if (error instanceof ExecutorCredentialRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

    if (request.method === 'GET' && url.pathname === '/v1/mcp-connectors') {
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
      sendJson(response, 200, await managedConnectorsSnapshot(workspaceId));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/tool-identities') {
      sendJson(
        response,
        200,
        await toolCredentialIdentitiesSnapshot({
          includeEnvRefs:
            operatorAuthentication!.principal?.role === 'owner' &&
            Boolean(operatorAuthentication!.principal.workspaceIds.includes('*')),
        }),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/capability-bundles') {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      sendJson(response, 200, {
        workspaceId,
        bundles: await threadConfigStore.listCapabilityBundles(workspaceId),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/capability-bundles') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceCapabilityBundleInput(body);
      if ('error' in input) {
        sendJson(response, 400, { error: input.error });
        return;
      }
      if (!requireOperatorWorkspace(response, operatorAuthentication!, input.workspaceId)) {
        return;
      }
      const existing = (await threadConfigStore.listCapabilityBundles(input.workspaceId))
        .find((bundle) => bundle.id === input.id);
      const invalidToolIdentity = await invalidAssignedToolCredentialIdentity(
        input.grants,
        existing?.grants,
      );
      if (invalidToolIdentity) {
        sendJson(response, 400, {
          error: `tool_credential_identity_${invalidToolIdentity.reason}:${invalidToolIdentity.id}`,
        });
        return;
      }
      const invalidSkill = await invalidAssignedSkill(
        input.skillIds,
        existing?.skillIds,
      );
      if (invalidSkill) {
        sendJson(response, 400, {
          error: `agent_skill_${invalidSkill.reason}:${invalidSkill.id}`,
        });
        return;
      }
      const invalidAgent = await invalidAssignedDelegatedAgent(
        input.agentIds,
        existing?.agentIds,
      );
      if (invalidAgent) {
        sendJson(response, 400, {
          error: `delegated_agent_${invalidAgent.reason}:${invalidAgent.id}`,
        });
        return;
      }
      const invalidKnowledge = await invalidAssignedKnowledgeSource(
        input.workspaceId,
        input.knowledgeSourceIds,
        existing?.knowledgeSourceIds,
      );
      if (invalidKnowledge) {
        sendJson(response, 400, {
          error: `knowledge_source_${invalidKnowledge.reason}:${invalidKnowledge.id}`,
        });
        return;
      }
      try {
        const bundle = await threadConfigStore.upsertCapabilityBundle({
          ...input,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          bundle,
          workspace: await workspaceSnapshot(input.workspaceId),
        });
      } catch (error) {
        if (error instanceof CapabilityBundleRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const capabilityBundleActionMatch =
      request.method === 'POST'
        ? /^\/v1\/capability-bundles\/([^/]+)\/(enable|disable)$/u.exec(
            url.pathname,
          )
        : null;
    if (capabilityBundleActionMatch) {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId =
        stringValue(body, 'workspaceId', 'dev-workspace') || 'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      try {
        const bundle = await threadConfigStore.setCapabilityBundleEnabled({
          workspaceId,
          id: decodeURIComponent(capabilityBundleActionMatch[1]),
          enabled: capabilityBundleActionMatch[2] === 'enable',
          expectedRevision: numberValue(body, 'expectedRevision'),
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          bundle,
          workspace: await workspaceSnapshot(workspaceId),
        });
      } catch (error) {
        if (error instanceof CapabilityBundleRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'capability_bundle_not_found' ? 404 : 400, {
          error: message,
        });
      }
      return;
    }

    const capabilityBundleDeleteMatch =
      request.method === 'DELETE'
        ? /^\/v1\/capability-bundles\/([^/]+)$/u.exec(url.pathname)
        : null;
    if (capabilityBundleDeleteMatch) {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      try {
        const bundle = await threadConfigStore.removeCapabilityBundle({
          workspaceId,
          id: decodeURIComponent(capabilityBundleDeleteMatch[1]),
          expectedRevision: numberValue(
            Object.fromEntries(url.searchParams),
            'expectedRevision',
          ),
          actor: operatorActor(operatorAuthentication!),
        });
        if (!bundle) {
          sendJson(response, 404, { error: 'capability_bundle_not_found' });
          return;
        }
        sendJson(response, 200, {
          bundle,
          workspace: await workspaceSnapshot(workspaceId),
        });
      } catch (error) {
        if (error instanceof CapabilityBundleRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/tool-identities') {
      if (!requireInstallationOwner(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const envRefs = recordValue(body, 'envRefs') ?? {};
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      ) {
        sendJson(response, 400, {
          error: 'tool_credential_identity_invalid_revision',
        });
        return;
      }
      try {
        const identity = await toolCredentialIdentityStore.upsert({
          id: stringValue(body, 'id') || '',
          displayName: stringValue(body, 'displayName') || '',
          provider: stringValue(body, 'provider') as 'lark' | 'github',
          envRefs: {
            appId: stringValue(envRefs, 'appId'),
            appSecret: stringValue(envRefs, 'appSecret'),
            token: stringValue(envRefs, 'token'),
          },
          baseUrl: stringValue(body, 'baseUrl'),
          externalActor: stringValue(body, 'externalActor'),
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          identity,
          catalog: await toolCredentialIdentitiesSnapshot({ includeEnvRefs: true }),
        });
      } catch (error) {
        if (error instanceof ToolCredentialIdentityRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const toolIdentityActionMatch = request.method === 'POST'
      ? /^\/v1\/tool-identities\/([^/]+)\/(enable|disable)$/u.exec(url.pathname)
      : null;
    if (toolIdentityActionMatch) {
      if (!requireInstallationOwner(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      try {
        const identity = await toolCredentialIdentityStore.setEnabled({
          id: decodeURIComponent(toolIdentityActionMatch[1]),
          enabled: toolIdentityActionMatch[2] === 'enable',
          expectedRevision: numberValue(body, 'expectedRevision'),
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          identity,
          catalog: await toolCredentialIdentitiesSnapshot({ includeEnvRefs: true }),
        });
      } catch (error) {
        if (error instanceof ToolCredentialIdentityRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'tool_credential_identity_not_found' ? 404 : 400, {
          error: message,
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/skills') {
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
        await agentSkillsSnapshot(
          workspaceId,
          Boolean(operatorAuthentication!.principal?.workspaceIds.includes('*')),
        ),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/knowledge-sources') {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      sendJson(
        response,
        200,
        await knowledgeSourcesSnapshot(
          workspaceId,
          operatorAuthentication!.principal?.role === 'owner',
        ),
      );
      return;
    }

    const knowledgeSourceDetailMatch =
      request.method === 'GET'
        ? /^\/v1\/knowledge-sources\/([^/]+)$/u.exec(url.pathname)
        : null;
    if (knowledgeSourceDetailMatch) {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      if (operatorAuthentication!.principal?.role !== 'owner') {
        sendJson(response, 403, { error: 'operator_owner_required' });
        return;
      }
      try {
        const source = await knowledgeSourceStore.get(
          workspaceId,
          decodeURIComponent(knowledgeSourceDetailMatch[1]),
        );
        if (!source) {
          sendJson(response, 404, { error: 'knowledge_source_not_found' });
          return;
        }
        const refreshJobs = await knowledgeSourceRefreshStore.list({
          workspaceId,
          sourceId: source.id,
          limit: 500,
        });
        sendJson(response, 200, {
          source: {
            ...source,
            refresh: knowledgeRefreshResponse(refreshJobs[0]),
            nextRefreshAt: knowledgeSourceNextRefreshAt(source, refreshJobs),
          },
        });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/knowledge-sources') {
      const body = (await readJsonBody(request, 14 * 1024 * 1024)) as Record<string, unknown>;
      const workspaceId =
        stringValue(body, 'workspaceId', scopedOperatorWorkspace(operatorAuthentication!)) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      if (operatorAuthentication!.principal?.role !== 'owner') {
        sendJson(response, 403, { error: 'operator_owner_required' });
        return;
      }
      const id = stringValue(body, 'id');
      const name = stringValue(body, 'name');
      const description = stringValue(body, 'description');
      const kind = stringValue(body, 'kind', 'text');
      let content = typeof body.content === 'string' ? body.content : undefined;
      let mediaType = stringValue(body, 'mediaType');
      let extraction: KnowledgeSourceExtraction | undefined;
      if (typeof body.content === 'string' && typeof body.contentBase64 === 'string') {
        sendJson(response, 400, { error: 'knowledge_extraction_input_ambiguous' });
        return;
      }
      if (typeof body.contentBase64 === 'string') {
        try {
          const extracted = await extractKnowledgeContent({
            buffer: decodeKnowledgeContentBase64(body.contentBase64),
            mediaType: mediaType || 'application/octet-stream',
            fileName: stringValue(body, 'fileName'),
          });
          content = extracted.content;
          mediaType = extracted.mediaType;
          extraction = extracted.extraction;
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      if (!id || !name || !description || !content?.trim()) {
        sendJson(response, 400, { error: 'knowledge_source_fields_required' });
        return;
      }
      if (kind !== 'text' && kind !== 'file' && kind !== 'url') {
        sendJson(response, 400, { error: 'knowledge_source_invalid_kind' });
        return;
      }
      const expectedRevision = numberValue(body, 'expectedRevision');
      const refreshIntervalMs = numberValue(body, 'refreshIntervalMs');
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      ) {
        sendJson(response, 400, { error: 'knowledge_source_invalid_revision' });
        return;
      }
      try {
        const source = await knowledgeSourceStore.upsert({
          workspaceId,
          id,
          name,
          description,
          kind,
          sourceUri: stringValue(body, 'sourceUri'),
          mediaType,
          extraction,
          refreshIntervalMs,
          content,
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          source,
          catalog: await knowledgeSourcesSnapshot(workspaceId, true),
        });
      } catch (error) {
        if (error instanceof KnowledgeSourceRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const knowledgeRefreshDetailMatch =
      request.method === 'GET'
        ? /^\/v1\/knowledge-sources\/([^/]+)\/refresh\/([^/]+)$/u.exec(url.pathname)
        : null;
    if (knowledgeRefreshDetailMatch) {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) return;
      if (operatorAuthentication!.principal?.role !== 'owner') {
        sendJson(response, 403, { error: 'operator_owner_required' });
        return;
      }
      const job = await knowledgeSourceRefreshStore.get(
        decodeURIComponent(knowledgeRefreshDetailMatch[2]),
      );
      if (
        !job || job.workspaceId !== workspaceId ||
        job.sourceId !== decodeURIComponent(knowledgeRefreshDetailMatch[1])
      ) {
        sendJson(response, 404, { error: 'knowledge_refresh_not_found' });
        return;
      }
      sendJson(response, 200, { refresh: knowledgeRefreshResponse(job) });
      return;
    }

    const knowledgeSourceActionMatch =
      request.method === 'POST'
        ? /^\/v1\/knowledge-sources\/([^/]+)\/(enable|disable|refresh)$/u.exec(url.pathname)
        : null;
    if (knowledgeSourceActionMatch) {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId =
        stringValue(body, 'workspaceId', scopedOperatorWorkspace(operatorAuthentication!)) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      if (operatorAuthentication!.principal?.role !== 'owner') {
        sendJson(response, 403, { error: 'operator_owner_required' });
        return;
      }
      if (knowledgeSourceActionMatch[2] === 'refresh') {
        const id = decodeURIComponent(knowledgeSourceActionMatch[1]);
        try {
          const source = await knowledgeSourceStore.get(workspaceId, id);
          if (!source) {
            sendJson(response, 404, { error: 'knowledge_source_not_found' });
            return;
          }
          if (source.kind !== 'url' || !source.sourceUri) {
            sendJson(response, 409, { error: 'knowledge_refresh_url_source_required' });
            return;
          }
          if (!source.enabled) {
            sendJson(response, 409, { error: 'knowledge_source_disabled' });
            return;
          }
          const queued = await knowledgeSourceRefreshStore.enqueue({
            workspaceId, sourceId: source.id, sourceRevision: source.revision,
            sourceUri: source.sourceUri, requestedBy: operatorActor(operatorAuthentication!),
          });
          if (booleanValue(body, 'wait', false)) {
            await knowledgeSourceRefreshService.runPass(1);
          }
          const job = (await knowledgeSourceRefreshStore.get(queued.job.id)) ?? queued.job;
          sendJson(response, job.status === 'pending' || job.status === 'claimed' ? 202 : 200, {
            accepted: true,
            duplicate: queued.duplicate,
            refresh: knowledgeRefreshResponse(job),
          });
        } catch (error) {
          sendJson(response, 409, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      const expectedRevision = numberValue(body, 'expectedRevision');
      try {
        const source = await knowledgeSourceStore.setEnabled({
          workspaceId,
          id: decodeURIComponent(knowledgeSourceActionMatch[1]),
          enabled: knowledgeSourceActionMatch[2] === 'enable',
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          source,
          catalog: await knowledgeSourcesSnapshot(workspaceId, true),
        });
      } catch (error) {
        if (error instanceof KnowledgeSourceRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'knowledge_source_not_found' ? 404 : 409, {
          error: message,
        });
      }
      return;
    }

    const agentSkillDetailMatch =
      request.method === 'GET'
        ? /^\/v1\/skills\/([^/]+)$/u.exec(url.pathname)
        : null;
    if (agentSkillDetailMatch) {
      if (!requireInstallationOperator(response, operatorAuthentication!)) return;
      try {
        const skill = await skillStore.get(
          decodeURIComponent(agentSkillDetailMatch[1]),
        );
        if (!skill) {
          sendJson(response, 404, { error: 'agent_skill_not_found' });
          return;
        }
        sendJson(response, 200, { skill });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/skills') {
      if (!requireInstallationOperator(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request, 32 * 1024)) as Record<string, unknown>;
      const id = stringValue(body, 'id');
      const name = stringValue(body, 'name');
      const description = stringValue(body, 'description');
      const content = typeof body.content === 'string' ? body.content : undefined;
      if (!id || !name || !description || !content?.trim()) {
        sendJson(response, 400, { error: 'agent_skill_fields_required' });
        return;
      }
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      ) {
        sendJson(response, 400, { error: 'agent_skill_invalid_revision' });
        return;
      }
      try {
        const skill = await skillStore.upsert({
          id,
          name,
          description,
          content,
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          skill,
          catalog: await agentSkillsSnapshot(
            stringValue(body, 'workspaceId', 'dev-workspace') || 'dev-workspace',
            true,
          ),
        });
      } catch (error) {
        if (error instanceof AgentSkillRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const agentSkillActionMatch =
      request.method === 'POST'
        ? /^\/v1\/skills\/([^/]+)\/(enable|disable)$/u.exec(url.pathname)
        : null;
    if (agentSkillActionMatch) {
      if (!requireInstallationOperator(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      ) {
        sendJson(response, 400, { error: 'agent_skill_invalid_revision' });
        return;
      }
      try {
        const skill = await skillStore.setEnabled({
          id: decodeURIComponent(agentSkillActionMatch[1]),
          enabled: agentSkillActionMatch[2] === 'enable',
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          skill,
          catalog: await agentSkillsSnapshot(
            stringValue(body, 'workspaceId', 'dev-workspace') || 'dev-workspace',
            true,
          ),
        });
      } catch (error) {
        if (error instanceof AgentSkillRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'agent_skill_not_found' ? 404 : 409, {
          error: message,
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agents') {
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
        await delegatedAgentsSnapshot(
          workspaceId,
          Boolean(operatorAuthentication!.principal?.workspaceIds.includes('*')),
        ),
      );
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/agent-tasks') {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      const rawStatus = url.searchParams.get('status') || undefined;
      const statuses: DelegatedAgentTask['status'][] = [
        'queued',
        'claimed',
        'completed',
        'failed',
        'cancelled',
        'stale',
      ];
      if (rawStatus && !statuses.includes(rawStatus as DelegatedAgentTask['status'])) {
        sendJson(response, 400, { error: 'delegated_agent_task_status_invalid' });
        return;
      }
      const tasks = await delegatedAgentTaskStore.list({
        workspaceId,
        projectId: url.searchParams.get('projectId') || undefined,
        threadId: url.searchParams.get('threadId') || undefined,
        parentRunId: url.searchParams.get('parentRunId') || undefined,
        status: rawStatus as DelegatedAgentTask['status'] | undefined,
        limit: Math.floor(
          Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100) || 100, 500)),
        ),
      });
      sendJson(response, 200, {
        workspaceId,
        tasks: tasks.map(delegatedAgentTaskResponse),
        total: tasks.length,
      });
      return;
    }

    const delegatedAgentTaskCancelMatch =
      request.method === 'POST'
        ? /^\/v1\/agent-tasks\/([^/]+)\/cancel$/u.exec(url.pathname)
        : null;
    if (delegatedAgentTaskCancelMatch) {
      const taskId = decodeURIComponent(delegatedAgentTaskCancelMatch[1]);
      const current = await delegatedAgentTaskStore.get(taskId);
      if (!current) {
        sendJson(response, 404, { error: 'delegated_agent_task_not_found' });
        return;
      }
      if (!requireOperatorWorkspace(response, operatorAuthentication!, current.workspaceId)) {
        return;
      }
      try {
        const task = await delegatedAgentTaskStore.cancel({
          id: taskId,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, { task: delegatedAgentTaskResponse(task) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'delegated_agent_task_not_found' ? 404 : 409, {
          error: message,
        });
      }
      return;
    }

    const delegatedAgentDetailMatch =
      request.method === 'GET'
        ? /^\/v1\/agents\/([^/]+)$/u.exec(url.pathname)
        : null;
    if (delegatedAgentDetailMatch) {
      if (!requireInstallationOperator(response, operatorAuthentication!)) return;
      try {
        const agent = await delegatedAgentStore.get(
          decodeURIComponent(delegatedAgentDetailMatch[1]),
        );
        if (!agent) {
          sendJson(response, 404, { error: 'delegated_agent_not_found' });
          return;
        }
        sendJson(response, 200, { agent });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/agents') {
      if (!requireInstallationOperator(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request, 64 * 1024)) as Record<string, unknown>;
      const id = stringValue(body, 'id');
      const name = stringValue(body, 'name');
      const description = stringValue(body, 'description');
      const instructions =
        typeof body.instructions === 'string' ? body.instructions : undefined;
      const executorId = stringValue(body, 'executorId');
      if (!id || !name || !description || !instructions?.trim() || !executorId) {
        sendJson(response, 400, { error: 'delegated_agent_fields_required' });
        return;
      }
      if (
        (executorId !== 'codex' && executorId !== 'claude') ||
        !executorRegistry.has(executorId)
      ) {
        sendJson(response, 400, { error: 'delegated_agent_executor_not_available' });
        return;
      }
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      ) {
        sendJson(response, 400, { error: 'delegated_agent_invalid_revision' });
        return;
      }
      const skillIds = skillIdArrayValue(body);
      if (skillIds && 'error' in skillIds) {
        sendJson(response, 400, { error: skillIds.error });
        return;
      }
      const grantKinds = delegatedAgentGrantKindsValue(body);
      if ('error' in grantKinds) {
        sendJson(response, 400, { error: grantKinds.error });
        return;
      }
      const memoryScopes = delegatedAgentMemoryScopesValue(body);
      if ('error' in memoryScopes) {
        sendJson(response, 400, { error: memoryScopes.error });
        return;
      }
      const networkHosts = stringArrayValue(body, 'networkHosts') ?? [];
      if (
        body.networkHosts !== undefined &&
        (!Array.isArray(body.networkHosts) ||
          networkHosts.length !== body.networkHosts.length)
      ) {
        sendJson(response, 400, { error: 'delegated_agent_network_hosts_invalid' });
        return;
      }
      const maxTurns = numberValue(body, 'maxTurns');
      const timeoutMs = numberValue(body, 'timeoutMs');
      try {
        const existing = await delegatedAgentStore.get(id);
        const invalidSkill = await invalidAssignedSkill(
          skillIds,
          existing?.skillIds,
        );
        if (invalidSkill) {
          sendJson(response, 400, {
            error: `agent_skill_${invalidSkill.reason}:${invalidSkill.id}`,
          });
          return;
        }
        const agent = await delegatedAgentStore.upsert({
          id,
          name,
          description,
          instructions,
          executorId,
          model: stringValue(body, 'model'),
          skillIds,
          grantKinds,
          memoryScopes,
          networkHosts,
          maxTurns,
          timeoutMs,
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          agent,
          catalog: await delegatedAgentsSnapshot(
            stringValue(body, 'workspaceId', 'dev-workspace') || 'dev-workspace',
            true,
          ),
        });
      } catch (error) {
        if (error instanceof DelegatedAgentRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const delegatedAgentActionMatch =
      request.method === 'POST'
        ? /^\/v1\/agents\/([^/]+)\/(enable|disable)$/u.exec(url.pathname)
        : null;
    if (delegatedAgentActionMatch) {
      if (!requireInstallationOperator(response, operatorAuthentication!)) return;
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      ) {
        sendJson(response, 400, { error: 'delegated_agent_invalid_revision' });
        return;
      }
      try {
        const agent = await delegatedAgentStore.setEnabled({
          id: decodeURIComponent(delegatedAgentActionMatch[1]),
          enabled: delegatedAgentActionMatch[2] === 'enable',
          expectedRevision,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          agent,
          catalog: await delegatedAgentsSnapshot(
            stringValue(body, 'workspaceId', 'dev-workspace') || 'dev-workspace',
            true,
          ),
        });
      } catch (error) {
        if (error instanceof DelegatedAgentRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'delegated_agent_not_found' ? 404 : 409, {
          error: message,
        });
      }
      return;
    }

    const managedConnectorActionMatch =
      request.method === 'POST'
        ? /^\/v1\/mcp-connectors\/([^/]+)\/(enable|disable|check)$/u.exec(
            url.pathname,
          )
        : null;
    if (managedConnectorActionMatch) {
      if (!requireInstallationOperator(response, operatorAuthentication!)) {
        return;
      }
      const connectorId = decodeURIComponent(managedConnectorActionMatch[1]);
      const action = managedConnectorActionMatch[2];
      if (!externalMcpRegistry?.has(connectorId)) {
        sendJson(response, 404, { error: 'external_mcp_server_not_registered' });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const expectedRevision = numberValue(body, 'expectedRevision');
      if (
        expectedRevision !== undefined &&
        (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      ) {
        sendJson(response, 400, { error: 'managed_connector_invalid_revision' });
        return;
      }
      const actor = operatorActor(operatorAuthentication!);
      try {
        const connector =
          action === 'check'
            ? await managedConnectorStore.recordHealth({
                id: connectorId,
                health: await externalMcpRegistry.check(connectorId),
                actor,
              })
            : await managedConnectorStore.setEnabled({
                id: connectorId,
                enabled: action === 'enable',
                expectedRevision,
                actor,
              });
        sendJson(response, 200, {
          connector,
          connectors: await managedConnectorsSnapshot(
            stringValue(body, 'workspaceId', 'dev-workspace') || 'dev-workspace',
          ),
        });
      } catch (error) {
        if (error instanceof ManagedConnectorRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            currentRevision: error.currentRevision,
          });
          return;
        }
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/spend') {
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
        await spendSnapshot(
          workspaceId,
          url.searchParams.get('period') || undefined,
        ),
      );
      return;
    }

    if (
      request.method === 'GET' &&
      (url.pathname === '/v1/audit' || url.pathname === '/v1/audit.csv')
    ) {
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
      const categoryValue = url.searchParams.get('category');
      const category =
        categoryValue === 'task' ||
        categoryValue === 'agent' ||
        categoryValue === 'tool' ||
        categoryValue === 'policy' ||
        categoryValue === 'knowledge' ||
        categoryValue === 'access' ||
        categoryValue === 'binding' ||
        categoryValue === 'routine' ||
        categoryValue === 'workflow'
          ? categoryValue
          : undefined;
      const outcomeValue = url.searchParams.get('outcome');
      const outcome =
        outcomeValue === 'started' ||
        outcomeValue === 'succeeded' ||
        outcomeValue === 'failed' ||
        outcomeValue === 'denied' ||
        outcomeValue === 'cancelled' ||
        outcomeValue === 'changed'
          ? outcomeValue
          : undefined;
      const destinationValue = url.searchParams.get('destination') || undefined;
      const destination = auditDestination(destinationValue);
      if (destinationValue && !destination) {
        sendJson(response, 400, { error: 'audit_destination_invalid' });
        return;
      }
      const audit = await organizationAuditSnapshot({
        workspaceId,
        projectId: url.searchParams.get('projectId') || undefined,
        actor: url.searchParams.get('actor') || undefined,
        action: url.searchParams.get('action') || undefined,
        destination,
        category,
        outcome,
        from: isoDateValue(url.searchParams.get('from')),
        to: isoDateValue(url.searchParams.get('to')),
        limit: numberValue(Object.fromEntries(url.searchParams.entries()), 'limit', 200),
        includeInstallation: Boolean(
          operatorAuthentication!.principal?.workspaceIds.includes('*'),
        ),
      });
      if (url.pathname === '/v1/audit.csv') {
        const csv = organizationAuditCsv(audit.entries);
        response.writeHead(200, {
          'cache-control': 'private, no-store',
          'content-disposition': `attachment; filename="opentag-audit-${workspaceId}.csv"`,
          'content-length': String(Buffer.byteLength(csv)),
          'content-type': 'text/csv; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        response.end(csv);
        return;
      }
      sendJson(response, 200, {
        workspaceId,
        filters: { category, outcome, destination },
        ...audit,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/data-lifecycle') {
      const workspaceId =
        url.searchParams.get('workspaceId') ||
        scopedOperatorWorkspace(operatorAuthentication!) ||
        'dev-workspace';
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      const values = Object.fromEntries(url.searchParams.entries());
      const retentionDays = numberValue(values, 'retentionDays', 90)!;
      const keepLatestPerThread = numberValue(values, 'keepLatestPerThread', 20)!;
      if (
        !Number.isInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > 3_650 ||
        !Number.isInteger(keepLatestPerThread) ||
        keepLatestPerThread < 1 ||
        keepLatestPerThread > 500
      ) {
        sendJson(response, 400, { error: 'data_lifecycle_policy_invalid' });
        return;
      }
      sendJson(
        response,
        200,
        { ...(await workspaceDataLifecycleResult({
          workspaceId,
          retentionDays,
          keepLatestPerThread,
          dryRun: true,
        })) },
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/data-lifecycle') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId');
      const confirmationWorkspaceId = stringValue(body, 'confirmationWorkspaceId');
      const retentionDays = numberValue(body, 'retentionDays', 90)!;
      const keepLatestPerThread = numberValue(body, 'keepLatestPerThread', 20)!;
      if (!workspaceId || confirmationWorkspaceId !== workspaceId) {
        sendJson(response, 400, { error: 'data_lifecycle_confirmation_required' });
        return;
      }
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) {
        return;
      }
      if (!requireOperatorOwner(response, operatorAuthentication!)) return;
      if (
        !Number.isInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > 3_650 ||
        !Number.isInteger(keepLatestPerThread) ||
        keepLatestPerThread < 1 ||
        keepLatestPerThread > 500
      ) {
        sendJson(response, 400, { error: 'data_lifecycle_policy_invalid' });
        return;
      }
      sendJson(
        response,
        200,
        { ...(await workspaceDataLifecycleResult({
          workspaceId,
          retentionDays,
          keepLatestPerThread,
          dryRun: false,
          actor: operatorActor(operatorAuthentication!),
        })) },
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/spend/policies') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId') || 'dev-workspace';
      const target = stringValue(body, 'target');
      if (!workspaceId || !target) {
        sendJson(response, 400, { error: 'spend_workspace_target_required' });
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
      const policyBody = recordValue(body, 'policy');
      if (!policyBody) {
        sendJson(response, 400, { error: 'spend_policy_required' });
        return;
      }
      const defaultMode =
        target === 'workspace' || target === 'workspace-default-channel'
          ? 'disabled'
          : 'inherit';
      const scope = target.includes('channel') ? 'channel' : target;
      if (
        scope !== 'workspace' &&
        scope !== 'project' &&
        scope !== 'channel'
      ) {
        sendJson(response, 400, { error: 'unsupported_spend_target' });
        return;
      }
      const policy = coerceBudgetPolicy(
        { budgetPolicy: policyBody },
        defaultMode,
        scope,
      );
      if (!policy || 'error' in policy) {
        sendJson(response, 400, {
          error: policy && 'error' in policy ? policy.error : 'spend_policy_required',
        });
        return;
      }
      const actor = operatorActor(operatorAuthentication!);
      if (target === 'workspace') {
        await threadConfigStore.upsertWorkspacePolicy({
          workspaceId,
          budgetPolicy: policy,
          actor,
        });
      } else if (target === 'workspace-default-channel') {
        await threadConfigStore.upsertWorkspacePolicy({
          workspaceId,
          defaultChannelBudgetPolicy: policy,
          actor,
        });
      } else if (target === 'project' || target === 'project-default-channel') {
        const projectId = stringValue(body, 'projectId');
        if (!projectId) {
          sendJson(response, 400, { error: 'spend_project_required' });
          return;
        }
        await threadConfigStore.upsertProjectPolicy({
          workspaceId,
          projectId,
          ...(target === 'project'
            ? { budgetPolicy: policy }
            : { defaultChannelBudgetPolicy: policy }),
          actor,
        });
      } else if (target === 'channel') {
        const projectId = stringValue(body, 'projectId');
        const platform = platformValue(stringValue(body, 'platform'));
        const channelId = stringValue(body, 'channelId');
        if (!projectId || !platform || !channelId) {
          sendJson(response, 400, {
            error: 'spend_project_platform_channel_required',
          });
          return;
        }
        await threadConfigStore.upsertChannelPolicy({
          workspaceId,
          projectId,
          platform,
          channelId,
          budgetPolicy: policy,
          actor,
        });
      }
      await reconcileSpendPolicyAlerts({
        workspaceId,
        target,
        projectId: stringValue(body, 'projectId'),
        platform: platformValue(stringValue(body, 'platform')),
        channelId: stringValue(body, 'channelId'),
      });
      sendJson(response, 200, await spendSnapshot(workspaceId));
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
      const workspaceId = stringValue(body, 'workspaceId') || 'dev-workspace';
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
      const existingProject = (
        await threadConfigStore.listProjectPolicies(input.workspaceId)
      ).find(
        (project) =>
          project.projectId === input.projectId || project.id === input.projectId,
      );
      const invalidToolIdentity = await invalidAssignedToolCredentialIdentity(
        input.grants,
        existingProject?.grants,
      );
      if (invalidToolIdentity) {
        sendJson(response, 400, {
          error: `tool_credential_identity_${invalidToolIdentity.reason}:${invalidToolIdentity.id}`,
        });
        return;
      }
      const invalidSkill = await invalidAssignedSkill(
        input.skillIds,
        existingProject?.skillIds,
      );
      if (invalidSkill) {
        sendJson(response, 400, {
          error: `agent_skill_${invalidSkill.reason}:${invalidSkill.id}`,
        });
        return;
      }
      const invalidAgent = await invalidAssignedDelegatedAgent(
        input.agentIds,
        existingProject?.agentIds,
      );
      if (invalidAgent) {
        sendJson(response, 400, {
          error: `delegated_agent_${invalidAgent.reason}:${invalidAgent.id}`,
        });
        return;
      }
      const invalidKnowledge = await invalidAssignedKnowledgeSource(
        input.workspaceId,
        input.knowledgeSourceIds,
        existingProject?.knowledgeSourceIds,
      );
      if (invalidKnowledge) {
        sendJson(response, 400, {
          error: `knowledge_source_${invalidKnowledge.reason}:${invalidKnowledge.id}`,
        });
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

    if (request.method === 'POST' && url.pathname === '/v1/channel-policies') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceChannelPolicyInput(body);
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
      const existingChannel = (
        await threadConfigStore.listChannelPolicies(
          input.workspaceId,
          input.projectId,
        )
      ).find(
        (channel) =>
          channel.platform === input.platform && channel.channelId === input.channelId,
      );
      const invalidToolIdentity = await invalidAssignedToolCredentialIdentity(
        input.grants,
        existingChannel?.grants,
      );
      if (invalidToolIdentity) {
        sendJson(response, 400, {
          error: `tool_credential_identity_${invalidToolIdentity.reason}:${invalidToolIdentity.id}`,
        });
        return;
      }
      const invalidSkill = await invalidAssignedSkill(
        input.skillIds,
        existingChannel?.skillIds,
      );
      if (invalidSkill) {
        sendJson(response, 400, {
          error: `agent_skill_${invalidSkill.reason}:${invalidSkill.id}`,
        });
        return;
      }
      const invalidAgent = await invalidAssignedDelegatedAgent(
        input.agentIds,
        existingChannel?.agentIds,
      );
      if (invalidAgent) {
        sendJson(response, 400, {
          error: `delegated_agent_${invalidAgent.reason}:${invalidAgent.id}`,
        });
        return;
      }
      const invalidKnowledge = await invalidAssignedKnowledgeSource(
        input.workspaceId,
        input.knowledgeSourceIds,
        existingChannel?.knowledgeSourceIds,
      );
      if (invalidKnowledge) {
        sendJson(response, 400, {
          error: `knowledge_source_${invalidKnowledge.reason}:${invalidKnowledge.id}`,
        });
        return;
      }
      try {
        const channelPolicy = await threadConfigStore.upsertChannelPolicy({
          ...input,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          channelPolicy,
          workspace: await workspaceSnapshot(channelPolicy.workspaceId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'channel_policy_project_not_found' ? 404 : 409, {
          error: message,
        });
      }
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/v1/channel-policies') {
      const workspaceId = url.searchParams.get('workspaceId') || 'dev-workspace';
      const projectId = url.searchParams.get('projectId') || '';
      const platform = platformValue(url.searchParams.get('platform'));
      const channelId = url.searchParams.get('channelId') || '';
      if (!projectId || !platform || !channelId) {
        sendJson(response, 400, {
          error: 'project_platform_channel_required',
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
      const channelPolicy = await threadConfigStore.removeChannelPolicy({
        workspaceId,
        projectId,
        platform,
        channelId,
        actor: operatorActor(operatorAuthentication!),
      });
      if (!channelPolicy) {
        sendJson(response, 404, { error: 'channel_policy_not_found' });
        return;
      }
      sendJson(response, 200, {
        channelPolicy,
        workspace: await workspaceSnapshot(workspaceId),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/workspace') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceWorkspacePolicyInput(body);
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
      const existingWorkspace = (
        await threadConfigStore.listWorkspacePolicies()
      ).find((policy) => policy.workspace.id === input.workspaceId);
      const invalidToolIdentity = await invalidAssignedToolCredentialIdentity(
        input.grants,
        existingWorkspace?.grants,
      );
      if (invalidToolIdentity) {
        sendJson(response, 400, {
          error: `tool_credential_identity_${invalidToolIdentity.reason}:${invalidToolIdentity.id}`,
        });
        return;
      }
      const invalidSkill = await invalidAssignedSkill(
        input.skillIds,
        existingWorkspace?.skillIds,
      );
      if (invalidSkill) {
        sendJson(response, 400, {
          error: `agent_skill_${invalidSkill.reason}:${invalidSkill.id}`,
        });
        return;
      }
      const invalidAgent = await invalidAssignedDelegatedAgent(
        input.agentIds,
        existingWorkspace?.agentIds,
      );
      if (invalidAgent) {
        sendJson(response, 400, {
          error: `delegated_agent_${invalidAgent.reason}:${invalidAgent.id}`,
        });
        return;
      }
      const invalidKnowledge = await invalidAssignedKnowledgeSource(
        input.workspaceId,
        input.knowledgeSourceIds,
        existingWorkspace?.knowledgeSourceIds,
      );
      if (invalidKnowledge) {
        sendJson(response, 400, {
          error: `knowledge_source_${invalidKnowledge.reason}:${invalidKnowledge.id}`,
        });
        return;
      }
      const workspace = await threadConfigStore.upsertWorkspacePolicy({
        ...input,
        actor: operatorActor(operatorAuthentication!),
      });
      sendJson(response, 200, {
        workspace,
        snapshot: await workspaceSnapshot(workspace.workspace.id),
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

    if (
      request.method === 'POST' &&
      url.pathname === '/v1/workflow-producers'
    ) {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const input = coerceWorkflowProducerRouteInput(body);
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
      const projects = await threadConfigStore.listProjectPolicies(
        input.workspaceId,
      );
      const project = projects.find(
        (candidate) =>
          candidate.projectId === input.projectId ||
          candidate.id === input.projectId,
      );
      if (!project) {
        sendJson(response, 404, { error: 'workflow_producer_project_not_found' });
        return;
      }
      try {
        if (input.id) {
          const existing = await workflowStore.getProducerRoute(input.id);
          if (!existing || existing.status === 'archived') {
            sendJson(response, 404, {
              error: 'workflow_producer_route_not_found',
            });
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
        }
        const route = await workflowStore.upsertProducerRoute({
          ...input,
          projectId: project.projectId,
          actor: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, {
          route,
          workflows: await workflowSnapshot(route.workspaceId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(
          response,
          message === 'workflow_producer_route_not_found' ? 404 : 409,
          { error: message },
        );
      }
      return;
    }

    const workflowProducerDeleteMatch =
      request.method === 'DELETE'
        ? /^\/v1\/workflow-producers\/([^/]+)$/u.exec(url.pathname)
        : null;
    if (workflowProducerDeleteMatch) {
      const id = decodeURIComponent(workflowProducerDeleteMatch[1]);
      const existing = await workflowStore.getProducerRoute(id);
      if (!existing || existing.status === 'archived') {
        sendJson(response, 404, { error: 'workflow_producer_route_not_found' });
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
      const route = await workflowStore.archiveProducerRoute(
        id,
        operatorActor(operatorAuthentication!),
      );
      sendJson(response, 200, {
        route,
        workflows: await workflowSnapshot(existing.workspaceId),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/workflows/tick') {
      if (!requireInstallationOperator(response, operatorAuthentication!)) {
        return;
      }
      const [result, documentWatcher] = await Promise.all([
        runWorkflowCoordinatorTick(),
        runLarkDocumentWatcherTick({ force: true }),
      ]);
      sendJson(response, 200, {
        result,
        documentWatcher,
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

    const workflowExecutionCancelMatch =
      request.method === 'POST'
        ? /^\/v1\/workflow-executions\/([^/]+)\/cancel$/u.exec(url.pathname)
        : null;
    if (workflowExecutionCancelMatch) {
      const executionId = decodeURIComponent(workflowExecutionCancelMatch[1]);
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const execution = await workflowStore.getExecution(executionId);
      if (!execution) {
        sendJson(response, 404, { error: 'workflow_execution_not_found' });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          execution.workflow.workspaceId,
        )
      ) {
        return;
      }
      const actor = operatorActor(operatorAuthentication!);
      const reason = `${actor}:${stringValue(
        body,
        'reason',
        'workflow_execution_cancelled',
      )}`;
      try {
        const cancelled = await workflowStore.cancelExecution(
          executionId,
          { actor, reason },
        );
        const runs = [];
        for (const runId of cancelled.activeRunIds) {
          const run = await deliveryStore.requestAgentRunCancel(runId, reason);
          activeRuns.get(runId)?.abort(reason);
          const cancelledOutbox = await deliveryStore.cancelOutbox({ runId, reason });
          runs.push({ run, cancelledOutbox });
        }
        sendJson(response, 200, {
          ...cancelled,
          runs,
          workflows: await workflowSnapshot(execution.workflow.workspaceId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message === 'workflow_execution_not_found' ? 404 : 409, {
          error: message,
        });
      }
      return;
    }

    const workflowNodeRetryMatch =
      request.method === 'POST'
        ? /^\/v1\/workflow-executions\/([^/]+)\/nodes\/([^/]+)\/retry$/u.exec(
            url.pathname,
          )
        : null;
    if (workflowNodeRetryMatch) {
      const executionId = decodeURIComponent(workflowNodeRetryMatch[1]);
      const nodeId = decodeURIComponent(workflowNodeRetryMatch[2]);
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const execution = await workflowStore.getExecution(executionId);
      if (!execution) {
        sendJson(response, 404, { error: 'workflow_execution_not_found' });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          execution.workflow.workspaceId,
        )
      ) {
        return;
      }
      try {
        const retried = await workflowStore.retryNode(
          executionId,
          nodeId,
          {
            actor: operatorActor(operatorAuthentication!),
            reason: stringValue(body, 'reason', 'workflow_node_retried'),
          },
        );
        const tick = workflowCoordinatorInline
          ? await runWorkflowCoordinatorTick()
          : undefined;
        sendJson(response, 202, {
          accepted: true,
          ...retried,
          execution:
            (await workflowStore.getExecution(executionId)) || retried.execution,
          tick,
          coordinatorMode: workflowCoordinatorMode,
          workflows: await workflowSnapshot(execution.workflow.workspaceId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, message.includes('_not_found') ? 404 : 409, {
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

    if (request.method === 'GET' && url.pathname === '/v1/binding-export') {
      const query = Object.fromEntries(url.searchParams.entries());
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      if (!selection.workspaceId) {
        sendJson(response, 400, { error: 'binding_export_workspace_required' });
        return;
      }
      const includeObserved = includeQueryFlag(url, 'includeObserved');
      const includeMetadata = includeQueryFlag(url, 'includeMetadata');
      const bindings = (
        await deliveryStore.listThreadBindings(
          numberValue(query, 'limit', 500),
          selection.workspaceId,
        )
      )
        .filter((binding) => includeObserved || binding.source !== 'observed')
        .map((binding) => bindingExportEntry(binding, includeMetadata));
      sendJson(response, 200, {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        workspaceId: selection.workspaceId,
        includeObserved,
        includeMetadata,
        count: bindings.length,
        bindings,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/binding-audit') {
      const query = Object.fromEntries(url.searchParams.entries());
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      sendJson(response, 200, {
        workspaceId: selection.workspaceId,
        audit: await deliveryStore.listThreadBindingAudit({
          workspaceId: selection.workspaceId,
          projectId: url.searchParams.get('projectId') || undefined,
          bindingId: url.searchParams.get('bindingId') || undefined,
          platform: platformValue(url.searchParams.get('platform')) as PlatformKind | undefined,
          limit: numberValue(query, 'limit', 100),
        }),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/binding-import') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId =
        stringValue(body, 'workspaceId') ||
        stringValue(recordValue(body, 'manifest') ?? {}, 'workspaceId') ||
        stringValue(recordValue(body, 'export') ?? {}, 'workspaceId');
      if (!workspaceId) {
        sendJson(response, 400, { error: 'binding_import_workspace_required' });
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
      const rawRows = bindingImportRows(body);
      if (!rawRows.length) {
        sendJson(response, 400, { error: 'binding_import_bindings_required' });
        return;
      }
      const actor = operatorActor(operatorAuthentication!);
      const projects = await knownProjectIds(workspaceId);
      const rows = rawRows.map((row, index) =>
        coerceBindingImportRow(row, index, workspaceId, projects, actor),
      );
      const errors = rows
        .filter((row) => row.error)
        .map((row) => ({ index: row.index, error: row.error }));
      const validInputs = rows.flatMap((row) => (row.input ? [row.input] : []));
      const apply = booleanValue(body, 'apply', false) === true;
      const dryRun = apply ? false : booleanValue(body, 'dryRun', true) !== false;
      if (errors.length) {
        sendJson(response, apply ? 400 : 200, {
          workspaceId,
          dryRun: true,
          apply: false,
          validated: validInputs.length,
          imported: 0,
          errors,
          preview: validInputs.map(bindingImportPreview),
        });
        return;
      }
      if (dryRun) {
        sendJson(response, 200, {
          workspaceId,
          dryRun: true,
          apply: false,
          validated: validInputs.length,
          imported: 0,
          errors: [],
          preview: validInputs.map(bindingImportPreview),
        });
        return;
      }
      const bindings = [];
      for (const input of validInputs) {
        bindings.push(await deliveryStore.configureThreadBinding(input));
      }
      sendJson(response, 200, {
        workspaceId,
        dryRun: false,
        apply: true,
        validated: validInputs.length,
        imported: bindings.length,
        errors: [],
        bindings,
        delivery: await deliverySnapshot(20, workspaceId),
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
        actor: operatorActor(operatorAuthentication!),
        reason: stringValue(body, 'reason', 'operator_configured'),
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
        actor: operatorActor(operatorAuthentication!),
        reason: url.searchParams.get('reason') || 'operator_removed',
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
        (platform !== 'lark' &&
          platform !== 'telegram' &&
          platform !== 'github' &&
          platform !== 'slack') ||
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
        allowedActorIds: stringArrayValue(body, 'allowedActorIds'),
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

    if (request.method === 'GET' && url.pathname === '/v1/tool-approvals') {
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      let status: ToolApprovalStatus | undefined;
      try {
        status = toolApprovalStatusValue(url.searchParams.get('status'));
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : 'invalid_tool_approval_status',
        });
        return;
      }
      const approvals = await deliveryStore.listToolApprovals({
        status,
        workspaceId: selection.workspaceId,
        projectId: url.searchParams.get('projectId') || undefined,
        runId: url.searchParams.get('runId') || undefined,
        threadId: url.searchParams.get('threadId') || undefined,
        limit: numberValue(
          Object.fromEntries(url.searchParams.entries()),
          'limit',
          100,
        ),
      });
      sendJson(response, 200, {
        workspaceId: selection.workspaceId,
        approvals,
      });
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/tool-approvals/')
    ) {
      const suffix = url.pathname.slice('/v1/tool-approvals/'.length);
      const [encodedId, action] = suffix.split('/');
      const id = decodeURIComponent(encodedId || '');
      if (action !== 'approve' && action !== 'reject') {
        sendJson(response, 404, { error: 'tool_approval_route_not_found' });
        return;
      }
      const existing = await deliveryStore.getToolApproval(id);
      if (!existing) {
        sendJson(response, 404, { error: 'tool_approval_not_found' });
        return;
      }
      if (
        !requireOperatorWorkspace(
          response,
          operatorAuthentication!,
          existing.workspaceId || 'dev-workspace',
        )
      ) {
        return;
      }
      const actorId = operatorActor(operatorAuthentication!);
      try {
        if (
          existing.status !== 'pending' &&
          existing.status !== 'approved'
        ) {
          if (!matchesToolApprovalDecision(action, existing.status)) {
            sendJson(response, 409, {
              error: `tool_approval_decision_conflict:${existing.status}`,
              approval: existing,
            });
            return;
          }
          sendJson(response, 200, { approval: existing, executed: false });
          return;
        }
        if (action === 'reject') {
          const approval = await deliveryStore.rejectToolApproval({
            id,
            actorId,
          });
          await deliveryStore.appendAgentRunEvent(
            approval.runId,
            'tool_approval',
            agentRunEventSummary({ type: 'tool_approval', approval }),
          );
          sendJson(response, 200, { approval, executed: false });
          return;
        }
        if (existing.status === 'approved') {
          const result = await executeApprovedTool(existing, actorId);
          sendJson(response, 200, {
            approval: result.approval,
            executed: result.executed,
          });
          return;
        }
        const approved = await deliveryStore.approveToolApproval({ id, actorId });
        await deliveryStore.appendAgentRunEvent(
          approved.runId,
          'tool_approval',
          agentRunEventSummary({ type: 'tool_approval', approval: approved }),
        );
        const result = await executeApprovedTool(approved, actorId);
        sendJson(response, 200, {
          approval: result.approval,
          executed: result.executed,
        });
      } catch (error) {
        const current = await deliveryStore.getToolApproval(id);
        if (
          current &&
          current.status !== 'pending' &&
          current.status !== 'approved' &&
          matchesToolApprovalDecision(action, current.status)
        ) {
          sendJson(response, 200, { approval: current, executed: false });
          return;
        }
        sendJson(response, 409, {
          error:
            error instanceof Error
              ? error.message
              : 'tool_approval_decision_failed',
          approval: current,
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/memory-proposals') {
      if (!memoryStore.listMemoryProposals) {
        sendJson(response, 501, { error: 'memory_proposals_unavailable' });
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const scope = memoryScopeOptionalValue(url.searchParams.get('scope'));
      const status = memoryProposalStatusValue(url.searchParams.get('status'));
      if (
        scope === 'global' &&
        !requireInstallationOperator(response, operatorAuthentication!)
      ) {
        return;
      }
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      const projectId = await resolvedProjectMemoryId(
        selection.workspaceId,
        stringValue(query, 'projectId'),
      );
      const proposals = await memoryStore.listMemoryProposals({
        status,
        workspaceId: selection.workspaceId,
        projectId,
        scope: scope || undefined,
        limit: numberValue(query, 'limit', 100),
      });
      sendJson(response, 200, {
        workspaceId: selection.workspaceId,
        proposals,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/memory-analysis') {
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      const projectId = await resolvedProjectMemoryId(
        selection.workspaceId,
        url.searchParams.get('projectId') || undefined,
      );
      const indexThread = coerceMemoryThread({
        workspaceId: selection.workspaceId,
        projectId,
        threadId: url.searchParams.get('threadId') || undefined,
        platform: url.searchParams.get('platform') || undefined,
        channelId: url.searchParams.get('channelId') || undefined,
      });
      const { workspace, project } = await memoryContextForThread(indexThread);
      const semanticIndex = memoryStore.listMemorySemanticIndex
        ? await memoryStore.listMemorySemanticIndex({
            thread: indexThread,
            workspace,
            project,
            scopes: ['workspace', 'project', 'channel', 'thread'],
          })
        : [];
      sendJson(response, 200, {
        ...memoryAnalysisService.status(),
        retrieval: {
          ...memoryRetrievalService.status(),
          indexedFacts: semanticIndex.length,
          indexedAliases: semanticIndex.reduce(
            (total, entry) => total + entry.aliases.length,
            0,
          ),
        },
        wrapup: await memoryWrapupService.status(),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/memory-wrapups') {
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      const jobs = await deliveryStore.listMemoryWrapups({
        workspaceId: selection.workspaceId,
        projectId: url.searchParams.get('projectId') || undefined,
        threadId: url.searchParams.get('threadId') || undefined,
        limit: numberValue(
          Object.fromEntries(url.searchParams.entries()),
          'limit',
          100,
        ),
      });
      sendJson(response, 200, {
        workspaceId: selection.workspaceId,
        status: await memoryWrapupService.status(),
        jobs,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/memory-analysis') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
      const projectId = stringValue(body, 'projectId');
      if (!workspaceId) {
        sendJson(response, 400, { error: 'memory_analysis_workspace_required' });
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
      const requestedScopes = memoryScopeListValue(body.scopes);
      if (requestedScopes?.includes('global')) {
        sendJson(response, 400, {
          error: 'memory_analysis_global_scope_not_supported',
        });
        return;
      }
      try {
        const report = await memoryAnalysisService.analyze({
          workspaceId,
          projectId,
          runId: stringValue(body, 'runId'),
          thread: body.threadId ? coerceMemoryThread(body) : undefined,
          scopes: requestedScopes,
          actorId: operatorActor(operatorAuthentication!),
        });
        sendJson(response, 200, { ...report });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'memory_analysis_failed';
        sendJson(
          response,
          message === 'memory_analysis_executor_not_ready' ? 503 : 400,
          { error: message },
        );
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/memory-query') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId', 'dev-workspace');
      const projectId = stringValue(body, 'projectId');
      const query = stringValue(body, 'query') || stringValue(body, 'q');
      if (!workspaceId || !query) {
        sendJson(response, 400, { error: 'memory_query_workspace_and_query_required' });
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
      const requestedScopes = memoryScopeListValue(body.scopes);
      if (requestedScopes?.includes('global')) {
        sendJson(response, 400, {
          error: 'memory_query_global_scope_not_supported',
        });
        return;
      }
      try {
        const report = await memoryAnalysisService.query({
          workspaceId,
          projectId,
          runId: stringValue(body, 'runId'),
          thread: body.threadId ? coerceMemoryThread(body) : undefined,
          scopes: requestedScopes,
          actorId: operatorActor(operatorAuthentication!),
          query,
        });
        sendJson(response, 200, { ...report });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'memory_query_failed';
        sendJson(
          response,
          message === 'memory_analysis_executor_not_ready' ? 503 : 400,
          { error: message },
        );
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/memory-proposals') {
      if (!memoryStore.proposeMemory) {
        sendJson(response, 501, { error: 'memory_proposals_unavailable' });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const action = stringValue(body, 'action', 'remember');
      if (
        action !== 'remember' &&
        action !== 'replace' &&
        action !== 'merge' &&
        action !== 'forget' &&
        action !== 'index'
      ) {
        sendJson(response, 400, { error: 'unsupported_memory_proposal_action' });
        return;
      }
      if (
        (action === 'replace' || action === 'index') &&
        !stringValue(body, 'selector')
      ) {
        sendJson(response, 400, {
          error:
            action === 'index'
              ? 'memory_index_selector_required'
              : 'memory_replace_selector_required',
        });
        return;
      }
      const selectors = stringArrayValue(body, 'selectors');
      if (action === 'merge' && (selectors?.length ?? 0) < 2) {
        sendJson(response, 400, { error: 'memory_merge_selectors_required' });
        return;
      }
      if (action === 'merge' && (selectors?.length ?? 0) > 8) {
        sendJson(response, 400, {
          error: 'memory_merge_selectors_limit_exceeded',
        });
        return;
      }
      if (
        (action === 'replace' || action === 'merge' || action === 'index') &&
        !Number.isInteger(numberValue(body, 'expectedDocumentVersion'))
      ) {
        sendJson(response, 400, {
          error:
            action === 'index'
              ? 'memory_index_expected_document_version_required'
              : action === 'merge'
                ? 'memory_merge_expected_document_version_required'
                : 'memory_replace_expected_document_version_required',
        });
        return;
      }
      const value =
        stringValue(body, 'text') ||
        stringValue(body, 'value') ||
        stringValue(body, 'selector');
      if (!value) {
        sendJson(response, 400, { error: 'memory_value_required' });
        return;
      }
      const thread = coerceMemoryThread(body);
      const { workspace, project } = await memoryContextForThread(thread);
      const scope = memoryScopeValue(body, 'project');
      if (
        !requireMemoryProposalWorkspace(
          response,
          operatorAuthentication!,
          scope,
          workspace?.id || thread.workspaceId,
        )
      ) {
        return;
      }
      const proposal = await memoryStore.proposeMemory({
        thread,
        workspace,
        project,
        scope,
        action,
        value,
        selector: stringValue(body, 'selector'),
        selectors,
        expectedDocumentVersion: numberValue(body, 'expectedDocumentVersion'),
        actorId: stringValue(body, 'actorId', operatorActor(operatorAuthentication!)),
        source: stringValue(body, 'source', 'operator-proposal'),
        reason: stringValue(body, 'reason'),
        searchAliases: stringArrayValue(body, 'searchAliases'),
        retentionDays:
          action === 'remember' || action === 'replace' || action === 'merge'
            ? memoryRetentionDaysFor(
                await threadConfigStore.getAccessBundle(thread, { workspace, project }),
                scope,
              )
            : undefined,
      });
      sendJson(response, 201, { proposal });
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/v1/memory-proposals/batch'
    ) {
      if (
        !memoryStore.getMemoryProposal ||
        !memoryStore.approveMemoryProposal ||
        !memoryStore.rejectMemoryProposal
      ) {
        sendJson(response, 501, { error: 'memory_proposals_unavailable' });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const action = stringValue(body, 'action');
      if (action !== 'approve' && action !== 'reject') {
        sendJson(response, 400, { error: 'unsupported_memory_proposal_batch_action' });
        return;
      }
      const ids = stringArrayValue(body, 'ids');
      if (!ids?.length) {
        sendJson(response, 400, { error: 'memory_proposal_ids_required' });
        return;
      }
      if (ids.length > 100) {
        sendJson(response, 400, { error: 'too_many_memory_proposal_ids' });
        return;
      }
      const uniqueIds = [...new Set(ids)];
      const proposals: MemoryProposal[] = [];
      const errors: Array<{ id: string; error: string }> = [];
      for (const id of uniqueIds) {
        const existing = await memoryStore.getMemoryProposal(id);
        if (!existing) {
          errors.push({ id, error: 'memory_proposal_not_found' });
          continue;
        }
        const allowed =
          existing.scope === 'global'
            ? operatorAuthentication!.principal?.workspaceIds.includes('*')
            : operatorCanAccessWorkspace(
                operatorAuthentication!.principal,
                existing.scopeRef.workspaceId || 'dev-workspace',
              );
        if (!allowed) {
          errors.push({ id, error: 'operator_workspace_forbidden' });
          continue;
        }
        try {
          const proposal =
            action === 'approve'
              ? await memoryStore.approveMemoryProposal({
                  id,
                  actorId: operatorActor(operatorAuthentication!),
                  reason: stringValue(body, 'reason'),
                })
              : await memoryStore.rejectMemoryProposal({
                  id,
                  actorId: operatorActor(operatorAuthentication!),
                  reason: stringValue(body, 'reason'),
                });
          proposals.push(proposal);
        } catch (error) {
          errors.push({
            id,
            error:
              error instanceof Error
                ? error.message
                : 'memory_proposal_decision_failed',
          });
        }
      }
      sendJson(response, errors.length ? 207 : 200, {
        action,
        requested: uniqueIds.length,
        decided: proposals.length,
        failed: errors.length,
        proposals,
        errors,
      });
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/v1/memory-proposals/')
    ) {
      if (
        !memoryStore.getMemoryProposal ||
        !memoryStore.approveMemoryProposal ||
        !memoryStore.rejectMemoryProposal
      ) {
        sendJson(response, 501, { error: 'memory_proposals_unavailable' });
        return;
      }
      const suffix = url.pathname.slice('/v1/memory-proposals/'.length);
      const [encodedId, action] = suffix.split('/');
      const id = decodeURIComponent(encodedId || '');
      if (action !== 'approve' && action !== 'reject') {
        sendJson(response, 404, { error: 'memory_proposal_route_not_found' });
        return;
      }
      const existing = await memoryStore.getMemoryProposal(id);
      if (!existing) {
        sendJson(response, 404, { error: 'memory_proposal_not_found' });
        return;
      }
      if (
        !requireMemoryProposalWorkspace(
          response,
          operatorAuthentication!,
          existing.scope,
          existing.scopeRef.workspaceId,
        )
      ) {
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      try {
        const proposal =
          action === 'approve'
            ? await memoryStore.approveMemoryProposal({
                id,
                actorId: operatorActor(operatorAuthentication!),
                reason: stringValue(body, 'reason'),
              })
            : await memoryStore.rejectMemoryProposal({
                id,
                actorId: operatorActor(operatorAuthentication!),
                reason: stringValue(body, 'reason'),
              });
        sendJson(response, 200, { proposal });
      } catch (error) {
        sendJson(response, 409, {
          error:
            error instanceof Error
              ? error.message
              : 'memory_proposal_decision_failed',
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/memory-search') {
      if (!memoryStore.searchMemory) {
        sendJson(response, 501, { error: 'memory_search_unavailable' });
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const searchQuery = stringValue(query, 'q') || stringValue(query, 'query');
      if (!searchQuery) {
        sendJson(response, 400, { error: 'memory_search_query_required' });
        return;
      }
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
      try {
        const result = await memoryStore.searchMemory({
          thread,
          workspace,
          project,
          scopes: [scope],
          query: searchQuery,
          limit: numberValue(query, 'limit', 25),
        });
        sendJson(response, 200, {
          route: {
            workspaceId: workspace?.id,
            projectId: project?.id,
            channelId: thread.channelId,
            threadId: thread.id,
            platform: thread.platform,
          },
          scope,
          ...result,
        });
      } catch (error) {
        sendJson(response, 400, {
          error:
            error instanceof Error ? error.message : 'memory_search_failed',
        });
      }
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
      const expiry = memoryStore.getMemoryExpiry
        ? await memoryStore.getMemoryExpiry({
            thread,
            workspace,
            project,
            scope,
            includeAudit: true,
            limit: numberValue(query, 'expiryAuditLimit') || 20,
          })
        : undefined;
      sendJson(response, 200, {
        route: {
          workspaceId: workspace?.id,
          projectId: project?.id,
          channelId: thread.channelId,
          threadId: thread.id,
          platform: thread.platform,
        },
        scope,
        snapshot,
        history,
        expiry,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/memory-expiry') {
      if (!memoryStore.setMemoryExpiry) {
        sendJson(response, 501, { error: 'memory_expiry_unavailable' });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const thread = coerceMemoryThread(body);
      const { workspace, project } = await memoryContextForThread(thread);
      const scope = memoryScopeValue(body, 'project');
      const memoryAllowed =
        scope === 'global'
          ? requireInstallationOperator(response, operatorAuthentication!)
          : requireOperatorWorkspace(
              response,
              operatorAuthentication!,
              workspace?.id || thread.workspaceId || 'dev-workspace',
            );
      if (!memoryAllowed) return;
      try {
        const expiry = await memoryStore.setMemoryExpiry({
          thread,
          workspace,
          project,
          scope,
          selector: stringValue(body, 'selector') || '',
          expiresAt: stringValue(body, 'expiresAt'),
          actorId: operatorActor(operatorAuthentication!),
          source: 'operator-api',
        });
        sendJson(response, 200, { expiry });
      } catch (error) {
        sendJson(response, 400, {
          error:
            error instanceof Error ? error.message : 'memory_expiry_update_failed',
        });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/memory-export') {
      if (!memoryStore.exportMemory) {
        sendJson(response, 501, { error: 'memory_export_unavailable' });
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const scopes = memoryScopeListValue(
        url.searchParams.getAll('scope').length > 1
          ? url.searchParams.getAll('scope')
          : url.searchParams.get('scope') || undefined,
      );
      const includesGlobal =
        !scopes?.length || scopes.includes('global');
      if (
        includesGlobal &&
        !requireInstallationOperator(response, operatorAuthentication!)
      ) {
        return;
      }
      const workspaceSelection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!workspaceSelection.ok) return;
      const projectId = await resolvedProjectMemoryId(
        workspaceSelection.workspaceId,
        stringValue(query, 'projectId'),
      );
      const exportResult = await memoryStore.exportMemory({
        workspaceId: workspaceSelection.workspaceId,
        projectId,
        channelId: stringValue(query, 'channelId'),
        threadId: stringValue(query, 'threadId'),
        scopes,
        includeRevisions: booleanValue(query, 'includeRevisions', false),
        revisionLimit: numberValue(query, 'revisionLimit'),
      });
      sendJson(response, 200, {
        ...exportResult,
        counts: {
          documents: exportResult.documents.length,
          revisions: exportResult.revisions.length,
        },
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/memory-diff') {
      if (!memoryStore.diffMemory) {
        sendJson(response, 501, { error: 'memory_diff_unavailable' });
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const thread = coerceMemoryThread(query);
      const { workspace, project } = await memoryContextForThread(thread);
      const scope = memoryScopeValue(query, 'project');
      const revisionId = stringValue(query, 'revisionId');
      if (!revisionId) {
        sendJson(response, 400, { error: 'memory_revision_required' });
        return;
      }
      const memoryAllowed =
        scope === 'global'
          ? requireInstallationOperator(response, operatorAuthentication!)
          : requireOperatorWorkspace(
              response,
              operatorAuthentication!,
              workspace?.id || thread.workspaceId || 'dev-workspace',
            );
      if (!memoryAllowed) return;
      try {
        const diff = await memoryStore.diffMemory({
          thread,
          workspace,
          project,
          scope,
          revisionId,
          compareToRevisionId: stringValue(query, 'compareToRevisionId'),
        });
        sendJson(response, 200, {
          route: {
            workspaceId: workspace?.id,
            projectId: project?.id,
            channelId: thread.channelId,
            threadId: thread.id,
            platform: thread.platform,
          },
          scope,
          diff,
        });
      } catch (error) {
        sendJson(response, 404, {
          error:
            error instanceof Error ? error.message : 'memory_revision_not_found',
        });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/memory-compact') {
      if (!memoryStore.compactMemory) {
        sendJson(response, 501, { error: 'memory_compaction_unavailable' });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const scopes = memoryScopeListValue(body.scope);
      const includesGlobal =
        !scopes?.length || scopes.includes('global');
      if (
        includesGlobal &&
        !requireInstallationOperator(response, operatorAuthentication!)
      ) {
        return;
      }
      const workspaceSelection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        stringValue(body, 'workspaceId'),
      );
      if (!workspaceSelection.ok) return;
      const projectId = await resolvedProjectMemoryId(
        workspaceSelection.workspaceId,
        stringValue(body, 'projectId'),
      );
      const apply = booleanValue(body, 'apply', false) === true;
      const result = await memoryStore.compactMemory({
        workspaceId: workspaceSelection.workspaceId,
        projectId,
        channelId: stringValue(body, 'channelId'),
        threadId: stringValue(body, 'threadId'),
        scopes,
        dryRun: !apply,
        keepLatestPerDocument: numberValue(body, 'keepLatestPerDocument'),
      });
      sendJson(response, 200, {
        ...result,
        apply,
        counts: {
          scannedDocuments: result.scannedDocuments,
          scannedRevisions: result.scannedRevisions,
          droppedRevisions: result.droppedRevisions.length,
          keptRevisions: result.keptRevisions.length,
        },
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
              channelId: thread.channelId,
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
        expiresAt: action === 'remember' ? stringValue(body, 'expiresAt') : undefined,
        useDefaultRetention:
          action === 'remember' && stringValue(body, 'retentionOverride') === 'keep'
            ? false
            : undefined,
        bypassApproval: true,
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

    if (request.method === 'GET' && url.pathname === '/v1/assistant/sessions') {
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      const projectId = url.searchParams.get('projectId') || undefined;
      const bindings = (await deliveryStore.listThreadBindings(500, selection.workspaceId))
        .filter(isWebAssistantBinding)
        .filter((binding) => !projectId || binding.projectId === projectId);
      const runs = await deliveryStore.listAgentRuns({
        workspaceId: selection.workspaceId,
        projectId,
        limit: 500,
      });
      const sessions = bindings
        .map((binding) => webAssistantSessionSummary(binding, runs))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      sendJson(response, 200, { sessions });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/assistant/sessions') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId') || 'dev-workspace';
      const projectId = stringValue(body, 'projectId');
      if (!projectId) {
        sendJson(response, 400, { error: 'assistant_project_required' });
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
        (candidate) =>
          candidate.projectId === projectId || candidate.id === projectId,
      );
      if (!project) {
        sendJson(response, 404, { error: 'assistant_project_not_found' });
        return;
      }
      const sessionId = randomUUID();
      const externalId = `assistant:${sessionId}`;
      const threadId = `web:${workspaceId}:${project.projectId}:${sessionId}`;
      const binding = await deliveryStore.configureThreadBinding({
        platform: 'web',
        externalId,
        scope: 'thread',
        source: 'configured',
        channelId: `web:${workspaceId}:${project.projectId}`,
        workspaceId,
        projectId: project.projectId,
        title: (stringValue(body, 'title') || 'New conversation').slice(0, 120),
        activationMode: 'always',
        requireMention: false,
        actor: operatorActor(operatorAuthentication!),
        reason: 'web_assistant_session_created',
        metadata: {
          webAssistant: true,
          webAssistantSessionId: sessionId,
          webAssistantThreadId: threadId,
          createdBy: operatorActor(operatorAuthentication!),
        },
      });
      sendJson(response, 201, await webAssistantSessionSnapshot(binding));
      return;
    }

    const assistantSessionMatch = /^\/v1\/assistant\/sessions\/([^/]+)$/u.exec(
      url.pathname,
    );
    if (request.method === 'GET' && assistantSessionMatch) {
      const sessionId = decodeURIComponent(assistantSessionMatch[1]);
      const binding = await deliveryStore.getThreadBinding(
        'web',
        `assistant:${sessionId}`,
      );
      if (!binding || !isWebAssistantBinding(binding)) {
        sendJson(response, 404, { error: 'assistant_session_not_found' });
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
      sendJson(response, 200, await webAssistantSessionSnapshot(binding));
      return;
    }

    const assistantEventsMatch =
      /^\/v1\/assistant\/sessions\/([^/]+)\/events$/u.exec(url.pathname);
    if (request.method === 'GET' && assistantEventsMatch) {
      const sessionId = decodeURIComponent(assistantEventsMatch[1]);
      const binding = await deliveryStore.getThreadBinding(
        'web',
        `assistant:${sessionId}`,
      );
      if (!binding || !isWebAssistantBinding(binding)) {
        sendJson(response, 404, { error: 'assistant_session_not_found' });
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
      await streamWebAssistantEvents({ request, response, url, binding });
      return;
    }

    const assistantMessageMatch =
      /^\/v1\/assistant\/sessions\/([^/]+)\/messages$/u.exec(url.pathname);
    if (request.method === 'POST' && assistantMessageMatch) {
      const sessionId = decodeURIComponent(assistantMessageMatch[1]);
      const binding = await deliveryStore.getThreadBinding(
        'web',
        `assistant:${sessionId}`,
      );
      if (!binding || !isWebAssistantBinding(binding)) {
        sendJson(response, 404, { error: 'assistant_session_not_found' });
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
      const body = (await readJsonBody(
        request,
        clientIngressBodyMaxBytes,
      )) as Record<string, unknown>;
      const text = stringValue(body, 'text')?.trim() || '';
      const attachments = coerceAttachments(body.attachments);
      if (!text && !attachments?.length) {
        sendJson(response, 400, {
          error: 'assistant_message_text_or_attachments_required',
        });
        return;
      }
      const thread = webAssistantThread(binding);
      const messageId = randomUUID();
      const message: SourceMessage = {
        id: messageId,
        threadId: thread.id,
        platform: 'web',
        text,
        actor: {
          id: operatorActor(operatorAuthentication!),
          displayName: operatorAuthentication!.principal?.displayName,
        },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
        attachments,
        metadata: {
          eventType: 'web.assistant.message',
          webAssistant: true,
        },
      };
      if (binding.title === 'New conversation' && text) {
        const title = text.replace(/\s+/gu, ' ').trim().slice(0, 72);
        if (title) {
          await deliveryStore.configureThreadBinding({
            platform: binding.platform,
            externalId: binding.externalId,
            scope: binding.scope,
            source: binding.source,
            channelId: binding.channelId,
            workspaceId: binding.workspaceId,
            projectId: binding.projectId,
            title,
            activationMode: binding.activationMode,
            requireMention: binding.requireMention,
            metadata: binding.metadata,
            actor: operatorActor(operatorAuthentication!),
            reason: 'web_assistant_session_auto_titled',
          });
        }
      }
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'web',
        externalId: `${sessionId}:${messageId}`,
        eventType: 'web.assistant.message',
        workspaceId: binding.workspaceId,
        projectId: binding.projectId,
        threadId: thread.id,
        messageId,
        metadata: {
          ingress: 'web-assistant',
          sessionId,
          operatorId: operatorAuthentication!.principal?.id,
        },
      });
      await recordSourceThreadMessage({ thread, message });
      const control = await handleRunControlCommand(
        { thread, message },
        inbound.record.id,
      );
      if (control) {
        sendJson(response, 200, {
          ...control,
          snapshot: await webAssistantSessionSnapshot(binding),
        });
        return;
      }
      const queued = await enqueueMessageRun(
        { thread, message },
        {
          inboundEventId: inbound.record.id,
          metadata: {
            source: 'web-assistant',
            webAssistantSessionId: sessionId,
            operatorId: operatorAuthentication!.principal?.id,
          },
        },
      );
      if (queued.disposition !== 'denied') scheduleAgentWorkerPass();
      sendJson(response, 202, {
        ...(await queuedMessageRunResponse(queued, binding.workspaceId)),
        sessionId,
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
      const requestedLimit = Math.max(
        1,
        Math.min(200, Math.floor(numberValue(query, 'limit', 20) || 20)),
      );
      const searchQuery = stringValue(query, 'q')?.slice(0, 200);
      const runs = await deliveryStore.listAgentRuns({
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
        query: searchQuery,
        limit: requestedLimit + 1,
      });
      sendJson(response, 200, {
        runs: runs.slice(0, requestedLimit),
        query: searchQuery,
        truncated: runs.length > requestedLimit,
      });
      return;
    }

    const artifactDownloadMatch =
      request.method === 'GET'
        ? /^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)$/u.exec(url.pathname)
        : null;
    if (artifactDownloadMatch) {
      const runId = decodeURIComponent(artifactDownloadMatch[1]);
      const artifactId = decodeURIComponent(artifactDownloadMatch[2]);
      const run = await deliveryStore.getAgentRun(runId);
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
      const file = await managedArtifactBytes({ runId, artifactId });
      if (!file) {
        sendJson(response, 404, { error: 'artifact_not_found_or_invalid' });
        return;
      }
      response.writeHead(200, {
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'content-length': String(file.bytes.byteLength),
        'content-type': file.mimeType,
        'x-content-type-options': 'nosniff',
      });
      response.end(file.bytes);
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
      const detailLimit = Number(url.searchParams.get('limit') || 100);
      const [
        events,
        steering,
        sessions,
        artifacts,
        outbox,
        turnDeliveries,
        usageSnapshot,
        threadRuns,
      ] = await Promise.all([
        deliveryStore.listAgentRunEvents(id, detailLimit),
        deliveryStore.listAgentRunSteering({
          runId: id,
          limit: detailLimit,
        }),
        deliveryStore.listAgentThreadSessions({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          threadId: run.threadId,
          limit: 20,
        }),
        runArtifacts(id),
        deliveryStore.listOutbox({ runId: id, limit: detailLimit }),
        deliveryStore.listTurnDeliveries({ runId: id, limit: detailLimit }),
        deliveryStore.usageSnapshot({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          limit: 1_000,
        }),
        deliveryStore.listAgentRuns({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          threadId: run.threadId,
          limit: 50,
        }),
      ]);
      sendJson(response, 200, {
        run,
        events,
        steering,
        sessions,
        artifacts,
        usage:
          usageSnapshot.records.find(
            (record) => record.runId === id && record.purpose === 'agent',
          ) ?? usageSnapshot.records.find((record) => record.runId === id),
        deliveries: {
          outbox: outbox.map(stripPayload),
          turns: turnDeliveries,
        },
        threadRuns,
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
        if (queued.disposition !== 'denied') scheduleAgentWorkerPass();
        sendJson(
          response,
          202,
          await queuedMessageRunResponse(queued, workspaceId),
        );
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
          producer: 'http-ingress',
          sourceExternalId: stringValue(body, 'sourceExternalId'),
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

    if (alertmanagerIngressMatch) {
      const routeId = decodeURIComponent(alertmanagerIngressMatch[1]);
      const route = await workflowStore.getProducerRoute(routeId);
      if (!route || route.status === 'archived') {
        sendJson(response, 404, {
          accepted: false,
          reason: 'workflow_producer_route_not_found',
        });
        return;
      }
      let normalized;
      try {
        normalized = normalizeAlertmanagerWorkflowEvent(
          await readJsonBody(request, alertmanagerIngressBodyMaxBytes),
        );
      } catch (error) {
        const message =
          error instanceof ManagedContentError
            ? error.code
            : error instanceof SyntaxError
              ? 'alertmanager_payload_invalid_json'
              : error instanceof Error
                ? error.message
                : String(error);
        const rejected = await deliveryStore.recordInboundEvent({
          platform: 'workflow',
          externalId: `alertmanager:rejected:${route.id}:${randomUUID()}`,
          eventType: 'alertmanager.invalid',
          workspaceId: route.workspaceId,
          projectId: route.projectId,
          metadata: {
            ingress: 'alertmanager-webhook',
            producer: 'alertmanager-webhook',
            sourceExternalId: route.id,
            reason: message,
          },
        });
        await deliveryStore.markInboundEventRejected(rejected.record.id, message);
        sendJson(
          response,
          error instanceof ManagedContentError ? error.statusCode : 400,
          { accepted: false, reason: message },
        );
        return;
      }
      const eventId = `${route.id}:${normalized.eventId}`;
      const externalId = `alertmanager:${eventId}`;
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'workflow',
        externalId,
        eventType: normalized.eventType,
        workspaceId: route.workspaceId,
        projectId: route.projectId,
        metadata: {
          ingress: 'alertmanager-webhook',
          producer: 'alertmanager-webhook',
          workflowEventType: normalized.eventType,
          sourceExternalId: route.id,
          alertCount: normalized.alertCount,
          truncatedAlerts: normalized.truncatedAlerts,
        },
      });
      if (!route.enabled) {
        if (!inbound.duplicate || inbound.record.status !== 'processed') {
          await deliveryStore.markInboundEventIgnored(
            inbound.record.id,
            'workflow_producer_route_disabled',
          );
        }
        sendJson(response, 202, {
          accepted: false,
          reason: 'workflow_producer_route_disabled',
          duplicate: inbound.duplicate,
          route: { id: route.id },
        });
        return;
      }
      if (!workflowsEnabled) {
        if (!inbound.duplicate || inbound.record.status !== 'processed') {
          await deliveryStore.markInboundEventIgnored(
            inbound.record.id,
            'workflows_disabled',
          );
        }
        sendJson(response, 202, {
          accepted: false,
          reason: 'workflows_disabled',
          producer: 'alertmanager-webhook',
          eventType: normalized.eventType,
        });
        return;
      }
      try {
        const staged = await workflowStore.triggerEvent({
          workspaceId: route.workspaceId,
          projectId: route.projectId,
          eventType: normalized.eventType,
          eventId,
          payload: normalized.payload,
          actor: normalized.actor,
          producer: 'alertmanager-webhook',
          sourceExternalId: route.id,
        });
        const tick = workflowCoordinatorInline && staged.staged.length > 0
          ? await runWorkflowCoordinatorTick()
          : undefined;
        await deliveryStore.markInboundEventProcessed(inbound.record.id, {
          workspaceId: route.workspaceId,
          projectId: route.projectId,
          metadata: {
            producer: 'alertmanager-webhook',
            workflowEventType: normalized.eventType,
            sourceExternalId: route.id,
            alertCount: normalized.alertCount,
            truncatedAlerts: normalized.truncatedAlerts,
            workflowMatched: staged.matched,
            workflowStaged: Math.max(
              Number(inbound.record.metadata?.workflowStaged || 0),
              staged.staged.length,
              staged.duplicates.length,
            ),
            workflowDuplicates: staged.duplicates.length,
          },
        });
        sendJson(response, 202, {
          accepted: true,
          duplicate: inbound.duplicate,
          producer: 'alertmanager-webhook',
          eventType: normalized.eventType,
          eventId,
          route: {
            id: route.id,
            workspaceId: route.workspaceId,
            projectId: route.projectId,
          },
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
        const message = error instanceof Error ? error.message : String(error);
        await deliveryStore.markInboundEventFailed(inbound.record.id, message);
        sendJson(response, 400, { accepted: false, error: message });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/client/events') {
      const body = (await readJsonBody(
        request,
        clientIngressBodyMaxBytes,
      )) as Record<string, unknown>;
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
      const result = await ingestClientEvent(normalized, {
        asyncRequested,
        ingress: 'client',
        includeDelivery: true,
      });
      sendJson(response, result.statusCode, result.body);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/lark/history-imports') {
      const selection = operatorCollectionWorkspace(
        response,
        operatorAuthentication!,
        url.searchParams.get('workspaceId') || undefined,
      );
      if (!selection.ok) return;
      const jobs = await deliveryStore.listLarkHistoryImports({
        workspaceId: selection.workspaceId,
        projectId: url.searchParams.get('projectId') || undefined,
        channelId: url.searchParams.get('channelId') || undefined,
        limit: numberValue(Object.fromEntries(url.searchParams.entries()), 'limit', 100),
      });
      sendJson(response, 200, {
        workspaceId: selection.workspaceId,
        status: await larkHistoryImportService.status(selection.workspaceId),
        jobs,
      });
      return;
    }

    if (
      request.method === 'POST' &&
      (url.pathname === '/v1/lark/history-imports/preview' ||
        url.pathname === '/v1/lark/history-imports')
    ) {
      const body = (await readJsonBody(request, 64 * 1024)) as Record<string, unknown>;
      const workspaceId = stringValue(body, 'workspaceId');
      const channelId = stringValue(body, 'channelId');
      const sinceValue = isoDateValue(body.since);
      const untilValue = isoDateValue(body.until) || new Date().toISOString();
      if (!workspaceId || !channelId || !sinceValue) {
        sendJson(response, 400, { error: 'lark_history_import_workspace_channel_range_required' });
        return;
      }
      if (!requireOperatorWorkspace(response, operatorAuthentication!, workspaceId)) return;
      const since = new Date(sinceValue);
      const until = new Date(untilValue);
      const maximumRangeMs = numberEnvironmentValue(
        'OPENTAG_LARK_HISTORY_IMPORT_MAX_RANGE_MS',
        5 * 365 * 24 * 60 * 60_000,
      );
      if (
        since.getTime() >= until.getTime() ||
        until.getTime() - since.getTime() > maximumRangeMs
      ) {
        sendJson(response, 400, {
          error: 'lark_history_import_invalid_range',
          maximumRangeMs,
        });
        return;
      }
      if (larkTransportStatus().mode !== 'http') {
        sendJson(response, 503, { error: 'lark_http_transport_required' });
        return;
      }
      const bindings = await deliveryStore.listThreadBindings(5_000, workspaceId);
      const channelBinding =
        bindings.find(
          (binding) =>
            binding.platform === 'lark' &&
            binding.scope === 'channel' &&
            binding.externalId === channelId,
        ) ||
        bindings.find(
          (binding) =>
            binding.platform === 'lark' && binding.channelId === channelId,
        );
      if (!channelBinding) {
        sendJson(response, 404, { error: 'lark_history_import_channel_not_bound' });
        return;
      }
      const requestedProjectId = stringValue(body, 'projectId');
      if (requestedProjectId && requestedProjectId !== channelBinding.projectId) {
        sendJson(response, 409, { error: 'lark_history_import_project_binding_mismatch' });
        return;
      }
      const projectId = channelBinding.projectId;
      let chat: LarkChatInfo | undefined;
      try {
        chat = await larkResourceTransport().getChat(channelId, {
          signal: AbortSignal.timeout(larkChatInfoTimeoutMs),
        });
      } catch {
        // The actual preview/import call below returns the precise Lark scope error.
      }
      const channelTitle = chat?.name || channelBinding.title || channelId;
      if (url.pathname.endsWith('/preview')) {
        try {
          const preview = await larkHistoryImportService.preview({
            workspaceId,
            projectId,
            channelId,
            channelTitle,
            since,
            until,
            maxMessages: Math.min(numberValue(body, 'maxMessages', 1_000) || 1_000, 5_000),
          });
          sendJson(response, preview.errors.length ? 207 : 200, { ...preview });
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : 'lark_history_import_preview_failed',
          });
        }
        return;
      }
      const thread: SourceThread = {
        id: `lark:${channelId}:main`,
        platform: 'lark',
        externalId: `${channelId}:main`,
        workspaceId,
        projectId,
        channelId,
        title: channelTitle,
        visibility: chat?.chatType === 'public' ? 'public' : 'private',
        metadata: {
          larkConversationMode: 'main',
          larkChatMode: chat?.chatMode,
          larkChatType: chat?.chatType,
          historyInitialization: true,
        },
      };
      try {
        const job = await deliveryStore.createLarkHistoryImport({
          workspaceId,
          projectId,
          channelId,
          channelTitle,
          thread,
          mode: 'history',
          since,
          until,
          analyzeMemory: booleanValue(body, 'analyzeMemory', true) ?? true,
          requestedBy: operatorActor(operatorAuthentication!),
        });
        setTimeout(() => {
          void larkHistoryImportService.runPass().catch((error) => {
            console.error('MaxTag Lark history import pass failed', error);
          });
        }, 0).unref?.();
        sendJson(response, 202, { accepted: true, job });
      } catch (error) {
        sendJson(response, 409, {
          error: error instanceof Error ? error.message : 'lark_history_import_create_failed',
        });
      }
      return;
    }

    const historyImportCancelMatch = /^\/v1\/lark\/history-imports\/([^/]+)\/cancel$/u.exec(
      url.pathname,
    );
    if (request.method === 'POST' && historyImportCancelMatch) {
      const job = await deliveryStore.getLarkHistoryImport(
        decodeURIComponent(historyImportCancelMatch[1]),
      );
      if (!job) {
        sendJson(response, 404, { error: 'lark_history_import_not_found' });
        return;
      }
      if (!requireOperatorWorkspace(response, operatorAuthentication!, job.workspaceId)) return;
      const cancelled = await deliveryStore.cancelLarkHistoryImport(
        job.id,
        `operator:${operatorActor(operatorAuthentication!)}:cancelled`,
      );
      sendJson(response, 200, { job: cancelled });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/lark/backfill') {
      const body = (await readJsonBody(request, 64 * 1024)) as Record<
        string,
        unknown
      >;
      const workspaceId = stringValue(body, 'workspaceId');
      const sinceValue = isoDateValue(body.since);
      const untilValue = isoDateValue(body.until) || new Date().toISOString();
      const since = sinceValue ? new Date(sinceValue) : undefined;
      const until = new Date(untilValue);
      const requestedCheckpoints = recordValue(body, 'checkpoints') || {};
      const maxWindowMs = numberEnvironmentValue(
        'OPENTAG_LARK_BACKFILL_MAX_WINDOW_MS',
        24 * 60 * 60_000,
      );
      if (
        !workspaceId ||
        !since ||
        since.getTime() >= until.getTime()
      ) {
        sendJson(response, 400, {
          accepted: false,
          reason: 'lark_backfill_workspace_and_bounded_window_required',
          maxWindowMs,
        });
        return;
      }
      if (larkTransportStatus().mode !== 'http') {
        sendJson(response, 503, {
          accepted: false,
          reason: 'lark_http_transport_required',
        });
        return;
      }
      const bindings = await deliveryStore.listThreadBindings(5_000, workspaceId);
      const channelBindings = new Map<string, typeof bindings>();
      for (const binding of bindings) {
        if (binding.platform !== 'lark') continue;
        const channelId =
          binding.channelId ||
          (binding.scope === 'channel' ? binding.externalId : undefined);
        if (!channelId) continue;
        const current = channelBindings.get(channelId) || [];
        current.push(binding);
        channelBindings.set(channelId, current);
      }
      const maxChannels = numberEnvironmentValue(
        'OPENTAG_LARK_BACKFILL_MAX_CHANNELS',
        500,
      );
      if (channelBindings.size > maxChannels) {
        sendJson(response, 413, {
          accepted: false,
          reason: 'lark_backfill_channel_limit_exceeded',
          channels: channelBindings.size,
          maxChannels,
        });
        return;
      }
      const maxMessages = Math.min(
        numberValue(body, 'maxMessages', 1_000) || 1_000,
        numberEnvironmentValue('OPENTAG_LARK_BACKFILL_MAX_MESSAGES', 1_000),
      );
      const channelResults = [];
      for (const [channelId, scopedBindings] of channelBindings) {
        const checkpointValue = isoDateValue(requestedCheckpoints[channelId]);
        const channelSince = checkpointValue ? new Date(checkpointValue) : since;
        if (channelSince.getTime() >= until.getTime()) {
          channelResults.push({
            channelId,
            complete: false,
            workspaceId,
            since: channelSince.toISOString(),
            until: until.toISOString(),
            channels: 1,
            threads: 0,
            scanned: 0,
            replayed: 0,
            duplicates: 0,
            ignored: 0,
            failed: 1,
            truncated: false,
            errors: [
              {
                channelId,
                containerType: 'chat',
                error: 'lark_backfill_checkpoint_not_before_until',
              },
            ],
          });
          continue;
        }
        const channelUntil = new Date(
          Math.min(until.getTime(), channelSince.getTime() + maxWindowMs),
        );
        const result = await backfillLarkHistory({
          workspaceId,
          since: channelSince,
          until: channelUntil,
          bindings: scopedBindings,
          transport: larkResourceTransport(),
          botOpenId,
          maxMessages,
          ingest: async (normalized) => {
            const replay = await ingestClientEvent(normalized, {
              asyncRequested: true,
              ingress: 'lark-long-connection-backfill',
            });
            return {
              accepted: replay.body.accepted !== false,
              duplicate: replay.body.duplicate === true,
              reason:
                typeof replay.body.reason === 'string'
                  ? replay.body.reason
                  : undefined,
            };
          },
        });
        channelResults.push({ channelId, ...result });
      }
      const complete = channelResults.every((result) => result.complete);
      const caughtUp = channelResults.every(
        (result) => result.complete && result.until === until.toISOString(),
      );
      const totals = channelResults.reduce(
        (summary, result) => ({
          threads: summary.threads + result.threads,
          scanned: summary.scanned + result.scanned,
          replayed: summary.replayed + result.replayed,
          duplicates: summary.duplicates + result.duplicates,
          ignored: summary.ignored + result.ignored,
          failed: summary.failed + result.failed,
        }),
        { threads: 0, scanned: 0, replayed: 0, duplicates: 0, ignored: 0, failed: 0 },
      );
      sendJson(response, complete ? 200 : 207, {
        accepted: complete,
        silent: true,
        complete,
        caughtUp,
        workspaceId,
        since: since.toISOString(),
        until: until.toISOString(),
        channels: channelResults.length,
        ...totals,
        truncated: channelResults.some((result) => result.truncated),
        channelResults,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/github/events') {
      if (!githubWebhookSecret) {
        sendJson(response, 503, {
          accepted: false,
          reason: 'github_webhook_secret_required',
          message:
            'Set OPENTAG_GITHUB_WEBHOOK_SECRET before enabling GitHub ingress.',
        });
        return;
      }
      const rawBody = await readTextBody(request);
      const parsed = parseAndValidateGitHubCallback(
        rawBody,
        request.headers,
        { webhookSecret: githubWebhookSecret },
      );
      const body = parsed.body as GitHubWebhookPayload;
      const externalId = githubCallbackExternalId(request.headers, body);
      const eventType = githubCallbackEventType(request.headers);
      if (!parsed.validation.ok) {
        const rejected = await deliveryStore.recordInboundEvent({
          platform: 'github',
          externalId: `rejected:${externalId}:${randomUUID()}`,
          eventType,
          metadata: {
            ingress: 'github-webhook',
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

      const normalized = normalizeGitHubWebhook(body, {
        eventType,
        botLogin: githubBotLogin,
        workspaceId: githubWorkspaceId,
      });
      const githubWorkflowEvent = normalizeGitHubWorkflowEvent(body, {
        eventType,
        deliveryId: externalId,
      });
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'github',
        externalId,
        eventType,
        workspaceId: normalized?.thread.workspaceId,
        projectId: normalized?.thread.projectId,
        threadId: normalized?.thread.id,
        messageId: normalized?.message.id,
        metadata: {
          ingress: 'github-webhook',
          action: body.action,
          deliveryId: request.headers['x-github-delivery'],
        },
      });
      if (inbound.duplicate && !githubWorkflowEvent) {
        sendJson(response, 200, {
          accepted: true,
          duplicate: true,
          inbound: inbound.record,
        });
        return;
      }
      // Producer redeliveries continue through the workflow store so a retry
      // can close a crash between durable ingress and event staging. The
      // workflow dedup key makes the replay idempotent once staging succeeded.
      if (eventType === 'ping') {
        await deliveryStore.markInboundEventProcessed(inbound.record.id);
        sendJson(response, 200, { accepted: true, pong: true });
        return;
      }
      if (githubWorkflowEvent) {
        if (!workflowsEnabled) {
          await deliveryStore.markInboundEventIgnored(
            inbound.record.id,
            'workflows_disabled',
            {
              metadata: {
                producer: 'github-webhook',
                workflowEventType: githubWorkflowEvent.eventType,
                sourceExternalId: githubWorkflowEvent.repositoryExternalId,
              },
            },
          );
          sendJson(response, 202, {
            accepted: false,
            reason: 'workflows_disabled',
            producer: 'github-webhook',
            eventType: githubWorkflowEvent.eventType,
          });
          return;
        }
        const binding = await deliveryStore.getThreadBindingForThread({
          platform: 'github',
          externalId: githubWorkflowEvent.repositoryExternalId,
          channelId: githubWorkflowEvent.repositoryExternalId,
        });
        if (binding?.source !== 'configured') {
          await deliveryStore.markInboundEventIgnored(
            inbound.record.id,
            'binding_required',
            {
              metadata: {
                producer: 'github-webhook',
                workflowEventType: githubWorkflowEvent.eventType,
                sourceExternalId: githubWorkflowEvent.repositoryExternalId,
              },
            },
          );
          sendJson(response, 202, {
            accepted: false,
            reason: 'binding_required',
            producer: 'github-webhook',
            eventType: githubWorkflowEvent.eventType,
            sourceExternalId: githubWorkflowEvent.repositoryExternalId,
          });
          return;
        }
        try {
          const staged = await workflowStore.triggerEvent({
            workspaceId: binding.workspaceId,
            projectId: binding.projectId,
            eventType: githubWorkflowEvent.eventType,
            eventId: githubWorkflowEvent.eventId,
            payload: githubWorkflowEvent.payload,
            actor: githubWorkflowEvent.actor,
            producer: 'github-webhook',
            sourceExternalId: githubWorkflowEvent.repositoryExternalId,
          });
          const tick = workflowCoordinatorInline && staged.staged.length > 0
            ? await runWorkflowCoordinatorTick()
            : undefined;
          await deliveryStore.markInboundEventProcessed(inbound.record.id, {
            workspaceId: binding.workspaceId,
            projectId: binding.projectId,
            metadata: {
              producer: 'github-webhook',
              workflowEventType: githubWorkflowEvent.eventType,
              sourceExternalId: githubWorkflowEvent.repositoryExternalId,
              resourceExternalId: githubWorkflowEvent.resourceExternalId,
              workflowMatched: staged.matched,
              workflowStaged: Math.max(
                Number(inbound.record.metadata?.workflowStaged || 0),
                staged.staged.length,
                staged.duplicates.length,
              ),
              workflowDuplicates: staged.duplicates.length,
            },
          });
          sendJson(response, 202, {
            accepted: true,
            producer: 'github-webhook',
            eventType: githubWorkflowEvent.eventType,
            sourceExternalId: githubWorkflowEvent.repositoryExternalId,
            route: {
              workspaceId: binding.workspaceId,
              projectId: binding.projectId,
              bindingId: binding.id,
            },
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
          const message = error instanceof Error ? error.message : String(error);
          await deliveryStore.markInboundEventFailed(inbound.record.id, message);
          sendJson(response, 400, { accepted: false, error: message });
        }
        return;
      }
      if (!normalized) {
        await deliveryStore.markInboundEventIgnored(
          inbound.record.id,
          'unsupported_github_event',
        );
        sendJson(response, 202, {
          accepted: false,
          reason: 'unsupported_github_event',
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
      await recordSourceThreadMessage(routed);
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
            channelId: routed.thread.channelId,
            rootMessageId: routed.thread.rootMessageId,
            topicId: routed.thread.topicId,
            title: routed.thread.title,
            visibility: routed.thread.visibility,
            larkChatInfoStatus: routed.thread.metadata?.larkChatInfoStatus,
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
      if (queued.disposition !== 'denied') scheduleAgentWorkerPass();
      sendJson(
        response,
        202,
        await queuedMessageRunResponse(queued, routed.thread.workspaceId),
      );
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
      await recordSourceThreadMessage(routed);
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
            channelId: routed.thread.channelId,
            rootMessageId: routed.thread.rootMessageId,
            topicId: routed.thread.topicId,
            title: routed.thread.title,
            visibility: routed.thread.visibility,
            larkChatInfoStatus: routed.thread.metadata?.larkChatInfoStatus,
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
      if (queued.disposition !== 'denied') scheduleAgentWorkerPass();
      sendJson(
        response,
        202,
        await queuedMessageRunResponse(queued, routed.thread.workspaceId),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/slack/events') {
      const rawBody = await readTextBody(request, slackCallbackMaxBytes);
      const parsed = parseAndValidateSlackCallback(rawBody, request.headers, {
        signingSecret: slackSigningSecret,
        maxSkewSeconds: slackCallbackMaxSkewSeconds,
      });
      const body = parsed.body;
      const externalId = slackCallbackExternalId(body);
      const eventType = slackCallbackEventType(body);
      if (!parsed.validation.ok) {
        const rejected = await deliveryStore.recordInboundEvent({
          platform: 'slack',
          externalId: `rejected:${externalId}:${randomUUID()}`,
          eventType,
          metadata: {
            ingress: 'slack-events-api',
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

      const normalized = normalizeSlackEvent(body as SlackEventEnvelope, {
        workspaceId: slackWorkspaceId,
        botUserId: slackBotUserId,
      });
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'slack',
        externalId,
        eventType,
        workspaceId: normalized?.thread.workspaceId,
        projectId: normalized?.thread.projectId,
        threadId: normalized?.thread.id,
        messageId: normalized?.message.id,
        metadata: {
          ingress: 'slack-events-api',
          teamId: body.team_id,
          apiAppId: body.api_app_id,
        },
      });
      if (body.type === 'url_verification' && typeof body.challenge === 'string') {
        if (!inbound.duplicate) {
          await deliveryStore.markInboundEventProcessed(inbound.record.id);
        }
        sendJson(response, 200, { challenge: body.challenge });
        return;
      }
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
          'unsupported_slack_event',
        );
        sendJson(response, 200, {
          accepted: false,
          reason: 'unsupported_slack_event',
        });
        return;
      }

      const pairing = await handlePairingCommand(normalized, inbound.record.id);
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
        sendJson(response, 200, {
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
      await recordSourceThreadMessage(routed);
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
        sendJson(response, 200, {
          accepted: false,
          reason: 'mention_required',
        });
        return;
      }
      const authorization = await authorizeRoutedMessage(routed);
      if (!authorization.allowed) {
        sendJson(
          response,
          200,
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
      if (queued.disposition !== 'denied') scheduleAgentWorkerPass();
      sendJson(
        response,
        200,
        await queuedMessageRunResponse(queued, routed.thread.workspaceId),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/lark/events') {
      if (!larkVerificationToken && !larkEncryptKey) {
        sendJson(response, 503, { error: 'lark_card_callback_not_configured' });
        return;
      }
      const rawBody = await readTextBody(request, larkCallbackMaxBytes);
      const parsed = parseAndValidateLarkCallback(rawBody, request.headers, {
        verificationToken: larkVerificationToken,
        encryptKey: larkEncryptKey,
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
      const normalized =
        typeof body.challenge !== 'string' &&
        eventType !== 'card.action.trigger'
          ? normalizeLarkEvent(body as LarkIncomingEvent, { botOpenId })
          : null;
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'lark',
        externalId,
        eventType,
        workspaceId: normalized?.thread.workspaceId,
        projectId: normalized?.thread.projectId,
        threadId: normalized?.thread.id,
        messageId: normalized?.message.id,
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
      if (larkEventMode !== 'webhook' && eventType !== 'card.action.trigger') {
        await deliveryStore.markInboundEventIgnored(
          inbound.record.id,
          'lark_message_webhook_disabled',
        );
        sendJson(response, 200, {
          accepted: true,
          ignored: true,
          reason: 'lark_message_webhook_disabled',
        });
        return;
      }
      if (eventType === 'card.action.trigger') {
        sendJson(
          response,
          200,
          await handleLarkCardAction(body, inbound.record.id),
        );
        return;
      }
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
      await recordSourceThreadMessage(routed);
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
            channelId: routed.thread.channelId,
            rootMessageId: routed.thread.rootMessageId,
            topicId: routed.thread.topicId,
            title: routed.thread.title,
            visibility: routed.thread.visibility,
            larkChatInfoStatus: routed.thread.metadata?.larkChatInfoStatus,
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
      if (queued.disposition !== 'denied') scheduleAgentWorkerPass();
      sendJson(
        response,
        202,
        await queuedMessageRunResponse(queued, routed.thread.workspaceId),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/lark/card-actions') {
      const body = (await readJsonBody(
        request,
        clientIngressBodyMaxBytes,
      )) as LarkIncomingEvent & Record<string, unknown>;
      const externalId = larkCallbackExternalId(body);
      const eventType = larkCallbackEventType(body);
      const inbound = await deliveryStore.recordInboundEvent({
        platform: 'lark',
        externalId,
        eventType,
        metadata: {
          ingress: 'lark-long-connection-card-action',
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
      sendJson(
        response,
        200,
        await handleLarkCardAction(body, inbound.record.id),
      );
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof ManagedContentError) {
      sendJson(response, error.statusCode, {
        accepted: false,
        error: error.code,
        message: error.message,
      });
      return;
    }
    sendJson(response, 500, {
      error: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

async function closeHttpServer(): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (serverShuttingDown) return;
  serverShuttingDown = true;
  console.log(`MaxTag server stopping after ${signal}`);

  if (agentWorkerTimer) clearTimeout(agentWorkerTimer);
  if (agentWorkerInterval) clearInterval(agentWorkerInterval);
  if (routineSchedulerInterval) clearInterval(routineSchedulerInterval);
  if (workflowCoordinatorInterval) clearInterval(workflowCoordinatorInterval);
  if (larkDocumentWatcherInterval) clearInterval(larkDocumentWatcherInterval);
  if (memoryWrapupInterval) clearInterval(memoryWrapupInterval);
  if (larkHistoryImportInterval) clearInterval(larkHistoryImportInterval);
  if (knowledgeEnrichmentInterval) clearInterval(knowledgeEnrichmentInterval);
  if (knowledgeRefreshInterval) clearInterval(knowledgeRefreshInterval);
  if (delegatedAgentTaskInterval) clearInterval(delegatedAgentTaskInterval);
  agentWorkerTimer = undefined;
  agentWorkerInterval = undefined;
  routineSchedulerInterval = undefined;
  workflowCoordinatorInterval = undefined;
  larkDocumentWatcherInterval = undefined;
  memoryWrapupInterval = undefined;
  larkHistoryImportInterval = undefined;
  knowledgeEnrichmentInterval = undefined;
  knowledgeRefreshInterval = undefined;
  delegatedAgentTaskInterval = undefined;
  memoryWrapupService.beginShutdown();
  larkHistoryImportService.beginShutdown();
  knowledgeEnrichmentService.beginShutdown();
  knowledgeSourceRefreshService.beginShutdown();
  delegatedAgentTaskService.beginShutdown();

  for (const response of activeAssistantStreams) {
    if (!response.writableEnded) response.end();
  }

  for (const controller of activeRuns.values()) {
    controller.abort(
      `${OPENTAG_REQUEUE_RUN_ABORT_REASON}:${signal.toLowerCase()}`,
    );
  }

  const forceExit = setTimeout(() => {
    console.error(
      `MaxTag graceful shutdown exceeded ${shutdownTimeoutMs}ms`,
    );
    server.closeAllConnections?.();
    process.exit(1);
  }, shutdownTimeoutMs);
  forceExit.unref?.();

  try {
    await Promise.all([
      closeHttpServer(),
      agentWorkerPass?.catch(() => undefined) ?? Promise.resolve(),
      startupRecoveryPass?.catch(() => undefined) ?? Promise.resolve(),
      routineScheduler.waitForIdle(),
      workflowCoordinator.waitForIdle(),
      larkDocumentWatcher.waitForIdle(),
      memoryWrapupService.waitForIdle(),
      larkHistoryImportService.waitForIdle(),
      knowledgeEnrichmentService.waitForIdle(),
      knowledgeSourceRefreshService.waitForIdle(),
      delegatedAgentTaskService.waitForIdle(),
    ]);
    sqliteStorage?.close();
    clearTimeout(forceExit);
    console.log('MaxTag server stopped');
  } catch (error) {
    clearTimeout(forceExit);
    console.error('MaxTag server shutdown failed', error);
    sqliteStorage?.close();
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

server.listen(port, host, () => {
  console.log(`MaxTag server listening on http://${host}:${port}`);
  console.log(
    `MaxTag storage driver=${storageDriver}${
      sqliteStorage
        ? ` wal=true migrated_delivery=${sqliteStorage.migration.deliveryImported} migrated_pairing=${sqliteStorage.migration.pairingImported} migrated_access=${sqliteStorage.migration.accessImported} migrated_memory=${sqliteStorage.migration.memoryImported} migrated_routines=${sqliteStorage.migration.routinesImported} migrated_workflows=${sqliteStorage.migration.workflowsImported}`
        : ''
    }`,
  );
  console.log(
    `MaxTag operator auth configured=${operatorAuth.configured} principals=${operatorAuth.principalCount}`,
  );
  // A dedicated worker owns run recovery when the server is in manual worker
  // mode. Replaying the same full delivery-state mutation in the HTTP process
  // can starve health checks while the external worker is recovering a large
  // run transcript from the shared SQLite document.
  if (agentWorkerEnabled) {
    startupRecoveryPass = deliveryStore
      .recoverStaleAgentRuns({
        olderThanMs: agentWorkerStaleMs,
        reason: 'server_startup_recovered_stale_run',
      })
      .then(async (result) => {
        if (result.requeued > 0 || result.cancelled > 0) {
          console.log(
            `MaxTag recovered agent runs requeued=${result.requeued} cancelled=${result.cancelled}`,
          );
        }
        const recoveredTools = await deliveryStore.recoverStaleToolApprovals({
          olderThanMs: agentWorkerStaleMs,
        });
        if (recoveredTools.failed > 0) {
          console.warn(
            `MaxTag marked ${recoveredTools.failed} stale tool approval execution(s) as outcome unknown`,
          );
        }
        if (!serverShuttingDown) scheduleAgentWorkerPass();
      })
      .catch((error) => {
        console.error('MaxTag failed to recover stale agent runs', error);
      })
      .finally(() => {
        startupRecoveryPass = undefined;
      });
  }
  if (agentWorkerEnabled) {
    agentWorkerInterval = setInterval(() => {
      scheduleAgentWorkerPass();
    }, agentWorkerIntervalMs);
    agentWorkerInterval.unref?.();
  }
  if (routineSchedulerInline) {
    void runRoutineSchedulerTick().catch((error) => {
      console.error('MaxTag routine startup tick failed', error);
    });
    routineSchedulerInterval = setInterval(() => {
      void runRoutineSchedulerTick().catch((error) => {
        console.error('MaxTag routine tick failed', error);
      });
    }, routineTickIntervalMs);
    routineSchedulerInterval.unref?.();
  }
  if (workflowCoordinatorInline) {
    void runWorkflowCoordinatorTick().catch((error) => {
      console.error('MaxTag workflow coordinator startup tick failed', error);
    });
    workflowCoordinatorInterval = setInterval(() => {
      void runWorkflowCoordinatorTick().catch((error) => {
        console.error('MaxTag workflow coordinator tick failed', error);
      });
    }, workflowTickIntervalMs);
    workflowCoordinatorInterval.unref?.();
  }
  if (workflowCoordinatorInline && larkDocumentWatcher.enabled) {
    void runLarkDocumentWatcherTick().catch((error) => {
      console.error('MaxTag Lark document watcher startup tick failed', error);
    });
    larkDocumentWatcherInterval = setInterval(() => {
      void runLarkDocumentWatcherTick().catch((error) => {
        console.error('MaxTag Lark document watcher tick failed', error);
      });
    }, larkDocumentWatcherIntervalMs);
    larkDocumentWatcherInterval.unref?.();
  }
  // In external-worker deployments the worker owns transcript staging and
  // memory wrapup. Running the same scan in the HTTP process repeatedly reads
  // and mutates the full shared delivery document, which can starve probes on
  // a busy workspace.
  if (agentWorkerEnabled && memoryWrapupService.enabled) {
    void memoryWrapupService.runPass().catch((error) => {
      console.error('MaxTag memory wrapup startup pass failed', error);
    });
    memoryWrapupInterval = setInterval(() => {
      void memoryWrapupService.runPass().catch((error) => {
        console.error('MaxTag memory wrapup pass failed', error);
      });
    }, memoryWrapupIntervalMs);
    memoryWrapupInterval.unref?.();
  }
  if (larkHistoryImportService.enabled) {
    void refreshLarkHistoryOnboardingCards().catch((error) => {
      console.error('MaxTag Lark onboarding card startup refresh failed', error);
    });
    void refreshActiveLarkHistoryImportStatusCards().catch((error) => {
      console.error('MaxTag Lark history status card startup refresh failed', error);
    });
    void larkHistoryImportService.runPass().catch((error) => {
      console.error('MaxTag Lark history import startup pass failed', error);
    });
    larkHistoryImportInterval = setInterval(() => {
      void larkHistoryImportService.runPass().catch((error) => {
        console.error('MaxTag Lark history import pass failed', error);
      });
    }, larkHistoryImportIntervalMs);
    larkHistoryImportInterval.unref?.();
  }
  if (knowledgeEnrichmentService.status().enabled) {
    void knowledgeEnrichmentService.runPass().catch((error) => {
      console.error('MaxTag knowledge enrichment startup pass failed', error);
    });
    knowledgeEnrichmentInterval = setInterval(() => {
      void knowledgeEnrichmentService.runPass().catch((error) => {
        console.error('MaxTag knowledge enrichment pass failed', error);
      });
    }, knowledgeEnrichmentIntervalMs);
    knowledgeEnrichmentInterval.unref?.();
  }
  if (knowledgeSourceRefreshService.enabled) {
    void knowledgeSourceRefreshService.runPass().catch((error) => {
      console.error('MaxTag knowledge refresh startup pass failed', error);
    });
    knowledgeRefreshInterval = setInterval(() => {
      void knowledgeSourceRefreshService.runPass().catch((error) => {
        console.error('MaxTag knowledge refresh pass failed', error);
      });
    }, knowledgeRefreshIntervalMs);
    knowledgeRefreshInterval.unref?.();
  }
  if (delegatedAgentTaskService.enabled) {
    void delegatedAgentTaskService.runPass().catch((error) => {
      console.error('MaxTag delegated Agent task startup pass failed', error);
    });
    delegatedAgentTaskInterval = setInterval(() => {
      void delegatedAgentTaskService.runPass().catch((error) => {
        console.error('MaxTag delegated Agent task pass failed', error);
      });
    }, delegatedAgentTaskIntervalMs);
    delegatedAgentTaskInterval.unref?.();
  }
});
