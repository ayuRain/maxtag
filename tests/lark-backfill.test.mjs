import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backfillLarkHistory } from '../apps/server/dist/lark-backfill.js';
import { MemoryLarkTransport } from '../packages/platform-lark/dist/index.js';
import {
  createBridgeState,
  eventKeyState,
  runStartupBackfill,
} from '../scripts/lark-long-connection-bridge.mjs';

function configuredBinding(input = {}) {
  return {
    id: 'lark:oc_alpha',
    platform: 'lark',
    externalId: 'oc_alpha',
    scope: 'channel',
    source: 'configured',
    channelId: 'oc_alpha',
    workspaceId: 'workspace-1',
    projectId: 'alpha',
    title: 'Alpha Project',
    activationMode: 'mention',
    requireMention: true,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...input,
  };
}

test('Lark history backfill preserves configured project routes and recovers thread replies', async () => {
  const transport = new MemoryLarkTransport();
  transport.chats.set('oc_alpha', {
    chatId: 'oc_alpha',
    name: 'Alpha Project',
    chatMode: 'topic',
    chatType: 'private',
  });
  transport.historyMessages.push(
    {
      message_id: 'om_before',
      chat_id: 'oc_alpha',
      msg_type: 'text',
      create_time: '1786553999000',
      sender: { id: 'ou_member', sender_type: 'user' },
      body: { content: JSON.stringify({ text: '@MaxTag too early' }) },
      mentions: [{ id: 'ou_bot', name: 'MaxTag' }],
    },
    {
      message_id: 'om_root',
      chat_id: 'oc_alpha',
      thread_id: 'omt_alpha',
      msg_type: 'text',
      create_time: '1786554001000',
      sender: { id: 'ou_member', sender_type: 'user' },
      body: { content: JSON.stringify({ text: '@MaxTag recover root' }) },
      mentions: [{ id: 'ou_bot', name: 'MaxTag' }],
    },
    {
      message_id: 'om_reply',
      chat_id: 'oc_alpha',
      thread_id: 'omt_alpha',
      root_id: 'om_root',
      parent_id: 'om_root',
      msg_type: 'text',
      create_time: '1786554002000',
      sender: { id: 'ou_teammate', sender_type: 'user' },
      body: { content: JSON.stringify({ text: 'continue without mention' }) },
    },
    {
      message_id: 'om_bot',
      chat_id: 'oc_alpha',
      thread_id: 'omt_alpha',
      root_id: 'om_root',
      msg_type: 'text',
      create_time: '1786554003000',
      sender: { id: 'ou_bot', sender_type: 'app' },
      body: { content: JSON.stringify({ text: 'bot reply' }) },
    },
  );
  const ingested = [];
  const result = await backfillLarkHistory({
    workspaceId: 'workspace-1',
    since: new Date('2026-08-12T17:00:00.000Z'),
    until: new Date('2026-08-12T17:01:00.000Z'),
    bindings: [
      configuredBinding(),
      configuredBinding({
        id: 'lark:oc_alpha:omt_alpha',
        externalId: 'oc_alpha:omt_alpha',
        scope: 'thread',
        source: 'observed',
        activationMode: 'mention',
        metadata: {
          clientThread: {
            metadata: { larkThreadId: 'omt_alpha' },
          },
        },
      }),
      configuredBinding({
        id: 'lark:oc_beta',
        externalId: 'oc_beta',
        channelId: 'oc_beta',
        projectId: 'beta',
      }),
    ],
    transport,
    botOpenId: 'ou_bot',
    ingest: async (event) => {
      ingested.push(event);
      return { accepted: true, duplicate: event.message.id === 'om_root' };
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.channels, 2);
  assert.equal(result.replayed, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(
    ingested.map((event) => event.message.id),
    ['om_root', 'om_reply'],
  );
  assert.ok(ingested.every((event) => event.thread.workspaceId === 'workspace-1'));
  assert.ok(ingested.every((event) => event.thread.projectId === 'alpha'));
  assert.ok(ingested.every((event) => event.thread.channelId === 'oc_alpha'));
  assert.ok(ingested.every((event) => event.thread.visibility === 'private'));
  assert.ok(
    ingested.every((event) => event.thread.id === 'lark:oc_alpha:om_root'),
  );
  assert.ok(
    ingested.every((event) => event.thread.rootMessageId === 'om_root'),
  );
  assert.equal(ingested[0].message.mentionsAgent, true);
  assert.equal(ingested[1].message.mentionsAgent, false);
  assert.equal(
    ingested[1].message.metadata.recoveredFromLongConnectionBackfill,
    true,
  );
  assert.doesNotMatch(JSON.stringify(ingested), /too early|bot reply/);
});

test('Lark history backfill keeps project routes isolated across channels', async () => {
  const transport = new MemoryLarkTransport();
  for (const [channelId, projectId, marker] of [
    ['oc_alpha', 'alpha', 'alpha marker'],
    ['oc_beta', 'beta', 'beta marker'],
  ]) {
    transport.chats.set(channelId, {
      chatId: channelId,
      name: `${projectId} project`,
      chatMode: 'group',
      chatType: 'private',
    });
    transport.historyMessages.push({
      message_id: `om_${projectId}`,
      chat_id: channelId,
      msg_type: 'text',
      create_time: '1786554001000',
      sender: { id: `ou_${projectId}`, sender_type: 'user' },
      body: { content: JSON.stringify({ text: `@MaxTag ${marker}` }) },
      mentions: [{ id: 'ou_bot', name: 'MaxTag' }],
    });
  }
  const ingested = [];
  const result = await backfillLarkHistory({
    workspaceId: 'workspace-1',
    since: new Date('2026-08-12T17:00:00.000Z'),
    until: new Date('2026-08-12T17:01:00.000Z'),
    bindings: [
      configuredBinding(),
      configuredBinding({
        id: 'lark:oc_beta',
        externalId: 'oc_beta',
        channelId: 'oc_beta',
        projectId: 'beta',
        title: 'Beta Project',
      }),
    ],
    transport,
    botOpenId: 'ou_bot',
    ingest: async (event) => {
      ingested.push(event);
      return { accepted: true };
    },
  });

  assert.equal(result.complete, true);
  assert.deepEqual(
    ingested.map((event) => [
      event.thread.channelId,
      event.thread.projectId,
      event.message.actor.id,
    ]),
    [
      ['oc_alpha', 'alpha', 'ou_alpha'],
      ['oc_beta', 'beta', 'ou_beta'],
    ],
  );
  assert.deepEqual(
    ingested.map((event) => event.thread.id),
    ['lark:oc_alpha:main', 'lark:oc_beta:main'],
  );
});

async function bridgeReceiver(handler) {
  const requests = [];
  const server = await new Promise((resolve) => {
    const instance = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      requests.push({ request, body: raw ? JSON.parse(raw) : undefined });
      const result = await handler(request, requests.at(-1).body);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    });
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  };
}

function readyBridgeState() {
  const state = createBridgeState('2026-08-13T00:00:00.000Z');
  for (const key of ['im.message.receive_v1', 'card.action.trigger']) {
    const item = eventKeyState(state, key);
    item.running = true;
    item.ready = true;
  }
  return state;
}

test('Lark bridge advances its recovery checkpoint only after complete silent backfill', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-backfill-'));
  const checkpoint = path.join(root, 'checkpoint.json');
  const receiver = await bridgeReceiver((request, body) => {
    assert.equal(request.headers.authorization, 'Bearer ingress-token');
    assert.equal(request.url, '/v1/lark/backfill');
    assert.equal(body.workspaceId, 'workspace-1');
    return {
      status: 200,
      body: {
        complete: true,
        silent: true,
        channels: 2,
        scanned: 4,
        replayed: 2,
        duplicates: 1,
        ignored: 0,
        failed: 0,
        truncated: false,
        channelResults: [
          {
            channelId: 'oc_alpha',
            complete: true,
            until: body.until,
          },
          {
            channelId: 'oc_beta',
            complete: true,
            until: body.until,
          },
        ],
      },
    };
  });
  context.after(async () => {
    await receiver.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = readyBridgeState();
  const result = await runStartupBackfill(
    {
      backfillEnabled: true,
      dryRun: false,
      serverUrl: receiver.baseUrl,
      token: 'ingress-token',
      workspaceId: 'workspace-1',
      backfillLookbackMs: 60_000,
      backfillMaxMessages: 100,
      backfillStateFile: checkpoint,
    },
    state,
  );

  assert.equal(result.complete, true);
  assert.equal(state.backfill.completed, 1);
  assert.equal(state.backfill.failed, 0);
  assert.equal(state.backfill.replayed, 2);
  assert.equal(state.backfill.duplicates, 1);
  assert.deepEqual(
    JSON.parse(await fs.readFile(checkpoint, 'utf8')).checkpoints,
    {
      oc_alpha: state.backfill.until,
      oc_beta: state.backfill.until,
    },
  );
});

test('Lark bridge keeps the prior checkpoint after partial recovery', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-backfill-'));
  const checkpoint = path.join(root, 'checkpoint.json');
  const original = '2026-08-13T00:00:00.000Z';
  await fs.writeFile(
    checkpoint,
    JSON.stringify({ checkpoints: { oc_alpha: original, oc_beta: original } }),
  );
  const receiver = await bridgeReceiver((request, body) => ({
    status: 207,
    body: {
      complete: false,
      silent: true,
      replayed: 50,
      duplicates: 49,
      failed: 1,
      truncated: true,
      channelResults: [
        {
          channelId: 'oc_alpha',
          complete: true,
          until: body.until,
        },
        {
          channelId: 'oc_beta',
          complete: false,
          until: body.until,
          truncated: true,
        },
      ],
    },
  }));
  context.after(async () => {
    await receiver.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = readyBridgeState();
  const result = await runStartupBackfill(
    {
      backfillEnabled: true,
      dryRun: false,
      serverUrl: receiver.baseUrl,
      workspaceId: 'workspace-1',
      backfillLookbackMs: 60_000,
      backfillMaxMessages: 50,
      backfillStateFile: checkpoint,
    },
    state,
  );

  assert.equal(result.complete, false);
  assert.equal(state.backfill.completed, 0);
  assert.equal(state.backfill.failed, 1);
  assert.equal(state.backfill.truncated, true);
  assert.deepEqual(
    JSON.parse(await fs.readFile(checkpoint, 'utf8')).checkpoints,
    {
      oc_alpha: state.backfill.until,
      oc_beta: original,
    },
  );
});
