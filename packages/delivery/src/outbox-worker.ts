import type { FileDeliveryStore } from './file-delivery-store.js';
import type { OutboundEnvelope } from './types.js';

export interface DeliveryWorkerPassResult {
  claimed: number;
  delivered: number;
  failed: number;
  retried: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDeliveryWorkerPass(
  store: FileDeliveryStore,
  dispatch: (record: OutboundEnvelope) => Promise<string | undefined>,
  options?: { limit?: number },
): Promise<DeliveryWorkerPassResult> {
  const records = await store.claimReadyOutbox({ limit: options?.limit });
  const result: DeliveryWorkerPassResult = {
    claimed: records.length,
    delivered: 0,
    failed: 0,
    retried: 0,
  };

  for (const record of records) {
    try {
      const externalId = await dispatch(record);
      await store.markDelivered(record.id, externalId);
      result.delivered += 1;
    } catch (error) {
      const updated = await store.markFailed(record.id, errorMessage(error));
      if (updated?.status === 'failed') result.failed += 1;
      else result.retried += 1;
    }
  }

  return result;
}
