import type {
  AccessBundle,
  AgentIdentity,
  MemoryApprovalPolicy,
  MemoryRetentionPolicy,
  Project,
  ToolApprovalPolicy,
  ToolGrant,
  UsageBudgetPolicy,
  Workspace,
} from '@opentag/core';

export type ProjectMemoryMode = 'workspace' | 'isolated';
export type ProjectAgentMode = 'inherit' | 'custom';
export type ProjectCapabilityMode = 'inherit' | 'custom';
export type ChannelInstructionMode = 'inherit' | 'append' | 'replace';
export type ChannelCapabilityMode = 'inherit' | 'extend' | 'custom';
export type CapabilityBundlePreset =
  | 'data-readonly'
  | 'platform-monitoring'
  | 'github-write'
  | 'custom';

/**
 * A reusable, administrator-managed set of capabilities.  This is the
 * persisted counterpart of the per-run AccessBundle in core: projects and
 * channels reference these by id, while the resolver expands them into the
 * immutable access snapshot carried by every run.
 */
export interface CapabilityBundle {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  preset: CapabilityBundlePreset;
  enabled: boolean;
  revision: number;
  skillIds: string[];
  agentIds: string[];
  knowledgeSourceIds: string[];
  grants: ToolGrant[];
  networkPolicy: AccessBundle['networkPolicy'];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface WorkspaceAgentPolicy {
  workspace: Workspace;
  identity: AgentIdentity;
  skillIds: string[];
  agentIds: string[];
  knowledgeSourceIds: string[];
  bundleIds: string[];
  grants: ToolGrant[];
  networkPolicy: AccessBundle['networkPolicy'];
  budgetPolicy?: UsageBudgetPolicy;
  defaultChannelBudgetPolicy?: UsageBudgetPolicy;
  memoryApprovalPolicy?: MemoryApprovalPolicy;
  memoryRetentionPolicy?: MemoryRetentionPolicy;
  toolApprovalPolicy?: ToolApprovalPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAgentPolicy {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  description?: string;
  identity: AgentIdentity;
  agentMode: ProjectAgentMode;
  capabilityMode: ProjectCapabilityMode;
  skillIds: string[];
  agentIds: string[];
  knowledgeSourceIds: string[];
  bundleIds: string[];
  grants: ToolGrant[];
  networkPolicy: AccessBundle['networkPolicy'];
  memoryMode: ProjectMemoryMode;
  budgetPolicy?: UsageBudgetPolicy;
  defaultChannelBudgetPolicy?: UsageBudgetPolicy;
  memoryApprovalPolicy?: MemoryApprovalPolicy;
  memoryRetentionPolicy?: MemoryRetentionPolicy;
  toolApprovalPolicy?: ToolApprovalPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelAgentPolicy {
  id: string;
  workspaceId: string;
  projectId: string;
  platform: string;
  channelId: string;
  title?: string;
  instructionMode: ChannelInstructionMode;
  instructions?: string;
  capabilityMode: ChannelCapabilityMode;
  skillIds: string[];
  agentIds: string[];
  knowledgeSourceIds: string[];
  bundleIds: string[];
  grants: ToolGrant[];
  networkPolicy: AccessBundle['networkPolicy'];
  budgetPolicy?: UsageBudgetPolicy;
  memoryApprovalPolicy?: MemoryApprovalPolicy;
  toolApprovalPolicy?: ToolApprovalPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProjectAgentPolicyInput {
  workspaceId: string;
  projectId: string;
  name?: string;
  description?: string;
  identity?: Partial<AgentIdentity>;
  agentMode?: ProjectAgentMode;
  capabilityMode?: ProjectCapabilityMode;
  skillIds?: string[];
  agentIds?: string[];
  knowledgeSourceIds?: string[];
  bundleIds?: string[];
  grants?: ToolGrant[];
  networkPolicy?: Partial<AccessBundle['networkPolicy']>;
  memoryMode?: ProjectMemoryMode;
  budgetPolicy?: UsageBudgetPolicy;
  defaultChannelBudgetPolicy?: UsageBudgetPolicy;
  memoryApprovalPolicy?: MemoryApprovalPolicy;
  memoryRetentionPolicy?: MemoryRetentionPolicy;
  toolApprovalPolicy?: ToolApprovalPolicy;
  actor?: string;
}

export interface UpsertWorkspaceAgentPolicyInput {
  workspaceId: string;
  name?: string;
  defaultProjectId?: string;
  identity?: Partial<AgentIdentity>;
  skillIds?: string[];
  agentIds?: string[];
  knowledgeSourceIds?: string[];
  bundleIds?: string[];
  grants?: ToolGrant[];
  networkPolicy?: Partial<AccessBundle['networkPolicy']>;
  budgetPolicy?: UsageBudgetPolicy;
  defaultChannelBudgetPolicy?: UsageBudgetPolicy;
  memoryApprovalPolicy?: MemoryApprovalPolicy;
  memoryRetentionPolicy?: MemoryRetentionPolicy;
  toolApprovalPolicy?: ToolApprovalPolicy;
  actor?: string;
}

export interface UpsertChannelAgentPolicyInput {
  workspaceId: string;
  projectId: string;
  platform: string;
  channelId: string;
  title?: string;
  instructionMode?: ChannelInstructionMode;
  instructions?: string;
  capabilityMode?: ChannelCapabilityMode;
  skillIds?: string[];
  agentIds?: string[];
  knowledgeSourceIds?: string[];
  bundleIds?: string[];
  grants?: ToolGrant[];
  networkPolicy?: Partial<AccessBundle['networkPolicy']>;
  budgetPolicy?: UsageBudgetPolicy;
  memoryApprovalPolicy?: MemoryApprovalPolicy;
  toolApprovalPolicy?: ToolApprovalPolicy;
  actor?: string;
}

export interface UpsertCapabilityBundleInput {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  preset?: CapabilityBundlePreset;
  enabled?: boolean;
  expectedRevision?: number;
  skillIds?: string[];
  agentIds?: string[];
  knowledgeSourceIds?: string[];
  grants?: ToolGrant[];
  networkPolicy?: Partial<AccessBundle['networkPolicy']>;
  actor?: string;
}

export interface ConfigAuditRecord {
  id: string;
  action:
    | 'workspace.updated'
    | 'project.created'
    | 'project.updated'
    | 'channel.created'
    | 'channel.updated'
    | 'channel.removed'
    | 'capability_bundle.created'
    | 'capability_bundle.updated'
    | 'capability_bundle.enabled'
    | 'capability_bundle.disabled'
    | 'capability_bundle.removed';
  actor: string;
  workspaceId: string;
  projectId?: string;
  channelId?: string;
  platform?: string;
  at: string;
  snapshot:
    | WorkspaceAgentPolicy
    | ProjectAgentPolicy
    | ChannelAgentPolicy
    | CapabilityBundle;
}

export interface FileConfigState {
  version: 1;
  workspaces: WorkspaceAgentPolicy[];
  projects: ProjectAgentPolicy[];
  channels: ChannelAgentPolicy[];
  capabilityBundles: CapabilityBundle[];
  audit: ConfigAuditRecord[];
}

export interface ResolvedThreadPolicy {
  workspace: Workspace;
  project: Project;
  identity: AgentIdentity;
  access: AccessBundle;
  channelPolicy?: ChannelAgentPolicy;
  configured: boolean;
}
