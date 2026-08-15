import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
} from 'node:crypto';
import test from 'node:test';
import {
  decryptLarkCallbackPayload,
  larkCallbackEventType,
  larkCallbackExternalId,
  normalizeLarkCardAction,
  normalizeFlatLarkCardAction,
  normalizeLarkEvent,
  parseAndValidateLarkCallback,
} from '@opentag/platform-lark';

function encryptPayload(body, encryptKey, iv = Buffer.alloc(16, 7)) {
  const key = createHash('sha256').update(encryptKey).digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

function signedHeaders(rawBody, encryptKey, timestamp = '1786492800') {
  const nonce = 'callback-nonce';
  return {
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256')
      .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
      .digest('hex'),
  };
}

function v2Message(token = 'verification-token') {
  return {
    schema: '2.0',
    header: {
      event_id: 'event-v2-1',
      event_type: 'im.message.receive_v1',
      token,
      tenant_key: 'tenant-v2',
    },
    event: {
      message: {
        message_id: 'message-v2-1',
        chat_id: 'chat-v2',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@MaxTag inspect' }),
      },
      sender: {
        sender_id: { open_id: 'user-v2' },
      },
    },
  };
}

test('Lark decrypt matches the official AES-256-CBC example vector', () => {
  assert.equal(
    decryptLarkCallbackPayload(
      'P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=',
      'test key',
    ),
    'hello world',
  );
});

test('signed encrypted Lark v2 callbacks decrypt, authenticate, and preserve v2 routing fields', () => {
  const encryptKey = 'integration-encrypt-key';
  const inner = v2Message();
  const rawBody = JSON.stringify({ encrypt: encryptPayload(inner, encryptKey) });
  const parsed = parseAndValidateLarkCallback(
    rawBody,
    signedHeaders(rawBody, encryptKey),
    {
      encryptKey,
      verificationToken: 'verification-token',
      maxTimestampSkewSeconds: 300,
      now: new Date('2026-08-12T00:00:00.000Z'),
    },
  );

  assert.deepEqual(parsed.validation, { ok: true });
  assert.equal(larkCallbackExternalId(parsed.body), 'event-v2-1');
  assert.equal(larkCallbackEventType(parsed.body), 'im.message.receive_v1');
  const normalized = normalizeLarkEvent(parsed.body, { botOpenId: 'bot-v2' });
  assert.ok(normalized);
  assert.equal(normalized.thread.workspaceId, 'tenant-v2');
  assert.equal(normalized.thread.metadata.eventId, 'event-v2-1');
});

test('unsigned encrypted URL verification requires a matching configured token', () => {
  const encryptKey = 'challenge-encrypt-key';
  const rawBody = JSON.stringify({
    encrypt: encryptPayload(
      {
        type: 'url_verification',
        token: 'challenge-token',
        challenge: 'challenge-value',
      },
      encryptKey,
    ),
  });

  const accepted = parseAndValidateLarkCallback(rawBody, {}, {
    encryptKey,
    verificationToken: 'challenge-token',
  });
  assert.deepEqual(accepted.validation, { ok: true });
  assert.equal(accepted.body.challenge, 'challenge-value');

  const wrongToken = parseAndValidateLarkCallback(rawBody, {}, {
    encryptKey,
    verificationToken: 'wrong-token',
  });
  assert.equal(wrongToken.validation.reason, 'invalid_verification_token');

  const noTokenPolicy = parseAndValidateLarkCallback(rawBody, {}, { encryptKey });
  assert.equal(noTokenPolicy.validation.reason, 'invalid_signature');

  const timestamped = parseAndValidateLarkCallback(
    rawBody,
    { 'x-lark-request-timestamp': '1786492800' },
    {
      encryptKey,
      verificationToken: 'challenge-token',
      maxTimestampSkewSeconds: 300,
      now: new Date('2026-08-12T00:00:00.000Z'),
    },
  );
  assert.deepEqual(timestamped.validation, { ok: true });
});

test('encrypted Lark events fail closed on missing signature, bad ciphertext, and stale requests', () => {
  const encryptKey = 'strict-encrypt-key';
  const rawBody = JSON.stringify({
    encrypt: encryptPayload(v2Message(), encryptKey),
  });
  const options = {
    encryptKey,
    verificationToken: 'verification-token',
    maxTimestampSkewSeconds: 300,
    now: new Date('2026-08-12T00:00:00.000Z'),
  };

  assert.equal(
    parseAndValidateLarkCallback(rawBody, {}, options).validation.reason,
    'invalid_signature',
  );
  assert.equal(
    parseAndValidateLarkCallback(
      rawBody,
      { ...signedHeaders(rawBody, encryptKey), 'x-lark-signature': 'bad' },
      options,
    ).validation.reason,
    'invalid_signature',
  );

  const corruptBody = JSON.stringify({
    encrypt: Buffer.alloc(32, 4).toString('base64'),
  });
  assert.equal(
    parseAndValidateLarkCallback(
      corruptBody,
      signedHeaders(corruptBody, encryptKey),
      options,
    ).validation.reason,
    'invalid_encrypted_payload',
  );

  const wrongKeyBody = JSON.stringify({
    encrypt: encryptPayload(v2Message(), 'different-encryption-key'),
  });
  assert.equal(
    parseAndValidateLarkCallback(
      wrongKeyBody,
      signedHeaders(wrongKeyBody, encryptKey),
      options,
    ).validation.reason,
    'invalid_encrypted_payload',
  );

  const staleHeaders = signedHeaders(rawBody, encryptKey, '1786480000');
  assert.equal(
    parseAndValidateLarkCallback(rawBody, staleHeaders, options).validation.reason,
    'stale_request',
  );
});

test('Lark callback timestamp policy rejects a missing timestamp header', () => {
  const rawBody = JSON.stringify(v2Message());
  const parsed = parseAndValidateLarkCallback(rawBody, {}, {
    verificationToken: 'verification-token',
    maxTimestampSkewSeconds: 300,
    now: new Date('2026-08-12T00:00:00.000Z'),
  });
  assert.equal(parsed.validation.reason, 'stale_request');
});

test('Lark callback parser rejects non-object JSON and encrypted payloads without a key', () => {
  assert.equal(
    parseAndValidateLarkCallback('null', {}).validation.reason,
    'invalid_json',
  );
  assert.equal(
    parseAndValidateLarkCallback(JSON.stringify({ encrypt: 'AAAA' }), {})
      .validation.reason,
    'encrypt_key_required',
  );
  assert.equal(
    parseAndValidateLarkCallback(JSON.stringify({ encrypt: '' }), {})
      .validation.reason,
    'encrypt_key_required',
  );
  assert.equal(
    parseAndValidateLarkCallback(JSON.stringify({ encrypt: 42 }), {})
      .validation.reason,
    'invalid_encrypted_payload',
  );
});

test('Lark v2 card actions normalize actor, receipt, chat, and run scope', () => {
  const action = normalizeLarkCardAction({
    schema: '2.0',
    header: {
      event_id: 'card-action-event-1',
      event_type: 'card.action.trigger',
      tenant_key: 'tenant-card',
    },
    event: {
      operator: {
        open_id: 'ou-card-operator',
        tenant_key: 'tenant-card',
      },
      action: {
        tag: 'button',
        value: {
          action: 'opentag.stop_run',
          run_id: 'run-card-1',
        },
      },
      context: {
        open_message_id: 'om-progress-card-1',
        open_chat_id: 'oc-project-1',
      },
      host: 'im_message',
    },
  });

  assert.deepEqual(action, {
    action: 'opentag.stop_run',
    runId: 'run-card-1',
    actorId: 'ou-card-operator',
    cardMessageId: 'om-progress-card-1',
    chatId: 'oc-project-1',
    tenantKey: 'tenant-card',
    componentTag: 'button',
  });
});

test('Lark long-connection card actions normalize from flat event output', () => {
  const action = normalizeFlatLarkCardAction({
    type: 'card.action.trigger',
    event_id: 'flat-card-action-1',
    operator_id: 'ou-flat-operator',
    message_id: 'om-flat-progress-card',
    chat_id: 'oc-flat-project',
    action_tag: 'button',
    action_value: JSON.stringify({
      action: 'opentag.stop_run',
      run_id: 'run-flat-1',
    }),
  });

  assert.deepEqual(action, {
    action: 'opentag.stop_run',
    runId: 'run-flat-1',
    actorId: 'ou-flat-operator',
    cardMessageId: 'om-flat-progress-card',
    chatId: 'oc-flat-project',
    componentTag: 'button',
  });

  assert.deepEqual(
    normalizeLarkCardAction({
      type: 'card.action.trigger',
      operator_id: 'ou-flat-operator',
      message_id: 'om-flat-progress-card',
      chat_id: 'oc-flat-project',
      action_tag: 'button',
      action_value: JSON.stringify({
        action: 'opentag.stop_run',
        run_id: 'run-flat-1',
      }),
    }),
    action,
  );
});

test('Lark onboarding card actions preserve the selected Project', () => {
  const v2 = normalizeLarkCardAction({
    schema: '2.0',
    header: { event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou-owner' },
      action: {
        tag: 'button',
        value: {
          action: 'maxtag.history.select_project',
          project_id: 'project-2',
        },
      },
      context: {
        open_message_id: 'om-onboarding',
        open_chat_id: 'oc-group',
      },
    },
  });
  assert.equal(v2.projectId, 'project-2');

  const flat = normalizeFlatLarkCardAction({
    type: 'card.action.trigger',
    operator_id: 'ou-owner',
    message_id: 'om-onboarding',
    chat_id: 'oc-group',
    action_tag: 'button',
    action_value: JSON.stringify({
      action: 'maxtag.history.select_project',
      project_id: 'project-2',
    }),
  });
  assert.equal(flat.projectId, 'project-2');
});

test('Lark memory proposal card actions normalize the proposal receipt scope', () => {
  const v2 = normalizeLarkCardAction({
    schema: '2.0',
    header: {
      event_id: 'memory-proposal-action-v2',
      event_type: 'card.action.trigger',
      tenant_key: 'tenant-card',
    },
    event: {
      operator: { open_id: 'ou-manager' },
      action: {
        tag: 'button',
        value: {
          action: 'opentag.memory_proposal.approve',
          proposal_id: 'proposal-1',
        },
      },
      context: {
        open_message_id: 'om-memory-card',
        open_chat_id: 'oc-project',
      },
    },
  });
  const flat = normalizeFlatLarkCardAction({
    type: 'card.action.trigger',
    operator_id: 'ou-manager',
    message_id: 'om-memory-card',
    chat_id: 'oc-project',
    action_tag: 'button',
    action_value: JSON.stringify({
      action: 'opentag.memory_proposal.reject',
      proposal_id: 'proposal-1',
    }),
  });

  assert.equal(v2.proposalId, 'proposal-1');
  assert.equal(v2.runId, undefined);
  assert.equal(flat.proposalId, 'proposal-1');
  assert.equal(flat.runId, undefined);
});

test('Lark tool approval actions normalize the durable approval id', () => {
  const v2 = normalizeLarkCardAction({
    schema: '2.0',
    header: { event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou-manager' },
      action: {
        tag: 'button',
        value: {
          action: 'opentag.tool_approval.approve',
          approval_id: 'approval-1',
        },
      },
      context: {
        open_message_id: 'om-tool-card',
        open_chat_id: 'oc-project',
      },
    },
  });
  const flat = normalizeFlatLarkCardAction({
    type: 'card.action.trigger',
    operator_id: 'ou-manager',
    message_id: 'om-tool-card',
    chat_id: 'oc-project',
    action_value: JSON.stringify({
      action: 'opentag.tool_approval.reject',
      approval_id: 'approval-1',
    }),
  });
  assert.equal(v2.approvalId, 'approval-1');
  assert.equal(v2.proposalId, undefined);
  assert.equal(flat.approvalId, 'approval-1');
});

test('Lark card action normalization rejects callbacks without durable routing fields', () => {
  assert.equal(
    normalizeLarkCardAction({
      header: { event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou-card-operator' },
        action: { value: { action: 'opentag.stop_run' } },
        context: { open_chat_id: 'oc-project-1' },
      },
    }),
    undefined,
  );
  assert.equal(
    normalizeLarkCardAction({
      header: { event_type: 'im.message.receive_v1' },
    }),
    undefined,
  );
});
