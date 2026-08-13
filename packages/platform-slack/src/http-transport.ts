import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  SlackDeliveryMetadata,
  SlackDownloadedFile,
  SlackFileInput,
  SlackTransport,
} from './types.js';

export interface HttpSlackTransportOptions {
  botToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxUploadBytes?: number;
}

interface SlackApiEnvelope {
  ok?: boolean;
  error?: string;
  warning?: string;
  ts?: string;
  upload_url?: string;
  file_id?: string;
  files?: Array<{ id?: string; title?: string }>;
}

export class SlackApiError extends Error {
  readonly statusCode?: number;
  readonly code?: string;
  readonly retryAfter?: number;

  constructor(input: {
    message: string;
    statusCode?: number;
    code?: string;
    retryAfter?: number;
  }) {
    super(input.message);
    this.name = 'SlackApiError';
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.retryAfter = input.retryAfter;
  }
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
        throw new SlackApiError({
          statusCode: 413,
          message: `Slack file exceeds the ${maxBytes} byte managed-content limit.`,
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

function validSlackFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'slack.com' ||
        url.hostname.endsWith('.slack.com') ||
        url.hostname.endsWith('.slack-edge.com'))
    );
  } catch {
    return false;
  }
}

export class HttpSlackTransport implements SlackTransport {
  private readonly botToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxUploadBytes: number;

  constructor(options: HttpSlackTransportOptions) {
    this.botToken = options.botToken;
    this.baseUrl = (options.baseUrl || 'https://slack.com/api').replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.maxUploadBytes = Math.max(1, options.maxUploadBytes ?? 30 * 1024 * 1024);
  }

  async sendText(input: {
    channelId: string;
    text: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<{ messageId: string }> {
    const result = await this.request('chat.postMessage', {
      channel: input.channelId,
      text: input.text,
      thread_ts: input.threadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!result.ts) {
      throw new SlackApiError({
        message: 'Slack chat.postMessage response did not include ts.',
      });
    }
    return { messageId: result.ts };
  }

  async editText(input: {
    channelId: string;
    messageId: string;
    text: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<void> {
    await this.request('chat.update', {
      channel: input.channelId,
      ts: input.messageId,
      text: input.text,
    });
  }

  async sendFile(input: {
    channelId: string;
    file: SlackFileInput;
    comment?: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<{ fileId: string; messageId?: string }> {
    const bytes = await readFile(input.file.path);
    if (!bytes.byteLength || bytes.byteLength > this.maxUploadBytes) {
      throw new SlackApiError({
        statusCode: 413,
        message: `Slack upload exceeds the ${this.maxUploadBytes} byte limit.`,
      });
    }
    const filename = input.file.name || path.basename(input.file.path);
    const ticket = await this.request('files.getUploadURLExternal', {
      filename,
      length: bytes.byteLength,
    });
    if (!ticket.upload_url || !ticket.file_id) {
      throw new SlackApiError({
        message: 'Slack upload ticket did not include upload_url and file_id.',
      });
    }
    const upload = await this.fetchImpl(ticket.upload_url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    if (!upload.ok) {
      throw new SlackApiError({
        statusCode: upload.status,
        message: `Slack file upload failed with HTTP ${upload.status}.`,
      });
    }
    const complete = await this.request('files.completeUploadExternal', {
      files: [{ id: ticket.file_id, title: input.file.title || filename }],
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      initial_comment: input.comment,
    });
    return {
      fileId: complete.files?.[0]?.id || ticket.file_id,
      messageId: complete.ts,
    };
  }

  async downloadFile(input: {
    url: string;
    name?: string;
    mimeType?: string;
    expectedSizeBytes?: number;
    maxBytes?: number;
  }): Promise<SlackDownloadedFile> {
    if (!validSlackFileUrl(input.url)) {
      throw new SlackApiError({
        statusCode: 400,
        message: 'Slack attachment URL is not an approved Slack file host.',
      });
    }
    const maxBytes = Math.max(1, input.maxBytes ?? 30 * 1024 * 1024);
    if (input.expectedSizeBytes && input.expectedSizeBytes > maxBytes) {
      throw new SlackApiError({
        statusCode: 413,
        message: `Slack file exceeds the ${maxBytes} byte managed-content limit.`,
      });
    }
    const response = await this.fetchImpl(input.url, {
      headers: { authorization: `Bearer ${this.botToken}` },
    });
    if (!response.ok) {
      throw new SlackApiError({
        statusCode: response.status,
        message: `Slack file download failed with HTTP ${response.status}.`,
      });
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > maxBytes) {
      throw new SlackApiError({
        statusCode: 413,
        message: `Slack file exceeds the ${maxBytes} byte managed-content limit.`,
      });
    }
    const bytes = await boundedResponseBytes(response, maxBytes);
    return {
      bytes,
      name: input.name,
      mimeType: input.mimeType || response.headers.get('content-type') || undefined,
      sizeBytes: bytes.byteLength,
    };
  }

  private async request(
    method: string,
    body: Record<string, unknown>,
  ): Promise<SlackApiEnvelope> {
    const clean = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    );
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(clean),
    });
    const text = await response.text();
    let parsed: SlackApiEnvelope;
    try {
      parsed = (text ? JSON.parse(text) : {}) as SlackApiEnvelope;
    } catch {
      throw new SlackApiError({
        statusCode: response.status,
        message: text || `Slack ${method} returned invalid JSON.`,
      });
    }
    if (!response.ok || parsed.ok !== true) {
      const retryAfter = Number(response.headers.get('retry-after') || 0) || undefined;
      throw new SlackApiError({
        statusCode: response.status,
        code: parsed.error,
        retryAfter,
        message: parsed.error || `Slack ${method} failed with HTTP ${response.status}.`,
      });
    }
    return parsed;
  }
}
