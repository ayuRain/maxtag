import type {
  AgentRunEvent,
  AgentRunResult,
  ChecklistItem,
  ProgressState,
  RuntimeDependencies,
  SourceMessage,
  SourceThread,
} from './types.js';

function createDefaultChecklist(): ChecklistItem[] {
  return [
    { id: 'understand', label: 'Understand request', status: 'running' },
    { id: 'work', label: 'Run agent work', status: 'pending' },
    { id: 'publish', label: 'Publish result', status: 'pending' },
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
    thread: SourceThread;
    message: SourceMessage;
    abortSignal?: AbortSignal;
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
    const { surfaceId } = await progress.create(state);

    const identity = await this.deps.threadConfig.getIdentity(input.thread);
    const access = await this.deps.threadConfig.getAccessBundle(input.thread);
    const memory = await this.deps.memory.loadThreadMemory(input.thread);

    state = {
      ...state,
      checklist: updateChecklist(state.checklist, {
        id: 'understand',
        label: 'Understand request',
        status: 'done',
      }),
      updatedAt: now(),
    };
    await progress.update(surfaceId, state);

    const onEvent = async (event: AgentRunEvent): Promise<void> => {
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

    try {
      state = {
        ...state,
        checklist: updateChecklist(state.checklist, {
          id: 'work',
          label: 'Run agent work',
          status: 'running',
        }),
        updatedAt: now(),
      };
      await progress.update(surfaceId, state);

      const result = await this.deps.executor.run({
        runId: input.runId,
        thread: input.thread,
        message: input.message,
        identity,
        access,
        memory,
        abortSignal: input.abortSignal,
        onEvent,
      });

      state = {
        ...state,
        status: 'completed',
        summary: result.summary,
        checklist: updateChecklist(
          updateChecklist(state.checklist, {
            id: 'work',
            label: 'Run agent work',
            status: 'done',
          }),
          {
            id: 'publish',
            label: 'Publish result',
            status: 'running',
          },
        ),
        updatedAt: now(),
      };
      await progress.update(surfaceId, state);
      await this.deps.platform.sendMessage(
        input.thread,
        result.summary,
        result.artifacts,
      );

      state = {
        ...state,
        checklist: updateChecklist(state.checklist, {
          id: 'publish',
          label: 'Publish result',
          status: 'done',
        }),
        updatedAt: now(),
      };
      await progress.complete(surfaceId, state);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = {
        ...state,
        status: input.abortSignal?.aborted ? 'cancelled' : 'failed',
        summary: message,
        checklist: updateChecklist(state.checklist, {
          id: 'work',
          label: 'Run agent work',
          status: 'failed',
          detail: message,
        }),
        updatedAt: now(),
      };
      await progress.complete(surfaceId, state);
      throw error;
    }
  }
}

