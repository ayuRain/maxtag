import type { PlatformKind, ThreadVisibility } from '@opentag/core';

export type RoutineSchedule =
  | {
      kind: 'once';
      at: string;
    }
  | {
      kind: 'interval';
      everyMinutes: number;
    }
  | {
      kind: 'daily';
      time: string;
      timeZone: string;
    };

export interface RoutineDestination {
  platform: PlatformKind;
  externalId: string;
  channelId?: string;
  threadId?: string;
  rootMessageId?: string;
  topicId?: string;
  visibility: ThreadVisibility;
  title?: string;
}

export type RoutineNotificationMode =
  | 'every_result'
  | 'failures_only'
  | 'silent';

export interface RoutineNotificationPolicy {
  mode: RoutineNotificationMode;
  failureThreshold: number;
  recovery: boolean;
}

export interface Routine {
  id: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  instructions: string;
  enabled: boolean;
  schedule: RoutineSchedule;
  notifications: RoutineNotificationPolicy;
  destination: RoutineDestination;
  nextRunAt?: string;
  lastScheduledAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  deletedAt?: string;
}

export type RoutineExecutionTrigger = 'scheduled' | 'manual';

export type RoutineExecutionStatus =
  | 'pending'
  | 'claimed'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RoutineExecution {
  id: string;
  routineId: string;
  routine: Routine;
  trigger: RoutineExecutionTrigger;
  dedupKey: string;
  scheduledFor: string;
  status: RoutineExecutionStatus;
  attempts: number;
  claimerId?: string;
  claimedAt?: string;
  runId?: string;
  summary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RoutineExecutionDigest {
  id: string;
  status: RoutineExecutionStatus;
  trigger: RoutineExecutionTrigger;
  scheduledFor: string;
  attempts: number;
  runId?: string;
  summary?: string;
  error?: string;
  updatedAt: string;
  completedAt?: string;
}

export type RoutineNotificationKind = 'failure' | 'recovery';

export type RoutineNotificationStatus =
  | 'pending'
  | 'claimed'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface RoutineNotification {
  id: string;
  routineId: string;
  executionId: string;
  routine: Routine;
  runId?: string;
  kind: RoutineNotificationKind;
  status: RoutineNotificationStatus;
  consecutiveFailures: number;
  message: string;
  attempts: number;
  nextAttemptAt: string;
  claimerId?: string;
  claimedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

export interface RoutineAuditRecord {
  id: string;
  action:
    | 'routine.created'
    | 'routine.updated'
    | 'routine.deleted'
    | 'routine.triggered';
  routineId: string;
  workspaceId: string;
  projectId?: string;
  actor: string;
  at: string;
  snapshot: Routine;
}

export interface RoutineState {
  version: 1;
  routines: Routine[];
  executions: RoutineExecution[];
  notifications: RoutineNotification[];
  audit: RoutineAuditRecord[];
}

export interface UpsertRoutineInput {
  id?: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  instructions: string;
  enabled?: boolean;
  schedule: RoutineSchedule;
  notifications?: Partial<RoutineNotificationPolicy>;
  destination: RoutineDestination;
  actor?: string;
}

export interface RoutineListFilter {
  workspaceId?: string;
  projectId?: string;
  includeDeleted?: boolean;
}

export interface RoutineExecutionFilter {
  routineId?: string;
  workspaceId?: string;
  projectId?: string;
  status?: RoutineExecutionStatus;
  limit?: number;
}

export interface RoutineExecutionDigestInput {
  routines: Routine[];
  limitPerRoutine?: number;
}

export interface RoutineAuditFilter {
  workspaceId?: string;
  projectId?: string;
  limit?: number;
}

export interface RoutineNotificationFilter {
  routineId?: string;
  workspaceId?: string;
  projectId?: string;
  status?: RoutineNotificationStatus;
  limit?: number;
}

export interface RoutineNotificationClaim {
  notification: RoutineNotification;
}

export interface RoutineClaim {
  routine: Routine;
  execution: RoutineExecution;
}

export interface RoutineSummary {
  routines: {
    enabled: number;
    disabled: number;
  };
  executions: Record<RoutineExecutionStatus, number>;
  notifications: Record<RoutineNotificationStatus, number>;
  oldestExecutionUpdatedAt: Partial<Record<RoutineExecutionStatus, string>>;
  nextRunAt?: string;
}
