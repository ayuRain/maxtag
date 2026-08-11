import type {
  PlatformKind,
  SourceMessage,
  SourceThread,
} from '@opentag/core';
import type { FileThreadConfigStore } from '@opentag/config';
import type {
  AgentRunRecord,
  DeliveryStore,
  ThreadBinding,
} from '@opentag/delivery';
import type {
  FileWorkflowStore,
  WorkflowExecutionFilter,
  WorkflowNodeClaim,
} from '@opentag/workflows';

export interface WorkflowCoordinatorTickResult {
  at: string;
  claimed: number;
  queued: number;
  failed: number;
  reconciled: number;
  executionIds: string[];
  nodeExecutionIds: string[];
  runIds: string[];
}

export interface WorkflowCoordinatorOptions {
  workflowStore: FileWorkflowStore;
  deliveryStore: DeliveryStore;
  threadConfigStore: FileThreadConfigStore;
  coordinatorId: string;
  claimStaleMs?: number;
  batchSize?: number;
  transportModeForPlatform?: (platform: PlatformKind) => string;
  onRunQueued?: (run: AgentRunRecord) => void | Promise<void>;
}

function applyBindingToThread(
  thread: SourceThread,
  binding: ThreadBinding,
): SourceThread {
  return {
    ...thread,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    title: binding.title || thread.title,
    metadata: {
      ...thread.metadata,
      bindingId: binding.id,
      bindingScope: binding.scope,
      bindingSource: binding.source,
    },
  };
}

function stringifyInput(value: unknown, max = 20_000): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length <= max
    ? rendered
    : `${rendered.slice(0, max)}\n...[truncated]`;
}

function renderNodeInstructions(claim: WorkflowNodeClaim): string {
  const sections = [claim.node.instructions.trim()];
  if (claim.execution.input && Object.keys(claim.execution.input).length > 0) {
    sections.push(
      ['## Workflow input', stringifyInput(claim.execution.input)].join('\n\n'),
    );
  }
  if (claim.upstream.length > 0) {
    sections.push(
      [
        '## Upstream node outputs',
        claim.upstream
          .map(
            (upstream) =>
              `### ${upstream.nodeId}\n\n${upstream.summary || '(no summary)'}`,
          )
          .join('\n\n'),
      ].join('\n\n'),
    );
  }
  return sections.join('\n\n').slice(0, 60_000);
}

function defaultTransportMode(platform: PlatformKind): string {
  return platform === 'workflow' ? 'workflow-internal' : `${platform}-workflow`;
}

export class WorkflowCoordinatorService {
  private readonly workflowStore: FileWorkflowStore;
  private readonly deliveryStore: DeliveryStore;
  private readonly threadConfigStore: FileThreadConfigStore;
  private readonly coordinatorId: string;
  private readonly claimStaleMs: number;
  private readonly batchSize: number;
  private readonly transportModeForPlatform: (platform: PlatformKind) => string;
  private readonly onRunQueued?: (run: AgentRunRecord) => void | Promise<void>;
  private tickPass: Promise<WorkflowCoordinatorTickResult> | undefined;
  private _lastTickAt: string | undefined;
  private _lastTickResult: WorkflowCoordinatorTickResult | undefined;

  constructor(options: WorkflowCoordinatorOptions) {
    this.workflowStore = options.workflowStore;
    this.deliveryStore = options.deliveryStore;
    this.threadConfigStore = options.threadConfigStore;
    this.coordinatorId = options.coordinatorId;
    this.claimStaleMs = Math.max(1_000, options.claimStaleMs ?? 120_000);
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 20, 100));
    this.transportModeForPlatform =
      options.transportModeForPlatform ?? defaultTransportMode;
    this.onRunQueued = options.onRunQueued;
  }

  get running(): boolean {
    return Boolean(this.tickPass);
  }

  get lastTickAt(): string | undefined {
    return this._lastTickAt;
  }

  get lastTickResult(): WorkflowCoordinatorTickResult | undefined {
    return this._lastTickResult
      ? structuredClone(this._lastTickResult)
      : undefined;
  }

  async reconcileNodeRuns(
    filter: WorkflowExecutionFilter = {},
  ): Promise<number> {
    const executions = await this.workflowStore.listExecutions({
      ...filter,
      limit: Math.min(filter.limit ?? 500, 500),
    });
    let reconciled = 0;
    for (const execution of executions) {
      for (const node of execution.nodes) {
        if (!node.runId) continue;
        if (
          node.status === 'completed' ||
          node.status === 'failed' ||
          node.status === 'cancelled' ||
          node.status === 'skipped'
        ) {
          continue;
        }
        const run = await this.deliveryStore.getAgentRun(node.runId);
        if (!run) continue;
        const status = run.status === 'cancel_requested' ? 'running' : run.status;
        if (
          node.status === status &&
          node.summary === run.summary &&
          node.error === run.lastError
        ) {
          continue;
        }
        await this.workflowStore.reconcileNodeRun({
          runId: run.id,
          status,
          summary: run.summary,
          error: run.lastError,
        });
        reconciled += 1;
      }
    }
    return reconciled;
  }

  async tick(at = new Date()): Promise<WorkflowCoordinatorTickResult> {
    if (this.tickPass) return this.tickPass;
    this.tickPass = this.runTick(at);
    try {
      return await this.tickPass;
    } finally {
      this.tickPass = undefined;
    }
  }

  private async runTick(at: Date): Promise<WorkflowCoordinatorTickResult> {
    const reconciledBefore = await this.reconcileNodeRuns();
    const claims = await this.workflowStore.claimReadyNodes({
      claimerId: this.coordinatorId,
      limit: this.batchSize,
      staleAfterMs: this.claimStaleMs,
      at,
    });
    const result: WorkflowCoordinatorTickResult = {
      at: at.toISOString(),
      claimed: claims.length,
      queued: 0,
      failed: 0,
      reconciled: reconciledBefore,
      executionIds: [...new Set(claims.map((claim) => claim.execution.id))],
      nodeExecutionIds: claims.map((claim) => claim.nodeExecution.id),
      runIds: [],
    };
    for (const claim of claims) {
      try {
        const run = await this.enqueueClaim(claim, at);
        result.queued += 1;
        result.runIds.push(run.id);
      } catch (error) {
        result.failed += 1;
        await this.workflowStore.markNodeFailed(
          claim.nodeExecution.id,
          error instanceof Error ? error.message : String(error),
          at,
        );
      }
    }
    result.reconciled += await this.reconcileNodeRuns();
    this._lastTickAt = result.at;
    this._lastTickResult = structuredClone(result);
    return result;
  }

  private internalThread(claim: WorkflowNodeClaim): SourceThread {
    const externalId = `${claim.workflow.id}:${claim.execution.id}`;
    return {
      id: `workflow:${externalId}:${claim.node.id}`,
      platform: 'workflow',
      externalId,
      workspaceId: claim.workflow.workspaceId,
      projectId: claim.workflow.projectId,
      visibility: 'private',
      title: `${claim.workflow.name} / ${claim.node.name || claim.node.id}`,
      metadata: {
        workflowId: claim.workflow.id,
        workflowExecutionId: claim.execution.id,
        workflowNodeId: claim.node.id,
        publish: false,
      },
    };
  }

  private publishThread(claim: WorkflowNodeClaim): SourceThread {
    const destination = claim.workflow.destination;
    const threadId =
      destination.threadId ||
      `${destination.platform}:${destination.externalId}:workflow:${claim.workflow.id}`;
    return {
      id: threadId,
      platform: destination.platform,
      externalId: destination.externalId,
      workspaceId: claim.workflow.workspaceId,
      projectId: claim.workflow.projectId,
      channelId: destination.channelId || destination.externalId,
      rootMessageId: destination.rootMessageId,
      topicId: destination.topicId,
      visibility: destination.visibility,
      title: destination.title || claim.workflow.name,
      metadata: {
        workflowId: claim.workflow.id,
        workflowExecutionId: claim.execution.id,
        workflowNodeId: claim.node.id,
        publish: true,
      },
    };
  }

  private async routePublishThread(thread: SourceThread): Promise<{
    thread: SourceThread;
    bindingId?: string;
  }> {
    const configuredBinding = await this.deliveryStore.getThreadBindingForThread(
      thread,
    );
    if (
      configuredBinding &&
      (configuredBinding.workspaceId !== thread.workspaceId ||
        configuredBinding.projectId !== thread.projectId)
    ) {
      throw new Error('workflow_destination_binding_scope_mismatch');
    }
    const routed = configuredBinding
      ? applyBindingToThread(thread, configuredBinding)
      : thread;
    const observed = await this.deliveryStore.upsertThreadBinding({
      thread: routed,
      workspaceId: routed.workspaceId ?? 'default-workspace',
      projectId: routed.projectId ?? 'general',
      activationMode: configuredBinding?.activationMode ?? 'always',
      requireMention: configuredBinding?.requireMention ?? false,
    });
    return { thread: routed, bindingId: configuredBinding?.id ?? observed.id };
  }

  private async enqueueClaim(
    claim: WorkflowNodeClaim,
    at: Date,
  ): Promise<AgentRunRecord> {
    const rawThread = claim.publish
      ? this.publishThread(claim)
      : this.internalThread(claim);
    const routed = claim.publish
      ? await this.routePublishThread(rawThread)
      : { thread: rawThread, bindingId: undefined };
    const thread = routed.thread;
    const policy = await this.threadConfigStore.resolveThreadPolicy(thread);
    const runId = `workflow:${claim.execution.id}:${claim.node.id}`;
    const message: SourceMessage = {
      id: runId,
      threadId: thread.id,
      platform: thread.platform,
      text: renderNodeInstructions(claim),
      actor: {
        id: `workflow:${claim.workflow.id}`,
        displayName: claim.workflow.name,
        isBot: true,
      },
      createdAt: at.toISOString(),
      mentionsAgent: true,
      metadata: {
        workflowId: claim.workflow.id,
        workflowExecutionId: claim.execution.id,
        workflowNodeId: claim.node.id,
        workflowTrigger: claim.execution.trigger,
        publish: claim.publish,
      },
    };
    const run = await this.deliveryStore.createAgentRun({
      runId,
      thread,
      message,
      bindingId: routed.bindingId,
      executorId: policy.identity.defaultExecutorId,
      transportMode: this.transportModeForPlatform(thread.platform),
      metadata: {
        source: 'workflow',
        workflowId: claim.workflow.id,
        workflowName: claim.workflow.name,
        workflowVersion: claim.workflow.version,
        workflowExecutionId: claim.execution.id,
        workflowNodeId: claim.node.id,
        workflowNodeName: claim.node.name,
        workflowPublish: claim.publish,
        workflowTrigger: claim.execution.trigger,
        actorAuthorization: {
          allowed: true,
          reason: 'operator_or_internal',
        },
        agentId: policy.identity.id,
        agentDisplayName: policy.identity.displayName,
        policyConfigured: policy.configured,
        grantKinds: policy.access.grants.map((grant) => grant.kind),
      },
    });
    await this.workflowStore.markNodeQueued(
      claim.nodeExecution.id,
      run.id,
      at,
    );
    await this.onRunQueued?.(run);
    return run;
  }
}
