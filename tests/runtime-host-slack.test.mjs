import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpenTagWorkerHost } from '@opentag/runtime-host';

test('standalone worker host keeps Slack runs on the native transport', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-slack-worker-'));
  try {
    const host = createOpenTagWorkerHost({
      dataDir,
      workerId: 'slack-worker-test',
      slack: { transportMode: 'memory' },
      executors: { mode: 'dry-run' },
    });
    const thread = {
      id: 'slack:C1:1786450000.000100',
      platform: 'slack',
      externalId: 'C1:1786450000.000100',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'C1',
      rootMessageId: '1786450000.000100',
      topicId: '1786450000.000100',
      visibility: 'public',
    };
    await host.deliveryStore.createAgentRun({
      runId: 'slack-worker-run',
      thread,
      message: {
        id: '1786450000.000100',
        threadId: thread.id,
        platform: 'slack',
        text: '<@UBOT> inspect worker routing',
        actor: { id: 'U1', displayName: 'Ada' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
      transportMode: 'slack-memory',
    });
    const result = await host.runAgentWorkerPass(1);
    assert.equal(result.completed, 1);
    assert.equal(result.runs[0].workerId, 'slack-worker-test');
    const outbox = await host.deliveryStore.listOutbox({ limit: 20 });
    assert.ok(outbox.some((item) => item.kind === 'slack.progress.create'));
    assert.ok(outbox.some((item) => item.kind === 'slack.progress.update'));
    assert.ok(outbox.some((item) => item.kind === 'slack.text'));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
