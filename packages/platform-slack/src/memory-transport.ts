import type {
  SlackDeliveryMetadata,
  SlackDownloadedFile,
  SlackFileInput,
  SlackTransport,
} from './types.js';

export class MemorySlackTransport implements SlackTransport {
  readonly texts: Array<{
    messageId: string;
    channelId: string;
    text: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }> = [];
  readonly edits: Array<{
    channelId: string;
    messageId: string;
    text: string;
    metadata?: SlackDeliveryMetadata;
  }> = [];
  readonly files: Array<{
    fileId: string;
    channelId: string;
    file: SlackFileInput;
    comment?: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }> = [];
  readonly resources = new Map<string, SlackDownloadedFile>();
  private nextMessageId = 1;
  private nextFileId = 1;

  async sendText(input: {
    channelId: string;
    text: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const messageId = `${this.nextMessageId++}.000001`;
    this.texts.push({ messageId, ...input });
    return { messageId };
  }

  async editText(input: {
    channelId: string;
    messageId: string;
    text: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<void> {
    this.edits.push(input);
  }

  async sendFile(input: {
    channelId: string;
    file: SlackFileInput;
    comment?: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<{ fileId: string; messageId?: string }> {
    const fileId = `F${this.nextFileId++}`;
    this.files.push({ fileId, ...input });
    return { fileId };
  }

  async downloadFile(input: {
    url: string;
    name?: string;
    mimeType?: string;
    expectedSizeBytes?: number;
    maxBytes?: number;
  }): Promise<SlackDownloadedFile> {
    const resource = this.resources.get(input.url);
    if (!resource) throw new Error('slack_memory_resource_not_found');
    if (input.maxBytes && resource.bytes.byteLength > input.maxBytes) {
      throw new Error('slack_resource_too_large');
    }
    return { ...resource, bytes: new Uint8Array(resource.bytes) };
  }
}
