import { createHash } from 'node:crypto';
import type { LarkDeliveryMetadata, LarkTransport } from './types.js';

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

function contentFor(msgType: 'text' | 'interactive', value: unknown): string {
  if (msgType === 'text') return JSON.stringify({ text: String(value) });
  return JSON.stringify(value);
}

function uuidFor(
  metadata: LarkDeliveryMetadata | undefined,
  kind: 'text' | 'card',
): string | undefined {
  if (!metadata?.runId) return undefined;
  return createHash('sha256')
    .update(`${metadata.runId}:${kind}:${metadata.stage ?? 'message'}`)
    .digest('hex')
    .slice(0, 50);
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

  private async sendMessage(input: {
    chatId: string;
    msgType: 'text' | 'interactive';
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

  private async rawRequest<T>(
    pathname: string,
    options: {
      method: string;
      authenticated: boolean;
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
    };
    if (options.authenticated) {
      headers.authorization = `Bearer ${await this.tenantAccessToken()}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const requestId = response.headers.get('x-request-id') ?? undefined;
    const text = await response.text();
    let parsed: LarkApiEnvelope<T>;
    try {
      parsed = (text ? JSON.parse(text) : {}) as LarkApiEnvelope<T>;
    } catch {
      throw new LarkApiError({
        statusCode: response.status,
        requestId,
        message:
          text ||
          `Lark API request returned invalid JSON with HTTP ${response.status}.`,
      });
    }
    if (!response.ok || parsed.code !== 0) {
      throw new LarkApiError({
        statusCode: response.status,
        code: parsed.code,
        requestId,
        message:
          parsed.msg ||
          `Lark API request failed with HTTP ${response.status}.`,
      });
    }
    return (parsed.data ?? parsed) as T;
  }
}
