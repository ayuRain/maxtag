import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

async function streamText(stream) {
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

async function runObserver(baseUrl, control = 'stop', runId = 'run-stop') {
  const child = spawn(
    process.execPath,
    [
      control === 'takeover'
        ? 'scripts/lark-takeover-smoke.mjs'
        : 'scripts/lark-stop-smoke.mjs',
      `--server-url=${baseUrl}`,
      `--bridge-health-url=${baseUrl}/health`,
      '--workspace-id=dev-workspace',
      '--project-id=opentag',
      `--run-id=${runId}`,
      '--poll-ms=5',
      '--timeout-ms=2000',
      '--json',
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    streamText(child.stdout),
    streamText(child.stderr),
    once(child, 'exit'),
  ]);
  return { stdout, stderr, exit };
}

test('Lark Stop smoke correlates callback, cancellation, and the original card receipt', async () => {
  let healthCalls = 0;
  const actionTime = new Date(Date.now() + 1_000).toISOString();
  const updateTime = new Date(Date.now() + 2_000).toISOString();
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/health') {
        healthCalls += 1;
        const handled = healthCalls > 1;
        response.end(
          JSON.stringify({
            ok: true,
            eventKeys: [
              {
                eventKey: 'card.action.trigger',
                running: true,
                ready: true,
                received: handled ? 1 : 0,
                delivered: handled ? 1 : 0,
                failed: 0,
                ...(handled ? { lastDeliveredAt: actionTime } : {}),
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/runs') {
        const cancelled = healthCalls > 1;
        response.end(
          JSON.stringify({
            runs: [
              {
                id: 'run-stop',
                status: cancelled ? 'cancelled' : 'running',
                platform: 'lark',
                workspaceId: 'dev-workspace',
                projectId: 'opentag',
                threadId: 'lark:oc_stop:om_root',
                createdAt: new Date().toISOString(),
                ...(cancelled
                  ? { lastError: 'lark-card:ou_owner:om_card_stop:stop' }
                  : {}),
                thread: {
                  channelId: 'oc_stop',
                },
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/deliveries') {
        response.end(
          JSON.stringify({
            outbox: [
              {
                id: 'delivery-create',
                runId: 'run-stop',
                kind: 'lark.card.create',
                status: 'delivered',
                externalId: 'om_card_stop',
              },
              ...(healthCalls > 1
                ? [
                    {
                      id: 'delivery-terminal',
                      runId: 'run-stop',
                      kind: 'lark.card.update',
                      status: 'delivered',
                      updatedAt: updateTime,
                      target: { cardId: 'om_card_stop' },
                    },
                  ]
                : []),
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/runs/run-stop/events') {
        response.end(
          JSON.stringify({
            events: [
              {
                id: 'event-stop-requested',
                sequence: 1,
                type: 'cancel_requested',
                at: actionTime,
                message: 'lark-card:ou_owner:om_card_stop:stop',
              },
            ],
            steering: [],
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await runObserver(baseUrl);
    assert.deepEqual(result.exit, [0, null], result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.run, {
      id: 'run-stop',
      status: 'cancelled',
      cancellationSource: 'lark-card-action',
    });
    assert.equal(parsed.card.messageId, 'om_card_stop');
    assert.equal(parsed.card.terminalUpdateDeliveryId, 'delivery-terminal');
    assert.equal(parsed.callback.final.delivered, 1);
    assert.ok(parsed.checks.includes('same_card_terminal_update'));
  } finally {
    server.close();
  }
});

test('Lark Take over smoke accepts a follow-up applied before the takeover event', async () => {
  let healthCalls = 0;
  let runDetailCalls = 0;
  const actionTime = new Date(Date.now() + 1_000).toISOString();
  const updateTime = new Date(Date.now() + 2_000).toISOString();
  const rootId = 'om_applied_root';
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/health') {
        healthCalls += 1;
        const handled = healthCalls > 1;
        response.end(
          JSON.stringify({
            ok: true,
            eventKeys: [
              {
                eventKey: 'card.action.trigger',
                running: true,
                ready: true,
                received: handled ? 1 : 0,
                delivered: handled ? 1 : 0,
                failed: 0,
                ...(handled ? { lastDeliveredAt: actionTime } : {}),
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/runs') {
        const handled = healthCalls > 1;
        response.end(
          JSON.stringify({
            runs: [
              {
                id: 'run-applied',
                status: handled ? 'cancelled' : 'running',
                platform: 'lark',
                workspaceId: 'dev-workspace',
                projectId: 'opentag',
                threadId: `lark:oc_applied:${rootId}`,
                createdAt: new Date().toISOString(),
                ...(handled
                  ? {
                      lastError:
                        'lark-card:ou_collaborator:om_card_applied:human_takeover',
                    }
                  : {}),
                thread: { channelId: 'oc_applied', rootMessageId: rootId },
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/runs/run-applied/events') {
        runDetailCalls += 1;
        const handled = healthCalls > 1;
        response.end(
          JSON.stringify({
            events: handled
              ? [
                  {
                    id: 'event-steering-applied',
                    sequence: 2,
                    type: 'steering_applied',
                    metadata: { steeringId: 'steering-applied' },
                  },
                  {
                    id: 'event-takeover-applied',
                    sequence: 3,
                    type: 'human_takeover',
                    at: actionTime,
                    metadata: {
                      actorId: 'ou_collaborator',
                      actorDisplayName: 'Collaborator',
                      cardMessageId: 'om_card_applied',
                    },
                  },
                  {
                    id: 'event-cancel-requested-applied',
                    sequence: 4,
                    type: 'cancel_requested',
                    at: actionTime,
                    message:
                      'lark-card:ou_collaborator:om_card_applied:human_takeover',
                  },
                ]
              : [],
            steering:
              runDetailCalls === 1
                ? []
                : [{ id: 'steering-applied', status: 'applied' }],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/deliveries') {
        const handled = healthCalls > 1;
        response.end(
          JSON.stringify({
            outbox: [
              {
                id: 'delivery-create-applied',
                runId: 'run-applied',
                kind: 'lark.card.create',
                status: 'delivered',
                externalId: 'om_card_applied',
              },
              ...(handled
                ? [
                    {
                      id: 'delivery-handoff-applied',
                      runId: 'run-applied',
                      threadId: `lark:oc_applied:${rootId}`,
                      kind: 'lark.text',
                      status: 'delivered',
                      updatedAt: updateTime,
                      target: { chatId: 'oc_applied', rootId },
                    },
                    {
                      id: 'delivery-terminal-applied',
                      runId: 'run-applied',
                      kind: 'lark.card.update',
                      status: 'delivered',
                      updatedAt: updateTime,
                      target: { cardId: 'om_card_applied' },
                    },
                  ]
                : []),
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/audit') {
        response.end(
          JSON.stringify({
            entries:
              healthCalls > 1
                ? [
                    {
                      id: 'audit-takeover-applied',
                      action: 'human_takeover',
                      outcome: 'changed',
                      actor: 'lark:ou_collaborator',
                      runId: 'run-applied',
                    },
                  ]
                : [],
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await runObserver(baseUrl, 'takeover', 'run-applied');
    assert.deepEqual(result.exit, [0, null], result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.takeover.followUpStatusAtObservation, 'applied');
    assert.equal(parsed.takeover.followUpFinalStatus, 'applied');
    assert.equal(
      parsed.takeover.followUpEvidenceEventId,
      'event-steering-applied',
    );
    assert.ok(parsed.checks.includes('follow_up_fenced_before_takeover'));
  } finally {
    server.close();
  }
});

test('Lark Take over smoke requires actor, queued steering, handoff, audit, and the original card receipt', async () => {
  let healthCalls = 0;
  let runDetailCalls = 0;
  const actionTime = new Date(Date.now() + 1_000).toISOString();
  const updateTime = new Date(Date.now() + 2_000).toISOString();
  const rootId = 'om_takeover_root';
  const server = await new Promise((resolve) => {
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/health') {
        healthCalls += 1;
        const handled = healthCalls > 1;
        response.end(
          JSON.stringify({
            ok: true,
            eventKeys: [
              {
                eventKey: 'card.action.trigger',
                running: true,
                ready: true,
                received: handled ? 1 : 0,
                delivered: handled ? 1 : 0,
                failed: 0,
                ...(handled ? { lastDeliveredAt: actionTime } : {}),
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/runs') {
        const cancelled = healthCalls > 1;
        response.end(
          JSON.stringify({
            runs: [
              {
                id: 'run-stop',
                status: cancelled ? 'cancelled' : 'running',
                platform: 'lark',
                workspaceId: 'dev-workspace',
                projectId: 'opentag',
                threadId: 'lark:oc_takeover:om_takeover_root',
                createdAt: new Date().toISOString(),
                ...(cancelled
                  ? {
                      lastError:
                        'lark-card:ou_collaborator:om_card_takeover:human_takeover',
                    }
                  : {}),
                thread: {
                  channelId: 'oc_takeover',
                  rootMessageId: rootId,
                },
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/runs/run-stop/events') {
        runDetailCalls += 1;
        const handled = healthCalls > 1;
        response.end(
          JSON.stringify({
            events: handled
              ? [
                  {
                    id: 'event-takeover',
                    sequence: 2,
                    type: 'human_takeover',
                    at: actionTime,
                    metadata: {
                      actorId: 'ou_collaborator',
                      actorDisplayName: 'Collaborator',
                      cardMessageId: 'om_card_takeover',
                    },
                  },
                  {
                    id: 'event-steering-cancelled',
                    sequence: 3,
                    type: 'steering_cancelled',
                    metadata: { steeringId: 'steering-follow-up' },
                  },
                  {
                    id: 'event-cancel-requested',
                    sequence: 4,
                    type: 'cancel_requested',
                    at: actionTime,
                    message:
                      'lark-card:ou_collaborator:om_card_takeover:human_takeover',
                  },
                ]
              : [],
            steering:
              runDetailCalls === 1
                ? []
                : [
                    {
                      id: 'steering-follow-up',
                      status: handled ? 'cancelled' : 'pending',
                      ...(handled
                        ? {
                            lastError:
                              'lark-card:ou_collaborator:om_card_takeover:human_takeover',
                          }
                        : {}),
                    },
                  ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/deliveries') {
        const handled = healthCalls > 1;
        response.end(
          JSON.stringify({
            outbox: [
              {
                id: 'delivery-create',
                runId: 'run-stop',
                kind: 'lark.card.create',
                status: 'delivered',
                externalId: 'om_card_takeover',
              },
              ...(handled
                ? [
                    {
                      id: 'delivery-handoff',
                      runId: 'run-stop',
                      threadId: 'lark:oc_takeover:om_takeover_root',
                      kind: 'lark.text',
                      status: 'delivered',
                      updatedAt: updateTime,
                      target: {
                        chatId: 'oc_takeover',
                        rootId,
                      },
                    },
                    {
                      id: 'delivery-terminal',
                      runId: 'run-stop',
                      kind: 'lark.card.update',
                      status: 'delivered',
                      updatedAt: updateTime,
                      target: { cardId: 'om_card_takeover' },
                    },
                  ]
                : []),
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v1/audit') {
        response.end(
          JSON.stringify({
            entries:
              healthCalls > 1
                ? [
                    {
                      id: 'audit-takeover',
                      action: 'human_takeover',
                      outcome: 'changed',
                      actor: 'lark:ou_collaborator',
                      runId: 'run-stop',
                    },
                  ]
                : [],
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    http.listen(0, '127.0.0.1', () => resolve(http));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await runObserver(baseUrl, 'takeover');
    assert.deepEqual(result.exit, [0, null], result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.event, 'opentag.smoke.lark-human-takeover');
    assert.equal(parsed.run.cancellationSource, 'lark-card-human-takeover');
    assert.deepEqual(parsed.takeover, {
      actorId: 'ou_collaborator',
      actorDisplayName: 'Collaborator',
      eventId: 'event-takeover',
      followUpSteeringId: 'steering-follow-up',
      followUpStatusAtObservation: 'pending',
      followUpFinalStatus: 'cancelled',
      followUpEvidenceEventId: 'event-steering-cancelled',
      handoffDeliveryId: 'delivery-handoff',
      auditEntryId: 'audit-takeover',
    });
    for (const check of [
      'new_follow_up_observed',
      'human_takeover_actor',
      'follow_up_fenced_before_takeover',
      'same_topic_handoff',
      'organization_audit',
    ]) {
      assert.ok(parsed.checks.includes(check));
    }
  } finally {
    server.close();
  }
});
