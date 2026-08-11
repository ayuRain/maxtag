import type { PlatformKind, ThreadVisibility } from '@opentag/core';

export type RoutineSchedule =
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

export interface Routine {
  id: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  instructions: string;
  enabled: boolean;
  schedule: RoutineSchedule;
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

export interface RoutineAuditFilter {
  workspaceId?: string;
  projectId?: string;
  limit?: number;
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
  nextRunAt?: string;
}
