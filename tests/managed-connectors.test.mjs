import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileManagedConnectorStore,
  ManagedConnectorRevisionConflictError,
} from '@opentag/config';

test('managed connector state is shared across store instances with optimistic revisions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-connectors-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverStore = new FileManagedConnectorStore(root);
  const workerStore = new FileManagedConnectorStore(root);

  assert.deepEqual(await serverStore.get('linear'), {
    id: 'linear',
    enabled: true,
    revision: 0,
  });
  const disabled = await serverStore.setEnabled({
    id: 'linear',
    enabled: false,
    expectedRevision: 0,
    actor: 'operator:ada',
  });
  assert.equal(disabled.revision, 1);
  assert.equal(await workerStore.isEnabled('linear'), false);

  await assert.rejects(
    workerStore.setEnabled({
      id: 'linear',
      enabled: true,
      expectedRevision: 0,
    }),
    (error) =>
      error instanceof ManagedConnectorRevisionConflictError &&
      error.currentRevision === 1,
  );

  const checked = await workerStore.recordHealth({
    id: 'linear',
    actor: 'operator:grace',
    health: {
      status: 'unavailable',
      checkedAt: '2026-08-13T12:00:00.000Z',
      latencyMs: 25,
      toolCount: 0,
      errorCode: 'external_mcp_connection_failed',
    },
  });
  assert.equal(checked.revision, 1);
  assert.equal(checked.lastCheck.status, 'unavailable');
  await Promise.all([
    serverStore.setEnabled({ id: 'github', enabled: false, expectedRevision: 0 }),
    workerStore.setEnabled({ id: 'notion', enabled: false, expectedRevision: 0 }),
  ]);
  assert.deepEqual(
    (await serverStore.list(['github', 'notion'])).map((item) => item.enabled),
    [false, false],
  );
  assert.deepEqual(
    (await serverStore.listAudit()).map((record) => record.action),
    [
      'connector.disabled',
      'connector.disabled',
      'connector.checked',
      'connector.disabled',
    ],
  );
});
