import type {
  AccessBundle,
  AgentIdentity,
  Project,
  ToolGrant,
  Workspace,
} from '@opentag/core';

export type ProjectMemoryMode = 'workspace' | 'isolated';
export type ProjectAgentMode = 'inherit' | 'custom';
export type ProjectCapabilityMode = 'inherit' | 'custom';

export interface WorkspaceAgentPolicy {
  workspace: Workspace;
  identity: AgentIdentity;
  grants: ToolGrant[];
  networkPolicy: AccessBundle['networkPolicy'];
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
  grants: ToolGrant[];
  networkPolicy: AccessBundle['networkPolicy'];
  memoryMode: ProjectMemoryMode;
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
  grants?: ToolGrant[];
  networkPolicy?: Partial<AccessBundle['networkPolicy']>;
  memoryMode?: ProjectMemoryMode;
  actor?: string;
}

export interface UpsertWorkspaceAgentPolicyInput {
  workspaceId: string;
  name?: string;
  defaultProjectId?: string;
  identity?: Partial<AgentIdentity>;
  grants?: ToolGrant[];
  networkPolicy?: Partial<AccessBundle['networkPolicy']>;
  actor?: string;
}

export interface ConfigAuditRecord {
  id: string;
  action: 'workspace.updated' | 'project.created' | 'project.updated';
  actor: string;
  workspaceId: string;
  projectId?: string;
  at: string;
  snapshot: WorkspaceAgentPolicy | ProjectAgentPolicy;
}

export interface FileConfigState {
  version: 1;
  workspaces: WorkspaceAgentPolicy[];
  projects: ProjectAgentPolicy[];
  audit: ConfigAuditRecord[];
}

export interface ResolvedThreadPolicy {
  workspace: Workspace;
  project: Project;
  identity: AgentIdentity;
  access: AccessBundle;
  configured: boolean;
}
