import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteOpenTagStore } from '@opentag/storage-sqlite';

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

async function waitForJson(url, predicate, child, logs, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 8_000);
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`process exited early (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url, options.fetch);
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

async function startServer(dataDir) {
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
      OPENTAG_AGENT_WORKER: 'manual',
      OPENTAG_ROUTINES_ENABLED: 'false',
      OPENTAG_EXECUTOR_MODE: 'dry-run',
      OPENTAG_LARK_TRANSPORT: 'memory',
      OPENTAG_TELEGRAM_TRANSPORT: 'memory',
      OPENTAG_SLACK_TRANSPORT: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForJson(`${baseUrl}/health`, (data) => data.ok === true, child, logs);
  return { baseUrl, child, logs };
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

function parseSseFrame(frame) {
  let event = 'message';
  let id = '';
  const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return undefined;
  return { event, id, data: JSON.parse(data.join('\n')) };
}

async function readSseUntil(response, predicate, timeoutMs = 5_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('sse_read_timeout')), remaining),
      ),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true }).replaceAll('\r\n', '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const parsed = parseSseFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (parsed) frames.push(parsed);
      if (predicate(frames)) return frames;
    }
  }
  throw new Error(`SSE predicate not reached: ${JSON.stringify(frames)}`);
}

test(
  'Web Assistant streams sanitized durable events and resumes from Last-Event-ID',
  { timeout: 20_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-web-stream-'));
    const server = await startServer(dataDir);
    context.after(async () => {
      await stopProcess(server.child);
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const created = await postJson(server.baseUrl, '/v1/assistant/sessions', {
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
    });
    const sessionId = created.data.session.id;
    const queued = await postJson(
      server.baseUrl,
      `/v1/assistant/sessions/${sessionId}/messages`,
      { text: 'Stream this turn.' },
    );
    const runId = queued.data.run.id;
    const firstAbort = new AbortController();
    const firstResponse = await fetch(
      `${server.baseUrl}/v1/assistant/sessions/${sessionId}/events`,
      { signal: firstAbort.signal },
    );
    assert.equal(firstResponse.status, 200);
    assert.match(firstResponse.headers.get('content-type') || '', /text\/event-stream/u);

    const sqlite = new SqliteOpenTagStore({
      databasePath: path.join(dataDir, 'opentag.sqlite'),
    });
    context.after(() => sqlite.close());
    await sqlite.deliveryStore.appendAgentRunEvent(runId, 'text_delta', {
      message: 'Incremental answer',
    });
    await sqlite.deliveryStore.appendAgentRunEvent(runId, 'delegation', {
      message: 'secret delegation message',
      metadata: {
        invocationId: 'invoke-review-1',
        agentId: 'evidence-reviewer',
        executorId: 'gpt-5.6-luna',
        status: 'running',
        taskPreview: 'Review the release proof.',
        internalPrompt: 'do-not-stream-this-agent-prompt',
      },
    });
    await sqlite.deliveryStore.appendAgentRunEvent(runId, 'tool_call', {
      message: 'secret original tool message',
      metadata: {
        call: {
          id: 'stream-tool',
          name: 'native_shell',
          title: 'Inspect workspace',
          grantKind: 'shell',
          risk: 'read',
          source: 'provider-native',
          provider: 'codex',
          arguments: { command: 'do-not-stream-this-command' },
        },
      },
    });
    await sqlite.deliveryStore.appendAgentRunEvent(runId, 'tool_result', {
      message: 'secret original result message',
      metadata: {
        call: {
          id: 'stream-tool',
          name: 'native_shell',
          title: 'Inspect workspace',
          grantKind: 'shell',
          risk: 'read',
          source: 'provider-native',
          provider: 'codex',
          status: 'succeeded',
          durationMs: 17,
          resultPreview: 'do-not-stream-this-result',
        },
      },
    });
    await sqlite.deliveryStore.appendAgentRunEvent(runId, 'delegation', {
      message: 'secret completed delegation message',
      metadata: {
        invocationId: 'invoke-review-1',
        agentId: 'evidence-reviewer',
        executorId: 'gpt-5.6-luna',
        status: 'completed',
        summaryPreview: 'Build proof verified; client receipt is pending.',
        usage: {
          runs: 1,
          costUsd: 0.0004,
          inputTokens: 90,
          outputTokens: 25,
          privateProviderDetail: 'do-not-stream-this-usage-detail',
        },
      },
    });

    const firstFrames = await readSseUntil(
      firstResponse,
      (frames) =>
        frames.some(
          (frame) =>
            frame.event === 'run_event' &&
            frame.data.event.type === 'delegation' &&
            frame.data.event.metadata?.status === 'completed',
        ),
    );
    const streamed = firstFrames
      .filter((frame) => frame.event === 'run_event')
      .map((frame) => frame.data.event);
    assert.equal(streamed.some((event) => event.type === 'created'), true);
    assert.equal(
      streamed.find((event) => event.type === 'text_delta').message,
      'Incremental answer',
    );
    const toolResult = streamed.find((event) => event.type === 'tool_result');
    assert.deepEqual(toolResult.metadata.tool, {
      id: 'stream-tool',
      status: 'succeeded',
      name: 'native_shell',
      title: 'Inspect workspace',
      grantKind: 'shell',
      risk: 'read',
      source: 'provider-native',
      provider: 'codex',
      durationMs: 17,
    });
    const delegation = streamed.find(
      (event) =>
        event.type === 'delegation' && event.metadata?.status === 'completed',
    );
    assert.deepEqual(delegation.metadata, {
      invocationId: 'invoke-review-1',
      agentId: 'evidence-reviewer',
      executorId: 'gpt-5.6-luna',
      status: 'completed',
      taskPreview: '',
      summaryPreview: 'Build proof verified; client receipt is pending.',
      usage: {
        runs: 1,
        costUsd: 0.0004,
        inputTokens: 90,
        outputTokens: 25,
      },
    });
    assert.doesNotMatch(JSON.stringify(firstFrames), /do-not-stream|secret original/u);
    const durableSnapshot = await fetch(
      `${server.baseUrl}/v1/assistant/sessions/${sessionId}`,
    ).then((response) => response.json());
    const durableTool = durableSnapshot.timeline.find(
      (event) => event.type === 'tool_result',
    );
    assert.deepEqual(durableTool.metadata, toolResult.metadata);
    assert.equal(
      durableSnapshot.timeline.some((event) => event.type === 'text_delta'),
      false,
    );
    assert.equal(
      durableSnapshot.drafts[runId],
      'Incremental answer',
    );
    assert.equal(durableSnapshot.eventCursor, delegation.sequence);
    assert.doesNotMatch(
      JSON.stringify(durableSnapshot.timeline),
      /do-not-stream|secret original|private\/workspace/u,
    );
    for (const asset of [
      ['/vendor/marked.js', /function|class/u],
      ['/vendor/dompurify.js', /DOMPurify|createDOMPurify/u],
    ]) {
      const response = await fetch(`${server.baseUrl}${asset[0]}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /text\/javascript/u);
      assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/u);
      assert.match(await response.text(), asset[1]);
    }
    const sequences = streamed.map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    const cursor = Math.max(...sequences);
    firstAbort.abort();

    const resumedEvent = await sqlite.deliveryStore.appendAgentRunEvent(
      runId,
      'progress',
      {
        message: 'Resume checkpoint',
        metadata: {
          item: {
            id: 'resume-checkpoint',
            label: 'Resume checkpoint',
            status: 'done',
            detail: '/private/workspace/path',
          },
        },
      },
    );
    const secondAbort = new AbortController();
    const secondResponse = await fetch(
      `${server.baseUrl}/v1/assistant/sessions/${sessionId}/events`,
      {
        headers: { 'last-event-id': String(cursor) },
        signal: secondAbort.signal,
      },
    );
    const secondFrames = await readSseUntil(
      secondResponse,
      (frames) => frames.some((frame) => frame.event === 'run_event'),
    );
    secondAbort.abort();
    const resumed = secondFrames.filter((frame) => frame.event === 'run_event');
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].id, String(resumedEvent.sequence));
    assert.equal(resumed[0].data.event.message, 'Resume checkpoint');
    assert.deepEqual(resumed[0].data.event.metadata.item, {
      id: 'resume-checkpoint',
      label: 'Resume checkpoint',
      status: 'done',
    });
  },
);

test(
  'Web Assistant persists a project thread across worker and server restart',
  { timeout: 25_000 },
  async (context) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-web-assistant-'));
    const processes = [];
    context.after(async () => {
      await Promise.all(processes.map(stopProcess));
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const first = await startServer(dataDir);
    processes.push(first.child);

    const missingProject = await postJson(first.baseUrl, '/v1/assistant/sessions', {
      workspaceId: 'dev-workspace',
      projectId: 'missing',
    });
    assert.equal(missingProject.response.status, 404);
    assert.equal(missingProject.data.error, 'assistant_project_not_found');

    const created = await postJson(first.baseUrl, '/v1/assistant/sessions', {
      workspaceId: 'dev-workspace',
      projectId: 'opentag',
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.data.session.projectId, 'opentag');
    assert.match(created.data.session.threadId, /^web:dev-workspace:opentag:/u);
    assert.equal(created.data.thread.visibility, 'private');

    const sessionId = created.data.session.id;
    const queued = await postJson(
      first.baseUrl,
      `/v1/assistant/sessions/${sessionId}/messages`,
      { text: 'Summarize the release readiness.' },
    );
    assert.equal(queued.response.status, 202);
    assert.equal(queued.data.run.platform, 'web');
    assert.equal(queued.data.run.status, 'queued');
    assert.equal(queued.data.run.transportMode, 'tracked-text');
    const autoTitled = await fetch(
      `${first.baseUrl}/v1/assistant/sessions/${sessionId}`,
    ).then((response) => response.json());
    assert.equal(autoTitled.session.title, 'Summarize the release readiness.');

    const workerLogs = [];
    const worker = spawn(process.execPath, ['apps/worker/dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTAG_DATA_DIR: dataDir,
        OPENTAG_STORAGE_DRIVER: 'sqlite',
        OPENTAG_WORKER_ONCE: '1',
        OPENTAG_EXECUTOR_MODE: 'dry-run',
        OPENTAG_LARK_TRANSPORT: 'memory',
        OPENTAG_TELEGRAM_TRANSPORT: 'memory',
        OPENTAG_SLACK_TRANSPORT: 'memory',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.push(worker);
    worker.stdout.on('data', (chunk) => workerLogs.push(chunk.toString()));
    worker.stderr.on('data', (chunk) => workerLogs.push(chunk.toString()));
    const [workerCode] = await once(worker, 'exit');
    assert.equal(workerCode, 0, workerLogs.join(''));

    const completed = await waitForJson(
      `${first.baseUrl}/v1/assistant/sessions/${sessionId}`,
      (data) => data.runs[0]?.status === 'completed',
      first.child,
      first.logs,
    );
    assert.equal(completed.transcript.entries.length, 2);
    assert.deepEqual(
      completed.transcript.entries.map((entry) => entry.role),
      ['user', 'assistant'],
    );
    assert.match(completed.transcript.entries[0].text, /release readiness/u);
    assert.match(completed.transcript.entries[1].text, /Dry-run Codex executor/u);
    assert.equal(completed.runs[0].metadata.source, 'web-assistant');

    await stopProcess(first.child);
    const second = await startServer(dataDir);
    processes.push(second.child);
    const restored = await fetch(
      `${second.baseUrl}/v1/assistant/sessions/${sessionId}`,
    ).then((response) => response.json());
    assert.equal(restored.session.title, 'Summarize the release readiness.');
    assert.equal(restored.session.runCount, 1);
    assert.equal(restored.transcript.entries.length, 2);

    const list = await fetch(
      `${second.baseUrl}/v1/assistant/sessions?workspaceId=dev-workspace`,
    ).then((response) => response.json());
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].id, sessionId);

    const withAttachment = await postJson(
      second.baseUrl,
      `/v1/assistant/sessions/${sessionId}/messages`,
      {
        text: 'Inspect the attached note.',
        attachments: [
          {
            id: 'web-note',
            kind: 'file',
            name: '../../web-note.txt',
            mimeType: 'text/plain',
            contentBase64: Buffer.from('private assistant attachment').toString(
              'base64',
            ),
          },
        ],
      },
    );
    assert.equal(withAttachment.response.status, 202);
    const managedAttachment = withAttachment.data.run.message.attachments[0];
    assert.equal(managedAttachment.name, 'web-note.txt');
    assert.equal(managedAttachment.metadata.managed, true);
    assert.equal(
      path.relative(path.join(dataDir, 'content'), managedAttachment.localPath).startsWith('..'),
      false,
    );
    assert.equal(
      await fs.readFile(managedAttachment.localPath, 'utf8'),
      'private assistant attachment',
    );

    const deliveries = await fetch(
      `${second.baseUrl}/v1/deliveries?workspaceId=dev-workspace&limit=50`,
    ).then((response) => response.json());
    assert.equal(
      deliveries.inboundEvents.some(
        (event) =>
          event.platform === 'web' &&
          event.eventType === 'web.assistant.message' &&
          event.status === 'processed',
      ),
      true,
    );
    assert.equal(
      deliveries.outbox.some(
        (item) => item.kind === 'web.text' && item.status === 'delivered',
      ),
      true,
    );
  },
);
