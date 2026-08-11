import type { AgentRunRequest, AgentRunResult, Executor } from '@opentag/core';

export interface ClaudeExecutorOptions {
  mode?: 'dry-run' | 'local-cli';
  model?: string;
}

export class ClaudeExecutor implements Executor {
  readonly id = 'claude';
  readonly label = 'Claude';
  private readonly options: ClaudeExecutorOptions;

  constructor(options?: ClaudeExecutorOptions) {
    this.options = options ?? {};
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    await request.onEvent?.({
      type: 'progress',
      item: {
        id: 'claude-plan',
        label: 'Prepare Claude run',
        status: 'done',
        detail: this.options.model ? `model=${this.options.model}` : undefined,
      },
    });

    if ((this.options.mode ?? 'dry-run') !== 'dry-run') {
      throw new Error('Claude local-cli executor is not wired yet.');
    }

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
