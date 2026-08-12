import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPENTAG_STOP_RUN_ACTION } from '@opentag/core';

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

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {
      // The server can refuse connections briefly while starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server did not become healthy\n${logs.join('')}`);
}

async function waitForValue(load, predicate, label, logs, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await load();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(
    `${label} timeout; latest=${JSON.stringify(latest)}\n${logs.join('')}`,
  );
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

function encryptPayload(body, encryptKey, iv = Buffer.alloc(16, 11)) {
  const key = createHash('sha256').update(encryptKey).digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

async function postLarkEvent(baseUrl, event, encryptKey) {
  const rawBody = JSON.stringify({ encrypt: encryptPayload(event, encryptKey) });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `nonce-${event.header.event_id}`;
  const signature = createHash('sha256')
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
    .digest('hex');
  const response = await fetch(`${baseUrl}/v1/lark/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature,
    },
    body: rawBody,
  });
  return { response, data: await response.json() };
}

function messageEvent({ eventId, messageId, actorId, token }) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      token,
      tenant_key: 'dev-workspace',
    },
    event: {
      message: {
        message_id: messageId,
        chat_id: 'oc_card_project',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'inspect the project' }),
        create_time: String(Date.now()),
      },
      sender: {
        sender_id: { open_id: actorId },
        tenant_key: 'dev-workspace',
      },
    },
  };
}

function cardActionEvent({
  eventId,
  actorId,
  runId,
  cardMessageId,
  token,
}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'card.action.trigger',
      token,
      tenant_key: 'dev-workspace',
    },
    event: {
      operator: {
        open_id: actorId,
        tenant_key: 'dev-workspace',
      },
      action: {
        tag: 'button',
        value: {
          action: OPENTAG_STOP_RUN_ACTION,
          run_id: runId,
        },
      },
      context: {
        open_message_id: cardMessageId,
        open_chat_id: 'oc_card_project',
      },
      host: 'im_message',
    },
  };
}

test(
  'Lark progress-card Stop is receipt-bound, authorized, cancellable, and idempotent',
  { timeout: 30_000 },
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-card-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    const fakeCli = path.join(root, 'fake-codex.mjs');
    const encryptKey = 'card-action-encrypt-key';
    const verificationToken = 'card-action-verification-token';
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(
      fakeCli,
      `#!/usr/bin/env node
const serverPid = process.ppid;
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'card-action-session' }));
console.log(JSON.stringify({ type: 'item.started', item: { id: 'wait', type: 'reasoning' } }));
setInterval(() => {
  try {
    process.kill(serverPid, 0);
  } catch {
    process.exit(0);
  }
}, 100);
`,
      { mode: 0o700 },
    );

    const port = await freePort();
    const logs = [];
    const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_STORAGE_DRIVER: 'sqlite',
        OPENTAG_ADMIN_TOKEN: '',
        OPENTAG_EXECUTOR_MODE: 'local-cli',
        OPENTAG_EXECUTOR_WORKSPACE_ROOT: workspaceRoot,
        OPENTAG_EXECUTOR_SESSION_MODE: 'transcript',
        OPENTAG_EXECUTOR_TIMEOUT_MS: '20000',
        OPENTAG_CODEX_COMMAND: fakeCli,
        OPENTAG_AGENT_WORKER: 'inline',
        OPENTAG_AGENT_WORKER_INTERVAL_MS: '25',
        OPENTAG_RUN_CONTROL_POLL_MS: '25',
        OPENTAG_ROUTINES_ENABLED: 'false',
        OPENTAG_WORKFLOWS_ENABLED: 'false',
        OPENTAG_LARK_TRANSPORT: 'memory',
        OPENTAG_LARK_VERIFICATION_TOKEN: verificationToken,
        OPENTAG_LARK_ENCRYPT_KEY: encryptKey,
        OPENTAG_LARK_REQUIRE_BINDING: 'true',
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
      await fs.rm(root, { recursive: true, force: true });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(baseUrl, child, logs);
    assert.equal(health.storage.driver, 'sqlite');

    const project = await postJson(baseUrl, '/v1/projects', {
      workspaceId: 'dev-workspace',
      projectId: 'card-project',
      name: 'Card project',
      agentMode: 'inherit',
      capabilityMode: 'inherit',
      memoryMode: 'workspace',
    });
    assert.equal(project.response.status, 200);
    const owner = await postJson(baseUrl, '/v1/access/members', {
      workspaceId: 'dev-workspace',
      displayName: 'Card owner',
      role: 'owner',
      platform: 'lark',
      externalId: 'ou-card-owner',
    });
    assert.equal(owner.response.status, 200);
    const policy = await postJson(baseUrl, '/v1/access/project-policy', {
      workspaceId: 'dev-workspace',
      projectId: 'card-project',
      mode: 'members',
    });
    assert.equal(policy.response.status, 200);
    const binding = await postJson(baseUrl, '/v1/bindings', {
      platform: 'lark',
      externalId: 'oc_card_project',
      workspaceId: 'dev-workspace',
      projectId: 'card-project',
      activationMode: 'always',
      requireMention: false,
    });
    assert.equal(binding.response.status, 200);

    const accepted = await postLarkEvent(
      baseUrl,
      messageEvent({
        eventId: 'card-message-event-1',
        messageId: 'om-card-message-1',
        actorId: 'ou-card-owner',
        token: verificationToken,
      }),
      encryptKey,
    );
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.data.accepted, true);
    const runId = accepted.data.run.id;

    const delivery = await waitForValue(
      () => fetch(`${baseUrl}/v1/deliveries?limit=100`).then((response) => response.json()),
      (snapshot) =>
        snapshot.outbox.some(
          (item) =>
            item.runId === runId &&
            item.kind === 'lark.card.create' &&
            item.status === 'delivered' &&
            item.externalId,
        ),
      'progress card receipt',
      logs,
    );
    const receipt = delivery.outbox.find(
      (item) => item.runId === runId && item.kind === 'lark.card.create',
    );
    assert.equal(receipt.target.chatId, 'oc_card_project');

    const stranger = await postLarkEvent(
      baseUrl,
      cardActionEvent({
        eventId: 'card-action-stranger-1',
        actorId: 'ou-card-stranger',
        runId,
        cardMessageId: receipt.externalId,
        token: verificationToken,
      }),
      encryptKey,
    );
    assert.equal(stranger.response.status, 200);
    assert.equal(stranger.data.toast.type, 'error');

    const forged = await postLarkEvent(
      baseUrl,
      cardActionEvent({
        eventId: 'card-action-forged-run-1',
        actorId: 'ou-card-owner',
        runId: 'forged-run-id',
        cardMessageId: receipt.externalId,
        token: verificationToken,
      }),
      encryptKey,
    );
    assert.equal(forged.response.status, 200);
    assert.equal(forged.data.toast.type, 'warning');

    const activeRuns = await fetch(`${baseUrl}/v1/runs?limit=10`).then(
      (response) => response.json(),
    );
    assert.equal(activeRuns.runs.find((run) => run.id === runId).status, 'running');

    const stopped = await postLarkEvent(
      baseUrl,
      cardActionEvent({
        eventId: 'card-action-owner-stop-1',
        actorId: 'ou-card-owner',
        runId,
        cardMessageId: receipt.externalId,
        token: verificationToken,
      }),
      encryptKey,
    );
    assert.equal(stopped.response.status, 200);
    assert.deepEqual(stopped.data.toast, {
      type: 'success',
      content: 'Cancellation requested.',
    });

    const cancelled = await waitForValue(
      () => fetch(`${baseUrl}/v1/runs?limit=10`).then((response) => response.json()),
      (snapshot) =>
        snapshot.runs.some((run) => run.id === runId && run.status === 'cancelled'),
      'cancelled run',
      logs,
    );
    assert.equal(cancelled.runs.length, 1);

    const repeated = await postLarkEvent(
      baseUrl,
      cardActionEvent({
        eventId: 'card-action-owner-stop-2',
        actorId: 'ou-card-owner',
        runId,
        cardMessageId: receipt.externalId,
        token: verificationToken,
      }),
      encryptKey,
    );
    assert.equal(repeated.response.status, 200);
    assert.deepEqual(repeated.data.toast, {
      type: 'info',
      content: 'This task has already finished.',
    });

    const duplicate = await postLarkEvent(
      baseUrl,
      cardActionEvent({
        eventId: 'card-action-owner-stop-2',
        actorId: 'ou-card-owner',
        runId,
        cardMessageId: receipt.externalId,
        token: verificationToken,
      }),
      encryptKey,
    );
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.data.duplicate, true);

    const finalDelivery = await waitForValue(
      () => fetch(`${baseUrl}/v1/deliveries?limit=100`).then((response) => response.json()),
      (snapshot) =>
        snapshot.outbox.some(
          (item) =>
            item.runId === runId &&
            item.kind === 'lark.card.update' &&
            item.status === 'delivered',
        ),
      'terminal progress card update',
      logs,
    );
    assert.equal(
      finalDelivery.inboundEvents.find(
        (event) => event.externalId === 'card-action-stranger-1',
      ).reason,
      'actor_not_authorized',
    );
    assert.equal(
      finalDelivery.inboundEvents.find(
        (event) => event.externalId === 'card-action-forged-run-1',
      ).reason,
      'invalid_lark_card_receipt',
    );
    assert.equal(
      finalDelivery.inboundEvents.find(
        (event) => event.externalId === 'card-action-owner-stop-1',
      ).status,
      'processed',
    );
  },
);
