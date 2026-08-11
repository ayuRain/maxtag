import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpenTagWorkerHost } from '@opentag/runtime-host';

test('standalone worker host keeps Telegram runs on the native transport', async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-telegram-worker-'),
  );
  try {
    const host = createOpenTagWorkerHost({
      dataDir,
      workerId: 'telegram-worker-test',
      telegram: { transportMode: 'memory' },
      executors: { mode: 'dry-run' },
    });
    const thread = {
      id: 'telegram:-100123:77',
      platform: 'telegram',
      externalId: '-100123:77',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: '-100123',
      topicId: '77',
      visibility: 'public',
      metadata: { incomingMessageId: '41' },
    };
    await host.deliveryStore.createAgentRun({
      runId: 'telegram-worker-run',
      thread,
      message: {
        id: '41',
        threadId: thread.id,
        platform: 'telegram',
        text: '/opentag inspect worker routing',
        actor: { id: 'user-1', displayName: 'Ada' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
      transportMode: 'telegram-memory',
    });

    const result = await host.runAgentWorkerPass(1);
    assert.equal(result.claimed, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.runs[0].status, 'completed');
    assert.equal(result.runs[0].workerId, 'telegram-worker-test');

    const outbox = await host.deliveryStore.listOutbox({ limit: 20 });
    assert.ok(outbox.every((item) => item.status === 'delivered'));
    assert.ok(outbox.some((item) => item.kind === 'telegram.progress.create'));
    assert.ok(outbox.some((item) => item.kind === 'telegram.progress.update'));
    assert.ok(outbox.some((item) => item.kind === 'telegram.text'));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
