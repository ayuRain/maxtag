import type {
  AgentRunEvent,
  AgentRunResult,
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
  readableMemoryScopes,
} from './memory-policy.js';
import {
  isOpenTagLeaseLostAbort,
  isOpenTagRequeueAbort,
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

    const progress = this.deps.platform.createProgressSurface(input.thread);
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
      const executorId = input.executorId ?? identity.defaultExecutorId;
      executor = this.deps.executors
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
      const memorySnapshot: ScopedMemorySnapshot | undefined =
        await this.deps.memory.loadMemory?.({
          thread: input.thread,
          workspace,
          project,
          scopes: readableMemoryScopes(access),
        });
      const memory =
        memorySnapshot?.text ??
        (await this.deps.memory.loadThreadMemory(input.thread));

      state = {
        ...state,
        checklist: updateChecklist(state.checklist, {
          id: 'memory',
          label: 'Load scoped memory',
          status: 'done',
          detail: memorySnapshot
            ? `${memorySnapshot.scopes.length} scope(s)`
            : 'thread scope',
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
      await this.deps.platform.sendMessage(
        input.thread,
        result.summary,
        result.artifacts,
        { runId: input.runId },
      );

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
      return result;
    } catch (error) {
      if (isOpenTagLeaseLostAbort(input.abortSignal)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const requeued = isOpenTagRequeueAbort(input.abortSignal);
      state = {
        ...state,
        status: requeued
          ? 'blocked'
          : input.abortSignal?.aborted
            ? 'cancelled'
            : 'failed',
        summary: requeued
          ? 'Worker is restarting. This run remains queued and will resume.'
          : message,
        checklist: updateChecklist(state.checklist, {
          ...activeItem,
          status: requeued ? 'pending' : 'failed',
          detail: requeued ? 'Waiting for an available worker' : message,
        }),
        updatedAt: now(),
      };
      if (requeued) await progress.update(surfaceId, state);
      else await progress.complete(surfaceId, state);
      throw error;
    }
  }
}
