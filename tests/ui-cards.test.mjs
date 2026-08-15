import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENTAG_APPROVE_MEMORY_PROPOSAL_ACTION,
  OPENTAG_REJECT_MEMORY_PROPOSAL_ACTION,
  OPENTAG_APPROVE_TOOL_ACTION,
  OPENTAG_REJECT_TOOL_ACTION,
  OPENTAG_SET_THREAD_ACTIVATION_ACTION,
  OPENTAG_STOP_RUN_ACTION,
  OPENTAG_TAKE_OVER_RUN_ACTION,
} from '@opentag/core';
import {
  buildLarkMemoryProposalCard,
  buildLarkProgressCard,
  buildLarkToolApprovalCard,
  buildLarkThreadStatusCard,
} from '@opentag/ui-cards';

test('Lark thread status card exposes Chinese capability sections and three activation modes', () => {
  const card = buildLarkThreadStatusCard({
    agentName: 'MaxTag',
    workspaceName: '研发公司',
    workspaceId: 'workspace-1',
    projectName: '支付项目',
    projectId: 'payments',
    channel: '支付研发群',
    topic: 'main',
    visibility: '私有群',
    activationMode: 'mention',
    identity: 'MaxTag [maxtag]',
    executor: 'codex',
    actorAccess: 'project manager',
    memoryRead: ['workspace', 'project', 'channel'],
    memoryWrite: ['project', 'channel'],
    skills: ['发布复核'],
    agents: ['发布检查员'],
    sources: ['发布手册'],
    tools: ['GitHub'],
    network: 'restricted；1 个允许域名',
    activeRoutines: ['每日发布检查'],
    pausedRoutines: [],
    budgetState: '下一次模型调用可用',
    budgetDetails: 'runs 3/100',
    budgetPeriod: '2026-08',
  });
  const buttons = cardButtons(card);
  assert.equal(card.schema, '2.0');
  assert.equal(buttons.length, 3);
  assert.deepEqual(
    buttons.map((button) => button.behaviors[0].value),
    ['mention', 'questions', 'always'].map((mode) => ({
      action: OPENTAG_SET_THREAD_ACTIVATION_ACTION,
      activation_mode: mode,
    })),
  );
  assert.equal(buttons[0].disabled, true);
  assert.match(JSON.stringify(card), /群内设置/u);
  assert.match(JSON.stringify(card), /什么时候响应/u);
  assert.match(JSON.stringify(card), /持续任务/u);
  assert.match(JSON.stringify(card), /可用能力/u);
  assert.match(JSON.stringify(card), /记忆、权限与用量/u);
});

function progressState(status) {
  return {
    runId: 'run-card-control',
    title: 'Working on MaxTag',
    status,
    summary: 'Inspecting the workspace.',
    checklist: [
      { id: 'inspect', label: 'Inspect workspace', status: 'running' },
    ],
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

function cardButtons(card) {
  const buttons = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.tag === 'button') buttons.push(value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card.body);
  return buttons;
}

test('active Lark progress cards expose run-scoped takeover and Stop actions', () => {
  const card = buildLarkProgressCard(progressState('running'));
  const buttons = cardButtons(card);

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.width_mode, 'fill');
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons[0].behaviors[0].value, {
    action: OPENTAG_TAKE_OVER_RUN_ACTION,
    run_id: 'run-card-control',
  });
  assert.equal(buttons[0].type, 'default');
  assert.deepEqual(buttons[1].behaviors[0].value, {
    action: OPENTAG_STOP_RUN_ACTION,
    run_id: 'run-card-control',
  });
  assert.equal(buttons[1].type, 'danger');
  assert.match(JSON.stringify(card), /处理中/u);
  assert.match(JSON.stringify(card), /执行详情/u);
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`terminal ${status} Lark progress cards remove task controls`, () => {
    const card = buildLarkProgressCard(progressState(status));
    assert.equal(cardButtons(card).length, 0);
  });
}

test('waiting Lark progress cards direct the user to the decision card and keep controls', () => {
  const card = buildLarkProgressCard(progressState('waiting'));
  assert.equal(card.header.template, 'orange');
  assert.equal(cardButtons(card).length, 2);
  assert.match(JSON.stringify(card), /等待你的决定/u);
  assert.match(JSON.stringify(card), /确认卡片/u);
});

function memoryProposal(status = 'pending') {
  return {
    id: 'memory-proposal-1',
    status,
    action: 'remember',
    scope: 'project',
    documentKey: 'project:workspace-1:project-1',
    scopeRef: {
      kind: 'project',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      label: 'project memory',
    },
    thread: {
      id: 'lark:chat-1:topic-1',
      platform: 'lark',
      externalId: 'chat-1:topic-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'chat-1',
      visibility: 'public',
    },
    workspace: { id: 'workspace-1', name: 'Workspace One' },
    project: { id: 'project-1', name: 'Project One' },
    value: 'Release trains use the project calendar.',
    actorId: 'lark:ou-proposer',
    createdAt: '2026-08-12T00:00:00.000Z',
    ...(status === 'pending'
      ? {}
      : {
          decidedAt: '2026-08-12T00:01:00.000Z',
          decidedBy: 'lark:ou-manager',
        }),
  };
}

test('pending Lark memory proposal cards use Card 2.0 receipt-scoped actions', () => {
  const card = buildLarkMemoryProposalCard(memoryProposal());
  const buttons = cardButtons(card);

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.width_mode, 'fill');
  assert.equal(card.config.enable_forward, false);
  assert.equal(card.header.template, 'blue');
  assert.equal(buttons.length, 2);
  assert.deepEqual(
    buttons.map((button) => button.behaviors[0].value),
    [
      {
        action: OPENTAG_APPROVE_MEMORY_PROPOSAL_ACTION,
        proposal_id: 'memory-proposal-1',
      },
      {
        action: OPENTAG_REJECT_MEMORY_PROPOSAL_ACTION,
        proposal_id: 'memory-proposal-1',
      },
    ],
  );
});

test('Lark memory merge cards expose every current fact and the merged result', () => {
  const proposal = {
    ...memoryProposal(),
    action: 'merge',
    value: 'Distributed workers use Postgres with 30-day backups.',
    selectors: [
      'Use Postgres for distributed workers.',
      'Keep database backups for 30 days.',
    ],
    expectedDocumentVersion: 4,
  };
  const card = buildLarkMemoryProposalCard(proposal);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /合并/u);
  assert.match(serialized, /Use Postgres for distributed workers/u);
  assert.match(serialized, /Keep database backups for 30 days/u);
  assert.match(serialized, /Postgres with 30\\\\-day backups/u);
});

for (const status of ['approved', 'rejected']) {
  test(`terminal ${status} Lark memory proposal cards remove approval actions`, () => {
    const card = buildLarkMemoryProposalCard(memoryProposal(status));
    assert.equal(card.header.template, status === 'approved' ? 'green' : 'red');
    assert.equal(cardButtons(card).length, 0);
  });
}

function toolApproval(status = 'pending') {
  return {
    id: 'tool-approval-1',
    status,
    runId: 'run-tool-1',
    toolCallId: 'call-tool-1',
    toolName: 'github_issue_create',
    title: 'Create GitHub issue',
    grantKind: 'github',
    risk: 'write',
    arguments: {
      owner: 'acme',
      repo: 'payments',
      title: 'Investigate retry spike',
    },
    argumentSummary: {
      owner: 'acme',
      repo: 'payments',
      title: 'Investigate retry spike',
      bodyLength: 240,
    },
    argumentDigest: '1234567890abcdef',
    platform: 'lark',
    thread: memoryProposal().thread,
    threadId: memoryProposal().thread.id,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    channelId: 'chat-1',
    requestedBy: 'agent:payments',
    requestedAt: '2026-08-13T00:00:00.000Z',
    expiresAt: '2026-08-13T00:15:00.000Z',
    ...(status === 'succeeded'
      ? {
          approvedAt: '2026-08-13T00:01:00.000Z',
          approvedBy: 'lark:ou-manager',
          completedAt: '2026-08-13T00:01:01.000Z',
          resultPreview: 'Created issue #42',
        }
      : {}),
  };
}

test('pending Lark tool approval card binds exact approval actions', () => {
  const card = buildLarkToolApprovalCard(toolApproval());
  const buttons = cardButtons(card);
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.enable_forward, false);
  assert.equal(card.header.template, 'orange');
  assert.deepEqual(
    buttons.map((button) => button.behaviors[0].value),
    [
      {
        action: OPENTAG_APPROVE_TOOL_ACTION,
        approval_id: 'tool-approval-1',
      },
      {
        action: OPENTAG_REJECT_TOOL_ACTION,
        approval_id: 'tool-approval-1',
      },
    ],
  );
  assert.match(JSON.stringify(card), /Investigate retry spike/u);
  assert.match(JSON.stringify(card), /查看操作参数/u);
});

test('Lark tool approval card disables blind approval for unreviewable arguments', () => {
  const approval = toolApproval();
  approval.arguments = {
    ...approval.arguments,
    api_token: 'must-not-be-rendered',
  };
  const card = buildLarkToolApprovalCard(approval);
  const buttons = cardButtons(card);
  assert.deepEqual(
    buttons.map((button) => button.behaviors[0].value.action),
    [OPENTAG_REJECT_TOOL_ACTION],
  );
  assert.doesNotMatch(JSON.stringify(card), /must-not-be-rendered/u);
  assert.match(JSON.stringify(card), /MaxTag 管理台/u);
});

test('terminal Lark tool approval card removes controls and shows result', () => {
  const card = buildLarkToolApprovalCard(toolApproval('succeeded'));
  assert.equal(card.header.template, 'green');
  assert.equal(cardButtons(card).length, 0);
  assert.match(JSON.stringify(card), /Created issue \\\\#42/u);
});
