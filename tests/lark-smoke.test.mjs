import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function createFakeLarkCli(directory, body = '') {
  const cliPath = path.join(directory, 'lark-cli');
  await fs.writeFile(
    cliPath,
    `#!/usr/bin/env node
${body}
const args = process.argv.slice(2);
if (args.includes('schema')) {
  process.stdout.write(JSON.stringify({ ok: true, event_key: 'im.message.receive_v1' }) + '\\n');
  process.exit(0);
}
if (args.includes('consume')) {
  process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');
  process.stdout.write(JSON.stringify({
    event_id: 'smoke-event',
    chat_id: 'oc_smoke',
    message_id: 'om_smoke',
    content: '@MaxTag hi',
  }) + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected fake lark-cli invocation\\n');
process.exit(2);
`,
  );
  await fs.chmod(cliPath, 0o755);
  return cliPath;
}

async function spawnSmoke(args, env = {}, options = {}) {
  let tempDir;
  const cleanup = [];
  if (options.fakeLarkCli !== false) {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-fake-lark-cli-'));
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));
    await createFakeLarkCli(tempDir, options.fakeLarkCliBody || '');
  }
  const child = spawn(process.execPath, ['scripts/lark-smoke.mjs', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(tempDir ? { PATH: `${tempDir}:${process.env.PATH}` } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const [stdoutChunks, stderrChunks, exit] = await Promise.all([
      streamText(child.stdout),
      streamText(child.stderr),
      once(child, 'exit'),
    ]);
    return { stdoutChunks, stderrChunks, exit };
  } finally {
    await Promise.allSettled(cleanup.map((fn) => fn()));
  }
}

test('Lark smoke reports readiness without sending by default', async () => {
  const requests = [];
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'oc_smoke',
                  name: 'Smoke group',
                  chat_type: 'group',
                  member_count: 3,
                },
              ],
            },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ code: 0, data: { message_id: 'unexpected' } }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  try {
    const port = server.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json'],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${port}`,
      },
    );
    assert.deepEqual(exit, [0, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    assert.equal(parsed.ok, true);
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_TENANT_TOKEN').status,
      'pass',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_BOT_INFO').evidence
        .configuredBotMatches,
      true,
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_VISIBLE_CHATS').status,
      'pass',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_TARGET_CHAT_VISIBLE').status,
      'skip',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_WEBHOOK_CALLBACK_CONFIGURED')
        .status,
      'skip',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_LARK_CLI_PROFILE').status,
      'pass',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_LARK_BRIDGE_HEALTH').status,
      'skip',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_LONG_CONNECTION_EVENT').status,
      'manual',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M2_TEXT_DELIVERY').status,
      'skip',
    );
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        '/open-apis/auth/v3/tenant_access_token/internal',
        '/open-apis/bot/v3/info',
        '/open-apis/im/v1/chats?page_size=20',
      ],
    );
  } finally {
    server.close();
  }
});

test('Lark smoke verifies supervised bridge health when configured', async () => {
  const servers = [];
  const lark = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(JSON.stringify({ code: 0, data: { items: [] } }));
        return;
      }
      response.end(JSON.stringify({ code: 0, data: {} }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  servers.push(lark);
  const bridge = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          ok: true,
          service: 'opentag-lark-bridge',
          eventKeys: [
            { eventKey: 'im.message.receive_v1', running: true, ready: true },
            { eventKey: 'card.action.trigger', running: true, ready: true },
          ],
        }),
      );
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  servers.push(bridge);
  try {
    const larkPort = lark.address().port;
    const bridgePort = bridge.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json', `--bridge-health-url=http://127.0.0.1:${bridgePort}/health`],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${larkPort}`,
      },
    );
    assert.deepEqual(exit, [0, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    const bridgeHealth = parsed.checks.find(
      (check) => check.id === 'M1_LARK_BRIDGE_HEALTH',
    );
    assert.equal(bridgeHealth.status, 'pass');
    assert.deepEqual(
      bridgeHealth.evidence.eventKeys.map((item) => item.eventKey).sort(),
      ['card.action.trigger', 'im.message.receive_v1'],
    );
  } finally {
    await Promise.allSettled(
      servers.map(
        (server) =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
});

test('Lark smoke fails bridge health when required event keys are not ready', async () => {
  const servers = [];
  const lark = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(JSON.stringify({ code: 0, data: { items: [] } }));
        return;
      }
      response.end(JSON.stringify({ code: 0, data: {} }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  servers.push(lark);
  const bridge = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          service: 'opentag-lark-bridge',
          eventKeys: [
            { eventKey: 'im.message.receive_v1', running: true, ready: true },
            { eventKey: 'card.action.trigger', running: true, ready: false },
          ],
        }),
      );
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  servers.push(bridge);
  try {
    const larkPort = lark.address().port;
    const bridgePort = bridge.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json', `--bridge-health-url=http://127.0.0.1:${bridgePort}/health`],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${larkPort}`,
      },
    );
    assert.deepEqual(exit, [1, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    const bridgeHealth = parsed.checks.find(
      (check) => check.id === 'M1_LARK_BRIDGE_HEALTH',
    );
    assert.equal(bridgeHealth.status, 'fail');
    assert.deepEqual(bridgeHealth.evidence.missing, ['card.action.trigger']);
  } finally {
    await Promise.allSettled(
      servers.map(
        (server) =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
});

test('Lark smoke proves the target chat is visible before live delivery', async () => {
  const requests = [];
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'oc_target',
                  name: 'Target smoke group',
                  chat_type: 'group',
                  member_count: 5,
                },
              ],
            },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ code: 0, data: { message_id: 'unexpected' } }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  try {
    const port = server.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json', '--chat-id=oc_target'],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${port}`,
      },
    );
    assert.deepEqual(exit, [0, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    const target = parsed.checks.find((check) => check.id === 'M1_TARGET_CHAT_VISIBLE');
    assert.equal(target.status, 'pass');
    assert.equal(target.evidence.chat.chatId, 'oc_t...rget');
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        '/open-apis/auth/v3/tenant_access_token/internal',
        '/open-apis/bot/v3/info',
        '/open-apis/im/v1/chats?page_size=20',
      ],
    );
  } finally {
    server.close();
  }
});

test('Lark smoke blocks live delivery when the target chat is not visible', async () => {
  const requests = [];
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'oc_other',
                  name: 'Other group',
                  chat_type: 'group',
                  member_count: 3,
                },
              ],
            },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ code: 0, data: { message_id: 'should-not-send' } }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  try {
    const port = server.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json', '--send', '--chat-id=oc_missing'],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${port}`,
      },
    );
    assert.deepEqual(exit, [1, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_TARGET_CHAT_VISIBLE').status,
      'fail',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M2_TEXT_DELIVERY').message,
      'Blocked live send because the target Lark chat is not visible to the bot.',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M2_PROGRESS_CARD').message,
      'Blocked live card smoke because the target Lark chat is not visible to the bot.',
    );
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        '/open-apis/auth/v3/tenant_access_token/internal',
        '/open-apis/bot/v3/info',
        '/open-apis/im/v1/chats?page_size=20',
      ],
    );
  } finally {
    server.close();
  }
});

test('Lark smoke proves the native image upload path', async () => {
  const requests = [];
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: request.method, url: request.url, rawBody });
        response.setHeader('content-type', 'application/json');
        if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
          response.end(
            JSON.stringify({
              code: 0,
              tenant_access_token: 'tenant-token',
              expire: 7200,
            }),
          );
          return;
        }
        if (request.url === '/open-apis/bot/v3/info') {
          response.end(
            JSON.stringify({
              code: 0,
              data: {
                bot: {
                  open_id: 'ou_bot',
                  app_name: 'MaxTag Smoke',
                  activate_status: 2,
                },
              },
            }),
          );
          return;
        }
        if (request.url === '/open-apis/im/v1/chats?page_size=20') {
          response.end(
            JSON.stringify({
              code: 0,
              data: {
                items: [{ chat_id: 'oc_target', name: 'Target smoke group' }],
              },
            }),
          );
          return;
        }
        if (request.url === '/open-apis/im/v1/images') {
          response.end(
            JSON.stringify({ code: 0, data: { image_key: 'smoke-image-key' } }),
          );
          return;
        }
        if (
          request.method === 'PATCH' &&
          request.url?.startsWith('/open-apis/im/v1/messages/')
        ) {
          response.end(JSON.stringify({ code: 0, data: {} }));
          return;
        }
        if (request.url === '/open-apis/im/v1/messages?receive_id_type=chat_id') {
          response.end(
            JSON.stringify({
              code: 0,
              data: { message_id: `message-${requests.length}` },
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ code: 404, msg: 'unexpected request' }));
      });
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  try {
    const port = server.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json', '--send', '--image', '--chat-id=oc_target'],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${port}`,
      },
    );
    assert.deepEqual(exit, [0, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    const image = parsed.checks.find(
      (check) => check.id === 'M6_IMAGE_DELIVERY',
    );
    assert.equal(image.status, 'pass');
    assert.equal(image.evidence.messageType, 'image');
    assert.ok(
      requests.some((request) => request.url === '/open-apis/im/v1/images'),
    );
    const imageMessage = requests.find(
      (request) =>
        request.url === '/open-apis/im/v1/messages?receive_id_type=chat_id' &&
        request.rawBody.includes('"msg_type":"image"'),
    );
    assert.ok(imageMessage);
  } finally {
    server.close();
  }
});

test('Lark smoke only requires callback configuration in webhook mode', async () => {
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(JSON.stringify({ code: 0, data: { items: [] } }));
        return;
      }
      response.end(JSON.stringify({ code: 0, data: {} }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  try {
    const port = server.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json', '--event-mode=webhook'],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${port}`,
      },
    );
    assert.deepEqual(exit, [1, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    assert.equal(parsed.ok, false);
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_CALLBACK_URL_REGISTERED')
        .status,
      'fail',
    );
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_ENCRYPT_KEY_CONFIGURED')
        .status,
      'fail',
    );
  } finally {
    server.close();
  }
});

test('Lark smoke posts milestone callbacks with stable run evidence', async () => {
  const requests = [];
  const callbacks = [];
  const server = await new Promise((resolve) => {
    const http = createServer(async (request, response) => {
      const body = await requestBody(request);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(JSON.stringify({ code: 0, data: { items: [] } }));
        return;
      }
      if (request.url === '/milestones') {
        callbacks.push(JSON.parse(body));
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.end(JSON.stringify({ code: 0, data: { message_id: 'unexpected' } }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  try {
    const port = server.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json', '--smoke-run-id=smoke-fixed'],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_VERIFICATION_TOKEN: 'token',
        OPENTAG_LARK_ENCRYPT_KEY: 'encrypt',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${port}`,
        OPENTAG_PUBLIC_CALLBACK_URL: 'https://opentag.example/v1/lark/events',
        OPENTAG_SMOKE_CALLBACK_URL: `http://127.0.0.1:${port}/milestones`,
        OPENTAG_SMOKE_CALLBACK_TOKEN: 'callback-token',
      },
    );
    assert.deepEqual(exit, [0, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    assert.equal(parsed.runId, 'smoke-fixed');
    assert.equal(
      parsed.checks.find((check) => check.id === 'M0_MILESTONE_CALLBACKS').status,
      'pass',
    );
    assert.equal(callbacks.length, parsed.checks.length - 1);
    assert.equal(callbacks[0].event, 'opentag.smoke.milestone');
    assert.equal(callbacks[0].runId, 'smoke-fixed');
    assert.equal(callbacks[0].milestone.id, 'M1_TOKEN_CONFIGURED');
    assert.equal(
      callbacks.find((callback) => callback.milestone.id === 'M1_VISIBLE_CHATS')
        .milestone.status,
      'manual',
    );
    assert.equal(callbacks.at(-1).milestone.id, 'M0_MILESTONE_CALLBACKS');
    assert.equal(parsed.checks.at(-1).id, 'M0_LOCAL_EVIDENCE');
    assert.deepEqual(
      requests
        .filter((request) => request.url === '/milestones')
        .map((request) => request.authorization),
      callbacks.map(() => 'Bearer callback-token'),
    );
  } finally {
    server.close();
  }
});

test('Lark smoke writes local milestone evidence as JSONL', async (context) => {
  const tempDir = await fs.mkdtemp(
    path.join(process.cwd(), '.tmp-opentag-smoke-evidence-'),
  );
  context.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const evidencePath = path.join(tempDir, 'lark-smoke.jsonl');
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(JSON.stringify({ code: 0, data: { items: [] } }));
        return;
      }
      response.end(JSON.stringify({ code: 0, data: {} }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  try {
    const port = server.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      [
        '--json',
        '--smoke-run-id=evidence-fixed',
        `--evidence-jsonl=${path.relative(process.cwd(), evidencePath)}`,
      ],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${port}`,
      },
    );
    assert.deepEqual(exit, [0, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    assert.equal(
      parsed.checks.find((check) => check.id === 'M0_LOCAL_EVIDENCE').status,
      'pass',
    );
    const records = (await fs.readFile(evidencePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records[0].event, 'opentag.smoke.milestone');
    assert.equal(records[0].runId, 'evidence-fixed');
    assert.equal(records[0].milestone.id, 'M1_TOKEN_CONFIGURED');
    assert.equal(records.at(-1).event, 'opentag.smoke.summary');
    assert.equal(records.at(-1).result.runId, 'evidence-fixed');
    assert.equal(records.at(-1).result.ok, true);
    assert.doesNotMatch(await fs.readFile(evidencePath, 'utf8'), /secret|tenant-token/);
  } finally {
    server.close();
  }
});

test('Lark smoke consumes long-connection events with a named lark-cli profile', async (context) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-smoke-'));
  const argvFile = path.join(tempDir, 'argv.json');
  const cliPath = path.join(tempDir, 'lark-cli');
  await fs.writeFile(
    cliPath,
    `#!/usr/bin/env node
const fs = await import('node:fs/promises');
const args = process.argv.slice(2);
await fs.appendFile(process.env.OPENTAG_TEST_ARGV_FILE, JSON.stringify(args) + '\\n');
if (args.includes('schema')) {
  process.stdout.write(JSON.stringify({ ok: true, event_key: 'im.message.receive_v1' }) + '\\n');
  process.exit(0);
}
if (args.includes('consume')) {
  process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');
  process.stdout.write(JSON.stringify({
    event_id: 'smoke-event',
    chat_id: 'oc_smoke',
    message_id: 'om_smoke',
    content: '@MaxTag hi',
  }) + '\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  await fs.chmod(cliPath, 0o755);
  context.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const child = spawn(
    process.execPath,
    [
      'scripts/lark-smoke.mjs',
      '--json',
      '--consume-events',
      '--event-timeout-ms=1000',
      '--lark-cli-profile=opentag-smoke',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH}`,
        OPENTAG_TEST_ARGV_FILE: argvFile,
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: 'http://127.0.0.1:1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const [stdoutChunks, stderrChunks, exit] = await Promise.all([
    streamText(child.stdout),
    streamText(child.stderr),
    once(child, 'exit'),
  ]);
  assert.deepEqual(exit, [1, null], stderrChunks);
  const parsed = JSON.parse(stdoutChunks);
  assert.equal(
    parsed.checks.find((check) => check.id === 'M1_LONG_CONNECTION_EVENT').status,
    'pass',
  );
  assert.equal(
    parsed.checks.find((check) => check.id === 'M1_LARK_CLI_PROFILE').status,
    'pass',
  );
  assert.equal(
    parsed.checks.find((check) => check.id === 'M1_TOKEN_CONFIGURED').evidence
      .larkCliProfile,
    'opentag-smoke',
  );
  const invocations = (await fs.readFile(argvFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(invocations[0], [
    '--profile',
    'opentag-smoke',
    'event',
    'schema',
    'im.message.receive_v1',
    '--json',
  ]);
  assert.deepEqual(invocations.find((args) => args.includes('consume')).slice(0, 5), [
    '--profile',
    'opentag-smoke',
    'event',
    'consume',
    'im.message.receive_v1',
  ]);
});

test('Lark smoke reports lark-cli profile readiness failures separately', async () => {
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        response.end(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
        );
        return;
      }
      if (request.url === '/open-apis/bot/v3/info') {
        response.end(
          JSON.stringify({
            code: 0,
            data: {
              bot: {
                open_id: 'ou_bot',
                app_name: 'MaxTag Smoke',
                activate_status: 2,
              },
            },
          }),
        );
        return;
      }
      if (request.url === '/open-apis/im/v1/chats?page_size=20') {
        response.end(JSON.stringify({ code: 0, data: { items: [] } }));
        return;
      }
      response.end(JSON.stringify({ code: 0, data: {} }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });
  try {
    const port = server.address().port;
    const { stdoutChunks, stderrChunks, exit } = await spawnSmoke(
      ['--json', '--lark-cli-profile=opentag-smoke'],
      {
        OPENTAG_LARK_APP_ID: 'cli_test',
        OPENTAG_LARK_APP_SECRET: 'secret',
        OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
        OPENTAG_LARK_BASE_URL: `http://127.0.0.1:${port}`,
      },
      {
        fakeLarkCliBody: `
if (process.argv.includes('schema')) {
  process.stderr.write('keychain not initialized\\n');
  process.exit(1);
}
`,
      },
    );
    assert.deepEqual(exit, [0, null], stderrChunks);
    const parsed = JSON.parse(stdoutChunks);
    assert.equal(parsed.ok, true);
    const cliProfile = parsed.checks.find(
      (check) => check.id === 'M1_LARK_CLI_PROFILE',
    );
    assert.equal(cliProfile.status, 'manual');
    assert.equal(cliProfile.evidence.profile, 'opentag-smoke');
    assert.match(cliProfile.evidence.stderr, /keychain not initialized/);
    assert.equal(
      parsed.checks.find((check) => check.id === 'M1_TENANT_TOKEN').status,
      'pass',
    );
  } finally {
    server.close();
  }
});

async function streamText(stream) {
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

async function requestBody(request) {
  let text = '';
  request.setEncoding('utf8');
  for await (const chunk of request) text += chunk;
  return text;
}
