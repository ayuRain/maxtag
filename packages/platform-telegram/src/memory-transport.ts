import type {
  TelegramDeliveryMetadata,
  TelegramDocumentInput,
  TelegramDownloadedFile,
  TelegramTransport,
} from './types.js';

export class MemoryTelegramTransport implements TelegramTransport {
  readonly texts: Array<{
    messageId: string;
    chatId: string;
    text: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }> = [];
  readonly edits: Array<{
    chatId: string;
    messageId: string;
    text: string;
    metadata?: TelegramDeliveryMetadata;
  }> = [];
  readonly documents: Array<{
    messageId: string;
    chatId: string;
    document: TelegramDocumentInput;
    caption?: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }> = [];
  private nextMessageId = 1;
  readonly resources = new Map<string, TelegramDownloadedFile>();

  async sendText(input: {
    chatId: string;
    text: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const messageId = String(this.nextMessageId++);
    this.texts.push({ messageId, ...input });
    return { messageId };
  }

  async editText(input: {
    chatId: string;
    messageId: string;
    text: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<void> {
    this.edits.push(input);
  }

  async sendDocument(input: {
    chatId: string;
    document: TelegramDocumentInput;
    caption?: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const messageId = String(this.nextMessageId++);
    this.documents.push({ messageId, ...input });
    return { messageId };
  }

  async downloadFile(input: {
    fileId: string;
    maxBytes?: number;
  }): Promise<TelegramDownloadedFile> {
    const resource = this.resources.get(input.fileId);
    if (!resource) throw new Error('telegram_memory_resource_not_found');
    if (input.maxBytes && resource.bytes.byteLength > input.maxBytes) {
      throw new Error('telegram_resource_too_large');
    }
    return { ...resource, bytes: new Uint8Array(resource.bytes) };
  }
}
