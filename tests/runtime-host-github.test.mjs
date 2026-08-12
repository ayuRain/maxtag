import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOpenTagWorkerHost } from '@opentag/runtime-host';

test('standalone worker host keeps GitHub runs on the native transport', async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-github-worker-'),
  );
  try {
    const host = createOpenTagWorkerHost({
      dataDir,
      workerId: 'github-worker-test',
      github: { transportMode: 'memory' },
      executors: { mode: 'dry-run' },
    });
    const thread = {
      id: 'github:acme/opentag#42',
      platform: 'github',
      externalId: 'acme/opentag#42',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'acme/opentag',
      rootMessageId: '42',
      topicId: '42',
      visibility: 'private',
      metadata: {
        owner: 'acme',
        repo: 'opentag',
        repository: 'acme/opentag',
        issueNumber: 42,
      },
    };
    await host.deliveryStore.createAgentRun({
      runId: 'github-worker-run',
      thread,
      message: {
        id: '303',
        threadId: thread.id,
        platform: 'github',
        text: '@OpenTagBot inspect worker routing',
        actor: { id: 'ada', displayName: 'Ada' },
        createdAt: new Date().toISOString(),
        mentionsAgent: true,
      },
      transportMode: 'github-memory',
    });

    const result = await host.runAgentWorkerPass(1);
    assert.equal(result.claimed, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.runs[0].status, 'completed');
    assert.equal(result.runs[0].workerId, 'github-worker-test');

    const outbox = await host.deliveryStore.listOutbox({ limit: 20 });
    assert.ok(outbox.every((item) => item.status === 'delivered'));
    assert.ok(outbox.some((item) => item.kind === 'github.progress.create'));
    assert.ok(outbox.some((item) => item.kind === 'github.progress.update'));
    assert.ok(outbox.some((item) => item.kind === 'github.comment'));
    assert.ok(
      outbox
        .filter((item) => item.kind.startsWith('github.'))
        .every(
          (item) =>
            item.target.chatId === 'acme/opentag' &&
            item.target.topicId === '42',
        ),
    );

    assert.deepEqual(host.githubTransportStatus(), {
      requested: 'memory',
      mode: 'memory',
      hasToken: false,
      baseUrl: undefined,
    });
    host.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
