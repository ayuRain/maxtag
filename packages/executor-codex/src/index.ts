import type { AgentRunRequest, AgentRunResult, Executor } from '@opentag/core';
import {
  buildAgentPrompt,
  createCliEnvironment,
  finalResponse,
  resolveProjectWorkingDirectory,
  runCliCommand,
  type CliExecutorOptions,
} from '@opentag/executor-cli';

export interface CodexExecutorOptions extends CliExecutorOptions {}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function itemLabel(item: JsonRecord): string {
  const type = text(item.type) || 'work';
  if (type === 'command_execution') {
    return `Command: ${(text(item.command) || 'shell command').slice(0, 100)}`;
  }
  if (type === 'mcp_tool_call') {
    return `Tool: ${text(item.tool) || text(item.name) || 'MCP call'}`;
  }
  if (type === 'file_change') return 'Apply file changes';
  if (type === 'web_search') return 'Search the web';
  if (type === 'reasoning') return 'Reason through the task';
  return type.replaceAll('_', ' ');
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

function hasWriteGrant(request: AgentRunRequest): boolean {
  return request.access.grants.some(
    (grant) => grant.kind === 'shell' || grant.kind === 'github',
  );
}

export class CodexExecutor implements Executor {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly steeringMode = 'next_turn' as const;
  private readonly options: CodexExecutorOptions;

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
    const sandbox = hasWriteGrant(request) ? 'workspace-write' : 'read-only';
    const args = [
      ...(this.options.commandPrefixArgs ?? []),
      'exec',
      '--json',
      '--color',
      'never',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      sandbox,
      '--cd',
      cwd,
    ];
    if (sandbox === 'workspace-write') {
      args.push(
        '-c',
        `sandbox_workspace_write.network_access=${
          request.access.networkPolicy.mode === 'allow-all'
        }`,
      );
    }
    if (this.options.model) args.push('--model', this.options.model);
    args.push('-');

    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-cli',
        label: 'Run Codex CLI',
        status: 'running',
        detail: `${sandbox} / ${cwd}`,
      },
    });

    let finalMessage = '';
    let providerError = '';
    let unstructuredLogCount = 0;
    let stderrLogCount = 0;
    const runningItems = new Map<string, string>();
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
        await request.onEvent?.({
          type: 'log',
          level: 'info',
          message: `Codex thread ${text(event.thread_id) || 'started'}`,
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
        input: buildAgentPrompt(request),
        env: createCliEnvironment({
          provider: 'codex',
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
              message: 'Additional Codex stderr output omitted.',
            });
          }
        },
      });
    } catch (error) {
      if (providerError) throw new Error(providerError, { cause: error });
      throw error;
    }

    if (providerError) throw new Error(providerError);
    if (!finalMessage.trim()) throw new Error('codex_no_final_response');
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-cli',
        label: 'Run Codex CLI',
        status: 'done',
        detail: runningItems.size ? `${runningItems.size} item(s)` : 'completed',
      },
    });
    return {
      summary: finalResponse(finalMessage),
      artifacts: [],
    };
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
