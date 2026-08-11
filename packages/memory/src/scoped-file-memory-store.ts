import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MemoryForgetRequest,
  MemoryQuery,
  MemoryScope,
  MemoryScopeKind,
  MemoryStore,
  MemoryWriteRequest,
  ScopedMemorySnapshot,
  SourceThread,
} from '@opentag/core';

const DEFAULT_SCOPE_ORDER: MemoryScopeKind[] = [
  'global',
  'workspace',
  'project',
  'thread',
];

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]/g, '_') || 'default';
}

function threadKey(thread: SourceThread): string {
  return safeSegment(`${thread.platform}-${thread.externalId}`);
}

function workspaceIdFor(query: MemoryQuery): string {
  return query.workspace?.id || query.thread.workspaceId || 'default-workspace';
}

function projectIdFor(query: MemoryQuery): string {
  if (query.project?.id) return query.project.id;
  if (query.thread.projectId) return query.thread.projectId;
  const projectKey = query.thread.channelId || 'general';
  return `${workspaceIdFor(query)}:${safeSegment(projectKey)}`;
}

function scopeFor(query: MemoryQuery, kind: MemoryScopeKind): MemoryScope {
  switch (kind) {
    case 'global':
      return { kind, label: 'Global memory' };
    case 'workspace': {
      const workspaceId = workspaceIdFor(query);
      return {
        kind,
        workspaceId,
        label: `Workspace memory / ${workspaceId}`,
      };
    }
    case 'project': {
      const workspaceId = workspaceIdFor(query);
      const projectId = projectIdFor(query);
      return {
        kind,
        workspaceId,
        projectId,
        label: `Project memory / ${projectId}`,
      };
    }
    case 'thread':
      return {
        kind,
        workspaceId: workspaceIdFor(query),
        projectId: projectIdFor(query),
        threadId: query.thread.id,
        label: `Thread memory / ${query.thread.id}`,
      };
  }
}

export class ScopedFileMemoryStore implements MemoryStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private fileForScope(query: MemoryQuery, kind: MemoryScopeKind): string {
    const workspaceId = safeSegment(workspaceIdFor(query));
    const projectId = safeSegment(projectIdFor(query));
    switch (kind) {
      case 'global':
        return path.join(this.rootDir, 'global.md');
      case 'workspace':
        return path.join(this.rootDir, 'workspaces', workspaceId, 'memory.md');
      case 'project':
        return path.join(
          this.rootDir,
          'workspaces',
          workspaceId,
          'projects',
          projectId,
          'memory.md',
        );
      case 'thread':
        return path.join(this.rootDir, 'threads', `${threadKey(query.thread)}.md`);
    }
  }

  private async readScope(
    query: MemoryQuery,
    kind: MemoryScopeKind,
  ): Promise<string> {
    try {
      return await fs.readFile(this.fileForScope(query, kind), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async loadMemory(query: MemoryQuery): Promise<ScopedMemorySnapshot> {
    const scopes = query.scopes ?? DEFAULT_SCOPE_ORDER;
    const loaded: ScopedMemorySnapshot['scopes'] = [];
    for (const kind of scopes) {
      const content = (await this.readScope(query, kind)).trim();
      loaded.push({
        scope: scopeFor(query, kind),
        content,
      });
    }
    const text = loaded
      .filter(({ content }) => content)
      .map(({ scope, content }) => `## ${scope.label}\n${content}`)
      .join('\n\n');
    return {
      loadedAt: new Date().toISOString(),
      scopes: loaded,
      text,
    };
  }

  async loadThreadMemory(thread: SourceThread): Promise<string> {
    return (await this.loadMemory({ thread })).text;
  }

  async remember(thread: SourceThread, text: string): Promise<void> {
    await this.rememberScoped({ thread, scope: 'thread', text });
  }

  async rememberScoped(request: MemoryWriteRequest): Promise<void> {
    await fs.mkdir(path.dirname(this.fileForScope(request, request.scope)), {
      recursive: true,
    });
    const line = `- ${new Date().toISOString()} ${request.text.trim()}\n`;
    await fs.appendFile(this.fileForScope(request, request.scope), line, 'utf8');
  }

  async forget(thread: SourceThread, selector: string): Promise<void> {
    await this.forgetScoped({ thread, scope: 'thread', selector });
  }

  async forgetScoped(request: MemoryForgetRequest): Promise<void> {
    const current = await this.readScope(request, request.scope);
    const next = current
      .split('\n')
      .filter((line) => !line.includes(request.selector))
      .join('\n');
    const filePath = this.fileForScope(request, request.scope);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, next.trim() ? `${next}\n` : '', 'utf8');
  }
}
