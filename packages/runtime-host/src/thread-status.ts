import {
  MEMORY_SCOPE_ORDER,
  memoryScopeGranted,
  type AccessBundle,
  type MemoryScopeKind,
  type SourceThread,
  type UsageBudgetPolicy,
} from '@opentag/core';
import type {
  FileAgentSkillStore,
  FileDelegatedAgentStore,
  FileKnowledgeSourceStore,
  FileThreadConfigStore,
} from '@opentag/config';
import type {
  DeliveryStore,
  ThreadActivationMode,
  UsageBudgetCheckResult,
  UsageBudgetLine,
} from '@opentag/delivery';
import type { RoutineCommandService } from '@opentag/routines';
import {
  buildLarkThreadStatusCard,
  type ThreadStatusCardModel,
} from '@opentag/ui-cards';

export interface ParsedThreadStatusCommand {
  kind: 'status';
}

export interface ThreadStatusResult {
  action: 'status';
  summary: string;
  workspaceId: string;
  projectId: string;
  skillIds: string[];
  agentIds: string[];
  knowledgeSourceIds: string[];
  routineIds: string[];
  capabilityBundleIds: string[];
  budget: UsageBudgetCheckResult;
  activationMode: ThreadActivationMode;
  bindingId?: string;
  card: Record<string, unknown>;
}

interface ThreadStatusAuthorization {
  mode?: string;
  workspaceRole?: string;
  projectRole?: string;
  capabilities?: string[];
}

export interface ThreadStatusServiceOptions {
  threadConfigStore: Pick<FileThreadConfigStore, 'resolveThreadPolicy'>;
  skillStore: Pick<FileAgentSkillStore, 'list'>;
  delegatedAgentStore: Pick<FileDelegatedAgentStore, 'list'>;
  knowledgeSourceStore: Pick<FileKnowledgeSourceStore, 'list'>;
  routineCommandService: Pick<RoutineCommandService, 'listForThread'>;
  deliveryStore: Pick<
    DeliveryStore,
    'checkUsageBudget' | 'getThreadBindingForThread'
  >;
}

function stripAddressing(text: string): string {
  return text
    .trim()
    .replace(/^(@\S+\s*)+/u, '')
    .replace(/^\/(?:maxtag|opentag|tag)(?:@[a-z0-9_]+)?(?:\s+|$)/iu, '')
    .replace(/^\//u, '')
    .replace(/@[a-z0-9_]+$/iu, '')
    .trim();
}

export function parseThreadStatusCommand(
  input: string,
): ParsedThreadStatusCommand | null {
  const text = stripAddressing(input).toLowerCase().replace(/[?？。.]$/u, '').trim();
  return [
    'status',
    'capability',
    'capabilities',
    'what can you access',
    'what do you have access to',
    '状态',
    '能力',
    '你能访问什么',
    '你可以访问什么',
    '你有什么权限',
    'help',
    'usage',
    '使用帮助',
    '怎么用',
    '如何使用',
  ].includes(text)
    ? { kind: 'status' }
    : null;
}

function textValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (item): item is string => typeof item === 'string' && Boolean(item.trim()),
  );
  return values.length ? values : undefined;
}

function authorizationFrom(value: unknown): ThreadStatusAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return {
    mode: typeof input.mode === 'string' ? input.mode : undefined,
    workspaceRole:
      typeof input.workspaceRole === 'string' ? input.workspaceRole : undefined,
    projectRole:
      typeof input.projectRole === 'string' ? input.projectRole : undefined,
    capabilities: textValues(input.capabilities),
  };
}

function boundedList(values: string[], empty = 'none', limit = 6): string {
  if (!values.length) return empty;
  const visible = values.slice(0, limit);
  const suffix = values.length > limit ? `, +${values.length - limit} more` : '';
  return `${visible.join(', ')}${suffix}`;
}

const memoryScopeLabels: Record<MemoryScopeKind, string> = {
  global: '安装',
  workspace: '公司',
  project: '项目',
  channel: '群聊',
  thread: '话题',
};

function memoryScopeLabelsFor(
  access: AccessBundle,
  permission: 'read' | 'write',
): string[] {
  return memoryScopes(access, permission).map((scope) => memoryScopeLabels[scope]);
}

function memoryScopes(
  access: AccessBundle,
  permission: 'read' | 'write',
): MemoryScopeKind[] {
  return MEMORY_SCOPE_ORDER.filter((scope) =>
    memoryScopeGranted(access, scope, permission),
  );
}

function activeBudgetPolicies(access: AccessBundle): UsageBudgetPolicy[] {
  const candidates = access.budgetPolicies?.length
    ? access.budgetPolicies
    : access.budgetPolicy
      ? [access.budgetPolicy]
      : [];
  return candidates.filter(
    (policy) => policy.mode !== 'disabled' && policy.mode !== 'inherit',
  );
}

function budgetLine(
  check: UsageBudgetCheckResult,
  policy: UsageBudgetPolicy,
): UsageBudgetLine | undefined {
  return check.current.find(
    (line) => line.scope === (policy.scope ?? 'project'),
  );
}

function numberLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function budgetPolicyLabel(
  check: UsageBudgetCheckResult,
  policy: UsageBudgetPolicy,
): string {
  const line = budgetLine(check, policy);
  const currentRuns = line?.runs ?? 0;
  const currentCost = line?.costUsd ?? 0;
  const limits: string[] = [];
  if (typeof policy.maxRunsPerMonth === 'number') {
    limits.push(`调用 ${numberLabel(currentRuns)}/${numberLabel(policy.maxRunsPerMonth)}`);
  }
  if (typeof policy.maxCostUsdPerMonth === 'number') {
    limits.push(
      `费用 $${currentCost.toFixed(2)}/$${policy.maxCostUsdPerMonth.toFixed(2)}`,
    );
  }
  const scope = memoryScopeLabels[(policy.scope ?? 'project') as MemoryScopeKind] ??
    (policy.scope ?? '项目');
  return `${scope} ${limits.join('，') || '不限额'}`;
}

function accessLabel(authorization: ThreadStatusAuthorization): string {
  const workspaceRoles: Record<string, string> = {
    owner: '所有者',
    admin: '管理员',
    member: '成员',
    guest: '访客',
  };
  const projectRoles: Record<string, string> = {
    manager: '管理员',
    contributor: '协作者',
    viewer: '查看者',
  };
  const capabilityLabels: Record<string, string> = {
    invoke_agent: '调用智能体',
    write_memory: '写入记忆',
    manage_routines: '管理持续任务',
    manage_workflows: '管理工作流',
  };
  const roles = [
    authorization.workspaceRole
      ? `工作区${workspaceRoles[authorization.workspaceRole] || authorization.workspaceRole}`
      : undefined,
    authorization.projectRole
      ? `Project ${projectRoles[authorization.projectRole] || authorization.projectRole}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const principal = roles.length
    ? roles.join(', ')
    : authorization.mode
      ? authorization.mode
      : '已授权入口';
  return `${principal}；${boundedList(
    (authorization.capabilities ?? []).map(
      (capability) => capabilityLabels[capability] || capability,
    ),
    '仅可调用',
  )}`;
}

function budgetBlockedLabel(check: UsageBudgetCheckResult): string {
  if (check.reason === 'runs_budget_exceeded') {
    return '已阻止（月度调用次数已用完）';
  }
  if (check.reason === 'cost_budget_exceeded') {
    return '已阻止（月度费用额度已用完）';
  }
  return '已阻止（月度用量已用完）';
}

function networkPolicyLabel(access: AccessBundle): string {
  const labels: Record<string, string> = {
    'deny-by-default': '默认禁止',
    'allow-all': '全部允许',
    restricted: '受限',
  };
  return `${labels[access.networkPolicy.mode] || access.networkPolicy.mode}；${access.networkPolicy.allowedHosts.length} 个允许域名`;
}

function activationModeLabel(mode: ThreadActivationMode): string {
  if (mode === 'always') return '持续响应';
  if (mode === 'questions') return '回答明确问题';
  return '仅被 @ 时';
}

function visibilityLabel(value: SourceThread['visibility']): string {
  if (value === 'direct') return '私聊';
  if (value === 'private') return '私有群';
  return '公开群';
}

export class ThreadStatusService {
  constructor(private readonly options: ThreadStatusServiceOptions) {}

  async execute(
    _command: ParsedThreadStatusCommand,
    thread: SourceThread,
    authorizationValue?: unknown,
  ): Promise<ThreadStatusResult> {
    const resolved = await this.options.threadConfigStore.resolveThreadPolicy(thread);
    const skillIds = resolved.access.skillIds ?? [];
    const agentIds = resolved.access.agentIds ?? [];
    const knowledgeSourceIds = resolved.access.knowledgeSourceIds ?? [];
    const [skills, agents, knowledgeSources, routines, budget, binding] = await Promise.all([
      this.options.skillStore.list({ ids: skillIds }),
      this.options.delegatedAgentStore.list({ ids: agentIds }),
      this.options.knowledgeSourceStore.list({
        workspaceId: resolved.workspace.id,
        ids: knowledgeSourceIds,
      }),
      this.options.routineCommandService.listForThread(thread),
      this.options.deliveryStore.checkUsageBudget({
        thread,
        policy: resolved.access.budgetPolicy,
        policies: resolved.access.budgetPolicies,
        expected: { runs: 1, costUsd: 0 },
      }),
      this.options.deliveryStore.getThreadBindingForThread(thread),
    ]);
    const toolGrants = resolved.access.grants.filter(
      (grant) => grant.kind !== 'memory',
    );
    const toolLabels = [
      ...new Set(toolGrants.map((grant) => `${grant.label} (${grant.kind})`)),
    ];
    const policies = activeBudgetPolicies(resolved.access);
    const authorization = authorizationFrom(authorizationValue);
    const channel =
      resolved.channelPolicy?.title || thread.title || thread.channelId || thread.externalId;
    const topic = thread.topicId || thread.rootMessageId || thread.id;
    const enabledRoutines = routines.filter((routine) => routine.enabled);
    const pausedRoutines = routines.length - enabledRoutines.length;
    const budgetState = budget.allowed
      ? '可用'
      : budgetBlockedLabel(budget);
    const budgetDetails = policies.length
      ? policies.map((policy) => budgetPolicyLabel(budget, policy)).join('; ')
      : '无月度上限';
    const activationMode = binding?.activationMode ?? 'mention';
    const cardModel: ThreadStatusCardModel = {
      agentName: resolved.identity.displayName,
      workspaceName: resolved.workspace.name,
      workspaceId: resolved.workspace.id,
      projectName: resolved.project.name,
      projectId: resolved.project.key,
      channel,
      topic,
      visibility: visibilityLabel(thread.visibility),
      activationMode,
      identity: `${resolved.identity.displayName} [${resolved.identity.id}]`,
      executor: resolved.identity.defaultExecutorId,
      actorAccess: accessLabel(authorization),
      memoryRead: memoryScopeLabelsFor(resolved.access, 'read'),
      memoryWrite: memoryScopeLabelsFor(resolved.access, 'write'),
      skills: skills.map((skill) => skill.name),
      agents: agents.map((agent) => agent.name),
      sources: knowledgeSources.map((source) => source.name),
      capabilityBundles: resolved.access.capabilityBundleIds ?? [],
      tools: toolLabels,
      network: networkPolicyLabel(resolved.access),
      activeRoutines: enabledRoutines.map((routine) => routine.name),
      pausedRoutines: routines
        .filter((routine) => !routine.enabled)
        .map((routine) => routine.name),
      budgetState: budget.allowed ? '下一次模型调用可用' : budgetBlockedLabel(budget),
      budgetDetails,
      budgetPeriod: budget.period,
    };

    const summary = [
      `${resolved.identity.displayName} · 群内设置`,
      '',
      '路由',
      `- 工作区：${resolved.workspace.name} [${resolved.workspace.id}]`,
      `- Project：${resolved.project.name} [${resolved.project.key}]`,
      `- 群聊：${channel}`,
      `- 话题：${topic}`,
      `- 响应方式：${activationModeLabel(activationMode)}`,
      '',
      '身份与权限',
      `- 智能体：${resolved.identity.displayName} [${resolved.identity.id}]，执行器 ${resolved.identity.defaultExecutorId}`,
      `- 你的权限：${accessLabel(authorization)}`,
      `- 可读记忆：${boundedList(memoryScopeLabelsFor(resolved.access, 'read'), '无')}`,
      `- 可写记忆：${boundedList(memoryScopeLabelsFor(resolved.access, 'write'), '无')}`,
      '',
      '当前可用',
      `- Skills（${skills.length}）：${boundedList(skills.map((skill) => skill.name), '无')}`,
      `- 子智能体（${agents.length}）：${boundedList(agents.map((agent) => agent.name), '无')}`,
      `- 知识源（${knowledgeSources.length}）：${boundedList(knowledgeSources.map((source) => source.name), '无')}`,
      `- 工具（${toolLabels.length}）：${boundedList(toolLabels, '无')}`,
      `- 能力包（${resolved.access.capabilityBundleIds?.length ?? 0}）：${boundedList(resolved.access.capabilityBundleIds ?? [], '无')}`,
      `- 持续任务：${enabledRoutines.length} 个运行中${pausedRoutines ? `，${pausedRoutines} 个已暂停` : ''}`,
      '',
      '用量',
      `- 下一次模型调用：${budgetState}`,
      `- ${budget.period}：${budgetDetails}`,
      '- 查看本卡片不消耗模型调用。',
    ].join('\n');

    return {
      action: 'status',
      summary,
      workspaceId: resolved.workspace.id,
      projectId: resolved.project.key,
      skillIds: skills.map((skill) => skill.id),
      agentIds: agents.map((agent) => agent.id),
      knowledgeSourceIds: knowledgeSources.map((source) => source.id),
      routineIds: routines.map((routine) => routine.id),
      capabilityBundleIds: resolved.access.capabilityBundleIds ?? [],
      budget,
      activationMode,
      bindingId: binding?.id,
      card: buildLarkThreadStatusCard(cardModel) as unknown as Record<
        string,
        unknown
      >,
    };
  }
}
