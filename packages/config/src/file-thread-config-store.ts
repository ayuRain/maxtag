import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AccessBundle,
  AgentIdentity,
  MemoryApprovalPolicy,
  MemoryRetentionPolicy,
  Project,
  MemoryApprovalAction,
  MemoryScopeKind,
  SourceThread,
  ThreadConfigContext,
  ThreadConfigStore,
  ToolApprovalPolicy,
  ToolGrant,
  Workspace,
} from '@opentag/core';
import type {
  ConfigAuditRecord,
  CapabilityBundle,
  CapabilityBundlePreset,
  ChannelAgentPolicy,
  ChannelCapabilityMode,
  ChannelInstructionMode,
  FileConfigState,
  ProjectAgentMode,
  ProjectAgentPolicy,
  ProjectCapabilityMode,
  ProjectMemoryMode,
  ResolvedThreadPolicy,
  UpsertChannelAgentPolicyInput,
  UpsertCapabilityBundleInput,
  UpsertProjectAgentPolicyInput,
  UpsertWorkspaceAgentPolicyInput,
  WorkspaceAgentPolicy,
} from './types.js';

const DEFAULT_INSTRUCTIONS =
  'You are MaxTag in a shared work thread. Keep progress visible and publish durable artifacts.';

function now(): string {
  return new Date().toISOString();
}

function safeKey(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]/g, '_') || 'general';
}

function normalizedSkillIds(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)),
    ),
  ];
}

const normalizedAgentIds = normalizedSkillIds;
const normalizedKnowledgeSourceIds = normalizedSkillIds;
const normalizedBundleIds = normalizedSkillIds;

function capabilityBundleId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id)) {
    throw new Error('capability_bundle_invalid_id');
  }
  return id;
}

function capabilityBundlePreset(value: unknown): CapabilityBundlePreset {
  return value === 'data-readonly' ||
    value === 'platform-monitoring' ||
    value === 'github-write'
    ? value
    : 'custom';
}

function projectKey(workspaceId: string, value: string): string {
  const prefix = `${workspaceId}:`;
  return safeKey(value.startsWith(prefix) ? value.slice(prefix.length) : value);
}

function policyId(workspaceId: string, projectId: string): string {
  return `${safeKey(workspaceId)}:${safeKey(projectId)}`;
}

function channelPolicyId(
  workspaceId: string,
  platform: string,
  channelId: string,
): string {
  return `${safeKey(workspaceId)}:${safeKey(platform)}:${safeKey(channelId)}`;
}

function defaultIdentity(): AgentIdentity {
  return {
    id: 'opentag',
    displayName: 'MaxTag',
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
        skillIds: [],
        agentIds: [],
        knowledgeSourceIds: [],
        bundleIds: [],
        grants: [],
        networkPolicy: defaultNetworkPolicy(),
        budgetPolicy: { mode: 'disabled' },
        defaultChannelBudgetPolicy: { mode: 'disabled' },
        memoryApprovalPolicy: { mode: 'disabled' },
        memoryRetentionPolicy: { mode: 'keep' },
        toolApprovalPolicy: { mode: 'require_approval', risks: ['write'] },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    projects: [
      {
        id: policyId(workspace.id, projectId),
        workspaceId: workspace.id,
        projectId,
        name: projectId === 'opentag' ? 'MaxTag' : projectId,
        description: 'Default project for this workspace bot.',
        identity: { ...identity },
        agentMode: 'inherit',
        capabilityMode: 'inherit',
        skillIds: [],
        agentIds: [],
        knowledgeSourceIds: [],
        bundleIds: [],
        grants: [],
        networkPolicy: defaultNetworkPolicy(),
        memoryMode: 'workspace',
        budgetPolicy: { mode: 'inherit' },
        defaultChannelBudgetPolicy: { mode: 'inherit' },
        memoryApprovalPolicy: { mode: 'inherit' },
        memoryRetentionPolicy: { mode: 'inherit' },
        toolApprovalPolicy: { mode: 'inherit' },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    channels: [],
    capabilityBundles: [],
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

function cloneCapabilityBundle(bundle: CapabilityBundle): CapabilityBundle {
  return {
    ...bundle,
    skillIds: normalizedSkillIds(bundle.skillIds),
    agentIds: normalizedAgentIds(bundle.agentIds),
    knowledgeSourceIds: normalizedKnowledgeSourceIds(bundle.knowledgeSourceIds),
    grants: bundle.grants.map(cloneGrant),
    networkPolicy: {
      ...bundle.networkPolicy,
      allowedHosts: [...bundle.networkPolicy.allowedHosts],
    },
  };
}

function cloneBudgetPolicy<T extends { budgetPolicy?: WorkspaceAgentPolicy['budgetPolicy'] }>(
  value: T,
): T {
  return {
    ...value,
    budgetPolicy: value.budgetPolicy ? { ...value.budgetPolicy } : undefined,
  };
}

function cloneMemoryApprovalPolicy(
  policy: MemoryApprovalPolicy | undefined,
): MemoryApprovalPolicy | undefined {
  return policy
    ? {
        ...policy,
        scopes: policy.scopes ? [...policy.scopes] : undefined,
        actions: policy.actions ? [...policy.actions] : undefined,
      }
    : undefined;
}

function cloneMemoryRetentionPolicy(
  policy: MemoryRetentionPolicy | undefined,
): MemoryRetentionPolicy | undefined {
  return policy ? { ...policy } : undefined;
}

function cloneToolApprovalPolicy(
  policy: ToolApprovalPolicy | undefined,
): ToolApprovalPolicy | undefined {
  return policy
    ? {
        ...policy,
        risks: policy.risks ? [...policy.risks] : undefined,
      }
    : undefined;
}

function cloneWorkspacePolicy(policy: WorkspaceAgentPolicy): WorkspaceAgentPolicy {
  const cloned = cloneBudgetPolicy({
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
    skillIds: normalizedSkillIds(policy.skillIds),
    agentIds: normalizedAgentIds(policy.agentIds),
    knowledgeSourceIds: normalizedKnowledgeSourceIds(policy.knowledgeSourceIds),
    bundleIds: normalizedBundleIds(policy.bundleIds),
    grants: policy.grants.map(cloneGrant),
    networkPolicy: {
      ...policy.networkPolicy,
      allowedHosts: [...policy.networkPolicy.allowedHosts],
    },
    memoryApprovalPolicy: cloneMemoryApprovalPolicy(
      policy.memoryApprovalPolicy,
    ),
    memoryRetentionPolicy: cloneMemoryRetentionPolicy(
      policy.memoryRetentionPolicy,
    ),
    toolApprovalPolicy: cloneToolApprovalPolicy(policy.toolApprovalPolicy),
  });
  return {
    ...cloned,
    defaultChannelBudgetPolicy: policy.defaultChannelBudgetPolicy
      ? { ...policy.defaultChannelBudgetPolicy }
      : undefined,
  };
}

function cloneProjectPolicy(policy: ProjectAgentPolicy): ProjectAgentPolicy {
  const cloned = cloneBudgetPolicy({
    ...policy,
    identity: cloneIdentity(policy.identity),
    agentMode: policy.agentMode ?? 'custom',
    capabilityMode: policy.capabilityMode ?? 'custom',
    skillIds: normalizedSkillIds(policy.skillIds),
    agentIds: normalizedAgentIds(policy.agentIds),
    knowledgeSourceIds: normalizedKnowledgeSourceIds(policy.knowledgeSourceIds),
    bundleIds: normalizedBundleIds(policy.bundleIds),
    grants: policy.grants.map(cloneGrant),
    networkPolicy: {
      ...policy.networkPolicy,
      allowedHosts: [...policy.networkPolicy.allowedHosts],
    },
    memoryMode: policy.memoryMode ?? 'workspace',
    memoryApprovalPolicy: cloneMemoryApprovalPolicy(
      policy.memoryApprovalPolicy,
    ),
    memoryRetentionPolicy: cloneMemoryRetentionPolicy(
      policy.memoryRetentionPolicy,
    ),
    toolApprovalPolicy: cloneToolApprovalPolicy(policy.toolApprovalPolicy),
  });
  return {
    ...cloned,
    defaultChannelBudgetPolicy: policy.defaultChannelBudgetPolicy
      ? { ...policy.defaultChannelBudgetPolicy }
      : undefined,
  };
}

function cloneChannelPolicy(policy: ChannelAgentPolicy): ChannelAgentPolicy {
  return cloneBudgetPolicy({
    ...policy,
    instructionMode: policy.instructionMode ?? 'inherit',
    capabilityMode: policy.capabilityMode ?? 'inherit',
    skillIds: normalizedSkillIds(policy.skillIds),
    agentIds: normalizedAgentIds(policy.agentIds),
    knowledgeSourceIds: normalizedKnowledgeSourceIds(policy.knowledgeSourceIds),
    bundleIds: normalizedBundleIds(policy.bundleIds),
    grants: (policy.grants ?? []).map(cloneGrant),
    networkPolicy: {
      ...(policy.networkPolicy ?? defaultNetworkPolicy()),
      allowedHosts: [...(policy.networkPolicy?.allowedHosts ?? [])],
    },
    memoryApprovalPolicy: cloneMemoryApprovalPolicy(
      policy.memoryApprovalPolicy,
    ),
    toolApprovalPolicy: cloneToolApprovalPolicy(policy.toolApprovalPolicy),
  });
}

function memoryGrants(input: {
  thread: SourceThread;
  workspaceId: string;
  projectId: string;
  memoryMode: ProjectMemoryMode;
}): ToolGrant[] {
  const grants: ToolGrant[] = [
    ...(input.thread.visibility !== 'direct' && input.memoryMode === 'workspace'
      ? [
          {
            id: `memory:workspace:${input.workspaceId}`,
            kind: 'memory',
            scope: 'workspace' as const,
            label: 'Workspace memory',
            constraints: {
              permissions:
                input.thread.visibility === 'private'
                  ? ['read']
                  : ['read', 'write'],
            },
          },
        ]
      : []),
    ...(input.thread.visibility !== 'direct'
      ? [
          {
            id: `memory:project:${input.projectId}`,
            kind: 'memory',
            scope: 'project' as const,
            label: 'Project memory',
            constraints: { permissions: ['read', 'write'] },
          },
          {
            id: `memory:channel:${input.thread.platform}:${input.thread.channelId || input.thread.externalId}`,
            kind: 'memory',
            scope: 'channel' as const,
            label: 'Channel memory',
            constraints: { permissions: ['read', 'write'] },
          },
        ]
      : []),
    {
      id: `memory:thread:${input.thread.id}`,
      kind: 'memory',
      scope: 'thread',
      label: 'Thread memory',
      constraints: { permissions: ['read', 'write'] },
    },
  ];
  return grants;
}

function resolvedBudgetPolicy(input: {
  workspace: WorkspaceAgentPolicy;
  project?: ProjectAgentPolicy;
  channel?: ChannelAgentPolicy;
}): WorkspaceAgentPolicy['budgetPolicy'] {
  const channelPolicy = input.channel?.budgetPolicy;
  if (channelPolicy?.mode === 'custom') {
    return { ...channelPolicy, scope: channelPolicy.scope ?? 'channel' };
  }
  if (channelPolicy?.mode === 'disabled') return { mode: 'disabled' };
  const projectPolicy = input.project?.budgetPolicy;
  if (projectPolicy?.mode === 'custom') {
    return { ...projectPolicy, scope: projectPolicy.scope ?? 'project' };
  }
  if (projectPolicy?.mode === 'disabled') return { mode: 'disabled' };
  return input.workspace.budgetPolicy
    ? {
        ...input.workspace.budgetPolicy,
        scope: input.workspace.budgetPolicy.scope ?? 'workspace',
      }
    : { mode: 'disabled' };
}

function resolvedBudgetPolicies(input: {
  workspace: WorkspaceAgentPolicy;
  project?: ProjectAgentPolicy;
  channel?: ChannelAgentPolicy;
}): NonNullable<AccessBundle['budgetPolicies']> {
  const policies: NonNullable<AccessBundle['budgetPolicies']> = [];
  if (input.workspace.budgetPolicy?.mode === 'custom') {
    policies.push({ ...input.workspace.budgetPolicy, scope: 'workspace' });
  }
  if (input.project?.budgetPolicy?.mode === 'custom') {
    policies.push({ ...input.project.budgetPolicy, scope: 'project' });
  }
  if (input.channel?.budgetPolicy?.mode === 'custom') {
    policies.push({ ...input.channel.budgetPolicy, scope: 'channel' });
  } else if (input.channel?.budgetPolicy?.mode !== 'disabled') {
    const projectDefault = input.project?.defaultChannelBudgetPolicy;
    const workspaceDefault = input.workspace.defaultChannelBudgetPolicy;
    if (projectDefault?.mode === 'custom') {
      policies.push({ ...projectDefault, scope: 'channel' });
    } else if (
      projectDefault?.mode !== 'disabled' &&
      workspaceDefault?.mode === 'custom'
    ) {
      policies.push({ ...workspaceDefault, scope: 'channel' });
    }
  }
  return policies;
}

function resolvedMemoryApprovalPolicy(input: {
  workspace: WorkspaceAgentPolicy;
  project?: ProjectAgentPolicy;
  channel?: ChannelAgentPolicy;
}): MemoryApprovalPolicy {
  const channelPolicy = input.channel?.memoryApprovalPolicy;
  if (channelPolicy?.mode && channelPolicy.mode !== 'inherit') {
    return normalizeMemoryApprovalPolicy(channelPolicy, channelPolicy.mode);
  }
  const projectPolicy = input.project?.memoryApprovalPolicy;
  if (projectPolicy?.mode && projectPolicy.mode !== 'inherit') {
    return normalizeMemoryApprovalPolicy(projectPolicy, projectPolicy.mode);
  }
  return normalizeMemoryApprovalPolicy(
    input.workspace.memoryApprovalPolicy,
    input.workspace.memoryApprovalPolicy?.mode ?? 'disabled',
  );
}

function normalizeToolApprovalPolicy(
  policy: ToolApprovalPolicy | undefined,
  mode: NonNullable<ToolApprovalPolicy['mode']>,
): ToolApprovalPolicy {
  if (mode === 'disabled' || mode === 'inherit') return { mode };
  const risks = policy?.risks?.filter((risk) => risk === 'write') ?? [];
  return { mode: 'require_approval', risks: risks.length ? risks : ['write'] };
}

function resolvedToolApprovalPolicy(input: {
  workspace: WorkspaceAgentPolicy;
  project?: ProjectAgentPolicy;
  channel?: ChannelAgentPolicy;
}): ToolApprovalPolicy {
  const channelPolicy = input.channel?.toolApprovalPolicy;
  if (channelPolicy?.mode && channelPolicy.mode !== 'inherit') {
    return normalizeToolApprovalPolicy(channelPolicy, channelPolicy.mode);
  }
  const projectPolicy = input.project?.toolApprovalPolicy;
  if (projectPolicy?.mode && projectPolicy.mode !== 'inherit') {
    return normalizeToolApprovalPolicy(projectPolicy, projectPolicy.mode);
  }
  return normalizeToolApprovalPolicy(
    input.workspace.toolApprovalPolicy,
    input.workspace.toolApprovalPolicy?.mode ?? 'require_approval',
  );
}

function retentionDays(
  policy: MemoryRetentionPolicy | undefined,
): number | undefined {
  if (policy?.mode !== 'custom') return undefined;
  const days = Math.floor(policy.days ?? 0);
  return days >= 1 && days <= 3_650 ? days : undefined;
}

function resolvedMemoryRetentionDays(input: {
  workspace: WorkspaceAgentPolicy;
  project?: ProjectAgentPolicy;
}): NonNullable<AccessBundle['memoryRetentionDays']> {
  const workspaceDays = retentionDays(input.workspace.memoryRetentionPolicy);
  const projectPolicy = input.project?.memoryRetentionPolicy;
  const projectDays =
    projectPolicy?.mode === 'keep'
      ? undefined
      : retentionDays(projectPolicy) ?? workspaceDays;
  return {
    ...(workspaceDays ? { workspace: workspaceDays } : {}),
    ...(projectDays
      ? {
          project: projectDays,
          channel: projectDays,
          thread: projectDays,
        }
      : {}),
  };
}

function normalizeMemoryApprovalPolicy(
  policy: MemoryApprovalPolicy | undefined,
  mode: NonNullable<MemoryApprovalPolicy['mode']>,
): MemoryApprovalPolicy {
  if (mode === 'disabled' || mode === 'inherit') return { mode };
  return {
    mode: 'require_approval',
    scopes: normalizeMemoryApprovalScopes(policy?.scopes),
    actions: normalizeMemoryApprovalActions(policy?.actions),
  };
}

function normalizeMemoryApprovalScopes(
  scopes: MemoryScopeKind[] | undefined,
): MemoryScopeKind[] {
  const values = scopes?.filter((scope) => scope !== 'global') ?? [];
  const defaults: MemoryScopeKind[] = ['workspace', 'project'];
  return [...new Set(values.length ? values : defaults)];
}

function normalizeMemoryApprovalActions(
  actions: MemoryApprovalAction[] | undefined,
): MemoryApprovalAction[] {
  const values = actions ?? [];
  const defaults: MemoryApprovalAction[] = ['remember', 'forget'];
  return [...new Set(values.length ? values : defaults)];
}

function dedupeGrants(grants: ToolGrant[]): ToolGrant[] {
  const deduped = new Map<string, ToolGrant>();
  for (const grant of grants) deduped.set(grant.id, cloneGrant(grant));
  return [...deduped.values()];
}

function extendedNetworkPolicy(
  base: AccessBundle['networkPolicy'],
  channel: AccessBundle['networkPolicy'],
): AccessBundle['networkPolicy'] {
  const allowedHosts = [...new Set([
    ...base.allowedHosts,
    ...channel.allowedHosts,
  ])];
  const mode =
    base.mode === 'allow-all' || channel.mode === 'allow-all'
      ? 'allow-all'
      : allowedHosts.length
        ? 'restricted'
        : 'deny-by-default';
  return { mode, allowedHosts };
}

function enabledCapabilityBundles(
  state: FileConfigState,
  workspaceId: string,
  ids: string[],
): CapabilityBundle[] {
  const requested = new Set(normalizedBundleIds(ids));
  return state.capabilityBundles
    .filter(
      (bundle) =>
        bundle.workspaceId === workspaceId &&
        bundle.enabled &&
        requested.has(bundle.id),
    )
    .map(cloneCapabilityBundle);
}

function assertCapabilityBundleIds(
  state: FileConfigState,
  workspaceId: string,
  ids: string[],
): void {
  const available = new Set(
    state.capabilityBundles
      .filter((bundle) => bundle.workspaceId === workspaceId)
      .map((bundle) => bundle.id),
  );
  const missing = normalizedBundleIds(ids).find((id) => !available.has(id));
  if (missing) throw new Error(`capability_bundle_not_found:${missing}`);
}

function resolvedCapabilityBundleIds(input: {
  workspace: WorkspaceAgentPolicy;
  project?: ProjectAgentPolicy;
  channel?: ChannelAgentPolicy;
}): string[] {
  const workspaceIds = normalizedBundleIds(input.workspace.bundleIds);
  const projectIds =
    !input.project || input.project.capabilityMode === 'inherit'
      ? workspaceIds
      : normalizedBundleIds(input.project.bundleIds);
  if (input.channel?.capabilityMode === 'custom') {
    return normalizedBundleIds(input.channel.bundleIds);
  }
  if (input.channel?.capabilityMode === 'extend') {
    return normalizedBundleIds([...projectIds, ...input.channel.bundleIds]);
  }
  return projectIds;
}

export class CapabilityBundleRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('capability_bundle_revision_conflict');
    this.name = 'CapabilityBundleRevisionConflictError';
  }
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
        workspaces: (parsed.workspaces ?? this.fallback.workspaces).map(
          cloneWorkspacePolicy,
        ),
        projects: (parsed.projects ?? this.fallback.projects).map(
          cloneProjectPolicy,
        ),
        channels: (parsed.channels ?? this.fallback.channels).map(
          cloneChannelPolicy,
        ),
        capabilityBundles: (
          parsed.capabilityBundles ?? this.fallback.capabilityBundles
        ).map(cloneCapabilityBundle),
        audit: parsed.audit ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: 1,
          workspaces: this.fallback.workspaces.map(cloneWorkspacePolicy),
          projects: this.fallback.projects.map(cloneProjectPolicy),
          channels: this.fallback.channels.map(cloneChannelPolicy),
          capabilityBundles: this.fallback.capabilityBundles.map(
            cloneCapabilityBundle,
          ),
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

  private channelPolicyFor(
    state: FileConfigState,
    thread: SourceThread,
    workspaceId: string,
    projectId: string,
  ): ChannelAgentPolicy | undefined {
    if (thread.visibility === 'direct') return undefined;
    const channelId = thread.channelId || thread.externalId;
    const project = projectKey(workspaceId, projectId);
    return state.channels.find(
      (item) =>
        item.workspaceId === workspaceId &&
        item.projectId === project &&
        item.platform === thread.platform &&
        item.channelId === channelId,
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
        agentId:
          policy?.agentMode === 'custom'
            ? policy.identity.id
            : this.workspacePolicyFor(state, resolvedWorkspace.id).identity.id,
        agentMode: policy?.agentMode ?? 'inherit',
        capabilityMode: policy?.capabilityMode ?? 'inherit',
        memoryMode: policy?.memoryMode ?? 'workspace',
      },
    };
  }

  async getIdentity(thread: SourceThread): Promise<AgentIdentity> {
    const workspace = await this.getWorkspace(thread);
    const state = await this.readState();
    const workspacePolicy = this.workspacePolicyFor(state, workspace.id);
    const key = this.projectKeyForThread(thread, workspace);
    const policy = this.projectPolicyFor(state, workspace.id, key);
    const channel = this.channelPolicyFor(state, thread, workspace.id, key);
    const base = cloneIdentity(
      policy?.agentMode === 'custom' ? policy.identity : workspacePolicy.identity,
    );
    const instructions = channel?.instructions?.trim();
    if (!instructions || channel?.instructionMode === 'inherit') return base;
    return {
      ...base,
      instructions:
        channel?.instructionMode === 'replace'
          ? instructions
          : `${base.instructions.trim()}\n\nChannel instructions:\n${instructions}`,
    };
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
    const channel = this.channelPolicyFor(
      state,
      thread,
      workspace.id,
      project.key,
    );
    const inheritsCapabilities = !policy || policy.capabilityMode === 'inherit';
    const projectGrants = inheritsCapabilities
      ? workspacePolicy.grants
      : policy.grants;
    const projectNetworkPolicy = inheritsCapabilities
      ? workspacePolicy.networkPolicy
      : policy.networkPolicy;
    const capabilityGrants =
      channel?.capabilityMode === 'custom'
        ? channel.grants
        : channel?.capabilityMode === 'extend'
          ? [...projectGrants, ...channel.grants]
          : projectGrants;
    const networkPolicy =
      channel?.capabilityMode === 'custom'
        ? channel.networkPolicy
        : channel?.capabilityMode === 'extend'
          ? extendedNetworkPolicy(
              projectNetworkPolicy,
              channel.networkPolicy,
            )
          : projectNetworkPolicy;
    const capabilityBundleIds = resolvedCapabilityBundleIds({
      workspace: workspacePolicy,
      project: policy,
      channel,
    });
    const capabilityBundles = enabledCapabilityBundles(
      state,
      workspace.id,
      capabilityBundleIds,
    );
    const bundleNetworkPolicy = capabilityBundles.reduce(
      (current, bundle) => extendedNetworkPolicy(current, bundle.networkPolicy),
      defaultNetworkPolicy(),
    );
    const effectiveNetworkPolicy = extendedNetworkPolicy(
      networkPolicy,
      bundleNetworkPolicy,
    );
    return {
      id: `access:${thread.id}`,
      threadId: thread.id,
      workspaceId: workspace.id,
      projectId: project.id,
      capabilityBundleIds: capabilityBundles.map((bundle) => bundle.id),
      skillIds: normalizedSkillIds([
        ...workspacePolicy.skillIds,
        ...(policy?.skillIds ?? []),
        ...(channel?.skillIds ?? []),
        ...capabilityBundles.flatMap((bundle) => bundle.skillIds),
      ]),
      agentIds: normalizedAgentIds([
        ...workspacePolicy.agentIds,
        ...(policy?.agentIds ?? []),
        ...(channel?.agentIds ?? []),
        ...capabilityBundles.flatMap((bundle) => bundle.agentIds),
      ]),
      knowledgeSourceIds: normalizedKnowledgeSourceIds([
        ...workspacePolicy.knowledgeSourceIds,
        ...(policy?.knowledgeSourceIds ?? []),
        ...(channel?.knowledgeSourceIds ?? []),
        ...capabilityBundles.flatMap((bundle) => bundle.knowledgeSourceIds),
      ]),
      grants: dedupeGrants([
        ...memoryGrants({
          thread,
          workspaceId: workspace.id,
          projectId: project.id,
          memoryMode: policy?.memoryMode ?? 'workspace',
        }),
        ...capabilityBundles.flatMap((bundle) => bundle.grants),
        ...capabilityGrants,
      ]),
      networkPolicy: {
        ...effectiveNetworkPolicy,
        allowedHosts: [...effectiveNetworkPolicy.allowedHosts],
      },
      budgetPolicy: resolvedBudgetPolicy({
        workspace: workspacePolicy,
        project: policy,
        channel,
      }),
      budgetPolicies: resolvedBudgetPolicies({
        workspace: workspacePolicy,
        project: policy,
        channel,
      }),
      memoryApprovalPolicy: resolvedMemoryApprovalPolicy({
        workspace: workspacePolicy,
        project: policy,
        channel,
      }),
      memoryRetentionDays: resolvedMemoryRetentionDays({
        workspace: workspacePolicy,
        project: policy,
      }),
      toolApprovalPolicy: resolvedToolApprovalPolicy({
        workspace: workspacePolicy,
        project: policy,
        channel,
      }),
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
      channelPolicy: this.channelPolicyFor(
        await this.readState(),
        thread,
        workspace.id,
        project.key,
      ),
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

  async listChannelPolicies(
    workspaceId?: string,
    projectId?: string,
  ): Promise<ChannelAgentPolicy[]> {
    const state = await this.readState();
    const project = projectId && workspaceId
      ? projectKey(workspaceId, projectId)
      : undefined;
    return state.channels
      .filter((item) => !workspaceId || item.workspaceId === workspaceId)
      .filter((item) => !project || item.projectId === project)
      .sort((a, b) =>
        `${a.platform}:${a.channelId}`.localeCompare(
          `${b.platform}:${b.channelId}`,
        ),
      )
      .map(cloneChannelPolicy);
  }

  async listCapabilityBundles(workspaceId?: string): Promise<CapabilityBundle[]> {
    const state = await this.readState();
    return state.capabilityBundles
      .filter((bundle) => !workspaceId || bundle.workspaceId === workspaceId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(cloneCapabilityBundle);
  }

  async upsertCapabilityBundle(
    input: UpsertCapabilityBundleInput,
  ): Promise<CapabilityBundle> {
    return this.mutate((state) => {
      const workspaceId = input.workspaceId.trim();
      const id = capabilityBundleId(input.id);
      const name = input.name.replace(/[\0\r\n]/gu, '').trim();
      if (!workspaceId || !name || name.length > 120) {
        throw new Error('capability_bundle_workspace_name_required');
      }
      if (!state.workspaces.some((item) => item.workspace.id === workspaceId)) {
        throw new Error('capability_bundle_workspace_not_found');
      }
      const existing = state.capabilityBundles.find(
        (bundle) => bundle.workspaceId === workspaceId && bundle.id === id,
      );
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== (existing?.revision ?? 0)
      ) {
        throw new CapabilityBundleRevisionConflictError(existing?.revision ?? 0);
      }
      const timestamp = now();
      const actor = input.actor?.trim() || 'admin';
      const networkBase = existing?.networkPolicy ?? defaultNetworkPolicy();
      const bundle: CapabilityBundle = {
        id,
        workspaceId,
        name,
        description:
          input.description === undefined
            ? existing?.description
            : input.description.replace(/[\0\r\n]/gu, ' ').trim().slice(0, 500) ||
              undefined,
        preset: capabilityBundlePreset(input.preset ?? existing?.preset),
        enabled: input.enabled ?? existing?.enabled ?? true,
        revision: (existing?.revision ?? 0) + 1,
        skillIds: normalizedSkillIds(input.skillIds ?? existing?.skillIds),
        agentIds: normalizedAgentIds(input.agentIds ?? existing?.agentIds),
        knowledgeSourceIds: normalizedKnowledgeSourceIds(
          input.knowledgeSourceIds ?? existing?.knowledgeSourceIds,
        ),
        grants: (input.grants ?? existing?.grants ?? []).map(cloneGrant),
        networkPolicy: {
          mode: input.networkPolicy?.mode ?? networkBase.mode,
          allowedHosts: [
            ...(input.networkPolicy?.allowedHosts ?? networkBase.allowedHosts),
          ],
        },
        createdAt: existing?.createdAt ?? timestamp,
        createdBy: existing?.createdBy ?? actor,
        updatedAt: timestamp,
        updatedBy: actor,
      };
      if (existing) {
        state.capabilityBundles.splice(
          state.capabilityBundles.indexOf(existing),
          1,
          bundle,
        );
      } else {
        state.capabilityBundles.push(bundle);
      }
      state.audit.push({
        id: randomUUID(),
        action: existing
          ? 'capability_bundle.updated'
          : 'capability_bundle.created',
        actor,
        workspaceId,
        at: timestamp,
        snapshot: cloneCapabilityBundle(bundle),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneCapabilityBundle(bundle);
    });
  }

  async setCapabilityBundleEnabled(input: {
    workspaceId: string;
    id: string;
    enabled: boolean;
    expectedRevision?: number;
    actor?: string;
  }): Promise<CapabilityBundle> {
    return this.mutate((state) => {
      const id = capabilityBundleId(input.id);
      const existing = state.capabilityBundles.find(
        (bundle) =>
          bundle.workspaceId === input.workspaceId && bundle.id === id,
      );
      if (!existing) throw new Error('capability_bundle_not_found');
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.revision
      ) {
        throw new CapabilityBundleRevisionConflictError(existing.revision);
      }
      const timestamp = now();
      const actor = input.actor?.trim() || 'admin';
      const bundle: CapabilityBundle = {
        ...cloneCapabilityBundle(existing),
        enabled: input.enabled,
        revision: existing.revision + 1,
        updatedAt: timestamp,
        updatedBy: actor,
      };
      state.capabilityBundles.splice(
        state.capabilityBundles.indexOf(existing),
        1,
        bundle,
      );
      state.audit.push({
        id: randomUUID(),
        action: input.enabled
          ? 'capability_bundle.enabled'
          : 'capability_bundle.disabled',
        actor,
        workspaceId: input.workspaceId,
        at: timestamp,
        snapshot: cloneCapabilityBundle(bundle),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneCapabilityBundle(bundle);
    });
  }

  async removeCapabilityBundle(input: {
    workspaceId: string;
    id: string;
    expectedRevision?: number;
    actor?: string;
  }): Promise<CapabilityBundle | undefined> {
    return this.mutate((state) => {
      const id = capabilityBundleId(input.id);
      const existing = state.capabilityBundles.find(
        (bundle) =>
          bundle.workspaceId === input.workspaceId && bundle.id === id,
      );
      if (!existing) return undefined;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.revision
      ) {
        throw new CapabilityBundleRevisionConflictError(existing.revision);
      }
      const referenced = [
        ...state.workspaces
          .filter((policy) => policy.workspace.id === input.workspaceId)
          .flatMap((policy) => policy.bundleIds),
        ...state.projects
          .filter((policy) => policy.workspaceId === input.workspaceId)
          .flatMap((policy) => policy.bundleIds),
        ...state.channels
          .filter((policy) => policy.workspaceId === input.workspaceId)
          .flatMap((policy) => policy.bundleIds),
      ].includes(id);
      if (referenced) throw new Error('capability_bundle_in_use');
      state.capabilityBundles.splice(state.capabilityBundles.indexOf(existing), 1);
      state.audit.push({
        id: randomUUID(),
        action: 'capability_bundle.removed',
        actor: input.actor?.trim() || 'admin',
        workspaceId: input.workspaceId,
        at: now(),
        snapshot: cloneCapabilityBundle(existing),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneCapabilityBundle(existing);
    });
  }

  async upsertWorkspacePolicy(
    input: UpsertWorkspaceAgentPolicyInput,
  ): Promise<WorkspaceAgentPolicy> {
    return this.mutate((state) => {
      const existing = this.workspacePolicyFor(state, input.workspaceId);
      assertCapabilityBundleIds(
        state,
        input.workspaceId,
        input.bundleIds ?? existing.bundleIds,
      );
      const timestamp = now();
      const networkBase = existing.networkPolicy;
      const policy: WorkspaceAgentPolicy = {
        workspace: {
          ...existing.workspace,
          id: input.workspaceId,
          name: input.name?.trim() || existing.workspace.name,
          defaultProjectId:
            input.defaultProjectId?.trim() ||
            existing.workspace.defaultProjectId,
        },
        identity: {
          ...existing.identity,
          ...input.identity,
          id: input.identity?.id?.trim() || existing.identity.id,
          displayName:
            input.identity?.displayName?.trim() ||
            existing.identity.displayName,
          instructions:
            input.identity?.instructions?.trim() ||
            existing.identity.instructions,
          defaultExecutorId:
            input.identity?.defaultExecutorId?.trim() ||
            existing.identity.defaultExecutorId,
        },
        skillIds: normalizedSkillIds(input.skillIds ?? existing.skillIds),
        agentIds: normalizedAgentIds(input.agentIds ?? existing.agentIds),
        knowledgeSourceIds: normalizedKnowledgeSourceIds(
          input.knowledgeSourceIds ?? existing.knowledgeSourceIds,
        ),
        bundleIds: normalizedBundleIds(input.bundleIds ?? existing.bundleIds),
        grants: (input.grants ?? existing.grants).map(cloneGrant),
        networkPolicy: {
          mode: input.networkPolicy?.mode ?? networkBase.mode,
          allowedHosts: [
            ...(input.networkPolicy?.allowedHosts ?? networkBase.allowedHosts),
          ],
        },
        budgetPolicy:
          input.budgetPolicy === undefined
            ? existing.budgetPolicy
            : { ...input.budgetPolicy },
        defaultChannelBudgetPolicy:
          input.defaultChannelBudgetPolicy === undefined
            ? existing.defaultChannelBudgetPolicy ?? { mode: 'disabled' }
            : { ...input.defaultChannelBudgetPolicy },
        memoryApprovalPolicy:
          input.memoryApprovalPolicy === undefined
            ? cloneMemoryApprovalPolicy(existing.memoryApprovalPolicy)
            : cloneMemoryApprovalPolicy(input.memoryApprovalPolicy),
        memoryRetentionPolicy:
          input.memoryRetentionPolicy === undefined
            ? cloneMemoryRetentionPolicy(
                existing.memoryRetentionPolicy ?? { mode: 'keep' },
              )
            : cloneMemoryRetentionPolicy(input.memoryRetentionPolicy),
        toolApprovalPolicy:
          input.toolApprovalPolicy === undefined
            ? cloneToolApprovalPolicy(
                existing.toolApprovalPolicy ?? {
                  mode: 'require_approval',
                  risks: ['write'],
                },
              )
            : cloneToolApprovalPolicy(input.toolApprovalPolicy),
        createdAt: existing.createdAt,
        updatedAt: timestamp,
      };
      const index = state.workspaces.findIndex(
        (item) => item.workspace.id === input.workspaceId,
      );
      if (index >= 0) state.workspaces.splice(index, 1, policy);
      else state.workspaces.push(policy);
      state.audit.push({
        id: randomUUID(),
        action: 'workspace.updated',
        actor: input.actor?.trim() || 'admin',
        workspaceId: input.workspaceId,
        at: timestamp,
        snapshot: cloneWorkspacePolicy(policy),
      });
      if (state.audit.length > 500) {
        state.audit.splice(0, state.audit.length - 500);
      }
      return cloneWorkspacePolicy(policy);
    });
  }

  async upsertProjectPolicy(
    input: UpsertProjectAgentPolicyInput,
  ): Promise<ProjectAgentPolicy> {
    return this.mutate((state) => {
      const workspacePolicy = this.workspacePolicyFor(state, input.workspaceId);
      const projectId = projectKey(input.workspaceId, input.projectId);
      const existing = this.projectPolicyFor(state, input.workspaceId, projectId);
      assertCapabilityBundleIds(
        state,
        input.workspaceId,
        input.bundleIds ?? existing?.bundleIds ?? [],
      );
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
        agentMode:
          input.agentMode ??
          existing?.agentMode ??
          (input.identity ? 'custom' : ('inherit' as ProjectAgentMode)),
        capabilityMode:
          input.capabilityMode ??
          existing?.capabilityMode ??
          (input.grants || input.networkPolicy
            ? 'custom'
            : ('inherit' as ProjectCapabilityMode)),
        skillIds: normalizedSkillIds(input.skillIds ?? existing?.skillIds),
        agentIds: normalizedAgentIds(input.agentIds ?? existing?.agentIds),
        knowledgeSourceIds: normalizedKnowledgeSourceIds(
          input.knowledgeSourceIds ?? existing?.knowledgeSourceIds,
        ),
        bundleIds: normalizedBundleIds(input.bundleIds ?? existing?.bundleIds),
        grants: (input.grants ?? existing?.grants ?? []).map(cloneGrant),
        networkPolicy: {
          mode: input.networkPolicy?.mode ?? networkBase.mode,
          allowedHosts: [
            ...(input.networkPolicy?.allowedHosts ?? networkBase.allowedHosts),
          ],
        },
        memoryMode: input.memoryMode ?? existing?.memoryMode ?? 'workspace',
        budgetPolicy:
          input.budgetPolicy === undefined
            ? existing?.budgetPolicy ?? { mode: 'inherit' }
            : { ...input.budgetPolicy },
        defaultChannelBudgetPolicy:
          input.defaultChannelBudgetPolicy === undefined
            ? existing?.defaultChannelBudgetPolicy ?? { mode: 'inherit' }
            : { ...input.defaultChannelBudgetPolicy },
        memoryApprovalPolicy:
          input.memoryApprovalPolicy === undefined
            ? cloneMemoryApprovalPolicy(
                existing?.memoryApprovalPolicy ?? { mode: 'inherit' },
              )
            : cloneMemoryApprovalPolicy(input.memoryApprovalPolicy),
        memoryRetentionPolicy:
          input.memoryRetentionPolicy === undefined
            ? cloneMemoryRetentionPolicy(
                existing?.memoryRetentionPolicy ?? { mode: 'inherit' },
              )
            : cloneMemoryRetentionPolicy(input.memoryRetentionPolicy),
        toolApprovalPolicy:
          input.toolApprovalPolicy === undefined
            ? cloneToolApprovalPolicy(
                existing?.toolApprovalPolicy ?? { mode: 'inherit' },
              )
            : cloneToolApprovalPolicy(input.toolApprovalPolicy),
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

  async upsertChannelPolicy(
    input: UpsertChannelAgentPolicyInput,
  ): Promise<ChannelAgentPolicy> {
    return this.mutate((state) => {
      const workspaceId = input.workspaceId.trim();
      const projectId = projectKey(workspaceId, input.projectId);
      const platform = input.platform.trim();
      const channelId = input.channelId.trim();
      if (!workspaceId || !platform || !channelId) {
        throw new Error('channel_policy_route_required');
      }
      if (!this.projectPolicyFor(state, workspaceId, projectId)) {
        throw new Error('channel_policy_project_not_found');
      }
      const existing = state.channels.find(
        (item) =>
          item.workspaceId === workspaceId &&
          item.projectId === projectId &&
          item.platform === platform &&
          item.channelId === channelId,
      );
      assertCapabilityBundleIds(
        state,
        workspaceId,
        input.bundleIds ?? existing?.bundleIds ?? [],
      );
      const timestamp = now();
      const instructionMode =
        input.instructionMode ?? existing?.instructionMode ?? 'inherit';
      const capabilityMode =
        input.capabilityMode ?? existing?.capabilityMode ?? 'inherit';
      const policy: ChannelAgentPolicy = {
        id: channelPolicyId(workspaceId, platform, channelId),
        workspaceId,
        projectId,
        platform,
        channelId,
        title:
          input.title === undefined
            ? existing?.title
            : input.title.trim() || undefined,
        instructionMode,
        instructions:
          instructionMode === 'inherit'
            ? undefined
            : input.instructions === undefined
              ? existing?.instructions
              : input.instructions.trim() || undefined,
        capabilityMode,
        skillIds: normalizedSkillIds(input.skillIds ?? existing?.skillIds),
        agentIds: normalizedAgentIds(input.agentIds ?? existing?.agentIds),
        knowledgeSourceIds: normalizedKnowledgeSourceIds(
          input.knowledgeSourceIds ?? existing?.knowledgeSourceIds,
        ),
        bundleIds:
          capabilityMode === 'inherit'
            ? []
            : normalizedBundleIds(input.bundleIds ?? existing?.bundleIds),
        grants:
          capabilityMode === 'inherit'
            ? []
            : (input.grants ?? existing?.grants ?? []).map(cloneGrant),
        networkPolicy:
          capabilityMode === 'inherit'
            ? defaultNetworkPolicy()
            : {
                mode:
                  input.networkPolicy?.mode ??
                  existing?.networkPolicy.mode ??
                  'deny-by-default',
                allowedHosts: [
                  ...(input.networkPolicy?.allowedHosts ??
                    existing?.networkPolicy.allowedHosts ??
                    []),
                ],
              },
        budgetPolicy:
          input.budgetPolicy === undefined
            ? existing?.budgetPolicy ?? { mode: 'inherit' }
            : { ...input.budgetPolicy },
        memoryApprovalPolicy:
          input.memoryApprovalPolicy === undefined
            ? cloneMemoryApprovalPolicy(
                existing?.memoryApprovalPolicy ?? { mode: 'inherit' },
              )
            : cloneMemoryApprovalPolicy(input.memoryApprovalPolicy),
        toolApprovalPolicy:
          input.toolApprovalPolicy === undefined
            ? cloneToolApprovalPolicy(
                existing?.toolApprovalPolicy ?? { mode: 'inherit' },
              )
            : cloneToolApprovalPolicy(input.toolApprovalPolicy),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (existing) {
        state.channels.splice(state.channels.indexOf(existing), 1, policy);
      } else {
        state.channels.push(policy);
      }
      state.audit.push({
        id: randomUUID(),
        action: existing ? 'channel.updated' : 'channel.created',
        actor: input.actor?.trim() || 'admin',
        workspaceId,
        projectId,
        channelId,
        platform,
        at: timestamp,
        snapshot: cloneChannelPolicy(policy),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneChannelPolicy(policy);
    });
  }

  async removeChannelPolicy(input: {
    workspaceId: string;
    projectId: string;
    platform: string;
    channelId: string;
    actor?: string;
  }): Promise<ChannelAgentPolicy | undefined> {
    return this.mutate((state) => {
      const projectId = projectKey(input.workspaceId, input.projectId);
      const existing = state.channels.find(
        (item) =>
          item.workspaceId === input.workspaceId &&
          item.projectId === projectId &&
          item.platform === input.platform &&
          item.channelId === input.channelId,
      );
      if (!existing) return undefined;
      state.channels.splice(state.channels.indexOf(existing), 1);
      state.audit.push({
        id: randomUUID(),
        action: 'channel.removed',
        actor: input.actor?.trim() || 'admin',
        workspaceId: input.workspaceId,
        projectId,
        channelId: input.channelId,
        platform: input.platform,
        at: now(),
        snapshot: cloneChannelPolicy(existing),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneChannelPolicy(existing);
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
        snapshot:
          'workspace' in item.snapshot
            ? cloneWorkspacePolicy(item.snapshot)
            : 'preset' in item.snapshot
              ? cloneCapabilityBundle(item.snapshot)
            : 'channelId' in item.snapshot
              ? cloneChannelPolicy(item.snapshot)
              : cloneProjectPolicy(item.snapshot),
      }));
  }
}
