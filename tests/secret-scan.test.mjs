import assert from 'node:assert/strict';
import test from 'node:test';
import { scanText } from '../scripts/scan-secrets.mjs';

test('secret scanner catches high-confidence credentials and supports explicit fixtures', () => {
  const privateKey = `-----BEGIN PRIVATE KEY-----`; // secret-scan: allow
  assert.deepEqual(scanText(privateKey, 'fixture.pem'), [
    { file: 'fixture.pem', line: 1, pattern: 'private-key' },
  ]);
  assert.deepEqual(
    scanText(`${privateKey} # secret-scan: allow`, 'allowed.pem'),
    [],
  );
  assert.deepEqual(scanText('OPENTAG_LARK_APP_SECRET=replace-me'), []);
});
