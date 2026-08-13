import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type PersistentOperatorRole = 'owner' | 'admin' | 'viewer';
export type OperatorCredentialStatus = 'active' | 'revoked';

export interface OperatorCredentialSummary {
  id: string;
  displayName: string;
  role: PersistentOperatorRole;
  workspaceIds: string[];
  status: OperatorCredentialStatus;
  revision: number;
  tokenPrefix: string;
  createdAt: string;
  createdBy: string;
  rotatedAt?: string;
  rotatedBy?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface OperatorCredentialAuditRecord {
  id: string;
  credentialId: string;
  action:
    | 'operator_credential.created'
    | 'operator_credential.rotated'
    | 'operator_credential.revoked';
  actor: string;
  at: string;
  revision: number;
}

export interface AuthenticatedOperatorCredential {
  principal: {
    id: string;
    displayName: string;
    role: PersistentOperatorRole;
    workspaceIds: string[];
  };
  revision: number;
}

interface StoredOperatorCredential extends OperatorCredentialSummary {
  tokenHash: string;
}

interface OperatorCredentialFileState {
  version: 1;
  credentials: StoredOperatorCredential[];
  audit: OperatorCredentialAuditRecord[];
}

export class OperatorCredentialRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('operator_credential_revision_conflict');
    this.name = 'OperatorCredentialRevisionConflictError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id)) {
    throw new Error('operator_credential_invalid_id');
  }
  return id;
}

function normalizeDisplayName(value: string): string {
  const displayName = value.replace(/[\0\r\n]/gu, '').trim();
  if (!displayName || displayName.length > 120) {
    throw new Error('operator_credential_invalid_display_name');
  }
  return displayName;
}

function normalizeRole(value: string): PersistentOperatorRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'viewer') {
    throw new Error('operator_credential_invalid_role');
  }
  return value;
}

function normalizeWorkspaceIds(value: string[]): string[] {
  const workspaceIds = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (
    !workspaceIds.length ||
    workspaceIds.some(
      (workspaceId) =>
        workspaceId !== '*' &&
        (workspaceId.length > 160 || !/^[a-zA-Z0-9_.:-]+$/u.test(workspaceId)),
    )
  ) {
    throw new Error('operator_credential_invalid_workspace_scope');
  }
  return workspaceIds;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantTimeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function generateToken(): string {
  return `otk_${randomBytes(32).toString('base64url')}`;
}

function cloneSummary(
  credential: StoredOperatorCredential,
): OperatorCredentialSummary {
  const { tokenHash: _tokenHash, ...summary } = credential;
  return { ...summary, workspaceIds: [...summary.workspaceIds] };
}

function cloneAudit(
  record: OperatorCredentialAuditRecord,
): OperatorCredentialAuditRecord {
  return { ...record };
}

function normalizeStoredCredential(value: unknown): StoredOperatorCredential | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<StoredOperatorCredential>;
  try {
    if (
      typeof item.id !== 'string' ||
      typeof item.displayName !== 'string' ||
      typeof item.role !== 'string' ||
      !Array.isArray(item.workspaceIds) ||
      !item.workspaceIds.every((workspaceId) => typeof workspaceId === 'string') ||
      (item.status !== 'active' && item.status !== 'revoked') ||
      !Number.isInteger(item.revision) ||
      (item.revision ?? 0) < 1 ||
      typeof item.tokenPrefix !== 'string' ||
      !item.tokenPrefix.startsWith('otk_') ||
      typeof item.tokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.tokenHash) ||
      typeof item.createdAt !== 'string' ||
      typeof item.createdBy !== 'string'
    ) return undefined;
    return {
      id: normalizeId(item.id),
      displayName: normalizeDisplayName(item.displayName),
      role: normalizeRole(item.role),
      workspaceIds: normalizeWorkspaceIds(item.workspaceIds),
      status: item.status,
      revision: item.revision as number,
      tokenPrefix: item.tokenPrefix.slice(0, 16),
      tokenHash: item.tokenHash,
      createdAt: new Date(item.createdAt).toISOString(),
      createdBy: item.createdBy.trim() || 'unknown',
      rotatedAt: item.rotatedAt ? new Date(item.rotatedAt).toISOString() : undefined,
      rotatedBy: item.rotatedBy?.trim() || undefined,
      revokedAt: item.revokedAt ? new Date(item.revokedAt).toISOString() : undefined,
      revokedBy: item.revokedBy?.trim() || undefined,
    };
  } catch {
    return undefined;
  }
}

function normalizeAudit(value: unknown): OperatorCredentialAuditRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<OperatorCredentialAuditRecord>;
  if (
    typeof item.id !== 'string' ||
    typeof item.credentialId !== 'string' ||
    (item.action !== 'operator_credential.created' &&
      item.action !== 'operator_credential.rotated' &&
      item.action !== 'operator_credential.revoked') ||
    typeof item.actor !== 'string' ||
    typeof item.at !== 'string' ||
    !Number.isInteger(item.revision)
  ) return undefined;
  return {
    id: item.id,
    credentialId: item.credentialId,
    action: item.action,
    actor: item.actor,
    at: new Date(item.at).toISOString(),
    revision: item.revision as number,
  };
}

function normalizeState(value: unknown): OperatorCredentialFileState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, credentials: [], audit: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    version: 1,
    credentials: Array.isArray(record.credentials)
      ? record.credentials.flatMap((item) => {
          const credential = normalizeStoredCredential(item);
          return credential ? [credential] : [];
        })
      : [],
    audit: Array.isArray(record.audit)
      ? record.audit.flatMap((item) => {
          const audit = normalizeAudit(item);
          return audit ? [audit] : [];
        })
      : [],
  };
}

export class FileOperatorCredentialStore {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private readonly sessionSecretFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'operator-credentials.json');
    this.lockFile = `${this.stateFile}.lock`;
    this.sessionSecretFile = path.join(rootDir, 'operator-session.key');
  }

  private async load(): Promise<OperatorCredentialFileState> {
    try {
      return normalizeState(JSON.parse(await fs.readFile(this.stateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, credentials: [], audit: [] };
      }
      throw error;
    }
  }

  private async save(state: OperatorCredentialFileState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryFile, this.stateFile);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const owner = `${process.pid}:${randomUUID()}`;
        const handle = await fs.open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(`${owner}\n${now()}\n`, 'utf8');
        return async () => {
          await handle.close().catch(() => undefined);
          const currentOwner = await fs.readFile(this.lockFile, 'utf8')
            .then((value) => value.split('\n', 1)[0])
            .catch(() => undefined);
          if (currentOwner === owner) {
            await fs.unlink(this.lockFile).catch(() => undefined);
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stale = await Promise.all([
          fs.stat(this.lockFile),
          fs.readFile(this.lockFile, 'utf8'),
        ])
          .then(
            ([stat, value]) =>
              Date.now() - stat.mtimeMs > 30_000 &&
              !processIsAlive(Number(value.split(':', 1)[0])),
          )
          .catch(() => false);
        if (stale) {
          await fs.unlink(this.lockFile).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error('operator_credential_store_lock_timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
  }

  private async mutate<T>(
    operation: (state: OperatorCredentialFileState) => T,
  ): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const release = await this.acquireLock();
      try {
        const state = await this.load();
        const result = operation(state);
        await this.save(state);
        return result;
      } finally {
        await release();
      }
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async sessionSecret(): Promise<string> {
    try {
      const existing = (await fs.readFile(this.sessionSecretFile, 'utf8')).trim();
      if (existing.length >= 32) return existing;
      throw new Error('operator_session_secret_invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const release = await this.acquireLock();
    try {
      const existing = await fs.readFile(this.sessionSecretFile, 'utf8')
        .then((value) => value.trim())
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
      if (existing) return existing;
      const secret = randomBytes(32).toString('base64url');
      await fs.mkdir(path.dirname(this.sessionSecretFile), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(this.sessionSecretFile, `${secret}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return secret;
    } finally {
      await release();
    }
  }

  async list(): Promise<OperatorCredentialSummary[]> {
    await this.mutationQueue;
    return (await this.load()).credentials
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map(cloneSummary);
  }

  async listAudit(limit = 100): Promise<OperatorCredentialAuditRecord[]> {
    await this.mutationQueue;
    return (await this.load()).audit
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, Math.max(1, Math.min(500, Math.floor(limit))))
      .map(cloneAudit);
  }

  async activeCount(): Promise<number> {
    await this.mutationQueue;
    return (await this.load()).credentials.filter(
      (credential) => credential.status === 'active',
    ).length;
  }

  async authenticateToken(
    token: string,
  ): Promise<AuthenticatedOperatorCredential | undefined> {
    if (!token.startsWith('otk_') || token.length < 40) return undefined;
    await this.mutationQueue;
    const suppliedHash = tokenHash(token);
    const credential = (await this.load()).credentials.find(
      (candidate) =>
        candidate.status === 'active' &&
        constantTimeHashEqual(candidate.tokenHash, suppliedHash),
    );
    return credential
      ? {
          principal: {
            id: credential.id,
            displayName: credential.displayName,
            role: credential.role,
            workspaceIds: [...credential.workspaceIds],
          },
          revision: credential.revision,
        }
      : undefined;
  }

  async resolveActive(
    idValue: string,
    revision: number,
  ): Promise<AuthenticatedOperatorCredential | undefined> {
    await this.mutationQueue;
    const id = normalizeId(idValue);
    const credential = (await this.load()).credentials.find(
      (candidate) =>
        candidate.id === id &&
        candidate.status === 'active' &&
        candidate.revision === revision,
    );
    return credential
      ? {
          principal: {
            id: credential.id,
            displayName: credential.displayName,
            role: credential.role,
            workspaceIds: [...credential.workspaceIds],
          },
          revision: credential.revision,
        }
      : undefined;
  }

  async create(input: {
    id: string;
    displayName: string;
    role: PersistentOperatorRole;
    workspaceIds: string[];
    actor: string;
  }): Promise<{ credential: OperatorCredentialSummary; token: string }> {
    const id = normalizeId(input.id);
    const displayName = normalizeDisplayName(input.displayName);
    const role = normalizeRole(input.role);
    const workspaceIds = normalizeWorkspaceIds(input.workspaceIds);
    const actor = input.actor.trim() || 'unknown';
    const token = generateToken();
    return this.mutate((state) => {
      if (state.credentials.some((credential) => credential.id === id)) {
        throw new Error('operator_credential_id_exists');
      }
      const at = now();
      const credential: StoredOperatorCredential = {
        id,
        displayName,
        role,
        workspaceIds,
        status: 'active',
        revision: 1,
        tokenPrefix: token.slice(0, 12),
        tokenHash: tokenHash(token),
        createdAt: at,
        createdBy: actor,
      };
      state.credentials.push(credential);
      state.audit.push({
        id: randomUUID(),
        credentialId: id,
        action: 'operator_credential.created',
        actor,
        at,
        revision: 1,
      });
      return { credential: cloneSummary(credential), token };
    });
  }

  async rotate(input: {
    id: string;
    expectedRevision: number;
    actor: string;
  }): Promise<{ credential: OperatorCredentialSummary; token: string }> {
    const id = normalizeId(input.id);
    const actor = input.actor.trim() || 'unknown';
    const token = generateToken();
    return this.mutate((state) => {
      const credential = state.credentials.find((candidate) => candidate.id === id);
      if (!credential) throw new Error('operator_credential_not_found');
      if (credential.status !== 'active') {
        throw new Error('operator_credential_revoked');
      }
      if (credential.revision !== input.expectedRevision) {
        throw new OperatorCredentialRevisionConflictError(credential.revision);
      }
      const at = now();
      credential.revision += 1;
      credential.tokenPrefix = token.slice(0, 12);
      credential.tokenHash = tokenHash(token);
      credential.rotatedAt = at;
      credential.rotatedBy = actor;
      state.audit.push({
        id: randomUUID(),
        credentialId: id,
        action: 'operator_credential.rotated',
        actor,
        at,
        revision: credential.revision,
      });
      return { credential: cloneSummary(credential), token };
    });
  }

  async revoke(input: {
    id: string;
    expectedRevision: number;
    actor: string;
    preserveInstallationOwner?: boolean;
  }): Promise<OperatorCredentialSummary> {
    const id = normalizeId(input.id);
    const actor = input.actor.trim() || 'unknown';
    return this.mutate((state) => {
      const credential = state.credentials.find((candidate) => candidate.id === id);
      if (!credential) throw new Error('operator_credential_not_found');
      if (credential.status !== 'active') {
        throw new Error('operator_credential_already_revoked');
      }
      if (credential.revision !== input.expectedRevision) {
        throw new OperatorCredentialRevisionConflictError(credential.revision);
      }
      if (
        input.preserveInstallationOwner &&
        credential.role === 'owner' &&
        credential.workspaceIds.includes('*') &&
        !state.credentials.some(
          (candidate) =>
            candidate.id !== credential.id &&
            candidate.status === 'active' &&
            candidate.role === 'owner' &&
            candidate.workspaceIds.includes('*'),
        )
      ) {
        throw new Error('operator_credential_last_owner_required');
      }
      const at = now();
      credential.revision += 1;
      credential.status = 'revoked';
      credential.revokedAt = at;
      credential.revokedBy = actor;
      state.audit.push({
        id: randomUUID(),
        credentialId: id,
        action: 'operator_credential.revoked',
        actor,
        at,
        revision: credential.revision,
      });
      return cloneSummary(credential);
    });
  }
}
