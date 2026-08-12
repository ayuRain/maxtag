import type {
  AccessBundle,
  AgentIdentity,
  Project,
  SourceThread,
  ThreadConfigStore,
  ThreadConfigContext,
  Workspace,
} from './types.js';

function safeKey(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]/g, '_') || 'default';
}

export class StaticThreadConfigStore implements ThreadConfigStore {
  private readonly identity: AgentIdentity;
  private readonly workspace: Workspace;

  constructor(input?: {
    identity?: Partial<AgentIdentity>;
    workspace?: Partial<Workspace>;
  }) {
    const identity = input?.identity;
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
    this.workspace = {
      id: input?.workspace?.id ?? 'default-workspace',
      name: input?.workspace?.name ?? 'Default Workspace',
      defaultProjectId: input?.workspace?.defaultProjectId ?? 'general',
      platformTenantIds: input?.workspace?.platformTenantIds,
      metadata: input?.workspace?.metadata,
    };
  }

  async getWorkspace(thread: SourceThread): Promise<Workspace> {
    const id = thread.workspaceId || this.workspace.id;
    return {
      ...this.workspace,
      id,
      name: id === this.workspace.id ? this.workspace.name : id,
    };
  }

  async getProject(
    thread: SourceThread,
    workspace = this.workspace,
  ): Promise<Project> {
    const metadataProjectId =
      typeof thread.metadata?.projectId === 'string'
        ? thread.metadata.projectId
        : undefined;
    const key = safeKey(
      thread.projectId ||
        metadataProjectId ||
        thread.channelId ||
        workspace.defaultProjectId ||
        'general',
    );
    return {
      id: `${workspace.id}:${key}`,
      workspaceId: workspace.id,
      key,
      name: thread.title || key,
      platformBindings: [
        {
          platform: thread.platform,
          externalId: thread.externalId,
          channelId: thread.channelId,
        },
      ],
    };
  }

  async getIdentity(_thread: SourceThread): Promise<AgentIdentity> {
    return this.identity;
  }

  async getAccessBundle(
    thread: SourceThread,
    context?: ThreadConfigContext,
  ): Promise<AccessBundle> {
    return {
      id: `access:${thread.id}`,
      threadId: thread.id,
      workspaceId: context?.workspace?.id,
      projectId: context?.project?.id,
      grants: [
        ...(thread.visibility !== 'direct'
          ? [
              {
                id: `memory:workspace:${context?.workspace?.id ?? thread.workspaceId ?? 'default'}`,
                kind: 'memory',
                scope: 'workspace' as const,
                label: 'Workspace memory',
                constraints: {
                  permissions:
                    thread.visibility === 'private'
                      ? ['read']
                      : ['read', 'write'],
                },
              },
              {
                id: `memory:project:${context?.project?.id ?? thread.projectId ?? 'general'}`,
                kind: 'memory',
                scope: 'project' as const,
                label: 'Project memory',
                constraints: { permissions: ['read', 'write'] },
              },
            ]
          : []),
        {
          id: `memory:thread:${thread.id}`,
          kind: 'memory',
          scope: 'thread',
          label: 'Thread memory',
          constraints: { permissions: ['read', 'write'] },
        },
      ],
      networkPolicy: {
        mode: 'deny-by-default',
        allowedHosts: [],
      },
    };
  }
}
