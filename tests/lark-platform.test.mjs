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
  normalizeLarkEvent,
} from '@opentag/platform-lark';

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
          mentions: [{ id: { open_id: 'bot-1' }, name: 'OpenTag' }],
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

test('HTTP Lark transport uploads files, replies with a file key, and downloads resources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-http-'));
  const localFile = path.join(root, 'report.csv');
  const requests = [];
  try {
    await fs.writeFile(localFile, 'a,b\n1,2\n');
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
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    assert.deepEqual(
      await transport.sendFile({
        chatId: 'chat-1',
        rootId: 'root-1',
        file: { path: localFile, mimeType: 'text/csv' },
        metadata: { runId: 'run-1', artifactId: 'artifact-1' },
      }),
      { messageId: 'sent-file-message' },
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
