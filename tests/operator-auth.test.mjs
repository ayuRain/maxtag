import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OperatorAuth,
  bearerTokenMatches,
} from '../apps/server/dist/operator-auth.js';

function request(method = 'GET', headers = {}) {
  return { method, headers };
}

test('operator auth signs expiring sessions and validates CSRF separately', () => {
  const token = 'operator-token-that-is-long-enough-1234';
  const auth = new OperatorAuth({ token, sessionTtlSeconds: 600 });
  const issuedAt = new Date('2026-08-12T00:00:00.000Z');
  const session = auth.createSession(token, issuedAt);
  assert.ok(session);
  assert.match(session.cookie, /HttpOnly/);
  assert.match(session.cookie, /SameSite=Strict/);
  assert.doesNotMatch(session.cookie, new RegExp(token));

  const cookie = session.cookie.split(';', 1)[0];
  const withoutCsrf = auth.authenticate(
    request('POST', { cookie }),
    new Date('2026-08-12T00:01:00.000Z'),
  );
  assert.equal(withoutCsrf.authenticated, true);
  assert.equal(withoutCsrf.method, 'session');
  assert.equal(withoutCsrf.csrfValid, false);

  const withCsrf = auth.authenticate(
    request('POST', {
      cookie,
      'x-opentag-csrf': session.csrfToken,
    }),
    new Date('2026-08-12T00:01:00.000Z'),
  );
  assert.equal(withCsrf.authenticated, true);
  assert.equal(withCsrf.csrfValid, true);
  assert.equal(withCsrf.csrfToken, session.csrfToken);

  const expired = auth.authenticate(
    request('GET', { cookie }),
    new Date('2026-08-12T00:11:00.000Z'),
  );
  assert.equal(expired.authenticated, false);

  const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('x') ? 'y' : 'x'}`;
  assert.equal(
    auth.authenticate(request('GET', { cookie: tampered }), issuedAt)
      .authenticated,
    false,
  );
});

test('operator auth supports bearer automation and safe disabled mode', () => {
  const token = 'operator-token-that-is-long-enough-5678';
  const auth = new OperatorAuth({ token });
  const bearerRequest = request('POST', {
    authorization: `Bearer ${token}`,
  });
  assert.equal(auth.authenticate(bearerRequest).method, 'bearer');
  assert.equal(auth.authenticate(bearerRequest).csrfValid, true);
  assert.equal(bearerTokenMatches(bearerRequest, token), true);
  assert.equal(
    bearerTokenMatches(
      request('GET', { authorization: 'Bearer incorrect-token' }),
      token,
    ),
    false,
  );

  const disabled = new OperatorAuth();
  assert.deepEqual(disabled.authenticate(request()), {
    authenticated: true,
    method: 'disabled',
    csrfValid: true,
  });
  assert.throws(
    () => new OperatorAuth({ token: 'too-short' }),
    /at least 24 characters/,
  );
});
