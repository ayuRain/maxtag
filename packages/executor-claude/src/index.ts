import type {
  AgentRunRequest,
  AgentRunResult,
  AgentSteeringInput,
  Executor,
} from '@opentag/core';
import {
  artifactInstructions,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  collectCliArtifacts,
  createCliEnvironment,
  isMissingCliSession,
  resolveProjectWorkingDirectory,
  runCliCommand,
  type CliExecutorOptions,
  type CliStdinWriter,
} from '@opentag/executor-cli';

export interface ClaudeExecutorOptions extends CliExecutorOptions {
  maxBudgetUsd?: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function claudeTools(request: AgentRunRequest): {
  available: string[];
  allowed: string[];
} {
  const kinds = new Set(request.access.grants.map((grant) => grant.kind));
  const available = new Set(['Read', 'Glob', 'Grep']);
  const allowed = new Set(['Read', 'Glob', 'Grep']);
  if (kinds.has('shell')) {
    for (const tool of ['Bash', 'Edit', 'Write']) {
      available.add(tool);
      allowed.add(tool);
    }
  } else if (kinds.has('github')) {
    available.add('Bash');
    allowed.add('Bash(git *)');
    allowed.add('Bash(gh *)');
  }
  if (
    kinds.has('browser') &&
    request.access.networkPolicy.mode === 'allow-all'
  ) {
    for (const tool of ['WebFetch', 'WebSearch']) {
      available.add(tool);
      allowed.add(tool);
    }
  }
  return { available: [...available], allowed: [...allowed] };
}

function assistantText(event: JsonRecord): string | undefined {
  const message = record(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = content
    .map((part) => record(part))
    .filter((part) => part?.type === 'text')
    .map((part) => text(part?.text))
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('\n') : undefined;
}

function streamJsonUserMessage(value: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: value }],
    },
  });
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

export class ClaudeExecutor implements Executor {
  readonly id = 'claude';
  readonly label = 'Claude';
  private readonly options: ClaudeExecutorOptions;

  get steeringMode(): 'live' | 'next_turn' {
    return (this.options.mode ?? 'dry-run') === 'local-cli'
      ? 'live'
      : 'next_turn';
  }

  constructor(options?: ClaudeExecutorOptions) {
    this.options = options ?? {};
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const mode = this.options.mode ?? 'dry-run';
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'claude-plan',
        label: 'Prepare Claude run',
        status: 'done',
        detail: [mode, this.options.model].filter(Boolean).join(' / '),
      },
    });

    if (mode === 'dry-run') return this.dryRun(request);

    const cwd = await resolveProjectWorkingDirectory(
      this.options.workspaceRoot,
      request,
    );
    const tools = claudeTools(request);
    const providerSession =
      this.options.sessionMode !== 'transcript' &&
      request.providerSession?.providerId === this.id
        ? request.providerSession
        : undefined;
    const resumeSessionId = providerSession?.sessionId;
    const args = [
      ...(this.options.commandPrefixArgs ?? []),
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-mode',
      'dontAsk',
      '--tools',
      tools.available.join(','),
      '--allowedTools',
      tools.allowed.join(','),
      '--append-system-prompt',
      [
        buildAgentSystemPrompt(request),
        artifactInstructions(Boolean(this.options.artifactRoot)),
      ]
        .filter(Boolean)
        .join('\n\n'),
    ];
    if (!providerSession) args.push('--no-session-persistence');
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(this.options.maxBudgetUsd));
    }

    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'claude-cli',
        label: 'Run Claude CLI',
        status: 'running',
        detail: `${resumeSessionId ? 'resume session' : 'new turn'} / ${tools.allowed.length} allowed tool rule(s) / ${cwd}`,
      },
    });

    let finalMessage = '';
    let providerError = '';
    let deltaBuffer = '';
    let unstructuredLogCount = 0;
    let stderrLogCount = 0;
    let recordedProviderSession = false;
    let resultSeen = false;
    let stdinWriter: CliStdinWriter | undefined;
    const steeringAbort = new AbortController();
    const abortSteering = (): void => steeringAbort.abort();
    request.abortSignal?.addEventListener('abort', abortSteering, { once: true });
    const runningTools = new Map<number, { id: string; label: string }>();
    const flushDelta = async (force = false): Promise<void> => {
      if (!deltaBuffer || (!force && deltaBuffer.length < 300)) return;
      const value = deltaBuffer;
      deltaBuffer = '';
      await request.onEvent?.({ type: 'text_delta', text: value });
    };
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
            message: 'Additional unstructured Claude output omitted.',
          });
        }
        return;
      }
      const eventType = text(event.type) || '';
      if (eventType === 'system' && event.subtype === 'init') {
        const sessionId = text(event.session_id);
        if (sessionId && providerSession) {
          await providerSession.record(sessionId);
          recordedProviderSession = true;
        }
        await request.onEvent?.({
          type: 'log',
          level: 'info',
          message: `Claude session ${sessionId || 'started'}`,
        });
        return;
      }
      if (eventType === 'assistant') {
        const value = assistantText(event);
        if (value) finalMessage = value;
        return;
      }
      if (eventType === 'stream_event') {
        const stream = record(event.event);
        const streamType = text(stream?.type);
        const index =
          typeof stream?.index === 'number' ? stream.index : runningTools.size;
        if (streamType === 'content_block_start') {
          const block = record(stream?.content_block);
          if (block?.type === 'tool_use') {
            const id = text(block.id) || `tool-${index}`;
            const label = `Tool: ${text(block.name) || 'Claude tool'}`;
            runningTools.set(index, { id, label });
            await request.onEvent?.({
              type: 'progress',
              item: { id: `claude-${id}`, label, status: 'running' },
            });
          }
          return;
        }
        if (streamType === 'content_block_delta') {
          const delta = record(stream?.delta);
          if (delta?.type === 'text_delta' && text(delta.text)) {
            deltaBuffer += String(delta.text);
            await flushDelta();
          }
          return;
        }
        if (streamType === 'content_block_stop') {
          const tool = runningTools.get(index);
          if (tool) {
            await request.onEvent?.({
              type: 'progress',
              item: {
                id: `claude-${tool.id}`,
                label: tool.label,
                status: 'done',
              },
            });
          }
          return;
        }
      }
      if (eventType === 'result') {
        resultSeen = true;
        steeringAbort.abort();
        stdinWriter?.end();
        await flushDelta(true);
        const value = text(event.result);
        if (value) finalMessage = value;
        if (event.is_error === true || event.subtype === 'error') {
          providerError = value || text(event.error) || 'claude_turn_failed';
        }
        const cost =
          typeof event.total_cost_usd === 'number'
            ? ` cost=$${event.total_cost_usd.toFixed(4)}`
            : '';
        await request.onEvent?.({
          type: 'log',
          level: providerError ? 'error' : 'info',
          message: providerError || `Claude turn completed${cost}`,
        });
      }
    };

    const pumpSteering = async (writer: CliStdinWriter): Promise<void> => {
      if (!request.steering || request.steering.mode !== 'live') return;
      while (!steeringAbort.signal.aborted && !writer.signal.aborted) {
        const followUp = await request.steering.receive({
          waitMs: 250,
          signal: steeringAbort.signal,
        });
        if (!followUp) continue;
        await request.onEvent?.({
          type: 'progress',
          item: {
            id: `claude-steering-${followUp.id}`,
            label: 'Apply live follow-up',
            status: 'running',
            detail: followUp.message.actor.displayName || followUp.message.actor.id,
          },
        });
        try {
          await writer.writeLine(
            streamJsonUserMessage(buildLiveSteeringPrompt(followUp)),
          );
        } catch (error) {
          if (
            resultSeen ||
            steeringAbort.signal.aborted ||
            writer.signal.aborted
          ) {
            await request.onEvent?.({
              type: 'log',
              level: 'info',
              message:
                'Claude stream closed before the follow-up was applied; the durable mailbox will continue it in the next turn.',
            });
            return;
          }
          throw error;
        }
        if (resultSeen || steeringAbort.signal.aborted || writer.signal.aborted) {
          await request.onEvent?.({
            type: 'log',
            level: 'info',
            message:
              'Claude completed while forwarding a follow-up; the durable mailbox will continue it in the next turn.',
          });
          return;
        }
        await request.steering.acknowledge(
          followUp.id,
          'Forwarded to the active Claude stream',
        );
        await request.onEvent?.({
          type: 'progress',
          item: {
            id: `claude-steering-${followUp.id}`,
            label: 'Apply live follow-up',
            status: 'done',
            detail: 'Applied to active session',
          },
        });
      }
    };

    try {
      await runCliCommand({
        command: this.options.command || 'claude',
        args,
        cwd,
        input: `${streamJsonUserMessage(buildAgentUserPrompt(request))}\n`,
        stdinMode: 'stream',
        async onStdinReady(writer) {
          stdinWriter = writer;
          writer.signal.addEventListener('abort', abortSteering, { once: true });
          if (resultSeen) {
            writer.end();
            return;
          }
          await pumpSteering(writer);
        },
        env: createCliEnvironment({
          provider: 'claude',
          request,
          inheritEnv: this.options.inheritEnv,
        }),
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
              message: 'Additional Claude stderr output omitted.',
            });
          }
        },
      });
    } catch (error) {
      if (resumeSessionId && isMissingCliSession(error)) {
        await providerSession.invalidate('Claude provider session is unavailable; rebuilding from durable transcript.');
        await request.onEvent?.({
          type: 'log',
          level: 'warn',
          message: 'Claude session unavailable; retrying once with durable shared-thread context.',
        });
        return this.run({
          ...request,
          providerSession: { ...providerSession, sessionId: undefined },
        });
      }
      if (providerError) throw new Error(providerError, { cause: error });
      throw error;
    } finally {
      steeringAbort.abort();
      stdinWriter?.end();
      request.abortSignal?.removeEventListener('abort', abortSteering);
    }
    if (resumeSessionId && providerSession && !recordedProviderSession) {
      await providerSession.record(resumeSessionId);
    }
    await flushDelta(true);

    if (providerError) throw new Error(providerError);
    if (!finalMessage.trim()) throw new Error('claude_no_final_response');
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'claude-cli',
        label: 'Run Claude CLI',
        status: 'done',
        detail: `${runningTools.size} tool call(s)`,
      },
    });
    const collected = await collectCliArtifacts({
      finalMessage,
      cwd,
      artifactRoot: this.options.artifactRoot,
      runId: request.runId,
      maxArtifactBytes: this.options.maxArtifactBytes,
      maxArtifacts: this.options.maxArtifacts,
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
    };
  }

  private async dryRun(request: AgentRunRequest): Promise<AgentRunResult> {
    const route = [request.workspace?.name, request.project?.name]
      .filter(Boolean)
      .join(' / ');
    return {
      summary: [
        `Dry-run Claude executor received: ${request.message.text || '(empty message)'}`,
        `Agent: ${request.identity.displayName}`,
        route ? `Route: ${route}` : '',
        `Tool grants: ${request.access.grants.map((grant) => grant.kind).join(', ') || 'none'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      artifacts: [],
    };
  }
}

export function createClaudeExecutor(options?: ClaudeExecutorOptions): Executor {
  return new ClaudeExecutor(options);
}
