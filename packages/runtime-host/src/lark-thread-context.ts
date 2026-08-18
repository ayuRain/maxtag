import type { AgentRunRecord, DeliveryStore } from '@opentag/delivery';
import {
  normalizeLarkHistoryMessage,
  type LarkTransport,
} from '@opentag/platform-lark';

export const LARK_THREAD_CONTEXT_SOURCE = 'lark-thread-history';

export interface HydrateLarkThreadContextOptions {
  deliveryStore: DeliveryStore;
  run: AgentRunRecord;
  transport?: LarkTransport;
  botOpenId?: string;
  maxMessages?: number;
  retryFailedAfterMs?: number;
  now?: () => Date;
}

export interface HydrateLarkThreadContextResult {
  attempted: boolean;
  importedMessages: number;
  duplicateMessages: number;
  truncated: boolean;
  skippedReason?: string;
  larkThreadId?: string;
}

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_FAILED_RETRY_MS = 60 * 60_000;

export async function hydrateLarkThreadContext(
  options: HydrateLarkThreadContextOptions,
): Promise<HydrateLarkThreadContextResult> {
  const { run } = options;
  if (run.thread?.platform !== 'lark') {
    return emptyResult('not_lark_thread');
  }
  if (!run.message) {
    return emptyResult('missing_source_message');
  }
  // A Lark group's `:main` conversation is not a topic thread. Its messages
  // are already captured continuously by ingress, and asking Lark to resolve
  // the current message and then list a non-existent thread only adds a slow
  // remote round trip before the acknowledgement card can be created.
  if (run.thread.externalId.endsWith(':main')) {
    return emptyResult('lark_main_conversation');
  }
  if (!options.transport) {
    return emptyResult('missing_lark_transport');
  }

  const now = options.now ?? (() => new Date());
  const retryFailedAfterMs =
    options.retryFailedAfterMs ?? DEFAULT_FAILED_RETRY_MS;
  const prior = await options.deliveryStore.getThreadContextSync(
    run.thread,
    LARK_THREAD_CONTEXT_SOURCE,
  );
  if (prior?.status === 'completed') {
    return emptyResult('already_imported');
  }
  if (
    prior?.status === 'failed' &&
    now().getTime() - new Date(prior.attemptedAt).getTime() < retryFailedAfterMs
  ) {
    return emptyResult('recent_failure');
  }

  const maxMessages = Math.max(
    1,
    Math.min(options.maxMessages ?? DEFAULT_MAX_MESSAGES, 50),
  );
  let larkThreadId = metadataString(run.thread.metadata, 'larkThreadId');
  larkThreadId ||= metadataString(run.message.metadata, 'larkThreadId');

  try {
    if (!larkThreadId) {
      const current = await options.transport.getMessage(run.message.id);
      larkThreadId = current?.thread_id;
    }
    if (!larkThreadId) {
      return emptyResult('missing_lark_thread_id');
    }

    const page = await options.transport.listMessages({
      containerType: 'thread',
      containerId: larkThreadId,
      sortType: 'ByCreateTimeAsc',
      pageSize: maxMessages,
    });
    const messages = page.items
      .map((message) =>
        normalizeLarkHistoryMessage(message, {
          thread: run.thread!,
          botOpenId: options.botOpenId,
        }),
      )
      .filter(
        (message): message is NonNullable<typeof message> =>
          message !== null && !message.actor.isBot,
      );
    const result = await options.deliveryStore.upsertSourceThreadMessages({
      thread: run.thread,
      messages,
      origin: 'history',
      observedAt: now(),
    });
    const importedMessages = result.inserted + result.updated;
    await options.deliveryStore.recordThreadContextSync({
      thread: run.thread,
      source: LARK_THREAD_CONTEXT_SOURCE,
      status: 'completed',
      importedMessages,
      duplicateMessages: result.duplicates,
      truncated: page.hasMore,
      metadata: {
        larkThreadId,
        requestedMessages: maxMessages,
      },
      attemptedAt: now(),
    });
    await options.deliveryStore.appendAgentRunEvent(
      run.id,
      'thread_context_imported',
      {
        message: `${importedMessages} Lark thread history messages imported`,
        metadata: {
          source: LARK_THREAD_CONTEXT_SOURCE,
          larkThreadId,
          importedMessages,
          duplicateMessages: result.duplicates,
          truncated: page.hasMore,
        },
      },
    );
    return {
      attempted: true,
      importedMessages,
      duplicateMessages: result.duplicates,
      truncated: page.hasMore,
      larkThreadId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.deliveryStore.recordThreadContextSync({
      thread: run.thread,
      source: LARK_THREAD_CONTEXT_SOURCE,
      status: 'failed',
      error: message,
      metadata: { larkThreadId },
      attemptedAt: now(),
    });
    await options.deliveryStore.appendAgentRunEvent(
      run.id,
      'thread_context_import_failed',
      {
        message,
        metadata: {
          source: LARK_THREAD_CONTEXT_SOURCE,
          larkThreadId,
        },
      },
    );
    return {
      attempted: true,
      importedMessages: 0,
      duplicateMessages: 0,
      truncated: false,
      skippedReason: 'failed',
      larkThreadId,
    };
  }
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function emptyResult(skippedReason: string): HydrateLarkThreadContextResult {
  return {
    attempted: false,
    importedMessages: 0,
    duplicateMessages: 0,
    truncated: false,
    skippedReason,
  };
}
