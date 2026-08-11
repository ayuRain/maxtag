import type {
  PlatformKind,
  ThreadVisibility,
} from '@opentag/core';

export type WorkflowStatus = 'active' | 'archived';
export type WorkflowExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type WorkflowNodeExecutionStatus =
  | 'pending'
  | 'claimed'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface WorkflowManualTrigger {
  kind: 'manual';
}

export interface WorkflowEventTrigger {
  kind: 'event';
  eventType: string;
}

export type WorkflowTrigger = WorkflowManualTrigger | WorkflowEventTrigger;

export interface WorkflowDestination {
  platform: PlatformKind;
  externalId: string;
  channelId?: string;
  threadId?: string;
  rootMessageId?: string;
  topicId?: string;
  visibility: ThreadVisibility;
  title?: string;
}

export interface WorkflowNode {
  id: string;
  name?: string;
  instructions: string;
  dependsOn?: string[];
  publish?: boolean;
}

export interface Workflow {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  description?: string;
  enabled: boolean;
  status: WorkflowStatus;
  version: number;
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  destination: WorkflowDestination;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  archivedAt?: string;
}

export interface WorkflowNodeExecution {
  id: string;
  nodeId: string;
  status: WorkflowNodeExecutionStatus;
  attempts: number;
  claimerId?: string;
  claimedAt?: string;
  runId?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowExecutionTrigger {
  kind: 'manual' | 'event';
  actor?: string;
  eventType?: string;
  eventId?: string;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflow: Workflow;
  workflowVersion: number;
  dedupKey: string;
  trigger: WorkflowExecutionTrigger;
  input?: Record<string, unknown>;
  status: WorkflowExecutionStatus;
  nodes: WorkflowNodeExecution[];
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowAuditAction =
  | 'workflow.created'
  | 'workflow.updated'
  | 'workflow.archived'
  | 'workflow.triggered';

export interface WorkflowAuditRecord {
  id: string;
  action: WorkflowAuditAction;
  workflowId: string;
  workspaceId: string;
  projectId: string;
  actor: string;
  at: string;
  snapshot: Workflow;
}

export interface WorkflowState {
  version: 1;
  workflows: Workflow[];
  executions: WorkflowExecution[];
  audit: WorkflowAuditRecord[];
}

export interface UpsertWorkflowInput {
  id?: string;
  workspaceId: string;
  projectId: string;
  name: string;
  description?: string;
  enabled?: boolean;
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  destination: WorkflowDestination;
  actor?: string;
}

export interface WorkflowListFilter {
  workspaceId?: string;
  projectId?: string;
  includeArchived?: boolean;
}

export interface WorkflowExecutionFilter {
  workflowId?: string;
  workspaceId?: string;
  projectId?: string;
  status?: WorkflowExecutionStatus;
  limit?: number;
}

export interface WorkflowAuditFilter {
  workspaceId?: string;
  projectId?: string;
  limit?: number;
}

export interface WorkflowEventInput {
  workspaceId: string;
  projectId: string;
  eventType: string;
  eventId: string;
  payload?: Record<string, unknown>;
  actor?: string;
}

export interface WorkflowEventStageResult {
  matched: number;
  staged: WorkflowExecution[];
  duplicates: WorkflowExecution[];
}

export interface WorkflowNodeClaim {
  workflow: Workflow;
  execution: WorkflowExecution;
  node: WorkflowNode;
  nodeExecution: WorkflowNodeExecution;
  upstream: Array<{
    nodeId: string;
    summary: string;
  }>;
  publish: boolean;
}

export interface WorkflowSummary {
  workflows: {
    enabled: number;
    disabled: number;
  };
  executions: Record<WorkflowExecutionStatus, number>;
  nodes: Record<WorkflowNodeExecutionStatus, number>;
}
