import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  LarkDeliveryMetadata,
  LarkDownloadedResource,
  LarkFileInput,
  LarkTransport,
} from './types.js';

export type LarkOpenApiDomain = 'feishu' | 'lark';

export interface HttpLarkTransportOptions {
  appId: string;
  appSecret: string;
  domain?: LarkOpenApiDomain;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface LarkApiEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
  tenant_access_token?: string;
  expire?: number;
}

interface LarkMessageData {
  message_id?: string;
}

interface LarkFileData {
  file_key?: string;
}

interface LarkImageData {
  image_key?: string;
}

interface TenantTokenCache {
  token: string;
  expiresAt: number;
}

function baseUrlFor(input: {
  baseUrl?: string;
  domain?: LarkOpenApiDomain;
}): string {
  if (input.baseUrl) return input.baseUrl.replace(/\/+$/u, '');
  return input.domain === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

type LarkMessageType = 'text' | 'interactive' | 'file' | 'image';

function contentFor(msgType: LarkMessageType, value: unknown): string {
  if (msgType === 'text') return JSON.stringify({ text: String(value) });
  return JSON.stringify(value);
}

function uuidFor(
  metadata: LarkDeliveryMetadata | undefined,
  kind: 'text' | 'card' | 'artifact',
): string | undefined {
  if (!metadata?.runId) return undefined;
  return createHash('sha256')
    .update(
      `${metadata.runId}:${kind}:${metadata.stage ?? 'message'}:${metadata.artifactId ?? ''}`,
    )
    .digest('hex')
    .slice(0, 50);
}

function larkFileType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return (
    {
      '.doc': 'doc',
      '.docx': 'doc',
      '.mp4': 'mp4',
      '.opus': 'opus',
      '.pdf': 'pdf',
      '.ppt': 'ppt',
      '.pptx': 'ppt',
      '.xls': 'xls',
      '.xlsx': 'xls',
    } as Record<string, string>
  )[extension] || 'stream';
}

function supportsNativeImage(filename: string, mimeType?: string): boolean {
  const extension = path.extname(filename).toLowerCase();
  return (
    Boolean(mimeType?.startsWith('image/')) &&
    ['.bmp', '.gif', '.heic', '.ico', '.jpeg', '.jpg', '.png', '.tiff', '.webp'].includes(
      extension,
    )
  );
}

function responseFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return /filename="?([^";]+)"?/iu.exec(value)?.[1];
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
        throw new LarkApiError({
          statusCode: 413,
          message: `Lark resource exceeds the ${maxBytes} byte managed-content limit.`,
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

export class LarkApiError extends Error {
  readonly statusCode?: number;
  readonly code?: number;
  readonly requestId?: string;

  constructor(input: {
    message: string;
    statusCode?: number;
    code?: number;
    requestId?: string;
  }) {
    super(input.message);
    this.name = 'LarkApiError';
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.requestId = input.requestId;
  }
}

export class HttpLarkTransport implements LarkTransport {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private tokenCache?: TenantTokenCache;

  constructor(options: HttpLarkTransportOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = baseUrlFor(options);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async openApiRequest<T>(
    pathname: string,
    options: {
      method: 'GET' | 'POST';
      query?: Record<string, string | number | boolean | undefined>;
      body?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    if (!pathname.startsWith('/open-apis/') || pathname.includes('://')) {
      throw new LarkApiError({ message: 'Invalid Lark OpenAPI pathname.' });
    }
    return this.rawRequest<T>(pathname, {
      ...options,
      authenticated: true,
    });
  }

  async sendText(input: {
    chatId: string;
    text: string;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void> {
    await this.sendMessage({
      chatId: input.chatId,
      msgType: 'text',
      content: input.text,
      rootId: input.rootId,
      replyToMessageId: input.replyToMessageId,
      uuid: uuidFor(input.metadata, 'text'),
    });
  }

  async createCard(input: {
    chatId: string;
    card: Record<string, unknown>;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ cardId: string }> {
    const data = await this.sendMessage({
      chatId: input.chatId,
      msgType: 'interactive',
      content: input.card,
      rootId: input.rootId,
      replyToMessageId: input.replyToMessageId,
      uuid: uuidFor(input.metadata, 'card'),
    });
    if (!data.message_id) {
      throw new LarkApiError({
        message: 'Lark create card response did not include message_id.',
      });
    }
    return { cardId: data.message_id };
  }

  async updateCard(input: {
    cardId: string;
    card: Record<string, unknown>;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void> {
    await this.request<LarkMessageData>(
      `/open-apis/im/v1/messages/${encodeURIComponent(input.cardId)}`,
      {
        method: 'PATCH',
        body: {
          content: contentFor('interactive', input.card),
        },
      },
    );
  }

  async sendFile(input: {
    chatId: string;
    file: LarkFileInput;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const bytes = await readFile(input.file.path);
    if (!bytes.byteLength) throw new LarkApiError({ message: 'Lark file cannot be empty.' });
    if (bytes.byteLength > 30 * 1024 * 1024) {
      throw new LarkApiError({ message: 'Lark file exceeds the 30 MB upload limit.' });
    }
    const filename = input.file.name || path.basename(input.file.path);
    let msgType: 'file' | 'image';
    let content: Record<string, string>;
    if (
      bytes.byteLength <= 10 * 1024 * 1024 &&
      supportsNativeImage(filename, input.file.mimeType)
    ) {
      const form = new FormData();
      form.set('image_type', 'message');
      form.set(
        'image',
        new Blob([new Uint8Array(bytes)], {
          type: input.file.mimeType || 'application/octet-stream',
        }),
        filename,
      );
      const uploaded = await this.multipartRequest<LarkImageData>(
        '/open-apis/im/v1/images',
        form,
      );
      if (!uploaded.image_key) {
        throw new LarkApiError({ message: 'Lark image upload response did not include image_key.' });
      }
      msgType = 'image';
      content = { image_key: uploaded.image_key };
    } else {
      const form = new FormData();
      form.set('file_type', larkFileType(filename));
      form.set('file_name', filename);
      form.set(
        'file',
        new Blob([new Uint8Array(bytes)], {
          type: input.file.mimeType || 'application/octet-stream',
        }),
        filename,
      );
      const uploaded = await this.multipartRequest<LarkFileData>(
        '/open-apis/im/v1/files',
        form,
      );
      if (!uploaded.file_key) {
        throw new LarkApiError({ message: 'Lark file upload response did not include file_key.' });
      }
      msgType = 'file';
      content = { file_key: uploaded.file_key };
    }

    const message = await this.sendMessage({
      chatId: input.chatId,
      msgType,
      content,
      rootId: input.rootId,
      replyToMessageId: input.replyToMessageId,
      uuid: uuidFor(input.metadata, 'artifact'),
    });
    if (!message.message_id) {
      throw new LarkApiError({ message: 'Lark file message response did not include message_id.' });
    }
    return { messageId: message.message_id };
  }

  async downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    type: 'file' | 'image';
    maxBytes?: number;
  }): Promise<LarkDownloadedResource> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(
        input.messageId,
      )}/resources/${encodeURIComponent(input.fileKey)}?type=${input.type}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${await this.tenantAccessToken()}` },
      },
    );
    const requestId =
      response.headers.get('x-request-id') ||
      response.headers.get('x-tt-logid') ||
      undefined;
    if (!response.ok) {
      const body = await response.text();
      let envelope: LarkApiEnvelope<unknown> | undefined;
      try {
        envelope = body ? (JSON.parse(body) as LarkApiEnvelope<unknown>) : undefined;
      } catch {
        envelope = undefined;
      }
      throw new LarkApiError({
        statusCode: response.status,
        code: envelope?.code,
        requestId,
        message: envelope?.msg || body || `Lark resource download failed with HTTP ${response.status}.`,
      });
    }
    const maxBytes = Math.max(1, input.maxBytes ?? 30 * 1024 * 1024);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > maxBytes) {
      throw new LarkApiError({
        statusCode: 413,
        requestId,
        message: `Lark resource exceeds the ${maxBytes} byte managed-content limit.`,
      });
    }
    const bytes = await boundedResponseBytes(response, maxBytes);
    return {
      bytes,
      name: responseFilename(response.headers.get('content-disposition')),
      mimeType: response.headers.get('content-type') || undefined,
    };
  }

  private async sendMessage(input: {
    chatId: string;
    msgType: LarkMessageType;
    content: unknown;
    rootId?: string;
    replyToMessageId?: string;
    uuid?: string;
  }): Promise<LarkMessageData> {
    const messageId = input.replyToMessageId ?? input.rootId;
    if (messageId) {
      return this.request<LarkMessageData>(
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
        {
          method: 'POST',
          body: {
            msg_type: input.msgType,
            content: contentFor(input.msgType, input.content),
            reply_in_thread: true,
            uuid: input.uuid,
          },
        },
      );
    }

    return this.request<LarkMessageData>(
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        body: {
          receive_id: input.chatId,
          msg_type: input.msgType,
          content: contentFor(input.msgType, input.content),
          uuid: input.uuid,
        },
      },
    );
  }

  private async tenantAccessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.tokenCache && this.tokenCache.expiresAt > nowMs) {
      return this.tokenCache.token;
    }
    const result = await this.rawRequest<{
      tenant_access_token?: string;
      expire?: number;
    }>('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      authenticated: false,
      body: {
        app_id: this.appId,
        app_secret: this.appSecret,
      },
    });
    const token = result.tenant_access_token;
    if (!token) {
      throw new LarkApiError({
        message: 'Lark token response did not include tenant_access_token.',
      });
    }
    const expireSeconds = Math.max(60, result.expire ?? 7200);
    this.tokenCache = {
      token,
      expiresAt: nowMs + (expireSeconds - 60) * 1000,
    };
    return token;
  }

  private async request<T>(
    pathname: string,
    options: {
      method: string;
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    return this.rawRequest<T>(pathname, {
      ...options,
      authenticated: true,
    });
  }

  private async multipartRequest<T>(pathname: string, form: FormData): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.tenantAccessToken()}` },
      body: form,
    });
    return this.parseJsonResponse<T>(response);
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    const requestId =
      response.headers.get('x-request-id') ||
      response.headers.get('x-tt-logid') ||
      undefined;
    const value = await response.text();
    let parsed: LarkApiEnvelope<T>;
    try {
      parsed = (value ? JSON.parse(value) : {}) as LarkApiEnvelope<T>;
    } catch {
      throw new LarkApiError({
        statusCode: response.status,
        requestId,
        message:
          value || `Lark API request returned invalid JSON with HTTP ${response.status}.`,
      });
    }
    if (!response.ok || parsed.code !== 0) {
      throw new LarkApiError({
        statusCode: response.status,
        code: parsed.code,
        requestId,
        message: parsed.msg || `Lark API request failed with HTTP ${response.status}.`,
      });
    }
    return (parsed.data ?? parsed) as T;
  }

  private async rawRequest<T>(
    pathname: string,
    options: {
      method: string;
      authenticated: boolean;
      query?: Record<string, string | number | boolean | undefined>;
      body?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
    };
    if (options.authenticated) {
      headers.authorization = `Bearer ${await this.tenantAccessToken()}`;
    }

    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.fetchImpl(url.toString(), {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    return this.parseJsonResponse<T>(response);
  }
}
