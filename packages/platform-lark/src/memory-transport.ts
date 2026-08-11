import type {
  LarkDeliveryMetadata,
  LarkDownloadedResource,
  LarkFileInput,
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

  async sendFile(input: {
    chatId: string;
    file: LarkFileInput;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const messageId = `file_${this.files.length + 1}`;
    this.files.push({ messageId, ...input });
    return { messageId };
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
