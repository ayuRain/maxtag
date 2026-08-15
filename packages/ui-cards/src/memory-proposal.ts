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

function markdown(
  content: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { tag: 'markdown', content, ...extra };
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
  return markdown(
    proposal.action === 'replace'
      ? `**当前记忆**\n${escapeMarkdown(proposal.selector || '(缺少原内容)')}\n\n**替换为**\n${escapeMarkdown(proposal.value)}`
      : proposal.action === 'merge'
        ? `**当前记忆**\n${escapeMarkdown((proposal.selectors || []).join('\n'))}\n\n**合并为**\n${escapeMarkdown(proposal.value)}`
      : proposal.action === 'index'
        ? `**${label}**\n${escapeMarkdown(proposal.selector || proposal.value)}\n\n**检索别名**\n${escapeMarkdown((proposal.searchAliases || []).join('\n'))}`
        : `**${label}**\n${escapeMarkdown(proposal.value)}`,
  );
}

function proposalAudit(proposal: MemoryProposal): Record<string, unknown> {
  const actor = proposal.actorId || 'unknown';
  return {
    tag: 'collapsible_panel',
    expanded: false,
    border: { color: 'grey', corner_radius: '6px' },
    header: {
      title: plainText('审计信息'),
      icon: { tag: 'standard_icon', token: 'history_outlined' },
      icon_position: 'left',
      padding: '8px 10px 8px 10px',
    },
    padding: '8px 10px 10px 10px',
    elements: [markdown(`提议人：${escapeMarkdown(actor)}  \n提议时间：${escapeMarkdown(proposal.createdAt)}${proposal.expectedDocumentVersion === undefined ? '' : `  \n预期版本：v${proposal.expectedDocumentVersion}`}`, { text_size: 'notation' })],
  };
}

function cardTitle(proposal: MemoryProposal): string {
  if (proposal.status !== 'pending') return '长期记忆';
  switch (proposal.action) {
    case 'remember': return '是否记住这条信息？';
    case 'forget': return '是否忘记这条信息？';
    case 'replace': return '是否更新这条记忆？';
    case 'merge': return '是否合并这些记忆？';
    default: return '是否完善这条记忆的检索？';
  }
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
      width_mode: 'fill',
      enable_forward: false,
      summary: { content: `记忆变更：${statusLabel}` },
    },
    header: {
      title: plainText(cardTitle(proposal)),
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
        proposalContent(proposal),
        ...(pending
          ? [markdown(`<font color='grey'>批准后，MaxTag 会在「${escapeMarkdown(scopeLabel(proposal))}」中持续使用这条信息。</font>`, { text_size: 'notation' })]
          : []),
        proposalAudit(proposal),
        ...(pending ? [approvalActions(proposal)] : [terminalDecision(proposal)]),
      ],
    },
  };
}
