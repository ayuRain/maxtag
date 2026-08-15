import type {
  LarkDeliveryMetadata,
  LarkChatInfo,
  LarkDownloadedResource,
  LarkFileInput,
  LarkHistoryMessage,
  LarkListMessagesInput,
  LarkMessagePage,
  LarkTransport,
} from './types.js';

export class MemoryLarkTransport implements LarkTransport {
  readonly texts: Array<Record<string, unknown>> = [];
  readonly cards: Array<{ id: string; card: Record<string, unknown> }> = [];
  readonly files: Array<{
    messageId: string;
    chatId: string;
    file: LarkFileInput;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }> = [];
  readonly resources = new Map<string, LarkDownloadedResource>();
  readonly historyMessages: LarkHistoryMessage[] = [];
  readonly chats = new Map<string, LarkChatInfo>();

  async readiness(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async getChat(chatId: string): Promise<LarkChatInfo | undefined> {
    const chat = this.chats.get(chatId);
    return chat ? structuredClone(chat) : undefined;
  }

  async getMessage(messageId: string): Promise<LarkHistoryMessage | undefined> {
    const message = this.historyMessages.find(
      (item) => item.message_id === messageId,
    );
    return message ? structuredClone(message) : undefined;
  }

  async listMessages(input: LarkListMessagesInput): Promise<LarkMessagePage> {
    const ascending = (input.sortType ?? 'ByCreateTimeAsc') === 'ByCreateTimeAsc';
    const startMs = input.startTime ? Number(input.startTime) * 1000 : undefined;
    const endMs = input.endTime ? Number(input.endTime) * 1000 : undefined;
    const matching = this.historyMessages
      .filter((message) =>
        input.containerType === 'thread'
          ? message.thread_id === input.containerId
          : message.chat_id === input.containerId,
      )
      .filter((message) => {
        if (input.containerType === 'thread') return true;
        const raw = Number(message.create_time);
        const createdMs = raw < 10_000_000_000 ? raw * 1000 : raw;
        return (
          Number.isFinite(createdMs) &&
          (startMs === undefined || createdMs >= startMs) &&
          (endMs === undefined || createdMs <= endMs)
        );
      })
      .sort((left, right) =>
        String(left.create_time || '').localeCompare(String(right.create_time || '')),
      );
    if (!ascending) matching.reverse();
    const offset = Math.max(0, Number(input.pageToken || 0) || 0);
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 50, 50));
    const items = matching.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      items: structuredClone(items),
      hasMore: nextOffset < matching.length,
      pageToken: nextOffset < matching.length ? String(nextOffset) : undefined,
    };
  }

  async sendText(input: {
    chatId: string;
    text: string;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void> {
    this.texts.push(input);
  }

  async createCard(input: {
    chatId: string;
    card: Record<string, unknown>;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ cardId: string }> {
    const id = `card_${this.cards.length + 1}`;
    this.cards.push({ id, card: input.card });
    return { cardId: id };
  }

  async updateCard(input: {
    cardId: string;
    card: Record<string, unknown>;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void> {
    const existing = this.cards.find((card) => card.id === input.cardId);
    if (existing) {
      existing.card = input.card;
      return;
    }
    this.cards.push({ id: input.cardId, card: input.card });
  }

  async deleteCard(input: {
    cardId: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void> {
    const index = this.cards.findIndex((card) => card.id === input.cardId);
    if (index !== -1) this.cards.splice(index, 1);
  }

  async sendFile(input: {
    chatId: string;
    file: LarkFileInput;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ messageId: string; messageType: 'file' | 'image' }> {
    const messageId = `file_${this.files.length + 1}`;
    this.files.push({ messageId, ...input });
    return {
      messageId,
      messageType: input.file.mimeType?.startsWith('image/') ? 'image' : 'file',
    };
  }

  async downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    type: 'file' | 'image';
    maxBytes?: number;
  }): Promise<LarkDownloadedResource> {
    const resource = this.resources.get(`${input.messageId}:${input.fileKey}:${input.type}`);
    if (!resource) throw new Error('lark_memory_resource_not_found');
    if (input.maxBytes && resource.bytes.byteLength > input.maxBytes) {
      throw new Error('lark_resource_too_large');
    }
    return { ...resource, bytes: new Uint8Array(resource.bytes) };
  }
}
