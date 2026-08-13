import type {
  AgentRunEvent,
  AgentRunResult,
  AgentMemoryCandidate,
  AgentSteeringProvider,
  ProviderSessionContext,
  ChecklistItem,
  Executor,
  ScopedMemorySnapshot,
  ProgressState,
  RuntimeDependencies,
  SourceMessage,
  SourceThread,
  ThreadTranscriptSnapshot,
} from './types.js';
import {
  constrainWorkspaceMemoryWrite,
  memoryRetentionDaysFor,
  memoryScopeGranted,
  readableMemoryScopes,
} from './memory-policy.js';
import {
  isOpenTagLeaseLostAbort,
  isOpenTagRequeueAbort,
  openTagAbortSummary,
} from './types.js';

function createDefaultChecklist(): ChecklistItem[] {
  return [
    { id: 'route', label: 'Resolve workspace/project', status: 'running' },
    { id: 'memory', label: 'Load scoped memory', status: 'pending' },
    { id: 'work', label: 'Run executor', status: 'pending' },
    { id: 'publish', label: 'Publish thread reply', status: 'pending' },
  ];
}

function updateChecklist(
  checklist: ChecklistItem[],
  item: ChecklistItem,
): ChecklistItem[] {
  const index = checklist.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...checklist, item];
  return checklist.map((candidate, i) => (i === index ? item : candidate));
}

const MAX_AUTOMATIC_MEMORY_CANDIDATES = 3;

function normalizedMemoryCandidateText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function containsSensitiveMemoryValue(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:api[_ -]?key|app[_ -]?secret|client[_ -]?secret|password|passwd|access[_ -]?token|refresh[_ -]?token|verification[_ -]?token)\b\s*[:=]\s*\S+/iu.test(
      value,
    )
  );
}

function validAutomaticMemoryCandidate(input: {
  candidate: AgentMemoryCandidate;
  access: Parameters<typeof memoryScopeGranted>[0];
  hasProject: boolean;
  hasChannel: boolean;
}): AgentMemoryCandidate | undefined {
  const { candidate } = input;
  if (!memoryScopeGranted(input.access, candidate.scope, 'write')) return undefined;
  if (candidate.scope === 'project' && !input.hasProject) return undefined;
  if (candidate.scope === 'channel' && !input.hasChannel) return undefined;
  const text = normalizedMemoryCandidateText(candidate.text);
  if (!text || text.length > 600 || containsSensitiveMemoryValue(text)) {
    return undefined;
  }
  const reason = candidate.reason?.trim().replace(/\s+/gu, ' ').slice(0, 240);
  return { scope: candidate.scope, text, reason: reason || undefined };
}

export class OpenTagRuntime {
  private readonly deps: RuntimeDependencies;

  constructor(deps: RuntimeDependencies) {
    this.deps = deps;
  }

  async handleMessage(input: {
    runId: string;
    executorId?: string;
    thread: SourceThread;
    message: SourceMessage;
    workspaceMemoryWriteAllowed?: boolean;
    abortSignal?: AbortSignal;
    progressSurfaceId?: string;
    assertActive?: () => void | Promise<void>;
    steering?: AgentSteeringProvider;
    transcript?: ThreadTranscriptSnapshot;
    providerSession?: ProviderSessionContext;
    publishResult?: boolean;
    onEvent?: (event: AgentRunEvent) => void | Promise<void>;
  }): Promise<AgentRunResult> {
    const now = () => (this.deps.clock ?? (() => new Date()))().toISOString();
    let state: ProgressState = {
      runId: input.runId,
      title: `Working on ${input.thread.title || input.thread.externalId}`,
      status: 'running',
      checklist: createDefaultChecklist(),
      updatedAt: now(),
    };

    const progress =
      input.publishResult === false
        ? {
            async create(): Promise<{ surfaceId: string }> {
              return { surfaceId: `silent:${input.runId}` };
            },
            async update(): Promise<void> {},
            async complete(): Promise<void> {},
          }
        : this.deps.platform.createProgressSurface(input.thread);
    const surfaceId = input.progressSurfaceId
      ? input.progressSurfaceId
      : (await progress.create(state)).surfaceId;
    if (input.progressSurfaceId) await progress.update(surfaceId, state);
    let executor: Executor | undefined;
    let activeItem: ChecklistItem = {
      id: 'route',
      label: 'Resolve workspace/project',
      status: 'running',
    };

    try {
      const workspace =
        (await this.deps.threadConfig.getWorkspace?.(input.thread)) ??
        (input.thread.workspaceId
          ? { id: input.thread.workspaceId, name: input.thread.workspaceId }
          : undefined);
      const project = await this.deps.threadConfig.getProject?.(
        input.thread,
        workspace,
      );
      const identity = await this.deps.threadConfig.getIdentity(input.thread);
      const access = constrainWorkspaceMemoryWrite(
        await this.deps.threadConfig.getAccessBundle(input.thread, {
          workspace,
          project,
        }),
        input.workspaceMemoryWriteAllowed,
      );
      const skills =
        this.deps.skills && access.skillIds?.length
          ? (await this.deps.skills.list({ ids: access.skillIds })).map(
              ({ id, name, description, revision }) => ({
                id,
                name,
                description,
                revision,
              }),
            )
          : [];
      const delegatedAgents =
        this.deps.delegatedAgents && access.agentIds?.length
          ? (await this.deps.delegatedAgents.list({ ids: access.agentIds })).map(
              ({ id, name, description, executorId, revision }) => ({
                id,
                name,
                description,
                executorId,
                revision,
              }),
            )
          : [];
      const knowledgeSources =
        this.deps.knowledgeSources &&
        workspace?.id &&
        access.knowledgeSourceIds?.length
          ? (
              await this.deps.knowledgeSources.list({
                workspaceId: workspace.id,
                ids: access.knowledgeSourceIds,
              })
            ).map(
              ({ content: _content, ...source }) => source,
            )
          : [];
      const executorId = input.executorId ?? identity.defaultExecutorId;
      executor = this.deps.executorRegistry
        ? this.deps.executorRegistry.get(executorId)
        : this.deps.executors
          ? this.deps.executors[executorId]
          : this.deps.executor;
      if (!executor) {
        throw new Error(`executor_not_available:${executorId}`);
      }

      state = {
        ...state,
        checklist: updateChecklist(state.checklist, {
          id: 'route',
          label: 'Resolve workspace/project',
          status: 'done',
          detail: [workspace?.name, project?.name].filter(Boolean).join(' / '),
        }),
        updatedAt: now(),
      };
      await progress.update(surfaceId, state);

      activeItem = {
        id: 'memory',
        label: 'Load scoped memory',
        status: 'running',
      };
      const approvedMemorySnapshot: ScopedMemorySnapshot | undefined =
        await this.deps.memory.loadMemory?.({
          thread: input.thread,
          workspace,
          project,
          scopes: readableMemoryScopes(access),
        });
      let memorySnapshot = approvedMemorySnapshot;
      let memory =
        approvedMemorySnapshot?.text ??
        (await this.deps.memory.loadThreadMemory(input.thread));
      let memoryDetail = approvedMemorySnapshot
        ? `${approvedMemorySnapshot.scopes.length} scope(s)`
        : 'thread scope';
      if (approvedMemorySnapshot && this.deps.memoryRetriever) {
        const retrieval = await this.deps.memoryRetriever.retrieve({
          runId: input.runId,
          workspace,
          project,
          thread: input.thread,
          message: input.message,
          access,
          memorySnapshot: approvedMemorySnapshot,
          transcript: input.transcript,
          abortSignal: input.abortSignal,
        });
        memorySnapshot = retrieval.snapshot;
        memory = retrieval.snapshot.text;
        memoryDetail = `${retrieval.selectedLines}/${retrieval.candidateLines} line(s) / ${retrieval.strategy}`;
        await input.onEvent?.({
          type: 'memory_retrieval',
          strategy: retrieval.strategy,
          candidateLines: retrieval.candidateLines,
          selectedLines: retrieval.selectedLines,
          durationMs: retrieval.durationMs,
          fallbackReason: retrieval.fallbackReason,
        });
      }

      state = {
        ...state,
        checklist: updateChecklist(state.checklist, {
          id: 'memory',
          label: 'Load scoped memory',
          status: 'done',
          detail: memoryDetail,
        }),
        updatedAt: now(),
      };
      await progress.update(surfaceId, state);

      const onEvent = async (event: AgentRunEvent): Promise<void> => {
        await input.onEvent?.(event);
        if (event.type === 'progress') {
          state = {
            ...state,
            checklist: updateChecklist(state.checklist, event.item),
            summary: event.message ?? state.summary,
            updatedAt: now(),
          };
          await progress.update(surfaceId, state);
        }
      };

      activeItem = {
        id: 'work',
        label: `Run ${executor.label}`,
        status: 'running',
      };
      state = {
        ...state,
        checklist: updateChecklist(state.checklist, activeItem),
        updatedAt: now(),
      };
      await progress.update(surfaceId, state);

      const steering = input.steering
        ? await input.steering.open(executor.steeringMode ?? 'next_turn')
        : undefined;
      const providerSession =
        input.providerSession?.providerId === executor.id
          ? input.providerSession
          : undefined;
      const result = await executor.run({
        runId: input.runId,
        workspace,
        project,
        thread: input.thread,
        message: input.message,
        identity,
        access,
        skills,
        delegatedAgents,
        knowledgeSources,
        memory,
        memorySnapshot,
        transcript: input.transcript,
        providerSession,
        steering,
        abortSignal: input.abortSignal,
        onEvent,
      });

      await input.assertActive?.();

      state = {
        ...state,
        status: 'completed',
        summary: result.summary,
        checklist: updateChecklist(
          updateChecklist(state.checklist, {
            id: 'work',
            label: `Run ${executor.label}`,
            status: 'done',
          }),
          {
            id: 'publish',
            label: 'Publish thread reply',
            status: 'running',
          },
        ),
        updatedAt: now(),
      };
      await progress.update(surfaceId, state);
      activeItem = {
        id: 'publish',
        label: 'Publish thread reply',
        status: 'running',
      };
      await input.assertActive?.();
      if (input.publishResult !== false) {
        await this.deps.platform.sendMessage(
          input.thread,
          result.summary,
          result.artifacts,
          {
            runId: input.runId,
            replyToMessageId: input.message.replyToMessageId,
          },
        );
      }

      const memoryProposals = [];
      const seenCandidates = new Set<string>();
      if (this.deps.memory.proposeMemory) {
        for (const rawCandidate of (result.memoryCandidates ?? []).slice(
          0,
          MAX_AUTOMATIC_MEMORY_CANDIDATES,
        )) {
          const candidate = validAutomaticMemoryCandidate({
            candidate: rawCandidate,
            access,
            hasProject: Boolean(project),
            hasChannel: Boolean(input.thread.channelId),
          });
          if (!candidate) continue;
          const key = `${candidate.scope}:${candidate.text.toLocaleLowerCase()}`;
          if (seenCandidates.has(key)) continue;
          seenCandidates.add(key);
          const source = `agent-run:${input.runId}`;
          try {
            const proposal = await this.deps.memory.proposeMemory({
              thread: input.thread,
              workspace,
              project,
              scope: candidate.scope,
              action: 'remember',
              value: candidate.text,
              actorId: `agent:${executor.id}`,
              source,
              reason: candidate.reason || 'agent:durable_memory_candidate',
              retentionDays: memoryRetentionDaysFor(access, candidate.scope),
            });
            // The store returns an existing pending proposal for exact duplicates.
            if (proposal.source !== source) continue;
            memoryProposals.push(proposal);
            await onEvent({ type: 'memory_proposal', proposal });
          } catch (error) {
            await onEvent({
              type: 'log',
              level: 'warn',
              message: `Memory candidate could not be queued: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }
      }

      state = {
        ...state,
        checklist: updateChecklist(state.checklist, {
          id: 'publish',
          label: 'Publish thread reply',
          status: 'done',
        }),
        updatedAt: now(),
      };
      await progress.complete(surfaceId, state);
      return memoryProposals.length ? { ...result, memoryProposals } : result;
    } catch (error) {
      if (isOpenTagLeaseLostAbort(input.abortSignal)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const requeued = isOpenTagRequeueAbort(input.abortSignal);
      const visibleMessage = openTagAbortSummary(input.abortSignal, message);
      state = {
        ...state,
        status: requeued
          ? 'blocked'
          : input.abortSignal?.aborted
            ? 'cancelled'
            : 'failed',
        summary: requeued
          ? 'Worker is restarting. This run remains queued and will resume.'
          : visibleMessage,
        checklist: updateChecklist(state.checklist, {
          ...activeItem,
          status: requeued ? 'pending' : 'failed',
          detail: requeued ? 'Waiting for an available worker' : visibleMessage,
        }),
        updatedAt: now(),
      };
      if (requeued) await progress.update(surfaceId, state);
      else await progress.complete(surfaceId, state);
      throw error;
    }
  }
}
