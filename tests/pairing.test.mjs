import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilePairingStore } from '@opentag/config';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-pairing-'));
  return { root, store: new FilePairingStore(root, { ttlMs: 30_000 }) };
}

function invitationInput(overrides = {}) {
  return {
    platform: 'telegram',
    workspaceId: 'acme',
    projectId: 'payments',
    activationMode: 'mention',
    requireMention: true,
    createdBy: 'operator',
    ...overrides,
  };
}

test('pairing invitations persist only a salted hash and consume once', async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.createInvitation(
      invitationInput(),
      new Date('2026-08-11T10:00:00.000Z'),
    );
    assert.match(created.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(created.command, `/pair ${created.code}`);
    assert.equal(created.ttlSeconds, 30);

    const raw = await fs.readFile(path.join(root, 'pairing-state.json'), 'utf8');
    assert.equal(raw.includes(created.code), false);
    assert.equal(raw.includes(created.code.replace('-', '')), false);
    assert.match(raw, /"codeHash": "[a-f0-9]{64}"/);
    assert.match(raw, /"codeSalt": "[a-f0-9]{32}"/);

    const restarted = new FilePairingStore(root, { ttlMs: 30_000 });
    const consumed = await restarted.consumeCode(
      {
        platform: 'telegram',
        code: created.code.toLowerCase(),
        channelId: '-100123',
        threadExternalId: '-100123:77',
        actorId: 'user-1',
      },
      new Date('2026-08-11T10:00:10.000Z'),
    );
    assert.equal(consumed.ok, true);
    assert.equal(consumed.invitation.status, 'consumed');
    assert.equal(consumed.invitation.consumedBy.channelId, '-100123');
    assert.equal(consumed.invitation.consumedBy.actorId, 'user-1');

    const reused = await restarted.consumeCode(
      {
        platform: 'telegram',
        code: created.code,
        channelId: '-100456',
        threadExternalId: '-100456',
      },
      new Date('2026-08-11T10:00:11.000Z'),
    );
    assert.equal(reused.ok, false);
    assert.equal(reused.reason, 'consumed_code');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('new invitations revoke the prior target code and enforce platform and expiry', async () => {
  const { root, store } = await fixture();
  try {
    const first = await store.createInvitation(
      invitationInput(),
      new Date('2026-08-11T10:00:00.000Z'),
    );
    const second = await store.createInvitation(
      invitationInput(),
      new Date('2026-08-11T10:00:05.000Z'),
    );
    const oldResult = await store.consumeCode(
      {
        platform: 'telegram',
        code: first.code,
        channelId: 'chat-1',
        threadExternalId: 'chat-1',
      },
      new Date('2026-08-11T10:00:06.000Z'),
    );
    assert.equal(oldResult.ok, false);
    assert.equal(oldResult.reason, 'revoked_code');

    const wrongPlatform = await store.consumeCode(
      {
        platform: 'lark',
        code: second.code,
        channelId: 'oc_1',
        threadExternalId: 'oc_1:root',
      },
      new Date('2026-08-11T10:00:07.000Z'),
    );
    assert.equal(wrongPlatform.ok, false);
    assert.equal(wrongPlatform.reason, 'platform_mismatch');

    const expired = await store.consumeCode(
      {
        platform: 'telegram',
        code: second.code,
        channelId: 'chat-1',
        threadExternalId: 'chat-1',
      },
      new Date('2026-08-11T10:00:36.000Z'),
    );
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, 'expired_code');

    const summary = await store.summarize('acme');
    assert.deepEqual(summary, {
      pending: 0,
      consumed: 0,
      expired: 1,
      revoked: 1,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('actor-restricted pairing invitations reject other users without consuming the code', async () => {
  const { root, store } = await fixture();
  try {
    const created = await store.createInvitation(
      invitationInput({
        allowedActorIds: ['allowed-user', 'allowed-user', '  '],
      }),
      new Date('2026-08-11T10:00:00.000Z'),
    );
    assert.deepEqual(created.invitation.allowedActorIds, ['allowed-user']);

    const rejected = await store.consumeCode(
      {
        platform: 'telegram',
        code: created.code,
        channelId: 'chat-1',
        threadExternalId: 'chat-1',
        actorId: 'other-user',
      },
      new Date('2026-08-11T10:00:05.000Z'),
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'actor_not_allowed');
    assert.equal(rejected.invitation.status, 'pending');

    const consumed = await store.consumeCode(
      {
        platform: 'telegram',
        code: created.code,
        channelId: 'chat-2',
        threadExternalId: 'chat-2',
        actorId: 'allowed-user',
      },
      new Date('2026-08-11T10:00:06.000Z'),
    );
    assert.equal(consumed.ok, true);
    assert.equal(consumed.invitation.consumedBy.actorId, 'allowed-user');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
