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
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';

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
}

export interface RuntimeHostRoutineConfig {
  defaultTimeZone?: string;
}

export interface RuntimeHostStorageConfig {
  driver?: 'file' | 'sqlite';
  databasePath?: string;
  busyTimeoutMs?: number;
}

export interface RuntimeHostConfig {
  dataDir: string;
  workerId?: string;
  lark?: RuntimeHostLarkConfig;
  telegram?: RuntimeHostTelegramConfig;
  executors?: RuntimeHostExecutorConfig;
  routines?: RuntimeHostRoutineConfig;
  storage?: RuntimeHostStorageConfig;
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

export class OpenTagWorkerHost {
  readonly deliveryStore: DeliveryStore;
  readonly memoryStore: ScopedFileMemoryStore;
  readonly routineStore: FileRoutineStore;
  private readonly config: RuntimeHostConfig;
  readonly threadConfigStore: FileThreadConfigStore;
  private readonly routineCommandService: RoutineCommandService;
  private readonly sqliteStorage?: SqliteOpenTagStore;
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
          })
        : undefined;
    this.deliveryStore =
      this.sqliteStorage?.deliveryStore ??
      new FileDeliveryStore(path.join(config.dataDir, 'delivery'));
    this.memoryStore = new ScopedFileMemoryStore(
      path.join(config.dataDir, 'memory'),
    );
    this.routineStore = new FileRoutineStore(
      path.join(config.dataDir, 'routines'),
    );
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
      codex: {
        command: config.codexCommand || 'codex',
        model: config.codexModel,
      },
      claude: {
        command: config.claudeCommand || 'claude',
        model: config.claudeModel,
        maxBudgetUsd: config.claudeMaxBudgetUsd,
      },
    };
  }

  async recoverStaleAgentRuns(
    options: RecoverStaleAgentRunsOptions,
  ): Promise<Awaited<ReturnType<DeliveryStore['recoverStaleAgentRuns']>>> {
    return this.deliveryStore.recoverStaleAgentRuns(options);
  }

  async deliverySnapshot(limit = 50): Promise<Record<string, unknown>> {
    const [summary, outbox, turnDeliveries, bindings, inboundEvents] =
      await Promise.all([
        this.deliveryStore.summarize(),
        this.deliveryStore.listOutbox({ limit }),
        this.deliveryStore.listTurnDeliveries({ limit }),
        this.deliveryStore.listThreadBindings(limit),
        this.deliveryStore.listInboundEvents({ limit }),
      ]);
    return {
      summary,
      outbox: outbox.map(({ payload: _payload, ...rest }) => rest),
      turnDeliveries,
      bindings,
      inboundEvents,
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
    try {
      const result = await runtime.handleMessage({
        runId,
        thread: initialRun.thread,
        message: initialRun.message,
        abortSignal: abortController.signal,
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
