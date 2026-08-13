import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertServerStartupSecurity,
  isLoopbackHost,
  larkEventModeValue,
} from '../apps/server/dist/startup-security.js';

test('server startup security fails closed for public unauthenticated binds', () => {
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.throws(
    () =>
      assertServerStartupSecurity({
        host: '0.0.0.0',
        operatorAuthConfigured: false,
        larkEventMode: 'long-connection',
        larkVerificationTokenConfigured: false,
        larkEncryptKeyConfigured: false,
      }),
    /refuses to bind a non-loopback host/,
  );
  assert.doesNotThrow(() =>
    assertServerStartupSecurity({
      host: '0.0.0.0',
      operatorAuthConfigured: true,
      larkEventMode: 'long-connection',
      larkVerificationTokenConfigured: false,
      larkEncryptKeyConfigured: false,
    }),
  );
});

test('Lark webhook startup requires callback authentication', () => {
  assert.equal(larkEventModeValue(undefined), 'long-connection');
  assert.equal(larkEventModeValue('webhook'), 'webhook');
  assert.throws(() => larkEventModeValue('both'), /must be long-connection or webhook/);
  assert.throws(
    () =>
      assertServerStartupSecurity({
        host: '127.0.0.1',
        operatorAuthConfigured: false,
        larkEventMode: 'webhook',
        larkVerificationTokenConfigured: false,
        larkEncryptKeyConfigured: false,
      }),
    /webhook mode requires/,
  );
  assert.doesNotThrow(() =>
    assertServerStartupSecurity({
      host: '127.0.0.1',
      operatorAuthConfigured: false,
      larkEventMode: 'webhook',
      larkVerificationTokenConfigured: true,
      larkEncryptKeyConfigured: false,
    }),
  );
});
