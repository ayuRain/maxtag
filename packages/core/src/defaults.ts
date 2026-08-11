import type {
  AccessBundle,
  AgentIdentity,
  SourceThread,
  ThreadConfigStore,
} from './types.js';

export class StaticThreadConfigStore implements ThreadConfigStore {
  private readonly identity: AgentIdentity;

  constructor(identity?: Partial<AgentIdentity>) {
    this.identity = {
      id: identity?.id ?? 'default',
      displayName: identity?.displayName ?? 'OpenTag',
      description: identity?.description ?? 'Open agent for shared work threads.',
      instructions:
        identity?.instructions ??
        'Help the thread move work forward. Keep progress visible and publish durable artifacts.',
      defaultExecutorId: identity?.defaultExecutorId ?? 'codex',
      avatarUrl: identity?.avatarUrl,
    };
  }

  async getIdentity(_thread: SourceThread): Promise<AgentIdentity> {
    return this.identity;
  }

  async getAccessBundle(thread: SourceThread): Promise<AccessBundle> {
    return {
      id: `access:${thread.id}`,
      threadId: thread.id,
      grants: [
        {
          id: `memory:${thread.id}`,
          kind: 'memory',
          scope: 'thread',
          label: 'Thread memory',
        },
      ],
      networkPolicy: {
        mode: 'deny-by-default',
        allowedHosts: [],
      },
    };
  }
}

