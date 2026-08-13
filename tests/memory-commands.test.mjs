import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMemoryCommand } from '@opentag/memory';

test('memory commands address channel scope with client-neutral group aliases', () => {
  assert.deepEqual(parseMemoryCommand('remember group deploy on Fridays'), {
    kind: 'remember',
    scope: 'channel',
    value: 'deploy on Fridays',
  });
  assert.deepEqual(parseMemoryCommand('记住 群 发布前先跑 smoke'), {
    kind: 'remember',
    scope: 'channel',
    value: '发布前先跑 smoke',
  });
  assert.deepEqual(parseMemoryCommand('查看记忆 频道'), {
    kind: 'show',
    scope: 'channel',
    value: '',
  });
});
