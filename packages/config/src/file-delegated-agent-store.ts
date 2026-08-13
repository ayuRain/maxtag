import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DelegatedAgentDefinition,
  DelegatedAgentSource,
  MemoryScopeKind,
  ToolGrantKind,
} from '@opentag/core';

export interface DelegatedAgentAuditRecord {
  id: string;
  agentId: string;
  action: 'agent.created' | 'agent.updated' | 'agent.enabled' | 'agent.disabled';
  actor: string;
  at: string;
  revision: number;
}

interface DelegatedAgentFileState {
  version: 1;
  agents: DelegatedAgentDefinition[];
  audit: DelegatedAgentAuditRecord[];
}

export class DelegatedAgentRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('delegated_agent_revision_conflict');
    this.name = 'DelegatedAgentRevisionConflictError';
  }
}

function now(): string {
  return new Date().toISOString();
}

export function normalizeDelegatedAgentId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id)) {
    throw new Error('delegated_agent_invalid_id');
  }
  return id;
}

function cleanText(value: string, limit: number, error: string): string {
  const text = value.replace(/\r\n?/gu, '\n').replace(/\0/gu, '').trim();
  if (!text || text.length > limit) throw new Error(error);
  return text;
}

function containsCredential(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:api[_ -]?key|app[_ -]?secret|client[_ -]?secret|password|passwd|access[_ -]?token|refresh[_ -]?token|verification[_ -]?token)\b\s*[:=]\s*\S+/iu.test(
      value,
    )
  );
}

function ids(values: string[] | undefined, maximum = 50): string[] {
  const result = [
    ...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)),
  ];
  if (result.length > maximum) throw new Error('delegated_agent_too_many_assignments');
  if (result.some((value) => !/^[a-z0-9][a-z0-9:_.-]{0,159}$/u.test(value))) {
    throw new Error('delegated_agent_invalid_assignment');
  }
  return result;
}

function grantKinds(values: ToolGrantKind[] | undefined): ToolGrantKind[] {
  return ids(values, 30);
}

function memoryScopes(values: MemoryScopeKind[] | undefined): MemoryScopeKind[] {
  const allowed: MemoryScopeKind[] = ['workspace', 'project', 'channel', 'thread'];
  return [...new Set((values ?? []).filter((value) => allowed.includes(value)))];
}

function networkHosts(values: string[] | undefined): string[] {
  const result = [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase().replace(/\.$/u, ''))
        .filter(Boolean),
    ),
  ];
  if (result.length > 50) throw new Error('delegated_agent_too_many_network_hosts');
  if (
    result.some(
      (value) =>
        !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(value) ||
        value.includes('..'),
    )
  ) {
    throw new Error('delegated_agent_invalid_network_host');
  }
  return result;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  error: string,
): number {
  const result = value === undefined ? fallback : Math.floor(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(error);
  }
  return result;
}

function cloneAgent(agent: DelegatedAgentDefinition): DelegatedAgentDefinition {
  return {
    ...agent,
    skillIds: [...agent.skillIds],
    grantKinds: [...agent.grantKinds],
    memoryScopes: [...agent.memoryScopes],
    networkHosts: [...agent.networkHosts],
  };
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

function normalizeAgent(value: unknown): DelegatedAgentDefinition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<DelegatedAgentDefinition>;
  try {
    if (
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.description !== 'string' ||
      typeof item.instructions !== 'string' ||
      typeof item.executorId !== 'string' ||
      typeof item.enabled !== 'boolean' ||
      !Number.isInteger(item.revision) ||
      typeof item.createdAt !== 'string' ||
      typeof item.updatedAt !== 'string'
    ) {
      return undefined;
    }
    return {
      id: normalizeDelegatedAgentId(item.id),
      name: cleanText(item.name, 120, 'delegated_agent_invalid_name'),
      description: cleanText(
        item.description,
        500,
        'delegated_agent_invalid_description',
      ),
      instructions: cleanText(
        item.instructions,
        16_000,
        'delegated_agent_invalid_instructions',
      ),
      executorId: cleanText(
        item.executorId,
        64,
        'delegated_agent_invalid_executor',
      ),
      model: item.model?.trim().slice(0, 120) || undefined,
      enabled: item.enabled,
      revision: Math.max(1, Math.floor(item.revision!)),
      skillIds: ids(item.skillIds),
      grantKinds: grantKinds(
        item.grantKinds ??
          (item as Partial<DelegatedAgentDefinition> & { grantIds?: string[] })
            .grantIds?.map((id) => id.split(':', 1)[0]),
      ),
      memoryScopes: memoryScopes(item.memoryScopes),
      networkHosts: networkHosts(item.networkHosts),
      maxTurns: boundedInteger(
        item.maxTurns,
        10,
        1,
        30,
        'delegated_agent_invalid_max_turns',
      ),
      timeoutMs: boundedInteger(
        item.timeoutMs,
        300_000,
        5_000,
        300_000,
        'delegated_agent_invalid_timeout',
      ),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function normalizeState(value: unknown): DelegatedAgentFileState {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<DelegatedAgentFileState>)
      : {};
  return {
    version: 1,
    agents: Array.isArray(record.agents)
      ? record.agents.flatMap((item) => {
          const agent = normalizeAgent(item);
          return agent ? [agent] : [];
        })
      : [],
    audit: Array.isArray(record.audit)
      ? record.audit.filter(
          (item): item is DelegatedAgentAuditRecord =>
            Boolean(
              item &&
                typeof item.id === 'string' &&
                typeof item.agentId === 'string' &&
                typeof item.action === 'string' &&
                typeof item.actor === 'string' &&
                typeof item.at === 'string' &&
                Number.isInteger(item.revision),
            ),
        )
      : [],
  };
}

export class FileDelegatedAgentStore implements DelegatedAgentSource {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'delegated-agents.json');
    this.lockFile = `${this.stateFile}.lock`;
  }

  private async load(): Promise<DelegatedAgentFileState> {
    try {
      return normalizeState(JSON.parse(await fs.readFile(this.stateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, agents: [], audit: [] };
      }
      throw error;
    }
  }

  private async save(state: DelegatedAgentFileState): Promise<void> {
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
          throw new Error('delegated_agent_store_lock_timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
  }

  private async mutate<T>(
    operation: (state: DelegatedAgentFileState) => T,
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

  async list(
    input: { ids?: string[]; includeDisabled?: boolean } = {},
  ): Promise<DelegatedAgentDefinition[]> {
    await this.mutationQueue;
    const requested = input.ids
      ? [...new Set(input.ids.map(normalizeDelegatedAgentId))]
      : undefined;
    const agents = (await this.load()).agents
      .filter((agent) => input.includeDisabled || agent.enabled)
      .map(cloneAgent);
    if (!requested) return agents.sort((a, b) => a.name.localeCompare(b.name));
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    return requested.flatMap((id) => {
      const agent = byId.get(id);
      return agent ? [agent] : [];
    });
  }

  async get(idValue: string): Promise<DelegatedAgentDefinition | undefined> {
    await this.mutationQueue;
    const id = normalizeDelegatedAgentId(idValue);
    const agent = (await this.load()).agents.find((item) => item.id === id);
    return agent ? cloneAgent(agent) : undefined;
  }

  async upsert(input: {
    id: string;
    name: string;
    description: string;
    instructions: string;
    executorId: string;
    model?: string;
    skillIds?: string[];
    grantKinds?: ToolGrantKind[];
    memoryScopes?: MemoryScopeKind[];
    networkHosts?: string[];
    maxTurns?: number;
    timeoutMs?: number;
    expectedRevision?: number;
    actor?: string;
  }): Promise<DelegatedAgentDefinition> {
    const id = normalizeDelegatedAgentId(input.id);
    const name = cleanText(input.name, 120, 'delegated_agent_invalid_name');
    const description = cleanText(
      input.description,
      500,
      'delegated_agent_invalid_description',
    );
    const instructions = cleanText(
      input.instructions,
      16_000,
      'delegated_agent_invalid_instructions',
    );
    const executorId = cleanText(
      input.executorId,
      64,
      'delegated_agent_invalid_executor',
    );
    const model = input.model?.trim().slice(0, 120) || undefined;
    if (containsCredential(`${description}\n${instructions}`)) {
      throw new Error('delegated_agent_credentials_not_allowed');
    }
    return this.mutate((state) => {
      const index = state.agents.findIndex((agent) => agent.id === id);
      const current = index >= 0 ? state.agents[index] : undefined;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== (current?.revision ?? 0)
      ) {
        throw new DelegatedAgentRevisionConflictError(current?.revision ?? 0);
      }
      const timestamp = now();
      const agent: DelegatedAgentDefinition = {
        id,
        name,
        description,
        instructions,
        executorId,
        model,
        skillIds: ids(input.skillIds),
        grantKinds: grantKinds(input.grantKinds),
        memoryScopes: memoryScopes(input.memoryScopes),
        networkHosts: networkHosts(input.networkHosts),
        maxTurns: boundedInteger(
          input.maxTurns,
          10,
          1,
          30,
          'delegated_agent_invalid_max_turns',
        ),
        timeoutMs: boundedInteger(
          input.timeoutMs,
          300_000,
          5_000,
          300_000,
          'delegated_agent_invalid_timeout',
        ),
        enabled: current?.enabled ?? true,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (index >= 0) state.agents.splice(index, 1, agent);
      else state.agents.push(agent);
      state.audit.push({
        id: randomUUID(),
        agentId: id,
        action: current ? 'agent.updated' : 'agent.created',
        actor: input.actor?.trim() || 'operator',
        at: timestamp,
        revision: agent.revision,
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneAgent(agent);
    });
  }

  async setEnabled(input: {
    id: string;
    enabled: boolean;
    expectedRevision?: number;
    actor?: string;
  }): Promise<DelegatedAgentDefinition> {
    return this.mutate((state) => {
      const id = normalizeDelegatedAgentId(input.id);
      const index = state.agents.findIndex((agent) => agent.id === id);
      if (index < 0) throw new Error('delegated_agent_not_found');
      const current = state.agents[index];
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== current.revision
      ) {
        throw new DelegatedAgentRevisionConflictError(current.revision);
      }
      const agent = {
        ...cloneAgent(current),
        enabled: input.enabled,
        revision: current.revision + 1,
        updatedAt: now(),
      };
      state.agents.splice(index, 1, agent);
      state.audit.push({
        id: randomUUID(),
        agentId: id,
        action: input.enabled ? 'agent.enabled' : 'agent.disabled',
        actor: input.actor?.trim() || 'operator',
        at: agent.updatedAt,
        revision: agent.revision,
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneAgent(agent);
    });
  }

  async listAudit(limit = 200): Promise<DelegatedAgentAuditRecord[]> {
    await this.mutationQueue;
    return (await this.load()).audit
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((record) => ({ ...record }));
  }
}
