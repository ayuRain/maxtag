import path from 'node:path';
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentSteeringInput,
  Executor,
  ProviderSessionContext,
} from '@opentag/core';
import {
  artifactInstructions,
  buildAgentPrompt,
  collectCliArtifacts,
  createCliEnvironment,
  isCliContextOverflow,
  isMissingCliSession,
  memoryCandidateInstructions,
  resolveProjectWorkingDirectory,
  runCliCommand,
  type CliExecutorOptions,
  type CliToolSession,
} from '@opentag/executor-cli';
import {
  CodexAppServerRpcError,
  CodexAppServerSession,
  prepareCodexAppServerHome,
  type CodexAppServerUsage,
} from './app-server.js';

export interface CodexExecutorOptions extends CliExecutorOptions {
  appServer?: boolean;
  codexHome?: string;
  codexAuthSourceHome?: string;
  contextCompactionThreshold?: number;
  disableNativeShell?: boolean;
}

function allowsEmptyFinalResponse(request: AgentRunRequest): boolean {
  return (
    request.purpose === 'memory_analysis' ||
    request.purpose === 'memory_wrapup' ||
    request.purpose === 'memory_retrieval'
  );
}

type JsonRecord = Record<string, unknown>;
const CODEX_COMPACT_COMMAND = '/compact';
const CODEX_OVERFLOW_CONTINUATION = [
  'The immediately preceding turn reached the provider context limit.',
  'MaxTag compacted this same Codex thread in place.',
  'Continue and complete the user request already present in the thread.',
  'Do not repeat completed side effects or recreate approvals; inspect existing results first.',
].join(' ');

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function itemLabel(item: JsonRecord): string {
  const type = text(item.type) || 'work';
  if (type === 'command_execution') {
    return 'Run shell command';
  }
  if (type === 'mcp_tool_call') {
    return `Tool: ${text(item.tool) || text(item.name) || 'MCP call'}`;
  }
  if (type === 'file_change') return 'Apply file changes';
  if (type === 'web_search') return 'Search the web';
  if (type === 'reasoning') return 'Reason through the task';
  if (type === 'context_compaction') return 'Compact conversation context';
  return type.replaceAll('_', ' ');
}

function isManualCodexCompact(request: AgentRunRequest): boolean {
  return request.message.text.trim() === CODEX_COMPACT_COMMAND;
}

function contextCompactionRatio(
  usage: CodexAppServerUsage | undefined,
): number | undefined {
  if (!usage?.totalTokens || !usage.modelContextWindow) return undefined;
  return usage.totalTokens / usage.modelContextWindow;
}

function nativeToolCall(item: JsonRecord, id: string) {
  const type = text(item.type);
  const shared = {
    id,
    source: 'provider-native' as const,
    provider: 'codex',
    arguments: undefined,
  };
  if (type === 'command_execution') {
    return {
      ...shared,
      name: 'codex.shell',
      title: 'Codex shell command',
      grantKind: 'shell' as const,
      risk: 'write' as const,
    };
  }
  if (type === 'file_change') {
    return {
      ...shared,
      name: 'codex.file_change',
      title: 'Codex file change',
      grantKind: 'shell' as const,
      risk: 'write' as const,
    };
  }
  if (type === 'web_search') {
    return {
      ...shared,
      name: 'codex.web_search',
      title: 'Codex web search',
      grantKind: 'browser' as const,
      risk: 'read' as const,
    };
  }
  return undefined;
}

function nativeToolFailed(item: JsonRecord): boolean {
  const status = text(item.status)?.toLowerCase();
  const exitCode = item.exit_code ?? item.exitCode;
  return (
    status === 'failed' ||
    status === 'error' ||
    (typeof exitCode === 'number' && exitCode !== 0)
  );
}

function agentMessage(item: JsonRecord): string | undefined {
  if (item.type !== 'agent_message') return undefined;
  const direct = text(item.text) || text(item.message);
  if (direct) return direct;
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content
    .map((part) => record(part))
    .map((part) => text(part?.text))
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('\n') : undefined;
}

function buildLiveSteeringPrompt(input: AgentSteeringInput): string {
  const attachments = input.message.attachments?.map((attachment) =>
    [attachment.kind, attachment.name, attachment.localPath || attachment.url]
      .filter(Boolean)
      .join(': '),
  );
  return [
    `Live follow-up from ${input.message.actor.displayName || input.message.actor.id}:`,
    input.message.text.trim() || '(no text)',
    attachments?.length ? `Attachments:\n${attachments.join('\n')}` : '',
    'Incorporate this follow-up into the work already in progress.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function codexNativeWebEnabled(request: AgentRunRequest): boolean {
  void request;
  return false;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexMcpConfigArgs(session: CliToolSession): string[] {
  const prefix = `mcp_servers.${session.mcp.name}`;
  const args = [
    '-c',
    `${prefix}.command=${tomlString(session.mcp.command)}`,
    '-c',
    `${prefix}.args=${JSON.stringify(session.mcp.args)}`,
  ];
  for (const [name, value] of Object.entries(session.mcp.env)) {
    args.push('-c', `${prefix}.env.${name}=${tomlString(value)}`);
  }
  return args;
}

export class CodexExecutor implements Executor {
  readonly id = 'codex';
  readonly label = 'Codex';
  private readonly options: CodexExecutorOptions;

  get steeringMode(): 'live' | 'next_turn' {
    return (this.options.mode ?? 'dry-run') === 'local-cli' &&
      this.appServerEnabled()
      ? 'live'
      : 'next_turn';
  }

  constructor(options?: CodexExecutorOptions) {
    this.options = options ?? {};
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const mode = this.options.mode ?? 'dry-run';
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-plan',
        label: 'Prepare Codex run',
        status: 'done',
        detail: [mode, this.options.model].filter(Boolean).join(' / '),
      },
    });

    if (mode === 'dry-run') return this.dryRun(request);

    const cwd = await resolveProjectWorkingDirectory(
      this.options.workspaceRoot,
      request,
    );
    const manualCompact =
      this.appServerEnabled(request) && isManualCodexCompact(request);
    const toolSession =
      request.purpose !== undefined && request.purpose !== 'agent'
        ? undefined
        : manualCompact
          ? undefined
          : await this.options.toolSessions?.open(request);
    const sandbox = 'read-only';
    const providerSession =
      (request.purpose === undefined || request.purpose === 'agent') &&
      this.options.sessionMode !== 'transcript' &&
      request.providerSession?.providerId === this.id
        ? request.providerSession
        : undefined;
    const resumeSessionId = providerSession?.sessionId;
    if (this.appServerEnabled(request)) {
      if (manualCompact && !resumeSessionId) {
        await request.onEvent?.({
          type: 'progress',
          item: {
            id: 'codex-context-compaction',
            label: 'Compact conversation context',
            status: 'done',
            detail: 'No active Codex thread for this route',
          },
        });
        return {
          summary:
            'This route has no active Codex conversation context yet. Send a normal message first, then use /compact.',
          artifacts: [],
        };
      }
      try {
        return await this.runAppServer(
          request,
          cwd,
          toolSession,
          providerSession,
        );
      } catch (error) {
        if (resumeSessionId && isMissingCliSession(error)) {
          return this.recoverProviderSession(
            request,
            providerSession!,
            'missing',
          );
        }
        if (resumeSessionId && isCliContextOverflow(error)) {
          return this.recoverProviderSession(
            request,
            providerSession!,
            'context_overflow',
          );
        }
        throw error;
      } finally {
        await toolSession?.close();
      }
    }
    const args = [
      ...(this.options.commandPrefixArgs ?? []),
      'exec',
      '--ignore-user-config',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '--sandbox',
      sandbox,
      '--cd',
      cwd,
    ];
    if (!providerSession) args.push('--ephemeral');
    if (toolSession) args.push(...codexMcpConfigArgs(toolSession));
    if (this.options.model) args.push('--model', this.options.model);
    if (resumeSessionId) args.push('resume', resumeSessionId, '-');
    else args.push('-');

    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-cli',
        label: 'Run Codex CLI',
        status: 'running',
        detail: `${resumeSessionId ? 'resume session' : 'new turn'} / ${sandbox} / ${toolSession?.tools.length ?? 0} brokered tools / ${cwd}`,
      },
    });

    let finalMessage = '';
    let providerError = '';
    let unstructuredLogCount = 0;
    let stderrLogCount = 0;
    let recordedProviderSession = false;
    let usage: AgentRunResult['usage'];
    const runningItems = new Map<string, string>();
    const nativeToolStartedAt = new Map<string, number>();
    const recoverProviderSession = async (
      reason: 'missing' | 'context_overflow',
    ): Promise<AgentRunResult> =>
      this.recoverProviderSession(request, providerSession!, reason);
    const onStdoutLine = async (line: string): Promise<void> => {
      let event: JsonRecord;
      try {
        event = JSON.parse(line) as JsonRecord;
      } catch {
        unstructuredLogCount += 1;
        if (unstructuredLogCount <= 20) {
          await request.onEvent?.({
            type: 'log',
            level: 'debug',
            message: line.slice(0, 500),
          });
        } else if (unstructuredLogCount === 21) {
          await request.onEvent?.({
            type: 'log',
            level: 'warn',
            message: 'Additional unstructured Codex output omitted.',
          });
        }
        return;
      }
      const eventType = text(event.type) || '';
      const item = record(event.item);
      if (eventType === 'thread.started') {
        const sessionId = text(event.thread_id);
        if (sessionId && providerSession) {
          await providerSession.record(sessionId);
          recordedProviderSession = true;
        }
        await request.onEvent?.({
          type: 'log',
          level: 'info',
          message: `Codex thread ${sessionId || 'started'}`,
        });
        return;
      }
      if (item && (eventType === 'item.started' || eventType === 'item.completed')) {
        const type = text(item.type) || '';
        const message = agentMessage(item);
        if (message) {
          finalMessage = message;
          return;
        }
        if (type === 'error') {
          await request.onEvent?.({
            type: 'log',
            level: 'warn',
            message:
              text(item.message) ||
              text(item.error) ||
              'Codex reported a recoverable item error.',
          });
          return;
        }
        const id = text(item.id) || `item-${runningItems.size + 1}`;
        const label = runningItems.get(id) || itemLabel(item);
        runningItems.set(id, label);
        const nativeCall = nativeToolCall(item, id);
        if (nativeCall && eventType === 'item.started') {
          nativeToolStartedAt.set(id, Date.now());
          await request.onEvent?.({ type: 'tool_call', call: nativeCall });
        }
        if (nativeCall && eventType === 'item.completed') {
          if (!nativeToolStartedAt.has(id)) {
            await request.onEvent?.({ type: 'tool_call', call: nativeCall });
          }
          const failed = nativeToolFailed(item);
          await request.onEvent?.({
            type: 'tool_result',
            call: {
              ...nativeCall,
              status: failed ? 'failed' : 'succeeded',
              durationMs: Math.max(
                0,
                Date.now() - (nativeToolStartedAt.get(id) ?? Date.now()),
              ),
              ...(failed ? { error: 'Provider reported native tool failure.' } : {}),
            },
          });
          nativeToolStartedAt.delete(id);
        }
        await request.onEvent?.({
          type: 'progress',
          item: {
            id: `codex-${id}`,
            label,
            status: eventType === 'item.completed' ? 'done' : 'running',
          },
        });
        return;
      }
      if (eventType === 'turn.failed' || eventType === 'error') {
        providerError =
          text(record(event.error)?.message) ||
          text(event.message) ||
          'codex_turn_failed';
        await request.onEvent?.({
          type: 'log',
          level: 'error',
          message: providerError,
        });
        return;
      }
      if (eventType === 'turn.completed') {
        const providerUsage = record(event.usage);
        usage = {
          runs: 1,
          inputTokens: nonNegativeNumber(providerUsage?.input_tokens),
          outputTokens: nonNegativeNumber(providerUsage?.output_tokens),
        };
        await request.onEvent?.({
          type: 'log',
          level: 'info',
          message: `Codex turn completed${event.usage ? ' with usage data' : ''}`,
        });
      }
    };

    try {
      await runCliCommand({
        command: this.options.command || 'codex',
        args,
        cwd,
        input: [
          buildAgentPrompt(request),
        artifactInstructions(
          (request.purpose === undefined || request.purpose === 'agent') &&
            !request.delegation &&
            Boolean(this.options.artifactRoot),
          ),
          memoryCandidateInstructions(request),
        ]
          .filter(Boolean)
          .join('\n\n'),
        env: {
          ...createCliEnvironment({
            provider: 'codex',
            request,
            inheritEnv: this.options.inheritEnv,
          }),
          ...this.options.environment,
        },
        timeoutMs: this.options.timeoutMs ?? 20 * 60_000,
        maxOutputBytes: this.options.maxOutputBytes,
        abortSignal: request.abortSignal,
        onStdoutLine,
        onStderrLine: async (line) => {
          stderrLogCount += 1;
          if (stderrLogCount <= 50) {
            await request.onEvent?.({
              type: 'log',
              level: 'warn',
              message: line.slice(0, 500),
            });
          } else if (stderrLogCount === 51) {
            await request.onEvent?.({
              type: 'log',
              level: 'warn',
              message: 'Additional Codex stderr output omitted.',
            });
          }
        },
      });
    } catch (error) {
      if (resumeSessionId && isMissingCliSession(error)) {
        return recoverProviderSession('missing');
      }
      if (
        resumeSessionId &&
        isCliContextOverflow(providerError || error)
      ) {
        return recoverProviderSession('context_overflow');
      }
      if (providerError) throw new Error(providerError, { cause: error });
      throw error;
    } finally {
      await toolSession?.close();
    }

    if (resumeSessionId && providerSession && !recordedProviderSession) {
      await providerSession.record(resumeSessionId);
    }

    if (providerError) {
      if (resumeSessionId && isCliContextOverflow(providerError)) {
        return recoverProviderSession('context_overflow');
      }
      throw new Error(providerError);
    }
    if (!finalMessage.trim() && !allowsEmptyFinalResponse(request)) {
      throw new Error('codex_no_final_response');
    }
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-cli',
        label: 'Run Codex CLI',
        status: 'done',
        detail: runningItems.size ? `${runningItems.size} item(s)` : 'completed',
      },
    });
    const collected = await collectCliArtifacts({
      finalMessage,
      cwd,
      artifactRoot: this.options.artifactRoot,
      runId: request.runId,
      maxArtifactBytes: this.options.maxArtifactBytes,
      maxArtifacts: this.options.maxArtifacts,
      hostedReport:
        this.options.hostedReportBaseUrl && request.workspace?.id && request.project
          ? {
              baseUrl: this.options.hostedReportBaseUrl,
              workspaceId: request.workspace.id,
              projectId: request.project.key || request.project.id,
            }
          : undefined,
    });
    for (const warning of collected.warnings) {
      await request.onEvent?.({ type: 'log', level: 'warn', message: warning });
    }
    for (const artifact of collected.artifacts) {
      await request.onEvent?.({ type: 'artifact', artifact });
    }
    return {
      summary: collected.summary,
      artifacts: collected.artifacts,
      memoryCandidates: collected.memoryCandidates,
      memoryDecisions: collected.memoryDecisions,
      memorySelections: collected.memorySelections,
      knowledgePassages: collected.knowledgePassages,
      usage,
    };
  }

  private appServerEnabled(request?: AgentRunRequest): boolean {
    if (
      request?.purpose !== undefined &&
      request.purpose !== 'agent'
    ) {
      return false;
    }
    if (this.options.appServer !== undefined) return this.options.appServer;
    if (this.options.commandPrefixArgs?.length) return false;
    if (
      this.options.command &&
      !['codex', 'codex.exe'].includes(path.basename(this.options.command))
    ) {
      return false;
    }
    return request?.purpose === undefined || request?.purpose === 'agent';
  }

  private async recoverProviderSession(
    request: AgentRunRequest,
    providerSession: ProviderSessionContext,
    reason: 'missing' | 'context_overflow',
  ): Promise<AgentRunResult> {
    const contextOverflow = reason === 'context_overflow';
    await providerSession.invalidate(
      contextOverflow
        ? 'Codex provider session reached its context limit; rebuilding this thread from the bounded durable transcript.'
        : 'Codex provider session is unavailable; rebuilding from durable transcript.',
    );
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-session-recovery',
        label: 'Rebuild conversation context',
        status: 'done',
        detail: contextOverflow
          ? 'Context limit reached; current thread session reset'
          : 'Provider session unavailable; current thread session reset',
      },
    });
    await request.onEvent?.({
      type: 'log',
      level: 'warn',
      message: contextOverflow
        ? 'Codex context limit reached; retrying once with bounded durable shared-thread context.'
        : 'Codex session unavailable; retrying once with durable shared-thread context.',
    });
    return this.run({
      ...request,
      providerSession: { ...providerSession, sessionId: undefined },
    });
  }

  private async runAppServer(
    request: AgentRunRequest,
    cwd: string,
    toolSession: CliToolSession | undefined,
    providerSession: ProviderSessionContext | undefined,
  ): Promise<AgentRunResult> {
    const sourceEnvironment = {
      ...createCliEnvironment({
        provider: 'codex',
        request,
        inheritEnv: this.options.inheritEnv,
      }),
      ...this.options.environment,
    };
    const codexHome = await prepareCodexAppServerHome({
      target:
        this.options.codexHome ||
        path.join(
          this.options.artifactRoot
            ? path.dirname(this.options.artifactRoot)
            : path.dirname(cwd),
          'providers',
          'codex',
        ),
      source: this.options.codexAuthSourceHome,
      env: sourceEnvironment,
    });
    const environment = { ...sourceEnvironment, CODEX_HOME: codexHome };
    const resumeSessionId = providerSession?.sessionId;
    const session = new CodexAppServerSession({
      command: this.options.command || 'codex',
      commandPrefixArgs: this.options.commandPrefixArgs,
      cwd,
      env: environment,
      model: this.options.model,
      resumeThreadId: resumeSessionId,
      ephemeral: !providerSession,
      toolSession,
      disableNativeShell: this.options.disableNativeShell,
      requestTimeoutMs: Math.min(this.options.timeoutMs ?? 30_000, 30_000),
      onStderrLine: async (line) => {
        await request.onEvent?.({
          type: 'log',
          level: 'warn',
          message: line.slice(0, 500),
        });
      },
      onUnstructuredLine: async (line) => {
        await request.onEvent?.({
          type: 'log',
          level: 'debug',
          message: line.slice(0, 500),
        });
      },
    });

    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-cli',
        label: 'Run Codex app server',
        status: 'running',
        detail: `${resumeSessionId ? 'resume session' : 'new turn'} / read-only / ${toolSession?.tools.length ?? 0} brokered tools / ${cwd}`,
      },
    });

    let finalMessage = '';
    let providerError = '';
    let usage: AgentRunResult['usage'];
    let contextUsage: CodexAppServerUsage | undefined;
    let turnCompleted = false;
    let contextCompactionCompleted = false;
    let steeringError: unknown;
    let deltaBuffer = '';
    const runningItems = new Map<string, string>();
    const nativeToolStartedAt = new Map<string, number>();
    const steeringAbort = new AbortController();
    const turnAbort = new AbortController();
    const timeoutController = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 20 * 60_000;
    const timeout = setTimeout(
      () => timeoutController.abort(`executor_timed_out_after_${timeoutMs}ms`),
      timeoutMs,
    );
    timeout.unref?.();
    const forwardAbort = (): void =>
      timeoutController.abort(request.abortSignal?.reason || 'executor_aborted');
    request.abortSignal?.addEventListener('abort', forwardAbort, { once: true });
    let interruptTask: Promise<void> = Promise.resolve();
    const onExecutionAbort = (): void => {
      steeringAbort.abort(timeoutController.signal.reason);
      interruptTask = session.interrupt();
    };
    timeoutController.signal.addEventListener('abort', onExecutionAbort, {
      once: true,
    });

    const flushDelta = async (force = false): Promise<void> => {
      if (!deltaBuffer || (!force && deltaBuffer.length < 300)) return;
      const value = deltaBuffer;
      deltaBuffer = '';
      await request.onEvent?.({ type: 'text_delta', text: value });
    };
    const reportContextCompaction = async (
      status: 'running' | 'done' | 'failed',
      detail: string,
    ): Promise<void> => {
      if (status === 'done' && contextCompactionCompleted) return;
      if (status === 'done') contextCompactionCompleted = true;
      await request.onEvent?.({
        type: 'progress',
        item: {
          id: 'codex-context-compaction',
          label: 'Compact conversation context',
          status,
          detail,
        },
      });
    };
    const pumpSteering = async (): Promise<void> => {
      if (!request.steering || request.steering.mode !== 'live') return;
      while (!steeringAbort.signal.aborted) {
        const followUp = await request.steering.receive({
          waitMs: 250,
          signal: steeringAbort.signal,
        });
        if (!followUp) continue;
        await request.onEvent?.({
          type: 'progress',
          item: {
            id: `codex-steering-${followUp.id}`,
            label: 'Apply live follow-up',
            status: 'running',
            detail:
              followUp.message.actor.displayName || followUp.message.actor.id,
          },
        });
        let applied = false;
        try {
          applied = await session.steer(
            buildLiveSteeringPrompt(followUp),
            followUp.message.id,
          );
        } catch (error) {
          if (
            turnCompleted ||
            steeringAbort.signal.aborted ||
            error instanceof CodexAppServerRpcError
          ) {
            await request.onEvent?.({
              type: 'log',
              level: 'info',
              message:
                'Codex could not accept the live follow-up; the durable mailbox will continue it in the next turn.',
            });
            return;
          }
          throw error;
        }
        if (!applied || turnCompleted || steeringAbort.signal.aborted) {
          await request.onEvent?.({
            type: 'log',
            level: 'info',
            message:
              'Codex completed while forwarding a follow-up; the durable mailbox will continue it in the next turn.',
          });
          return;
        }
        await request.steering.acknowledge(
          followUp.id,
          'Forwarded to the active Codex turn',
        );
        await request.onEvent?.({
          type: 'progress',
          item: {
            id: `codex-steering-${followUp.id}`,
            label: 'Apply live follow-up',
            status: 'done',
            detail: 'Applied to active turn',
          },
        });
      }
    };

    try {
      const threadId = await session.startOrResume();
      if (providerSession) await providerSession.record(threadId);
      await request.onEvent?.({
        type: 'log',
        level: 'info',
        message: `Codex thread ${threadId}`,
      });

      if (isManualCodexCompact(request)) {
        await reportContextCompaction('running', 'Same provider thread');
        const compacted = await session.compact({
          signal: timeoutController.signal,
        });
        await reportContextCompaction(
          'done',
          `${compacted.source} confirmation / ${compacted.turnId || 'provider turn'}`,
        );
        await request.onEvent?.({
          type: 'log',
          level: 'info',
          message: `Codex thread ${threadId} compacted in place.`,
        });
        finalMessage =
          'Codex conversation context for this route was compacted in place. The provider thread and MaxTag scoped memory are unchanged.';
        turnCompleted = true;
      } else {
        let turnPrompt = [
          buildAgentPrompt(request),
          artifactInstructions(
            (request.purpose === undefined || request.purpose === 'agent') &&
              Boolean(this.options.artifactRoot),
          ),
          memoryCandidateInstructions(request),
        ]
          .filter(Boolean)
          .join('\n\n');
        let localImages = request.message.attachments
          ?.filter(
            (attachment) =>
              attachment.kind === 'image' && Boolean(attachment.localPath),
          )
          .map((attachment) => attachment.localPath!);
        let overflowRecoveryAttempted = false;

        while (true) {
          let steeringTask: Promise<void> = Promise.resolve();
          turnCompleted = false;
          try {
            for await (const event of session.runTurn(turnPrompt, {
              localImages,
              onStarted() {
                if (overflowRecoveryAttempted) return;
                steeringTask = pumpSteering().catch((error) => {
                  steeringError = error;
                  steeringAbort.abort(error);
                  turnAbort.abort(error);
                  void session.interrupt();
                });
              },
              signal: AbortSignal.any([
                timeoutController.signal,
                turnAbort.signal,
              ]),
            })) {
            if (event.type === 'text.delta') {
              deltaBuffer += event.text;
              await flushDelta();
              continue;
            }
            if (event.type === 'usage') {
              contextUsage = event.usage;
              usage = {
                runs: 1,
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
              };
              continue;
            }
            if (event.type === 'error') {
              if (!event.willRetry) providerError = event.message;
              await request.onEvent?.({
                type: 'log',
                level: event.willRetry ? 'warn' : 'error',
                message: event.message,
              });
              continue;
            }
            if (event.type === 'turn.completed') {
              turnCompleted = true;
              steeringAbort.abort();
              if (event.status === 'failed') {
                providerError = event.error || providerError || 'codex_turn_failed';
              }
              continue;
            }
            if (event.type === 'compact.completed') {
              await reportContextCompaction(
                'done',
                `Automatic provider compaction / ${event.source} confirmation`,
              );
              continue;
            }

            const item = event.item;
            if (item.type === 'context_compaction') {
              await reportContextCompaction(
                event.type === 'item.completed' ? 'done' : 'running',
                'Automatic provider compaction',
              );
              continue;
            }
            const message = agentMessage(item);
            if (message) {
              finalMessage = message;
              continue;
            }
            const id = text(item.id) || `item-${runningItems.size + 1}`;
            const label = runningItems.get(id) || itemLabel(item);
            runningItems.set(id, label);
            const nativeCall = nativeToolCall(item, id);
            if (nativeCall && event.type === 'item.started') {
              nativeToolStartedAt.set(id, Date.now());
              await request.onEvent?.({ type: 'tool_call', call: nativeCall });
            }
            if (nativeCall && event.type === 'item.completed') {
              if (!nativeToolStartedAt.has(id)) {
                await request.onEvent?.({ type: 'tool_call', call: nativeCall });
              }
              const failed = nativeToolFailed(item);
              await request.onEvent?.({
                type: 'tool_result',
                call: {
                  ...nativeCall,
                  status: failed ? 'failed' : 'succeeded',
                  durationMs: Math.max(
                    0,
                    Date.now() - (nativeToolStartedAt.get(id) ?? Date.now()),
                  ),
                  ...(failed
                    ? { error: 'Provider reported native tool failure.' }
                    : {}),
                },
              });
              nativeToolStartedAt.delete(id);
            }
            await request.onEvent?.({
              type: 'progress',
              item: {
                id: `codex-${id}`,
                label,
                status: event.type === 'item.completed' ? 'done' : 'running',
              },
            });
            }
          } finally {
            turnCompleted = true;
            steeringAbort.abort();
            await steeringTask;
          }

          if (
            overflowRecoveryAttempted ||
            !providerSession ||
            finalMessage.trim() ||
            !isCliContextOverflow(providerError)
          ) {
            break;
          }

          await reportContextCompaction(
            'running',
            'Recovering context overflow in the same provider thread',
          );
          try {
            const compacted = await session.compact({
              signal: timeoutController.signal,
            });
            await reportContextCompaction(
              'done',
              `Overflow recovery / ${compacted.source} confirmation / ${compacted.turnId || 'provider turn'}`,
            );
            await request.onEvent?.({
              type: 'log',
              level: 'warn',
              message:
                'Codex context limit reached; compacted the same provider thread and continuing once without replaying the original user message.',
            });
            overflowRecoveryAttempted = true;
            providerError = '';
            contextUsage = undefined;
            turnPrompt = CODEX_OVERFLOW_CONTINUATION;
            localImages = undefined;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await reportContextCompaction('failed', message);
            await request.onEvent?.({
              type: 'log',
              level: 'warn',
              message: `Codex same-thread context recovery failed; durable transcript recovery remains available: ${message}`,
            });
            break;
          }
        }

        const threshold = this.contextCompactionThreshold();
        const ratio = contextCompactionRatio(contextUsage);
        if (
          providerSession &&
          !contextCompactionCompleted &&
          threshold !== undefined &&
          ratio !== undefined &&
          ratio >= threshold &&
          finalMessage.trim() &&
          !providerError
        ) {
          await reportContextCompaction(
            'running',
            `Proactive compaction at ${Math.round(ratio * 100)}% context usage`,
          );
          try {
            const compacted = await session.compact({
              signal: timeoutController.signal,
            });
            await reportContextCompaction(
              'done',
              `Proactive ${compacted.source} confirmation / ${compacted.turnId || 'provider turn'}`,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await reportContextCompaction('failed', message);
            await request.onEvent?.({
              type: 'log',
              level: 'warn',
              message: `Codex proactive context compaction failed after the completed turn: ${message}`,
            });
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      timeoutController.signal.removeEventListener('abort', onExecutionAbort);
      request.abortSignal?.removeEventListener('abort', forwardAbort);
      steeringAbort.abort();
      if (timeoutController.signal.aborted) await interruptTask;
      await session.close();
    }

    await flushDelta(true);
    if (timeoutController.signal.aborted) {
      throw new Error(
        typeof timeoutController.signal.reason === 'string'
          ? timeoutController.signal.reason
          : 'executor_aborted',
      );
    }
    if (steeringError) throw steeringError;
    if (providerError) throw new Error(providerError);
    if (!finalMessage.trim() && !allowsEmptyFinalResponse(request)) {
      throw new Error('codex_no_final_response');
    }
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-cli',
        label: 'Run Codex app server',
        status: 'done',
        detail: runningItems.size ? `${runningItems.size} item(s)` : 'completed',
      },
    });
    const collected = await collectCliArtifacts({
      finalMessage,
      cwd,
      artifactRoot: this.options.artifactRoot,
      runId: request.runId,
      maxArtifactBytes: this.options.maxArtifactBytes,
      maxArtifacts: this.options.maxArtifacts,
      hostedReport:
        this.options.hostedReportBaseUrl && request.workspace?.id && request.project
          ? {
              baseUrl: this.options.hostedReportBaseUrl,
              workspaceId: request.workspace.id,
              projectId: request.project.key || request.project.id,
            }
          : undefined,
    });
    for (const warning of collected.warnings) {
      await request.onEvent?.({ type: 'log', level: 'warn', message: warning });
    }
    for (const artifact of collected.artifacts) {
      await request.onEvent?.({ type: 'artifact', artifact });
    }
    return {
      summary: collected.summary,
      artifacts: collected.artifacts,
      memoryCandidates: collected.memoryCandidates,
      memoryDecisions: collected.memoryDecisions,
      memorySelections: collected.memorySelections,
      knowledgePassages: collected.knowledgePassages,
      usage,
    };
  }

  private contextCompactionThreshold(): number | undefined {
    const value = this.options.contextCompactionThreshold ?? 0.85;
    if (!Number.isFinite(value) || value <= 0 || value > 1) return undefined;
    return value;
  }

  private async dryRun(request: AgentRunRequest): Promise<AgentRunResult> {
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-dry-run',
        label: 'Dry-run response',
        status: 'done',
      },
    });

    const scopeCount = request.memorySnapshot?.scopes.length ?? 0;
    const route = [request.workspace?.name, request.project?.name]
      .filter(Boolean)
      .join(' / ');
    return {
      summary: [
        `Dry-run Codex executor received: ${request.message.text || '(empty message)'}`,
        `Agent: ${request.identity.displayName}`,
        route ? `Route: ${route}` : '',
        `Memory scopes loaded: ${scopeCount}`,
        `Tool grants: ${request.access.grants.map((grant) => grant.kind).join(', ') || 'none'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      artifacts: [],
    };
  }
}

export function createCodexExecutor(options?: CodexExecutorOptions): Executor {
  return new CodexExecutor(options);
}
