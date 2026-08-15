import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDeliveryStore } from '../packages/delivery/dist/index.js';
import { MemoryLarkTransport } from '../packages/platform-lark/dist/index.js';
import { LarkHistoryImportService } from '../apps/server/dist/lark-history-import.js';

function mainThread() {
  return {
    id: 'lark:oc_history:main',
    platform: 'lark',
    externalId: 'oc_history:main',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    channelId: 'oc_history',
    title: 'Long-running group',
    visibility: 'private',
  };
}

test('old-group history import is durable, archive-only, and restart resumable', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxtag-history-import-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  await store.configureThreadBinding({
    platform: 'lark',
    externalId: 'oc_history',
    scope: 'channel',
    source: 'configured',
    channelId: 'oc_history',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    title: 'Long-running group',
  });
  const transport = new MemoryLarkTransport();
  transport.chats.set('oc_history', {
    chatId: 'oc_history',
    name: 'Long-running group',
    chatMode: 'topic',
    chatType: 'private',
  });
  transport.historyMessages.push(
    {
      message_id: 'om_main',
      chat_id: 'oc_history',
      msg_type: 'text',
      create_time: String(Date.parse('2026-08-14T00:10:00.000Z')),
      sender: { id: 'ou_member', sender_type: 'user' },
      body: { content: JSON.stringify({ text: '项目统一使用 pnpm。' }) },
    },
    {
      message_id: 'om_topic',
      chat_id: 'oc_history',
      thread_id: 'omt_topic',
      msg_type: 'text',
      create_time: String(Date.parse('2026-08-14T00:20:00.000Z')),
      sender: { id: 'ou_owner', sender_type: 'user' },
      body: { content: JSON.stringify({ text: '决定九月发布。' }) },
    },
    {
      message_id: 'om_bot',
      chat_id: 'oc_history',
      msg_type: 'text',
      create_time: String(Date.parse('2026-08-14T00:30:00.000Z')),
      sender: { id: 'ou_bot', sender_type: 'app' },
      body: { content: JSON.stringify({ text: 'bot claim' }) },
    },
  );
  const job = await store.createLarkHistoryImport({
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    channelId: 'oc_history',
    channelTitle: 'Long-running group',
    thread: mainThread(),
    mode: 'history',
    since: new Date('2026-08-14T00:00:00.000Z'),
    until: new Date('2026-08-15T00:00:00.000Z'),
    analyzeMemory: false,
  });
  const statusUpdates = [];
  const service = new LarkHistoryImportService({
    deliveryStore: store,
    memoryAnalysisService: { status: () => ({ enabled: false }) },
    transport: () => transport,
    workerId: 'history-worker-a',
    intervalWindowMs: 12 * 60 * 60_000,
    windowsPerPass: 1,
    onStatus: async (current) => statusUpdates.push(current.status),
  });

  const first = await service.runPass();
  assert.equal(first.claimed, 1);
  assert.equal(first.released, 1);
  const checkpoint = await store.getLarkHistoryImport(job.id);
  assert.equal(checkpoint.status, 'pending');
  assert.equal(checkpoint.cursor.windowSince, '2026-08-14T12:00:00.000Z');
  assert.deepEqual(statusUpdates, ['claimed', 'pending']);

  // A fresh service instance represents a process restart. It resumes at the
  // persisted window boundary and idempotently finishes without executing any
  // historical @mention as a new agent task.
  const restarted = new LarkHistoryImportService({
    deliveryStore: store,
    memoryAnalysisService: { status: () => ({ enabled: false }) },
    transport: () => transport,
    workerId: 'history-worker-b',
    intervalWindowMs: 12 * 60 * 60_000,
    windowsPerPass: 2,
    onStatus: async (current) => statusUpdates.push(current.status),
  });
  const second = await restarted.runPass();
  assert.equal(second.completed, 1);
  const completed = await store.getLarkHistoryImport(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.importedMessages, 2);
  assert.equal(completed.duplicateMessages, 0);
  assert.deepEqual(statusUpdates.slice(-2), ['claimed', 'completed']);
  assert.equal((await store.listAgentRuns({ limit: 20 })).length, 0);

  const main = await store.listSourceThreadMessages({ thread: mainThread() });
  assert.deepEqual(main.map((record) => record.message.id), ['om_main', 'om_topic']);
  assert.equal(main[0].origin, 'history');
  assert.equal(main[1].message.metadata.historySourceThreadId, 'lark:oc_history:om_topic');
  const topic = {
    ...mainThread(),
    id: 'lark:oc_history:om_topic',
    externalId: 'oc_history:om_topic',
    rootMessageId: 'om_topic',
    topicId: 'omt_topic',
  };
  const topicMessages = await store.listSourceThreadMessages({ thread: topic });
  assert.deepEqual(topicMessages.map((record) => record.message.id), ['om_topic']);
  assert.doesNotMatch(JSON.stringify([...main, ...topicMessages]), /bot claim/u);
});

test('first-use choice can complete from-now or activate a bounded import', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxtag-history-choice-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  const awaiting = await store.createLarkHistoryImport({
    workspaceId: 'workspace-1', projectId: 'project-1', channelId: 'oc_history',
    thread: mainThread(), mode: 'awaiting_choice', requestedBy: 'lark:ou_admin',
  });
  assert.equal(awaiting.status, 'awaiting_choice');
  const rebound = await store.updateLarkHistoryImportOnboarding(awaiting.id, {
    projectId: 'project-2',
    cardMessageId: 'om_onboarding',
  });
  assert.equal(rebound.projectId, 'project-2');
  assert.equal(rebound.thread.projectId, 'project-2');
  assert.equal(rebound.cardMessageId, 'om_onboarding');
  const activated = await store.configureLarkHistoryImport(awaiting.id, {
    mode: 'history',
    since: new Date('2026-05-01T00:00:00.000Z'),
    until: new Date('2026-08-01T00:00:00.000Z'),
  });
  assert.equal(activated.status, 'pending');
  assert.equal(activated.projectId, 'project-2');
  assert.equal(activated.cursor.windowSince, '2026-05-01T00:00:00.000Z');

  const other = await store.createLarkHistoryImport({
    workspaceId: 'workspace-1', projectId: 'project-1', channelId: 'oc_other',
    thread: { ...mainThread(), id: 'lark:oc_other:main', externalId: 'oc_other:main', channelId: 'oc_other' },
    mode: 'awaiting_choice',
  });
  const fromNow = await store.configureLarkHistoryImport(other.id, { mode: 'from_now' });
  assert.equal(fromNow.status, 'completed');
  assert.equal(fromNow.mode, 'from_now');
  assert.equal(fromNow.importedMessages, 0);
});

test('history memory synthesis batches the canonical group transcript without agent runs', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maxtag-history-memory-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileDeliveryStore(root);
  await store.configureThreadBinding({
    platform: 'lark', externalId: 'oc_history', scope: 'channel', source: 'configured',
    channelId: 'oc_history', workspaceId: 'workspace-1', projectId: 'project-1',
  });
  const transport = new MemoryLarkTransport();
  transport.chats.set('oc_history', {
    chatId: 'oc_history', name: 'Long-running group', chatMode: 'topic', chatType: 'private',
  });
  for (let index = 0; index < 3; index += 1) {
    transport.historyMessages.push({
      message_id: `om_memory_${index}`,
      chat_id: 'oc_history',
      thread_id: index ? `omt_${index}` : undefined,
      msg_type: 'text',
      create_time: String(Date.parse(`2026-08-14T00:0${index}:00.000Z`)),
      sender: { id: `ou_${index}`, sender_type: 'user' },
      body: { content: JSON.stringify({ text: `durable fact ${index}` }) },
    });
  }
  const calls = [];
  const memoryAnalysisService = {
    status: () => ({ enabled: true, maxEntries: 2, maxChars: 200_000 }),
    analyze: async (input) => {
      calls.push(input);
      const transcript = await store.loadThreadTranscript({
        thread: input.thread,
        maxEntries: 2,
        maxChars: 200_000,
        afterCursor: input.afterCursor,
        order: 'oldest',
      });
      return {
        transcript,
        proposed: [],
      };
    },
  };
  const job = await store.createLarkHistoryImport({
    workspaceId: 'workspace-1', projectId: 'project-1', channelId: 'oc_history',
    thread: mainThread(), mode: 'history',
    since: new Date('2026-08-14T00:00:00.000Z'),
    until: new Date('2026-08-15T00:00:00.000Z'),
    analyzeMemory: true,
  });
  const service = new LarkHistoryImportService({
    deliveryStore: store,
    memoryAnalysisService,
    transport: () => transport,
    workerId: 'history-memory-worker',
  });
  const result = await service.runPass();
  assert.equal(result.completed, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.thread.id === mainThread().id));
  assert.ok(calls.every((call) => call.useProvidedThread === true));
  const completed = await store.getLarkHistoryImport(job.id);
  assert.equal(completed.analyzedThreads, 1);
  assert.ok(completed.cursor.analysis[mainThread().id]);
  assert.equal((await store.listAgentRuns({ limit: 20 })).length, 0);
});
