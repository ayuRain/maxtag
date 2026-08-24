import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error('failed_to_reserve_test_port');
  return port;
}

async function waitForJson(url, predicate, child, logs, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`process exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (response.ok && predicate(data)) return data;
      lastError = new Error(`unexpected response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message}\n${logs.join('')}`);
}

async function startServer(dataDir) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENTAG_PORT: String(port),
      OPENTAG_HOST: '127.0.0.1',
      OPENTAG_DATA_DIR: dataDir,
      OPENTAG_STORAGE_DRIVER: 'sqlite',
      OPENTAG_ADMIN_TOKEN: '',
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_EXECUTOR_MODE: 'dry-run',
      OPENTAG_LARK_TRANSPORT: 'memory',
      OPENTAG_TELEGRAM_TRANSPORT: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForJson(
    `${baseUrl}/health`,
    (data) => data.ok === true,
    child,
    logs,
  );
  return { baseUrl, child, health, logs };
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

test(
  'server and standalone worker share SQLite runs across restart',
  { timeout: 25_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-sqlite-app-'));
    const processes = [];
    context.after(async () => {
      await Promise.all(processes.map(stopProcess));
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const firstServer = await startServer(dataDir);
    processes.push(firstServer.child);
    assert.equal(firstServer.health.storage.driver, 'sqlite');
    assert.equal(firstServer.health.storage.wal, true);

    const queuedResponse = await fetch(`${firstServer.baseUrl}/v1/dev/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        async: true,
        platform: 'telegram',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        text: '@MaxTag verify the shared SQLite worker path',
      }),
    });
    assert.equal(queuedResponse.status, 202);
    const queued = await queuedResponse.json();
    assert.equal(queued.run.status, 'queued');

    const workerLogs = [];
    const worker = spawn(process.execPath, ['apps/worker/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_STORAGE_DRIVER: 'sqlite',
        OPENTAG_WORKER_ONCE: '1',
        OPENTAG_EXECUTOR_MODE: 'dry-run',
        OPENTAG_LARK_TRANSPORT: 'memory',
        OPENTAG_TELEGRAM_TRANSPORT: 'memory',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.push(worker);
    worker.stdout.on('data', (chunk) => workerLogs.push(chunk.toString()));
    worker.stderr.on('data', (chunk) => workerLogs.push(chunk.toString()));
    const [workerCode] = await once(worker, 'exit');
    assert.equal(workerCode, 0, workerLogs.join(''));
    assert.match(workerLogs.join(''), /"claimed":1/);

    const completed = await waitForJson(
      `${firstServer.baseUrl}/v1/runs?limit=20`,
      (data) =>
        data.runs.some(
          (run) => run.id === queued.run.id && run.status === 'completed',
        ),
      firstServer.child,
      firstServer.logs,
    );
    assert.match(
      completed.runs.find((run) => run.id === queued.run.id).summary,
      /Dry-run Codex executor received/,
    );

    const memoryRoute = {
      platform: 'lark',
      externalId: 'sqlite-memory-channel',
      threadId: 'lark:sqlite-memory-channel:root',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      scope: 'project',
    };
    const firstMemoryWrite = await fetch(`${firstServer.baseUrl}/v1/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryRoute,
        action: 'remember',
        text: 'memory persisted before restart',
      }),
    });
    assert.equal(firstMemoryWrite.status, 200);

    await stopProcess(firstServer.child);
    const secondServer = await startServer(dataDir);
    processes.push(secondServer.child);
    assert.deepEqual(secondServer.health.storage.migration, {
      deliveryImported: false,
      deliverySplitMigrated: false,
      pairingImported: false,
      accessImported: false,
      memoryImported: false,
      routinesImported: false,
      workflowsImported: false,
    });
    const afterRestart = await fetch(
      `${secondServer.baseUrl}/v1/runs?limit=20`,
    ).then((response) => response.json());
    assert.equal(
      afterRestart.runs.find((run) => run.id === queued.run.id)?.status,
      'completed',
    );
    const memoryQuery = new URLSearchParams(memoryRoute);
    const persistedMemory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    assert.match(
      persistedMemory.snapshot.scopes[0].content,
      /memory persisted before restart/,
    );
    assert.equal(persistedMemory.history.document.version, 1);
    assert.equal(
      persistedMemory.history.revisions[0].actorId,
      'operator:local-development',
    );
    assert.equal(persistedMemory.history.revisions[0].source, 'operator-api');

    await fetch(`${secondServer.baseUrl}/v1/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryRoute,
        action: 'remember',
        text: 'temporary second version',
      }),
    });
    const restoreResponse = await fetch(`${secondServer.baseUrl}/v1/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryRoute,
        action: 'restore',
        revisionId: persistedMemory.history.revisions[0].id,
      }),
    });
    assert.equal(restoreResponse.status, 200);
    const restoredMemory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    assert.equal(restoredMemory.history.document.version, 3);
    assert.equal(restoredMemory.history.revisions[0].action, 'restore');
    assert.doesNotMatch(
      restoredMemory.snapshot.scopes[0].content,
      /temporary second version/,
    );

    const memoryExportQuery = new URLSearchParams({
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      scope: 'project',
      includeRevisions: 'true',
    });
    const memoryExport = await fetch(
      `${secondServer.baseUrl}/v1/memory-export?${memoryExportQuery.toString()}`,
    ).then((response) => response.json());
    assert.equal(memoryExport.schemaVersion, 1);
    assert.equal(memoryExport.counts.documents, 1);
    assert.equal(memoryExport.counts.revisions, 3);
    assert.equal(memoryExport.documents[0].scope.kind, 'project');
    assert.equal(memoryExport.documents[0].scope.workspaceId, 'dev-workspace');
    assert.equal(memoryExport.documents[0].scope.projectId, 'dev-workspace:opentag');
    assert.deepEqual(
      memoryExport.revisions.map((revision) => revision.action),
      ['restore', 'remember', 'remember'],
    );

    const memoryDiffQuery = new URLSearchParams({
      ...memoryRoute,
      revisionId: memoryExport.revisions[0].id,
    });
    const memoryDiff = await fetch(
      `${secondServer.baseUrl}/v1/memory-diff?${memoryDiffQuery.toString()}`,
    ).then((response) => response.json());
    assert.equal(memoryDiff.scope, 'project');
    assert.equal(memoryDiff.diff.to.action, 'restore');
    assert.equal(memoryDiff.diff.from.action, 'remember');
    assert.equal(memoryDiff.diff.removedLines.length, 1);
    assert.match(memoryDiff.diff.removedLines[0], /temporary second version/);
    assert.equal(memoryDiff.diff.addedLines.length, 0);

    const memoryCompactDryRun = await fetch(
      `${secondServer.baseUrl}/v1/memory-compact`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'dev-workspace',
          projectId: 'opentag',
          scope: ['project'],
          keepLatestPerDocument: 1,
        }),
      },
    ).then((response) => response.json());
    assert.equal(memoryCompactDryRun.dryRun, true);
    assert.equal(memoryCompactDryRun.counts.scannedRevisions, 3);
    assert.equal(memoryCompactDryRun.counts.droppedRevisions, 1);

    const afterDryRunExport = await fetch(
      `${secondServer.baseUrl}/v1/memory-export?${memoryExportQuery.toString()}`,
    ).then((response) => response.json());
    assert.equal(afterDryRunExport.counts.revisions, 3);

    const memoryCompactApply = await fetch(
      `${secondServer.baseUrl}/v1/memory-compact`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'dev-workspace',
          projectId: 'opentag',
          scope: ['project'],
          keepLatestPerDocument: 1,
          apply: true,
        }),
      },
    ).then((response) => response.json());
    assert.equal(memoryCompactApply.dryRun, false);
    assert.equal(memoryCompactApply.counts.droppedRevisions, 1);

    const afterApplyExport = await fetch(
      `${secondServer.baseUrl}/v1/memory-export?${memoryExportQuery.toString()}`,
    ).then((response) => response.json());
    assert.deepEqual(
      afterApplyExport.revisions.map((revision) => revision.action),
      ['restore', 'remember'],
    );

    const proposalCreate = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...memoryRoute,
          action: 'remember',
          text: 'approved proposal fact',
          actorId: 'lark:ou-requester',
          source: 'lark-command',
        }),
      },
    ).then((response) => response.json());
    assert.equal(proposalCreate.proposal.status, 'pending');

    const pendingProposals = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals?workspaceId=dev-workspace&projectId=opentag&status=pending`,
    ).then((response) => response.json());
    assert.equal(pendingProposals.proposals.length, 1);
    assert.equal(pendingProposals.proposals[0].id, proposalCreate.proposal.id);

    const approvedProposal = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals/${proposalCreate.proposal.id}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'useful project memory' }),
      },
    ).then((response) => response.json());
    assert.equal(approvedProposal.proposal.status, 'approved');
    assert.ok(approvedProposal.proposal.appliedRevisionId);
    const afterApprovalMemory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    assert.match(
      afterApprovalMemory.snapshot.scopes[0].content,
      /approved proposal fact/,
    );

    const secondMergeSource = await fetch(
      `${secondServer.baseUrl}/v1/memory`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...memoryRoute,
          action: 'remember',
          text: 'merge source two',
        }),
      },
    );
    assert.equal(secondMergeSource.status, 200);
    const mergeHistory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    const mergeProposalResponse = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...memoryRoute,
          action: 'merge',
          text: 'merged API fact',
          selectors: ['approved proposal fact', 'merge source two'],
          expectedDocumentVersion:
            mergeHistory.snapshot.scopes[0].document.version,
          searchAliases: ['merged API lookup'],
        }),
      },
    );
    assert.equal(mergeProposalResponse.status, 201);
    const mergeProposal = await mergeProposalResponse.json();
    assert.deepEqual(mergeProposal.proposal.selectors, [
      'approved proposal fact',
      'merge source two',
    ]);
    const oversizedMergeResponse = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...memoryRoute,
          action: 'merge',
          text: 'An over-broad API merge.',
          selectors: Array.from({ length: 9 }, (_, index) => `fact-${index}`),
          expectedDocumentVersion:
            mergeHistory.snapshot.scopes[0].document.version,
        }),
      },
    );
    assert.equal(oversizedMergeResponse.status, 400);
    assert.deepEqual(await oversizedMergeResponse.json(), {
      error: 'memory_merge_selectors_limit_exceeded',
    });
    const approvedMerge = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals/${mergeProposal.proposal.id}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(approvedMerge.status, 200);
    const afterMergeMemory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    assert.match(afterMergeMemory.snapshot.scopes[0].content, /merged API fact/u);
    assert.doesNotMatch(
      afterMergeMemory.snapshot.scopes[0].content,
      /approved proposal fact|merge source two/u,
    );

    const rejectProposal = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...memoryRoute,
          action: 'forget',
          selector: 'merged API fact',
        }),
      },
    ).then((response) => response.json());
    const rejectedProposal = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals/${rejectProposal.proposal.id}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'keep it' }),
      },
    ).then((response) => response.json());
    assert.equal(rejectedProposal.proposal.status, 'rejected');
    const afterRejectMemory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    assert.match(
      afterRejectMemory.snapshot.scopes[0].content,
      /merged API fact/,
    );

    const firstBatchProposal = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...memoryRoute,
          action: 'remember',
          text: 'batch approved one',
        }),
      },
    ).then((response) => response.json());
    const secondBatchProposal = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...memoryRoute,
          action: 'remember',
          text: 'batch approved two',
        }),
      },
    ).then((response) => response.json());
    const batchApproved = await fetch(
      `${secondServer.baseUrl}/v1/memory-proposals/batch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          ids: [
            firstBatchProposal.proposal.id,
            secondBatchProposal.proposal.id,
          ],
        }),
      },
    ).then((response) => response.json());
    assert.equal(batchApproved.decided, 2);
    assert.equal(batchApproved.failed, 0);
    assert.deepEqual(
      batchApproved.proposals.map((proposal) => proposal.status),
      ['approved', 'approved'],
    );
    const afterBatchApprovalMemory = await fetch(
      `${secondServer.baseUrl}/v1/memory?${memoryQuery.toString()}`,
    ).then((response) => response.json());
    assert.match(
      afterBatchApprovalMemory.snapshot.scopes[0].content,
      /batch approved one/,
    );
    assert.match(
      afterBatchApprovalMemory.snapshot.scopes[0].content,
      /batch approved two/,
    );

  },
);
