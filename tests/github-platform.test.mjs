import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileDeliveryStore,
  TrackedGitHubTransport,
} from '@opentag/delivery';
import {
  GitHubApiError,
  GitHubPlatformAdapter,
  HttpGitHubTransport,
  MemoryGitHubTransport,
  githubCallbackEventType,
  githubCallbackExternalId,
  normalizeGitHubWebhook,
  parseAndValidateGitHubCallback,
  splitGitHubText,
} from '@opentag/platform-github';

function githubPayload(overrides = {}) {
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
      id: 202,
      number: 42,
      title: 'Ship native comments',
      html_url: 'https://github.com/acme/opentag/issues/42',
      pull_request: { url: 'https://api.github.com/repos/acme/opentag/pulls/42' },
    },
    comment: {
      id: 303,
      body: '@OpenTagBot inspect this pull request',
      html_url: 'https://github.com/acme/opentag/issues/42#issuecomment-303',
      created_at: '2026-08-12T01:02:03.000Z',
      author_association: 'MEMBER',
      user: { id: 404, login: 'ada', type: 'User' },
    },
    sender: { id: 404, login: 'ada', type: 'User' },
    installation: { id: 505 },
    ...overrides,
  };
}

test('GitHub callback validates HMAC-SHA256 and exposes delivery headers', () => {
  const raw = JSON.stringify(githubPayload());
  const signature = `sha256=${createHmac('sha256', 'secret-1')
    .update(raw)
    .digest('hex')}`;
  const headers = {
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'issue_comment',
    'x-hub-signature-256': signature,
  };
  const accepted = parseAndValidateGitHubCallback(raw, headers, {
    webhookSecret: 'secret-1',
  });
  assert.equal(accepted.validation.ok, true);
  assert.equal(
    githubCallbackExternalId(headers, accepted.body),
    'delivery:delivery-1',
  );
  assert.equal(githubCallbackEventType(headers), 'issue_comment');

  const rejected = parseAndValidateGitHubCallback(
    raw,
    { ...headers, 'x-hub-signature-256': 'sha256=bad' },
    { webhookSecret: 'secret-1' },
  );
  assert.deepEqual(rejected.validation, {
    ok: false,
    statusCode: 401,
    reason: 'invalid_signature',
  });
  assert.deepEqual(parseAndValidateGitHubCallback('{', {}).validation, {
    ok: false,
    statusCode: 400,
    reason: 'invalid_json',
  });
});

test('GitHub issue comments normalize repositories, threads, actors, and mentions', () => {
  const normalized = normalizeGitHubWebhook(githubPayload(), {
    eventType: 'issue_comment',
    botLogin: 'OpenTagBot',
    workspaceId: 'acme-workspace',
  });
  assert.ok(normalized);
  assert.equal(normalized.thread.id, 'github:acme/opentag#42');
  assert.equal(normalized.thread.externalId, 'acme/opentag#42');
  assert.equal(normalized.thread.channelId, 'acme/opentag');
  assert.equal(normalized.thread.rootMessageId, '42');
  assert.equal(normalized.thread.topicId, '42');
  assert.equal(normalized.thread.projectId, 'acme/opentag');
  assert.equal(normalized.thread.workspaceId, 'acme-workspace');
  assert.equal(normalized.thread.visibility, 'private');
  assert.equal(normalized.thread.metadata.isPullRequest, true);
  assert.equal(normalized.message.mentionsAgent, true);
  assert.equal(normalized.message.actor.id, 'ada');

  assert.equal(
    normalizeGitHubWebhook(
      githubPayload({
        comment: {
          id: 304,
          body: '@OpenTagBot loop',
          user: { login: 'OpenTagBot', type: 'Bot' },
        },
      }),
      { eventType: 'issue_comment', botLogin: 'OpenTagBot' },
    ),
    null,
  );
  assert.equal(
    normalizeGitHubWebhook(
      githubPayload({
        comment: {
          id: 305,
          body: '<!-- opentag-reply:run-1 -->\nDone',
          user: { login: 'service-user', type: 'User' },
        },
      }),
      { eventType: 'issue_comment', botLogin: 'OpenTagBot' },
    ),
    null,
  );
  assert.equal(
    normalizeGitHubWebhook(githubPayload(), {
      eventType: 'issues',
      botLogin: 'OpenTagBot',
    }),
    null,
  );
});

test('HTTP GitHub transport creates and updates issue comments', async () => {
  const requests = [];
  const transport = new HttpGitHubTransport({
    token: 'token-1',
    baseUrl: 'https://github.example/api/v3',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          id: requests.length === 1 ? 9001 : 9001,
          html_url: 'https://github.example/acme/opentag/issues/42#issuecomment-9001',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const created = await transport.createIssueComment({
    owner: 'acme',
    repo: 'open tag',
    issueNumber: 42,
    body: 'Working',
  });
  assert.equal(created.commentId, '9001');
  await transport.updateIssueComment({
    owner: 'acme',
    repo: 'open tag',
    commentId: created.commentId,
    body: 'Done',
  });

  assert.equal(
    requests[0].url,
    'https://github.example/api/v3/repos/acme/open%20tag/issues/42/comments',
  );
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(JSON.parse(requests[0].options.body).body, 'Working');
  assert.equal(requests[0].options.headers.authorization, 'Bearer token-1');
  assert.equal(requests[0].options.headers['x-github-api-version'], '2022-11-28');
  assert.equal(
    requests[1].url,
    'https://github.example/api/v3/repos/acme/open%20tag/issues/comments/9001',
  );
  assert.equal(requests[1].options.method, 'PATCH');

  const failing = new HttpGitHubTransport({
    token: 'token-1',
    fetch: async () =>
      new Response(
        JSON.stringify({ message: 'Resource not accessible by integration' }),
        { status: 403 },
      ),
  });
  await assert.rejects(
    failing.createIssueComment({
      owner: 'acme',
      repo: 'opentag',
      issueNumber: 42,
      body: 'Denied',
    }),
    (error) =>
      error instanceof GitHubApiError &&
      error.statusCode === 403 &&
      /Resource not accessible/u.test(error.message),
  );
});

test('GitHub adapter edits progress, chunks replies, marks self output, and tracks delivery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-github-'));
  try {
    const store = new FileDeliveryStore(root);
    const memory = new MemoryGitHubTransport();
    const adapter = new GitHubPlatformAdapter(
      new TrackedGitHubTransport(memory, store),
    );
    const thread = {
      id: 'github:acme/opentag#42',
      platform: 'github',
      externalId: 'acme/opentag#42',
      workspaceId: 'acme',
      projectId: 'payments',
      channelId: 'acme/opentag',
      rootMessageId: '42',
      topicId: '42',
      visibility: 'private',
      metadata: {
        owner: 'acme',
        repo: 'opentag',
        repository: 'acme/opentag',
        issueNumber: 42,
      },
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
      `start ${'x'.repeat(130_000)} end`,
      [
        { id: 'link-1', kind: 'link', title: 'PR', url: 'https://github.com/acme/opentag/pull/9' },
        { id: 'file-1', kind: 'file', title: 'report.txt', path: '/tmp/report.txt' },
      ],
      { runId: 'run-1' },
    );

    assert.equal(memory.comments[0].issueNumber, 42);
    assert.match(memory.comments[0].body, /opentag-progress:run-1/u);
    assert.equal(memory.updates.length, 1);
    assert.equal(memory.updates[0].commentId, created.surfaceId);
    assert.match(memory.updates[0].body, /\[x\] Inspect/u);
    const replies = memory.comments.slice(1);
    assert.ok(replies.length >= 3);
    assert.ok(replies.every((item) => item.body.length <= 60_000));
    assert.ok(
      replies.every((item) => item.body.startsWith('<!-- opentag-reply:run-1 -->')),
    );
    assert.match(replies.at(-1).body, /available in OpenTag/u);

    const outbox = await store.listOutbox({ limit: 20 });
    assert.ok(outbox.every((item) => item.status === 'delivered'));
    assert.ok(outbox.some((item) => item.kind === 'github.progress.create'));
    assert.ok(outbox.some((item) => item.kind === 'github.progress.update'));
    assert.ok(outbox.some((item) => item.kind === 'github.comment'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GitHub text chunking keeps surrogate pairs intact', () => {
  const text = '😀'.repeat(70_000);
  const chunks = splitGitHubText(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 60_000));
  assert.equal(chunks.join(''), text);
});
