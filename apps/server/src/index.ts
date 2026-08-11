import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OpenTagRuntime,
  StaticThreadConfigStore,
  type SourceMessage,
  type SourceThread,
} from '@opentag/core';
import { createCodexExecutor } from '@opentag/executor-codex';
import { FileMemoryStore } from '@opentag/memory';
import {
  LarkPlatformAdapter,
  MemoryLarkTransport,
  normalizeLarkEvent,
  type LarkIncomingEvent,
} from '@opentag/platform-lark';

const port = Number(process.env.OPENTAG_PORT || 3077);
const host = process.env.OPENTAG_HOST || '127.0.0.1';
const dataDir = process.env.OPENTAG_DATA_DIR || path.resolve('data');
const botOpenId = process.env.OPENTAG_LARK_BOT_OPEN_ID;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
}

function createRuntimeForDryRun(transport: MemoryLarkTransport): OpenTagRuntime {
  const platform = new LarkPlatformAdapter(transport);
  return new OpenTagRuntime({
    platform,
    executor: createCodexExecutor({ mode: 'dry-run' }),
    memory: new FileMemoryStore(path.join(dataDir, 'memory')),
    threadConfig: new StaticThreadConfigStore({
      displayName: 'OpenTag',
      instructions:
        'You are OpenTag in a shared work thread. Keep progress visible and publish durable artifacts.',
      defaultExecutorId: 'codex',
    }),
  });
}

function coerceDevMessage(body: Record<string, unknown>): {
  thread: SourceThread;
  message: SourceMessage;
} {
  const text = typeof body.text === 'string' ? body.text : 'hello opentag';
  const thread: SourceThread = {
    id: 'lark:dev-chat:root',
    platform: 'lark',
    externalId: 'dev-chat:root',
    channelId: 'dev-chat',
    rootMessageId: 'root',
    topicId: 'root',
    title: 'Development Thread',
    visibility: 'public',
  };
  return {
    thread,
    message: {
      id: `dev-${Date.now()}`,
      threadId: thread.id,
      platform: 'lark',
      text,
      actor: {
        id: 'dev-user',
        displayName: 'Developer',
      },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
  };
}

async function runDryMessage(input: {
  thread: SourceThread;
  message: SourceMessage;
}): Promise<Record<string, unknown>> {
  const transport = new MemoryLarkTransport();
  const runtime = createRuntimeForDryRun(transport);
  const result = await runtime.handleMessage({
    runId: randomUUID(),
    thread: input.thread,
    message: input.message,
  });
  return {
    result,
    larkDryRun: {
      texts: transport.texts,
      cards: transport.cards,
    },
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'opentag-server' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
      sendJson(response, 200, {
        product: 'OpenTag',
        principle: 'Lark first, not Lark only',
        platforms: ['lark', 'telegram-placeholder'],
        executors: ['codex-dry-run', 'claude-placeholder'],
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/dev/messages') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      sendJson(response, 200, await runDryMessage(coerceDevMessage(body)));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/lark/events') {
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      if (typeof body.challenge === 'string') {
        sendJson(response, 200, { challenge: body.challenge });
        return;
      }
      const normalized = normalizeLarkEvent(body as LarkIncomingEvent, { botOpenId });
      if (!normalized) {
        sendJson(response, 202, { accepted: false, reason: 'unsupported_lark_event' });
        return;
      }
      sendJson(response, 200, { accepted: true, ...(await runDryMessage(normalized)) });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    sendJson(response, 500, {
      error: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`OpenTag server listening on http://${host}:${port}`);
});
