import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nextRoutineRunAt, normalizeRoutineSchedule } from './schedule.js';
import type {
  Routine,
  RoutineAuditFilter,
  RoutineAuditRecord,
  RoutineClaim,
  RoutineExecution,
  RoutineExecutionDigest,
  RoutineExecutionDigestInput,
  RoutineExecutionFilter,
  RoutineExecutionStatus,
  RoutineListFilter,
  RoutineNotification,
  RoutineNotificationClaim,
  RoutineNotificationFilter,
  RoutineNotificationPolicy,
  RoutineNotificationStatus,
  RoutineState,
  RoutineSummary,
  UpsertRoutineInput,
} from './types.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function iso(value: Date): string {
  return value.toISOString();
}

export function createEmptyRoutineState(): RoutineState {
  return { version: 1, routines: [], executions: [], notifications: [], audit: [] };
}

export function normalizeRoutineNotificationPolicy(
  input: Partial<RoutineNotificationPolicy> | undefined,
): RoutineNotificationPolicy {
  const mode =
    input?.mode === 'failures_only' || input?.mode === 'silent'
      ? input.mode
      : 'every_result';
  const rawThreshold = Number(input?.failureThreshold ?? 1);
  return {
    mode,
    failureThreshold: Number.isInteger(rawThreshold)
      ? Math.max(1, Math.min(rawThreshold, 10))
      : 1,
    recovery: input?.recovery !== false,
  };
}

function normalizeRoutine(routine: Routine): Routine {
  return {
    ...routine,
    notifications: normalizeRoutineNotificationPolicy(routine.notifications),
  };
}

export function normalizeRoutineState(
  input: Partial<RoutineState> | Record<string, unknown>,
): RoutineState {
  return {
    version: 1,
    routines: Array.isArray(input.routines)
      ? (input.routines as Routine[]).map(normalizeRoutine)
      : [],
    executions: Array.isArray(input.executions)
      ? (input.executions as RoutineExecution[]).map((execution) => ({
          ...execution,
          routine: normalizeRoutine(execution.routine),
        }))
      : [],
    notifications: Array.isArray(input.notifications)
      ? (input.notifications as RoutineNotification[]).map((notification) => ({
          ...notification,
          routine: normalizeRoutine(notification.routine),
        }))
      : [],
    audit: Array.isArray(input.audit)
      ? (input.audit as RoutineAuditRecord[])
      : [],
  };
}

export function trimRoutineState(state: RoutineState): void {
  if (state.executions.length > 2_000) {
    state.executions.splice(0, state.executions.length - 2_000);
  }
  if (state.audit.length > 500) {
    state.audit.splice(0, state.audit.length - 500);
  }
  if (state.notifications.length > 1_000) {
    const removable = state.notifications
      .map((notification, index) => ({ notification, index }))
      .filter(({ notification }) =>
        notification.status === 'delivered' || notification.status === 'failed',
      )
      .sort((left, right) =>
        left.notification.createdAt.localeCompare(right.notification.createdAt),
      );
    const remove = new Set(
      removable
        .slice(0, state.notifications.length - 1_000)
        .map(({ index }) => index),
    );
    state.notifications = state.notifications.filter((_, index) => !remove.has(index));
  }
}

function executionCounts(): Record<RoutineExecutionStatus, number> {
  return {
    pending: 0,
    claimed: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

function notificationCounts(): Record<RoutineNotificationStatus, number> {
  return { pending: 0, claimed: 0, delivered: 0, failed: 0, cancelled: 0 };
}

function recordOldestExecution(
  target: Partial<Record<RoutineExecutionStatus, string>>,
  execution: RoutineExecution,
): void {
  const current = target[execution.status];
  if (!current || execution.updatedAt < current) {
    target[execution.status] = execution.updatedAt;
  }
}

function scheduleChanged(left: Routine, right: UpsertRoutineInput): boolean {
  return JSON.stringify(left.schedule) !== JSON.stringify(right.schedule);
}

function boundedExecutionText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, 300) : undefined;
}

function executionDigest(execution: RoutineExecution): RoutineExecutionDigest {
  return {
    id: execution.id,
    status: execution.status,
    trigger: execution.trigger,
    scheduledFor: execution.scheduledFor,
    attempts: execution.attempts,
    runId: execution.runId,
    summary: boundedExecutionText(execution.summary),
    error: boundedExecutionText(execution.error),
    updatedAt: execution.updatedAt,
    completedAt: execution.completedAt,
  };
}

function sameExecutionRoute(execution: RoutineExecution, routine: Routine): boolean {
  const left = execution.routine.destination;
  const right = routine.destination;
  return (
    execution.routine.workspaceId === routine.workspaceId &&
    execution.routine.projectId === routine.projectId &&
    left.platform === right.platform &&
    left.externalId === right.externalId &&
    left.channelId === right.channelId &&
    left.threadId === right.threadId &&
    left.rootMessageId === right.rootMessageId &&
    left.topicId === right.topicId &&
    left.visibility === right.visibility
  );
}

function sameRoutineRoute(left: Routine, right: Routine): boolean {
  const leftDestination = left.destination;
  const rightDestination = right.destination;
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    leftDestination.platform === rightDestination.platform &&
    leftDestination.externalId === rightDestination.externalId &&
    leftDestination.channelId === rightDestination.channelId &&
    leftDestination.threadId === rightDestination.threadId &&
    leftDestination.rootMessageId === rightDestination.rootMessageId &&
    leftDestination.topicId === rightDestination.topicId &&
    leftDestination.visibility === rightDestination.visibility
  );
}

function sameIncidentPolicy(left: Routine, right: Routine): boolean {
  return (
    sameRoutineRoute(left, right) &&
    left.notifications.mode === right.notifications.mode &&
    left.notifications.failureThreshold === right.notifications.failureThreshold &&
    left.notifications.recovery === right.notifications.recovery
  );
}

function terminalExecution(execution: RoutineExecution): boolean {
  return (
    execution.status === 'completed' ||
    execution.status === 'failed' ||
    execution.status === 'cancelled'
  );
}

function consecutiveFailuresBefore(
  state: RoutineState,
  execution: RoutineExecution,
): number {
  const executionIndex = state.executions.findIndex(
    (candidate) => candidate.id === execution.id,
  );
  const ordered = state.executions
    .slice(0, executionIndex < 0 ? state.executions.length : executionIndex)
    .filter(
      (candidate) =>
        candidate.routineId === execution.routineId &&
        terminalExecution(candidate) &&
        sameIncidentPolicy(candidate.routine, execution.routine),
    )
    .reverse();
  let failures = 0;
  for (const candidate of ordered) {
    if (candidate.status !== 'failed') break;
    failures += 1;
  }
  return failures;
}

function notificationMessage(input: {
  execution: RoutineExecution;
  kind: 'failure' | 'recovery';
  consecutiveFailures: number;
}): string {
  const { execution, kind, consecutiveFailures } = input;
  const heading =
    kind === 'failure'
      ? `Standing work alert: ${execution.routine.name}`
      : `Standing work recovered: ${execution.routine.name}`;
  const detail =
    kind === 'failure'
      ? `Failed ${consecutiveFailures} consecutive run${consecutiveFailures === 1 ? '' : 's'}.`
      : `Recovered after ${consecutiveFailures} consecutive failure${consecutiveFailures === 1 ? '' : 's'}.`;
  const latest = boundedExecutionText(
    kind === 'failure' ? execution.error : execution.summary,
  );
  return [
    heading,
    detail,
    latest ? `Latest: ${latest}` : undefined,
    `Scheduled: ${execution.scheduledFor}`,
    `Routine ID: ${execution.routineId.slice(0, 8)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function maybeCreateNotification(
  state: RoutineState,
  execution: RoutineExecution,
  at: string,
): void {
  const policy = execution.routine.notifications;
  if (policy.mode !== 'failures_only') return;
  const previousFailures = consecutiveFailuresBefore(state, execution);
  let kind: 'failure' | 'recovery' | undefined;
  let consecutiveFailures = previousFailures;
  if (
    execution.status === 'failed' &&
    previousFailures + 1 === policy.failureThreshold
  ) {
    kind = 'failure';
    consecutiveFailures = previousFailures + 1;
  } else if (
    execution.status === 'completed' &&
    policy.recovery &&
    previousFailures >= policy.failureThreshold
  ) {
    kind = 'recovery';
  }
  if (!kind) return;
  const id = `${kind}:${execution.id}`;
  if (state.notifications.some((notification) => notification.id === id)) return;
  state.notifications.push({
    id,
    routineId: execution.routineId,
    executionId: execution.id,
    routine: clone(execution.routine),
    runId: execution.runId,
    kind,
    status: 'pending',
    consecutiveFailures,
    message: notificationMessage({ execution, kind, consecutiveFailures }),
    attempts: 0,
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

function cancelPendingExecutions(
  state: RoutineState,
  routineId: string,
  reason: string,
  at: string,
): void {
  for (const execution of state.executions) {
    if (
      execution.routineId === routineId &&
      (execution.status === 'pending' || execution.status === 'claimed')
    ) {
      execution.status = 'cancelled';
      execution.error = reason;
      execution.completedAt = at;
      execution.updatedAt = at;
    }
  }
}

function cancelPendingNotifications(
  state: RoutineState,
  routineId: string,
  reason: string,
  at: string,
): void {
  for (const notification of state.notifications) {
    if (
      notification.routineId === routineId &&
      (notification.status === 'pending' || notification.status === 'claimed')
    ) {
      notification.status = 'cancelled';
      notification.lastError = reason;
      notification.updatedAt = at;
    }
  }
}

export class FileRoutineStore {
  private readonly stateFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'routine-state.json');
  }

  private async load(): Promise<RoutineState> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as Partial<RoutineState>;
      return normalizeRoutineState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createEmptyRoutineState();
      }
      throw error;
    }
  }

  private async save(state: RoutineState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporary, this.stateFile);
  }

  protected async readState(): Promise<RoutineState> {
    await this.mutationQueue;
    return this.load();
  }

  protected async mutate<T>(operation: (state: RoutineState) => T): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = operation(state);
      trimRoutineState(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async listRoutines(filter: RoutineListFilter = {}): Promise<Routine[]> {
    const state = await this.readState();
    return state.routines
      .filter(
        (routine) =>
          (!filter.workspaceId || routine.workspaceId === filter.workspaceId) &&
          (!filter.projectId || routine.projectId === filter.projectId) &&
          (filter.includeDeleted || !routine.deletedAt),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(clone);
  }

  async getRoutine(id: string): Promise<Routine | undefined> {
    const state = await this.readState();
    const routine = state.routines.find((item) => item.id === id);
    return routine ? clone(routine) : undefined;
  }

  async upsertRoutine(
    input: UpsertRoutineInput,
    at = new Date(),
  ): Promise<Routine> {
    const schedule = normalizeRoutineSchedule(input.schedule);
    const name = input.name.trim();
    const instructions = input.instructions.trim();
    const externalId = input.destination.externalId.trim();
    if (!input.workspaceId.trim()) throw new Error('routine_workspace_required');
    if (!name) throw new Error('routine_name_required');
    if (!instructions) throw new Error('routine_instructions_required');
    if (!externalId) throw new Error('routine_destination_required');
    const timestamp = iso(at);

    return this.mutate((state) => {
      const existing = input.id
        ? state.routines.find((item) => item.id === input.id && !item.deletedAt)
        : undefined;
      if (input.id && !existing) throw new Error('routine_not_found');
      const enabled = input.enabled ?? existing?.enabled ?? true;
      if (
        enabled &&
        schedule.kind === 'once' &&
        Date.parse(schedule.at) <= at.getTime()
      ) {
        throw new Error('routine_once_at_must_be_in_future');
      }
      const actor = input.actor?.trim() || 'admin';
      const routine: Routine = {
        id: existing?.id ?? input.id ?? randomUUID(),
        workspaceId: input.workspaceId.trim(),
        projectId: input.projectId?.trim() || undefined,
        name,
        instructions,
        enabled,
        schedule,
        notifications: normalizeRoutineNotificationPolicy(
          input.notifications ?? existing?.notifications,
        ),
        destination: {
          platform: input.destination.platform,
          externalId,
          channelId: input.destination.channelId?.trim() || undefined,
          threadId: input.destination.threadId?.trim() || undefined,
          rootMessageId:
            input.destination.rootMessageId?.trim() || undefined,
          topicId: input.destination.topicId?.trim() || undefined,
          visibility: input.destination.visibility,
          title: input.destination.title?.trim() || undefined,
        },
        nextRunAt: enabled
          ? existing?.enabled &&
            existing.nextRunAt &&
            !scheduleChanged(existing, { ...input, schedule })
            ? existing.nextRunAt
            : iso(nextRoutineRunAt(schedule, at))
          : undefined,
        lastScheduledAt: existing?.lastScheduledAt,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        createdBy: existing?.createdBy ?? actor,
        updatedBy: actor,
      };
      if (existing) {
        state.routines.splice(state.routines.indexOf(existing), 1, routine);
      } else {
        state.routines.push(routine);
      }
      if (existing && !sameIncidentPolicy(existing, routine)) {
        cancelPendingNotifications(
          state,
          routine.id,
          'routine_route_or_notification_policy_changed',
          timestamp,
        );
      }
      if (!enabled) {
        cancelPendingExecutions(
          state,
          routine.id,
          'routine_disabled',
          timestamp,
        );
        cancelPendingNotifications(
          state,
          routine.id,
          'routine_disabled',
          timestamp,
        );
      }
      const audit: RoutineAuditRecord = {
        id: randomUUID(),
        action: existing ? 'routine.updated' : 'routine.created',
        routineId: routine.id,
        workspaceId: routine.workspaceId,
        projectId: routine.projectId,
        actor,
        at: timestamp,
        snapshot: clone(routine),
      };
      state.audit.push(audit);
      return clone(routine);
    });
  }

  async setRoutineEnabled(
    id: string,
    enabled: boolean,
    actor = 'admin',
    at = new Date(),
  ): Promise<Routine | undefined> {
    return this.mutate((state) => {
      const routine = state.routines.find(
        (item) => item.id === id && !item.deletedAt,
      );
      if (!routine) return undefined;
      if (routine.enabled === enabled) return clone(routine);
      if (
        enabled &&
        routine.schedule.kind === 'once' &&
        Date.parse(routine.schedule.at) <= at.getTime()
      ) {
        throw new Error('routine_once_already_elapsed');
      }
      const timestamp = iso(at);
      routine.enabled = enabled;
      routine.nextRunAt = enabled
        ? iso(nextRoutineRunAt(routine.schedule, at))
        : undefined;
      routine.updatedAt = timestamp;
      routine.updatedBy = actor.trim() || 'admin';
      if (!enabled) {
        cancelPendingExecutions(
          state,
          routine.id,
          'routine_disabled',
          timestamp,
        );
        cancelPendingNotifications(
          state,
          routine.id,
          'routine_disabled',
          timestamp,
        );
      }
      state.audit.push({
        id: randomUUID(),
        action: 'routine.updated',
        routineId: routine.id,
        workspaceId: routine.workspaceId,
        projectId: routine.projectId,
        actor: routine.updatedBy,
        at: timestamp,
        snapshot: clone(routine),
      });
      return clone(routine);
    });
  }

  async deleteRoutine(
    id: string,
    actor = 'admin',
    at = new Date(),
  ): Promise<Routine | undefined> {
    return this.mutate((state) => {
      const routine = state.routines.find((item) => item.id === id && !item.deletedAt);
      if (!routine) return undefined;
      const timestamp = iso(at);
      routine.enabled = false;
      routine.nextRunAt = undefined;
      routine.updatedAt = timestamp;
      routine.updatedBy = actor.trim() || 'admin';
      routine.deletedAt = timestamp;
      cancelPendingExecutions(state, id, 'routine_deleted', timestamp);
      cancelPendingNotifications(state, id, 'routine_deleted', timestamp);
      state.audit.push({
        id: randomUUID(),
        action: 'routine.deleted',
        routineId: routine.id,
        workspaceId: routine.workspaceId,
        projectId: routine.projectId,
        actor,
        at: timestamp,
        snapshot: clone(routine),
      });
      return clone(routine);
    });
  }

  async stageDue(at = new Date(), limit = 50): Promise<RoutineExecution[]> {
    return this.mutate((state) => {
      const timestamp = iso(at);
      const due = state.routines
        .filter(
          (routine) =>
            routine.enabled &&
            !routine.deletedAt &&
            routine.nextRunAt &&
            routine.nextRunAt <= timestamp,
        )
        .sort((left, right) =>
          String(left.nextRunAt).localeCompare(String(right.nextRunAt)),
        )
        .slice(0, Math.max(1, Math.min(limit, 200)));
      const staged: RoutineExecution[] = [];
      for (const routine of due) {
        const scheduledFor = routine.nextRunAt as string;
        const dedupKey = `scheduled:${routine.id}:${scheduledFor}`;
        const existing = state.executions.find(
          (execution) => execution.dedupKey === dedupKey,
        );
        if (!existing) {
          const execution: RoutineExecution = {
            id: randomUUID(),
            routineId: routine.id,
            routine: clone(routine),
            trigger: 'scheduled',
            dedupKey,
            scheduledFor,
            status: 'pending',
            attempts: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          state.executions.push(execution);
          staged.push(clone(execution));
        }
        routine.lastScheduledAt = scheduledFor;
        if (routine.schedule.kind === 'once') {
          routine.enabled = false;
          routine.nextRunAt = undefined;
        } else {
          routine.nextRunAt = iso(nextRoutineRunAt(routine.schedule, at));
        }
        routine.updatedAt = timestamp;
      }
      return staged;
    });
  }

  async triggerRoutine(
    id: string,
    actor = 'admin',
    at = new Date(),
  ): Promise<RoutineExecution> {
    return this.mutate((state) => {
      const routine = state.routines.find((item) => item.id === id && !item.deletedAt);
      if (!routine) throw new Error('routine_not_found');
      const timestamp = iso(at);
      const execution: RoutineExecution = {
        id: randomUUID(),
        routineId: routine.id,
        routine: clone(routine),
        trigger: 'manual',
        dedupKey: `manual:${routine.id}:${randomUUID()}`,
        scheduledFor: timestamp,
        status: 'pending',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.executions.push(execution);
      state.audit.push({
        id: randomUUID(),
        action: 'routine.triggered',
        routineId: routine.id,
        workspaceId: routine.workspaceId,
        projectId: routine.projectId,
        actor,
        at: timestamp,
        snapshot: clone(routine),
      });
      return clone(execution);
    });
  }

  async claimExecutions(input: {
    claimerId: string;
    limit?: number;
    staleAfterMs?: number;
    at?: Date;
  }): Promise<RoutineClaim[]> {
    return this.mutate((state) => {
      const at = input.at ?? new Date();
      const timestamp = iso(at);
      const staleBefore = new Date(
        at.getTime() - (input.staleAfterMs ?? 120_000),
      ).toISOString();
      const eligible = state.executions
        .filter(
          (execution) =>
            execution.status === 'pending' ||
            (execution.status === 'claimed' &&
              Boolean(execution.claimedAt && execution.claimedAt <= staleBefore)),
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, Math.max(1, Math.min(input.limit ?? 20, 100)));
      return eligible.map((execution) => {
        execution.status = 'claimed';
        execution.claimerId = input.claimerId;
        execution.claimedAt = timestamp;
        execution.attempts += 1;
        execution.updatedAt = timestamp;
        return {
          routine: clone(execution.routine),
          execution: clone(execution),
        };
      });
    });
  }

  async markExecutionQueued(
    id: string,
    runId: string,
    at = new Date(),
  ): Promise<RoutineExecution | undefined> {
    return this.updateExecution(id, at, (execution) => {
      execution.status = 'queued';
      execution.runId = runId;
      execution.error = undefined;
    });
  }

  async markExecutionFailed(
    id: string,
    error: string,
    at = new Date(),
  ): Promise<RoutineExecution | undefined> {
    return this.mutate((state) => {
      const execution = state.executions.find((item) => item.id === id);
      if (!execution) return undefined;
      const timestamp = iso(at);
      execution.status = 'failed';
      execution.error = error.slice(0, 2_000);
      execution.completedAt = timestamp;
      execution.updatedAt = timestamp;
      maybeCreateNotification(state, execution, timestamp);
      return clone(execution);
    });
  }

  async reconcileRun(input: {
    runId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    summary?: string;
    error?: string;
    at?: Date;
  }): Promise<RoutineExecution | undefined> {
    const mapped: RoutineExecutionStatus = input.status;
    return this.mutate((state) => {
      const execution = state.executions.find(
        (item) => item.runId === input.runId,
      );
      if (!execution) return undefined;
      const at = input.at ?? new Date();
      execution.status = mapped;
      execution.summary = input.summary?.slice(0, 2_000);
      execution.error = input.error?.slice(0, 2_000);
      execution.updatedAt = iso(at);
      if (
        mapped === 'completed' ||
        mapped === 'failed' ||
        mapped === 'cancelled'
      ) {
        execution.completedAt = iso(at);
        maybeCreateNotification(state, execution, execution.completedAt);
      }
      return clone(execution);
    });
  }

  private async updateExecution(
    id: string,
    at: Date,
    update: (execution: RoutineExecution) => void,
  ): Promise<RoutineExecution | undefined> {
    return this.mutate((state) => {
      const execution = state.executions.find((item) => item.id === id);
      if (!execution) return undefined;
      update(execution);
      execution.updatedAt = iso(at);
      return clone(execution);
    });
  }

  async listExecutions(
    filter: RoutineExecutionFilter = {},
  ): Promise<RoutineExecution[]> {
    const state = await this.readState();
    return state.executions
      .filter(
        (execution) =>
          (!filter.routineId || execution.routineId === filter.routineId) &&
          (!filter.workspaceId ||
            execution.routine.workspaceId === filter.workspaceId) &&
          (!filter.projectId ||
            execution.routine.projectId === filter.projectId) &&
          (!filter.status || execution.status === filter.status),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(filter.limit ?? 100, 500)))
      .map(clone);
  }

  async referencedRunIds(workspaceId: string): Promise<string[]> {
    const state = await this.readState();
    return [...new Set(
      state.executions
        .filter((execution) => execution.routine.workspaceId === workspaceId)
        .flatMap((execution) => (execution.runId ? [execution.runId] : [])),
    )];
  }

  async listRecentExecutionDigests(
    input: RoutineExecutionDigestInput,
  ): Promise<Record<string, RoutineExecutionDigest[]>> {
    const routines = new Map(input.routines.map((routine) => [routine.id, routine]));
    if (routines.size > 50) {
      throw new Error('routine_execution_digest_maximum_is_50_routines');
    }
    const limit = Math.max(1, Math.min(input.limitPerRoutine ?? 3, 3));
    const result = Object.fromEntries(
      [...routines.keys()].map((routineId) => [routineId, [] as RoutineExecutionDigest[]]),
    );
    if (!routines.size) return result;
    const state = await this.readState();
    for (const execution of [...state.executions].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )) {
      const routine = routines.get(execution.routineId);
      if (!routine || !sameExecutionRoute(execution, routine)) continue;
      const digests = result[execution.routineId];
      if (digests.length < limit) digests.push(executionDigest(execution));
    }
    return result;
  }

  async listNotifications(
    filter: RoutineNotificationFilter = {},
  ): Promise<RoutineNotification[]> {
    const state = await this.readState();
    return state.notifications
      .filter(
        (notification) =>
          (!filter.routineId || notification.routineId === filter.routineId) &&
          (!filter.workspaceId ||
            notification.routine.workspaceId === filter.workspaceId) &&
          (!filter.projectId ||
            notification.routine.projectId === filter.projectId) &&
          (!filter.status || notification.status === filter.status),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(filter.limit ?? 100, 500)))
      .map(clone);
  }

  async getNotification(id: string): Promise<RoutineNotification | undefined> {
    const state = await this.readState();
    const notification = state.notifications.find((item) => item.id === id);
    return notification ? clone(notification) : undefined;
  }

  async claimNotifications(input: {
    claimerId: string;
    limit?: number;
    staleAfterMs?: number;
    at?: Date;
  }): Promise<RoutineNotificationClaim[]> {
    return this.mutate((state) => {
      const at = input.at ?? new Date();
      const timestamp = iso(at);
      const staleBefore = new Date(
        at.getTime() - (input.staleAfterMs ?? 120_000),
      ).toISOString();
      const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
      const claims: RoutineNotificationClaim[] = [];
      const eligible = state.notifications
        .filter(
          (notification) =>
            (notification.status === 'pending' &&
              notification.nextAttemptAt <= timestamp) ||
            (notification.status === 'claimed' &&
              Boolean(
                notification.claimedAt && notification.claimedAt <= staleBefore,
              )),
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      for (const notification of eligible) {
        const current = state.routines.find(
          (routine) =>
            routine.id === notification.routineId && !routine.deletedAt,
        );
        if (!current || !sameIncidentPolicy(notification.routine, current)) {
          notification.status = 'cancelled';
          notification.lastError = 'routine_route_or_notification_policy_changed';
          notification.updatedAt = timestamp;
          continue;
        }
        if (claims.length >= limit) break;
        notification.status = 'claimed';
        notification.claimerId = input.claimerId;
        notification.claimedAt = timestamp;
        notification.attempts += 1;
        notification.updatedAt = timestamp;
        claims.push({ notification: clone(notification) });
      }
      return claims;
    });
  }

  async markNotificationDelivered(
    id: string,
    at = new Date(),
  ): Promise<RoutineNotification | undefined> {
    return this.mutate((state) => {
      const notification = state.notifications.find((item) => item.id === id);
      if (!notification) return undefined;
      const timestamp = iso(at);
      notification.status = 'delivered';
      notification.lastError = undefined;
      notification.deliveredAt = timestamp;
      notification.updatedAt = timestamp;
      return clone(notification);
    });
  }

  async retryNotification(
    id: string,
    error: string,
    options: { at?: Date; maxAttempts?: number; retryBaseMs?: number } = {},
  ): Promise<RoutineNotification | undefined> {
    return this.mutate((state) => {
      const notification = state.notifications.find((item) => item.id === id);
      if (!notification) return undefined;
      const at = options.at ?? new Date();
      const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 5, 20));
      const retryBaseMs = Math.max(1_000, options.retryBaseMs ?? 30_000);
      notification.status =
        notification.attempts >= maxAttempts ? 'failed' : 'pending';
      notification.lastError = error.slice(0, 2_000);
      notification.nextAttemptAt = new Date(
        at.getTime() +
          Math.min(
            retryBaseMs * 2 ** Math.max(0, notification.attempts - 1),
            30 * 60_000,
          ),
      ).toISOString();
      notification.updatedAt = iso(at);
      return clone(notification);
    });
  }

  async summarize(
    workspaceId?: string,
    projectId?: string,
  ): Promise<RoutineSummary> {
    const state = await this.readState();
    const routines = state.routines.filter(
      (routine) =>
        !routine.deletedAt &&
        (!workspaceId || routine.workspaceId === workspaceId) &&
        (!projectId || routine.projectId === projectId),
    );
    const routineIds = new Set(routines.map((routine) => routine.id));
    const routineById = new Map(routines.map((routine) => [routine.id, routine]));
    const executions = executionCounts();
    const notifications = notificationCounts();
    const oldestExecutionUpdatedAt: Partial<
      Record<RoutineExecutionStatus, string>
    > = {};
    for (const execution of state.executions) {
      if (routineIds.has(execution.routineId)) {
        executions[execution.status] += 1;
        recordOldestExecution(oldestExecutionUpdatedAt, execution);
      }
    }
    for (const notification of state.notifications) {
      const routine = routineById.get(notification.routineId);
      if (!routine || !sameRoutineRoute(notification.routine, routine)) continue;
      notifications[notification.status] += 1;
    }
    const nextRunAt = routines
      .filter((routine) => routine.enabled && routine.nextRunAt)
      .map((routine) => routine.nextRunAt as string)
      .sort()[0];
    return {
      routines: {
        enabled: routines.filter((routine) => routine.enabled).length,
        disabled: routines.filter((routine) => !routine.enabled).length,
      },
      executions,
      notifications,
      oldestExecutionUpdatedAt,
      nextRunAt,
    };
  }

  async listAudit(
    input: RoutineAuditFilter | number = {},
  ): Promise<RoutineAuditRecord[]> {
    const filter = typeof input === 'number' ? { limit: input } : input;
    const state = await this.readState();
    return state.audit
      .filter(
        (entry) =>
          (!filter.workspaceId || entry.workspaceId === filter.workspaceId) &&
          (!filter.projectId || entry.projectId === filter.projectId),
      )
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, Math.max(1, Math.min(filter.limit ?? 50, 200)))
      .map(clone);
  }
}
