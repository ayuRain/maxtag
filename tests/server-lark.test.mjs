import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createHash,
} from 'node:crypto';
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

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return await response.json();
    } catch {
      // The server can refuse connections briefly while starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server did not become healthy\n${logs.join('')}`);
}

function encryptPayload(body, encryptKey, iv = Buffer.alloc(16, 9)) {
  const key = createHash('sha256').update(encryptKey).digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

function callback(rawBody, encryptKey, timestamp = String(Math.floor(Date.now() / 1000))) {
  const nonce = 'server-lark-nonce';
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': createHash('sha256')
        .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
        .digest('hex'),
    },
  };
}

async function postCallback(baseUrl, input) {
  const response = await fetch(`${baseUrl}/v1/lark/events`, {
    method: 'POST',
    headers: input.headers,
    body: input.rawBody,
  });
  return { response, data: await response.json() };
}

test(
  'native Lark endpoint accepts encrypted v2 callbacks and rejects forged or stale delivery',
  { timeout: 20_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-api-'));
    const port = await freePort();
    const logs = [];
    const encryptKey = 'server-encrypt-key';
    const verificationToken = 'server-verification-token';
    const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_ADMIN_TOKEN: '',
        OPENTAG_EXECUTOR_MODE: 'dry-run',
        OPENTAG_AGENT_WORKER: 'manual',
        OPENTAG_ROUTINES_ENABLED: 'false',
        OPENTAG_WORKFLOWS_ENABLED: 'false',
        OPENTAG_LARK_TRANSPORT: 'memory',
        OPENTAG_LARK_EVENT_MODE: 'webhook',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_opentag_bot',
        OPENTAG_LARK_VERIFICATION_TOKEN: verificationToken,
        OPENTAG_LARK_ENCRYPT_KEY: encryptKey,
        OPENTAG_LARK_CALLBACK_MAX_BYTES: '2048',
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
    const health = await waitForHealth(baseUrl, child, logs);
    assert.equal(health.clients.lark.encryptionKeyConfigured, true);
    assert.equal(health.clients.lark.verificationTokenConfigured, true);
    assert.equal(health.clients.lark.callbackMaxBytes, 2048);
    assert.equal(health.clients.lark.callbackMaxSkewSeconds, 300);

    const challengeBody = JSON.stringify({
      encrypt: encryptPayload(
        {
          type: 'url_verification',
          token: verificationToken,
          challenge: 'encrypted-server-challenge',
        },
        encryptKey,
      ),
    });
    const challenge = await postCallback(baseUrl, {
      rawBody: challengeBody,
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
    });
    assert.equal(challenge.response.status, 200);
    assert.deepEqual(challenge.data, { challenge: 'encrypted-server-challenge' });

    const event = {
      schema: '2.0',
      header: {
        event_id: 'encrypted-event-1',
        event_type: 'im.message.receive_v1',
        token: verificationToken,
        tenant_key: 'dev-workspace',
      },
      event: {
        message: {
          message_id: 'encrypted-message-1',
          chat_id: 'encrypted-project',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@MaxTag inspect encryption' }),
          create_time: String(Date.now()),
          mentions: [
            { id: { open_id: 'ou_opentag_bot' }, name: 'MaxTag' },
          ],
        },
        sender: {
          sender_id: { open_id: 'ou_lark_user' },
        },
      },
    };
    const eventBody = JSON.stringify({ encrypt: encryptPayload(event, encryptKey) });
    const signedEvent = callback(eventBody, encryptKey);
    const accepted = await postCallback(baseUrl, signedEvent);
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.data.accepted, true);
    assert.equal(accepted.data.queued, true);
    assert.equal(accepted.data.run.thread.workspaceId, 'dev-workspace');
    assert.equal(accepted.data.run.thread.projectId, 'encrypted-project');

    const duplicate = await postCallback(baseUrl, signedEvent);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.data.duplicate, true);

    const forged = await postCallback(baseUrl, {
      ...signedEvent,
      headers: { ...signedEvent.headers, 'x-lark-signature': 'forged' },
    });
    assert.equal(forged.response.status, 401);
    assert.equal(forged.data.reason, 'invalid_signature');

    const corruptBody = JSON.stringify({
      encrypt: Buffer.alloc(32, 3).toString('base64'),
    });
    const corrupt = await postCallback(baseUrl, callback(corruptBody, encryptKey));
    assert.equal(corrupt.response.status, 400);
    assert.equal(corrupt.data.reason, 'invalid_encrypted_payload');

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 601);
    const stale = await postCallback(
      baseUrl,
      callback(eventBody, encryptKey, staleTimestamp),
    );
    assert.equal(stale.response.status, 401);
    assert.equal(stale.data.reason, 'stale_request');

    const oversized = await postCallback(baseUrl, {
      rawBody: JSON.stringify({ padding: 'x'.repeat(2100) }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.data.error, 'request_body_too_large');
  },
);
