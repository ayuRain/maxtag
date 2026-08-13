import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileThreadConfigStore } from '@opentag/config';
import { FileDeliveryStore } from '@opentag/delivery';
import {
  FileRoutineStore,
  RoutineCommandService,
  nextRoutineRunAt,
  parseRoutineCommand,
} from '@opentag/routines';
import { RoutineSchedulerService } from '@opentag/runtime-host';

function routineInput(overrides = {}) {
  return {
    workspaceId: 'acme',
    projectId: 'payments',
    name: 'Daily payment digest',
    instructions: 'Summarize payment incidents and open pull requests.',
    enabled: true,
    schedule: { kind: 'interval', everyMinutes: 5 },
    destination: {
      platform: 'lark',
      externalId: 'oc_payments',
      channelId: 'oc_payments',
      visibility: 'public',
      title: 'Payments',
    },
    ...overrides,
  };
}

async function storeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-routines-'));
  return { root, store: new FileRoutineStore(root) };
}

test('daily schedules honor the configured IANA time zone', () => {
  const schedule = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' };
  assert.equal(
    nextRoutineRunAt(schedule, new Date('2026-08-11T00:30:00.000Z')).toISOString(),
    '2026-08-11T01:00:00.000Z',
  );
  assert.equal(
    nextRoutineRunAt(schedule, new Date('2026-08-11T02:00:00.000Z')).toISOString(),
    '2026-08-12T01:00:00.000Z',
  );
});

test('one-time schedules normalize an explicit offset and stage exactly once', async () => {
  assert.equal(
    nextRoutineRunAt(
      { kind: 'once', at: '2026-08-14T09:00:00+08:00' },
      new Date('2026-08-13T00:00:00.000Z'),
    ).toISOString(),
    '2026-08-14T01:00:00.000Z',
  );
  const fixture = await storeFixture();
  const created = await fixture.store.upsertRoutine(
    routineInput({
      name: 'One-time release follow-up',
      schedule: { kind: 'once', at: '2026-08-14T09:00:00+08:00' },
    }),
    new Date('2026-08-13T00:00:00.000Z'),
  );
  assert.equal(created.nextRunAt, '2026-08-14T01:00:00.000Z');
  assert.equal(
    (await fixture.store.stageDue(new Date('2026-08-14T01:00:01.000Z'))).length,
    1,
  );
  const disabled = await fixture.store.getRoutine(created.id);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.nextRunAt, undefined);
  assert.equal(
    (await fixture.store.stageDue(new Date('2026-08-15T01:00:00.000Z'))).length,
    0,
  );
  await assert.rejects(
    fixture.store.setRoutineEnabled(
      created.id,
      true,
      'operator',
      new Date('2026-08-15T01:00:00.000Z'),
    ),
    /routine_once_already_elapsed/u,
  );
  await assert.rejects(
    fixture.store.upsertRoutine(
      routineInput({
        name: 'Past follow-up',
        schedule: { kind: 'once', at: '2026-08-12T09:00:00+08:00' },
      }),
      new Date('2026-08-13T00:00:00.000Z'),
    ),
    /routine_once_at_must_be_in_future/u,
  );
});

test('standing-work commands parse English, Chinese, and client addressing', () => {
  assert.deepEqual(
    parseRoutineCommand(
      'schedule once 2026-08-14T09:00:00+08:00: Check release status',
    ),
    {
      kind: 'create',
      instructions: 'Check release status',
      schedule: { kind: 'once', at: '2026-08-14T09:00:00+08:00' },
    },
  );
  assert.deepEqual(
    parseRoutineCommand('安排一次 2026-08-14T09:00:00+08:00：检查发布状态'),
    {
      kind: 'create',
      instructions: '检查发布状态',
      schedule: { kind: 'once', at: '2026-08-14T09:00:00+08:00' },
    },
  );
  assert.deepEqual(
    parseRoutineCommand(
      '/maxtag@MaxTagBot schedule every 2h: Check failed pipelines',
    ),
    {
      kind: 'create',
      instructions: 'Check failed pipelines',
      schedule: { kind: 'interval', everyMinutes: 120 },
    },
  );
  assert.deepEqual(
    parseRoutineCommand('@MaxTag 每天 09:30：汇总项目进展', {
      defaultTimeZone: 'Asia/Shanghai',
    }),
    {
      kind: 'create',
      instructions: '汇总项目进展',
      schedule: {
        kind: 'daily',
        time: '09:30',
        timeZone: 'Asia/Shanghai',
      },
    },
  );
  assert.deepEqual(parseRoutineCommand('/opentag routines'), { kind: 'list' });
  assert.deepEqual(parseRoutineCommand('暂停定时任务 ab12cd34'), {
    kind: 'pause',
    selector: 'ab12cd34',
  });
  assert.equal(parseRoutineCommand('summarize this project'), null);
});

test('standing-work service scopes lifecycle commands to their source thread', async () => {
  const fixture = await storeFixture();
  const service = new RoutineCommandService(fixture.store, {
    defaultTimeZone: 'Asia/Shanghai',
  });
  const thread = {
    id: 'lark:oc_payments:om_root',
    platform: 'lark',
    externalId: 'oc_payments:om_root',
    workspaceId: 'acme',
    projectId: 'payments',
    channelId: 'oc_payments',
    rootMessageId: 'om_root',
    topicId: 'om_root',
    visibility: 'public',
    title: 'Payments',
  };
  const command = service.parse('schedule every 15m: Check payment alerts');
  assert.ok(command);
  const created = await service.execute(command, thread, 'user-ada');
  assert.equal(created.action, 'create');
  assert.equal(created.routine.createdBy, 'user-ada');
  assert.equal(created.routine.destination.externalId, thread.externalId);

  const listed = await service.execute({ kind: 'list' }, thread, 'user-bob');
  assert.equal(listed.routines.length, 1);
  assert.match(listed.summary, /Check payment alerts/);
  assert.match(listed.summary, /last never/);
  const execution = await fixture.store.triggerRoutine(
    created.routine.id,
    'user-ada',
    new Date('2026-08-11T10:00:00.000Z'),
  );
  await fixture.store.markExecutionQueued(execution.id, 'routine-list-run');
  await fixture.store.reconcileRun({
    runId: 'routine-list-run',
    status: 'completed',
    summary: 'No payment alerts are open.',
    at: new Date('2026-08-11T10:01:00.000Z'),
  });
  const listedAfterRun = await service.execute({ kind: 'list' }, thread, 'user-bob');
  assert.match(listedAfterRun.summary, /last completed 2026-08-11T10:01:00.000Z/);
  assert.match(listedAfterRun.summary, /No payment alerts are open\./);
  assert.equal(listedAfterRun.recentExecutions[created.routine.id].length, 1);
  const anotherThread = {
    ...thread,
    id: 'lark:oc_payments:om_other',
    externalId: 'oc_payments:om_other',
    rootMessageId: 'om_other',
    topicId: 'om_other',
  };
  assert.match(
    (await service.execute({ kind: 'list' }, anotherThread, 'user-bob')).summary,
    /No standing work/,
  );

  const selector = created.routine.id.slice(0, 8);
  const paused = await service.execute(
    { kind: 'pause', selector },
    thread,
    'user-bob',
  );
  assert.equal(paused.routine.enabled, false);
  assert.equal(paused.routine.updatedBy, 'user-bob');
  const resumed = await service.execute(
    { kind: 'resume', selector },
    thread,
    'user-carol',
  );
  assert.equal(resumed.routine.enabled, true);
  assert.ok(resumed.routine.nextRunAt);
  const removed = await service.execute(
    { kind: 'delete', selector },
    thread,
    'user-dan',
  );
  assert.equal(removed.routine.deletedAt !== undefined, true);
  assert.equal((await fixture.store.listRoutines({ workspaceId: 'acme' })).length, 0);
  assert.ok(
    (await fixture.store.listAudit({ workspaceId: 'acme' })).some(
      (entry) => entry.actor === 'user-dan' && entry.action === 'routine.deleted',
    ),
  );
});

test('scheduled routine executions are deduped, reclaimable, and reconcilable', async () => {
  const fixture = await storeFixture();
  const created = await fixture.store.upsertRoutine(
    routineInput(),
    new Date('2026-08-11T10:00:00.000Z'),
  );
  assert.equal(created.nextRunAt, '2026-08-11T10:05:00.000Z');

  const staged = await fixture.store.stageDue(
    new Date('2026-08-11T10:06:00.000Z'),
  );
  assert.equal(staged.length, 1);
  assert.equal(staged[0].scheduledFor, '2026-08-11T10:05:00.000Z');
  assert.equal(staged[0].status, 'pending');
  assert.equal(
    (await fixture.store.getRoutine(created.id)).nextRunAt,
    '2026-08-11T10:11:00.000Z',
  );
  assert.equal(
    (await fixture.store.stageDue(new Date('2026-08-11T10:06:00.000Z'))).length,
    0,
  );

  const firstClaim = await fixture.store.claimExecutions({
    claimerId: 'server-1',
    at: new Date('2026-08-11T10:06:00.000Z'),
  });
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].execution.attempts, 1);

  const restarted = new FileRoutineStore(fixture.root);
  const reclaimed = await restarted.claimExecutions({
    claimerId: 'server-2',
    staleAfterMs: 120_000,
    at: new Date('2026-08-11T10:09:00.000Z'),
  });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].execution.id, firstClaim[0].execution.id);
  assert.equal(reclaimed[0].execution.attempts, 2);

  await restarted.markExecutionQueued(reclaimed[0].execution.id, 'run-1');
  await restarted.reconcileRun({ runId: 'run-1', status: 'running' });
  await restarted.reconcileRun({
    runId: 'run-1',
    status: 'completed',
    summary: 'Digest sent.',
  });
  const executions = await restarted.listExecutions({ routineId: created.id });
  assert.equal(executions[0].status, 'completed');
  assert.equal(executions[0].summary, 'Digest sent.');
  const summary = await restarted.summarize('acme');
  assert.equal(summary.executions.completed, 1);
  assert.equal(
    summary.oldestExecutionUpdatedAt.completed,
    executions[0].updatedAt,
  );
});

test('recent execution digests are bounded and do not follow a routine to another thread', async () => {
  const fixture = await storeFixture();
  const original = await fixture.store.upsertRoutine(
    routineInput({
      destination: {
        platform: 'lark',
        externalId: 'oc_payments:om_original',
        channelId: 'oc_payments',
        threadId: 'lark:oc_payments:om_original',
        rootMessageId: 'om_original',
        topicId: 'om_original',
        visibility: 'private',
      },
    }),
  );
  for (let index = 0; index < 4; index += 1) {
    const execution = await fixture.store.triggerRoutine(
      original.id,
      'operator',
      new Date(`2026-08-11T10:0${index}:00.000Z`),
    );
    await fixture.store.markExecutionQueued(execution.id, `digest-run-${index}`);
    await fixture.store.reconcileRun({
      runId: `digest-run-${index}`,
      status: 'completed',
      summary: `${index}:${'result '.repeat(80)}`,
      at: new Date(`2026-08-11T10:0${index}:30.000Z`),
    });
  }
  const digests = await fixture.store.listRecentExecutionDigests({
    routines: [original],
    limitPerRoutine: 10,
  });
  assert.equal(digests[original.id].length, 3);
  assert.match(digests[original.id][0].summary, /^3:/u);
  assert.equal(digests[original.id][0].summary.length, 300);

  const moved = await fixture.store.upsertRoutine({
    ...routineInput(),
    id: original.id,
    destination: {
      platform: 'lark',
      externalId: 'oc_payments:om_moved',
      channelId: 'oc_payments',
      threadId: 'lark:oc_payments:om_moved',
      rootMessageId: 'om_moved',
      topicId: 'om_moved',
      visibility: 'private',
    },
  });
  const afterMove = await fixture.store.listRecentExecutionDigests({
    routines: [moved],
  });
  assert.deepEqual(afterMove[moved.id], []);
});

test('routine failure escalation is thresholded, deduplicated, recoverable, and route-bound', async () => {
  const fixture = await storeFixture();
  const routine = await fixture.store.upsertRoutine(
    routineInput({
      notifications: {
        mode: 'failures_only',
        failureThreshold: 2,
        recovery: true,
      },
      destination: {
        platform: 'lark',
        externalId: 'oc_payments:om_alerts',
        channelId: 'oc_payments',
        threadId: 'lark:oc_payments:om_alerts',
        rootMessageId: 'om_alerts',
        topicId: 'om_alerts',
        visibility: 'private',
      },
    }),
  );
  const finish = async (index, status, detail) => {
    const at = new Date(`2026-08-11T10:0${index}:00.000Z`);
    const execution = await fixture.store.triggerRoutine(routine.id, 'test', at);
    await fixture.store.markExecutionQueued(execution.id, `alert-run-${index}`, at);
    return fixture.store.reconcileRun({
      runId: `alert-run-${index}`,
      status,
      ...(status === 'failed' ? { error: detail } : { summary: detail }),
      at,
    });
  };

  await finish(1, 'failed', 'first outage');
  assert.equal((await fixture.store.listNotifications()).length, 0);
  const thresholdExecution = await finish(2, 'failed', 'second outage');
  let notifications = await fixture.store.listNotifications();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'failure');
  assert.equal(notifications[0].consecutiveFailures, 2);
  assert.equal(notifications[0].executionId, thresholdExecution.id);
  assert.match(notifications[0].message, /second outage/u);

  await fixture.store.reconcileRun({
    runId: 'alert-run-2',
    status: 'failed',
    error: 'second outage repeated',
  });
  await finish(3, 'failed', 'third outage');
  assert.equal((await fixture.store.listNotifications()).length, 1);
  await finish(4, 'completed', 'service healthy');
  notifications = await fixture.store.listNotifications();
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].kind, 'recovery');
  assert.equal(notifications[0].consecutiveFailures, 3);
  assert.match(notifications[0].message, /service healthy/u);

  const [claimed] = await fixture.store.claimNotifications({
    claimerId: 'notifier-a',
    at: new Date('2026-08-11T10:05:00.000Z'),
  });
  assert.equal(claimed.notification.status, 'claimed');
  const retried = await fixture.store.retryNotification(
    claimed.notification.id,
    'temporary delivery failure',
    {
      at: new Date('2026-08-11T10:05:00.000Z'),
      retryBaseMs: 1_000,
    },
  );
  assert.equal(retried.status, 'pending');
  assert.equal(retried.nextAttemptAt, '2026-08-11T10:05:01.000Z');

  const moved = await fixture.store.upsertRoutine({
    ...routineInput(),
    id: routine.id,
    notifications: routine.notifications,
    destination: {
      ...routine.destination,
      externalId: 'oc_payments:om_moved_alerts',
      threadId: 'lark:oc_payments:om_moved_alerts',
      rootMessageId: 'om_moved_alerts',
      topicId: 'om_moved_alerts',
    },
  });
  assert.equal(moved.destination.topicId, 'om_moved_alerts');
  const cancelled = await fixture.store.getNotification(claimed.notification.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(
    cancelled.lastError,
    'routine_route_or_notification_policy_changed',
  );
  const summary = await fixture.store.summarize('acme', 'payments');
  assert.equal(summary.notifications.pending, 0);
  assert.equal(summary.notifications.cancelled, 0);
});

test('routine notification dispatch retries once and recognizes a delivered receipt', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-routine-notify-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const routineStore = new FileRoutineStore(path.join(root, 'routines'));
  const deliveryStore = new FileDeliveryStore(path.join(root, 'delivery'));
  const threadConfigStore = new FileThreadConfigStore(path.join(root, 'config'));
  const routine = await routineStore.upsertRoutine(
    routineInput({
      notifications: {
        mode: 'failures_only',
        failureThreshold: 1,
        recovery: true,
      },
    }),
  );
  const execution = await routineStore.triggerRoutine(
    routine.id,
    'test',
    new Date('2026-08-11T10:00:00.000Z'),
  );
  await routineStore.markExecutionQueued(
    execution.id,
    'notify-run',
    new Date('2026-08-11T10:00:00.000Z'),
  );
  await routineStore.reconcileRun({
    runId: 'notify-run',
    status: 'failed',
    error: 'pipeline unavailable',
    at: new Date('2026-08-11T10:01:00.000Z'),
  });
  const [notification] = await routineStore.listNotifications();
  let sends = 0;
  const scheduler = new RoutineSchedulerService({
    routineStore,
    deliveryStore,
    threadConfigStore,
    schedulerId: 'notification-test',
    sendNotification: async (thread, pending) => {
      sends += 1;
      assert.equal(thread.channelId, 'oc_payments');
      assert.equal(pending.id, notification.id);
      throw new Error('lark temporarily unavailable');
    },
  });
  const first = await scheduler.dispatchNotifications(
    new Date('2026-08-11T10:01:00.000Z'),
  );
  assert.equal(first.failed, 1);
  assert.equal(sends, 1);
  assert.equal((await routineStore.getNotification(notification.id)).status, 'pending');

  const receipt = await deliveryStore.enqueue({
    kind: 'lark.text',
    target: { platform: 'lark', chatId: 'oc_payments' },
    payload: {
      stage: 'routine-notification',
      notificationId: notification.id,
      text: notification.message,
    },
    runId: notification.runId,
    thread: {
      id: routine.destination.threadId || routine.destination.externalId,
      platform: 'lark',
      externalId: routine.destination.externalId,
      workspaceId: routine.workspaceId,
      projectId: routine.projectId,
      channelId: routine.destination.channelId,
      visibility: routine.destination.visibility,
    },
    maxAttempts: 1,
  });
  await deliveryStore.markSending(receipt.id);
  await deliveryStore.markDelivered(receipt.id, 'om_notification');
  const second = await scheduler.dispatchNotifications(
    new Date('2026-08-11T10:01:31.000Z'),
  );
  assert.equal(second.delivered, 1);
  assert.equal(sends, 1);
  assert.equal((await routineStore.getNotification(notification.id)).status, 'delivered');
});

test('disabling a routine cancels staged work while manual runs remain auditable', async () => {
  const fixture = await storeFixture();
  const created = await fixture.store.upsertRoutine(
    routineInput(),
    new Date('2026-08-11T10:00:00.000Z'),
  );
  await fixture.store.stageDue(new Date('2026-08-11T10:06:00.000Z'));
  const updated = await fixture.store.upsertRoutine(
    routineInput({ id: created.id, enabled: false }),
    new Date('2026-08-11T10:07:00.000Z'),
  );
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextRunAt, undefined);
  assert.equal(
    (await fixture.store.listExecutions({ routineId: created.id }))[0].status,
    'cancelled',
  );

  const manual = await fixture.store.triggerRoutine(
    created.id,
    'operator',
    new Date('2026-08-11T10:08:00.000Z'),
  );
  assert.equal(manual.trigger, 'manual');
  assert.equal(manual.status, 'pending');
  assert.ok(
    (await fixture.store.listAudit()).some(
      (entry) => entry.action === 'routine.triggered' && entry.actor === 'operator',
    ),
  );

  await fixture.store.upsertRoutine(
    routineInput({ workspaceId: 'other-workspace', projectId: 'other-project' }),
  );
  const scopedAudit = await fixture.store.listAudit({ workspaceId: 'acme' });
  assert.ok(scopedAudit.length > 0);
  assert.ok(scopedAudit.every((entry) => entry.workspaceId === 'acme'));
});

test('routine scheduler rejects a destination bound to another project', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-routine-scope-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const routineStore = new FileRoutineStore(path.join(root, 'routines'));
  const deliveryStore = new FileDeliveryStore(path.join(root, 'delivery'));
  const threadConfigStore = new FileThreadConfigStore(
    path.join(root, 'config'),
    {
      workspace: {
        id: 'acme',
        name: 'Acme',
        defaultProjectId: 'payments',
      },
    },
  );
  await deliveryStore.configureThreadBinding({
    platform: 'lark',
    externalId: 'oc_shared',
    workspaceId: 'acme',
    projectId: 'security',
    scope: 'channel',
    source: 'configured',
  });
  const routine = await routineStore.upsertRoutine(
    routineInput({
      destination: {
        platform: 'lark',
        externalId: 'oc_shared',
        channelId: 'oc_shared',
        visibility: 'public',
      },
    }),
  );
  const execution = await routineStore.triggerRoutine(routine.id);
  const scheduler = new RoutineSchedulerService({
    routineStore,
    deliveryStore,
    threadConfigStore,
    schedulerId: 'scope-test',
  });

  const result = await scheduler.tick({ stageDue: false });
  assert.equal(result.queued, 0);
  assert.equal(result.failed, 1);
  assert.equal(
    (await routineStore.listExecutions({ routineId: routine.id }))[0].error,
    'routine_destination_binding_scope_mismatch',
  );
  assert.equal(
    await deliveryStore.getAgentRun(`routine:${execution.id}`),
    undefined,
  );
});
