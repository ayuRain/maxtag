import path from 'node:path';
import {
  OpenTagRuntime,
  type AgentRunEvent,
  type MemoryScopeKind,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformKind,
  type SourceThread,
  type Workspace,
  type Project,
} from '@opentag/core';
import { FileThreadConfigStore } from '@opentag/config';
import {
  FileDeliveryStore,
  TrackedLarkTransport,
  TrackedTelegramTransport,
  TrackedTextPlatformAdapter,
  type AgentRunRecord,
  type DeliveryStore,
  type RecoverStaleAgentRunsOptions,
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
  HttpLarkTransport,
  LarkPlatformAdapter,
  MemoryLarkTransport,
  type LarkOpenApiDomain,
  type LarkTransport,
} from '@opentag/platform-lark';
import {
  HttpTelegramTransport,
  MemoryTelegramTransport,
  TelegramPlatformAdapter,
  type TelegramTransport,
} from '@opentag/platform-telegram';
import {
  FileRoutineStore,
  RoutineCommandService,
} from '@opentag/routines';
import { FileWorkflowStore } from '@opentag/workflows';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';
import {
  createOpenTagToolBroker,
  type OpenTagToolBroker,
} from '@opentag/tool-broker';
import {
  WorkflowCoordinatorService,
  type WorkflowCoordinatorTickResult,
} from './workflow-coordinator.js';
import {
  createDurableSteeringProvider,
  monitorDurableRunCancellation,
} from './run-control.js';
import {
  createDurableProviderSessionContext,
  defaultProviderSessionNamespace,
  loadDurableConversationContext,
} from './conversation-context.js';

export * from './routine-scheduler.js';
export * from './run-control.js';
export * from './conversation-context.js';
export * from './workflow-coordinator.js';
export * from './managed-content-store.js';

export interface RuntimeHostLarkConfig {
  transportMode?: string;
  appId?: string;
  appSecret?: string;
  domain?: LarkOpenApiDomain;
  baseUrl?: string;
}

export interface RuntimeHostTelegramConfig {
  transportMode?: string;
  botToken?: string;
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
}

export interface RuntimeHostRoutineConfig {
  defaultTimeZone?: string;
}

export interface RuntimeHostWorkflowConfig {
  claimStaleMs?: number;
  batchSize?: number;
}

export interface RuntimeHostStorageConfig {
  driver?: 'file' | 'sqlite';
  databasePath?: string;
  busyTimeoutMs?: number;
}

export interface RuntimeHostToolBrokerConfig {
  githubToken?: string;
  maxCallsPerRun?: number;
  callTimeoutMs?: number;
}

export interface RuntimeHostConfig {
  dataDir: string;
  workerId?: string;
  lark?: RuntimeHostLarkConfig;
  telegram?: RuntimeHostTelegramConfig;
  executors?: RuntimeHostExecutorConfig;
  routines?: RuntimeHostRoutineConfig;
  workflows?: RuntimeHostWorkflowConfig;
  storage?: RuntimeHostStorageConfig;
  toolBroker?: RuntimeHostToolBrokerConfig;
  runControlPollMs?: number;
}

export interface AgentWorkerPassResult {
  claimed: number;
  completed: number;
  failed: number;
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
  private readonly config: RuntimeHostConfig;
  readonly threadConfigStore: FileThreadConfigStore;
  private readonly routineCommandService: RoutineCommandService;
  private readonly sqliteStorage?: SqliteOpenTagStore;
  private readonly toolBroker: OpenTagToolBroker;
  private toolLarkTransport?: HttpLarkTransport;
  private readonly activeRuns = new Map<string, AbortController>();
  private workerPass: Promise<AgentWorkerPassResult> | undefined;

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
    this.toolBroker = createOpenTagToolBroker({
      memory: this.memoryStore,
      github: { token: config.toolBroker?.githubToken },
      lark:
        config.lark?.appId &&
        config.lark?.appSecret &&
        this.larkTransportStatus().mode === 'http'
          ? {
              request: (pathname, options) =>
                this.larkOpenApiTransport().openApiRequest(pathname, options),
            }
          : undefined,
      maxCallsPerRun: config.toolBroker?.maxCallsPerRun,
      callTimeoutMs: config.toolBroker?.callTimeoutMs,
    });
    this.routineStore =
      this.sqliteStorage?.routineStore ??
      new FileRoutineStore(path.join(config.dataDir, 'routines'));
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
      },
    );
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
        return platform === 'workflow' ? 'workflow-internal' : 'tracked-text';
      },
    });
  }

  get workerId(): string {
    return this.config.workerId || `opentag-worker-${process.pid}`;
  }

  get activeRunCount(): number {
    return this.activeRuns.size;
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
      codex: {
        command: config.codexCommand || 'codex',
        model: config.codexModel,
        steeringMode: 'next_turn',
      },
      claude: {
        command: config.claudeCommand || 'claude',
        model: config.claudeModel,
        maxBudgetUsd: config.claudeMaxBudgetUsd,
        steeringMode:
          (config.mode ?? 'dry-run') === 'local-cli' ? 'live' : 'next_turn',
      },
      runControlPollMs: this.config.runControlPollMs ?? 250,
    };
  }

  async recoverStaleAgentRuns(
    options: RecoverStaleAgentRunsOptions,
  ): Promise<Awaited<ReturnType<DeliveryStore['recoverStaleAgentRuns']>>> {
    return this.deliveryStore.recoverStaleAgentRuns(options);
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
    this.workerPass = (async () => {
      const claimed = await this.deliveryStore.claimQueuedAgentRuns({
        limit,
        workerId: this.workerId,
      });
      const result: AgentWorkerPassResult = {
        claimed: claimed.length,
        completed: 0,
        failed: 0,
        runs: [],
      };
      for (const run of claimed) {
        try {
          await this.executeAgentRun(run, { alreadyClaimed: true });
          result.completed += 1;
        } catch {
          result.failed += 1;
        } finally {
          const latest = await this.deliveryStore.getAgentRun(run.id);
          if (latest) result.runs.push(latest);
          if (run.metadata?.source === 'workflow') {
            await this.workflowCoordinator.tick();
          }
        }
      }
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
      const runningRun = await this.deliveryStore.markAgentRunRunning(runId);
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
          { runId, replyToMessageId: initialRun.message.id },
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
        });
        await this.deliveryStore.appendAgentRunEvent(runId, 'memory_command', {
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
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deliveryStore.markAgentRunFailed(runId, message);
        await this.markRunInboundFailed(initialRun, message);
        throw error;
      }
    }

    const runtime = this.createRuntimeForPlatform(runPlatform.platform);
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);
    const stopCancellationMonitor = monitorDurableRunCancellation({
      deliveryStore: this.deliveryStore,
      runId,
      abortController,
      pollMs: this.config.runControlPollMs,
    });
    try {
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
        transcript,
        providerSession,
        abortSignal: abortController.signal,
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
        },
      });
      await this.markRunInboundProcessed(initialRun);
      await this.deliveryStore.markAgentRunCompleted(runId, result.summary);
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
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (abortController.signal.aborted) {
        await this.deliveryStore.markAgentRunCancelled(runId, message);
      } else {
        await this.deliveryStore.markAgentRunFailed(runId, message);
      }
      await this.markRunInboundFailed(initialRun, message);
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
  }): Promise<Record<string, unknown>> {
    const { workspace, project } = await this.memoryContextForThread(
      input.thread,
    );
    if (input.command.kind === 'remember') {
      await this.memoryStore.rememberScoped({
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
    const config = this.config.executors ?? {};
    const common = {
      mode: config.mode ?? 'dry-run',
      workspaceRoot: config.workspaceRoot,
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      inheritEnv: config.inheritEnv,
      sessionMode: config.sessionMode,
      artifactRoot:
        config.artifactRoot || path.join(this.config.dataDir, 'artifacts'),
      maxArtifactBytes: config.maxArtifactBytes,
      maxArtifacts: config.maxArtifacts,
      toolSessions: this.toolBroker,
    } as const;
    const codex = createCodexExecutor({
      ...common,
      command: config.codexCommand,
      model: config.codexModel,
    });
    const claude = createClaudeExecutor({
      ...common,
      command: config.claudeCommand,
      model: config.claudeModel,
      maxBudgetUsd: config.claudeMaxBudgetUsd,
    });
    return new OpenTagRuntime({
      platform,
      executor: codex,
      executors: { codex, claude },
      memory: this.memoryStore,
      threadConfig: this.threadConfigStore,
    });
  }

  private createPlatformForRun(thread: SourceThread): {
    platform: PlatformAdapter;
    transportMode: string;
    larkDryRun?: MemoryLarkTransport;
    larkTransport?: { mode: 'memory' | 'http' };
    telegramDryRun?: MemoryTelegramTransport;
    telegramTransport?: { mode: 'memory' | 'http' };
  } {
    if (thread.platform === 'lark') {
      const larkTransport = this.createLarkTransportForRun();
      return {
        platform: new LarkPlatformAdapter(
          new TrackedLarkTransport(larkTransport.transport, this.deliveryStore),
        ),
        transportMode: `lark-${larkTransport.mode}`,
        larkDryRun: larkTransport.dryRun,
        larkTransport: { mode: larkTransport.mode },
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

export function createOpenTagWorkerHost(
  config: RuntimeHostConfig,
): OpenTagWorkerHost {
  return new OpenTagWorkerHost(config);
}
