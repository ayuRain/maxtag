import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileDeliveryStore,
  TrackedTelegramTransport,
} from '@opentag/delivery';
import {
  HttpTelegramTransport,
  MemoryTelegramTransport,
  TelegramApiError,
  TelegramPlatformAdapter,
  normalizeTelegramUpdate,
  parseAndValidateTelegramCallback,
  splitTelegramText,
  telegramCallbackEventType,
  telegramCallbackExternalId,
} from '@opentag/platform-telegram';

function telegramUpdate(overrides = {}) {
  return {
    update_id: 9001,
    message: {
      message_id: 41,
      message_thread_id: 77,
      date: 1_786_450_000,
      chat: { id: -100123, type: 'supergroup', title: 'MaxTag Lab' },
      from: {
        id: 88,
        is_bot: false,
        first_name: 'Ada',
        username: 'ada',
      },
      text: '/maxtag@MaxTagBot check this',
      entities: [{ type: 'bot_command', offset: 0, length: 19 }],
      document: {
        file_id: 'file-1',
        file_unique_id: 'unique-1',
        file_name: 'trace.txt',
        mime_type: 'text/plain',
        file_size: 123,
      },
      ...overrides,
    },
  };
}

test('Telegram callback validates the webhook secret and exposes stable ids', () => {
  const raw = JSON.stringify(telegramUpdate());
  const accepted = parseAndValidateTelegramCallback(
    raw,
    { 'x-telegram-bot-api-secret-token': 'secret-1' },
    { webhookSecret: 'secret-1' },
  );
  assert.equal(accepted.validation.ok, true);
  assert.equal(telegramCallbackExternalId(accepted.body), 'update:9001');
  assert.equal(telegramCallbackEventType(accepted.body), 'message');

  const rejected = parseAndValidateTelegramCallback(
    raw,
    { 'x-telegram-bot-api-secret-token': 'wrong' },
    { webhookSecret: 'secret-1' },
  );
  assert.deepEqual(rejected.validation, {
    ok: false,
    statusCode: 401,
    reason: 'invalid_webhook_secret',
  });
  assert.equal(
    parseAndValidateTelegramCallback('{', {}).validation.ok,
    false,
  );
});

test('Telegram updates normalize forum topics, mentions, actors, and files', () => {
  const normalized = normalizeTelegramUpdate(telegramUpdate(), {
    botUsername: 'MaxTagBot',
    workspaceId: 'acme',
  });
  assert.ok(normalized);
  assert.equal(normalized.thread.id, 'telegram:-100123:77');
  assert.equal(normalized.thread.externalId, '-100123:77');
  assert.equal(normalized.thread.channelId, '-100123');
  assert.equal(normalized.thread.topicId, '77');
  assert.equal(normalized.thread.workspaceId, 'acme');
  assert.equal(normalized.thread.projectId, '-100123');
  assert.equal(normalized.message.mentionsAgent, true);
  assert.equal(normalized.message.actor.displayName, 'Ada');
  assert.equal(normalized.message.attachments[0].kind, 'file');
  assert.equal(
    normalized.message.attachments[0].metadata.telegramFileId,
    'file-1',
  );

  const direct = normalizeTelegramUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: 1_786_450_000,
      chat: { id: 99, type: 'private', first_name: 'Lin' },
      from: { id: 99, first_name: 'Lin' },
      text: 'hello',
    },
  });
  assert.equal(direct.thread.visibility, 'direct');
  assert.equal(direct.message.mentionsAgent, true);

  assert.equal(
    normalizeTelegramUpdate(
      telegramUpdate({ from: { id: 1, is_bot: true }, text: 'loop' }),
    ),
    null,
  );

  const wrongBot = normalizeTelegramUpdate(
    telegramUpdate({
      text: '/opentag@AnotherBot check this',
      entities: [{ type: 'bot_command', offset: 0, length: 19 }],
    }),
    { botUsername: 'MaxTagBot' },
  );
  assert.equal(wrongBot.message.mentionsAgent, false);
});

test('HTTP Telegram transport sends topic replies and surfaces API retry metadata', async () => {
  const requests = [];
  const transport = new HttpTelegramTransport({
    botToken: 'token',
    baseUrl: 'https://telegram.example',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: requests.length } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  assert.deepEqual(
    await transport.sendText({
      chatId: '-100123',
      text: 'hello',
      messageThreadId: '77',
      replyToMessageId: '41',
    }),
    { messageId: '1' },
  );
  await transport.editText({ chatId: '-100123', messageId: '1', text: 'done' });
  await transport.sendDocument({
    chatId: '-100123',
    document: { url: 'https://example.com/report.txt' },
    caption: 'report',
    messageThreadId: '77',
  });

  assert.match(requests[0].url, /\/bottoken\/sendMessage$/);
  const sendBody = JSON.parse(requests[0].options.body);
  assert.equal(sendBody.chat_id, '-100123');
  assert.equal(sendBody.message_thread_id, 77);
  assert.deepEqual(sendBody.reply_parameters, {
    message_id: 41,
    allow_sending_without_reply: true,
  });
  assert.match(requests[1].url, /\/editMessageText$/);
  assert.match(requests[2].url, /\/sendDocument$/);

  const failing = new HttpTelegramTransport({
    botToken: 'token',
    fetch: async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 4 },
        }),
        { status: 429 },
      ),
  });
  await assert.rejects(
    failing.sendText({ chatId: '1', text: 'wait' }),
    (error) =>
      error instanceof TelegramApiError &&
      error.code === 429 &&
      error.retryAfter === 4,
  );
});

test('HTTP Telegram transport resolves and bounds native file downloads', async () => {
  const requests = [];
  const transport = new HttpTelegramTransport({
    botToken: 'token',
    baseUrl: 'https://telegram.example',
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/bottoken/getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              file_id: 'file-1',
              file_size: 8,
              file_path: 'documents/evidence 1.txt',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/file/bottoken/documents/evidence%201.txt')) {
        return new Response(new TextEncoder().encode('evidence'), {
          status: 200,
          headers: { 'content-length': '8' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await transport.downloadFile({ fileId: 'file-1', maxBytes: 20 });
  assert.equal(new TextDecoder().decode(result.bytes), 'evidence');
  assert.equal(result.name, 'evidence 1.txt');
  assert.equal(result.sizeBytes, 8);
  assert.equal(requests.length, 2);

  await assert.rejects(
    transport.downloadFile({ fileId: 'file-1', maxBytes: 4 }),
    (error) => error instanceof TelegramApiError && error.statusCode === 413,
  );
});

test('Telegram adapter edits progress, chunks replies, sends files, and tracks delivery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-telegram-'));
  try {
    const store = new FileDeliveryStore(root);
    const memory = new MemoryTelegramTransport();
    const adapter = new TelegramPlatformAdapter(
      new TrackedTelegramTransport(memory, store),
    );
    const thread = {
      id: 'telegram:-100123:77',
      platform: 'telegram',
      externalId: '-100123:77',
      workspaceId: 'acme',
      projectId: 'payments',
      channelId: '-100123',
      topicId: '77',
      visibility: 'public',
      metadata: { incomingMessageId: '41' },
    };
    const progress = adapter.createProgressSurface(thread);
    const created = await progress.create({
      runId: 'run-1',
      title: 'Investigate',
      status: 'running',
      checklist: [{ id: 'one', label: 'Inspect', status: 'running' }],
      updatedAt: new Date().toISOString(),
    });
    await progress.complete(created.surfaceId, {
      runId: 'run-1',
      title: 'Investigate',
      status: 'completed',
      summary: 'Done',
      checklist: [{ id: 'one', label: 'Inspect', status: 'done' }],
      updatedAt: new Date().toISOString(),
    });
    await adapter.sendMessage(
      thread,
      `start ${'x'.repeat(8_500)} end`,
      [{ id: 'file-1', kind: 'file', title: 'report.txt', path: '/tmp/report.txt' }],
      { runId: 'run-1', replyToMessageId: '41' },
    );

    assert.equal(memory.texts[0].messageThreadId, '77');
    assert.equal(memory.texts[0].replyToMessageId, '41');
    assert.equal(memory.edits.length, 1);
    const replies = memory.texts.slice(1);
    assert.ok(replies.length >= 3);
    assert.ok(replies.every((item) => item.text.length <= 4_000));
    assert.equal(replies[0].replyToMessageId, '41');
    assert.ok(replies.slice(1).every((item) => !item.replyToMessageId));
    assert.equal(memory.documents.length, 1);
    assert.equal(memory.documents[0].messageThreadId, '77');

    const outbox = await store.listOutbox({ limit: 20 });
    assert.ok(outbox.every((item) => item.status === 'delivered'));
    assert.ok(outbox.some((item) => item.kind === 'telegram.progress.create'));
    assert.ok(outbox.some((item) => item.kind === 'telegram.progress.update'));
    assert.ok(outbox.some((item) => item.kind === 'telegram.text'));
    assert.ok(outbox.some((item) => item.kind === 'telegram.document'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Telegram text chunking keeps surrogate pairs intact', () => {
  const text = '😀'.repeat(5_000);
  const chunks = splitTelegramText(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4_000));
  assert.equal(chunks.join(''), text);
});
