import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  TelegramDeliveryMetadata,
  TelegramDocumentInput,
  TelegramDownloadedFile,
  TelegramTransport,
} from './types.js';

export interface HttpTelegramTransportOptions {
  botToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface TelegramApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

interface TelegramMessageResult {
  message_id?: number;
}

interface TelegramFileResult {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

function numericId(value: string | undefined): number | undefined {
  if (!value || !/^-?\d+$/u.test(value)) return undefined;
  return Number(value);
}

function replyParameters(messageId: string | undefined): Record<string, unknown> | undefined {
  const numeric = numericId(messageId);
  return numeric === undefined
    ? undefined
    : { message_id: numeric, allow_sending_without_reply: true };
}

function messageIdFrom(result: TelegramMessageResult, method: string): string {
  if (typeof result.message_id !== 'number') {
    throw new TelegramApiError({
      message: `Telegram ${method} response did not include message_id.`,
    });
  }
  return String(result.message_id);
}

async function boundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('managed_content_limit_exceeded');
        throw new TelegramApiError({
          statusCode: 413,
          message: `Telegram file exceeds the ${maxBytes} byte managed-content limit.`,
        });
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class TelegramApiError extends Error {
  readonly statusCode?: number;
  readonly code?: number;
  readonly retryAfter?: number;
  readonly migrateToChatId?: number;

  constructor(input: {
    message: string;
    statusCode?: number;
    code?: number;
    retryAfter?: number;
    migrateToChatId?: number;
  }) {
    super(input.message);
    this.name = 'TelegramApiError';
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.retryAfter = input.retryAfter;
    this.migrateToChatId = input.migrateToChatId;
  }
}

export class HttpTelegramTransport implements TelegramTransport {
  private readonly baseUrl: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTelegramTransportOptions) {
    this.botToken = options.botToken;
    this.baseUrl = (options.baseUrl || 'https://api.telegram.org').replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async sendText(input: {
    chatId: string;
    text: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const result = await this.request<TelegramMessageResult>('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      message_thread_id: numericId(input.messageThreadId),
      reply_parameters: replyParameters(input.replyToMessageId),
      link_preview_options: { is_disabled: true },
    });
    return { messageId: messageIdFrom(result, 'sendMessage') };
  }

  async editText(input: {
    chatId: string;
    messageId: string;
    text: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<void> {
    await this.request<TelegramMessageResult>('editMessageText', {
      chat_id: input.chatId,
      message_id: numericId(input.messageId),
      text: input.text,
      link_preview_options: { is_disabled: true },
    });
  }

  async sendDocument(input: {
    chatId: string;
    document: TelegramDocumentInput;
    caption?: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    if (input.document.path) return this.sendLocalDocument(input);
    if (!input.document.url) {
      throw new Error('Telegram document requires a path or URL.');
    }
    const result = await this.request<TelegramMessageResult>('sendDocument', {
      chat_id: input.chatId,
      document: input.document.url,
      caption: input.caption,
      message_thread_id: numericId(input.messageThreadId),
      reply_parameters: replyParameters(input.replyToMessageId),
    });
    return { messageId: messageIdFrom(result, 'sendDocument') };
  }

  async downloadFile(input: {
    fileId: string;
    maxBytes?: number;
  }): Promise<TelegramDownloadedFile> {
    const file = await this.request<TelegramFileResult>('getFile', {
      file_id: input.fileId,
    });
    if (!file.file_path) {
      throw new TelegramApiError({
        message: 'Telegram getFile response did not include file_path.',
      });
    }
    const maxBytes = Math.max(1, input.maxBytes ?? 30 * 1024 * 1024);
    if (file.file_size && file.file_size > maxBytes) {
      throw new TelegramApiError({
        statusCode: 413,
        message: `Telegram file exceeds the ${maxBytes} byte managed-content limit.`,
      });
    }
    const response = await this.fetchImpl(
      `${this.baseUrl}/file/bot${this.botToken}/${file.file_path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`,
    );
    if (!response.ok) {
      throw new TelegramApiError({
        statusCode: response.status,
        message: `Telegram file download failed with HTTP ${response.status}.`,
      });
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > maxBytes) {
      throw new TelegramApiError({
        statusCode: 413,
        message: `Telegram file exceeds the ${maxBytes} byte managed-content limit.`,
      });
    }
    const bytes = await boundedResponseBytes(response, maxBytes);
    return {
      bytes,
      name: path.basename(file.file_path),
      sizeBytes: bytes.byteLength,
    };
  }

  private async sendLocalDocument(input: {
    chatId: string;
    document: TelegramDocumentInput & { path?: string };
    caption?: string;
    messageThreadId?: string;
    replyToMessageId?: string;
  }): Promise<{ messageId: string }> {
    const localPath = input.document.path;
    if (!localPath) throw new Error('Telegram document path is required.');
    const bytes = await readFile(localPath);
    const form = new FormData();
    form.set('chat_id', input.chatId);
    form.set(
      'document',
      new Blob([new Uint8Array(bytes)]),
      input.document.name || path.basename(localPath),
    );
    if (input.caption) form.set('caption', input.caption);
    const topicId = numericId(input.messageThreadId);
    if (topicId !== undefined) form.set('message_thread_id', String(topicId));
    const reply = replyParameters(input.replyToMessageId);
    if (reply) form.set('reply_parameters', JSON.stringify(reply));
    const result = await this.rawRequest<TelegramMessageResult>('sendDocument', form);
    return { messageId: messageIdFrom(result, 'sendDocument') };
  }

  private request<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const clean = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    );
    return this.rawRequest<T>(method, JSON.stringify(clean), {
      'content-type': 'application/json; charset=utf-8',
    });
  }

  private async rawRequest<T>(
    method: string,
    body: BodyInit,
    headers?: Record<string, string>,
  ): Promise<T> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/bot${this.botToken}/${method}`,
      { method: 'POST', headers, body },
    );
    const text = await response.text();
    let parsed: TelegramApiEnvelope<T>;
    try {
      parsed = (text ? JSON.parse(text) : {}) as TelegramApiEnvelope<T>;
    } catch {
      throw new TelegramApiError({
        statusCode: response.status,
        message:
          text ||
          `Telegram ${method} returned invalid JSON with HTTP ${response.status}.`,
      });
    }
    if (!response.ok || parsed.ok !== true || parsed.result === undefined) {
      throw new TelegramApiError({
        statusCode: response.status,
        code: parsed.error_code,
        retryAfter: parsed.parameters?.retry_after,
        migrateToChatId: parsed.parameters?.migrate_to_chat_id,
        message:
          parsed.description ||
          `Telegram ${method} failed with HTTP ${response.status}.`,
      });
    }
    return parsed.result;
  }
}
