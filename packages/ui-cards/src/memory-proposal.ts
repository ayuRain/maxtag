import {
  OPENTAG_APPROVE_MEMORY_PROPOSAL_ACTION,
  OPENTAG_REJECT_MEMORY_PROPOSAL_ACTION,
  type MemoryProposal,
} from '@opentag/core';

export interface LarkCardV2Document {
  schema: '2.0';
  config: Record<string, unknown>;
  header: Record<string, unknown>;
  body: {
    direction: 'vertical';
    padding: string;
    vertical_spacing: string;
    elements: Array<Record<string, unknown>>;
  };
}

function plainText(content: string): Record<string, unknown> {
  return { tag: 'plain_text', content };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

function boundedText(value: string, maxLength = 1_000): string {
  const normalized = value.trim() || '(empty)';
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

function escapeMarkdown(value: string): string {
  return boundedText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|])/gu, '\\$1');
}

function scopeLabel(proposal: MemoryProposal): string {
  const target =
    proposal.scope === 'project'
      ? proposal.project?.name || proposal.project?.id
      : proposal.scope === 'workspace'
        ? proposal.workspace?.name || proposal.workspace?.id
        : proposal.scope === 'channel'
          ? proposal.thread.channelId || proposal.thread.externalId
          : proposal.scope === 'thread'
            ? proposal.thread.title || proposal.thread.externalId
            : 'MaxTag';
  const scope = proposal.scope === 'workspace'
    ? '公司'
    : proposal.scope === 'project'
      ? '项目'
      : proposal.scope === 'channel'
        ? '群聊'
        : proposal.scope === 'thread'
          ? '话题'
          : '安装';
  return target ? `${scope} · ${target}` : scope;
}

function fieldBlock(proposal: MemoryProposal): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    horizontal_spacing: 'medium',
    background_style: 'blue-50',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px',
        elements: [
          markdown(
            `**操作**\n${
              proposal.action === 'remember'
                ? '记住'
                : proposal.action === 'replace'
                  ? '替换'
                  : proposal.action === 'merge'
                    ? '合并'
                  : proposal.action === 'index'
                    ? '添加检索索引'
                    : '忘记'
            }`,
          ),
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px',
        elements: [markdown(`**生效范围**\n${escapeMarkdown(scopeLabel(proposal))}`)],
      },
    ],
  };
}

function proposalContent(proposal: MemoryProposal): Record<string, unknown> {
  const label =
    proposal.action === 'remember'
      ? '要记住的内容'
      : proposal.action === 'replace'
        ? '替换后的记忆'
        : proposal.action === 'merge'
          ? '合并后的记忆'
        : proposal.action === 'index'
          ? '要添加检索索引的记忆'
        : '要删除的记忆';
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    background_style: 'grey-50',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px',
        elements: [
          markdown(
            proposal.action === 'replace'
              ? `**当前记忆**\n${escapeMarkdown(proposal.selector || '(缺少原内容)')}\n\n**替换后的记忆**\n${escapeMarkdown(proposal.value)}\n\n<font color='grey'>预期文档版本：v${proposal.expectedDocumentVersion ?? '?'}</font>`
              : proposal.action === 'merge'
                ? `**当前记忆**\n${escapeMarkdown((proposal.selectors || []).join('\n'))}\n\n**合并后的记忆**\n${escapeMarkdown(proposal.value)}\n\n<font color='grey'>预期文档版本：v${proposal.expectedDocumentVersion ?? '?'}</font>`
              : proposal.action === 'index'
                ? `**${label}**\n${escapeMarkdown(proposal.selector || proposal.value)}\n\n**检索别名**\n${escapeMarkdown((proposal.searchAliases || []).join('\n'))}\n\n<font color='grey'>预期文档版本：v${proposal.expectedDocumentVersion ?? '?'}</font>`
              : `**${label}**\n${escapeMarkdown(proposal.value)}`,
          ),
        ],
      },
    ],
  };
}

function proposalAudit(proposal: MemoryProposal): Record<string, unknown> {
  const actor = proposal.actorId || 'unknown';
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '0 2px',
        elements: [
          markdown(
            `<font color='grey'>由 ${escapeMarkdown(actor)} 提议 · ${escapeMarkdown(proposal.createdAt)}</font>`,
          ),
        ],
      },
    ],
  };
}

function approvalActions(proposal: MemoryProposal): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    horizontal_spacing: 'medium',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          {
            tag: 'button',
            text: plainText('批准'),
            type: 'primary_filled',
            width: 'fill',
            behaviors: [
              {
                type: 'callback',
                value: {
                  action: OPENTAG_APPROVE_MEMORY_PROPOSAL_ACTION,
                  proposal_id: proposal.id,
                },
              },
            ],
            confirm: {
              title: plainText('批准这条记忆变更？'),
              text: plainText('批准后将作为长期记忆保存到 MaxTag。'),
            },
          },
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          {
            tag: 'button',
            text: plainText('拒绝'),
            type: 'danger',
            width: 'fill',
            behaviors: [
              {
                type: 'callback',
                value: {
                  action: OPENTAG_REJECT_MEMORY_PROPOSAL_ACTION,
                  proposal_id: proposal.id,
                },
              },
            ],
            confirm: {
              title: plainText('拒绝这条记忆变更？'),
              text: plainText('该建议不会写入长期记忆，仅保留审计记录。'),
            },
          },
        ],
      },
    ],
  };
}

function terminalDecision(proposal: MemoryProposal): Record<string, unknown> {
  const decision = proposal.status === 'approved' ? '已批准' : '已拒绝';
  const actor = proposal.decidedBy || '未知';
  const at = proposal.decidedAt || '未知时间';
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    background_style: proposal.status === 'approved' ? 'green-50' : 'red-50',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px',
        elements: [
          markdown(
            `**${decision}**\n${escapeMarkdown(actor)} · ${escapeMarkdown(at)}`,
          ),
        ],
      },
    ],
  };
}

export function buildLarkMemoryProposalCard(
  proposal: MemoryProposal,
): LarkCardV2Document {
  const pending = proposal.status === 'pending';
  const statusLabel = pending
    ? '等待处理'
    : proposal.status === 'approved'
      ? '已批准'
      : '已拒绝';
  const statusColor = pending
    ? 'blue'
    : proposal.status === 'approved'
      ? 'green'
      : 'red';

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
      summary: { content: `记忆变更：${statusLabel}` },
    },
    header: {
      title: plainText('长期记忆确认'),
      subtitle: plainText(scopeLabel(proposal)),
      template: pending ? 'blue' : statusColor,
      icon: { tag: 'standard_icon', token: 'approve_colorful' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: plainText(statusLabel),
          color: statusColor,
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'large',
      elements: [
        fieldBlock(proposal),
        proposalContent(proposal),
        proposalAudit(proposal),
        ...(pending ? [approvalActions(proposal)] : [terminalDecision(proposal)]),
      ],
    },
  };
}
