import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
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

function payload(commentId, issueNumber, body, user = 'ada') {
  return {
    action: 'created',
    repository: {
      id: 101,
      name: 'opentag',
      full_name: 'acme/opentag',
      private: true,
      html_url: 'https://github.com/acme/opentag',
    },
    issue: {
      id: 200 + issueNumber,
      number: issueNumber,
      title: `Issue ${issueNumber}`,
      html_url: `https://github.com/acme/opentag/issues/${issueNumber}`,
    },
    comment: {
      id: commentId,
      body,
      html_url: `https://github.com/acme/opentag/issues/${issueNumber}#issuecomment-${commentId}`,
      created_at: new Date().toISOString(),
      author_association: 'MEMBER',
      user: { id: 404, login: user, type: user === 'OpenTagBot' ? 'Bot' : 'User' },
    },
    sender: { id: 404, login: user, type: user === 'OpenTagBot' ? 'Bot' : 'User' },
  };
}

async function webhook(baseUrl, deliveryId, body, options = {}) {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', options.secret || 'integration-secret')
    .update(raw)
    .digest('hex')}`;
  return fetch(`${baseUrl}/v1/github/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-github-event': options.eventType || 'issue_comment',
      'x-hub-signature-256': options.signature || signature,
    },
    body: raw,
  });
}

test(
  'native GitHub webhook pairs a repository and routes isolated issue threads',
  { timeout: 20_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-github-api-'));
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
        OPENTAG_GITHUB_TRANSPORT: 'memory',
        OPENTAG_GITHUB_BOT_LOGIN: 'OpenTagBot',
        OPENTAG_GITHUB_WEBHOOK_SECRET: 'integration-secret',
        OPENTAG_GITHUB_REQUIRE_BINDING: 'true',
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
    assert.equal(health.clients.github.mode, 'memory');
    assert.equal(health.clients.github.webhookSecretConfigured, true);
    assert.equal(health.clients.github.requireBinding, true);

    const capabilities = await fetch(`${baseUrl}/v1/capabilities`).then((response) =>
      response.json(),
    );
    assert.equal(
      capabilities.clients.find((client) => client.id === 'github').status,
      'ready',
    );
    assert.equal(capabilities.githubTransport.webhookSecretConfigured, true);

    const invalidRoutineResponse = await fetch(`${baseUrl}/v1/routines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'Incomplete GitHub destination',
        instructions: 'Summarize the issue',
        schedule: { kind: 'interval', everyMinutes: 60 },
        destination: {
          platform: 'github',
          externalId: 'acme/opentag',
          visibility: 'private',
        },
      }),
    });
    assert.equal(invalidRoutineResponse.status, 400);
    assert.equal(
      (await invalidRoutineResponse.json()).error,
      'github_destination_must_be_owner_repo_issue',
    );

    const validRoutineResponse = await fetch(`${baseUrl}/v1/routines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'GitHub issue digest',
        instructions: 'Summarize the issue.',
        schedule: { kind: 'interval', everyMinutes: 60 },
        destination: {
          platform: 'github',
          externalId: 'acme/opentag#44',
          visibility: 'private',
        },
      }),
    });
    assert.equal(validRoutineResponse.status, 200);
    const validRoutine = (await validRoutineResponse.json()).routine;
    assert.equal(validRoutine.destination.channelId, 'acme/opentag');
    assert.equal(validRoutine.destination.rootMessageId, '44');
    assert.equal(validRoutine.destination.topicId, '44');

    const validWorkflowResponse = await fetch(`${baseUrl}/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        name: 'GitHub issue triage',
        trigger: { kind: 'manual' },
        nodes: [
          {
            id: 'publish',
            instructions: 'Publish the issue triage result.',
          },
        ],
        destination: {
          platform: 'github',
          externalId: 'acme/opentag#45',
          visibility: 'private',
        },
      }),
    });
    assert.equal(validWorkflowResponse.status, 200);
    const validWorkflow = (await validWorkflowResponse.json()).workflow;
    assert.equal(validWorkflow.destination.channelId, 'acme/opentag');
    assert.equal(validWorkflow.destination.rootMessageId, '45');
    assert.equal(validWorkflow.destination.topicId, '45');

    const pingResponse = await webhook(
      baseUrl,
      'delivery-ping',
      { zen: 'Keep it logically awesome.', hook_id: 1 },
      { eventType: 'ping' },
    );
    assert.equal(pingResponse.status, 200);
    assert.equal((await pingResponse.json()).pong, true);

    const blockedResponse = await webhook(
      baseUrl,
      'delivery-blocked',
      payload(300, 40, '@OpenTagBot inspect before pairing'),
    );
    assert.equal(blockedResponse.status, 202);
    assert.equal((await blockedResponse.json()).reason, 'binding_required');

    const invitationResponse = await fetch(`${baseUrl}/v1/pairing-invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'github',
        workspaceId: 'dev-workspace',
        projectId: 'opentag',
        activationMode: 'mention',
        requireMention: true,
      }),
    });
    assert.equal(invitationResponse.status, 201);
    const invitation = await invitationResponse.json();

    const pairResponse = await webhook(
      baseUrl,
      'delivery-pair',
      payload(301, 41, `/pair ${invitation.code}`),
    );
    assert.equal(pairResponse.status, 200);
    const paired = await pairResponse.json();
    assert.equal(paired.paired, true);
    assert.equal(paired.binding.platform, 'github');
    assert.equal(paired.binding.externalId, 'acme/opentag');
    assert.equal(paired.binding.scope, 'channel');
    assert.equal(paired.binding.projectId, 'opentag');

    const firstResponse = await webhook(
      baseUrl,
      'delivery-first',
      payload(302, 42, '@OpenTagBot inspect this issue'),
    );
    assert.equal(firstResponse.status, 202);
    const accepted = await firstResponse.json();
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.transport.mode, 'github-memory');
    assert.equal(accepted.route.projectId, 'opentag');
    assert.equal(accepted.route.threadId, 'github:acme/opentag#42');

    const completed = await waitForJson(
      `${baseUrl}/v1/runs?limit=20`,
      (data) =>
        data.runs.some(
          (run) => run.id === accepted.run.id && run.status === 'completed',
        ),
      child,
      logs,
    );
    const run = completed.runs.find((item) => item.id === accepted.run.id);
    assert.equal(run.platform, 'github');
    assert.equal(run.projectId, 'opentag');
    assert.equal(run.transportMode, 'github-memory');

    const followUpResponse = await webhook(
      baseUrl,
      'delivery-follow-up',
      payload(303, 42, 'continue with the same issue context'),
    );
    assert.equal(followUpResponse.status, 202);
    const followUp = await followUpResponse.json();
    assert.equal(followUp.accepted, true);
    assert.equal(followUp.route.threadId, 'github:acme/opentag#42');

    const newIssueResponse = await webhook(
      baseUrl,
      'delivery-new-issue',
      payload(304, 43, 'this new issue has no mention'),
    );
    assert.equal(newIssueResponse.status, 202);
    assert.equal((await newIssueResponse.json()).reason, 'mention_required');

    const duplicateResponse = await webhook(
      baseUrl,
      'delivery-first',
      payload(302, 42, '@OpenTagBot inspect this issue'),
    );
    assert.equal(duplicateResponse.status, 200);
    assert.equal((await duplicateResponse.json()).duplicate, true);

    const selfResponse = await webhook(
      baseUrl,
      'delivery-self',
      payload(305, 42, '<!-- opentag-reply:run-1 -->\nDone', 'service-user'),
    );
    assert.equal(selfResponse.status, 202);
    assert.equal((await selfResponse.json()).reason, 'unsupported_github_event');

    const botResponse = await webhook(
      baseUrl,
      'delivery-bot',
      payload(306, 42, '@OpenTagBot loop', 'OpenTagBot'),
    );
    assert.equal(botResponse.status, 202);
    assert.equal((await botResponse.json()).reason, 'unsupported_github_event');

    const badSignature = await webhook(
      baseUrl,
      'delivery-invalid',
      payload(307, 42, '@OpenTagBot tampered'),
      { signature: 'sha256=invalid' },
    );
    assert.equal(badSignature.status, 401);
    assert.equal((await badSignature.json()).reason, 'invalid_signature');

    await waitForJson(
      `${baseUrl}/v1/runs?limit=20`,
      (data) =>
        data.runs.some(
          (item) => item.id === followUp.run.id && item.status === 'completed',
        ),
      child,
      logs,
    );
    const delivery = await fetch(`${baseUrl}/v1/deliveries?limit=100`).then(
      (response) => response.json(),
    );
    const runOutbox = delivery.outbox.filter((item) => item.runId === run.id);
    assert.ok(runOutbox.every((item) => item.status === 'delivered'));
    assert.ok(runOutbox.some((item) => item.kind === 'github.progress.create'));
    assert.ok(runOutbox.some((item) => item.kind === 'github.progress.update'));
    assert.ok(runOutbox.some((item) => item.kind === 'github.comment'));
    assert.equal(
      delivery.inboundEvents.find(
        (item) => item.externalId === 'delivery:delivery-first',
      ).status,
      'processed',
    );
    assert.ok(
      delivery.inboundEvents.some(
        (item) =>
          item.externalId.startsWith('rejected:delivery:delivery-invalid:') &&
          item.status === 'rejected',
      ),
    );
  },
);
