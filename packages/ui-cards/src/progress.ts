import {
  OPENTAG_STOP_RUN_ACTION,
  type ChecklistItem,
  type ProgressState,
} from '@opentag/core';

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

function isTerminalStatus(status: ProgressState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
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
      ...(!isTerminalStatus(state.status)
        ? [
            {
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  text: {
                    tag: 'plain_text',
                    content: 'Stop',
                  },
                  type: 'danger',
                  value: {
                    action: OPENTAG_STOP_RUN_ACTION,
                    run_id: state.runId,
                  },
                  confirm: {
                    title: {
                      tag: 'plain_text',
                      content: 'Stop this task?',
                    },
                    text: {
                      tag: 'plain_text',
                      content: 'OpenTag will stop the current run and queued follow-ups.',
                    },
                  },
                },
              ],
            },
          ]
        : []),
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
