import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { TelegramUpdate } from './types.js';

export interface TelegramCallbackValidationOptions {
  webhookSecret?: string;
}

export type TelegramCallbackValidationResult =
  | { ok: true }
  | {
      ok: false;
      statusCode: number;
      reason: 'invalid_json' | 'invalid_webhook_secret';
    };

export interface ParsedTelegramCallback {
  body: TelegramUpdate & Record<string, unknown>;
  validation: TelegramCallbackValidationResult;
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function secretsEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function parseAndValidateTelegramCallback(
  rawBody: string,
  headers: IncomingHttpHeaders,
  options: TelegramCallbackValidationOptions = {},
): ParsedTelegramCallback {
  let body: TelegramUpdate & Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}') as TelegramUpdate & Record<string, unknown>;
  } catch {
    return {
      body: {},
      validation: { ok: false, statusCode: 400, reason: 'invalid_json' },
    };
  }

  if (options.webhookSecret) {
    const received = headerValue(
      headers,
      'x-telegram-bot-api-secret-token',
    );
    if (!received || !secretsEqual(received, options.webhookSecret)) {
      return {
        body,
        validation: {
          ok: false,
          statusCode: 401,
          reason: 'invalid_webhook_secret',
        },
      };
    }
  }

  return { body, validation: { ok: true } };
}

export function telegramCallbackExternalId(
  body: TelegramUpdate & Record<string, unknown>,
): string {
  if (typeof body.update_id === 'number') return `update:${body.update_id}`;
  const message =
    body.message ||
    body.edited_message ||
    body.channel_post ||
    body.edited_channel_post;
  if (message) return `message:${message.chat.id}:${message.message_id}`;
  return `anonymous:${Date.now()}`;
}

export function telegramCallbackEventType(
  body: TelegramUpdate & Record<string, unknown>,
): string {
  if (body.message) return 'message';
  if (body.edited_message) return 'edited_message';
  if (body.channel_post) return 'channel_post';
  if (body.edited_channel_post) return 'edited_channel_post';
  return 'unknown';
}
