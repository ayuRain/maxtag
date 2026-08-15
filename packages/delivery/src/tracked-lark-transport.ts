import type {
  LarkDeliveryMetadata,
  LarkChatInfo,
  LarkDownloadedResource,
  LarkFileInput,
  LarkHistoryMessage,
  LarkListMessagesInput,
  LarkMessagePage,
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

  getChat(
    chatId: string,
    options?: { signal?: AbortSignal },
  ): Promise<LarkChatInfo | undefined> {
    return this.delegate.getChat(chatId, options);
  }

  getMessage(messageId: string): Promise<LarkHistoryMessage | undefined> {
    return this.delegate.getMessage(messageId);
  }

  listMessages(input: LarkListMessagesInput): Promise<LarkMessagePage> {
    return this.delegate.listMessages(input);
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
        notificationId: input.metadata?.notificationId,
      },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
      maxAttempts:
        input.metadata?.stage === 'routine-notification' ? 1 : undefined,
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
        proposalId: input.metadata?.proposalId,
        approvalId: input.metadata?.approvalId,
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
        proposalId: input.metadata?.proposalId,
        approvalId: input.metadata?.approvalId,
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

  async deleteCard(input: {
    cardId: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void> {
    if (!this.delegate.deleteCard) return;
    const envelope = await this.store.enqueue({
      kind: 'lark.card.delete',
      target: metadataTarget(
        { platform: 'lark', cardId: input.cardId },
        input.metadata,
      ),
      payload: { stage: input.metadata?.stage },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      await this.delegate.deleteCard(input);
      await this.store.markDelivered(envelope.id, input.cardId);
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  async sendFile(input: {
    chatId: string;
    file: LarkFileInput;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ messageId: string; messageType: 'file' | 'image' }> {
    const envelope = await this.store.enqueue({
      kind: 'lark.file',
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
        file: input.file,
        stage: input.metadata?.stage,
        artifactId: input.metadata?.artifactId,
      },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      const result = await this.delegate.sendFile(input);
      await this.store.markDelivered(envelope.id, result.messageId);
      return result;
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    type: 'file' | 'image';
    maxBytes?: number;
  }): Promise<LarkDownloadedResource> {
    return this.delegate.downloadMessageResource(input);
  }
}
