import {
  OPENTAG_APPROVE_TOOL_ACTION,
  OPENTAG_REJECT_TOOL_ACTION,
  type ToolApprovalRecord,
} from '@opentag/core';
import type { LarkCardV2Document } from './memory-proposal.js';

function plainText(content: string): Record<string, unknown> {
  return { tag: 'plain_text', content };
}

function markdown(
  content: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { tag: 'markdown', content, ...extra };
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
      return { label: '等待确认', color: 'orange', background: 'orange-50' };
    case 'approved':
    case 'executing':
      return { label: '执行中', color: 'blue', background: 'blue-50' };
    case 'succeeded':
      return { label: '已完成', color: 'green', background: 'green-50' };
    case 'rejected':
      return { label: '已拒绝', color: 'red', background: 'red-50' };
    case 'expired':
      return { label: '已过期', color: 'grey', background: 'grey-50' };
    default:
      return { label: '执行失败', color: 'red', background: 'red-50' };
  }
}

function argumentLines(approval: ToolApprovalRecord): string {
  const entries = Object.entries(approval.argumentSummary);
  if (!entries.length) return '无额外参数';
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
        ? '参数中包含敏感字段，请在 MaxTag 管理台核对后再批准。'
        : '参数过长，无法在卡片中安全展示；请在 MaxTag 管理台核对。',
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
    text: plainText('拒绝'),
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
            text: plainText('批准并执行'),
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
              title: plainText('批准这次操作？'),
              text: plainText('MaxTag 只会按卡片中展示的参数执行这一次操作。'),
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
      ? approval.resultPreview || '操作已完成。'
      : approval.error ||
        (approval.status === 'rejected'
          ? `由 ${approval.rejectedBy || '审批人'} 拒绝。`
          : approval.status === 'expired'
            ? '该审批已超时，未执行任何操作。'
            : `当前状态：${approval.status}`);
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      enable_forward: false,
      summary: { content: `${approval.title}: ${status.label}` },
    },
    header: {
      title: plainText('需要你的确认'),
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
        ...(approval.status === 'pending'
          ? [markdown('MaxTag 即将执行一个外部操作。请核对内容后决定是否继续。')]
          : []),
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
              elements: [markdown(`**操作**\n${escaped(approval.toolName)}`)],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              padding: '10px',
              elements: [
                markdown(
                  `**项目**\n${escaped(approval.projectId || approval.workspaceId || 'MaxTag')}`,
                ),
              ],
            },
          ],
        },
        {
          tag: 'collapsible_panel',
          expanded: true,
          border: { color: 'grey', corner_radius: '6px' },
          header: {
            title: plainText(argumentsReview.reviewable ? '查看操作参数' : '查看参数摘要'),
            icon: { tag: 'standard_icon', token: 'file_outlined' },
            icon_position: 'left',
            padding: '8px 10px 8px 10px',
          },
          padding: '8px 10px 10px 10px',
          elements: [
            markdown(argumentsReview.content, { text_size: 'notation' }),
            ...(argumentsReview.reason
              ? [markdown(`<font color='orange'>${escaped(argumentsReview.reason)}</font>`)]
              : []),
          ],
        },
        {
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
          elements: [markdown(`申请时间：${escaped(approval.requestedAt)}  \n过期时间：${escaped(approval.expiresAt)}  \n参数摘要：${escaped(approval.argumentDigest.slice(0, 12))}`, { text_size: 'notation' })],
        },
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
