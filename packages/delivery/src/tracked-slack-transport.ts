import type {
  SlackDeliveryMetadata,
  SlackDownloadedFile,
  SlackFileInput,
  SlackTransport,
} from '@opentag/platform-slack';
import type { DeliveryStore } from './file-delivery-store.js';
import type { OutboundTarget } from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function target(
  base: Omit<OutboundTarget, 'platform'>,
  metadata?: SlackDeliveryMetadata,
): OutboundTarget {
  return {
    platform: 'slack',
    ...base,
    chatId: base.chatId || metadata?.thread?.channelId,
    topicId:
      base.topicId ||
      metadata?.thread?.rootMessageId ||
      metadata?.thread?.topicId,
  };
}

export class TrackedSlackTransport implements SlackTransport {
  constructor(
    private readonly delegate: SlackTransport,
    private readonly store: DeliveryStore,
  ) {}

  async sendText(input: {
    channelId: string;
    text: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const envelope = await this.store.enqueue({
      kind:
        input.metadata?.stage === 'progress'
          ? 'slack.progress.create'
          : 'slack.text',
      target: target(
        { chatId: input.channelId, topicId: input.threadTs },
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
    channelId: string;
    messageId: string;
    text: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<void> {
    const envelope = await this.store.enqueue({
      kind: 'slack.progress.update',
      target: target(
        { chatId: input.channelId, cardId: input.messageId },
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

  async sendFile(input: {
    channelId: string;
    file: SlackFileInput;
    comment?: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<{ fileId: string; messageId?: string }> {
    const envelope = await this.store.enqueue({
      kind: 'slack.file',
      target: target(
        { chatId: input.channelId, topicId: input.threadTs },
        input.metadata,
      ),
      payload: {
        file: input.file,
        comment: input.comment,
        stage: input.metadata?.stage,
      },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      const result = await this.delegate.sendFile(input);
      await this.store.markDelivered(
        envelope.id,
        result.messageId || result.fileId,
      );
      return result;
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  downloadFile(input: {
    url: string;
    name?: string;
    mimeType?: string;
    expectedSizeBytes?: number;
    maxBytes?: number;
  }): Promise<SlackDownloadedFile> {
    return this.delegate.downloadFile(input);
  }
}
