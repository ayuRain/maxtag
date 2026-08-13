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
  UsageBudgetCheckResult,
  UsageBudgetLine,
} from '@opentag/delivery';
import type { RoutineCommandService } from '@opentag/routines';

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
  budget: UsageBudgetCheckResult;
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
  deliveryStore: Pick<DeliveryStore, 'checkUsageBudget'>;
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
    limits.push(
      `runs ${numberLabel(currentRuns)}/${numberLabel(policy.maxRunsPerMonth)}`,
    );
  }
  if (typeof policy.maxCostUsdPerMonth === 'number') {
    limits.push(
      `cost $${currentCost.toFixed(2)}/$${policy.maxCostUsdPerMonth.toFixed(2)}`,
    );
  }
  return `${policy.scope ?? 'project'} ${limits.join(', ') || 'uncapped'}`;
}

function accessLabel(authorization: ThreadStatusAuthorization): string {
  const roles = [
    authorization.workspaceRole
      ? `workspace ${authorization.workspaceRole}`
      : undefined,
    authorization.projectRole ? `project ${authorization.projectRole}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const principal = roles.length
    ? roles.join(', ')
    : authorization.mode
      ? authorization.mode
      : 'authorized ingress';
  return `${principal}; ${boundedList(authorization.capabilities ?? [], 'invoke only')}`;
}

function budgetBlockedLabel(check: UsageBudgetCheckResult): string {
  if (check.reason === 'runs_budget_exceeded') {
    return 'blocked (monthly run limit reached)';
  }
  if (check.reason === 'cost_budget_exceeded') {
    return 'blocked (monthly cost limit reached)';
  }
  return 'blocked (monthly usage limit reached)';
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
    const [skills, agents, knowledgeSources, routines, budget] = await Promise.all([
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
      ? 'available'
      : budgetBlockedLabel(budget);
    const budgetDetails = policies.length
      ? policies.map((policy) => budgetPolicyLabel(budget, policy)).join('; ')
      : 'no monthly cap';

    const summary = [
      `${resolved.identity.displayName} thread status`,
      '',
      'Route',
      `- Workspace: ${resolved.workspace.name} [${resolved.workspace.id}]`,
      `- Project: ${resolved.project.name} [${resolved.project.key}]`,
      `- Channel: ${channel}`,
      `- Topic: ${topic}`,
      `- Visibility: ${thread.visibility}`,
      '',
      'Identity and access',
      `- Agent: ${resolved.identity.displayName} [${resolved.identity.id}] via ${resolved.identity.defaultExecutorId}`,
      `- Your access: ${accessLabel(authorization)}`,
      `- Memory read: ${boundedList(memoryScopes(resolved.access, 'read'))}`,
      `- Memory write: ${boundedList(memoryScopes(resolved.access, 'write'))}`,
      '',
      'Available here',
      `- Skills (${skills.length}): ${boundedList(skills.map((skill) => skill.name))}`,
      `- Agents (${agents.length}): ${boundedList(agents.map((agent) => agent.name))}`,
      `- Sources (${knowledgeSources.length}): ${boundedList(knowledgeSources.map((source) => source.name))}`,
      `- Tools (${toolLabels.length}): ${boundedList(toolLabels)}`,
      `- Network: ${resolved.access.networkPolicy.mode}; ${resolved.access.networkPolicy.allowedHosts.length} allowed host${resolved.access.networkPolicy.allowedHosts.length === 1 ? '' : 's'}`,
      `- Standing work: ${enabledRoutines.length} active${pausedRoutines ? `, ${pausedRoutines} paused` : ''}`,
      '',
      'Usage',
      `- Next model run: ${budgetState}`,
      `- ${budget.period}: ${budgetDetails}`,
      '- This status check uses no model run.',
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
      budget,
    };
  }
}
