import {
  OPENTAG_APPROVE_TOOL_ACTION,
  OPENTAG_REJECT_TOOL_ACTION,
  type ToolApprovalRecord,
} from '@opentag/core';
import type { LarkCardV2Document } from './memory-proposal.js';

function plainText(content: string): Record<string, unknown> {
  return { tag: 'plain_text', content };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

function bounded(value: unknown, maxLength = 700): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = (text || '(empty)').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

function escaped(value: unknown): string {
  return bounded(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|])/gu, '\\$1');
}

function statusPresentation(approval: ToolApprovalRecord): {
  label: string;
  color: string;
  background: string;
} {
  switch (approval.status) {
    case 'pending':
      return { label: 'Pending', color: 'orange', background: 'orange-50' };
    case 'approved':
    case 'executing':
      return { label: 'Executing', color: 'blue', background: 'blue-50' };
    case 'succeeded':
      return { label: 'Succeeded', color: 'green', background: 'green-50' };
    case 'rejected':
      return { label: 'Rejected', color: 'red', background: 'red-50' };
    case 'expired':
      return { label: 'Expired', color: 'grey', background: 'grey-50' };
    default:
      return { label: 'Failed', color: 'red', background: 'red-50' };
  }
}

function argumentLines(approval: ToolApprovalRecord): string {
  const entries = Object.entries(approval.argumentSummary);
  if (!entries.length) return '(no arguments)';
  return entries
    .map(([key, value]) => `**${escaped(key)}:** ${escaped(value)}`)
    .join('\n');
}

const sensitiveArgumentKey =
  /(?:^|[_-])(authorization|credential|password|secret|token|api[_-]?key)(?:$|[_-])/iu;

function reviewArguments(approval: ToolApprovalRecord): {
  content: string;
  reviewable: boolean;
  reason?: string;
} {
  let containsSensitiveKey = false;
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (sensitiveArgumentKey.test(key)) containsSensitiveKey = true;
      inspect(child);
    }
  };
  inspect(approval.arguments);
  const serialized = JSON.stringify(approval.arguments, null, 2) || '{}';
  if (
    containsSensitiveKey ||
    serialized.includes('```') ||
    serialized.length > 3_000
  ) {
    return {
      content: argumentLines(approval),
      reviewable: false,
      reason: containsSensitiveKey
        ? 'Sensitive-looking fields are hidden. Review the exact JSON in the MaxTag console before approving.'
        : 'The exact arguments are too large for a safe card review. Review them in the MaxTag console before approving.',
    };
  }
  return {
    content: `\`\`\`json\n${serialized
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')}\n\`\`\``,
    reviewable: true,
  };
}

function rejectAction(approval: ToolApprovalRecord): Record<string, unknown> {
  return {
    tag: 'button',
    text: plainText('Reject'),
    type: 'danger',
    width: 'fill',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: OPENTAG_REJECT_TOOL_ACTION,
          approval_id: approval.id,
        },
      },
    ],
  };
}

function pendingActions(
  approval: ToolApprovalRecord,
  reviewable: boolean,
): Record<string, unknown> {
  if (!reviewable) {
    return {
      tag: 'column_set',
      flex_mode: 'stretch',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [rejectAction(approval)],
        },
      ],
    };
  }
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
            text: plainText('Approve and run'),
            type: 'primary_filled',
            width: 'fill',
            behaviors: [
              {
                type: 'callback',
                value: {
                  action: OPENTAG_APPROVE_TOOL_ACTION,
                  approval_id: approval.id,
                },
              },
            ],
            confirm: {
              title: plainText(`Run ${approval.title}?`),
              text: plainText(
                'MaxTag will execute this one operation with the exact arguments shown.',
              ),
            },
          },
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          rejectAction(approval),
        ],
      },
    ],
  };
}

export function buildLarkToolApprovalCard(
  approval: ToolApprovalRecord,
): LarkCardV2Document {
  const status = statusPresentation(approval);
  const argumentsReview = reviewArguments(approval);
  const terminalDetail =
    approval.status === 'succeeded'
      ? approval.resultPreview || 'Operation completed.'
      : approval.error ||
        (approval.status === 'rejected'
          ? `Rejected by ${approval.rejectedBy || 'reviewer'}.`
          : approval.status === 'expired'
            ? 'The approval window expired.'
            : `Status: ${approval.status}`);
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      enable_forward: false,
      summary: { content: `${approval.title}: ${status.label}` },
    },
    header: {
      title: plainText('Tool approval'),
      subtitle: plainText(approval.title),
      template: status.color,
      icon: { tag: 'standard_icon', token: 'approve_colorful' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: plainText(status.label),
          color: status.color,
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'large',
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'bisect',
          horizontal_spacing: 'medium',
          background_style: 'grey-50',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '10px',
              elements: [markdown(`**Tool**\n${escaped(approval.toolName)}`)],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '10px',
              elements: [
                markdown(
                  `**Project**\n${escaped(approval.projectId || approval.workspaceId || 'MaxTag')}`,
                ),
              ],
            },
          ],
        },
        {
          tag: 'column_set',
          flex_mode: 'stretch',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '10px',
              elements: [
                markdown(
                  `**${argumentsReview.reviewable ? 'Exact arguments' : 'Argument summary'}**\n${argumentsReview.content}`,
                ),
                ...(argumentsReview.reason
                  ? [markdown(`<font color='orange'>${escaped(argumentsReview.reason)}</font>`)]
                  : []),
              ],
            },
          ],
        },
        markdown(
          `<font color='grey'>Requested ${escaped(approval.requestedAt)} · Expires ${escaped(approval.expiresAt)} · digest ${escaped(approval.argumentDigest.slice(0, 12))}</font>`,
        ),
        ...(approval.status === 'pending'
          ? [pendingActions(approval, argumentsReview.reviewable)]
          : [
              {
                tag: 'column_set',
                flex_mode: 'stretch',
                background_style: status.background,
                columns: [
                  {
                    tag: 'column',
                    width: 'weighted',
                    weight: 1,
                    padding: '10px',
                    elements: [
                      markdown(`**${status.label}**\n${escaped(terminalDetail)}`),
                    ],
                  },
                ],
              },
            ]),
      ],
    },
  };
}
