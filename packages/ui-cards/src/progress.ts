import type { ChecklistItem, ProgressState } from '@opentag/core';

const STATUS_SYMBOL: Record<ChecklistItem['status'], string> = {
  pending: '○',
  running: '●',
  done: '✓',
  failed: '!',
  skipped: '-',
};

export function renderProgressMarkdown(state: ProgressState): string {
  const lines = [
    `## ${state.title}`,
    '',
    `Status: ${state.status}`,
    state.summary ? `Summary: ${state.summary}` : '',
    '',
    ...state.checklist.map((item) => {
      const detail = item.detail ? ` - ${item.detail}` : '';
      return `${STATUS_SYMBOL[item.status]} ${item.label}${detail}`;
    }),
  ].filter(Boolean);
  return lines.join('\n');
}

export interface LarkCardDocument {
  config: {
    wide_screen_mode: boolean;
  };
  header: {
    title: {
      tag: 'plain_text';
      content: string;
    };
    template: string;
  };
  elements: Array<Record<string, unknown>>;
}

function larkTemplateForStatus(status: ProgressState['status']): string {
  switch (status) {
    case 'completed':
      return 'green';
    case 'failed':
    case 'cancelled':
      return 'red';
    case 'blocked':
      return 'orange';
    default:
      return 'blue';
  }
}

export function buildLarkProgressCard(state: ProgressState): LarkCardDocument {
  const checklistText = state.checklist
    .map((item) => {
      const detail = item.detail ? ` - ${item.detail}` : '';
      return `${STATUS_SYMBOL[item.status]} ${item.label}${detail}`;
    })
    .join('\n');

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: state.title,
      },
      template: larkTemplateForStatus(state.status),
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**Status:** ${state.status}`,
        },
      },
      ...(state.summary
        ? [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `**Summary:** ${state.summary}`,
              },
            },
          ]
        : []),
      {
        tag: 'hr',
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: checklistText || 'No checklist items yet.',
        },
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `Updated ${state.updatedAt}`,
          },
        ],
      },
    ],
  };
}

