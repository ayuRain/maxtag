import type { AgentRunRequest, AgentRunResult, Executor } from '@opentag/core';
import {
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  createCliEnvironment,
  finalResponse,
  resolveProjectWorkingDirectory,
  runCliCommand,
  type CliExecutorOptions,
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

export class ClaudeExecutor implements Executor {
  readonly id = 'claude';
  readonly label = 'Claude';
  readonly steeringMode = 'next_turn' as const;
  private readonly options: ClaudeExecutorOptions;

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
    const args = [
      ...(this.options.commandPrefixArgs ?? []),
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
      '--tools',
      tools.available.join(','),
      '--allowedTools',
      tools.allowed.join(','),
      '--append-system-prompt',
      buildAgentSystemPrompt(request),
    ];
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
        detail: `${tools.allowed.length} allowed tool rule(s) / ${cwd}`,
      },
    });

    let finalMessage = '';
    let providerError = '';
    let deltaBuffer = '';
    let unstructuredLogCount = 0;
    let stderrLogCount = 0;
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
        await request.onEvent?.({
          type: 'log',
          level: 'info',
          message: `Claude session ${text(event.session_id) || 'started'}`,
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

    try {
      await runCliCommand({
        command: this.options.command || 'claude',
        args,
        cwd,
        input: buildAgentUserPrompt(request),
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
      if (providerError) throw new Error(providerError, { cause: error });
      throw error;
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
    return {
      summary: finalResponse(finalMessage),
      artifacts: [],
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
