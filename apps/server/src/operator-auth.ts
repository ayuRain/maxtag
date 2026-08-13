import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const SESSION_COOKIE = 'opentag_operator_session';
const MINIMUM_TOKEN_LENGTH = 24;
const MINIMUM_SESSION_TTL_SECONDS = 5 * 60;
const MAXIMUM_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

interface LegacyOperatorSessionPayload {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  csrfToken: string;
}

interface OperatorSessionPayload {
  version: 2;
  principalId: string;
  issuedAt: number;
  expiresAt: number;
  csrfToken: string;
}

interface RevisionedOperatorSessionPayload {
  version: 3;
  principalId: string;
  credentialSource: 'static' | 'persistent';
  credentialRevision: number;
  issuedAt: number;
  expiresAt: number;
  csrfToken: string;
}

type DecodedOperatorSessionPayload =
  | LegacyOperatorSessionPayload
  | OperatorSessionPayload
  | RevisionedOperatorSessionPayload;

export type OperatorRole = 'owner' | 'admin' | 'viewer';

export interface OperatorPrincipal {
  id: string;
  displayName: string;
  role: OperatorRole;
  workspaceIds: string[];
}

export interface OperatorCredential extends OperatorPrincipal {
  token: string;
}

export interface OperatorAuthentication {
  authenticated: boolean;
  method?: 'disabled' | 'bearer' | 'session';
  csrfValid: boolean;
  expiresAt?: string;
  csrfToken?: string;
  principal?: OperatorPrincipal;
}

export interface OperatorSession {
  cookie: string;
  expiresAt: string;
  csrfToken: string;
  principal: OperatorPrincipal;
}

export interface OperatorAuthOptions {
  token?: string;
  principal?: Partial<OperatorPrincipal>;
  credentials?: OperatorCredential[];
  sessionSecret?: string;
  sessionTtlSeconds?: number;
  secureCookie?: boolean;
  persistentCredentials?: PersistentOperatorCredentialProvider;
  persistentCredentialCount?: number;
}

export interface PersistentOperatorCredentialProvider {
  authenticateToken(token: string): Promise<{
    principal: OperatorPrincipal;
    revision: number;
  } | undefined>;
  resolveActive(id: string, revision: number): Promise<{
    principal: OperatorPrincipal;
    revision: number;
  } | undefined>;
}

interface ResolvedCredential {
  principal: OperatorPrincipal;
  source: 'static' | 'persistent';
  revision: number;
}

const LOCAL_PRINCIPAL: OperatorPrincipal = {
  id: 'local-development',
  displayName: 'Local operator',
  role: 'owner',
  workspaceIds: ['*'],
};

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

function required(value: string, error: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(error);
  return normalized;
}

function normalizePrincipal(
  principal: Partial<OperatorPrincipal> | undefined,
  fallback: OperatorPrincipal,
): OperatorPrincipal {
  const role = principal?.role ?? fallback.role;
  if (role !== 'owner' && role !== 'admin' && role !== 'viewer') {
    throw new Error('operator_principal_role_invalid');
  }
  const workspaceIds = [
    ...new Set(
      (principal?.workspaceIds ?? fallback.workspaceIds)
        .map((workspaceId) => workspaceId.trim())
        .filter(Boolean),
    ),
  ];
  if (!workspaceIds.length) {
    throw new Error('operator_principal_workspace_required');
  }
  return {
    id: required(
      principal?.id ?? fallback.id,
      'operator_principal_id_required',
    ),
    displayName: required(
      principal?.displayName ?? fallback.displayName,
      'operator_principal_display_name_required',
    ),
    role,
    workspaceIds,
  };
}

function clonePrincipal(principal: OperatorPrincipal): OperatorPrincipal {
  return {
    id: principal.id,
    displayName: principal.displayName,
    role: principal.role,
    workspaceIds: [...principal.workspaceIds],
  };
}

function validateToken(token: string, label: string): string {
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    throw new Error(`${label} must be at least ${MINIMUM_TOKEN_LENGTH} characters.`);
  }
  return token;
}

function staticCredentialRevision(token: string): number {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  return digest.readUIntBE(0, 6) || 1;
}

function encodePayload(payload: DecodedOperatorSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(
  value: string,
): DecodedOperatorSessionPayload | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<DecodedOperatorSessionPayload>;
    if (
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
      !Number.isFinite(parsed.issuedAt) ||
      !Number.isFinite(parsed.expiresAt) ||
      typeof parsed.csrfToken !== 'string' ||
      !parsed.csrfToken ||
      ((parsed.version === 2 || parsed.version === 3) &&
        (!('principalId' in parsed) ||
          typeof parsed.principalId !== 'string' ||
          !parsed.principalId)) ||
      (parsed.version === 3 &&
        (parsed.credentialSource !== 'static' &&
          parsed.credentialSource !== 'persistent')) ||
      (parsed.version === 3 &&
        (!Number.isInteger(parsed.credentialRevision) ||
          (parsed.credentialRevision ?? 0) < 1))
    ) {
      return undefined;
    }
    return parsed as DecodedOperatorSessionPayload;
  } catch {
    return undefined;
  }
}

export function parseOperatorCredentials(
  raw: string | undefined,
): OperatorCredential[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OPENTAG_OPERATOR_PRINCIPALS_JSON must be valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('OPENTAG_OPERATOR_PRINCIPALS_JSON must be an array.');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`operator_principal_${index}_invalid`);
    }
    const value = entry as Record<string, unknown>;
    if (
      value.role !== 'owner' &&
      value.role !== 'admin' &&
      value.role !== 'viewer'
    ) {
      throw new Error(`operator_principal_${index}_role_invalid`);
    }
    const workspaceIds = Array.isArray(value.workspaceIds)
      ? value.workspaceIds.filter(
          (workspaceId): workspaceId is string => typeof workspaceId === 'string',
        )
      : [];
    if (!workspaceIds.length) {
      throw new Error(`operator_principal_${index}_workspace_required`);
    }
    const principal = normalizePrincipal(
      {
        id: typeof value.id === 'string' ? value.id : '',
        displayName:
          typeof value.displayName === 'string' ? value.displayName : '',
        role: value.role,
        workspaceIds,
      },
      LOCAL_PRINCIPAL,
    );
    const token =
      typeof value.token === 'string'
        ? validateToken(value.token, `operator principal ${principal.id} token`)
        : '';
    if (!token) throw new Error(`operator_principal_${principal.id}_token_required`);
    return { ...principal, token };
  });
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
  readonly sessionTtlSeconds: number;
  private readonly credentials: OperatorCredential[];
  private readonly sessionSecret?: string;
  private readonly secureCookie: boolean;
  private readonly persistentCredentials?: PersistentOperatorCredentialProvider;
  private persistentCredentialCount: number;

  constructor(options: OperatorAuthOptions = {}) {
    const credentials = (options.credentials ?? []).map((credential) => ({
      ...normalizePrincipal(credential, LOCAL_PRINCIPAL),
      token: validateToken(
        credential.token,
        `operator principal ${credential.id} token`,
      ),
    }));
    if (options.token) {
      credentials.unshift({
        ...normalizePrincipal(options.principal, {
          id: 'installation-owner',
          displayName: 'Installation owner',
          role: 'owner',
          workspaceIds: ['*'],
        }),
        token: validateToken(options.token, 'OPENTAG_ADMIN_TOKEN'),
      });
    }
    const principalIds = new Set<string>();
    const tokens = new Set<string>();
    for (const credential of credentials) {
      if (principalIds.has(credential.id)) {
        throw new Error(`operator_principal_${credential.id}_duplicate`);
      }
      if (tokens.has(credential.token)) {
        throw new Error('operator_principal_token_duplicate');
      }
      principalIds.add(credential.id);
      tokens.add(credential.token);
    }
    this.credentials = credentials;
    this.persistentCredentials = options.persistentCredentials;
    this.persistentCredentialCount = Math.max(
      0,
      Math.floor(options.persistentCredentialCount ?? 0),
    );
    this.sessionSecret = options.sessionSecret
      ? validateToken(options.sessionSecret, 'OPENTAG_OPERATOR_SESSION_SECRET')
      : credentials[0]?.token;
    this.sessionTtlSeconds = boundedTtl(options.sessionTtlSeconds);
    this.secureCookie = Boolean(options.secureCookie);
  }

  get configured(): boolean {
    return this.credentials.length > 0 || this.persistentCredentialCount > 0;
  }

  get principalCount(): number {
    return this.credentials.length + this.persistentCredentialCount;
  }

  setPersistentCredentialCount(count: number): void {
    this.persistentCredentialCount = Math.max(0, Math.floor(count));
  }

  hasStaticPrincipal(id: string): boolean {
    return this.credentials.some((credential) => credential.id === id);
  }

  hasStaticInstallationOwner(): boolean {
    return this.credentials.some(
      (credential) =>
        credential.role === 'owner' && credential.workspaceIds.includes('*'),
    );
  }

  async authenticate(
    request: IncomingMessage,
    at = new Date(),
  ): Promise<OperatorAuthentication> {
    if (!this.configured) {
      return {
        authenticated: true,
        method: 'disabled',
        csrfValid: true,
        principal: clonePrincipal(LOCAL_PRINCIPAL),
      };
    }
    const suppliedBearer = bearerToken(request);
    const staticBearerCredential = suppliedBearer
      ? this.credentials.find((credential) =>
          constantTimeEqual(suppliedBearer, credential.token),
        )
      : undefined;
    if (staticBearerCredential) {
      return {
        authenticated: true,
        method: 'bearer',
        csrfValid: true,
        principal: clonePrincipal(staticBearerCredential),
      };
    }
    const persistentBearerCredential = suppliedBearer
      ? await this.persistentCredentials?.authenticateToken(suppliedBearer)
      : undefined;
    if (persistentBearerCredential) {
      return {
        authenticated: true,
        method: 'bearer',
        csrfValid: true,
        principal: clonePrincipal(persistentBearerCredential.principal),
      };
    }
    const session = this.parseSession(cookieValue(request, SESSION_COOKIE), at);
    if (!session) return { authenticated: false, csrfValid: false };
    let principal: OperatorPrincipal | undefined;
    if (session.version === 1) {
      principal = this.credentials[0];
    } else if (session.version === 2) {
      principal = this.credentials.find(
        (candidate) => candidate.id === session.principalId,
      );
    } else if (session.credentialSource === 'static') {
      principal = this.credentials.find(
        (candidate) =>
          candidate.id === session.principalId &&
          staticCredentialRevision(candidate.token) === session.credentialRevision,
      );
    } else {
      principal = (
        await this.persistentCredentials?.resolveActive(
          session.principalId,
          session.credentialRevision,
        )
      )?.principal;
    }
    if (!principal) return { authenticated: false, csrfValid: false };
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
      principal: clonePrincipal(principal),
    };
  }

  async createSession(
    suppliedToken: string,
    at = new Date(),
  ): Promise<OperatorSession | undefined> {
    const staticCredential = this.credentials.find((candidate) =>
      constantTimeEqual(suppliedToken, candidate.token),
    );
    const resolved: ResolvedCredential | undefined = staticCredential
      ? {
          principal: staticCredential,
          source: 'static',
          revision: staticCredentialRevision(staticCredential.token),
        }
      : await this.persistentCredentials?.authenticateToken(suppliedToken)
        .then((credential) =>
          credential
            ? {
                principal: credential.principal,
                source: 'persistent' as const,
                revision: credential.revision,
              }
            : undefined,
        );
    if (!resolved) return undefined;
    const issuedAt = Math.floor(at.getTime() / 1000);
    const payload: RevisionedOperatorSessionPayload = {
      version: 3,
      principalId: resolved.principal.id,
      credentialSource: resolved.source,
      credentialRevision: resolved.revision,
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
      principal: clonePrincipal(resolved.principal),
    };
  }

  clearSessionCookie(): string {
    return this.cookie('', 0);
  }

  private parseSession(
    value: string | undefined,
    at: Date,
  ): DecodedOperatorSessionPayload | undefined {
    if (!this.sessionSecret || !value) return undefined;
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
    return createHmac('sha256', this.sessionSecret || '')
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
