import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { GitHubWebhookPayload } from './types.js';

export interface GitHubCallbackValidationOptions {
  webhookSecret?: string;
}

export type GitHubCallbackValidationResult =
  | { ok: true }
  | {
      ok: false;
      statusCode: number;
      reason: 'invalid_json' | 'invalid_signature';
    };

export interface ParsedGitHubCallback {
  body: GitHubWebhookPayload;
  validation: GitHubCallbackValidationResult;
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function validSignature(
  rawBody: string,
  secret: string,
  received: string | undefined,
): boolean {
  if (!received?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex')}`;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return (
    expectedBytes.byteLength === receivedBytes.byteLength &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function parseAndValidateGitHubCallback(
  rawBody: string,
  headers: IncomingHttpHeaders,
  options: GitHubCallbackValidationOptions = {},
): ParsedGitHubCallback {
  let body: GitHubWebhookPayload;
  try {
    body = JSON.parse(rawBody || '{}') as GitHubWebhookPayload;
  } catch {
    return {
      body: {},
      validation: { ok: false, statusCode: 400, reason: 'invalid_json' },
    };
  }

  if (
    options.webhookSecret &&
    !validSignature(
      rawBody,
      options.webhookSecret,
      headerValue(headers, 'x-hub-signature-256'),
    )
  ) {
    return {
      body,
      validation: {
        ok: false,
        statusCode: 401,
        reason: 'invalid_signature',
      },
    };
  }

  return { body, validation: { ok: true } };
}

export function githubCallbackExternalId(
  headers: IncomingHttpHeaders,
  body: GitHubWebhookPayload,
): string {
  const deliveryId = headerValue(headers, 'x-github-delivery')?.trim();
  if (deliveryId) return `delivery:${deliveryId}`;
  if (body.comment?.id) return `comment:${body.comment.id}`;
  if (body.hook_id) return `hook:${body.hook_id}`;
  return `anonymous:${Date.now()}`;
}

export function githubCallbackEventType(
  headers: IncomingHttpHeaders,
): string {
  return headerValue(headers, 'x-github-event')?.trim() || 'unknown';
}
