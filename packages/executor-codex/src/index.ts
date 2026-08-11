import type { AgentRunRequest, AgentRunResult, Executor } from '@opentag/core';

export interface CodexExecutorOptions {
  mode?: 'dry-run' | 'local-cli';
  model?: string;
}

export class CodexExecutor implements Executor {
  readonly id = 'codex';
  readonly label = 'Codex';
  private readonly options: CodexExecutorOptions;

  constructor(options?: CodexExecutorOptions) {
    this.options = options ?? {};
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'codex-plan',
        label: 'Prepare Codex run',
        status: 'done',
        detail: this.options.model ? `model=${this.options.model}` : undefined,
      },
    });

    if ((this.options.mode ?? 'dry-run') !== 'dry-run') {
      throw new Error('Codex local-cli executor is not wired yet.');
    }

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
