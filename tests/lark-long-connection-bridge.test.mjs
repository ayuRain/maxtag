import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { FileLarkBotCredentialStore } from '@opentag/config';
import {
  bridgeHealth,
  configuredEventKeys,
  createBridgeState,
  eventKeyState,
  handleEvent,
  isMainModule,
  larkConsumerExitError,
  larkEventToClientEvent,
  prepareManagedLarkProfile,
  renderBridgeMetrics,
} from '../scripts/lark-long-connection-bridge.mjs';

test('Lark bridge recognizes a symlinked production entrypoint as the main module', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-main-module-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'bridge.mjs');
  const link = path.join(root, 'current-bridge.mjs');
  await fs.writeFile(target, 'export {};\n');
  await fs.symlink(target, link);

  assert.equal(await isMainModule(pathToFileURL(target).href, link), true);
});

test('Lark bridge builds its managed profile through secret stdin in private temporary storage', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-managed-profile-'));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-managed-bin-'));
  const marker = path.join(root, 'invocation.json');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  context.after(() => fs.rm(bin, { recursive: true, force: true }));
  const secret = 'managed-profile-secret-value';
  await new FileLarkBotCredentialStore(root).save({
    appId: 'cli_managed_profile',
    appSecret: secret,
    domain: 'feishu',
    actor: 'test',
  });
  const fake = path.join(bin, 'lark-cli');
  await fs.writeFile(fake, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  await import('node:fs/promises').then((fs) => fs.writeFile(
    process.env.FAKE_LARK_CONFIG_LOG,
    JSON.stringify({ args: process.argv.slice(2), secretLength: input.trim().length, home: process.env.HOME }),
  ));
});
`);
  await fs.chmod(fake, 0o755);
  const priorPath = process.env.PATH;
  const priorMarker = process.env.FAKE_LARK_CONFIG_LOG;
  process.env.PATH = `${bin}:${priorPath}`;
  process.env.FAKE_LARK_CONFIG_LOG = marker;
  let prepared;
  try {
    prepared = await prepareManagedLarkProfile({ dataDir: root });
  } finally {
    process.env.PATH = priorPath;
    if (priorMarker === undefined) delete process.env.FAKE_LARK_CONFIG_LOG;
    else process.env.FAKE_LARK_CONFIG_LOG = priorMarker;
  }
  context.after(() => fs.rm(prepared.larkCliHome, { recursive: true, force: true }));
  assert.equal(prepared.larkCliProfile, 'maxtag-managed');
  assert.equal(prepared.managedCredentialRevision, 1);
  assert.match(prepared.larkCliHome, /maxtag-lark-cli-/u);
  const invocation = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.deepEqual(invocation.args.slice(0, 2), ['config', 'init']);
  assert.equal(invocation.args.includes(secret), false);
  assert.equal(invocation.secretLength, secret.length);
  assert.equal(invocation.home, prepared.larkCliHome);
});

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

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

function launchBridge(environment) {
  const logs = [];
  const child = spawn(process.execPath, ['scripts/lark-long-connection-bridge.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

async function waitFor(condition, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for condition: ${lastError?.message || 'not ready'}`);
}

async function waitForJson(url, bridge, predicate, options = {}) {
  return waitFor(async () => {
    if (bridge.child.exitCode !== null) {
      throw new Error(`bridge exited early (${bridge.child.exitCode})\n${bridge.logs.join('')}`);
    }
    const response = await fetch(url, {
      headers: options.token
        ? { authorization: `Bearer ${options.token}` }
        : undefined,
    });
    const body = await response.json();
    return response.ok && predicate(body, response) ? body : undefined;
  }, options);
}

async function waitForText(url, bridge, predicate, options = {}) {
  return waitFor(async () => {
    if (bridge.child.exitCode !== null) {
      throw new Error(`bridge exited early (${bridge.child.exitCode})\n${bridge.logs.join('')}`);
    }
    const response = await fetch(url, {
      headers: options.token
        ? { authorization: `Bearer ${options.token}` }
        : undefined,
    });
    const body = await response.text();
    return response.ok && predicate(body, response) ? body : undefined;
  }, options);
}

async function stopBridge(bridge) {
  if (bridge.child.exitCode !== null) return bridge.child.exitCode;
  bridge.child.kill('SIGTERM');
  const [code] = await Promise.race([
    once(bridge.child, 'exit'),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`bridge shutdown timeout\n${bridge.logs.join('')}`)),
        4_000,
      ),
    ),
  ]);
  return code;
}

async function createFakeLarkCli(directory) {
  const script = path.join(directory, 'lark-cli');
  await fs.writeFile(
    script,
    `#!/usr/bin/env node
let args = process.argv.slice(2);
if (args[0] === '--profile') args = args.slice(2);
const eventKey = args[2];
if (args[0] !== 'event' || args[1] !== 'consume' || !eventKey) {
  process.stderr.write('invalid fake lark-cli invocation\\n');
  process.exit(2);
}
process.stderr.write('[event] ready event_key=' + eventKey + '\\n');
const events = {
  'im.message.receive_v1': {
    event_id: 'bridge-message-event',
    chat_id: 'oc_bridge',
    chat_type: 'group',
    message_id: 'om_bridge_message',
    message_type: 'text',
    thread_id: 'omt_bridge',
    root_id: 'om_bridge_root',
    sender_id: 'ou_user',
    sender_type: 'user',
    create_time: '1786450000000',
    content: '@MaxTag bridge smoke',
    mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'MaxTag' }],
  },
  'card.action.trigger': {
    event_id: 'bridge-card-action-event',
    operator_id: 'ou_user',
    message_id: 'om_bridge_card',
    chat_id: 'oc_bridge',
    action_tag: 'button',
    action_value: JSON.stringify({
      action: 'opentag.stop_run',
      run_id: 'bridge-run',
    }),
  },
};
setTimeout(() => {
  const event = events[eventKey];
  if (event) process.stdout.write(JSON.stringify(event) + '\\n');
}, 25);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
`,
  );
  await fs.chmod(script, 0o755);
  return script;
}

test('Lark long-connection bridge maps message events to client ingress payloads', () => {
  const payload = larkEventToClientEvent(
    {
      event_id: 'event-1',
      type: 'im.message.receive_v1',
      chat_id: 'oc_group',
      chat_type: 'group',
      message_id: 'om_message',
      message_type: 'text',
      thread_id: 'omt_thread',
      root_id: 'om_root',
      reply_to: 'om_parent',
      sender_id: 'ou_user',
      sender_type: 'user',
      create_time: '1786450000000',
      content: '@MaxTag ship it',
      mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'MaxTag' }],
    },
    {
      workspaceId: 'tenant-1',
      projectId: 'project-1',
      botOpenId: 'ou_bot',
    },
  );

  assert.equal(payload.platform, 'lark');
  assert.equal(payload.eventId, 'event-1');
  assert.equal(payload.thread.id, 'lark:oc_group:om_root');
  assert.equal(payload.thread.externalId, 'oc_group:om_root');
  assert.equal(payload.thread.workspaceId, 'tenant-1');
  assert.equal(payload.thread.projectId, 'project-1');
  assert.equal(payload.thread.topicId, 'omt_thread');
  assert.equal(payload.thread.rootMessageId, 'om_root');
  assert.equal(payload.message.id, 'om_message');
  assert.equal(payload.message.text, '@MaxTag ship it');
  assert.equal(payload.message.mentionsAgent, true);
  assert.equal(payload.message.replyToMessageId, 'om_parent');
  assert.equal(payload.message.actor.id, 'ou_user');
  assert.equal(payload.message.createdAt, '2026-08-11T12:06:40.000Z');
});

test('Lark long-connection topic root and reply keep one canonical thread identity', () => {
  const root = larkEventToClientEvent({
    event_id: 'event-root',
    chat_id: 'oc_topic',
    chat_type: 'group',
    message_id: 'om_topic_root',
    thread_id: 'omt_topic',
    sender_id: 'ou_user',
    content: '@MaxTag audit this',
  });
  const reply = larkEventToClientEvent({
    event_id: 'event-reply',
    chat_id: 'oc_topic',
    chat_type: 'group',
    message_id: 'om_topic_reply',
    thread_id: 'omt_topic',
    root_id: 'om_topic_root',
    reply_to: 'om_topic_root',
    sender_id: 'ou_user',
    content: '@MaxTag include owners',
  });

  assert.equal(root.thread.id, 'lark:oc_topic:om_topic_root');
  assert.equal(reply.thread.id, root.thread.id);
  assert.equal(reply.thread.rootMessageId, 'om_topic_root');
  assert.equal(reply.thread.topicId, 'omt_topic');
});

test('Lark long-connection top-level group messages share the main conversation', () => {
  const event = (messageId) => larkEventToClientEvent({
    event_id: `event-${messageId}`,
    chat_id: 'oc_regular_group',
    chat_type: 'group',
    message_id: messageId,
    sender_id: 'ou_user',
    content: '@MaxTag continue',
  });
  const first = event('om_first');
  const second = event('om_second');

  assert.equal(first.thread.id, 'lark:oc_regular_group:main');
  assert.equal(second.thread.id, first.thread.id);
  assert.equal(first.thread.externalId, 'oc_regular_group:main');
  assert.equal(first.thread.rootMessageId, 'om_first');
  assert.equal(second.thread.rootMessageId, 'om_second');
  assert.equal(first.thread.topicId, undefined);
  assert.equal(first.thread.metadata.larkConversationMode, 'main');
});

test('Lark regular group replies without thread_id stay in the main conversation', () => {
  const root = larkEventToClientEvent({
    chat_id: 'oc_regular_group',
    chat_type: 'group',
    message_id: 'om_root',
    sender_id: 'ou_user',
    content: '@MaxTag start',
  });
  const reply = larkEventToClientEvent({
    chat_id: 'oc_regular_group',
    chat_type: 'group',
    message_id: 'om_reply',
    root_id: 'om_root',
    reply_to: 'om_root',
    sender_id: 'ou_user',
    content: '@MaxTag continue',
  });

  assert.equal(reply.thread.id, root.thread.id);
  assert.equal(reply.thread.topicId, undefined);
  assert.equal(reply.thread.rootMessageId, 'om_root');
});

test('Lark long-connection bridge recognizes MaxTag and legacy text mentions', () => {
  const event = {
    chat_id: 'oc_group',
    chat_type: 'group',
    message_id: 'om_message',
    sender_id: 'ou_user',
  };

  assert.equal(
    larkEventToClientEvent({ ...event, content: '@MaxTag help' }).message.mentionsAgent,
    true,
  );
  assert.equal(
    larkEventToClientEvent({ ...event, content: '@opentag help' }).message.mentionsAgent,
    true,
  );
  assert.equal(
    larkEventToClientEvent({ ...event, content: 'continue without a mention' }).message.mentionsAgent,
    false,
  );
});

test('Lark long-connection bridge treats p2p messages as agent-addressed', () => {
  const payload = larkEventToClientEvent({
    event_id: 'event-p2p',
    chat_id: 'oc_p2p',
    chat_type: 'p2p',
    message_id: 'om_p2p',
    sender_id: 'ou_user',
    create_time: '1786450000000',
    content: 'hello',
  });

  assert.equal(payload.thread.visibility, 'direct');
  assert.equal(payload.message.mentionsAgent, true);
  assert.equal(payload.thread.workspaceId, 'dev-workspace');
  assert.equal(payload.thread.projectId, undefined);
  assert.equal(payload.thread.id, 'lark:oc_p2p');
  assert.equal(payload.thread.externalId, 'oc_p2p');
  assert.equal(payload.thread.rootMessageId, undefined);
  assert.equal(payload.thread.topicId, undefined);

  const followUp = larkEventToClientEvent({
    event_id: 'event-p2p-follow-up',
    chat_id: 'oc_p2p',
    chat_type: 'p2p',
    message_id: 'om_p2p_follow_up',
    sender_id: 'ou_user',
    create_time: '1786450001000',
    content: 'continue',
  });
  assert.equal(followUp.thread.id, payload.thread.id);
});

test('Lark long-connection bridge listens to message events by default', () => {
  assert.deepEqual(configuredEventKeys(), ['im.message.receive_v1']);
});

test('Lark long-connection bridge diagnoses an independent profile brand mismatch', () => {
  const error = larkConsumerExitError(
    '[SDK ERROR] connect failed, err: 1000040351: Incorrect domain name',
    'im.message.receive_v1',
    'opentag-production',
  );

  assert.match(error, /lark_websocket_profile_domain_mismatch/);
  assert.match(error, /profile=opentag-production/);
  assert.match(error, /independently of OPENTAG_LARK_DOMAIN/);
  assert.match(error, /feishu\/lark brand/);
});

test('Lark long-connection bridge routes card actions to the card endpoint', async () => {
  const result = await handleEvent(
    { dryRun: true },
    {
      type: 'card.action.trigger',
      event_id: 'card-action-event',
      operator_id: 'ou_operator',
      message_id: 'om_card',
      chat_id: 'oc_card',
      action_tag: 'button',
      action_value: JSON.stringify({
        action: 'opentag.stop_run',
        run_id: 'run-1',
      }),
    },
  );

  assert.equal(result.target, 'lark.card-action');
  assert.equal(result.accepted, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.eventId, 'card-action-event');
  assert.equal(result.messageId, 'om_card');
});

test('Lark long-connection bridge health requires every consumer to be ready and running', () => {
  const state = createBridgeState('2026-08-12T00:00:00.000Z');
  const message = eventKeyState(state, 'im.message.receive_v1');
  const action = eventKeyState(state, 'card.action.trigger');
  message.running = true;
  message.ready = true;
  action.running = true;

  assert.equal(bridgeHealth(state).ok, false);

  action.ready = true;
  assert.equal(bridgeHealth(state).ok, true);

  action.running = false;
  action.lastExitCode = 0;
  assert.equal(bridgeHealth(state).ok, false);
});

test('Lark long-connection bridge exports low-cardinality Prometheus metrics', () => {
  const state = createBridgeState('2026-08-12T00:00:00.000Z');
  const message = eventKeyState(state, 'im.message.receive_v1');
  const action = eventKeyState(state, 'card.action.trigger');
  message.running = true;
  message.ready = true;
  message.received = 2;
  message.delivered = 1;
  action.running = true;
  action.ready = false;
  action.failed = 1;

  const metrics = renderBridgeMetrics(state, new Date('2026-08-12T00:01:00.000Z'));

  assert.match(metrics, /opentag_process_up\{service="opentag-lark-bridge"\} 1/);
  assert.match(metrics, /opentag_process_uptime_seconds\{service="opentag-lark-bridge"\} 60/);
  assert.match(metrics, /opentag_lark_bridge_event_key_running\{event_key="im\.message\.receive_v1",service="opentag-lark-bridge"\} 1/);
  assert.match(metrics, /opentag_lark_bridge_event_key_ready\{event_key="card\.action\.trigger",service="opentag-lark-bridge"\} 0/);
  assert.match(metrics, /opentag_lark_bridge_events_failed_total\{event_key="card\.action\.trigger",service="opentag-lark-bridge"\} 1/);
  assert.match(
    metrics,
    /opentag_lark_bridge_backfill_attempts_total\{service="opentag-lark-bridge"\} 0/,
  );
  assert.match(
    metrics,
    /opentag_lark_bridge_backfill_failed_total\{service="opentag-lark-bridge"\} 0/,
  );
  assert.doesNotMatch(metrics, /workspace|project|thread|run_id/iu);
});

test(
  'Lark long-connection bridge runs consumers, forwards events, and stops cleanly',
  { timeout: 15_000 },
  async (context) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-lark-bridge-'));
    await createFakeLarkCli(tempDir);
    const clientEvents = [];
    const cardActions = [];
    const receiver = await new Promise((resolve) => {
      const server = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        try {
          if (request.headers.authorization !== 'Bearer bridge-ingress-token') {
            response.writeHead(401);
            response.end(JSON.stringify({ accepted: false }));
            return;
          }
          if (request.method === 'POST' && request.url === '/v1/client/events') {
            clientEvents.push(await readJsonBody(request));
            response.end(JSON.stringify({ accepted: true }));
            return;
          }
          if (request.method === 'POST' && request.url === '/v1/lark/card-actions') {
            cardActions.push(await readJsonBody(request));
            response.end(
              JSON.stringify({
                accepted: true,
                toast: { type: 'success', content: 'stopping' },
              }),
            );
            return;
          }
          response.writeHead(404);
          response.end(JSON.stringify({ accepted: false }));
        } catch (error) {
          response.writeHead(500);
          response.end(JSON.stringify({ error: error.message }));
        }
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
    const observabilityPort = await freePort();
    const metricsToken = 'bridge-metrics-token';
    const bridge = launchBridge({
      PATH: `${tempDir}:${process.env.PATH}`,
      OPENTAG_SERVER_URL: `http://127.0.0.1:${receiver.address().port}`,
      OPENTAG_CLIENT_INGRESS_TOKEN: 'bridge-ingress-token',
      OPENTAG_LARK_WORKSPACE_ID: 'workspace-bridge',
      OPENTAG_LARK_PROJECT_ID: 'project-bridge',
      OPENTAG_LARK_BOT_OPEN_ID: 'ou_bot',
      OPENTAG_OBSERVABILITY_HOST: '127.0.0.1',
      OPENTAG_LARK_BRIDGE_OBSERVABILITY_PORT: String(observabilityPort),
      // The fake CLI exercises the bridge's generic multi-consumer path. Real
      // lark-cli releases expose message events here but not card callbacks.
      OPENTAG_LARK_BRIDGE_EVENT_KEYS:
        'im.message.receive_v1,card.action.trigger',
      OPENTAG_LARK_CLI_PROFILE: 'opentag-smoke',
      OPENTAG_METRICS_TOKEN: metricsToken,
    });
    context.after(async () => {
      await Promise.allSettled([
        stopBridge(bridge),
        new Promise((resolve, reject) =>
          receiver.close((error) => (error ? reject(error) : resolve())),
        ),
        fs.rm(tempDir, { recursive: true, force: true }),
      ]);
    });

    const health = await waitForJson(
      `http://127.0.0.1:${observabilityPort}/health`,
      bridge,
      (body) =>
        body.ok === true &&
        body.service === 'opentag-lark-bridge' &&
        body.eventKeys.length === 2 &&
        body.eventKeys.every((item) => item.ready && item.running),
    );
    assert.deepEqual(
      health.eventKeys.map((item) => item.eventKey).sort(),
      ['card.action.trigger', 'im.message.receive_v1'],
    );

    await waitFor(
      () => clientEvents.length === 1 && cardActions.length === 1,
      { timeoutMs: 8_000 },
    );
    assert.equal(clientEvents[0].thread.workspaceId, 'workspace-bridge');
    assert.equal(clientEvents[0].thread.projectId, 'project-bridge');
    assert.equal(clientEvents[0].message.mentionsAgent, true);
    assert.equal(cardActions[0].type, 'card.action.trigger');
    assert.equal(cardActions[0].message_id, 'om_bridge_card');

    const anonymous = await fetch(`http://127.0.0.1:${observabilityPort}/metrics`);
    assert.equal(anonymous.status, 401);
    const metrics = await waitForText(
      `http://127.0.0.1:${observabilityPort}/metrics`,
      bridge,
      (body) =>
        body.includes(
          'opentag_lark_bridge_events_delivered_total{event_key="im.message.receive_v1",service="opentag-lark-bridge"} 1',
        ) &&
        body.includes(
          'opentag_lark_bridge_events_delivered_total{event_key="card.action.trigger",service="opentag-lark-bridge"} 1',
        ),
      { token: metricsToken },
    );
    assert.doesNotMatch(metrics, /workspace|project|thread|run_id/iu);

    const exitCode = await stopBridge(bridge);
    assert.equal(exitCode, 0, bridge.logs.join(''));
    assert.match(bridge.logs.join(''), /"event":"stopped"/);
  },
);
