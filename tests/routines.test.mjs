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

test('standing-work commands parse English, Chinese, and client addressing', () => {
  assert.deepEqual(
    parseRoutineCommand(
      '/opentag@OpenTagBot schedule every 2h: Check failed pipelines',
    ),
    {
      kind: 'create',
      instructions: 'Check failed pipelines',
      schedule: { kind: 'interval', everyMinutes: 120 },
    },
  );
  assert.deepEqual(
    parseRoutineCommand('@OpenTag 每天 09:30：汇总项目进展', {
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
