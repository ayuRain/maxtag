import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OperatorAuth,
  bearerTokenMatches,
  parseOperatorCredentials,
} from '../apps/server/dist/operator-auth.js';

function request(method = 'GET', headers = {}) {
  return { method, headers };
}

test('operator auth signs expiring sessions and validates CSRF separately', async () => {
  const token = 'operator-token-that-is-long-enough-1234';
  const auth = new OperatorAuth({ token, sessionTtlSeconds: 600 });
  const issuedAt = new Date('2026-08-12T00:00:00.000Z');
  const session = await auth.createSession(token, issuedAt);
  assert.ok(session);
  assert.match(session.cookie, /HttpOnly/);
  assert.match(session.cookie, /SameSite=Strict/);
  assert.doesNotMatch(session.cookie, new RegExp(token));

  const cookie = session.cookie.split(';', 1)[0];
  const withoutCsrf = await auth.authenticate(
    request('POST', { cookie }),
    new Date('2026-08-12T00:01:00.000Z'),
  );
  assert.equal(withoutCsrf.authenticated, true);
  assert.equal(withoutCsrf.method, 'session');
  assert.equal(withoutCsrf.csrfValid, false);

  const withCsrf = await auth.authenticate(
    request('POST', {
      cookie,
      'x-opentag-csrf': session.csrfToken,
    }),
    new Date('2026-08-12T00:01:00.000Z'),
  );
  assert.equal(withCsrf.authenticated, true);
  assert.equal(withCsrf.csrfValid, true);
  assert.equal(withCsrf.csrfToken, session.csrfToken);
  assert.deepEqual(withCsrf.principal, {
    id: 'installation-owner',
    displayName: 'Installation owner',
    role: 'owner',
    workspaceIds: ['*'],
  });

  const expired = await auth.authenticate(
    request('GET', { cookie }),
    new Date('2026-08-12T00:11:00.000Z'),
  );
  assert.equal(expired.authenticated, false);

  const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('x') ? 'y' : 'x'}`;
  assert.equal(
    (await auth.authenticate(request('GET', { cookie: tampered }), issuedAt))
      .authenticated,
    false,
  );
});

test('operator auth supports bearer automation and safe disabled mode', async () => {
  const token = 'operator-token-that-is-long-enough-5678';
  const auth = new OperatorAuth({ token });
  const bearerRequest = request('POST', {
    authorization: `Bearer ${token}`,
  });
  assert.equal((await auth.authenticate(bearerRequest)).method, 'bearer');
  assert.equal((await auth.authenticate(bearerRequest)).csrfValid, true);
  assert.equal((await auth.authenticate(bearerRequest)).principal?.id, 'installation-owner');
  assert.equal(bearerTokenMatches(bearerRequest, token), true);
  assert.equal(
    bearerTokenMatches(
      request('GET', { authorization: 'Bearer incorrect-token' }),
      token,
    ),
    false,
  );

  const disabled = new OperatorAuth();
  assert.deepEqual(await disabled.authenticate(request()), {
    authenticated: true,
    method: 'disabled',
    csrfValid: true,
    principal: {
      id: 'local-development',
      displayName: 'Local operator',
      role: 'owner',
      workspaceIds: ['*'],
    },
  });
  assert.throws(
    () => new OperatorAuth({ token: 'too-short' }),
    /at least 24 characters/,
  );
});

test('rotating a static operator token invalidates sessions with a stable signing secret', async () => {
  const shared = {
    principal: {
      id: 'installation-owner',
      displayName: 'Installation owner',
      role: 'owner',
      workspaceIds: ['*'],
    },
    sessionSecret: 'stable-session-signing-secret-123456789',
  };
  const originalToken = 'original-static-token-that-is-long-enough';
  const original = new OperatorAuth({ ...shared, token: originalToken });
  const session = await original.createSession(originalToken);
  assert.ok(session);
  const cookie = session.cookie.split(';', 1)[0];

  const rotated = new OperatorAuth({
    ...shared,
    token: 'rotated-static-token-that-is-long-enough',
  });
  assert.equal(
    (await rotated.authenticate(request('GET', { cookie }))).authenticated,
    false,
  );
});

test('operator auth maps multiple tokens to named workspace principals', async () => {
  const credentials = parseOperatorCredentials(
    JSON.stringify([
      {
        id: 'acme-admin',
        displayName: 'Acme admin',
        role: 'admin',
        workspaceIds: ['acme'],
        token: 'acme-admin-token-that-is-long-enough',
      },
      {
        id: 'audit-viewer',
        displayName: 'Audit viewer',
        role: 'viewer',
        workspaceIds: ['acme', 'labs'],
        token: 'audit-viewer-token-that-is-long-enough',
      },
    ]),
  );
  const auth = new OperatorAuth({
    credentials,
    sessionSecret: 'operator-session-secret-that-is-long-enough',
  });
  assert.equal(auth.configured, true);
  assert.equal(auth.principalCount, 2);

  const bearer = await auth.authenticate(
    request('GET', {
      authorization: 'Bearer audit-viewer-token-that-is-long-enough',
    }),
  );
  assert.deepEqual(bearer.principal, {
    id: 'audit-viewer',
    displayName: 'Audit viewer',
    role: 'viewer',
    workspaceIds: ['acme', 'labs'],
  });
  assert.equal(Object.hasOwn(bearer.principal, 'token'), false);

  const issuedAt = new Date('2026-08-12T01:00:00.000Z');
  const session = await auth.createSession(
    'acme-admin-token-that-is-long-enough',
    issuedAt,
  );
  assert.equal(session?.principal.id, 'acme-admin');
  const cookie = session.cookie.split(';', 1)[0];
  const authenticated = await auth.authenticate(
    request('GET', { cookie }),
    new Date('2026-08-12T01:01:00.000Z'),
  );
  assert.equal(authenticated.principal?.id, 'acme-admin');
  assert.equal(authenticated.principal?.role, 'admin');
});

test('operator principal configuration rejects unsafe or ambiguous credentials', () => {
  assert.throws(
    () => parseOperatorCredentials('{'),
    /must be valid JSON/,
  );
  assert.throws(
    () =>
      parseOperatorCredentials(
        JSON.stringify([
          {
            id: 'missing-scope',
            displayName: 'Missing scope',
            role: 'admin',
            workspaceIds: [],
            token: 'missing-scope-token-that-is-long-enough',
          },
        ]),
      ),
    /workspace_required/,
  );
  const duplicate = {
    id: 'duplicate',
    displayName: 'Duplicate',
    role: 'admin',
    workspaceIds: ['acme'],
    token: 'duplicate-token-that-is-long-enough',
  };
  assert.throws(
    () =>
      new OperatorAuth({
        credentials: [duplicate, { ...duplicate, token: `${duplicate.token}-2` }],
      }),
    /principal_duplicate_duplicate/,
  );
});
