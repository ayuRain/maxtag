import { parentPort, workerData } from 'node:worker_threads';
import { SqliteOpenTagStore } from '../../packages/storage-sqlite/dist/index.js';

const gate = new Int32Array(workerData.gate);
const store = new SqliteOpenTagStore({ databasePath: workerData.databasePath });

Atomics.add(gate, 0, 1);
Atomics.notify(gate, 0);
while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0);

try {
  const result =
    workerData.action === 'pair'
      ? await store.consumePairingAndConfigureBinding(workerData.input)
      : workerData.action === 'remember'
        ? await store.memoryStore.rememberScoped(workerData.input)
        : workerData.action === 'routine-claim'
          ? await store.routineStore.claimExecutions({
              ...workerData.input,
              limit: 1,
            })
        : await store.deliveryStore.claimReadyOutbox({ limit: 1 });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  store.close();
  parentPort.close();
}
