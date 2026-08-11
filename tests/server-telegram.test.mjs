import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error('failed_to_reserve_test_port');
  return port;
}

async function waitForJson(url, predicate, child, logs, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (response.ok && predicate(data)) return data;
      lastError = new Error(`unexpected response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message}\n${logs.join('')}`);
}

function update(
  updateId,
  text = '/opentag@OpenTagBot inspect this topic',
  messageThreadId = 77,
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId - 8_000,
      message_thread_id: messageThreadId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: -100123, type: 'supergroup', title: 'OpenTag Lab' },
      from: { id: 42, is_bot: false, first_name: 'Ada' },
      text,
      entities: text.startsWith('/opentag')
        ? [{ type: 'bot_command', offset: 0, length: 19 }]
        : [],
    },
  };
}

test(
  'native Telegram webhook routes a topic into a tracked project run',
  { timeout: 20_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-telegram-api-'));
    const port = await freePort();
    const logs = [];
    const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_EXECUTOR_MODE: 'dry-run',
        OPENTAG_LARK_REQUIRE_BINDING: 'true',
        OPENTAG_TELEGRAM_TRANSPORT: 'memory',
        OPENTAG_TELEGRAM_BOT_USERNAME: 'OpenTagBot',
        OPENTAG_TELEGRAM_WEBHOOK_SECRET: 'integration-secret',
        OPENTAG_TELEGRAM_REQUIRE_BINDING: 'true',
        OPENTAG_AGENT_WORKER: 'inline',
        OPENTAG_AGENT_WORKER_INTERVAL_MS: '50',
        OPENTAG_ROUTINES_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
    context.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForJson(
      `${baseUrl}/health`,
      (data) => data.ok === true,
      child,
      logs,
    );
    assert.equal(health.clients.telegram.mode, 'memory');
    assert.equal(health.clients.telegram.webhookSecretConfigured, true);
    assert.equal(health.clients.lark.requireBinding, true);

    const larkBlockedResponse = await fetch(`${baseUrl}/v1/lark/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event_id: 'lark-blocked-event-1',
        event: {
          message: {
            message_id: 'om_blocked_1',
            chat_id: 'oc_unpaired',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'hello before pairing' }),
            create_time: String(Date.now()),
          },
          sender: {
            sender_id: { open_id: 'ou_unpaired_user' },
            tenant_key: 'dev-workspace',
          },
        },
      }),
    });
    assert.equal(larkBlockedResponse.status, 202);
    assert.equal((await larkBlockedResponse.json()).reason, 'binding_required');

    const capabilityResponse = await fetch(`${baseUrl}/v1/capabilities`);
    const capabilities = await capabilityResponse.json();
    assert.equal(
      capabilities.clients.find((client) => client.id === 'telegram').status,
      'ready',
    );

    const larkInvitationResponse = await fetch(
      `${baseUrl}/v1/pairing-invitations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'lark',
          workspaceId: 'dev-workspace',
          projectId: 'opentag',
          activationMode: 'mention',
          requireMention: true,
        }),
      },
    );
    assert.equal(larkInvitationResponse.status, 201);
    const larkInvitation = await larkInvitationResponse.json();
    const larkPairResponse = await fetch(`${baseUrl}/v1/lark/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event_id: 'lark-pair-event-1',
        event: {
          message: {
            message_id: 'om_pair_1',
            chat_id: 'oc_pairing',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: `/pair ${larkInvitation.code}` }),
            create_time: String(Date.now()),
          },
          sender: {
            sender_id: { open_id: 'ou_pairing_user' },
            tenant_key: 'dev-workspace',
          },
        },
      }),
    });
    assert.equal(larkPairResponse.status, 200);
    const larkPaired = await larkPairResponse.json();
    assert.equal(larkPaired.paired, true);
    assert.equal(larkPaired.binding.platform, 'lark');
    assert.equal(larkPaired.binding.externalId, 'oc_pairing');
    assert.equal(larkPaired.binding.projectId, 'opentag');

    const blockedResponse = await fetch(`${baseUrl}/v1/telegram/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'integration-secret',
      },
      body: JSON.stringify(update(8_999)),
    });
    assert.equal(blockedResponse.status, 202);
    const blocked = await blockedResponse.json();
    assert.equal(blocked.reason, 'binding_required');
    assert.equal(blocked.notice.notified, true);

    const invitationResponse = await fetch(`${baseUrl}/v1/pairing-invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'telegram',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        activationMode: 'mention',
        requireMention: true,
      }),
    });
    assert.equal(invitationResponse.status, 201);
    const invitation = await invitationResponse.json();
    assert.match(invitation.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    const pairResponse = await fetch(`${baseUrl}/v1/telegram/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'integration-secret',
      },
      body: JSON.stringify(update(9_000, `/pair ${invitation.code}`)),
    });
    assert.equal(pairResponse.status, 200);
    const paired = await pairResponse.json();
    assert.equal(paired.paired, true);
    assert.equal(paired.binding.externalId, '-100123');
    assert.equal(paired.binding.scope, 'channel');
    assert.equal(paired.binding.source, 'configured');
    assert.equal(paired.binding.projectId, 'opentag');

    const invitationsResponse = await fetch(
      `${baseUrl}/v1/pairing-invitations?workspaceId=dev-workspace`,
    );
    const invitations = await invitationsResponse.json();
    assert.equal(
      invitations.invitations.find(
        (item) => item.id === invitation.invitation.id,
      ).status,
      'consumed',
    );

    const webhookResponse = await fetch(`${baseUrl}/v1/telegram/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'integration-secret',
      },
      body: JSON.stringify(update(9_001)),
    });
    assert.equal(webhookResponse.status, 202);
    const accepted = await webhookResponse.json();
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.transport.mode, 'telegram-memory');
    assert.equal(accepted.route.projectId, 'opentag');
    assert.equal(accepted.route.threadId, 'telegram:-100123:77');

    const completed = await waitForJson(
      `${baseUrl}/v1/runs?limit=10`,
      (data) =>
        data.runs.some(
          (run) => run.id === accepted.run.id && run.status === 'completed',
        ),
      child,
      logs,
    );
    const run = completed.runs.find((item) => item.id === accepted.run.id);
    assert.equal(run.platform, 'telegram');
    assert.equal(run.projectId, 'opentag');
    assert.equal(run.transportMode, 'telegram-memory');

    const deliveryResponse = await fetch(`${baseUrl}/v1/deliveries?limit=50`);
    const delivery = await deliveryResponse.json();
    const runOutbox = delivery.outbox.filter((item) => item.runId === run.id);
    assert.ok(runOutbox.length >= 3);
    assert.ok(runOutbox.every((item) => item.status === 'delivered'));
    assert.ok(runOutbox.some((item) => item.kind === 'telegram.text'));
    assert.ok(
      runOutbox.some((item) => item.kind === 'telegram.progress.create'),
    );
    assert.ok(
      runOutbox.some((item) => item.kind === 'telegram.progress.update'),
    );
    assert.equal(
      delivery.inboundEvents.find((item) => item.externalId === 'update:9001')
        .status,
      'processed',
    );

    const duplicateResponse = await fetch(`${baseUrl}/v1/telegram/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'integration-secret',
      },
      body: JSON.stringify(update(9_001)),
    });
    assert.equal(duplicateResponse.status, 200);
    assert.equal((await duplicateResponse.json()).duplicate, true);

    const ignoredResponse = await fetch(`${baseUrl}/v1/telegram/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'integration-secret',
      },
      body: JSON.stringify(update(9_002, 'ordinary group chatter', 78)),
    });
    assert.equal(ignoredResponse.status, 202);
    assert.equal((await ignoredResponse.json()).reason, 'mention_required');

    const rejectedResponse = await fetch(`${baseUrl}/v1/telegram/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'wrong',
      },
      body: JSON.stringify(update(9_003)),
    });
    assert.equal(rejectedResponse.status, 401);
    assert.equal(
      (await rejectedResponse.json()).reason,
      'invalid_webhook_secret',
    );

    const unbindResponse = await fetch(
      `${baseUrl}/v1/bindings/${encodeURIComponent(paired.binding.id)}`,
      { method: 'DELETE' },
    );
    assert.equal(unbindResponse.status, 200);
    const unbound = await unbindResponse.json();
    assert.ok(unbound.removed.some((item) => item.id === paired.binding.id));
    assert.ok(
      unbound.removed.some((item) => item.externalId === '-100123:77'),
    );

    const blockedAgainResponse = await fetch(`${baseUrl}/v1/telegram/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'integration-secret',
      },
      body: JSON.stringify(update(9_004)),
    });
    assert.equal(blockedAgainResponse.status, 202);
    assert.equal((await blockedAgainResponse.json()).reason, 'binding_required');
  },
);
