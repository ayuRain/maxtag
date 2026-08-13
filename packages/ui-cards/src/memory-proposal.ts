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
  return target ? `${proposal.scope} · ${target}` : proposal.scope;
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
            `**Change**\n${
              proposal.action === 'remember'
                ? 'Remember'
                : proposal.action === 'replace'
                  ? 'Replace'
                  : proposal.action === 'merge'
                    ? 'Merge'
                  : proposal.action === 'index'
                    ? 'Index'
                    : 'Forget'
            }`,
          ),
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        padding: '10px',
        elements: [markdown(`**Scope**\n${escapeMarkdown(scopeLabel(proposal))}`)],
      },
    ],
  };
}

function proposalContent(proposal: MemoryProposal): Record<string, unknown> {
  const label =
    proposal.action === 'remember'
      ? 'Memory to add'
      : proposal.action === 'replace'
        ? 'Replacement memory'
        : proposal.action === 'merge'
          ? 'Merged memory'
        : proposal.action === 'index'
          ? 'Approved memory to index'
        : 'Selector to remove';
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
              ? `**Current memory**\n${escapeMarkdown(proposal.selector || '(missing selector)')}\n\n**Replacement memory**\n${escapeMarkdown(proposal.value)}\n\n<font color='grey'>Expected document version: v${proposal.expectedDocumentVersion ?? '?'}</font>`
              : proposal.action === 'merge'
                ? `**Current memories**\n${escapeMarkdown((proposal.selectors || []).join('\n'))}\n\n**Merged memory**\n${escapeMarkdown(proposal.value)}\n\n<font color='grey'>Expected document version: v${proposal.expectedDocumentVersion ?? '?'}</font>`
              : proposal.action === 'index'
                ? `**${label}**\n${escapeMarkdown(proposal.selector || proposal.value)}\n\n**Search aliases**\n${escapeMarkdown((proposal.searchAliases || []).join('\n'))}\n\n<font color='grey'>Expected document version: v${proposal.expectedDocumentVersion ?? '?'}</font>`
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
            `<font color='grey'>Proposed by ${escapeMarkdown(actor)} · ${escapeMarkdown(proposal.createdAt)}</font>`,
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
            text: plainText('Approve'),
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
              title: plainText('Approve this memory change?'),
              text: plainText('The approved change becomes durable scoped memory.'),
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
            text: plainText('Reject'),
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
              title: plainText('Reject this memory change?'),
              text: plainText('The proposal will remain in the audit history as rejected.'),
            },
          },
        ],
      },
    ],
  };
}

function terminalDecision(proposal: MemoryProposal): Record<string, unknown> {
  const decision = proposal.status === 'approved' ? 'Approved' : 'Rejected';
  const actor = proposal.decidedBy || 'unknown';
  const at = proposal.decidedAt || 'unknown time';
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
    ? 'Pending'
    : proposal.status === 'approved'
      ? 'Approved'
      : 'Rejected';
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
      summary: { content: `Memory change ${statusLabel.toLowerCase()}` },
    },
    header: {
      title: plainText('Memory change approval'),
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
