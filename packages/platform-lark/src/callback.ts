import {
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { LarkCardAction, LarkIncomingEvent } from './types.js';

export interface LarkCallbackValidationOptions {
  verificationToken?: string;
  encryptKey?: string;
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
        | 'invalid_signature'
        | 'encrypt_key_required'
        | 'invalid_encrypted_payload'
        | 'stale_request';
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

function headerRecord(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const header = body.header;
  return header && typeof header === 'object' && !Array.isArray(header)
    ? (header as Record<string, unknown>)
    : undefined;
}

function verificationToken(body: Record<string, unknown>): unknown {
  return headerRecord(body)?.token ?? body.token;
}

function isUrlVerification(body: Record<string, unknown>): boolean {
  return (
    body.type === 'url_verification' &&
    typeof body.challenge === 'string' &&
    body.challenge.length > 0
  );
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_lark_callback_object');
  }
  return parsed as Record<string, unknown>;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function signatureHeaders(headers: IncomingHttpHeaders): {
  timestamp?: string;
  nonce?: string;
  signature?: string;
  complete: boolean;
  absent: boolean;
} {
  const timestamp = headerValue(headers, 'x-lark-request-timestamp');
  const nonce = headerValue(headers, 'x-lark-request-nonce');
  const signature = headerValue(headers, 'x-lark-signature');
  return {
    timestamp,
    nonce,
    signature,
    complete: Boolean(timestamp && nonce && signature),
    absent: !timestamp && !nonce && !signature,
  };
}

function validateSignature(
  rawBody: string,
  headers: IncomingHttpHeaders,
  encryptKey: string,
): LarkCallbackValidationResult {
  const values = signatureHeaders(headers);
  if (!values.complete) {
    return { ok: false, statusCode: 401, reason: 'invalid_signature' };
  }
  const expected = createHash('sha256')
    .update(`${values.timestamp}${values.nonce}${encryptKey}${rawBody}`)
    .digest('hex');
  const actual = values.signature!.trim().toLowerCase();
  if (!safeEqual(expected, actual)) {
    return { ok: false, statusCode: 401, reason: 'invalid_signature' };
  }
  return { ok: true };
}

export function decryptLarkCallbackPayload(
  encryptedPayload: string,
  encryptKey: string,
): string {
  const encoded = encryptedPayload.trim();
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new Error('invalid_lark_encrypted_payload');
  }
  const encrypted = Buffer.from(encoded, 'base64');
  if (encrypted.length < 32 || (encrypted.length - 16) % 16 !== 0) {
    throw new Error('invalid_lark_encrypted_payload');
  }
  const key = createHash('sha256').update(encryptKey).digest();
  const decipher = createDecipheriv(
    'aes-256-cbc',
    key,
    encrypted.subarray(0, 16),
  );
  return Buffer.concat([
    decipher.update(encrypted.subarray(16)),
    decipher.final(),
  ]).toString('utf8');
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
  const actual = verificationToken(body);
  if (
    typeof actual !== 'string' ||
    !safeEqual(actual, options.verificationToken)
  ) {
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
  let envelope: LarkIncomingEvent & Record<string, unknown>;
  try {
    envelope = parseObject(rawBody || '{}') as LarkIncomingEvent &
      Record<string, unknown>;
  } catch {
    return {
      body: {},
      validation: { ok: false, statusCode: 400, reason: 'invalid_json' },
    };
  }

  const encryptedEnvelope = Object.hasOwn(envelope, 'encrypt');
  if (encryptedEnvelope && typeof envelope.encrypt !== 'string') {
    return {
      body: envelope,
      validation: {
        ok: false,
        statusCode: 400,
        reason: 'invalid_encrypted_payload',
      },
    };
  }
  const encryptedPayload = encryptedEnvelope
    ? (envelope.encrypt as string)
    : undefined;
  if (encryptedEnvelope && !options.encryptKey) {
    return {
      body: envelope,
      validation: { ok: false, statusCode: 400, reason: 'encrypt_key_required' },
    };
  }

  const signature = options.encryptKey
    ? validateSignature(rawBody, headers, options.encryptKey)
    : ({ ok: true } as const);
  const signatureState = signatureHeaders(headers);
  if (
    options.encryptKey &&
    !signature.ok &&
    (!signatureState.absent || !encryptedEnvelope)
  ) {
    return { body: envelope, validation: signature };
  }

  let body = envelope;
  if (encryptedEnvelope && options.encryptKey) {
    try {
      body = parseObject(
        decryptLarkCallbackPayload(encryptedPayload!, options.encryptKey),
      ) as LarkIncomingEvent & Record<string, unknown>;
    } catch {
      return {
        body: envelope,
        validation: options.encryptKey && !signature.ok
          ? signature
          : {
              ok: false,
              statusCode: 400,
              reason: 'invalid_encrypted_payload',
            },
      };
    }
  }

  const token = validateVerificationToken(body, options);
  if (!token.ok) return { body, validation: token };

  if (options.encryptKey && !signature.ok) {
    const tokenVerifiedChallenge =
      Boolean(options.verificationToken) && isUrlVerification(body);
    if (!tokenVerifiedChallenge) return { body, validation: signature };
  }

  const timestamp = validateTimestamp(headers, options);
  if (!timestamp.ok) return { body, validation: timestamp };

  return { body, validation: { ok: true } };
}

export function larkCallbackExternalId(
  body: LarkIncomingEvent & Record<string, unknown>,
): string {
  const headerEventId = headerRecord(body)?.event_id;
  if (typeof headerEventId === 'string' && headerEventId) return headerEventId;
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

export function normalizeLarkCardAction(
  body: LarkIncomingEvent & Record<string, unknown>,
): LarkCardAction | undefined {
  if (larkCallbackEventType(body) !== 'card.action.trigger') return undefined;
  const event = body.event;
  const value = event?.action?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const action = typeof record.action === 'string' ? record.action.trim() : '';
  const actorId =
    event?.operator?.open_id?.trim() || event?.operator?.user_id?.trim() || '';
  const cardMessageId = event?.context?.open_message_id?.trim() || '';
  const chatId = event?.context?.open_chat_id?.trim() || '';
  if (!action || !actorId || !cardMessageId || !chatId) return undefined;
  const runId = typeof record.run_id === 'string' ? record.run_id.trim() : '';
  return {
    action,
    runId: runId || undefined,
    actorId,
    cardMessageId,
    chatId,
    tenantKey: event?.operator?.tenant_key || body.header?.tenant_key,
    componentTag: event?.action?.tag,
  };
}
