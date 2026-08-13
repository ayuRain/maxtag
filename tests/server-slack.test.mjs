import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { slackRequestSignature } from '@opentag/platform-slack';

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

function event(eventId, ts, text, channel = 'C_OPENTAG') {
  return {
    type: 'event_callback',
    team_id: 'T_DEVELOPMENT',
    api_app_id: 'A_OPENTAG',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: 'app_mention',
      user: 'U_ADA',
      text,
      ts,
      channel,
      event_ts: ts.replace('.', ''),
    },
  };
}

async function postSlack(baseUrl, body, signingSecret, options = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(`${baseUrl}/v1/slack/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': options.signature || slackRequestSignature({
        signingSecret,
        timestamp,
        rawBody,
      }),
    },
    body: rawBody,
  });
}

test(
  'native signed Slack events pair a channel and route a tracked SQLite run',
  { timeout: 20_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-slack-api-'));
    const port = await freePort();
    const logs = [];
    const signingSecret = 'slack-integration-signing-secret';
    const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_PORT: String(port),
        OPENTAG_HOST: '127.0.0.1',
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_STORAGE_DRIVER: 'sqlite',
        OPENTAG_EXECUTOR_MODE: 'dry-run',
        OPENTAG_SLACK_TRANSPORT: 'memory',
        OPENTAG_SLACK_SIGNING_SECRET: signingSecret,
        OPENTAG_SLACK_BOT_USER_ID: 'U_BOT',
        OPENTAG_SLACK_REQUIRE_BINDING: 'true',
        OPENTAG_AGENT_WORKER: 'inline',
        OPENTAG_AGENT_WORKER_INTERVAL_MS: '25',
        OPENTAG_ROUTINES_ENABLED: 'false',
        OPENTAG_WORKFLOWS_ENABLED: 'false',
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
    assert.equal(health.clients.slack.mode, 'memory');
    assert.equal(health.clients.slack.signingSecretConfigured, true);
    assert.equal(health.clients.slack.requireBinding, true);

    const capabilities = await fetch(`${baseUrl}/v1/capabilities`).then((response) => response.json());
    assert.equal(
      capabilities.clients.find((client) => client.id === 'slack').status,
      'ready',
    );
    assert.equal(capabilities.slackTransport.signingSecretConfigured, true);

    const challengeResponse = await postSlack(
      baseUrl,
      { type: 'url_verification', challenge: 'verify-opentag' },
      signingSecret,
    );
    assert.equal(challengeResponse.status, 200);
    assert.deepEqual(await challengeResponse.json(), { challenge: 'verify-opentag' });

    const rejectedResponse = await postSlack(
      baseUrl,
      event('Ev-rejected', '1786450000.000001', '<@U_BOT> rejected'),
      signingSecret,
      { signature: 'v0=wrong' },
    );
    assert.equal(rejectedResponse.status, 401);
    assert.equal((await rejectedResponse.json()).reason, 'invalid_signature');

    const blockedResponse = await postSlack(
      baseUrl,
      event('Ev-blocked', '1786450001.000001', '<@U_BOT> before pairing'),
      signingSecret,
    );
    assert.equal(blockedResponse.status, 200);
    const blocked = await blockedResponse.json();
    assert.equal(blocked.reason, 'binding_required');
    assert.equal(blocked.notice.notified, true);

    const invitationResponse = await fetch(`${baseUrl}/v1/pairing-invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'slack',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        activationMode: 'mention',
        requireMention: true,
        allowedActorIds: ['U_ADA'],
      }),
    });
    assert.equal(invitationResponse.status, 201);
    const invitation = await invitationResponse.json();

    const pairResponse = await postSlack(
      baseUrl,
      event('Ev-pair', '1786450002.000001', `<@U_BOT> /pair ${invitation.code}`),
      signingSecret,
    );
    assert.equal(pairResponse.status, 200);
    const paired = await pairResponse.json();
    assert.equal(paired.paired, true);
    assert.equal(paired.binding.platform, 'slack');
    assert.equal(paired.binding.externalId, 'C_OPENTAG');
    assert.equal(paired.binding.projectId, 'opentag');

    const runResponse = await postSlack(
      baseUrl,
      event('Ev-run', '1786450003.000001', '<@U_BOT> inspect the workspace'),
      signingSecret,
    );
    assert.equal(runResponse.status, 200);
    const accepted = await runResponse.json();
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.transport.mode, 'slack-memory');
    assert.equal(accepted.route.projectId, 'opentag');
    assert.equal(accepted.route.threadId, 'slack:C_OPENTAG:1786450003.000001');

    const completed = await waitForJson(
      `${baseUrl}/v1/runs?limit=10`,
      (data) => data.runs.some(
        (run) => run.id === accepted.run.id && run.status === 'completed',
      ),
      child,
      logs,
    );
    const run = completed.runs.find((item) => item.id === accepted.run.id);
    assert.equal(run.platform, 'slack');
    assert.equal(run.transportMode, 'slack-memory');

    const delivery = await fetch(`${baseUrl}/v1/deliveries?limit=50`).then((response) => response.json());
    const runOutbox = delivery.outbox.filter((item) => item.runId === run.id);
    assert.ok(runOutbox.every((item) => item.status === 'delivered'));
    assert.ok(runOutbox.some((item) => item.kind === 'slack.progress.create'));
    assert.ok(runOutbox.some((item) => item.kind === 'slack.progress.update'));
    assert.ok(runOutbox.some((item) => item.kind === 'slack.text'));
    assert.equal(
      delivery.inboundEvents.find((item) => item.externalId === 'event:Ev-run').status,
      'processed',
    );

    const duplicateResponse = await postSlack(
      baseUrl,
      event('Ev-run', '1786450003.000001', '<@U_BOT> inspect the workspace'),
      signingSecret,
    );
    assert.equal((await duplicateResponse.json()).duplicate, true);
  },
);
