import type {
  PlatformKind,
  ThreadVisibility,
} from '@opentag/core';

export type WorkflowStatus = 'active' | 'archived';
export type WorkflowProducerKind = 'alertmanager' | 'lark-document';
export type WorkflowProducerRouteStatus = 'active' | 'archived';
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
  retryCount?: number;
  claimerId?: string;
  claimedAt?: string;
  runId?: string;
  runIds?: string[];
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
  producer?: string;
  sourceExternalId?: string;
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
  | 'workflow.triggered'
  | 'workflow.event.staged'
  | 'workflow.execution.cancelled'
  | 'workflow.node.retried';

export interface WorkflowAuditRecord {
  id: string;
  action: WorkflowAuditAction;
  workflowId: string;
  workspaceId: string;
  projectId: string;
  actor: string;
  at: string;
  snapshot: Workflow;
  executionId?: string;
  eventType?: string;
  eventId?: string;
  producer?: string;
  sourceExternalId?: string;
  nodeId?: string;
  attempt?: number;
  reason?: string;
}

export interface WorkflowProducerRoute {
  id: string;
  kind: WorkflowProducerKind;
  workspaceId: string;
  projectId: string;
  name: string;
  documentId?: string;
  pollIntervalSeconds?: number;
  enabled: boolean;
  status: WorkflowProducerRouteStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  archivedAt?: string;
}

export interface WorkflowProducerRuntime {
  routeId: string;
  lastRevisionId?: number;
  lastContentHash?: string;
  lastTitle?: string;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastChangedAt?: string;
  nextPollAt?: string;
  failureCount: number;
  lastError?: string;
  claimerId?: string;
  claimedAt?: string;
}

export interface WorkflowProducerClaim {
  route: WorkflowProducerRoute;
  runtime: WorkflowProducerRuntime;
}

export interface CompleteWorkflowProducerPollInput {
  routeId: string;
  claimerId: string;
  revisionId: number;
  contentHash?: string;
  title?: string;
  changed?: boolean;
}

export interface FailWorkflowProducerPollInput {
  routeId: string;
  claimerId: string;
  error: string;
}

export type WorkflowProducerAuditAction =
  | 'workflow.producer.created'
  | 'workflow.producer.updated'
  | 'workflow.producer.archived';

export interface WorkflowProducerAuditRecord {
  id: string;
  action: WorkflowProducerAuditAction;
  routeId: string;
  workspaceId: string;
  projectId: string;
  actor: string;
  at: string;
  snapshot: WorkflowProducerRoute;
}

export interface CancelWorkflowExecutionResult {
  execution: WorkflowExecution;
  changed: boolean;
  activeRunIds: string[];
}

export interface RetryWorkflowNodeResult {
  execution: WorkflowExecution;
  node: WorkflowNodeExecution;
  resetNodeIds: string[];
  nextAttempt: number;
}

export interface WorkflowState {
  version: 1;
  workflows: Workflow[];
  executions: WorkflowExecution[];
  audit: WorkflowAuditRecord[];
  producerRoutes: WorkflowProducerRoute[];
  producerRuntime: WorkflowProducerRuntime[];
  producerAudit: WorkflowProducerAuditRecord[];
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

export interface UpsertWorkflowProducerRouteInput {
  id?: string;
  kind: WorkflowProducerKind;
  workspaceId: string;
  projectId: string;
  name: string;
  documentId?: string;
  pollIntervalSeconds?: number;
  enabled?: boolean;
  actor?: string;
}

export interface WorkflowProducerRouteFilter {
  workspaceId?: string;
  projectId?: string;
  kind?: WorkflowProducerKind;
  includeArchived?: boolean;
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
  producer?: string;
  sourceExternalId?: string;
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
  producerRoutes: {
    enabled: number;
    disabled: number;
  };
  producerRuntime: {
    ready: number;
    pending: number;
    error: number;
    claimed: number;
  };
  workflows: {
    enabled: number;
    disabled: number;
  };
  executions: Record<WorkflowExecutionStatus, number>;
  nodes: Record<WorkflowNodeExecutionStatus, number>;
  oldestExecutionUpdatedAt: Partial<Record<WorkflowExecutionStatus, string>>;
  oldestNodeUpdatedAt: Partial<Record<WorkflowNodeExecutionStatus, string>>;
  queues: WorkflowQueueHealth[];
}

export interface WorkflowQueueHealth {
  workflowId: string;
  workflowName: string;
  enabled: boolean;
  activeExecutions: number;
  queuedNodes: number;
  runningNodes: number;
  failedExecutions: number;
  failedNodes: number;
  oldestActiveUpdatedAt?: string;
  latestExecutionUpdatedAt?: string;
  latestExecutionStatus?: WorkflowExecutionStatus;
}
