import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { SlackEventEnvelope } from './types.js';

export interface SlackCallbackValidationOptions {
  signingSecret?: string;
  maxSkewSeconds?: number;
  now?: () => number;
}

export type SlackCallbackValidationResult =
  | { ok: true }
  | {
      ok: false;
      statusCode: number;
      reason:
        | 'invalid_json'
        | 'signing_secret_not_configured'
        | 'missing_signature'
        | 'invalid_timestamp'
        | 'stale_request'
        | 'invalid_signature';
    };

export interface ParsedSlackCallback {
  body: SlackEventEnvelope & Record<string, unknown>;
  validation: SlackCallbackValidationResult;
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function slackRequestSignature(input: {
  signingSecret: string;
  timestamp: string | number;
  rawBody: string;
}): string {
  return `v0=${createHmac('sha256', input.signingSecret)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest('hex')}`;
}

export function parseAndValidateSlackCallback(
  rawBody: string,
  headers: IncomingHttpHeaders,
  options: SlackCallbackValidationOptions = {},
): ParsedSlackCallback {
  let body: SlackEventEnvelope & Record<string, unknown> = {};
  let validJson = true;
  try {
    body = JSON.parse(rawBody || '{}') as SlackEventEnvelope &
      Record<string, unknown>;
  } catch {
    validJson = false;
  }

  if (!options.signingSecret) {
    return {
      body,
      validation: {
        ok: false,
        statusCode: 503,
        reason: 'signing_secret_not_configured',
      },
    };
  }
  const received = headerValue(headers, 'x-slack-signature');
  const timestamp = headerValue(headers, 'x-slack-request-timestamp');
  if (!received || !timestamp) {
    return {
      body,
      validation: { ok: false, statusCode: 401, reason: 'missing_signature' },
    };
  }
  if (!/^\d+$/u.test(timestamp)) {
    return {
      body,
      validation: { ok: false, statusCode: 401, reason: 'invalid_timestamp' },
    };
  }
  const maxSkewSeconds = Math.max(0, options.maxSkewSeconds ?? 300);
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (
    maxSkewSeconds > 0 &&
    Math.abs(nowSeconds - Number(timestamp)) > maxSkewSeconds
  ) {
    return {
      body,
      validation: { ok: false, statusCode: 401, reason: 'stale_request' },
    };
  }
  const expected = slackRequestSignature({
    signingSecret: options.signingSecret,
    timestamp,
    rawBody,
  });
  if (!signaturesEqual(expected, received)) {
    return {
      body,
      validation: { ok: false, statusCode: 401, reason: 'invalid_signature' },
    };
  }
  if (!validJson) {
    return {
      body,
      validation: { ok: false, statusCode: 400, reason: 'invalid_json' },
    };
  }
  return { body, validation: { ok: true } };
}

export function slackCallbackExternalId(
  body: SlackEventEnvelope & Record<string, unknown>,
): string {
  if (typeof body.event_id === 'string' && body.event_id) {
    return `event:${body.event_id}`;
  }
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return `challenge:${createHash('sha256').update(body.challenge).digest('hex')}`;
  }
  const event = body.event;
  if (event?.channel && event.ts) return `message:${event.channel}:${event.ts}`;
  return `anonymous:${Date.now()}`;
}

export function slackCallbackEventType(
  body: SlackEventEnvelope & Record<string, unknown>,
): string {
  if (body.type === 'url_verification') return 'url_verification';
  return body.event?.type || body.type || 'unknown';
}
