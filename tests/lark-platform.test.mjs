import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDeliveryStore, TrackedLarkTransport } from '@opentag/delivery';
import {
  HttpLarkTransport,
  LarkPlatformAdapter,
  MemoryLarkTransport,
  applyLarkChatInfo,
  applyUnavailableLarkChatInfo,
  normalizeLarkEvent,
  normalizeLarkHistoryMessage,
} from '@opentag/platform-lark';
import { hydrateLarkThreadContext } from '@opentag/runtime-host';

test('Lark chat metadata supplies the real group name and privacy boundary', () => {
  const thread = applyLarkChatInfo(
    {
      id: 'lark:oc_private:root-1',
      platform: 'lark',
      externalId: 'oc_private:root-1',
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
      channelId: 'oc_private',
      rootMessageId: 'root-1',
      title: 'Lark oc_private',
      visibility: 'public',
    },
    {
      chatId: 'oc_private',
      name: 'MaxTag',
      chatMode: 'group',
      chatType: 'private',
      external: false,
    },
  );

  assert.equal(thread.title, 'MaxTag');
  assert.equal(thread.visibility, 'private');
  assert.equal(thread.metadata.larkChatInfoStatus, 'resolved');
  assert.equal(thread.metadata.larkChatMode, 'group');
  assert.equal(thread.metadata.larkChatType, 'private');
});

test('unavailable Lark group metadata fails closed to private', () => {
  const thread = applyUnavailableLarkChatInfo({
    id: 'lark:oc_unknown:root-1',
    platform: 'lark',
    externalId: 'oc_unknown:root-1',
    channelId: 'oc_unknown',
    rootMessageId: 'root-1',
    visibility: 'public',
  });

  assert.equal(thread.visibility, 'private');
  assert.equal(thread.metadata.larkChatInfoStatus, 'unavailable');
});

test('Lark file events normalize resource provenance without exposing raw JSON as text', () => {
  const normalized = normalizeLarkEvent(
    {
      event_id: 'event-1',
      event: {
        message: {
          message_id: 'message-1',
          root_id: 'root-1',
          chat_id: 'chat-1',
          chat_type: 'group',
          message_type: 'file',
          content: JSON.stringify({
            file_key: 'file-key-1',
            file_name: 'evidence.csv',
          }),
          create_time: '1786450000000',
          mentions: [{ id: { open_id: 'bot-1' }, name: 'MaxTag' }],
        },
        sender: {
          sender_id: { open_id: 'user-1' },
          tenant_key: 'tenant-1',
        },
      },
    },
    { botOpenId: 'bot-1' },
  );

  assert.ok(normalized);
  assert.equal(normalized.message.text, '');
  assert.equal(normalized.message.attachments.length, 1);
  assert.equal(normalized.message.attachments[0].name, 'evidence.csv');
  assert.equal(
    normalized.message.attachments[0].metadata.larkFileKey,
    'file-key-1',
  );
  assert.equal(
    normalized.message.attachments[0].metadata.larkResourceType,
    'file',
  );
});

test('Lark threaded events use the root message for routing and preserve thread_id for history import', () => {
  const normalized = normalizeLarkEvent(
    {
      event_id: 'event-thread',
      event: {
        message: {
          message_id: 'message-thread',
          root_id: 'root-message',
          parent_id: 'parent-message',
          thread_id: 'thread-container',
          chat_id: 'chat-thread',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'Follow this existing topic.' }),
          create_time: '1786450000000',
          mentions: [{ id: { open_id: 'bot-1' } }],
        },
        sender: {
          sender_id: { open_id: 'user-1' },
          tenant_key: 'tenant-1',
        },
      },
    },
    { botOpenId: 'bot-1' },
  );

  assert.ok(normalized);
  assert.equal(
    normalized.thread.externalId,
    'chat-thread:root-message',
  );
  assert.equal(normalized.thread.rootMessageId, 'root-message');
  assert.equal(normalized.thread.topicId, 'thread-container');
  assert.equal(normalized.thread.metadata.larkThreadId, 'thread-container');
  assert.equal(
    normalized.message.metadata.larkThreadId,
    'thread-container',
  );

  const history = normalizeLarkHistoryMessage(
    {
      message_id: 'history-1',
      thread_id: 'thread-container',
      msg_type: 'text',
      create_time: '1786450000001',
      sender: { id: 'user-2', sender_type: 'user' },
      body: { content: JSON.stringify({ text: 'Earlier point.' }) },
      mentions: [{ id: 'bot-1' }],
    },
    { thread: normalized.thread, botOpenId: 'bot-1' },
  );
  assert.equal(history.text, 'Earlier point.');
  assert.equal(history.mentionsAgent, true);
  assert.equal(history.metadata.larkThreadId, 'thread-container');
});

test('Lark topic root and later replies share one canonical MaxTag thread', () => {
  const event = (message) =>
    normalizeLarkEvent({
      event: {
        message: {
          chat_id: 'chat-topic',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@MaxTag continue' }),
          ...message,
        },
        sender: { sender_id: { open_id: 'user-1' } },
      },
    });
  const root = event({ message_id: 'om_root', thread_id: 'omt_topic' });
  const reply = event({
    message_id: 'om_reply',
    root_id: 'om_root',
    parent_id: 'om_root',
    thread_id: 'omt_topic',
  });

  assert.ok(root);
  assert.ok(reply);
  assert.equal(root.thread.id, 'lark:chat-topic:om_root');
  assert.equal(reply.thread.id, root.thread.id);
  assert.equal(reply.thread.rootMessageId, 'om_root');
  assert.equal(reply.thread.topicId, 'omt_topic');
});

test('Lark webhook top-level group messages share one stable main conversation', () => {
  const event = (messageId) =>
    normalizeLarkEvent({
      event: {
        message: {
          message_id: messageId,
          chat_id: 'chat-group',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@MaxTag continue' }),
        },
        sender: { sender_id: { open_id: 'user-1' } },
      },
    });
  const first = event('om_first');
  const second = event('om_second');

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.thread.id, 'lark:chat-group:main');
  assert.equal(second.thread.id, first.thread.id);
  assert.equal(first.thread.rootMessageId, 'om_first');
  assert.equal(second.thread.rootMessageId, 'om_second');
  assert.equal(first.thread.topicId, undefined);
});

test('Lark webhook regular group replies without thread_id stay in main', () => {
  const event = (message) => normalizeLarkEvent({
    event: {
      message: {
        chat_id: 'chat-group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@MaxTag continue' }),
        ...message,
      },
      sender: { sender_id: { open_id: 'user-1' } },
    },
  });
  const root = event({ message_id: 'om_root' });
  const reply = event({
    message_id: 'om_reply',
    root_id: 'om_root',
    parent_id: 'om_root',
  });

  assert.ok(root);
  assert.ok(reply);
  assert.equal(reply.thread.id, root.thread.id);
  assert.equal(reply.thread.topicId, undefined);
  assert.equal(reply.thread.rootMessageId, 'om_root');
});

test('Lark p2p events share one stable chat thread across messages', () => {
  const event = (messageId) =>
    normalizeLarkEvent(
      {
        event_id: `event-${messageId}`,
        event: {
          message: {
            message_id: messageId,
            chat_id: 'chat-direct',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: `Message ${messageId}` }),
            create_time: '1786450000000',
          },
          sender: {
            sender_id: { open_id: 'user-1' },
            tenant_key: 'tenant-1',
          },
        },
      },
      { botOpenId: 'bot-1' },
    );

  const first = event('message-direct-1');
  const second = event('message-direct-2');
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.thread.id, 'lark:chat-direct');
  assert.equal(second.thread.id, first.thread.id);
  assert.equal(first.thread.externalId, 'chat-direct');
  assert.equal(first.thread.rootMessageId, undefined);
  assert.equal(first.thread.topicId, undefined);
  assert.equal(first.message.mentionsAgent, true);
});

test('Lark thread history hydration imports prior messages without failing the run', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opentag-lark-context-'),
  );
  try {
    const store = new FileDeliveryStore(root);
    const memory = new MemoryLarkTransport();
    memory.historyMessages.push(
      {
        message_id: 'history-1',
        thread_id: 'thread-import',
        chat_id: 'chat-1',
        msg_type: 'text',
        create_time: '1786450000000',
        sender: { id: 'user-1', sender_type: 'user' },
        body: { content: JSON.stringify({ text: 'First context.' }) },
      },
      {
        message_id: 'history-bot',
        thread_id: 'thread-import',
        chat_id: 'chat-1',
        msg_type: 'text',
        create_time: '1786450001000',
        sender: { id: 'app-1', sender_type: 'app' },
        body: { content: JSON.stringify({ text: 'Ignore bot echo.' }) },
      },
      {
        message_id: 'current-message',
        thread_id: 'thread-import',
        chat_id: 'chat-1',
        msg_type: 'text',
        create_time: '1786450002000',
        sender: { id: 'user-2', sender_type: 'user' },
        body: { content: JSON.stringify({ text: 'Current request.' }) },
      },
    );
    const thread = {
      id: 'lark:chat-1:thread-import',
      platform: 'lark',
      externalId: 'chat-1:thread-import',
      workspaceId: 'tenant-1',
      projectId: 'chat-1',
      channelId: 'chat-1',
      rootMessageId: 'root-1',
      topicId: 'thread-import',
      visibility: 'public',
      metadata: { larkThreadId: 'thread-import' },
    };
    const current = await store.createAgentRunOrSteer({
      runId: 'lark-import-run',
      thread,
      message: {
        id: 'current-message',
        threadId: thread.id,
        platform: 'lark',
        text: 'Current request.',
        actor: { id: 'user-2' },
        createdAt: new Date('2026-01-01T00:00:02.000Z').toISOString(),
        mentionsAgent: true,
        metadata: { larkThreadId: 'thread-import' },
      },
    });

    const result = await hydrateLarkThreadContext({
      deliveryStore: store,
      run: current.run,
      transport: memory,
      maxMessages: 50,
    });
    assert.equal(result.attempted, true);
    assert.equal(result.importedMessages, 2);
    assert.equal(result.duplicateMessages, 0);

    const transcript = await store.loadThreadTranscript({
      thread,
      excludeRunId: current.run.id,
    });
    assert.deepEqual(
      transcript.entries.map((entry) => [entry.source, entry.text]),
      [['source_message', 'First context.']],
    );
    assert.ok(
      (await store.listAgentRunEvents(current.run.id)).some(
        (event) => event.type === 'thread_context_imported',
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP Lark transport uploads files, replies with a file key, and downloads resources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-http-'));
  const localFile = path.join(root, 'report.csv');
  const localImage = path.join(root, 'preview.png');
  const requests = [];
  try {
    await fs.writeFile(localFile, 'a,b\n1,2\n');
    await fs.writeFile(
      localImage,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+cv6WAAAAAElFTkSuQmCC',
        'base64',
      ),
    );
    const transport = new HttpLarkTransport({
      appId: 'app-id',
      appSecret: 'app-secret',
      baseUrl: 'https://lark.example',
      fetch: async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('/tenant_access_token/internal')) {
          return new Response(
            JSON.stringify({
              code: 0,
              tenant_access_token: 'tenant-token',
              expire: 7200,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/open-apis/im/v1/chats/chat-1')) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                chat_id: 'chat-1',
                name: 'Release Room',
                chat_mode: 'group',
                chat_type: 'private',
                external: false,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/messages/message-1/reactions')) {
          assert.equal(options.method, 'POST');
          assert.deepEqual(JSON.parse(options.body), {
            reaction_type: { emoji_type: 'OnIt' },
          });
          return new Response(
            JSON.stringify({ code: 0, data: { reaction_id: 'reaction-1' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/messages/message-1/reactions/reaction-1')) {
          assert.equal(options.method, 'DELETE');
          return new Response(JSON.stringify({ code: 0, data: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/im/v1/files')) {
          assert.ok(options.body instanceof FormData);
          assert.equal(options.body.get('file_type'), 'stream');
          assert.equal(options.body.get('file_name'), 'report.csv');
          assert.ok(options.body.get('file') instanceof Blob);
          return new Response(
            JSON.stringify({ code: 0, data: { file_key: 'uploaded-file-key' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/im/v1/images')) {
          assert.ok(options.body instanceof FormData);
          assert.equal(options.body.get('image_type'), 'message');
          assert.ok(options.body.get('image') instanceof Blob);
          return new Response(
            JSON.stringify({ code: 0, data: { image_key: 'uploaded-image-key' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/messages/root-1/reply')) {
          const body = JSON.parse(options.body);
          assert.equal(body.msg_type, 'file');
          assert.deepEqual(JSON.parse(body.content), {
            file_key: 'uploaded-file-key',
          });
          return new Response(
            JSON.stringify({ code: 0, data: { message_id: 'sent-file-message' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/messages/root-2/reply')) {
          const body = JSON.parse(options.body);
          assert.equal(body.msg_type, 'image');
          assert.deepEqual(JSON.parse(body.content), {
            image_key: 'uploaded-image-key',
          });
          return new Response(
            JSON.stringify({ code: 0, data: { message_id: 'sent-image-message' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/messages/message-1/resources/file-key-1?type=file')) {
          assert.equal(options.headers.authorization, 'Bearer tenant-token');
          return new Response(new TextEncoder().encode('downloaded'), {
            status: 200,
            headers: {
              'content-disposition': "attachment; filename*=UTF-8''evidence.csv",
              'content-length': '10',
              'content-type': 'text/csv',
            },
          });
        }
        if (url.includes('/open-apis/im/v1/messages?')) {
          const parsed = new URL(url);
          assert.equal(parsed.searchParams.get('container_id_type'), 'thread');
          assert.equal(parsed.searchParams.get('container_id'), 'thread-1');
          assert.equal(
            parsed.searchParams.get('sort_type'),
            'ByCreateTimeAsc',
          );
          assert.equal(parsed.searchParams.get('page_size'), '50');
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                items: [{ message_id: 'history-1', thread_id: 'thread-1' }],
                has_more: true,
                page_token: 'next-page',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    assert.deepEqual(
      await transport.getChat('chat-1'),
      {
        chatId: 'chat-1',
        name: 'Release Room',
        description: undefined,
        chatMode: 'group',
        chatType: 'private',
        external: false,
      },
    );
    assert.deepEqual(
      await transport.addReaction({
        messageId: 'message-1',
        emojiType: 'OnIt',
      }),
      { reactionId: 'reaction-1' },
    );
    await transport.removeReaction({
      messageId: 'message-1',
      reactionId: 'reaction-1',
    });
    assert.deepEqual(
      await transport.sendFile({
        chatId: 'chat-1',
        rootId: 'root-1',
        file: { path: localFile, mimeType: 'text/csv' },
        metadata: { runId: 'run-1', artifactId: 'artifact-1' },
      }),
      { messageId: 'sent-file-message', messageType: 'file' },
    );
    assert.deepEqual(
      await transport.sendFile({
        chatId: 'chat-1',
        rootId: 'root-2',
        file: {
          path: localImage,
          name: 'preview.png',
          mimeType: 'image/png',
        },
        metadata: { runId: 'run-2', artifactId: 'artifact-image' },
      }),
      { messageId: 'sent-image-message', messageType: 'image' },
    );
    const downloaded = await transport.downloadMessageResource({
      messageId: 'message-1',
      fileKey: 'file-key-1',
      type: 'file',
      maxBytes: 100,
    });
    assert.equal(new TextDecoder().decode(downloaded.bytes), 'downloaded');
    assert.equal(downloaded.name, 'evidence.csv');
    assert.equal(downloaded.mimeType, 'text/csv');
    assert.deepEqual(
      await transport.listMessages({
        containerType: 'thread',
        containerId: 'thread-1',
        startTime: '1786400000',
        endTime: '1786500000',
        sortType: 'ByCreateTimeAsc',
        pageSize: 500,
      }),
      {
        items: [{ message_id: 'history-1', thread_id: 'thread-1' }],
        hasMore: true,
        pageToken: 'next-page',
      },
    );
    const historyRequest = requests.find((request) =>
      request.url.includes('/open-apis/im/v1/messages?'),
    );
    assert.equal(
      new URL(historyRequest.url).searchParams.get('start_time'),
      '1786400000',
    );
    assert.equal(
      new URL(historyRequest.url).searchParams.get('end_time'),
      '1786500000',
    );
    assert.equal(
      requests.filter((request) => request.url.endsWith('/tenant_access_token/internal')).length,
      1,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Lark adapter sends managed artifacts through tracked file delivery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-adapter-'));
  try {
    const store = new FileDeliveryStore(root);
    const memory = new MemoryLarkTransport();
    const adapter = new LarkPlatformAdapter(
      new TrackedLarkTransport(memory, store),
    );
    const thread = {
      id: 'lark:chat-1:root-1',
      platform: 'lark',
      externalId: 'chat-1:root-1',
      workspaceId: 'acme',
      projectId: 'payments',
      channelId: 'chat-1',
      rootMessageId: 'root-1',
      visibility: 'public',
    };
    await adapter.sendMessage(
      thread,
      'Report complete.',
      [
        {
          id: 'artifact-1',
          kind: 'report',
          title: 'Report',
          path: '/managed/report.csv',
          metadata: { mimeType: 'text/csv' },
        },
      ],
      { runId: 'run-1', replyToMessageId: 'message-1' },
    );

    assert.equal(memory.texts.length, 1);
    assert.equal(memory.files.length, 1);
    assert.equal(memory.files[0].metadata.artifactId, 'artifact-1');
    assert.equal(memory.files[0].replyToMessageId, 'message-1');
    const outbox = await store.listOutbox({ runId: 'run-1', limit: 20 });
    assert.ok(outbox.some((item) => item.kind === 'lark.text'));
    assert.ok(outbox.some((item) => item.kind === 'lark.file'));
    assert.ok(outbox.every((item) => item.status === 'delivered'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Lark adapter mirrors AgentDock OnIt acknowledgement lifecycle', async () => {
  const memory = new MemoryLarkTransport();
  const adapter = new LarkPlatformAdapter(memory);

  await adapter.setMessageProcessingReaction('message-1', true);
  await adapter.setMessageProcessingReaction('message-1', true);
  assert.deepEqual(memory.reactions, [
    {
      messageId: 'message-1',
      reactionId: 'reaction_1',
      emojiType: 'OnIt',
    },
  ]);

  await adapter.setMessageProcessingReaction('message-1', false);
  await adapter.setMessageProcessingReaction('message-1', false);
  assert.deepEqual(memory.reactions, []);
});

test('transient Lark progress timeouts do not fail work or replay stale card state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-progress-timeout-'));
  try {
    class FlakyUpdateTransport extends MemoryLarkTransport {
      failNextUpdate = true;

      async updateCard(input) {
        if (this.failNextUpdate) {
          this.failNextUpdate = false;
          throw new Error('Lark API request failed with HTTP 504.');
        }
        return super.updateCard(input);
      }
    }

    const store = new FileDeliveryStore(root);
    const memory = new FlakyUpdateTransport();
    const adapter = new LarkPlatformAdapter(
      new TrackedLarkTransport(memory, store),
    );
    const thread = {
      id: 'lark:chat-timeout:main',
      platform: 'lark',
      externalId: 'chat-timeout:main',
      workspaceId: 'acme',
      projectId: 'payments',
      channelId: 'chat-timeout',
      visibility: 'private',
    };
    const progress = adapter.createProgressSurface(thread);
    const initial = {
      runId: 'run-progress-timeout',
      title: 'Working on MaxTag',
      status: 'running',
      checklist: [{ id: 'work', label: 'Run Codex', status: 'running' }],
      updatedAt: new Date().toISOString(),
    };
    const { surfaceId } = await progress.create(initial);

    await progress.update(surfaceId, initial);
    await progress.update(surfaceId, {
      ...initial,
      checklist: [{ id: 'work', label: 'Run Codex', status: 'done' }],
    });

    const updates = (await store.listOutbox({
      runId: initial.runId,
      limit: 20,
    }))
      .filter((item) => item.kind === 'lark.card.update')
      .sort((left, right) => left.sequence - right.sequence);
    assert.equal(updates.length, 2);
    assert.equal(updates[0].status, 'cancelled');
    assert.equal(updates[0].lastError, 'superseded_by_newer_card_update');
    assert.equal(updates[1].status, 'delivered');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('successful Lark runs remove the transient progress card after the reply is delivered', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-progress-'));
  try {
    const store = new FileDeliveryStore(root);
    const memory = new MemoryLarkTransport();
    const adapter = new LarkPlatformAdapter(new TrackedLarkTransport(memory, store));
    const thread = {
      id: 'lark:chat-progress:main',
      platform: 'lark',
      externalId: 'chat-progress:main',
      workspaceId: 'acme',
      projectId: 'payments',
      channelId: 'chat-progress',
      visibility: 'public',
    };
    const progress = adapter.createProgressSurface(thread);
    const initial = {
      runId: 'run-progress-cleanup',
      title: 'Working on MaxTag',
      status: 'running',
      checklist: [{ id: 'work', label: 'Run Codex', status: 'running' }],
      updatedAt: new Date().toISOString(),
    };
    const { surfaceId } = await progress.create(initial);
    assert.equal(memory.cards.length, 1);
    await progress.complete(surfaceId, {
      ...initial,
      status: 'completed',
      checklist: [{ id: 'work', label: 'Run Codex', status: 'done' }],
    });
    assert.equal(memory.cards.length, 0);
    const outbox = await store.listOutbox({ runId: initial.runId, limit: 20 });
    assert.ok(outbox.some((item) => item.kind === 'lark.card.delete'));
    assert.ok(outbox.every((item) => item.status === 'delivered'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed Lark runs keep a concise diagnostic card', async () => {
  const memory = new MemoryLarkTransport();
  const adapter = new LarkPlatformAdapter(memory);
  const thread = {
    id: 'lark:chat-progress-failed:main',
    platform: 'lark',
    externalId: 'chat-progress-failed:main',
    channelId: 'chat-progress-failed',
    visibility: 'public',
  };
  const progress = adapter.createProgressSurface(thread);
  const state = {
    runId: 'run-progress-failed',
    title: 'Working on MaxTag',
    status: 'failed',
    summary: 'Provider unavailable.',
    checklist: [{ id: 'work', label: 'Run Codex', status: 'failed' }],
    updatedAt: new Date().toISOString(),
  };
  const { surfaceId } = await progress.create({ ...state, status: 'running' });
  await progress.complete(surfaceId, state);
  assert.equal(memory.cards.length, 1);
  assert.match(JSON.stringify(memory.cards[0].card), /执行失败/u);
});

test('tracked Lark cards persist an exact external receipt for action callbacks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-receipt-'));
  try {
    const store = new FileDeliveryStore(root);
    const memory = new MemoryLarkTransport();
    const tracked = new TrackedLarkTransport(memory, store);
    const thread = {
      id: 'lark:chat-card:root-card',
      platform: 'lark',
      externalId: 'chat-card:root-card',
      workspaceId: 'acme',
      projectId: 'payments',
      channelId: 'chat-card',
      rootMessageId: 'root-card',
      visibility: 'public',
    };

    const created = await tracked.createCard({
      chatId: 'chat-card',
      card: { elements: [] },
      metadata: {
        runId: 'run-card-receipt',
        thread,
        stage: 'progress-card',
      },
    });
    const receipt = await store.getDeliveredOutboundByExternalId({
      platform: 'lark',
      externalId: created.cardId,
      kind: 'lark.card.create',
    });

    assert.ok(receipt);
    assert.equal(receipt.runId, 'run-card-receipt');
    assert.equal(receipt.threadId, thread.id);
    assert.equal(receipt.workspaceId, 'acme');
    assert.equal(receipt.projectId, 'payments');
    assert.equal(receipt.target.chatId, 'chat-card');
    assert.equal(receipt.externalId, created.cardId);
    assert.equal(
      await store.getDeliveredOutboundByExternalId({
        platform: 'telegram',
        externalId: created.cardId,
      }),
      undefined,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
