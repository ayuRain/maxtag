import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileRoutineStore, nextRoutineRunAt } from '@opentag/routines';

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
  assert.equal((await restarted.summarize('acme')).executions.completed, 1);
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
