import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AccessBundle,
  AgentIdentity,
  Project,
  SourceThread,
  ThreadConfigContext,
  ThreadConfigStore,
  ToolGrant,
  Workspace,
} from '@opentag/core';
import type {
  ConfigAuditRecord,
  FileConfigState,
  ProjectAgentPolicy,
  ResolvedThreadPolicy,
  UpsertProjectAgentPolicyInput,
  WorkspaceAgentPolicy,
} from './types.js';

const DEFAULT_INSTRUCTIONS =
  'You are OpenTag in a shared work thread. Keep progress visible and publish durable artifacts.';

function now(): string {
  return new Date().toISOString();
}

function safeKey(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]/g, '_') || 'general';
}

function projectKey(workspaceId: string, value: string): string {
  const prefix = `${workspaceId}:`;
  return safeKey(value.startsWith(prefix) ? value.slice(prefix.length) : value);
}

function policyId(workspaceId: string, projectId: string): string {
  return `${safeKey(workspaceId)}:${safeKey(projectId)}`;
}

function defaultIdentity(): AgentIdentity {
  return {
    id: 'opentag',
    displayName: 'OpenTag',
    description: 'Open agent for shared work threads.',
    instructions: DEFAULT_INSTRUCTIONS,
    defaultExecutorId: 'codex',
  };
}

function defaultNetworkPolicy(): AccessBundle['networkPolicy'] {
  return {
    mode: 'deny-by-default',
    allowedHosts: [],
  };
}

function createDefaultState(input?: {
  workspace?: Partial<Workspace>;
  identity?: Partial<AgentIdentity>;
}): FileConfigState {
  const timestamp = now();
  const workspace: Workspace = {
    id: input?.workspace?.id ?? 'dev-workspace',
    name: input?.workspace?.name ?? 'Development Workspace',
    defaultProjectId: input?.workspace?.defaultProjectId ?? 'opentag',
    platformTenantIds: input?.workspace?.platformTenantIds,
    metadata: input?.workspace?.metadata,
  };
  const identity = {
    ...defaultIdentity(),
    ...input?.identity,
  };
  const projectId = workspace.defaultProjectId ?? 'general';
  return {
    version: 1,
    workspaces: [
      {
        workspace,
        identity,
        grants: [],
        networkPolicy: defaultNetworkPolicy(),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    projects: [
      {
        id: policyId(workspace.id, projectId),
        workspaceId: workspace.id,
        projectId,
        name: projectId === 'opentag' ? 'OpenTag' : projectId,
        description: 'Default project for this workspace bot.',
        identity: { ...identity },
        grants: [],
        networkPolicy: defaultNetworkPolicy(),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    audit: [],
  };
}

function cloneIdentity(identity: AgentIdentity): AgentIdentity {
  return { ...identity };
}

function cloneGrant(grant: ToolGrant): ToolGrant {
  return {
    ...grant,
    constraints: grant.constraints ? { ...grant.constraints } : undefined,
  };
}

function cloneWorkspacePolicy(policy: WorkspaceAgentPolicy): WorkspaceAgentPolicy {
  return {
    ...policy,
    workspace: {
      ...policy.workspace,
      platformTenantIds: policy.workspace.platformTenantIds
        ? { ...policy.workspace.platformTenantIds }
        : undefined,
      metadata: policy.workspace.metadata
        ? { ...policy.workspace.metadata }
        : undefined,
    },
    identity: cloneIdentity(policy.identity),
    grants: policy.grants.map(cloneGrant),
    networkPolicy: {
      ...policy.networkPolicy,
      allowedHosts: [...policy.networkPolicy.allowedHosts],
    },
  };
}

function cloneProjectPolicy(policy: ProjectAgentPolicy): ProjectAgentPolicy {
  return {
    ...policy,
    identity: cloneIdentity(policy.identity),
    grants: policy.grants.map(cloneGrant),
    networkPolicy: {
      ...policy.networkPolicy,
      allowedHosts: [...policy.networkPolicy.allowedHosts],
    },
  };
}

function memoryGrants(input: {
  thread: SourceThread;
  workspaceId: string;
  projectId: string;
}): ToolGrant[] {
  return [
    {
      id: 'memory:global',
      kind: 'memory',
      scope: 'global',
      label: 'Global memory',
      constraints: { permissions: ['read'] },
    },
    {
      id: `memory:workspace:${input.workspaceId}`,
      kind: 'memory',
      scope: 'workspace',
      label: 'Workspace memory',
      constraints: { permissions: ['read'] },
    },
    {
      id: `memory:project:${input.projectId}`,
      kind: 'memory',
      scope: 'project',
      label: 'Project memory',
      constraints: { permissions: ['read', 'write'] },
    },
    {
      id: `memory:thread:${input.thread.id}`,
      kind: 'memory',
      scope: 'thread',
      label: 'Thread memory',
      constraints: { permissions: ['read', 'write'] },
    },
  ];
}

function dedupeGrants(grants: ToolGrant[]): ToolGrant[] {
  const deduped = new Map<string, ToolGrant>();
  for (const grant of grants) deduped.set(grant.id, cloneGrant(grant));
  return [...deduped.values()];
}

export class FileThreadConfigStore implements ThreadConfigStore {
  private readonly stateFile: string;
  private readonly fallback: FileConfigState;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    rootDir: string,
    defaults?: {
      workspace?: Partial<Workspace>;
      identity?: Partial<AgentIdentity>;
    },
  ) {
    this.stateFile = path.join(rootDir, 'workspace-config.json');
    this.fallback = createDefaultState(defaults);
  }

  private async load(): Promise<FileConfigState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Partial<FileConfigState>;
      return {
        version: 1,
        workspaces: parsed.workspaces ?? this.fallback.workspaces.map(cloneWorkspacePolicy),
        projects: parsed.projects ?? this.fallback.projects.map(cloneProjectPolicy),
        audit: parsed.audit ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: 1,
          workspaces: this.fallback.workspaces.map(cloneWorkspacePolicy),
          projects: this.fallback.projects.map(cloneProjectPolicy),
          audit: [],
        };
      }
      throw error;
    }
  }

  private async save(state: FileConfigState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporaryFile, this.stateFile);
  }

  private async readState(): Promise<FileConfigState> {
    await this.mutationQueue;
    return this.load();
  }

  private async mutate<T>(operation: (state: FileConfigState) => T): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = operation(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private workspacePolicyFor(
    state: FileConfigState,
    workspaceId?: string,
  ): WorkspaceAgentPolicy {
    return (
      state.workspaces.find((item) => item.workspace.id === workspaceId) ??
      state.workspaces[0] ??
      this.fallback.workspaces[0]
    );
  }

  private projectPolicyFor(
    state: FileConfigState,
    workspaceId: string,
    projectId: string,
  ): ProjectAgentPolicy | undefined {
    const key = projectKey(workspaceId, projectId);
    return state.projects.find(
      (item) => item.workspaceId === workspaceId && item.projectId === key,
    );
  }

  private projectKeyForThread(thread: SourceThread, workspace: Workspace): string {
    const metadataProjectId =
      typeof thread.metadata?.projectId === 'string'
        ? thread.metadata.projectId
        : undefined;
    return projectKey(
      workspace.id,
      thread.projectId ||
        metadataProjectId ||
        thread.channelId ||
        workspace.defaultProjectId ||
        'general',
    );
  }

  async getWorkspace(thread: SourceThread): Promise<Workspace> {
    const state = await this.readState();
    const policy = this.workspacePolicyFor(state, thread.workspaceId);
    if (!thread.workspaceId || policy.workspace.id === thread.workspaceId) {
      return cloneWorkspacePolicy(policy).workspace;
    }
    return {
      ...policy.workspace,
      id: thread.workspaceId,
      name: thread.workspaceId,
    };
  }

  async getProject(
    thread: SourceThread,
    workspace?: Workspace,
  ): Promise<Project> {
    const resolvedWorkspace = workspace ?? (await this.getWorkspace(thread));
    const state = await this.readState();
    const key = this.projectKeyForThread(thread, resolvedWorkspace);
    const policy = this.projectPolicyFor(state, resolvedWorkspace.id, key);
    return {
      id: policyId(resolvedWorkspace.id, key),
      workspaceId: resolvedWorkspace.id,
      key,
      name: policy?.name || thread.title || key,
      description: policy?.description,
      platformBindings: [
        {
          platform: thread.platform,
          externalId: thread.externalId,
          channelId: thread.channelId,
        },
      ],
      metadata: {
        configured: Boolean(policy),
        agentId: policy?.identity.id,
      },
    };
  }

  async getIdentity(thread: SourceThread): Promise<AgentIdentity> {
    const workspace = await this.getWorkspace(thread);
    const state = await this.readState();
    const workspacePolicy = this.workspacePolicyFor(state, workspace.id);
    const key = this.projectKeyForThread(thread, workspace);
    const policy = this.projectPolicyFor(state, workspace.id, key);
    return cloneIdentity(policy?.identity ?? workspacePolicy.identity);
  }

  async getAccessBundle(
    thread: SourceThread,
    context?: ThreadConfigContext,
  ): Promise<AccessBundle> {
    const workspace = context?.workspace ?? (await this.getWorkspace(thread));
    const project = context?.project ?? (await this.getProject(thread, workspace));
    const state = await this.readState();
    const workspacePolicy = this.workspacePolicyFor(state, workspace.id);
    const policy = this.projectPolicyFor(state, workspace.id, project.key);
    return {
      id: `access:${thread.id}`,
      threadId: thread.id,
      workspaceId: workspace.id,
      projectId: project.id,
      grants: dedupeGrants([
        ...memoryGrants({ thread, workspaceId: workspace.id, projectId: project.id }),
        ...workspacePolicy.grants,
        ...(policy?.grants ?? []),
      ]),
      networkPolicy: {
        ...(policy?.networkPolicy ?? workspacePolicy.networkPolicy),
        allowedHosts: [
          ...(policy?.networkPolicy.allowedHosts ??
            workspacePolicy.networkPolicy.allowedHosts),
        ],
      },
    };
  }

  async resolveThreadPolicy(thread: SourceThread): Promise<ResolvedThreadPolicy> {
    const workspace = await this.getWorkspace(thread);
    const project = await this.getProject(thread, workspace);
    const [identity, access] = await Promise.all([
      this.getIdentity(thread),
      this.getAccessBundle(thread, { workspace, project }),
    ]);
    return {
      workspace,
      project,
      identity,
      access,
      configured: Boolean(project.metadata?.configured),
    };
  }

  async listWorkspacePolicies(): Promise<WorkspaceAgentPolicy[]> {
    const state = await this.readState();
    return state.workspaces.map(cloneWorkspacePolicy);
  }

  async listProjectPolicies(workspaceId?: string): Promise<ProjectAgentPolicy[]> {
    const state = await this.readState();
    return state.projects
      .filter((item) => !workspaceId || item.workspaceId === workspaceId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(cloneProjectPolicy);
  }

  async upsertProjectPolicy(
    input: UpsertProjectAgentPolicyInput,
  ): Promise<ProjectAgentPolicy> {
    return this.mutate((state) => {
      const workspacePolicy = this.workspacePolicyFor(state, input.workspaceId);
      const projectId = projectKey(input.workspaceId, input.projectId);
      const existing = this.projectPolicyFor(state, input.workspaceId, projectId);
      const timestamp = now();
      const identityBase = existing?.identity ?? workspacePolicy.identity;
      const networkBase = existing?.networkPolicy ?? workspacePolicy.networkPolicy;
      const policy: ProjectAgentPolicy = {
        id: policyId(input.workspaceId, projectId),
        workspaceId: input.workspaceId,
        projectId,
        name: input.name?.trim() || existing?.name || projectId,
        description:
          input.description === undefined
            ? existing?.description
            : input.description.trim() || undefined,
        identity: {
          ...identityBase,
          ...input.identity,
          id: input.identity?.id?.trim() || identityBase.id,
          displayName:
            input.identity?.displayName?.trim() || identityBase.displayName,
          instructions:
            input.identity?.instructions?.trim() || identityBase.instructions,
          defaultExecutorId:
            input.identity?.defaultExecutorId?.trim() ||
            identityBase.defaultExecutorId,
        },
        grants: (input.grants ?? existing?.grants ?? []).map(cloneGrant),
        networkPolicy: {
          mode: input.networkPolicy?.mode ?? networkBase.mode,
          allowedHosts: [
            ...(input.networkPolicy?.allowedHosts ?? networkBase.allowedHosts),
          ],
        },
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (existing) {
        state.projects.splice(state.projects.indexOf(existing), 1, policy);
      } else {
        state.projects.push(policy);
      }
      const audit: ConfigAuditRecord = {
        id: randomUUID(),
        action: existing ? 'project.updated' : 'project.created',
        actor: input.actor?.trim() || 'admin',
        workspaceId: input.workspaceId,
        projectId,
        at: timestamp,
        snapshot: cloneProjectPolicy(policy),
      };
      state.audit.push(audit);
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneProjectPolicy(policy);
    });
  }

  async listAudit(
    limit = 50,
    workspaceId?: string,
  ): Promise<ConfigAuditRecord[]> {
    const state = await this.readState();
    return state.audit
      .filter((item) => !workspaceId || item.workspaceId === workspaceId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((item) => ({
        ...item,
        snapshot: cloneProjectPolicy(item.snapshot),
      }));
  }
}
