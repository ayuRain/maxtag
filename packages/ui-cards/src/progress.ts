import {
  OPENTAG_STOP_RUN_ACTION,
  OPENTAG_TAKE_OVER_RUN_ACTION,
  type ChecklistItem,
  type ProgressState,
} from '@opentag/core';
import type { LarkCardV2Document } from './memory-proposal.js';

const STATUS_SYMBOL: Record<ChecklistItem['status'], string> = {
  pending: '等待',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

const CHECKLIST_LABELS: Record<string, string> = {
  route: '确认项目与权限',
  memory: '加载相关上下文',
  work: '执行任务',
  publish: '回复到当前会话',
};

function plainText(content: string): Record<string, unknown> {
  return { tag: 'plain_text', content };
}

function markdown(content: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { tag: 'markdown', content, ...extra };
}

function compact(value: string, maxLength = 96): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function escaped(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|])/gu, '\\$1');
}

function displayChecklistLabel(item: ChecklistItem): string {
  if (CHECKLIST_LABELS[item.id]) return CHECKLIST_LABELS[item.id];
  return compact(item.label
    .replace(/^Resolve workspace\/project$/u, '确认项目与权限')
    .replace(/^Load scoped memory$/u, '加载相关上下文')
    .replace(/^Publish thread reply$/u, '回复到当前会话')
    .replace(/^Prepare (.+) run(?:\s*-.*)?$/u, '准备 $1')
    .replace(/^Run (.+) app server(?:\s*-.*)?$/u, '连接 $1')
    .replace(/^Run (.+)$/u, '调用 $1')
    .replace(/^Reason through the task$/u, '分析任务')
    .replace(/^agent message$/iu, '生成回复'));
}

function displayDetail(item: ChecklistItem): string {
  const detail = item.detail?.trim();
  if (!detail) return '';
  if (/^\d+\/\d+ line\(s\) \/ empty$/u.test(detail)) return '未找到需要加载的长期记忆';
  if (/^\d+\/\d+ line\(s\)/u.test(detail)) return detail.replace('line(s)', '条记忆');
  if (/^\d+ scope\(s\)$/u.test(detail)) return detail.replace('scope(s)', '个记忆范围');
  if (/^\d+ item\(s\)$/u.test(detail)) return detail.replace('item(s)', '个步骤');
  return compact(detail, 120);
}

function statusPresentation(status: ProgressState['status']): {
  label: string;
  template: string;
  icon: string;
} {
  switch (status) {
    case 'queued':
      return { label: '等待开始', template: 'grey', icon: 'time_outlined' };
    case 'running':
      return { label: '处理中', template: 'wathet', icon: 'loading_outlined' };
    case 'waiting':
      return { label: '等待你的决定', template: 'orange', icon: 'time_outlined' };
    case 'blocked':
      return { label: '等待恢复', template: 'orange', icon: 'warning_outlined' };
    case 'completed':
      return { label: '已完成', template: 'green', icon: 'yes_outlined' };
    case 'cancelled':
      return { label: '已停止', template: 'grey', icon: 'pause_outlined' };
    default:
      return { label: '执行失败', template: 'red', icon: 'warning_outlined' };
  }
}

function currentStep(state: ProgressState): string {
  const running = [...state.checklist].reverse().find((item) => item.status === 'running');
  if (running) return displayChecklistLabel(running);
  if (state.status === 'completed') return '结果已发送';
  if (state.status === 'waiting') return '请处理下方确认卡片';
  if (state.status === 'blocked') return '任务会在服务恢复后继续';
  if (state.status === 'cancelled') return '已保留完成的工作';
  if (state.status === 'failed') return compact(state.summary || '请查看错误详情');
  return '正在准备';
}

function checklistPanel(state: ProgressState): Record<string, unknown> {
  const lines = state.checklist.map((item) => {
    const detail = displayDetail(item);
    return `**${STATUS_SYMBOL[item.status]}** · ${escaped(displayChecklistLabel(item))}${detail ? `  \n<font color='grey'>${escaped(detail)}</font>` : ''}`;
  });
  return {
    tag: 'collapsible_panel',
    expanded: state.status === 'failed',
    border: { color: 'grey', corner_radius: '6px' },
    header: {
      title: plainText(`执行详情 · ${state.checklist.filter((item) => item.status === 'done').length}/${state.checklist.length}`),
      icon: { tag: 'standard_icon', token: 'list_view_outlined' },
      icon_position: 'left',
      padding: '8px 10px 8px 10px',
    },
    padding: '8px 10px 10px 10px',
    elements: [markdown(lines.join('\n\n') || '暂无执行记录', { text_size: 'notation' })],
  };
}

export function renderProgressMarkdown(state: ProgressState): string {
  const presentation = statusPresentation(state.status);
  const lines = [
    `## MaxTag · ${presentation.label}`,
    currentStep(state),
    state.status !== 'completed' && state.summary ? state.summary : '',
    '',
    ...state.checklist.map((item) => {
      const detail = displayDetail(item);
      return `${STATUS_SYMBOL[item.status]} · ${displayChecklistLabel(item)}${detail ? ` — ${detail}` : ''}`;
    }),
  ].filter(Boolean);
  return lines.join('\n');
}

export type LarkCardDocument = LarkCardV2Document;

function isTerminalStatus(status: ProgressState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function activeActions(state: ProgressState): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: 'small',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            text: plainText('交给我处理'),
            type: 'default',
            size: 'small',
            behaviors: [{
              type: 'callback',
              value: { action: OPENTAG_TAKE_OVER_RUN_ACTION, run_id: state.runId },
            }],
            confirm: {
              title: plainText('由你接手这个任务？'),
              text: plainText('MaxTag 会停止当前执行和后续消息，已完成的工作会保留。'),
            },
          },
        ],
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            text: plainText('停止'),
            type: 'danger',
            size: 'small',
            behaviors: [{
              type: 'callback',
              value: { action: OPENTAG_STOP_RUN_ACTION, run_id: state.runId },
            }],
            confirm: {
              title: plainText('停止当前任务？'),
              text: plainText('已完成的工作会保留，当前步骤和后续消息将被停止。'),
            },
          },
        ],
      },
    ],
  };
}

export function buildLarkProgressCard(state: ProgressState): LarkCardDocument {
  const presentation = statusPresentation(state.status);
  const done = state.checklist.filter((item) => item.status === 'done').length;
  const elements: Array<Record<string, unknown>> = [];

  if (state.status === 'failed') {
    elements.push(markdown(`<font color='red'>**${escaped(compact(state.summary || '执行遇到错误', 240))}**</font>`));
  } else if (state.status === 'waiting') {
    elements.push(markdown(`<font color='orange'>**需要你的确认后才能继续外部操作。**</font>\n<font color='grey'>请处理同一话题里的确认卡片；任务状态会自动更新。</font>`));
  } else if (state.status === 'blocked') {
    elements.push(markdown(`<font color='orange'>**服务正在恢复，任务会自动继续。**</font>\n<font color='grey'>无需重新发送消息。</font>`));
  } else if (state.status === 'cancelled') {
    elements.push(markdown('**已停止当前任务。**\n<font color=\'grey\'>已完成的工作不受影响。</font>'));
  } else if (state.status === 'completed') {
    elements.push(markdown('**结果已发送到当前会话。**'));
  } else if (state.summary) {
    elements.push(markdown(escaped(compact(state.summary, 360))));
  }

  elements.push(checklistPanel(state));
  if (!isTerminalStatus(state.status)) elements.push(activeActions(state));

  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward_interaction: false,
      summary: { content: `MaxTag · ${presentation.label}` },
    },
    header: {
      title: plainText('MaxTag'),
      subtitle: plainText(currentStep(state)),
      template: presentation.template,
      icon: { tag: 'standard_icon', token: presentation.icon },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: plainText(presentation.label),
          color: presentation.template === 'wathet' ? 'blue' : presentation.template,
        },
        {
          tag: 'text_tag',
          text: plainText(`${done}/${state.checklist.length} 步`),
          color: 'neutral',
        },
      ],
      padding: '12px 16px 12px 16px',
    },
    body: {
      direction: 'vertical',
      padding: '12px 16px 14px 16px',
      vertical_spacing: '10px',
      elements,
    },
  };
}
