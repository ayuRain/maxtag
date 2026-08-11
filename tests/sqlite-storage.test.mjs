import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  FilePairingStore,
  FileWorkspaceAccessStore,
} from '../packages/config/dist/index.js';
import { FileDeliveryStore } from '../packages/delivery/dist/index.js';
import { FileRoutineStore } from '../packages/routines/dist/index.js';
import { SqliteOpenTagStore } from '../packages/storage-sqlite/dist/index.js';

const workerFile = new URL('./fixtures/sqlite-storage-worker.mjs', import.meta.url);

async function runContendingWorkers(databasePath, action, inputs) {
  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const gate = new Int32Array(gateBuffer);
  const workers = inputs.map(
    (input) =>
      new Worker(workerFile, {
        workerData: { databasePath, action, input, gate: gateBuffer },
      }),
  );
  const results = workers.map(
    (worker) =>
      new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      }),
  );
  const deadline = Date.now() + 5_000;
  while (Atomics.load(gate, 0) < workers.length) {
    if (Date.now() > deadline) throw new Error('sqlite_workers_not_ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1, workers.length);
  const messages = await Promise.all(results);
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve) => {
          if (worker.threadId === -1) resolve();
          else worker.once('exit', resolve);
        }),
    ),
  );
  for (const message of messages) {
    if (!message.ok) throw new Error(message.error);
  }
  return messages.map((message) => message.result);
}

test('SQLite storage imports existing file state once and preserves it', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-sqlite-migrate-'));
  let reopened;
  context.after(async () => {
    reopened?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const deliveryDir = path.join(root, 'delivery');
  const pairingDir = path.join(root, 'pairing');
  const fileDelivery = new FileDeliveryStore(deliveryDir);
  const filePairing = new FilePairingStore(pairingDir, { ttlMs: 600_000 });
  const accessDir = path.join(root, 'access');
  const memoryDir = path.join(root, 'memory');
  const routineDir = path.join(root, 'routines');
  const fileAccess = new FileWorkspaceAccessStore(accessDir);
  const fileRoutines = new FileRoutineStore(routineDir);
  await fileDelivery.configureThreadBinding({
    platform: 'lark',
    externalId: 'legacy-channel',
    workspaceId: 'dev-workspace',
    projectId: 'legacy-project',
    channelId: 'legacy-channel',
    source: 'configured',
  });
  await fileDelivery.enqueue({
    kind: 'text',
    target: { platform: 'lark', chatId: 'legacy-channel' },
    payload: { text: 'persist me' },
  });
  const invitation = await filePairing.createInvitation({
    platform: 'lark',
    workspaceId: 'dev-workspace',
    projectId: 'sqlite-project',
  });
  await fileAccess.upsertMember({
    workspaceId: 'dev-workspace',
    displayName: 'Legacy owner',
    role: 'owner',
    identities: [{ platform: 'lark', externalId: 'ou-legacy-owner' }],
  });
  await fs.mkdir(
    path.join(memoryDir, 'workspaces', 'dev-workspace', 'projects', 'legacy-project'),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      memoryDir,
      'workspaces',
      'dev-workspace',
      'projects',
      'legacy-project',
      'memory.md',
    ),
    '- legacy project memory\n',
    'utf8',
  );
  const legacyRoutine = await fileRoutines.upsertRoutine({
    workspaceId: 'dev-workspace',
    projectId: 'legacy-project',
    name: 'Legacy digest',
    instructions: 'Summarize legacy project activity.',
    schedule: { kind: 'interval', everyMinutes: 60 },
    destination: {
      platform: 'lark',
      externalId: 'legacy-channel',
      visibility: 'public',
    },
  });

  const databasePath = path.join(root, 'opentag.sqlite');
  const sqlite = new SqliteOpenTagStore({
    databasePath,
    pairingTtlMs: 600_000,
    legacyDeliveryFile: path.join(deliveryDir, 'delivery-state.json'),
    legacyPairingFile: path.join(pairingDir, 'pairing-state.json'),
    legacyAccessFile: path.join(accessDir, 'workspace-access.json'),
    legacyMemoryDir: memoryDir,
    legacyRoutineFile: path.join(routineDir, 'routine-state.json'),
  });
  assert.deepEqual(sqlite.migration, {
    deliveryImported: true,
    pairingImported: true,
    accessImported: true,
    memoryImported: true,
    routinesImported: true,
  });
  assert.equal((await sqlite.deliveryStore.listThreadBindings()).length, 1);
  assert.equal((await sqlite.deliveryStore.listOutbox()).length, 1);
  assert.equal((await sqlite.pairingStore.listInvitations()).length, 1);
  assert.equal((await sqlite.accessStore.snapshot('dev-workspace')).members.length, 1);
  const memoryQuery = {
    thread: {
      id: 'lark:legacy-channel',
      platform: 'lark',
      externalId: 'legacy-channel',
      workspaceId: 'dev-workspace',
      projectId: 'legacy-project',
      visibility: 'public',
    },
  };
  assert.match(
    (await sqlite.memoryStore.loadMemory({ ...memoryQuery, scopes: ['project'] }))
      .scopes[0].content,
    /legacy project memory/,
  );
  assert.equal(
    (await sqlite.memoryStore.getMemoryHistory({
      ...memoryQuery,
      scope: 'project',
    })).revisions[0].action,
    'import',
  );
  assert.equal(
    (await sqlite.routineStore.getRoutine(legacyRoutine.id))?.name,
    'Legacy digest',
  );

  const paired = await sqlite.consumePairingAndConfigureBinding({
    platform: 'lark',
    code: invitation.code,
    channelId: 'sqlite-channel',
    threadExternalId: 'sqlite-channel:root',
    actorId: 'operator-1',
    title: 'SQLite channel',
  });
  assert.equal(paired.consumed.ok, true);
  assert.equal(paired.binding?.projectId, 'sqlite-project');
  sqlite.close();

  reopened = new SqliteOpenTagStore({
    databasePath,
    legacyDeliveryFile: path.join(deliveryDir, 'delivery-state.json'),
    legacyPairingFile: path.join(pairingDir, 'pairing-state.json'),
    legacyAccessFile: path.join(accessDir, 'workspace-access.json'),
    legacyMemoryDir: memoryDir,
    legacyRoutineFile: path.join(routineDir, 'routine-state.json'),
  });
  assert.deepEqual(reopened.migration, {
    deliveryImported: false,
    pairingImported: false,
    accessImported: false,
    memoryImported: false,
    routinesImported: false,
  });
  assert.equal(
    (await reopened.deliveryStore.getThreadBinding('lark', 'sqlite-channel'))
      ?.projectId,
    'sqlite-project',
  );
  assert.equal(
    (await reopened.pairingStore.listInvitations())[0].status,
    'consumed',
  );
  assert.equal(
    (await reopened.accessStore.snapshot('dev-workspace')).members[0].displayName,
    'Legacy owner',
  );
  assert.match(
    (
      await reopened.memoryStore.loadMemory({
        ...memoryQuery,
        scopes: ['project'],
      })
    ).scopes[0].content,
    /legacy project memory/,
  );
  assert.equal(
    (await reopened.routineStore.getRoutine(legacyRoutine.id))?.name,
    'Legacy digest',
  );
});

test(
  'SQLite storage atomically arbitrates pairing and outbox claims across workers',
  { timeout: 15_000 },
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-sqlite-race-'));
    const databasePath = path.join(root, 'opentag.sqlite');
    const store = new SqliteOpenTagStore({
      databasePath,
      pairingTtlMs: 600_000,
    });
    context.after(async () => {
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    const invitation = await store.pairingStore.createInvitation({
      platform: 'telegram',
      workspaceId: 'workspace-race',
      projectId: 'project-race',
    });

    const pairResults = await runContendingWorkers(databasePath, 'pair', [
      {
        platform: 'telegram',
        code: invitation.code,
        channelId: 'telegram-channel-a',
        threadExternalId: 'telegram-channel-a:1',
        actorId: 'actor-a',
      },
      {
        platform: 'telegram',
        code: invitation.code,
        channelId: 'telegram-channel-b',
        threadExternalId: 'telegram-channel-b:1',
        actorId: 'actor-b',
      },
    ]);
    assert.equal(
      pairResults.filter((result) => result.consumed.ok).length,
      1,
    );
    assert.equal(
      pairResults.filter(
        (result) => !result.consumed.ok && result.consumed.reason === 'consumed_code',
      ).length,
      1,
    );
    const bindings = await store.deliveryStore.listThreadBindings();
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].projectId, 'project-race');

    await store.deliveryStore.enqueue({
      kind: 'text',
      target: { platform: 'telegram', chatId: 'same-target' },
      payload: { text: 'first' },
    });
    await store.deliveryStore.enqueue({
      kind: 'text',
      target: { platform: 'telegram', chatId: 'same-target' },
      payload: { text: 'second' },
    });
    const claimResults = await runContendingWorkers(
      databasePath,
      'claim',
      [{}, {}],
    );
    assert.equal(claimResults.flat().length, 1);
    assert.equal(claimResults.flat()[0].payload.text, 'first');
    assert.equal(
      (await store.deliveryStore.listOutbox({ status: 'sending' })).length,
      1,
    );
    assert.equal(
      (await store.deliveryStore.listOutbox({ status: 'pending' })).length,
      1,
    );

    const memoryThread = {
      id: 'telegram:shared-topic',
      platform: 'telegram',
      externalId: 'shared-topic',
      workspaceId: 'workspace-race',
      projectId: 'project-race',
      visibility: 'public',
    };
    await runContendingWorkers(databasePath, 'remember', [
      {
        thread: memoryThread,
        scope: 'project',
        text: 'memory from worker A',
        actorId: 'telegram:actor-a',
        source: 'telegram-command',
      },
      {
        thread: memoryThread,
        scope: 'project',
        text: 'memory from worker B',
        actorId: 'telegram:actor-b',
        source: 'telegram-command',
      },
    ]);
    const history = await store.memoryStore.getMemoryHistory({
      thread: memoryThread,
      scope: 'project',
    });
    assert.equal(history.document.version, 2);
    assert.equal(history.revisions.length, 2);
    assert.match(history.document.content, /memory from worker A/);
    assert.match(history.document.content, /memory from worker B/);

    const routine = await store.routineStore.upsertRoutine({
      workspaceId: 'workspace-race',
      projectId: 'project-race',
      name: 'Race-safe digest',
      instructions: 'Summarize the project once.',
      schedule: { kind: 'interval', everyMinutes: 60 },
      destination: {
        platform: 'telegram',
        externalId: 'same-target',
        visibility: 'public',
      },
    });
    const execution = await store.routineStore.triggerRoutine(routine.id);
    const routineClaims = await runContendingWorkers(
      databasePath,
      'routine-claim',
      [{ claimerId: 'scheduler-a' }, { claimerId: 'scheduler-b' }],
    );
    assert.equal(routineClaims.flat().length, 1);
    assert.equal(routineClaims.flat()[0].execution.id, execution.id);
    assert.equal(
      (await store.routineStore.listExecutions({ routineId: routine.id }))[0]
        .attempts,
      1,
    );
  },
);
