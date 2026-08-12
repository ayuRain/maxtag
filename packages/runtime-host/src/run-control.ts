import type {
  AgentSteeringChannel,
  AgentSteeringProvider,
  ExecutorSteeringMode,
} from '@opentag/core';
import { OPENTAG_LEASE_LOST_ABORT_REASON } from '@opentag/core';
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
  workerId?: string;
  pollMs?: number;
  heartbeatMs?: number;
  onError?: (error: unknown) => void;
}

export interface DurableRunLeaseOptions {
  deliveryStore: DeliveryStore;
  runId: string;
  workerId: string;
  abortController: AbortController;
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

export async function renewDurableRunLeaseOrAbort(
  options: DurableRunLeaseOptions,
): Promise<boolean> {
  if (options.abortController.signal.aborted) return false;
  const renewed = await options.deliveryStore.renewAgentRunLease(
    options.runId,
    { workerId: options.workerId },
  );
  if (renewed) return true;

  const latest = await options.deliveryStore.getAgentRun(options.runId);
  if (
    latest?.status === 'cancel_requested' ||
    latest?.status === 'cancelled'
  ) {
    options.abortController.abort(
      latest.lastError || 'durable_cancel_requested',
    );
  } else {
    options.abortController.abort(
      `${OPENTAG_LEASE_LOST_ABORT_REASON}:${
        latest
          ? `${latest.status}:${latest.workerId || 'unowned'}`
          : 'missing'
      }`,
    );
  }
  return false;
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
  const heartbeatMs = Math.max(250, options.heartbeatMs ?? 15_000);
  let lastHeartbeatAt = 0;
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
        return;
      }
      if (
        options.workerId &&
        (!run ||
          run.status !== 'running' ||
          run.workerId !== options.workerId)
      ) {
        options.abortController.abort(
          `${OPENTAG_LEASE_LOST_ABORT_REASON}:${
            run ? `${run.status}:${run.workerId || 'unowned'}` : 'missing'
          }`,
        );
        return;
      }
      const currentTime = Date.now();
      if (
        run?.status === 'running' &&
        options.workerId &&
        currentTime - lastHeartbeatAt >= heartbeatMs
      ) {
        const renewed = await renewDurableRunLeaseOrAbort({
          deliveryStore: options.deliveryStore,
          runId: options.runId,
          workerId: options.workerId,
          abortController: options.abortController,
        });
        if (renewed) lastHeartbeatAt = currentTime;
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
