import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CancelWorkflowExecutionResult,
  CompleteWorkflowProducerPollInput,
  FailWorkflowProducerPollInput,
  RetryWorkflowNodeResult,
  UpsertWorkflowProducerRouteInput,
  UpsertWorkflowInput,
  Workflow,
  WorkflowAuditFilter,
  WorkflowAuditRecord,
  WorkflowDestination,
  WorkflowEventInput,
  WorkflowEventStageResult,
  WorkflowExecution,
  WorkflowExecutionFilter,
  WorkflowExecutionStatus,
  WorkflowListFilter,
  WorkflowProducerAuditRecord,
  WorkflowProducerClaim,
  WorkflowProducerRoute,
  WorkflowProducerRouteFilter,
  WorkflowProducerRuntime,
  WorkflowNode,
  WorkflowNodeClaim,
  WorkflowNodeExecution,
  WorkflowNodeExecutionStatus,
  WorkflowState,
  WorkflowSummary,
  WorkflowTrigger,
} from './types.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function iso(value: Date): string {
  return value.toISOString();
}

function required(value: string, error: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(error);
  return normalized;
}

function bounded(value: string | undefined, max: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, max);
}

export function createEmptyWorkflowState(): WorkflowState {
  return {
    version: 1,
    workflows: [],
    executions: [],
    audit: [],
    producerRoutes: [],
    producerRuntime: [],
    producerAudit: [],
  };
}

export function normalizeWorkflowState(
  input: Partial<WorkflowState> | Record<string, unknown>,
): WorkflowState {
  return {
    version: 1,
    workflows: Array.isArray(input.workflows)
      ? (input.workflows as Workflow[])
      : [],
    executions: Array.isArray(input.executions)
      ? (input.executions as WorkflowExecution[])
      : [],
    audit: Array.isArray(input.audit)
      ? (input.audit as WorkflowAuditRecord[])
      : [],
    producerRoutes: Array.isArray(input.producerRoutes)
      ? (input.producerRoutes as WorkflowProducerRoute[])
      : [],
    producerRuntime: Array.isArray(input.producerRuntime)
      ? (input.producerRuntime as WorkflowProducerRuntime[])
      : [],
    producerAudit: Array.isArray(input.producerAudit)
      ? (input.producerAudit as WorkflowProducerAuditRecord[])
      : [],
  };
}

export function trimWorkflowState(state: WorkflowState): void {
  if (state.executions.length > 1_000) {
    const overflow = state.executions.length - 1_000;
    const terminalIds = new Set(
      state.executions
        .filter(
          (execution) =>
            execution.status === 'completed' ||
            execution.status === 'failed' ||
            execution.status === 'cancelled',
        )
        .slice(0, overflow)
        .map((execution) => execution.id),
    );
    state.executions = state.executions.filter(
      (execution) => !terminalIds.has(execution.id),
    );
  }
  if (state.audit.length > 500) {
    state.audit.splice(0, state.audit.length - 500);
  }
  if (state.producerAudit.length > 500) {
    state.producerAudit.splice(0, state.producerAudit.length - 500);
  }
}

function normalizeTrigger(trigger: WorkflowTrigger): WorkflowTrigger {
  if (trigger.kind === 'manual') return { kind: 'manual' };
  if (trigger.kind !== 'event') throw new Error('workflow_trigger_invalid');
  const eventType = required(
    trigger.eventType,
    'workflow_event_type_required',
  );
  if (eventType.length > 120 || !/^[a-zA-Z0-9_.:-]+$/.test(eventType)) {
    throw new Error('workflow_event_type_invalid');
  }
  return { kind: 'event', eventType };
}

function normalizeDestination(
  destination: WorkflowDestination,
): WorkflowDestination {
  return {
    platform: required(
      String(destination.platform || ''),
      'workflow_destination_platform_required',
    ),
    externalId: required(
      destination.externalId,
      'workflow_destination_required',
    ),
    channelId: bounded(destination.channelId, 500),
    threadId: bounded(destination.threadId, 500),
    rootMessageId: bounded(destination.rootMessageId, 500),
    topicId: bounded(destination.topicId, 500),
    visibility: destination.visibility,
    title: bounded(destination.title, 200),
  };
}

export function normalizeWorkflowNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('workflow_nodes_required');
  }
  if (nodes.length > 20) throw new Error('workflow_nodes_limit_exceeded');
  const normalized = nodes.map((node) => {
    const id = required(node.id, 'workflow_node_id_required');
    if (!/^[a-zA-Z0-9_.-]+$/.test(id) || id.length > 80) {
      throw new Error('workflow_node_id_invalid');
    }
    const instructions = required(
      node.instructions,
      `workflow_node_instructions_required:${id}`,
    );
    const dependsOn = [...new Set(node.dependsOn ?? [])].map((dependency) =>
      required(dependency, `workflow_node_dependency_invalid:${id}`),
    );
    if (dependsOn.includes(id)) {
      throw new Error(`workflow_node_self_dependency:${id}`);
    }
    return {
      id,
      name: bounded(node.name, 120),
      instructions: instructions.slice(0, 20_000),
      dependsOn: dependsOn.length ? dependsOn : undefined,
      publish: node.publish,
    } satisfies WorkflowNode;
  });
  const ids = new Set<string>();
  for (const node of normalized) {
    if (ids.has(node.id)) throw new Error(`workflow_node_duplicate:${node.id}`);
    ids.add(node.id);
  }
  for (const node of normalized) {
    for (const dependency of node.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(
          `workflow_node_unknown_dependency:${node.id}:${dependency}`,
        );
      }
    }
  }

  const incoming = new Map(
    normalized.map((node) => [node.id, node.dependsOn?.length ?? 0]),
  );
  const outgoing = new Map<string, string[]>();
  for (const node of normalized) {
    for (const dependency of node.dependsOn ?? []) {
      outgoing.set(dependency, [
        ...(outgoing.get(dependency) ?? []),
        node.id,
      ]);
    }
  }
  const queue = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift() as string;
    visited += 1;
    for (const child of outgoing.get(id) ?? []) {
      const count = (incoming.get(child) ?? 0) - 1;
      incoming.set(child, count);
      if (count === 0) queue.push(child);
    }
  }
  if (visited !== normalized.length) throw new Error('workflow_dependency_cycle');
  return normalized;
}

function sinkNodeIds(nodes: WorkflowNode[]): Set<string> {
  const dependencies = new Set(nodes.flatMap((node) => node.dependsOn ?? []));
  return new Set(nodes.filter((node) => !dependencies.has(node.id)).map((node) => node.id));
}

function shouldPublishNode(workflow: Workflow, node: WorkflowNode): boolean {
  return node.publish ?? sinkNodeIds(workflow.nodes).has(node.id);
}

function nodeExecutionFor(
  execution: WorkflowExecution,
  nodeId: string,
): WorkflowNodeExecution | undefined {
  return execution.nodes.find((node) => node.nodeId === nodeId);
}

function descendantNodeIds(workflow: Workflow, nodeId: string): Set<string> {
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of workflow.nodes) {
      if (
        node.id !== nodeId &&
        !descendants.has(node.id) &&
        (node.dependsOn ?? []).some(
          (dependency) => dependency === nodeId || descendants.has(dependency),
        )
      ) {
        descendants.add(node.id);
        changed = true;
      }
    }
  }
  return descendants;
}

function terminalNodeStatus(status: WorkflowNodeExecutionStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'cancelled'
  );
}

function updateExecutionState(
  execution: WorkflowExecution,
  timestamp: string,
): void {
  if (execution.status === 'cancelled') return;
  let derivedChanged = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of execution.workflow.nodes) {
      const current = nodeExecutionFor(execution, node.id);
      if (!current || current.status !== 'pending') continue;
      const blocked = (node.dependsOn ?? []).some((dependency) => {
        const status = nodeExecutionFor(execution, dependency)?.status;
        return (
          status === 'failed' ||
          status === 'skipped' ||
          status === 'cancelled'
        );
      });
      if (!blocked) continue;
      current.status = 'skipped';
      current.error = 'workflow_dependency_failed';
      current.completedAt = timestamp;
      current.updatedAt = timestamp;
      changed = true;
      derivedChanged = true;
    }
  }

  if (execution.nodes.every((node) => terminalNodeStatus(node.status))) {
    const failures = execution.nodes.filter(
      (node) => node.status !== 'completed',
    );
    const status = failures.length ? 'failed' : 'completed';
    const published = execution.workflow.nodes
      .filter((node) => shouldPublishNode(execution.workflow, node))
      .map((node) => nodeExecutionFor(execution, node.id)?.summary)
      .filter((summary): summary is string => Boolean(summary));
    const summary = published.join('\n\n').slice(0, 8_000) || undefined;
    const error = failures
      .map((node) => node.error)
      .filter(Boolean)
      .join('; ')
      .slice(0, 2_000) || undefined;
    if (
      execution.status !== status ||
      execution.summary !== summary ||
      execution.error !== error ||
      !execution.completedAt
    ) {
      execution.status = status;
      execution.summary = summary;
      execution.error = error;
      execution.completedAt = execution.completedAt ?? timestamp;
      derivedChanged = true;
    }
    if (derivedChanged) execution.updatedAt = timestamp;
    return;
  }
  const hasProgress = execution.nodes.some((node) => node.status !== 'pending');
  const status = hasProgress ? 'running' : 'pending';
  if (execution.status !== status) {
    execution.status = status;
    derivedChanged = true;
  }
  if (hasProgress && !execution.startedAt) {
    execution.startedAt = timestamp;
    derivedChanged = true;
  }
  if (derivedChanged) execution.updatedAt = timestamp;
}

function createExecution(
  workflow: Workflow,
  input: {
    dedupKey: string;
    trigger: WorkflowExecution['trigger'];
    payload?: Record<string, unknown>;
  },
  timestamp: string,
): WorkflowExecution {
  const id = randomUUID();
  return {
    id,
    workflowId: workflow.id,
    workflow: clone(workflow),
    workflowVersion: workflow.version,
    dedupKey: input.dedupKey,
    trigger: clone(input.trigger),
    input: input.payload ? clone(input.payload) : undefined,
    status: 'pending',
    nodes: workflow.nodes.map((node) => ({
      id: `${id}:${node.id}`,
      nodeId: node.id,
      status: 'pending',
      attempts: 0,
      retryCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function executionCounts(): Record<WorkflowExecutionStatus, number> {
  return {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

function nodeCounts(): Record<WorkflowNodeExecutionStatus, number> {
  return {
    pending: 0,
    claimed: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
}

function recordOldestStatus<K extends string>(
  target: Partial<Record<K, string>>,
  status: K,
  updatedAt: string,
): void {
  const current = target[status];
  if (!current || updatedAt < current) target[status] = updatedAt;
}

function validatePayload(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;
  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new Error('workflow_event_payload_invalid');
  }
  if (Buffer.byteLength(encoded, 'utf8') > 100_000) {
    throw new Error('workflow_event_payload_too_large');
  }
}

export class FileWorkflowStore {
  private readonly stateFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'workflow-state.json');
  }

  private async load(): Promise<WorkflowState> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as Partial<WorkflowState>;
      return normalizeWorkflowState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createEmptyWorkflowState();
      }
      throw error;
    }
  }

  private async save(state: WorkflowState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporary, this.stateFile);
  }

  protected async readState(): Promise<WorkflowState> {
    await this.mutationQueue;
    return this.load();
  }

  protected async mutate<T>(
    operation: (state: WorkflowState) => T,
  ): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = operation(state);
      trimWorkflowState(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async listWorkflows(filter: WorkflowListFilter = {}): Promise<Workflow[]> {
    const state = await this.readState();
    return state.workflows
      .filter(
        (workflow) =>
          (!filter.workspaceId || workflow.workspaceId === filter.workspaceId) &&
          (!filter.projectId || workflow.projectId === filter.projectId) &&
          (filter.includeArchived || workflow.status !== 'archived'),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(clone);
  }

  async getWorkflow(id: string): Promise<Workflow | undefined> {
    const state = await this.readState();
    const workflow = state.workflows.find((item) => item.id === id);
    return workflow ? clone(workflow) : undefined;
  }

  async listProducerRoutes(
    filter: WorkflowProducerRouteFilter = {},
  ): Promise<WorkflowProducerRoute[]> {
    const state = await this.readState();
    return state.producerRoutes
      .filter(
        (route) =>
          (!filter.workspaceId || route.workspaceId === filter.workspaceId) &&
          (!filter.projectId || route.projectId === filter.projectId) &&
          (!filter.kind || route.kind === filter.kind) &&
          (filter.includeArchived || route.status !== 'archived'),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(clone);
  }

  async getProducerRoute(
    id: string,
  ): Promise<WorkflowProducerRoute | undefined> {
    const state = await this.readState();
    const route = state.producerRoutes.find((item) => item.id === id);
    return route ? clone(route) : undefined;
  }

  async upsertProducerRoute(
    input: UpsertWorkflowProducerRouteInput,
    at = new Date(),
  ): Promise<WorkflowProducerRoute> {
    const workspaceId = required(
      input.workspaceId,
      'workflow_producer_workspace_required',
    );
    const projectId = required(
      input.projectId,
      'workflow_producer_project_required',
    );
    const name = required(input.name, 'workflow_producer_name_required').slice(
      0,
      160,
    );
    if (input.kind !== 'alertmanager' && input.kind !== 'lark-document') {
      throw new Error('workflow_producer_kind_invalid');
    }
    const documentId =
      input.kind === 'lark-document'
        ? required(
            input.documentId || '',
            'workflow_producer_document_id_required',
          ).slice(0, 100)
        : undefined;
    const pollIntervalSeconds =
      input.kind === 'lark-document'
        ? Math.max(
            30,
            Math.min(
              86_400,
              Math.floor(input.pollIntervalSeconds ?? 60),
            ),
          )
        : undefined;
    const timestamp = iso(at);
    return this.mutate((state) => {
      const existing = input.id
        ? state.producerRoutes.find(
            (route) => route.id === input.id && route.status !== 'archived',
          )
        : undefined;
      if (input.id && !existing) {
        throw new Error('workflow_producer_route_not_found');
      }
      if (
        existing &&
        (existing.workspaceId !== workspaceId ||
          existing.projectId !== projectId ||
          existing.kind !== input.kind ||
          existing.documentId !== documentId)
      ) {
        throw new Error('workflow_producer_route_scope_immutable');
      }
      const actor = input.actor?.trim() || 'admin';
      const route: WorkflowProducerRoute = {
        id: existing?.id ?? randomUUID(),
        kind: input.kind,
        workspaceId,
        projectId,
        name,
        documentId,
        pollIntervalSeconds,
        enabled: input.enabled ?? existing?.enabled ?? true,
        status: 'active',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        createdBy: existing?.createdBy ?? actor,
        updatedBy: actor,
      };
      if (existing) {
        state.producerRoutes.splice(
          state.producerRoutes.indexOf(existing),
          1,
          route,
        );
      } else {
        state.producerRoutes.push(route);
      }
      if (route.kind === 'lark-document') {
        const runtime = state.producerRuntime.find(
          (item) => item.routeId === route.id,
        );
        if (!runtime) {
          state.producerRuntime.push({
            routeId: route.id,
            failureCount: 0,
            nextPollAt: timestamp,
          });
        } else if (route.enabled && !runtime.nextPollAt) {
          runtime.nextPollAt = timestamp;
        }
      }
      state.producerAudit.push({
        id: randomUUID(),
        action: existing
          ? 'workflow.producer.updated'
          : 'workflow.producer.created',
        routeId: route.id,
        workspaceId,
        projectId,
        actor,
        at: timestamp,
        snapshot: clone(route),
      });
      return clone(route);
    });
  }

  async archiveProducerRoute(
    id: string,
    actor = 'admin',
    at = new Date(),
  ): Promise<WorkflowProducerRoute | undefined> {
    return this.mutate((state) => {
      const route = state.producerRoutes.find(
        (item) => item.id === id && item.status !== 'archived',
      );
      if (!route) return undefined;
      const timestamp = iso(at);
      route.enabled = false;
      route.status = 'archived';
      route.updatedAt = timestamp;
      route.updatedBy = actor.trim() || 'admin';
      route.archivedAt = timestamp;
      const runtime = state.producerRuntime.find(
        (item) => item.routeId === route.id,
      );
      if (runtime) {
        runtime.claimerId = undefined;
        runtime.claimedAt = undefined;
        runtime.nextPollAt = undefined;
      }
      state.producerAudit.push({
        id: randomUUID(),
        action: 'workflow.producer.archived',
        routeId: route.id,
        workspaceId: route.workspaceId,
        projectId: route.projectId,
        actor: route.updatedBy,
        at: timestamp,
        snapshot: clone(route),
      });
      return clone(route);
    });
  }

  async listProducerAudit(
    filter: WorkflowAuditFilter = {},
  ): Promise<WorkflowProducerAuditRecord[]> {
    const state = await this.readState();
    return state.producerAudit
      .filter(
        (entry) =>
          (!filter.workspaceId || entry.workspaceId === filter.workspaceId) &&
          (!filter.projectId || entry.projectId === filter.projectId),
      )
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, Math.max(1, Math.min(filter.limit ?? 50, 200)))
      .map(clone);
  }

  async listProducerRuntime(
    filter: WorkflowProducerRouteFilter = {},
  ): Promise<WorkflowProducerRuntime[]> {
    const state = await this.readState();
    const routeIds = new Set(
      state.producerRoutes
        .filter(
          (route) =>
            (!filter.workspaceId || route.workspaceId === filter.workspaceId) &&
            (!filter.projectId || route.projectId === filter.projectId) &&
            (!filter.kind || route.kind === filter.kind) &&
            (filter.includeArchived || route.status !== 'archived'),
        )
        .map((route) => route.id),
    );
    return state.producerRuntime
      .filter((runtime) => routeIds.has(runtime.routeId))
      .map(clone);
  }

  async claimDueProducerRoutes(
    input: {
      kind: 'lark-document';
      claimerId: string;
      staleAfterMs?: number;
      limit?: number;
      force?: boolean;
    },
    at = new Date(),
  ): Promise<WorkflowProducerClaim[]> {
    const claimerId = required(
      input.claimerId,
      'workflow_producer_claimer_required',
    );
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const staleBefore = at.getTime() - Math.max(1_000, input.staleAfterMs ?? 120_000);
    const timestamp = iso(at);
    return this.mutate((state) => {
      const claims: WorkflowProducerClaim[] = [];
      for (const route of state.producerRoutes) {
        if (claims.length >= limit) break;
        if (
          route.kind !== input.kind ||
          route.status !== 'active' ||
          !route.enabled
        ) {
          continue;
        }
        let runtime = state.producerRuntime.find(
          (item) => item.routeId === route.id,
        );
        if (!runtime) {
          runtime = { routeId: route.id, failureCount: 0 };
          state.producerRuntime.push(runtime);
        }
        const due =
          input.force ||
          !runtime.nextPollAt ||
          Date.parse(runtime.nextPollAt) <= at.getTime();
        const claimStale =
          !runtime.claimerId ||
          !runtime.claimedAt ||
          Date.parse(runtime.claimedAt) <= staleBefore;
        if (!due || !claimStale) continue;
        runtime.claimerId = claimerId;
        runtime.claimedAt = timestamp;
        claims.push({ route: clone(route), runtime: clone(runtime) });
      }
      return claims;
    });
  }

  async completeProducerPoll(
    input: CompleteWorkflowProducerPollInput,
    at = new Date(),
  ): Promise<WorkflowProducerRuntime> {
    return this.mutate((state) => {
      const route = state.producerRoutes.find(
        (item) => item.id === input.routeId && item.status === 'active',
      );
      const runtime = state.producerRuntime.find(
        (item) => item.routeId === input.routeId,
      );
      if (!route || !runtime) throw new Error('workflow_producer_route_not_found');
      if (runtime.claimerId !== input.claimerId) {
        throw new Error('workflow_producer_claim_lost');
      }
      const timestamp = iso(at);
      runtime.lastRevisionId = input.revisionId;
      runtime.lastContentHash = bounded(input.contentHash, 100);
      runtime.lastTitle = bounded(input.title, 500);
      runtime.lastCheckedAt = timestamp;
      runtime.lastSuccessAt = timestamp;
      if (input.changed) runtime.lastChangedAt = timestamp;
      runtime.nextPollAt = iso(
        new Date(at.getTime() + (route.pollIntervalSeconds ?? 60) * 1_000),
      );
      runtime.failureCount = 0;
      runtime.lastError = undefined;
      runtime.claimerId = undefined;
      runtime.claimedAt = undefined;
      return clone(runtime);
    });
  }

  async failProducerPoll(
    input: FailWorkflowProducerPollInput,
    at = new Date(),
  ): Promise<WorkflowProducerRuntime> {
    return this.mutate((state) => {
      const runtime = state.producerRuntime.find(
        (item) => item.routeId === input.routeId,
      );
      if (!runtime) throw new Error('workflow_producer_route_not_found');
      if (runtime.claimerId !== input.claimerId) {
        throw new Error('workflow_producer_claim_lost');
      }
      runtime.failureCount += 1;
      runtime.lastCheckedAt = iso(at);
      runtime.lastError = required(input.error, 'workflow_producer_error_required').slice(
        0,
        1_000,
      );
      const backoffMs = Math.min(
        15 * 60_000,
        30_000 * 2 ** Math.min(runtime.failureCount - 1, 5),
      );
      runtime.nextPollAt = iso(new Date(at.getTime() + backoffMs));
      runtime.claimerId = undefined;
      runtime.claimedAt = undefined;
      return clone(runtime);
    });
  }

  async upsertWorkflow(
    input: UpsertWorkflowInput,
    at = new Date(),
  ): Promise<Workflow> {
    const workspaceId = required(input.workspaceId, 'workflow_workspace_required');
    const projectId = required(input.projectId, 'workflow_project_required');
    const name = required(input.name, 'workflow_name_required').slice(0, 160);
    const trigger = normalizeTrigger(input.trigger);
    const nodes = normalizeWorkflowNodes(input.nodes);
    const destination = normalizeDestination(input.destination);
    const timestamp = iso(at);
    return this.mutate((state) => {
      const existing = input.id
        ? state.workflows.find(
            (workflow) =>
              workflow.id === input.id && workflow.status !== 'archived',
          )
        : undefined;
      if (input.id && !existing) throw new Error('workflow_not_found');
      if (existing && existing.workspaceId !== workspaceId) {
        throw new Error('workflow_workspace_immutable');
      }
      const actor = input.actor?.trim() || 'admin';
      const workflow: Workflow = {
        id: existing?.id ?? input.id ?? randomUUID(),
        workspaceId,
        projectId,
        name,
        description: bounded(input.description, 1_000),
        enabled: input.enabled ?? existing?.enabled ?? true,
        status: 'active',
        version: (existing?.version ?? 0) + 1,
        trigger,
        nodes,
        destination,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        createdBy: existing?.createdBy ?? actor,
        updatedBy: actor,
      };
      if (existing) {
        state.workflows.splice(state.workflows.indexOf(existing), 1, workflow);
      } else {
        state.workflows.push(workflow);
      }
      state.audit.push({
        id: randomUUID(),
        action: existing ? 'workflow.updated' : 'workflow.created',
        workflowId: workflow.id,
        workspaceId,
        projectId,
        actor,
        at: timestamp,
        snapshot: clone(workflow),
      });
      return clone(workflow);
    });
  }

  async setWorkflowEnabled(
    id: string,
    enabled: boolean,
    actor = 'admin',
    at = new Date(),
  ): Promise<Workflow | undefined> {
    return this.mutate((state) => {
      const workflow = state.workflows.find(
        (item) => item.id === id && item.status !== 'archived',
      );
      if (!workflow) return undefined;
      if (workflow.enabled === enabled) return clone(workflow);
      workflow.enabled = enabled;
      workflow.version += 1;
      workflow.updatedAt = iso(at);
      workflow.updatedBy = actor.trim() || 'admin';
      state.audit.push({
        id: randomUUID(),
        action: 'workflow.updated',
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        projectId: workflow.projectId,
        actor: workflow.updatedBy,
        at: workflow.updatedAt,
        snapshot: clone(workflow),
      });
      return clone(workflow);
    });
  }

  async archiveWorkflow(
    id: string,
    actor = 'admin',
    at = new Date(),
  ): Promise<Workflow | undefined> {
    return this.mutate((state) => {
      const workflow = state.workflows.find(
        (item) => item.id === id && item.status !== 'archived',
      );
      if (!workflow) return undefined;
      const timestamp = iso(at);
      workflow.enabled = false;
      workflow.status = 'archived';
      workflow.version += 1;
      workflow.updatedAt = timestamp;
      workflow.updatedBy = actor.trim() || 'admin';
      workflow.archivedAt = timestamp;
      state.audit.push({
        id: randomUUID(),
        action: 'workflow.archived',
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        projectId: workflow.projectId,
        actor: workflow.updatedBy,
        at: timestamp,
        snapshot: clone(workflow),
      });
      return clone(workflow);
    });
  }

  async triggerWorkflow(
    id: string,
    input: {
      actor?: string;
      payload?: Record<string, unknown>;
    } = {},
    at = new Date(),
  ): Promise<WorkflowExecution> {
    validatePayload(input.payload);
    return this.mutate((state) => {
      const workflow = state.workflows.find(
        (item) => item.id === id && item.status !== 'archived',
      );
      if (!workflow) throw new Error('workflow_not_found');
      const timestamp = iso(at);
      const actor = input.actor?.trim() || 'admin';
      const execution = createExecution(
        workflow,
        {
          dedupKey: `manual:${workflow.id}:${randomUUID()}`,
          trigger: { kind: 'manual', actor },
          payload: input.payload,
        },
        timestamp,
      );
      state.executions.push(execution);
      state.audit.push({
        id: randomUUID(),
        action: 'workflow.triggered',
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        projectId: workflow.projectId,
        actor,
        at: timestamp,
        snapshot: clone(workflow),
      });
      return clone(execution);
    });
  }

  async triggerEvent(
    input: WorkflowEventInput,
    at = new Date(),
  ): Promise<WorkflowEventStageResult> {
    validatePayload(input.payload);
    const workspaceId = required(input.workspaceId, 'workflow_workspace_required');
    const projectId = required(input.projectId, 'workflow_project_required');
    const normalizedTrigger = normalizeTrigger({
      kind: 'event',
      eventType: input.eventType,
    });
    if (normalizedTrigger.kind !== 'event') {
      throw new Error('workflow_event_type_required');
    }
    const eventType = normalizedTrigger.eventType;
    const eventId = required(input.eventId, 'workflow_event_id_required').slice(
      0,
      500,
    );
    const producer = bounded(input.producer, 120);
    const sourceExternalId = bounded(input.sourceExternalId, 500);
    return this.mutate((state) => {
      const timestamp = iso(at);
      const workflows = state.workflows.filter(
        (workflow) =>
          workflow.enabled &&
          workflow.status === 'active' &&
          workflow.workspaceId === workspaceId &&
          workflow.projectId === projectId &&
          workflow.trigger.kind === 'event' &&
          workflow.trigger.eventType === eventType,
      );
      const staged: WorkflowExecution[] = [];
      const duplicates: WorkflowExecution[] = [];
      for (const workflow of workflows) {
        const dedupKey = `event:${workflow.id}:${eventType}:${eventId}`;
        const existing = state.executions.find(
          (execution) => execution.dedupKey === dedupKey,
        );
        if (existing) {
          duplicates.push(clone(existing));
          continue;
        }
        const execution = createExecution(
          workflow,
          {
            dedupKey,
            trigger: {
              kind: 'event',
              actor: input.actor?.trim() || 'workflow-event',
              eventType,
              eventId,
              producer,
              sourceExternalId,
            },
            payload: input.payload,
          },
          timestamp,
        );
        state.executions.push(execution);
        staged.push(clone(execution));
        state.audit.push({
          id: randomUUID(),
          action: 'workflow.event.staged',
          workflowId: workflow.id,
          workspaceId: workflow.workspaceId,
          projectId: workflow.projectId,
          actor: input.actor?.trim() || 'workflow-event',
          at: timestamp,
          snapshot: clone(workflow),
          executionId: execution.id,
          eventType,
          eventId,
          producer,
          sourceExternalId,
        });
      }
      return { matched: workflows.length, staged, duplicates };
    });
  }

  async claimReadyNodes(input: {
    claimerId: string;
    limit?: number;
    staleAfterMs?: number;
    at?: Date;
  }): Promise<WorkflowNodeClaim[]> {
    return this.mutate((state) => {
      const at = input.at ?? new Date();
      const timestamp = iso(at);
      const staleBefore = new Date(
        at.getTime() - (input.staleAfterMs ?? 120_000),
      ).toISOString();
      for (const execution of state.executions) {
        updateExecutionState(execution, timestamp);
      }
      const claims: WorkflowNodeClaim[] = [];
      const executions = [...state.executions].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
      for (const execution of executions) {
        if (claims.length >= limit) break;
        if (
          execution.status === 'completed' ||
          execution.status === 'failed' ||
          execution.status === 'cancelled'
        ) {
          continue;
        }
        for (const node of execution.workflow.nodes) {
          if (claims.length >= limit) break;
          const current = nodeExecutionFor(execution, node.id);
          if (!current) continue;
          const staleClaim =
            current.status === 'claimed' &&
            Boolean(current.claimedAt && current.claimedAt <= staleBefore);
          const dependenciesReady = (node.dependsOn ?? []).every(
            (dependency) =>
              nodeExecutionFor(execution, dependency)?.status === 'completed',
          );
          if (!(staleClaim || (current.status === 'pending' && dependenciesReady))) {
            continue;
          }
          current.status = 'claimed';
          current.claimerId = input.claimerId;
          current.claimedAt = timestamp;
          current.attempts += 1;
          current.startedAt = current.startedAt ?? timestamp;
          current.updatedAt = timestamp;
          execution.status = 'running';
          execution.startedAt = execution.startedAt ?? timestamp;
          execution.updatedAt = timestamp;
          claims.push({
            workflow: clone(execution.workflow),
            execution: clone(execution),
            node: clone(node),
            nodeExecution: clone(current),
            upstream: (node.dependsOn ?? []).map((dependency) => ({
              nodeId: dependency,
              summary:
                nodeExecutionFor(execution, dependency)?.summary ?? '',
            })),
            publish: shouldPublishNode(execution.workflow, node),
          });
        }
      }
      return claims;
    });
  }

  async markNodeQueued(
    nodeExecutionId: string,
    runId: string,
    at = new Date(),
  ): Promise<WorkflowNodeExecution | undefined> {
    return this.updateNode(nodeExecutionId, at, (node) => {
      if (node.status !== 'claimed') return false;
      node.status = 'queued';
      node.runId = runId;
      node.runIds = [...new Set([...(node.runIds ?? []), runId])];
      node.error = undefined;
      return true;
    });
  }

  async markNodeFailed(
    nodeExecutionId: string,
    error: string,
    at = new Date(),
  ): Promise<WorkflowNodeExecution | undefined> {
    return this.updateNode(nodeExecutionId, at, (node) => {
      if (terminalNodeStatus(node.status)) return false;
      node.status = 'failed';
      node.error = error.slice(0, 2_000);
      node.completedAt = iso(at);
    });
  }

  async reconcileNodeRun(input: {
    runId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    summary?: string;
    error?: string;
    at?: Date;
  }): Promise<WorkflowNodeExecution | undefined> {
    return this.mutate((state) => {
      const execution = state.executions.find((item) =>
        item.nodes.some((node) => node.runId === input.runId),
      );
      const node = execution?.nodes.find((item) => item.runId === input.runId);
      if (!execution || !node) return undefined;
      if (execution.status === 'cancelled' || node.status === 'cancelled') {
        return clone(node);
      }
      const at = input.at ?? new Date();
      const timestamp = iso(at);
      node.status = input.status;
      node.summary = input.summary?.slice(0, 8_000);
      node.error = input.error?.slice(0, 2_000);
      node.updatedAt = timestamp;
      execution.updatedAt = timestamp;
      if (
        input.status === 'completed' ||
        input.status === 'failed' ||
        input.status === 'cancelled'
      ) {
        node.completedAt = timestamp;
      }
      updateExecutionState(execution, timestamp);
      return clone(node);
    });
  }

  private async updateNode(
    nodeExecutionId: string,
    at: Date,
    update: (node: WorkflowNodeExecution) => boolean | void,
  ): Promise<WorkflowNodeExecution | undefined> {
    return this.mutate((state) => {
      const execution = state.executions.find((item) =>
        item.nodes.some((node) => node.id === nodeExecutionId),
      );
      const node = execution?.nodes.find((item) => item.id === nodeExecutionId);
      if (!execution || !node) return undefined;
      if (update(node) === false) return undefined;
      const timestamp = iso(at);
      node.updatedAt = timestamp;
      execution.updatedAt = timestamp;
      updateExecutionState(execution, timestamp);
      return clone(node);
    });
  }

  async cancelExecution(
    id: string,
    input: { actor?: string; reason?: string } = {},
    at = new Date(),
  ): Promise<CancelWorkflowExecutionResult> {
    return this.mutate((state) => {
      const execution = state.executions.find((item) => item.id === id);
      if (!execution) throw new Error('workflow_execution_not_found');
      if (execution.status === 'completed' || execution.status === 'failed') {
        throw new Error('workflow_execution_not_active');
      }
      const activeRunIds = execution.nodes
        .filter(
          (node) =>
            node.status === 'claimed' ||
            node.status === 'queued' ||
            node.status === 'running' ||
            (execution.status === 'cancelled' && node.status === 'cancelled'),
        )
        .flatMap((node) => (node.runId ? [node.runId] : []));
      if (execution.status === 'cancelled') {
        return { execution: clone(execution), changed: false, activeRunIds };
      }
      const timestamp = iso(at);
      const reason = bounded(input.reason, 500) || 'workflow_execution_cancelled';
      for (const node of execution.nodes) {
        if (terminalNodeStatus(node.status)) continue;
        node.status = 'cancelled';
        node.error = reason;
        node.completedAt = timestamp;
        node.updatedAt = timestamp;
      }
      execution.status = 'cancelled';
      execution.error = reason;
      execution.completedAt = timestamp;
      execution.updatedAt = timestamp;
      state.audit.push({
        id: randomUUID(),
        action: 'workflow.execution.cancelled',
        workflowId: execution.workflowId,
        workspaceId: execution.workflow.workspaceId,
        projectId: execution.workflow.projectId,
        actor: input.actor?.trim() || 'admin',
        at: timestamp,
        snapshot: clone(execution.workflow),
        executionId: execution.id,
        reason,
      });
      return { execution: clone(execution), changed: true, activeRunIds };
    });
  }

  async retryNode(
    executionId: string,
    nodeId: string,
    input: { actor?: string; reason?: string } = {},
    at = new Date(),
  ): Promise<RetryWorkflowNodeResult> {
    return this.mutate((state) => {
      const execution = state.executions.find((item) => item.id === executionId);
      if (!execution) throw new Error('workflow_execution_not_found');
      if (execution.status !== 'failed') {
        throw new Error('workflow_execution_not_failed');
      }
      const node = nodeExecutionFor(execution, nodeId);
      if (!node) throw new Error('workflow_node_not_found');
      if (node.status !== 'failed') throw new Error('workflow_node_not_failed');
      const timestamp = iso(at);
      const nextAttempt = (node.retryCount ?? 0) + 2;
      node.retryCount = (node.retryCount ?? 0) + 1;
      const descendants = descendantNodeIds(execution.workflow, nodeId);
      const resetNodeIds = [nodeId];
      for (const candidate of execution.nodes) {
        const resetTarget =
          candidate.id === node.id ||
          (descendants.has(candidate.nodeId) &&
            candidate.status === 'skipped' &&
            candidate.error === 'workflow_dependency_failed');
        if (!resetTarget) continue;
        if (candidate.id !== node.id) resetNodeIds.push(candidate.nodeId);
        if (candidate.runId) {
          candidate.runIds = [
            ...new Set([...(candidate.runIds ?? []), candidate.runId]),
          ];
        }
        candidate.status = 'pending';
        candidate.claimerId = undefined;
        candidate.claimedAt = undefined;
        candidate.runId = undefined;
        candidate.summary = undefined;
        candidate.error = undefined;
        candidate.startedAt = undefined;
        candidate.completedAt = undefined;
        candidate.updatedAt = timestamp;
      }
      execution.status = 'pending';
      execution.summary = undefined;
      execution.error = undefined;
      execution.completedAt = undefined;
      execution.updatedAt = timestamp;
      state.audit.push({
        id: randomUUID(),
        action: 'workflow.node.retried',
        workflowId: execution.workflowId,
        workspaceId: execution.workflow.workspaceId,
        projectId: execution.workflow.projectId,
        actor: input.actor?.trim() || 'admin',
        at: timestamp,
        snapshot: clone(execution.workflow),
        executionId: execution.id,
        nodeId,
        attempt: nextAttempt,
        reason: bounded(input.reason, 500) || 'workflow_node_retried',
      });
      return {
        execution: clone(execution),
        node: clone(node),
        resetNodeIds,
        nextAttempt,
      };
    });
  }

  async finalizeExecutions(at = new Date()): Promise<number> {
    return this.mutate((state) => {
      const timestamp = iso(at);
      let changed = 0;
      for (const execution of state.executions) {
        const before = `${execution.status}:${execution.updatedAt}`;
        updateExecutionState(execution, timestamp);
        if (`${execution.status}:${execution.updatedAt}` !== before) changed += 1;
      }
      return changed;
    });
  }

  async listExecutions(
    filter: WorkflowExecutionFilter = {},
  ): Promise<WorkflowExecution[]> {
    const state = await this.readState();
    return state.executions
      .filter(
        (execution) =>
          (!filter.workflowId || execution.workflowId === filter.workflowId) &&
          (!filter.workspaceId ||
            execution.workflow.workspaceId === filter.workspaceId) &&
          (!filter.projectId ||
            execution.workflow.projectId === filter.projectId) &&
          (!filter.status || execution.status === filter.status),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(filter.limit ?? 100, 500)))
      .map(clone);
  }

  async referencedRunIds(workspaceId: string): Promise<string[]> {
    const state = await this.readState();
    return [...new Set(
      state.executions
        .filter((execution) => execution.workflow.workspaceId === workspaceId)
        .flatMap((execution) =>
          execution.nodes.flatMap((node) => [
            ...(node.runIds ?? []),
            ...(node.runId ? [node.runId] : []),
          ]),
        ),
    )];
  }

  async getExecution(id: string): Promise<WorkflowExecution | undefined> {
    const state = await this.readState();
    const execution = state.executions.find((item) => item.id === id);
    return execution ? clone(execution) : undefined;
  }

  async summarize(
    workspaceId?: string,
    projectId?: string,
  ): Promise<WorkflowSummary> {
    const state = await this.readState();
    const producerRoutes = state.producerRoutes.filter(
      (route) =>
        route.status !== 'archived' &&
        (!workspaceId || route.workspaceId === workspaceId) &&
        (!projectId || route.projectId === projectId),
    );
    const workflows = state.workflows.filter(
      (workflow) =>
        workflow.status !== 'archived' &&
        (!workspaceId || workflow.workspaceId === workspaceId) &&
        (!projectId || workflow.projectId === projectId),
    );
    const ids = new Set(workflows.map((workflow) => workflow.id));
    const producerRouteIds = new Set(producerRoutes.map((route) => route.id));
    const producerRuntime = state.producerRuntime.filter((runtime) =>
      producerRouteIds.has(runtime.routeId),
    );
    const executions = executionCounts();
    const nodes = nodeCounts();
    const oldestExecutionUpdatedAt: Partial<
      Record<WorkflowExecutionStatus, string>
    > = {};
    const oldestNodeUpdatedAt: Partial<
      Record<WorkflowNodeExecutionStatus, string>
    > = {};
    for (const execution of state.executions) {
      if (!ids.has(execution.workflowId)) continue;
      executions[execution.status] += 1;
      recordOldestStatus(
        oldestExecutionUpdatedAt,
        execution.status,
        execution.updatedAt,
      );
      for (const node of execution.nodes) {
        nodes[node.status] += 1;
        recordOldestStatus(oldestNodeUpdatedAt, node.status, node.updatedAt);
      }
    }
    const queues = workflows.map((workflow) => {
      const workflowExecutions = state.executions
        .filter((execution) => execution.workflowId === workflow.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const active = workflowExecutions.filter(
        (execution) => execution.status === 'pending' || execution.status === 'running',
      );
      const activeNodes = active.flatMap((execution) => execution.nodes);
      const failed = workflowExecutions.filter((execution) => execution.status === 'failed');
      const oldestActiveUpdatedAt = active
        .map((execution) => execution.updatedAt)
        .sort((left, right) => left.localeCompare(right))[0];
      return {
        workflowId: workflow.id,
        workflowName: workflow.name,
        enabled: workflow.enabled,
        activeExecutions: active.length,
        queuedNodes: activeNodes.filter(
          (node) =>
            node.status === 'pending' ||
            node.status === 'claimed' ||
            node.status === 'queued',
        ).length,
        runningNodes: activeNodes.filter((node) => node.status === 'running').length,
        failedExecutions: failed.length,
        failedNodes: failed.flatMap((execution) => execution.nodes)
          .filter((node) => node.status === 'failed').length,
        oldestActiveUpdatedAt,
        latestExecutionUpdatedAt: workflowExecutions[0]?.updatedAt,
        latestExecutionStatus: workflowExecutions[0]?.status,
      };
    });
    return {
      producerRoutes: {
        enabled: producerRoutes.filter((route) => route.enabled).length,
        disabled: producerRoutes.filter((route) => !route.enabled).length,
      },
      producerRuntime: {
        ready: producerRuntime.filter(
          (runtime) => runtime.lastSuccessAt && !runtime.lastError && !runtime.claimerId,
        ).length,
        pending: producerRuntime.filter(
          (runtime) => !runtime.lastSuccessAt && !runtime.lastError && !runtime.claimerId,
        ).length,
        error: producerRuntime.filter((runtime) => Boolean(runtime.lastError)).length,
        claimed: producerRuntime.filter((runtime) => Boolean(runtime.claimerId)).length,
      },
      workflows: {
        enabled: workflows.filter((workflow) => workflow.enabled).length,
        disabled: workflows.filter((workflow) => !workflow.enabled).length,
      },
      executions,
      nodes,
      oldestExecutionUpdatedAt,
      oldestNodeUpdatedAt,
      queues,
    };
  }

  async listAudit(
    filter: WorkflowAuditFilter = {},
  ): Promise<WorkflowAuditRecord[]> {
    const state = await this.readState();
    return state.audit
      .filter(
        (entry) =>
          (!filter.workspaceId || entry.workspaceId === filter.workspaceId) &&
          (!filter.projectId || entry.projectId === filter.projectId),
      )
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, Math.max(1, Math.min(filter.limit ?? 50, 200)))
      .map(clone);
  }
}
