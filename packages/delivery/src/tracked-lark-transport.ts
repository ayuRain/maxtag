import type {
  LarkDeliveryMetadata,
  LarkTransport,
} from '@opentag/platform-lark';
import type { DeliveryStore } from './file-delivery-store.js';
import type { OutboundTarget } from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metadataTarget(
  base: OutboundTarget,
  metadata?: LarkDeliveryMetadata,
): OutboundTarget {
  return {
    ...base,
    platform: 'lark',
    rootId: base.rootId ?? metadata?.thread?.rootMessageId,
  };
}

export class TrackedLarkTransport implements LarkTransport {
  private readonly delegate: LarkTransport;
  private readonly store: DeliveryStore;

  constructor(delegate: LarkTransport, store: DeliveryStore) {
    this.delegate = delegate;
    this.store = store;
  }

  async sendText(input: {
    chatId: string;
    text: string;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void> {
    const envelope = await this.store.enqueue({
      kind: 'lark.text',
      target: metadataTarget(
        {
          platform: 'lark',
          chatId: input.chatId,
          rootId: input.rootId,
          replyToMessageId: input.replyToMessageId,
        },
        input.metadata,
      ),
      payload: {
        text: input.text,
        stage: input.metadata?.stage,
      },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      await this.delegate.sendText(input);
      await this.store.markDelivered(envelope.id);
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  async createCard(input: {
    chatId: string;
    card: Record<string, unknown>;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ cardId: string }> {
    const envelope = await this.store.enqueue({
      kind: 'lark.card.create',
      target: metadataTarget(
        {
          platform: 'lark',
          chatId: input.chatId,
          rootId: input.rootId,
          replyToMessageId: input.replyToMessageId,
        },
        input.metadata,
      ),
      payload: {
        card: input.card,
        stage: input.metadata?.stage,
      },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      const result = await this.delegate.createCard(input);
      await this.store.markDelivered(envelope.id, result.cardId);
      return result;
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  async updateCard(input: {
    cardId: string;
    card: Record<string, unknown>;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void> {
    const envelope = await this.store.enqueue({
      kind: 'lark.card.update',
      target: metadataTarget(
        {
          platform: 'lark',
          cardId: input.cardId,
        },
        input.metadata,
      ),
      payload: {
        card: input.card,
        stage: input.metadata?.stage,
      },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      await this.delegate.updateCard(input);
      await this.store.markDelivered(envelope.id, input.cardId);
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }
}
