import type {
  ProviderSessionContext,
  ThreadTranscriptSnapshot,
} from '@opentag/core';
import type { AgentRunRecord, DeliveryStore } from '@opentag/delivery';
import os from 'node:os';

export function defaultProviderSessionNamespace(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return `local:${os.hostname()}:${uid}`;
}

export interface DurableConversationContextOptions {
  deliveryStore: DeliveryStore;
  run: AgentRunRecord;
  transcriptMaxEntries?: number;
  transcriptMaxChars?: number;
}

export interface DurableProviderSessionOptions {
  deliveryStore: DeliveryStore;
  run: AgentRunRecord;
  providerId: string;
  namespace: string;
}

export async function loadDurableConversationContext(
  options: DurableConversationContextOptions,
): Promise<ThreadTranscriptSnapshot | undefined> {
  if (!options.run.thread) return undefined;
  const transcript = await options.deliveryStore.loadThreadTranscript({
    thread: options.run.thread,
    excludeRunId: options.run.id,
    maxEntries: options.transcriptMaxEntries,
    maxChars: options.transcriptMaxChars,
  });
  await options.deliveryStore.appendAgentRunEvent(
    options.run.id,
    'transcript_loaded',
    {
      message: `${transcript.entries.length} shared-thread context entries loaded`,
      metadata: {
        totalEntries: transcript.totalEntries,
        loadedEntries: transcript.entries.length,
        omittedEntries: transcript.omittedEntries,
        truncated: transcript.truncated,
      },
    },
  );
  return transcript;
}

export async function createDurableProviderSessionContext(
  options: DurableProviderSessionOptions,
): Promise<ProviderSessionContext | undefined> {
  if (!options.run.thread) return undefined;
  const query = {
    providerId: options.providerId,
    namespace: options.namespace,
    thread: options.run.thread,
  };
  const existing = await options.deliveryStore.getAgentThreadSession(query);
  return {
    providerId: options.providerId,
    namespace: options.namespace,
    sessionId: existing?.sessionId,
    resumedFromRunId: existing?.lastRunId,
    async record(sessionId: string) {
      await options.deliveryStore.recordAgentThreadSession({
        ...query,
        sessionId,
        runId: options.run.id,
      });
    },
    async invalidate(reason: string) {
      await options.deliveryStore.invalidateAgentThreadSession({
        ...query,
        runId: options.run.id,
        reason,
      });
    },
  };
}
