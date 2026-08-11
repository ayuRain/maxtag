import type { IncomingHttpHeaders } from 'node:http';
import type { LarkIncomingEvent } from './types.js';

export interface LarkCallbackValidationOptions {
  verificationToken?: string;
  maxTimestampSkewSeconds?: number;
  now?: Date;
}

export type LarkCallbackValidationResult =
  | { ok: true }
  | {
      ok: false;
      statusCode: number;
      reason:
        | 'invalid_json'
        | 'invalid_verification_token'
        | 'stale_request'
        | 'encrypted_event_unsupported';
    };

export interface ParsedLarkCallback {
  body: LarkIncomingEvent & Record<string, unknown>;
  validation: LarkCallbackValidationResult;
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function hasEncryptedPayload(body: Record<string, unknown>): boolean {
  return typeof body.encrypt === 'string';
}

function validateTimestamp(
  headers: IncomingHttpHeaders,
  options: LarkCallbackValidationOptions,
): LarkCallbackValidationResult {
  if (!options.maxTimestampSkewSeconds) return { ok: true };
  const raw = headerValue(headers, 'x-lark-request-timestamp');
  if (!raw) return { ok: true };
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    return { ok: false, statusCode: 401, reason: 'stale_request' };
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - seconds) > options.maxTimestampSkewSeconds) {
    return { ok: false, statusCode: 401, reason: 'stale_request' };
  }
  return { ok: true };
}

function validateVerificationToken(
  body: Record<string, unknown>,
  options: LarkCallbackValidationOptions,
): LarkCallbackValidationResult {
  if (!options.verificationToken) return { ok: true };
  if (body.token !== options.verificationToken) {
    return {
      ok: false,
      statusCode: 401,
      reason: 'invalid_verification_token',
    };
  }
  return { ok: true };
}

export function parseAndValidateLarkCallback(
  rawBody: string,
  headers: IncomingHttpHeaders,
  options: LarkCallbackValidationOptions = {},
): ParsedLarkCallback {
  let body: LarkIncomingEvent & Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}') as LarkIncomingEvent & Record<string, unknown>;
  } catch {
    return {
      body: {},
      validation: { ok: false, statusCode: 400, reason: 'invalid_json' },
    };
  }

  if (hasEncryptedPayload(body)) {
    return {
      body,
      validation: {
        ok: false,
        statusCode: 400,
        reason: 'encrypted_event_unsupported',
      },
    };
  }

  const token = validateVerificationToken(body, options);
  if (!token.ok) return { body, validation: token };

  const timestamp = validateTimestamp(headers, options);
  if (!timestamp.ok) return { body, validation: timestamp };

  return { body, validation: { ok: true } };
}

export function larkCallbackExternalId(
  body: LarkIncomingEvent & Record<string, unknown>,
): string {
  if (typeof body.event_id === 'string' && body.event_id) return body.event_id;
  if (typeof body.uuid === 'string' && body.uuid) return body.uuid;
  const messageId = body.event?.message?.message_id;
  if (messageId) return `message:${messageId}`;
  const challenge = typeof body.challenge === 'string' ? body.challenge : '';
  if (challenge) return `challenge:${challenge}`;
  return `anonymous:${Date.now()}`;
}

export function larkCallbackEventType(
  body: LarkIncomingEvent & Record<string, unknown>,
): string {
  if (typeof body.type === 'string') return body.type;
  if (typeof body.header === 'object' && body.header && 'event_type' in body.header) {
    const eventType = (body.header as { event_type?: unknown }).event_type;
    if (typeof eventType === 'string') return eventType;
  }
  return body.event?.message?.message_type ?? 'unknown';
}
