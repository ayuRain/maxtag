import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';

function launchWorker(environment) {
  const logs = [];
  const child = spawn(process.execPath, ['apps/worker/dist/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

async function waitForRun(store, runId, predicate, processInfo, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    if (processInfo && processInfo.child.exitCode !== null) {
      throw new Error(
        `worker exited early (${processInfo.child.exitCode})\n${processInfo.logs.join('')}`,
      );
    }
    latest = await store.deliveryStore.getAgentRun(runId);
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(
    `run state timeout; latest=${JSON.stringify(latest)}\n${processInfo?.logs.join('') || ''}`,
  );
}

async function stopWorker(processInfo) {
  if (processInfo.child.exitCode !== null) return processInfo.child.exitCode;
  processInfo.child.kill('SIGTERM');
  const [code] = await Promise.race([
    once(processInfo.child, 'exit'),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`worker shutdown timeout\n${processInfo.logs.join('')}`)),
        5_000,
      ),
    ),
  ]);
  return code;
}

test(
  'standalone worker requeues an interrupted run and a replacement completes it',
  { timeout: 30_000 },
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-restart-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspaces');
    const databasePath = path.join(dataDir, 'opentag.sqlite');
    const hangingCli = path.join(root, 'hanging-codex.mjs');
    const completingCli = path.join(root, 'completing-codex.mjs');
    await fs.mkdir(path.join(workspaceRoot, 'opentag'), { recursive: true });
    await fs.writeFile(
      hangingCli,
      `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'restart-session-one' }));
console.log(JSON.stringify({ type: 'item.started', item: { id: 'wait', type: 'reasoning' } }));
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    await fs.writeFile(
      completingCli,
      `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'restart-session-two' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Replacement worker completed the run.' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
      { mode: 0o700 },
    );

    const store = new SqliteOpenTagStore({ databasePath });
    const processes = [];
    context.after(async () => {
      await Promise.allSettled(processes.map(stopWorker));
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    const runId = 'worker-restart-run';
    const thread = {
      id: 'lark:restart:root',
      platform: 'lark',
      externalId: 'restart:root',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'oc_restart',
      rootMessageId: 'om_restart_root',
      visibility: 'public',
      title: 'Restart proof',
    };
    await store.deliveryStore.createAgentRun({
      runId,
      thread,
      message: {
        id: 'om_restart_message',
        threadId: thread.id,
        platform: thread.platform,
        text: 'Run through a supervised worker restart.',
        actor: { id: 'ou_restart_owner', displayName: 'Restart owner' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
      transportMode: 'lark-memory',
    });

    const sharedEnvironment = {
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_STORAGE_DRIVER: 'sqlite',
      OPENTAG_SQLITE_PATH: databasePath,
      OPENTAG_WORKER_INTERVAL_MS: '25',
      OPENTAG_WORKER_BATCH: '1',
      OPENTAG_WORKER_STALE_MS: '5000',
      OPENTAG_AGENT_RUN_HEARTBEAT_MS: '250',
      OPENTAG_RUN_CONTROL_POLL_MS: '25',
      OPENTAG_EXECUTOR_MODE: 'local-cli',
      OPENTAG_EXECUTOR_WORKSPACE_ROOT: workspaceRoot,
      OPENTAG_EXECUTOR_SESSION_MODE: 'transcript',
      OPENTAG_EXECUTOR_TIMEOUT_MS: '20000',
      OPENTAG_LARK_TRANSPORT: 'memory',
      OPENTAG_TELEGRAM_TRANSPORT: 'memory',
      OPENTAG_GITHUB_TRANSPORT: 'memory',
    };

    const first = launchWorker({
      ...sharedEnvironment,
      OPENTAG_WORKER_ID: 'restart-worker-one',
      OPENTAG_CODEX_COMMAND: hangingCli,
    });
    processes.push(first);
    await waitForRun(
      store,
      runId,
      (run) => run.status === 'running' && run.workerId === 'restart-worker-one',
      first,
    );

    assert.equal(await stopWorker(first), 0, first.logs.join(''));
    const queued = await waitForRun(
      store,
      runId,
      (run) => run.status === 'queued',
      undefined,
    );
    assert.equal(queued.workerId, undefined);
    assert.match(queued.lastError, /^opentag\.run_requeue:sigterm$/);
    assert.match(first.logs.join(''), /"requeued":1/);

    const afterRestartOutbox = await store.deliveryStore.listOutbox({
      runId,
      limit: 100,
    });
    assert.ok(
      afterRestartOutbox.some(
        (item) =>
          item.kind === 'lark.card.update' &&
          JSON.stringify(item.payload).includes('**Status:** blocked'),
      ),
    );
    const initialCard = afterRestartOutbox.find(
      (item) => item.kind === 'lark.card.create',
    );
    assert.ok(initialCard?.externalId);
    assert.equal(
      afterRestartOutbox.filter((item) => item.kind === 'lark.card.create')
        .length,
      1,
    );

    const replacement = launchWorker({
      ...sharedEnvironment,
      OPENTAG_WORKER_ID: 'restart-worker-two',
      OPENTAG_WORKER_ONCE: '1',
      OPENTAG_CODEX_COMMAND: completingCli,
    });
    processes.push(replacement);
    const [replacementCode] = await once(replacement.child, 'exit');
    assert.equal(replacementCode, 0, replacement.logs.join(''));

    const completed = await store.deliveryStore.getAgentRun(runId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.workerId, 'restart-worker-two');
    assert.equal(completed.summary, 'Replacement worker completed the run.');
    assert.equal(completed.lastError, undefined);
    assert.equal((await store.deliveryStore.listAgentRuns({ limit: 20 })).length, 1);
    const events = await store.deliveryStore.listAgentRunEvents(runId);
    assert.equal(events.filter((event) => event.type === 'started').length, 2);
    assert.ok(
      events.some(
        (event) =>
          event.type === 'log' &&
          event.message === 'opentag.run_requeue:sigterm',
      ),
    );
    const finalOutbox = await store.deliveryStore.listOutbox({
      runId,
      limit: 100,
    });
    assert.ok(
      finalOutbox.some(
        (item) =>
          item.kind === 'lark.card.update' &&
          JSON.stringify(item.payload).includes('**Status:** completed'),
      ),
    );
    assert.equal(
      finalOutbox.filter((item) => item.kind === 'lark.card.create').length,
      1,
    );
    assert.ok(
      finalOutbox
        .filter((item) => item.kind === 'lark.card.update')
        .every(
          (item) =>
            item.target.cardId === initialCard.externalId &&
            item.externalId === initialCard.externalId,
        ),
    );
    assert.ok(finalOutbox.some((item) => item.kind === 'lark.text'));
  },
);
