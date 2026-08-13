import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentSkill, AgentSkillSource } from '@opentag/core';

export interface AgentSkillAuditRecord {
  id: string;
  skillId: string;
  action: 'skill.created' | 'skill.updated' | 'skill.enabled' | 'skill.disabled';
  actor: string;
  at: string;
  revision: number;
}

interface AgentSkillFileState {
  version: 1;
  skills: AgentSkill[];
  audit: AgentSkillAuditRecord[];
}

export class AgentSkillRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('agent_skill_revision_conflict');
    this.name = 'AgentSkillRevisionConflictError';
  }
}

function now(): string {
  return new Date().toISOString();
}

export function normalizeAgentSkillId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(id)) {
    throw new Error('agent_skill_invalid_id');
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

function cloneSkill(skill: AgentSkill): AgentSkill {
  return { ...skill };
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

function normalizeState(value: unknown): AgentSkillFileState {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AgentSkillFileState>)
      : {};
  const skills = Array.isArray(record.skills)
    ? record.skills.flatMap((item) => {
        try {
          if (
            !item ||
            typeof item !== 'object' ||
            typeof item.id !== 'string' ||
            typeof item.name !== 'string' ||
            typeof item.description !== 'string' ||
            typeof item.content !== 'string' ||
            typeof item.enabled !== 'boolean' ||
            !Number.isInteger(item.revision) ||
            typeof item.createdAt !== 'string' ||
            typeof item.updatedAt !== 'string'
          ) {
            return [];
          }
          return [
            {
              ...cloneSkill(item),
              id: normalizeAgentSkillId(item.id),
              revision: Math.max(1, Math.floor(item.revision)),
            },
          ];
        } catch {
          return [];
        }
      })
    : [];
  const audit = Array.isArray(record.audit)
    ? record.audit.filter(
        (item): item is AgentSkillAuditRecord =>
          Boolean(
            item &&
              typeof item === 'object' &&
              typeof item.id === 'string' &&
              typeof item.skillId === 'string' &&
              typeof item.action === 'string' &&
              typeof item.actor === 'string' &&
              typeof item.at === 'string' &&
              Number.isInteger(item.revision),
          ),
      )
    : [];
  return { version: 1, skills, audit };
}

export class FileAgentSkillStore implements AgentSkillSource {
  private readonly stateFile: string;
  private readonly lockFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'agent-skills.json');
    this.lockFile = `${this.stateFile}.lock`;
  }

  private async load(): Promise<AgentSkillFileState> {
    try {
      return normalizeState(JSON.parse(await fs.readFile(this.stateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, skills: [], audit: [] };
      }
      throw error;
    }
  }

  private async save(state: AgentSkillFileState): Promise<void> {
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
        if (Date.now() >= deadline) throw new Error('agent_skill_store_lock_timeout');
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      }
    }
  }

  private async mutate<T>(operation: (state: AgentSkillFileState) => T): Promise<T> {
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

  async list(input: { ids?: string[]; includeDisabled?: boolean } = {}): Promise<AgentSkill[]> {
    await this.mutationQueue;
    const ids = input.ids
      ? [...new Set(input.ids.map(normalizeAgentSkillId))]
      : undefined;
    const state = await this.load();
    const skills = state.skills
      .filter((skill) => input.includeDisabled || skill.enabled)
      .map(cloneSkill);
    if (!ids) return skills.sort((a, b) => a.name.localeCompare(b.name));
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    return ids.flatMap((id) => {
      const skill = byId.get(id);
      return skill ? [skill] : [];
    });
  }

  async get(idValue: string): Promise<AgentSkill | undefined> {
    await this.mutationQueue;
    const id = normalizeAgentSkillId(idValue);
    const state = await this.load();
    const skill = state.skills.find((item) => item.id === id);
    return skill ? cloneSkill(skill) : undefined;
  }

  async upsert(input: {
    id: string;
    name: string;
    description: string;
    content: string;
    expectedRevision?: number;
    actor?: string;
  }): Promise<AgentSkill> {
    const id = normalizeAgentSkillId(input.id);
    const name = cleanText(input.name, 120, 'agent_skill_invalid_name');
    const description = cleanText(
      input.description,
      500,
      'agent_skill_invalid_description',
    );
    const content = cleanText(input.content, 24_000, 'agent_skill_invalid_content');
    if (containsCredential(`${description}\n${content}`)) {
      throw new Error('agent_skill_credentials_not_allowed');
    }
    return this.mutate((state) => {
      const index = state.skills.findIndex((skill) => skill.id === id);
      const current = index >= 0 ? state.skills[index] : undefined;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== (current?.revision ?? 0)
      ) {
        throw new AgentSkillRevisionConflictError(current?.revision ?? 0);
      }
      const timestamp = now();
      const revision = (current?.revision ?? 0) + 1;
      const skill: AgentSkill = {
        id,
        name,
        description,
        content,
        enabled: current?.enabled ?? true,
        revision,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (index >= 0) state.skills.splice(index, 1, skill);
      else state.skills.push(skill);
      state.audit.push({
        id: randomUUID(),
        skillId: id,
        action: current ? 'skill.updated' : 'skill.created',
        actor: input.actor?.trim() || 'operator',
        at: timestamp,
        revision,
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneSkill(skill);
    });
  }

  async setEnabled(input: {
    id: string;
    enabled: boolean;
    expectedRevision?: number;
    actor?: string;
  }): Promise<AgentSkill> {
    return this.mutate((state) => {
      const id = normalizeAgentSkillId(input.id);
      const index = state.skills.findIndex((skill) => skill.id === id);
      if (index < 0) throw new Error('agent_skill_not_found');
      const current = state.skills[index];
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== current.revision
      ) {
        throw new AgentSkillRevisionConflictError(current.revision);
      }
      const timestamp = now();
      const skill = {
        ...cloneSkill(current),
        enabled: input.enabled,
        revision: current.revision + 1,
        updatedAt: timestamp,
      };
      state.skills.splice(index, 1, skill);
      state.audit.push({
        id: randomUUID(),
        skillId: id,
        action: input.enabled ? 'skill.enabled' : 'skill.disabled',
        actor: input.actor?.trim() || 'operator',
        at: timestamp,
        revision: skill.revision,
      });
      if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
      return cloneSkill(skill);
    });
  }

  async listAudit(limit = 200): Promise<AgentSkillAuditRecord[]> {
    await this.mutationQueue;
    const state = await this.load();
    return state.audit
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((record) => ({ ...record }));
  }
}
