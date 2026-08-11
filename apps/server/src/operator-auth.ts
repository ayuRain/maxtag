import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const SESSION_COOKIE = 'opentag_operator_session';
const MINIMUM_TOKEN_LENGTH = 24;
const MINIMUM_SESSION_TTL_SECONDS = 5 * 60;
const MAXIMUM_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

interface OperatorSessionPayload {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  csrfToken: string;
}

export interface OperatorAuthentication {
  authenticated: boolean;
  method?: 'disabled' | 'bearer' | 'session';
  csrfValid: boolean;
  expiresAt?: string;
  csrfToken?: string;
}

export interface OperatorSession {
  cookie: string;
  expiresAt: string;
  csrfToken: string;
}

export interface OperatorAuthOptions {
  token?: string;
  sessionTtlSeconds?: number;
  secureCookie?: boolean;
}

function boundedTtl(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8 * 60 * 60;
  return Math.max(
    MINIMUM_SESSION_TTL_SECONDS,
    Math.min(MAXIMUM_SESSION_TTL_SECONDS, Math.floor(value as number)),
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization || '');
  return match?.[1];
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    return entry.slice(separator + 1).trim();
  }
  return undefined;
}

function encodePayload(payload: OperatorSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(value: string): OperatorSessionPayload | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<OperatorSessionPayload>;
    if (
      parsed.version !== 1 ||
      !Number.isFinite(parsed.issuedAt) ||
      !Number.isFinite(parsed.expiresAt) ||
      typeof parsed.csrfToken !== 'string' ||
      !parsed.csrfToken
    ) {
      return undefined;
    }
    return parsed as OperatorSessionPayload;
  } catch {
    return undefined;
  }
}

export function bearerTokenMatches(
  request: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  const supplied = bearerToken(request);
  return Boolean(
    expectedToken && supplied && constantTimeEqual(supplied, expectedToken),
  );
}

export class OperatorAuth {
  readonly configured: boolean;
  readonly sessionTtlSeconds: number;
  private readonly token?: string;
  private readonly secureCookie: boolean;

  constructor(options: OperatorAuthOptions = {}) {
    this.token = options.token || undefined;
    if (this.token && this.token.length < MINIMUM_TOKEN_LENGTH) {
      throw new Error(
        `OPENTAG_ADMIN_TOKEN must be at least ${MINIMUM_TOKEN_LENGTH} characters.`,
      );
    }
    this.configured = Boolean(this.token);
    this.sessionTtlSeconds = boundedTtl(options.sessionTtlSeconds);
    this.secureCookie = Boolean(options.secureCookie);
  }

  authenticate(
    request: IncomingMessage,
    at = new Date(),
  ): OperatorAuthentication {
    if (!this.token) {
      return {
        authenticated: true,
        method: 'disabled',
        csrfValid: true,
      };
    }
    if (bearerTokenMatches(request, this.token)) {
      return {
        authenticated: true,
        method: 'bearer',
        csrfValid: true,
      };
    }
    const session = this.parseSession(cookieValue(request, SESSION_COOKIE), at);
    if (!session) return { authenticated: false, csrfValid: false };
    const suppliedCsrf = request.headers['x-opentag-csrf'];
    const csrfValue = Array.isArray(suppliedCsrf)
      ? suppliedCsrf[0]
      : suppliedCsrf;
    return {
      authenticated: true,
      method: 'session',
      csrfValid: Boolean(
        csrfValue && constantTimeEqual(csrfValue, session.csrfToken),
      ),
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
      csrfToken: session.csrfToken,
    };
  }

  createSession(suppliedToken: string, at = new Date()): OperatorSession | undefined {
    if (!this.token || !constantTimeEqual(suppliedToken, this.token)) {
      return undefined;
    }
    const issuedAt = Math.floor(at.getTime() / 1000);
    const payload: OperatorSessionPayload = {
      version: 1,
      issuedAt,
      expiresAt: issuedAt + this.sessionTtlSeconds,
      csrfToken: randomBytes(24).toString('base64url'),
    };
    const encoded = encodePayload(payload);
    const signature = this.sign(encoded);
    return {
      cookie: this.cookie(`${encoded}.${signature}`, this.sessionTtlSeconds),
      expiresAt: new Date(payload.expiresAt * 1000).toISOString(),
      csrfToken: payload.csrfToken,
    };
  }

  clearSessionCookie(): string {
    return this.cookie('', 0);
  }

  private parseSession(
    value: string | undefined,
    at: Date,
  ): OperatorSessionPayload | undefined {
    if (!this.token || !value) return undefined;
    const separator = value.lastIndexOf('.');
    if (separator < 1) return undefined;
    const encoded = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    if (!constantTimeEqual(signature, this.sign(encoded))) return undefined;
    const payload = decodePayload(encoded);
    if (!payload || payload.expiresAt <= Math.floor(at.getTime() / 1000)) {
      return undefined;
    }
    return payload;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.token || '')
      .update(value)
      .digest('base64url');
  }

  private cookie(value: string, maxAge: number): string {
    return [
      `${SESSION_COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      ...(this.secureCookie ? ['Secure'] : []),
    ].join('; ');
  }
}
