import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ToolCredentialIdentityProvider = 'lark' | 'github';

export interface ToolCredentialIdentity {
  id: string;
  displayName: string;
  provider: ToolCredentialIdentityProvider;
  envRefs: {
    appId?: string;
    appSecret?: string;
    token?: string;
  };
  baseUrl?: string;
  externalActor?: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ToolCredentialIdentityAuditRecord {
  id: string;
  identityId: string;
  action:
    | 'tool_identity.created'
    | 'tool_identity.updated'
    | 'tool_identity.enabled'
    | 'tool_identity.disabled';
  actor: string;
  at: string;
  snapshot: ToolCredentialIdentity;
}

interface ToolCredentialIdentityFileState {
  version: 1;
  identities: ToolCredentialIdentity[];
  audit: ToolCredentialIdentityAuditRecord[];
}

export class ToolCredentialIdentityRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('tool_credential_identity_revision_conflict');
    this.name = 'ToolCredentialIdentityRevisionConflictError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function identityId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id)) {
    throw new Error('tool_credential_identity_invalid_id');
  }
  return id;
}

function displayName(value: string): string {
  const name = value.replace(/[\0\r\n]/gu, '').trim();
  if (!name || name.length > 120) {
    throw new Error('tool_credential_identity_invalid_display_name');
  }
  return name;
}

function provider(value: string): ToolCredentialIdentityProvider {
  if (value !== 'lark' && value !== 'github') {
    throw new Error('tool_credential_identity_invalid_provider');
  }
  return value;
}

function envRef(value: string | undefined): string | undefined {
  const ref = value?.trim();
  if (!ref) return undefined;
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(ref)) {
    throw new Error('tool_credential_identity_invalid_env_ref');
  }
  return ref;
}

function normalizedBaseUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  const url = new URL(candidate);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('tool_credential_identity_invalid_base_url');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

function externalActor(value: string | undefined): string | undefined {
  const actor = value?.replace(/[\0\r\n]/gu, '').trim();
  if (!actor) return undefined;
  if (actor.length > 160) {
    throw new Error('tool_credential_identity_invalid_external_actor');
  }
  return actor;
}

function cloneIdentity(value: ToolCredentialIdentity): ToolCredentialIdentity {
  return { ...value, envRefs: { ...value.envRefs } };
}

function normalizedIdentity(value: unknown): ToolCredentialIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<ToolCredentialIdentity>;
  try {
    if (
      typeof item.id !== 'string' ||
      typeof item.displayName !== 'string' ||
      typeof item.provider !== 'string' ||
      !item.envRefs ||
      typeof item.envRefs !== 'object' ||
      typeof item.enabled !== 'boolean' ||
      !Number.isInteger(item.revision) ||
      (item.revision ?? 0) < 1 ||
      typeof item.createdAt !== 'string' ||
      typeof item.createdBy !== 'string' ||
      typeof item.updatedAt !== 'string' ||
      typeof item.updatedBy !== 'string'
    ) return undefined;
    const resolvedProvider = provider(item.provider);
    const refs = {
      appId: envRef(item.envRefs.appId),
      appSecret: envRef(item.envRefs.appSecret),
      token: envRef(item.envRefs.token),
    };
    if (
      (resolvedProvider === 'lark' && (!refs.appId || !refs.appSecret || refs.token)) ||
      (resolvedProvider === 'github' && (!refs.token || refs.appId || refs.appSecret))
    ) return undefined;
    return {
      id: identityId(item.id),
      displayName: displayName(item.displayName),
      provider: resolvedProvider,
      envRefs: refs,
      baseUrl: normalizedBaseUrl(item.baseUrl),
      externalActor: externalActor(item.externalActor),
      enabled: item.enabled,
      revision: item.revision as number,
      createdAt: new Date(item.createdAt).toISOString(),
      createdBy: item.createdBy.trim() || 'unknown',
      updatedAt: new Date(item.updatedAt).toISOString(),
      updatedBy: item.updatedBy.trim() || 'unknown',
    };
  } catch {
    return undefined;
  }
}

function normalizeState(value: unknown): ToolCredentialIdentityFileState {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const identities = Array.isArray(record.identities)
    ? record.identities.flatMap((item) => {
        const identity = normalizedIdentity(item);
        return identity ? [identity] : [];
      })
    : [];
  const audit = Array.isArray(record.audit)
    ? record.audit.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const item = value as Partial<ToolCredentialIdentityAuditRecord>;
        const snapshot = normalizedIdentity(item.snapshot);
        if (
          typeof item.id !== 'string' ||
          typeof item.identityId !== 'string' ||
          !item.action?.startsWith('tool_identity.') ||
          typeof item.actor !== 'string' ||
          typeof item.at !== 'string' ||
          !snapshot
        ) return [];
        return [{
          id: item.id,
          identityId: identityId(item.identityId),
          action: item.action as ToolCredentialIdentityAuditRecord['action'],
          actor: item.actor,
          at: new Date(item.at).toISOString(),
          snapshot,
        }];
      })
    : [];
  return { version: 1, identities, audit };
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

export class FileToolCredentialIdentityStore {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'tool-credential-identities.json');
    this.lockFile = `${this.stateFile}.lock`;
  }

  private async load(): Promise<ToolCredentialIdentityFileState> {
    try {
      return normalizeState(JSON.parse(await fs.readFile(this.stateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, identities: [], audit: [] };
      }
      throw error;
    }
  }

  private async save(state: ToolCredentialIdentityFileState): Promise<void> {
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
          const current = await fs.readFile(this.lockFile, 'utf8')
            .then((text) => text.split('\n', 1)[0])
            .catch(() => undefined);
          if (current === owner) await fs.unlink(this.lockFile).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stale = await Promise.all([
          fs.stat(this.lockFile),
          fs.readFile(this.lockFile, 'utf8'),
        ]).then(([stat, text]) => {
          const pid = Number(text.split(':', 1)[0]);
          return Date.now() - stat.mtimeMs > 30_000 && !processIsAlive(pid);
        }).catch(() => false);
        if (stale) {
          await fs.unlink(this.lockFile).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error('tool_credential_identity_store_lock_timeout');
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
  }

  private async mutate<T>(operation: (state: ToolCredentialIdentityFileState) => T): Promise<T> {
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

  async list(): Promise<ToolCredentialIdentity[]> {
    await this.mutationQueue;
    return (await this.load()).identities.map(cloneIdentity);
  }

  async get(idValue: string): Promise<ToolCredentialIdentity | undefined> {
    const id = identityId(idValue);
    return (await this.list()).find((item) => item.id === id);
  }

  async upsert(input: {
    id: string;
    displayName: string;
    provider: ToolCredentialIdentityProvider;
    envRefs: ToolCredentialIdentity['envRefs'];
    baseUrl?: string;
    externalActor?: string;
    expectedRevision?: number;
    actor?: string;
  }): Promise<ToolCredentialIdentity> {
    return this.mutate((state) => {
      const id = identityId(input.id);
      const index = state.identities.findIndex((item) => item.id === id);
      const existing = index >= 0 ? state.identities[index] : undefined;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== (existing?.revision ?? 0)
      ) throw new ToolCredentialIdentityRevisionConflictError(existing?.revision ?? 0);
      const resolvedProvider = provider(input.provider);
      const refs = {
        appId: envRef(input.envRefs.appId),
        appSecret: envRef(input.envRefs.appSecret),
        token: envRef(input.envRefs.token),
      };
      if (
        (resolvedProvider === 'lark' && (!refs.appId || !refs.appSecret || refs.token)) ||
        (resolvedProvider === 'github' && (!refs.token || refs.appId || refs.appSecret))
      ) throw new Error('tool_credential_identity_invalid_env_refs');
      const timestamp = now();
      const actor = input.actor?.trim() || 'operator';
      const next: ToolCredentialIdentity = {
        id,
        displayName: displayName(input.displayName),
        provider: resolvedProvider,
        envRefs: refs,
        baseUrl: normalizedBaseUrl(input.baseUrl),
        externalActor: externalActor(input.externalActor),
        enabled: existing?.enabled ?? true,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? timestamp,
        createdBy: existing?.createdBy ?? actor,
        updatedAt: timestamp,
        updatedBy: actor,
      };
      if (index >= 0) state.identities.splice(index, 1, next);
      else state.identities.push(next);
      state.audit.push({
        id: randomUUID(),
        identityId: id,
        action: existing ? 'tool_identity.updated' : 'tool_identity.created',
        actor,
        at: timestamp,
        snapshot: cloneIdentity(next),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneIdentity(next);
    });
  }

  async setEnabled(input: {
    id: string;
    enabled: boolean;
    expectedRevision?: number;
    actor?: string;
  }): Promise<ToolCredentialIdentity> {
    return this.mutate((state) => {
      const id = identityId(input.id);
      const index = state.identities.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('tool_credential_identity_not_found');
      const existing = state.identities[index];
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.revision
      ) throw new ToolCredentialIdentityRevisionConflictError(existing.revision);
      const timestamp = now();
      const actor = input.actor?.trim() || 'operator';
      const next = {
        ...cloneIdentity(existing),
        enabled: input.enabled,
        revision: existing.revision + 1,
        updatedAt: timestamp,
        updatedBy: actor,
      };
      state.identities.splice(index, 1, next);
      state.audit.push({
        id: randomUUID(),
        identityId: id,
        action: input.enabled ? 'tool_identity.enabled' : 'tool_identity.disabled',
        actor,
        at: timestamp,
        snapshot: cloneIdentity(next),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneIdentity(next);
    });
  }

  async listAudit(limit = 200): Promise<ToolCredentialIdentityAuditRecord[]> {
    await this.mutationQueue;
    return (await this.load()).audit
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((record) => ({ ...record, snapshot: cloneIdentity(record.snapshot) }));
  }
}
