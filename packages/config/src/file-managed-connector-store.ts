import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ManagedConnectorHealthStatus =
  | 'ready'
  | 'credentials-required'
  | 'unavailable';

export interface ManagedConnectorHealth {
  status: ManagedConnectorHealthStatus;
  checkedAt: string;
  latencyMs: number;
  toolCount: number;
  errorCode?: string;
}

export interface ManagedConnectorState {
  id: string;
  enabled: boolean;
  revision: number;
  updatedAt?: string;
  updatedBy?: string;
  lastCheck?: ManagedConnectorHealth;
}

export interface ManagedConnectorAuditRecord {
  id: string;
  connectorId: string;
  action: 'connector.enabled' | 'connector.disabled' | 'connector.checked';
  actor: string;
  at: string;
  snapshot: ManagedConnectorState;
}

interface ManagedConnectorFileState {
  version: 1;
  connectors: ManagedConnectorState[];
  audit: ManagedConnectorAuditRecord[];
}

export class ManagedConnectorRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('managed_connector_revision_conflict');
    this.name = 'ManagedConnectorRevisionConflictError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function connectorId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(id)) {
    throw new Error('managed_connector_invalid_id');
  }
  return id;
}

function cloneHealth(
  health: ManagedConnectorHealth | undefined,
): ManagedConnectorHealth | undefined {
  return health ? { ...health } : undefined;
}

function cloneState(state: ManagedConnectorState): ManagedConnectorState {
  return state.lastCheck
    ? { ...state, lastCheck: cloneHealth(state.lastCheck) }
    : { ...state };
}

function defaultState(id: string): ManagedConnectorState {
  return { id: connectorId(id), enabled: true, revision: 0 };
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

function normalizeState(value: unknown): ManagedConnectorFileState {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<ManagedConnectorFileState>)
      : {};
  const connectors = Array.isArray(record.connectors)
    ? record.connectors
        .filter(
          (item): item is ManagedConnectorState =>
            Boolean(
              item &&
                typeof item === 'object' &&
                typeof item.id === 'string' &&
                typeof item.enabled === 'boolean' &&
                Number.isInteger(item.revision) &&
                item.revision >= 0,
            ),
        )
        .map((item) => ({
          ...cloneState(item),
          id: connectorId(item.id),
          revision: Math.floor(item.revision),
        }))
    : [];
  const audit = Array.isArray(record.audit)
    ? record.audit.filter(
        (item): item is ManagedConnectorAuditRecord =>
          Boolean(
            item &&
              typeof item === 'object' &&
              typeof item.id === 'string' &&
              typeof item.connectorId === 'string' &&
              typeof item.action === 'string' &&
              typeof item.actor === 'string' &&
              typeof item.at === 'string' &&
              item.snapshot,
          ),
      )
    : [];
  return { version: 1, connectors, audit };
}

export class FileManagedConnectorStore {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'managed-connectors.json');
    this.lockFile = `${this.stateFile}.lock`;
  }

  private async load(): Promise<ManagedConnectorFileState> {
    try {
      return normalizeState(JSON.parse(await fs.readFile(this.stateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, connectors: [], audit: [] };
      }
      throw error;
    }
  }

  private async save(state: ManagedConnectorFileState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporaryFile, this.stateFile);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const owner = `${process.pid}:${randomUUID()}`;
        const handle = await fs.open(this.lockFile, 'wx');
        await handle.writeFile(`${owner}\n${now()}\n`, 'utf8');
        return async () => {
          await handle.close().catch(() => undefined);
          const currentOwner = await fs
            .readFile(this.lockFile, 'utf8')
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
          .then(([stat, value]) => {
            const pid = Number(value.split(':', 1)[0]);
            return Date.now() - stat.mtimeMs > 30_000 && !processIsAlive(pid);
          })
          .catch(() => false);
        if (stale) {
          await fs.unlink(this.lockFile).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error('managed_connector_store_lock_timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
  }

  private async mutate<T>(
    operation: (state: ManagedConnectorFileState) => T,
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
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async get(idValue: string): Promise<ManagedConnectorState> {
    await this.mutationQueue;
    const id = connectorId(idValue);
    const state = await this.load();
    return cloneState(
      state.connectors.find((item) => item.id === id) ?? defaultState(id),
    );
  }

  async list(ids: string[]): Promise<ManagedConnectorState[]> {
    await this.mutationQueue;
    const state = await this.load();
    return [...new Set(ids.map(connectorId))].map((id) =>
      cloneState(
        state.connectors.find((item) => item.id === id) ?? defaultState(id),
      ),
    );
  }

  async isEnabled(id: string): Promise<boolean> {
    return (await this.get(id)).enabled;
  }

  async setEnabled(input: {
    id: string;
    enabled: boolean;
    expectedRevision?: number;
    actor?: string;
  }): Promise<ManagedConnectorState> {
    return this.mutate((state) => {
      const id = connectorId(input.id);
      const index = state.connectors.findIndex((item) => item.id === id);
      const current = index >= 0 ? state.connectors[index] : defaultState(id);
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== current.revision
      ) {
        throw new ManagedConnectorRevisionConflictError(current.revision);
      }
      const timestamp = now();
      const actor = input.actor?.trim() || 'operator';
      const next: ManagedConnectorState = {
        ...cloneState(current),
        enabled: input.enabled,
        revision: current.revision + 1,
        updatedAt: timestamp,
        updatedBy: actor,
      };
      if (index >= 0) state.connectors.splice(index, 1, next);
      else state.connectors.push(next);
      state.audit.push({
        id: randomUUID(),
        connectorId: id,
        action: input.enabled ? 'connector.enabled' : 'connector.disabled',
        actor,
        at: timestamp,
        snapshot: cloneState(next),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneState(next);
    });
  }

  async recordHealth(input: {
    id: string;
    health: ManagedConnectorHealth;
    actor?: string;
  }): Promise<ManagedConnectorState> {
    return this.mutate((state) => {
      const id = connectorId(input.id);
      const index = state.connectors.findIndex((item) => item.id === id);
      const current = index >= 0 ? state.connectors[index] : defaultState(id);
      const actor = input.actor?.trim() || 'operator';
      const next = {
        ...cloneState(current),
        lastCheck: cloneHealth(input.health),
      };
      if (index >= 0) state.connectors.splice(index, 1, next);
      else state.connectors.push(next);
      state.audit.push({
        id: randomUUID(),
        connectorId: id,
        action: 'connector.checked',
        actor,
        at: input.health.checkedAt,
        snapshot: cloneState(next),
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneState(next);
    });
  }

  async listAudit(limit = 200): Promise<ManagedConnectorAuditRecord[]> {
    await this.mutationQueue;
    const state = await this.load();
    return state.audit
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((item) => ({ ...item, snapshot: cloneState(item.snapshot) }));
  }
}
