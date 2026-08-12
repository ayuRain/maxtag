import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
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
  return { version: 1, workflows: [], executions: [], audit: [] };
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
            },
            payload: input.payload,
          },
          timestamp,
        );
        state.executions.push(execution);
        staged.push(clone(execution));
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
      node.status = 'queued';
      node.runId = runId;
      node.error = undefined;
    });
  }

  async markNodeFailed(
    nodeExecutionId: string,
    error: string,
    at = new Date(),
  ): Promise<WorkflowNodeExecution | undefined> {
    return this.updateNode(nodeExecutionId, at, (node) => {
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
    update: (node: WorkflowNodeExecution) => void,
  ): Promise<WorkflowNodeExecution | undefined> {
    return this.mutate((state) => {
      const execution = state.executions.find((item) =>
        item.nodes.some((node) => node.id === nodeExecutionId),
      );
      const node = execution?.nodes.find((item) => item.id === nodeExecutionId);
      if (!execution || !node) return undefined;
      update(node);
      const timestamp = iso(at);
      node.updatedAt = timestamp;
      execution.updatedAt = timestamp;
      updateExecutionState(execution, timestamp);
      return clone(node);
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
    const workflows = state.workflows.filter(
      (workflow) =>
        workflow.status !== 'archived' &&
        (!workspaceId || workflow.workspaceId === workspaceId) &&
        (!projectId || workflow.projectId === projectId),
    );
    const ids = new Set(workflows.map((workflow) => workflow.id));
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
    return {
      workflows: {
        enabled: workflows.filter((workflow) => workflow.enabled).length,
        disabled: workflows.filter((workflow) => !workflow.enabled).length,
      },
      executions,
      nodes,
      oldestExecutionUpdatedAt,
      oldestNodeUpdatedAt,
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
