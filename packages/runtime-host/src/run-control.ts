import type {
  AgentSteeringChannel,
  AgentSteeringProvider,
  ExecutorSteeringMode,
} from '@opentag/core';
import type { DeliveryStore } from '@opentag/delivery';

export interface DurableSteeringProviderOptions {
  deliveryStore: DeliveryStore;
  runId: string;
  workerId: string;
  pollMs?: number;
}

export interface DurableCancellationMonitorOptions {
  deliveryStore: DeliveryStore;
  runId: string;
  abortController: AbortController;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

export function createDurableSteeringProvider(
  options: DurableSteeringProviderOptions,
): AgentSteeringProvider {
  const pollMs = Math.max(25, options.pollMs ?? 250);
  return {
    async open(mode: ExecutorSteeringMode): Promise<AgentSteeringChannel> {
      await options.deliveryStore.setAgentRunSteeringMode(options.runId, mode);
      return {
        mode,
        async receive(input = {}) {
          if (mode !== 'live') return undefined;
          const waitMs = Math.max(0, input.waitMs ?? 0);
          const deadline = Date.now() + waitMs;
          do {
            if (input.signal?.aborted) return undefined;
            const steering =
              await options.deliveryStore.claimNextAgentRunSteering(
                options.runId,
                { workerId: options.workerId },
              );
            if (steering) {
              return {
                id: steering.id,
                targetRunId: steering.targetRunId,
                receivedAt: steering.receivedAt,
                thread: steering.thread,
                message: steering.message,
              };
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) return undefined;
            await wait(Math.min(pollMs, remaining), input.signal);
          } while (!input.signal?.aborted);
          return undefined;
        },
        async acknowledge(id: string, detail?: string) {
          const steering =
            await options.deliveryStore.markAgentRunSteeringApplied(
              id,
              detail,
              options.runId,
            );
          if (
            !steering ||
            steering.targetRunId !== options.runId ||
            steering.status !== 'applied'
          ) {
            throw new Error(`steering_not_claimed:${id}`);
          }
        },
      };
    },
  };
}

export function monitorDurableRunCancellation(
  options: DurableCancellationMonitorOptions,
): () => void {
  const pollMs = Math.max(25, options.pollMs ?? 250);
  let checking = false;
  let stopped = false;
  const check = async (): Promise<void> => {
    if (checking || stopped || options.abortController.signal.aborted) return;
    checking = true;
    try {
      const run = await options.deliveryStore.getAgentRun(options.runId);
      if (run?.status === 'cancel_requested' || run?.status === 'cancelled') {
        options.abortController.abort(
          run.lastError || 'durable_cancel_requested',
        );
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), pollMs);
  timer.unref?.();
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
