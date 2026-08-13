import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FileDeliveryStore } from '@opentag/delivery';
import { loadDurableConversationContext } from '@opentag/runtime-host';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';

function thread(id = 'context-thread', platform = 'lark') {
  return {
    id: `${platform}:payments:${id}`,
    platform,
    externalId: `payments:${id}`,
    channelId: 'payments',
    rootMessageId: id,
    workspaceId: 'acme',
    projectId: 'payments',
    visibility: 'public',
  };
}

function message(sourceThread, id, text, actorId = 'user-1') {
  return {
    id,
    threadId: sourceThread.id,
    platform: sourceThread.platform,
    text,
    actor: { id: actorId, displayName: actorId },
    createdAt: new Date().toISOString(),
    mentionsAgent: true,
  };
}

async function rootFixture(context, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('durable transcript preserves ordered provenance without replaying the current turn', async (context) => {
  const root = await rootFixture(context, 'opentag-context-');
  const store = new FileDeliveryStore(root);
  const sourceThread = thread();
  const initial = await store.createAgentRunOrSteer({
    runId: 'run-initial',
    thread: sourceThread,
    message: message(sourceThread, 'message-initial', 'Investigate latency.'),
    executorId: 'claude',
    metadata: { agentId: 'payments-agent', agentDisplayName: 'Payments Agent' },
  });
  await store.claimQueuedAgentRuns({ workerId: 'worker-1' });
  await store.setAgentRunSteeringMode(initial.run.id, 'live');
  const steered = await store.createAgentRunOrSteer({
    runId: 'unused-live-run',
    thread: sourceThread,
    message: message(
      sourceThread,
      'message-live',
      'Focus on the database pool.',
      'user-2',
    ),
    executorId: 'claude',
  });
  const claimed = await store.claimNextAgentRunSteering(initial.run.id, {
    workerId: 'worker-1',
  });
  await store.markAgentRunSteeringApplied(
    claimed.id,
    'Forwarded to active Claude stream',
  );
  await store.markAgentRunCompleted(initial.run.id, 'The pool was exhausted.');

  const current = await store.createAgentRunOrSteer({
    runId: 'run-current',
    thread: sourceThread,
    message: message(sourceThread, 'message-current', 'What should we change?'),
    executorId: 'claude',
  });
  const transcript = await loadDurableConversationContext({
    deliveryStore: store,
    run: current.run,
    transcriptMaxEntries: 40,
    transcriptMaxChars: 40_000,
  });

  assert.deepEqual(
    transcript.entries.map((entry) => [entry.role, entry.source, entry.text]),
    [
      ['user', 'run', 'Investigate latency.'],
      ['user', 'live_steering', 'Focus on the database pool.'],
      ['assistant', 'run', 'The pool was exhausted.'],
    ],
  );
  assert.equal(
    transcript.entries.filter((entry) => entry.id.includes(steered.steering.id))
      .length,
    1,
  );
  assert.equal(
    transcript.entries.some((entry) => entry.runId === current.run.id),
    false,
  );
  assert.equal(transcript.totalEntries, 3);
  assert.equal(transcript.omittedEntries, 0);
  assert.ok(
    (await store.listAgentRunEvents(current.run.id)).some(
      (event) =>
        event.type === 'transcript_loaded' &&
        event.metadata?.loadedEntries === 3,
    ),
  );

  const bounded = await store.loadThreadTranscript({
    thread: sourceThread,
    excludeRunId: current.run.id,
    maxEntries: 2,
    maxChars: 40_000,
  });
  assert.equal(bounded.entries.length, 2);
  assert.equal(bounded.omittedEntries, 1);
  assert.equal(bounded.truncated, true);
});

test('source thread messages hydrate transcript and de-duplicate run messages', async (context) => {
  const root = await rootFixture(context, 'opentag-source-context-');
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('source-context');
  const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
  await store.upsertSourceThreadMessages({
    thread: sourceThread,
    origin: 'history',
    messages: [
      {
        ...message(sourceThread, 'source-1', 'We already chose option B.'),
        createdAt,
      },
      {
        ...message(sourceThread, 'source-dup', 'This became a run too.'),
        createdAt: new Date('2026-01-01T00:00:01.000Z').toISOString(),
      },
    ],
  });
  const previous = await store.createAgentRunOrSteer({
    runId: 'source-run-dup',
    thread: sourceThread,
    message: {
      ...message(sourceThread, 'source-dup', 'This became a run too.'),
      createdAt: new Date('2026-01-01T00:00:01.000Z').toISOString(),
    },
    metadata: { agentDisplayName: 'MaxTag' },
  });
  await store.claimQueuedAgentRuns({ workerId: 'worker-1' });
  await store.markAgentRunCompleted(previous.run.id, 'Acknowledged.');

  const current = await store.createAgentRunOrSteer({
    runId: 'source-run-current',
    thread: sourceThread,
    message: {
      ...message(sourceThread, 'source-current', 'Continue from there.'),
      createdAt: new Date('2026-01-01T00:00:02.000Z').toISOString(),
    },
  });
  const transcript = await store.loadThreadTranscript({
    thread: sourceThread,
    excludeRunId: current.run.id,
  });

  assert.deepEqual(
    transcript.entries.map((entry) => [
      entry.role,
      entry.source,
      entry.messageId,
      entry.text,
    ]),
    [
      [
        'user',
        'source_message',
        'source-1',
        'We already chose option B.',
      ],
      ['user', 'source_message', 'source-dup', 'This became a run too.'],
      ['assistant', 'run', undefined, 'Acknowledged.'],
    ],
  );
  assert.equal(
    transcript.entries.filter((entry) => entry.messageId === 'source-dup')
      .length,
    1,
  );
});

test('next-turn steering appears once after its continuation completes', async (context) => {
  const root = await rootFixture(context, 'opentag-context-next-');
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('next-turn');
  const active = await store.createAgentRunOrSteer({
    runId: 'run-active',
    thread: sourceThread,
    message: message(sourceThread, 'message-active', 'Start the review.'),
  });
  await store.claimQueuedAgentRuns({ workerId: 'worker-1' });
  const followUp = await store.createAgentRunOrSteer({
    runId: 'unused-follow-up',
    thread: sourceThread,
    message: message(
      sourceThread,
      'message-follow-up',
      'Check the retry policy too.',
    ),
  });
  await store.markAgentRunCompleted(active.run.id, 'Initial review complete.');
  const scheduled = (
    await store.listAgentRunSteering({ runId: active.run.id })
  ).find((item) => item.id === followUp.steering.id);
  const continuation = (
    await store.claimQueuedAgentRuns({ workerId: 'worker-2' })
  )[0];
  assert.equal(continuation.id, scheduled.continuationRunId);

  const before = await store.loadThreadTranscript({
    thread: sourceThread,
    excludeRunId: continuation.id,
  });
  assert.equal(
    before.entries.filter((entry) => entry.text.includes('retry policy')).length,
    0,
  );

  await store.markAgentRunCompleted(continuation.id, 'Retry policy checked.');
  const later = await store.createAgentRunOrSteer({
    runId: 'run-later',
    thread: sourceThread,
    message: message(sourceThread, 'message-later', 'Summarize the work.'),
  });
  const after = await store.loadThreadTranscript({
    thread: sourceThread,
    excludeRunId: later.run.id,
  });
  assert.equal(
    after.entries.filter((entry) => entry.text.includes('retry policy')).length,
    1,
  );
});

test('long thread transcripts keep the newest complete context window', async (context) => {
  const root = await rootFixture(context, 'opentag-context-long-');
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('long-thread');
  for (let index = 0; index < 12; index += 1) {
    const run = await store.createAgentRunOrSteer({
      runId: `long-run-${index}`,
      thread: sourceThread,
      message: message(
        sourceThread,
        `long-message-${index}`,
        `Question ${index}: ${'x'.repeat(120)}`,
      ),
    });
    await store.claimQueuedAgentRuns({ workerId: 'long-worker' });
    await store.markAgentRunCompleted(
      run.run.id,
      `Answer ${index}: ${'y'.repeat(120)}`,
    );
    await delay(2);
  }
  const current = await store.createAgentRunOrSteer({
    runId: 'long-run-current',
    thread: sourceThread,
    message: message(sourceThread, 'long-message-current', 'Current question.'),
  });

  const transcript = await store.loadThreadTranscript({
    thread: sourceThread,
    excludeRunId: current.run.id,
    maxEntries: 6,
    maxChars: 40_000,
  });
  assert.equal(transcript.totalEntries, 24);
  assert.equal(transcript.entries.length, 6);
  assert.equal(transcript.omittedEntries, 18);
  assert.deepEqual(
    transcript.entries.map((entry) => entry.runId),
    [
      'long-run-9',
      'long-run-9',
      'long-run-10',
      'long-run-10',
      'long-run-11',
      'long-run-11',
    ],
  );

  const charBounded = await store.loadThreadTranscript({
    thread: sourceThread,
    excludeRunId: current.run.id,
    maxEntries: 40,
    maxChars: 1_000,
  });
  assert.ok(charBounded.entries.length < transcript.totalEntries);
  assert.equal(charBounded.truncated, true);
  assert.equal(charBounded.entries.at(-1).runId, 'long-run-11');
});

test('incremental transcripts advance from the oldest unseen entry without gaps', async (context) => {
  const root = await rootFixture(context, 'opentag-context-cursor-');
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('cursor-thread');
  const messages = Array.from({ length: 5 }, (_, index) => ({
    ...message(
      sourceThread,
      `cursor-message-${index + 1}`,
      `Cursor message ${index + 1}`,
    ),
    createdAt: new Date(`2026-01-01T00:00:0${index}.000Z`).toISOString(),
  }));
  await store.upsertSourceThreadMessages({
    thread: sourceThread,
    messages,
    origin: 'history',
  });

  const first = await store.loadThreadTranscript({
    thread: sourceThread,
    maxEntries: 2,
    maxChars: 40_000,
    order: 'oldest',
  });
  const second = await store.loadThreadTranscript({
    thread: sourceThread,
    maxEntries: 2,
    maxChars: 40_000,
    afterCursor: first.nextCursor,
    order: 'oldest',
  });
  const third = await store.loadThreadTranscript({
    thread: sourceThread,
    maxEntries: 2,
    maxChars: 40_000,
    afterCursor: second.nextCursor,
    order: 'oldest',
  });

  assert.deepEqual(
    [...first.entries, ...second.entries, ...third.entries].map(
      (entry) => entry.messageId,
    ),
    messages.map((item) => item.id),
  );
  assert.equal(first.omittedEntries, 3);
  assert.equal(second.omittedEntries, 1);
  assert.equal(third.omittedEntries, 0);
});

test('incremental cursor resumes by exact sorted position for equal timestamps', async (context) => {
  const root = await rootFixture(context, 'opentag-context-cursor-tie-');
  const store = new FileDeliveryStore(root);
  const sourceThread = thread('cursor-tie');
  const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
  await store.upsertSourceThreadMessages({
    thread: sourceThread,
    origin: 'history',
    messages: [
      { ...message(sourceThread, 'z-message', 'First by source order.'), createdAt },
      { ...message(sourceThread, 'a-message', 'Second by source order.'), createdAt },
    ],
  });
  const run = await store.createAgentRunOrSteer({
    runId: 'cursor-tie-run',
    thread: sourceThread,
    message: { ...message(sourceThread, 'run-message', 'Third.'), createdAt },
  });
  await store.claimQueuedAgentRuns({ workerId: 'cursor-worker' });
  await store.markAgentRunCompleted(run.run.id, 'Fourth.');

  const all = await store.loadThreadTranscript({
    thread: sourceThread,
    maxEntries: 20,
    maxChars: 40_000,
    order: 'oldest',
  });
  const seen = [];
  let cursor;
  for (let index = 0; index < all.entries.length; index += 1) {
    const page = await store.loadThreadTranscript({
      thread: sourceThread,
      maxEntries: 2,
      maxChars: 1_000,
      afterCursor: cursor,
      order: 'oldest',
    });
    if (!page.entries.length) break;
    seen.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, all.entries.map((entry) => entry.id));
});

test('provider sessions survive SQLite process boundaries and can be invalidated', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-context-sqlite-'),
  );
  const databasePath = path.join(root, 'opentag.db');
  const first = new SqliteOpenTagStore({ databasePath });
  const second = new SqliteOpenTagStore({ databasePath });
  context.after(async () => {
    first.close();
    second.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourceThread = thread('sqlite-session');
  const initial = await first.deliveryStore.createAgentRunOrSteer({
    runId: 'session-run-1',
    thread: sourceThread,
    message: message(sourceThread, 'session-message-1', 'Open a session.'),
    executorId: 'codex',
  });
  await first.deliveryStore.recordAgentThreadSession({
    providerId: 'codex',
    namespace: 'host:test',
    thread: sourceThread,
    sessionId: 'provider-session-1',
    runId: initial.run.id,
  });

  assert.equal(
    (
      await second.deliveryStore.getAgentThreadSession({
        providerId: 'codex',
        namespace: 'host:test',
        thread: sourceThread,
      })
    ).sessionId,
    'provider-session-1',
  );

  await first.deliveryStore.markAgentRunCompleted(initial.run.id, 'Opened.');
  const resumedRun = await second.deliveryStore.createAgentRunOrSteer({
    runId: 'session-run-2',
    thread: sourceThread,
    message: message(sourceThread, 'session-message-2', 'Continue.'),
    executorId: 'codex',
  });
  await second.deliveryStore.recordAgentThreadSession({
    providerId: 'codex',
    namespace: 'host:test',
    thread: sourceThread,
    sessionId: 'provider-session-1',
    runId: resumedRun.run.id,
  });
  const resumed = await first.deliveryStore.getAgentThreadSession({
    providerId: 'codex',
    namespace: 'host:test',
    thread: sourceThread,
  });
  assert.equal(resumed.lastRunId, resumedRun.run.id);
  assert.ok(
    (await first.deliveryStore.listAgentRunEvents(resumedRun.run.id)).some(
      (event) => event.type === 'session_resumed',
    ),
  );

  await first.deliveryStore.invalidateAgentThreadSession({
    providerId: 'codex',
    namespace: 'host:test',
    thread: sourceThread,
    runId: resumedRun.run.id,
    reason: 'provider session removed',
  });
  assert.equal(
    await second.deliveryStore.getAgentThreadSession({
      providerId: 'codex',
      namespace: 'host:test',
      thread: sourceThread,
    }),
    undefined,
  );

  const restarted = await second.deliveryStore.recordAgentThreadSession({
    providerId: 'codex',
    namespace: 'host:test',
    thread: sourceThread,
    sessionId: 'provider-session-2',
    runId: resumedRun.run.id,
  });
  assert.equal(restarted.status, 'active');
  assert.equal(restarted.sessionId, 'provider-session-2');
  assert.equal(restarted.startedByRunId, resumedRun.run.id);
  assert.equal((await first.deliveryStore.summarize('acme')).sessions.active, 1);
});
