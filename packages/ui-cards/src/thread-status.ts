import { OPENTAG_SET_THREAD_ACTIVATION_ACTION } from '@opentag/core';
import type { LarkCardV2Document } from './memory-proposal.js';

export type ThreadStatusActivationMode = 'mention' | 'questions' | 'always';

export interface ThreadStatusCardModel {
  agentName: string;
  workspaceName: string;
  workspaceId: string;
  projectName: string;
  projectId: string;
  channel: string;
  topic: string;
  visibility: string;
  activationMode: ThreadStatusActivationMode;
  identity: string;
  executor: string;
  actorAccess: string;
  memoryRead: string[];
  memoryWrite: string[];
  skills: string[];
  agents: string[];
  sources: string[];
  capabilityBundles?: string[];
  tools: string[];
  network: string;
  activeRoutines: string[];
  pausedRoutines: string[];
  budgetState: string;
  budgetDetails: string;
  budgetPeriod: string;
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

function escaped(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|])/gu, '\\$1');
}

function list(values: string[], empty = '无', limit = 8): string {
  if (!values.length) return empty;
  const visible = values.slice(0, limit).map(escaped);
  return `${visible.join('、')}${values.length > limit ? `，另有 ${values.length - limit} 项` : ''}`;
}

const activationLabels: Record<ThreadStatusActivationMode, string> = {
  mention: '仅被 @ 时',
  questions: '回答明确问题',
  always: '持续响应',
};

const activationDescriptions: Record<ThreadStatusActivationMode, string> = {
  mention: '默认。群里只有 @MaxTag 才会启动；真实话题内可继续追问。',
  questions: '明确问题会启动，普通闲聊保持安静。',
  always: '每条群消息都可能启动，适合专用工作群。',
};

function activationButton(
  mode: ThreadStatusActivationMode,
  current: ThreadStatusActivationMode,
): Record<string, unknown> {
  return {
    tag: 'button',
    text: plainText(activationLabels[mode]),
    type: mode === current ? 'primary_filled' : 'default',
    size: 'small',
    disabled: mode === current,
    behaviors: [
      {
        type: 'callback',
        value: {
          action: OPENTAG_SET_THREAD_ACTIVATION_ACTION,
          activation_mode: mode,
        },
      },
    ],
    ...(mode === 'always'
      ? {
          confirm: {
            title: plainText('启用持续响应？'),
            text: plainText('启用后，MaxTag 会处理群里的每条消息，可能增加打扰和模型用量。'),
          },
        }
      : {}),
  };
}

function activationControls(model: ThreadStatusCardModel): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    horizontal_spacing: 'small',
    columns: (['mention', 'questions', 'always'] as const).map((mode) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [activationButton(mode, model.activationMode)],
    })),
  };
}

function collapsible(
  title: string,
  icon: string,
  content: string,
  expanded = false,
): Record<string, unknown> {
  return {
    tag: 'collapsible_panel',
    expanded,
    border: { color: 'grey', corner_radius: '6px' },
    header: {
      title: plainText(title),
      icon: { tag: 'standard_icon', token: icon },
      icon_position: 'left',
      padding: '8px 10px 8px 10px',
    },
    padding: '8px 10px 10px 10px',
    elements: [markdown(content, { text_size: 'notation' })],
  };
}

export function buildLarkThreadStatusCard(
  model: ThreadStatusCardModel,
): LarkCardV2Document {
  const activeLabel = activationLabels[model.activationMode];
  const standingWork = [
    `**运行中（${model.activeRoutines.length}）**：${list(model.activeRoutines)}`,
    `**已暂停（${model.pausedRoutines.length}）**：${list(model.pausedRoutines)}`,
    '',
    '群内命令：`@MaxTag 定时任务`、`@MaxTag 定时任务帮助`',
  ].join('\n');
  const capabilities = [
    `**Skills（${model.skills.length}）**：${list(model.skills)}`,
    `**子智能体（${model.agents.length}）**：${list(model.agents)}`,
    `**知识源（${model.sources.length}）**：${list(model.sources)}`,
    `**能力包（${model.capabilityBundles?.length ?? 0}）**：${list(model.capabilityBundles ?? [])}`,
    `**工具（${model.tools.length}）**：${list(model.tools)}`,
    `**网络**：${escaped(model.network)}`,
  ].join('\n\n');
  const access = [
    `**智能体身份**：${escaped(model.identity)} · ${escaped(model.executor)}`,
    `**你的权限**：${escaped(model.actorAccess)}`,
    `**可读记忆**：${list(model.memoryRead)}`,
    `**可写记忆**：${list(model.memoryWrite)}`,
    `**模型用量**：${escaped(model.budgetState)}`,
    `**${escaped(model.budgetPeriod)}**：${escaped(model.budgetDetails)}`,
    '',
    '查看记忆：`@MaxTag 查看记忆 项目` 或 `@MaxTag 查看记忆 工作区`',
  ].join('\n');
  const usage = [
    '**直接交办**：`@MaxTag 帮我分析……`、`@MaxTag 修改代码并验证`',
    '**长任务协作**：在同一话题继续补充要求；可点“停止”或“接管”',
    '**图表与报告**：`@MaxTag 生成交互式发布健康报告，并以后持续更新`',
    '**记忆**：聊天上下文会自动整理；可用 `@MaxTag 查看记忆 项目` 检查',
    '**持续任务**：`@MaxTag 每天 09:00：总结项目进展`、`@MaxTag 定时任务`',
    '**项目归属**：首次入群卡片可选择或创建 Project；管理员也可在管理台调整',
    '**当前状态**：`@MaxTag 状态`、`@MaxTag 帮助`（不消耗模型调用）',
  ].join('\n\n');

  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward_interaction: false,
      summary: { content: `${model.agentName} · 群内能力与触发器` },
    },
    header: {
      title: plainText(`${model.agentName} · 群内设置`),
      subtitle: plainText(`${model.projectName} · ${model.channel}`),
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'settings_outlined' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: plainText(activeLabel),
          color: model.activationMode === 'always' ? 'orange' : 'blue',
        },
      ],
      padding: '12px 16px 12px 16px',
    },
    body: {
      direction: 'vertical',
      padding: '12px 16px 16px 16px',
      vertical_spacing: '12px',
      elements: [
        markdown(
          `**当前项目**：${escaped(model.projectName)}  \n<font color='grey'>工作区 ${escaped(model.workspaceName)} · ${escaped(model.visibility)} · 当前话题 ${escaped(model.topic)}</font>`,
        ),
        markdown(
          `**什么时候响应**\n${escaped(activationDescriptions[model.activationMode])}`,
        ),
        activationControls(model),
        collapsible('怎么使用', 'app_outlined', usage, true),
        collapsible('持续任务', 'calendar_outlined', standingWork, true),
        collapsible('可用能力', 'app_outlined', capabilities),
        collapsible('记忆、权限与用量', 'lock_outlined', access),
        markdown(
          "<font color='grey'>切换响应方式不会改变 Project、记忆或权限。设置仅作用于当前群/话题，并记录操作者。</font>",
          { text_size: 'notation' },
        ),
      ],
    },
  };
}
