import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDeliveryStore, TrackedSlackTransport } from '@opentag/delivery';
import {
  HttpSlackTransport,
  MemorySlackTransport,
  SlackApiError,
  SlackPlatformAdapter,
  normalizeSlackEvent,
  parseAndValidateSlackCallback,
  slackRequestSignature,
  splitSlackText,
} from '@opentag/platform-slack';

test('Slack callback validation matches the official signing recipe and rejects replay', () => {
  const rawBody = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
  const timestamp = '1531420618';
  const signingSecret = '8f742231b10e8888abcd99yyyzzz85a5';
  const signature = slackRequestSignature({ signingSecret, timestamp, rawBody });
  assert.equal(
    signature,
    'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
  );
  const parsed = parseAndValidateSlackCallback(
    rawBody,
    {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    {
      signingSecret,
      maxSkewSeconds: 0,
    },
  );
  assert.equal(parsed.validation.reason, 'invalid_json');
  assert.equal(
    parseAndValidateSlackCallback(rawBody, {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': 'v0=wrong',
    }, {
      signingSecret,
      maxSkewSeconds: 0,
    }).validation.reason,
    'invalid_signature',
  );

  const body = JSON.stringify({ type: 'url_verification', challenge: 'hello' });
  const now = 1_786_450_000_000;
  const currentTimestamp = String(now / 1000);
  const headers = {
    'x-slack-request-timestamp': currentTimestamp,
    'x-slack-signature': slackRequestSignature({
      signingSecret,
      timestamp: currentTimestamp,
      rawBody: body,
    }),
  };
  assert.deepEqual(
    parseAndValidateSlackCallback(body, headers, {
      signingSecret,
      now: () => now,
    }).validation,
    { ok: true },
  );
  assert.equal(
    parseAndValidateSlackCallback(body, headers, {
      signingSecret,
      now: () => now + 301_000,
    }).validation.reason,
    'stale_request',
  );
  assert.equal(
    parseAndValidateSlackCallback(body, headers, {}).validation.reason,
    'signing_secret_not_configured',
  );
});

test('Slack app mentions, DMs, threads, files, and bot-loop guards normalize', () => {
  const mention = normalizeSlackEvent({
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev1',
    event: {
      type: 'app_mention',
      user: 'U1',
      text: '<@UBOT> inspect',
      ts: '1786450000.000100',
      channel: 'C1',
      channel_type: 'channel',
      files: [
        {
          id: 'F1',
          name: 'evidence.txt',
          mimetype: 'text/plain',
          size: 8,
          url_private_download: 'https://files.slack.com/files-pri/evidence.txt',
        },
      ],
    },
  });
  assert.equal(mention.thread.id, 'slack:C1:1786450000.000100');
  assert.equal(mention.thread.visibility, 'public');
  assert.equal(mention.thread.rootMessageId, '1786450000.000100');
  assert.equal(mention.message.mentionsAgent, true);
  assert.equal(mention.message.text, 'inspect');
  assert.equal(mention.message.attachments[0].metadata.slackFileId, 'F1');

  const reply = normalizeSlackEvent({
    type: 'event_callback',
    event_id: 'Ev2',
    event: {
      type: 'app_mention',
      user: 'U1',
      text: '<@UBOT> continue',
      ts: '1786450001.000101',
      thread_ts: '1786450000.000100',
      channel: 'C1',
    },
  });
  assert.equal(reply.thread.id, mention.thread.id);

  const unknownChannel = normalizeSlackEvent({
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: 'U1',
      text: '<@UBOT> private by default',
      ts: '1786450001.000102',
      channel: 'C_UNKNOWN',
    },
  }, { botUserId: 'UBOT' });
  assert.equal(unknownChannel.thread.visibility, 'private');
  assert.equal(unknownChannel.message.text, 'private by default');

  const direct = normalizeSlackEvent({
    type: 'event_callback',
    event: {
      type: 'message',
      user: 'U2',
      text: 'hello',
      ts: '1786450002.000102',
      channel: 'D1',
      channel_type: 'im',
    },
  });
  assert.equal(direct.thread.visibility, 'direct');
  assert.equal(direct.thread.id, 'slack:D1');
  assert.equal(direct.thread.rootMessageId, undefined);
  assert.equal(direct.message.mentionsAgent, true);
  const directContinuation = normalizeSlackEvent({
    type: 'event_callback',
    event: {
      type: 'message',
      user: 'U2',
      text: 'continue',
      ts: '1786450003.000104',
      channel: 'D1',
      channel_type: 'im',
    },
  });
  assert.equal(directContinuation.thread.id, direct.thread.id);
  assert.equal(
    normalizeSlackEvent({
      type: 'event_callback',
      event: {
        type: 'message',
        bot_id: 'B1',
        text: 'loop',
        ts: '1786450003.000103',
        channel: 'D1',
        channel_type: 'im',
      },
    }),
    null,
  );
});

test('HTTP Slack transport posts, updates, uploads, downloads, and exposes retry metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-slack-http-'));
  try {
    const filePath = path.join(root, 'report.txt');
    await fs.writeFile(filePath, 'report');
    const requests = [];
    const transport = new HttpSlackTransport({
      botToken: 'xoxb-test',
      baseUrl: 'https://slack.example/api',
      fetch: async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith('/chat.postMessage')) {
          return new Response(JSON.stringify({ ok: true, ts: '1.1' }));
        }
        if (String(url).endsWith('/chat.update')) {
          return new Response(JSON.stringify({ ok: true, ts: '1.1' }));
        }
        if (String(url).endsWith('/files.getUploadURLExternal')) {
          return new Response(JSON.stringify({
            ok: true,
            upload_url: 'https://files.slack.com/upload/v1/ticket',
            file_id: 'F1',
          }));
        }
        if (String(url).includes('/upload/v1/ticket')) return new Response('ok');
        if (String(url).endsWith('/files.completeUploadExternal')) {
          return new Response(JSON.stringify({ ok: true, files: [{ id: 'F1' }] }));
        }
        if (String(url).includes('/files-pri/evidence.txt')) {
          return new Response(new TextEncoder().encode('evidence'), {
            headers: { 'content-length': '8', 'content-type': 'text/plain' },
          });
        }
        throw new Error(`unexpected request ${url}`);
      },
    });
    assert.deepEqual(
      await transport.sendText({ channelId: 'C1', text: 'hello', threadTs: '1.0' }),
      { messageId: '1.1' },
    );
    await transport.editText({ channelId: 'C1', messageId: '1.1', text: 'done' });
    assert.deepEqual(
      await transport.sendFile({
        channelId: 'C1',
        file: { path: filePath, title: 'Report' },
        threadTs: '1.0',
      }),
      { fileId: 'F1', messageId: undefined },
    );
    const downloaded = await transport.downloadFile({
      url: 'https://files.slack.com/files-pri/evidence.txt',
      maxBytes: 20,
    });
    assert.equal(new TextDecoder().decode(downloaded.bytes), 'evidence');
    assert.equal(requests[0].options.headers.authorization, 'Bearer xoxb-test');
    assert.equal(JSON.parse(requests[0].options.body).thread_ts, '1.0');
    assert.equal(JSON.parse(requests[4].options.body).thread_ts, '1.0');

    const failing = new HttpSlackTransport({
      botToken: 'xoxb-test',
      fetch: async () => new Response(
        JSON.stringify({ ok: false, error: 'ratelimited' }),
        { status: 429, headers: { 'retry-after': '4' } },
      ),
    });
    await assert.rejects(
      failing.sendText({ channelId: 'C1', text: 'wait' }),
      (error) => error instanceof SlackApiError && error.retryAfter === 4,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Slack adapter edits progress, chunks thread replies, uploads files, and tracks delivery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-slack-'));
  try {
    const store = new FileDeliveryStore(root);
    const memory = new MemorySlackTransport();
    const adapter = new SlackPlatformAdapter(
      new TrackedSlackTransport(memory, store),
    );
    const thread = {
      id: 'slack:C1:1786450000.000100',
      platform: 'slack',
      externalId: 'C1:1786450000.000100',
      workspaceId: 'acme',
      projectId: 'payments',
      channelId: 'C1',
      rootMessageId: '1786450000.000100',
      topicId: '1786450000.000100',
      visibility: 'public',
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
      checklist: [{ id: 'one', label: 'Inspect', status: 'done' }],
      updatedAt: new Date().toISOString(),
    });
    await adapter.sendMessage(
      thread,
      `start ${'x'.repeat(8_500)} end`,
      [{ id: 'f', kind: 'file', title: 'report.txt', path: '/tmp/report.txt' }],
      { runId: 'run-1' },
    );
    assert.equal(memory.texts[0].threadTs, '1786450000.000100');
    assert.equal(memory.edits.length, 1);
    assert.ok(memory.texts.slice(1).length >= 3);
    assert.ok(memory.texts.slice(1).every((item) => item.text.length <= 3_900));
    assert.equal(memory.files.length, 1);
    const outbox = await store.listOutbox({ limit: 20 });
    assert.ok(outbox.every((item) => item.status === 'delivered'));
    for (const kind of [
      'slack.progress.create',
      'slack.progress.update',
      'slack.text',
      'slack.file',
    ]) assert.ok(outbox.some((item) => item.kind === kind));
    const emoji = '😀'.repeat(5_000);
    assert.equal(splitSlackText(emoji).join(''), emoji);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
