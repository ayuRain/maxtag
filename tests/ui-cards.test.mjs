import assert from 'node:assert/strict';
import test from 'node:test';
import { OPENTAG_STOP_RUN_ACTION } from '@opentag/core';
import { buildLarkProgressCard } from '@opentag/ui-cards';

function progressState(status) {
  return {
    runId: 'run-card-control',
    title: 'Working on OpenTag',
    status,
    summary: 'Inspecting the workspace.',
    checklist: [
      { id: 'inspect', label: 'Inspect workspace', status: 'running' },
    ],
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

test('active Lark progress cards expose a run-scoped Stop action', () => {
  const card = buildLarkProgressCard(progressState('running'));
  const actionBlock = card.elements.find((element) => element.tag === 'action');

  assert.ok(actionBlock);
  assert.equal(actionBlock.actions.length, 1);
  assert.deepEqual(actionBlock.actions[0].value, {
    action: OPENTAG_STOP_RUN_ACTION,
    run_id: 'run-card-control',
  });
  assert.equal(actionBlock.actions[0].type, 'danger');
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`terminal ${status} Lark progress cards remove task controls`, () => {
    const card = buildLarkProgressCard(progressState(status));
    assert.equal(
      card.elements.some((element) => element.tag === 'action'),
      false,
    );
  });
}
