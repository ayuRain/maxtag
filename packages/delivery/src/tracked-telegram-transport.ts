import type {
  TelegramDeliveryMetadata,
  TelegramDocumentInput,
  TelegramDownloadedFile,
  TelegramTransport,
} from '@opentag/platform-telegram';
import type { DeliveryStore } from './file-delivery-store.js';
import type { OutboundTarget } from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function target(
  base: Omit<OutboundTarget, 'platform'>,
  metadata?: TelegramDeliveryMetadata,
): OutboundTarget {
  return {
    platform: 'telegram',
    ...base,
    chatId: base.chatId || metadata?.thread?.channelId,
    topicId: base.topicId || metadata?.thread?.topicId,
  };
}

export class TrackedTelegramTransport implements TelegramTransport {
  constructor(
    private readonly delegate: TelegramTransport,
    private readonly store: DeliveryStore,
  ) {}

  async sendText(input: {
    chatId: string;
    text: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const envelope = await this.store.enqueue({
      kind:
        input.metadata?.stage === 'progress'
          ? 'telegram.progress.create'
          : 'telegram.text',
      target: target(
        {
          chatId: input.chatId,
          topicId: input.messageThreadId,
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
      const result = await this.delegate.sendText(input);
      await this.store.markDelivered(envelope.id, result.messageId);
      return result;
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  async editText(input: {
    chatId: string;
    messageId: string;
    text: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<void> {
    const envelope = await this.store.enqueue({
      kind: 'telegram.progress.update',
      target: target(
        { chatId: input.chatId, cardId: input.messageId },
        input.metadata,
      ),
      payload: { text: input.text, stage: input.metadata?.stage },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      await this.delegate.editText(input);
      await this.store.markDelivered(envelope.id, input.messageId);
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  async sendDocument(input: {
    chatId: string;
    document: TelegramDocumentInput;
    caption?: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const envelope = await this.store.enqueue({
      kind: 'telegram.document',
      target: target(
        {
          chatId: input.chatId,
          topicId: input.messageThreadId,
          replyToMessageId: input.replyToMessageId,
        },
        input.metadata,
      ),
      payload: {
        document: input.document,
        caption: input.caption,
        stage: input.metadata?.stage,
      },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      const result = await this.delegate.sendDocument(input);
      await this.store.markDelivered(envelope.id, result.messageId);
      return result;
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  downloadFile(input: {
    fileId: string;
    maxBytes?: number;
  }): Promise<TelegramDownloadedFile> {
    return this.delegate.downloadFile(input);
  }
}
