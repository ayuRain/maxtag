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

export interface WorkspaceAgentPolicy {
  workspace: Workspace;
  identity: AgentIdentity;
  skillIds: string[];
  agentIds: string[];
  knowledgeSourceIds: string[];
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
  grants?: ToolGrant[];
  networkPolicy?: Partial<AccessBundle['networkPolicy']>;
  budgetPolicy?: UsageBudgetPolicy;
  memoryApprovalPolicy?: MemoryApprovalPolicy;
  toolApprovalPolicy?: ToolApprovalPolicy;
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
    | 'channel.removed';
  actor: string;
  workspaceId: string;
  projectId?: string;
  channelId?: string;
  platform?: string;
  at: string;
  snapshot: WorkspaceAgentPolicy | ProjectAgentPolicy | ChannelAgentPolicy;
}

export interface FileConfigState {
  version: 1;
  workspaces: WorkspaceAgentPolicy[];
  projects: ProjectAgentPolicy[];
  channels: ChannelAgentPolicy[];
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
