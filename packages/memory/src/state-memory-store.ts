import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  MemoryDocument,
  MemoryForgetRequest,
  MemoryHistory,
  MemoryHistoryQuery,
  MemoryQuery,
  MemoryRestoreRequest,
  MemoryRevision,
  MemoryRevisionAction,
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

export interface MemoryState {
  version: 1;
  documents: MemoryDocument[];
  revisions: MemoryRevision[];
}

export interface LegacyMemoryImport {
  state: MemoryState;
  imported: boolean;
}

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

export function memoryScopeFor(
  query: MemoryQuery,
  kind: MemoryScopeKind,
): MemoryScope {
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

export function memoryDocumentKey(
  query: MemoryQuery,
  kind: MemoryScopeKind,
): string {
  switch (kind) {
    case 'global':
      return 'global';
    case 'workspace':
      return `workspace:${safeSegment(workspaceIdFor(query))}`;
    case 'project':
      return `project:${safeSegment(workspaceIdFor(query))}:${safeSegment(
        projectIdFor(query),
      )}`;
    case 'thread':
      return `thread:${threadKey(query.thread)}`;
  }
}

export function createEmptyMemoryState(): MemoryState {
  return {
    version: 1,
    documents: [],
    revisions: [],
  };
}

export function normalizeMemoryState(
  input: Partial<MemoryState>,
): MemoryState {
  return {
    version: 1,
    documents: Array.isArray(input.documents) ? input.documents : [],
    revisions: Array.isArray(input.revisions) ? input.revisions : [],
  };
}

function cloneScope(scope: MemoryScope): MemoryScope {
  return { ...scope };
}

function cloneDocument(document: MemoryDocument): MemoryDocument {
  return {
    ...document,
    scope: cloneScope(document.scope),
  };
}

function cloneRevision(revision: MemoryRevision): MemoryRevision {
  return { ...revision };
}

function importedScope(relativePath: string): {
  key: string;
  scope: MemoryScope;
} | undefined {
  if (relativePath === 'global.md') {
    return {
      key: 'global',
      scope: { kind: 'global', label: 'Global memory' },
    };
  }
  const workspace = relativePath.match(/^workspaces\/([^/]+)\/memory\.md$/u);
  if (workspace) {
    const workspaceId = workspace[1];
    return {
      key: `workspace:${workspaceId}`,
      scope: {
        kind: 'workspace',
        workspaceId,
        label: `Workspace memory / ${workspaceId}`,
      },
    };
  }
  const project = relativePath.match(
    /^workspaces\/([^/]+)\/projects\/([^/]+)\/memory\.md$/u,
  );
  if (project) {
    const [, workspaceId, projectId] = project;
    return {
      key: `project:${workspaceId}:${projectId}`,
      scope: {
        kind: 'project',
        workspaceId,
        projectId,
        label: `Project memory / ${projectId}`,
      },
    };
  }
  const thread = relativePath.match(/^threads\/(.+)\.md$/u);
  if (thread) {
    const threadId = thread[1];
    return {
      key: `thread:${threadId}`,
      scope: {
        kind: 'thread',
        threadId,
        label: `Thread memory / ${threadId}`,
      },
    };
  }
  return undefined;
}

function walkFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  visit(rootDir);
  return files;
}

export function readLegacyMemoryState(rootDir: string): LegacyMemoryImport {
  const stateFile = path.join(rootDir, 'memory-state.json');
  if (fs.existsSync(stateFile)) {
    try {
      return {
        state: normalizeMemoryState(
          JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<MemoryState>,
        ),
        imported: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`memory_legacy_import_failed:${stateFile}:${message}`);
    }
  }

  const state = createEmptyMemoryState();
  for (const filePath of walkFiles(rootDir)) {
    if (!filePath.endsWith('.md')) continue;
    const relativePath = path.relative(rootDir, filePath).split(path.sep).join('/');
    const target = importedScope(relativePath);
    if (!target) continue;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) continue;
    const timestamp = fs.statSync(filePath).mtime.toISOString();
    const revisionId = `legacy-${createHash('sha256')
      .update(`${target.key}\0${timestamp}\0${content}`)
      .digest('hex')
      .slice(0, 32)}`;
    state.documents.push({
      key: target.key,
      scope: target.scope,
      content,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      updatedBy: 'system:legacy-import',
      latestRevisionId: revisionId,
    });
    state.revisions.push({
      id: revisionId,
      documentKey: target.key,
      version: 1,
      action: 'import',
      actorId: 'system:legacy-import',
      source: 'legacy-markdown',
      at: timestamp,
      content,
    });
  }
  return {
    state,
    imported: state.documents.length > 0,
  };
}

interface CommitRevisionInput {
  query: MemoryQuery;
  scope: MemoryScopeKind;
  action: MemoryRevisionAction;
  content: string;
  actorId?: string;
  source?: string;
  selector?: string;
  restoredFromRevisionId?: string;
}

function commitRevision(
  state: MemoryState,
  input: CommitRevisionInput,
): MemoryDocument {
  const key = memoryDocumentKey(input.query, input.scope);
  const scope = memoryScopeFor(input.query, input.scope);
  const index = state.documents.findIndex((item) => item.key === key);
  const current = index >= 0 ? state.documents[index] : undefined;
  const timestamp = new Date().toISOString();
  const actorId = input.actorId?.trim() || 'system:unknown';
  const revision: MemoryRevision = {
    id: randomUUID(),
    documentKey: key,
    version: (current?.version ?? 0) + 1,
    action: input.action,
    actorId,
    source: input.source,
    at: timestamp,
    content: input.content,
    selector: input.selector,
    restoredFromRevisionId: input.restoredFromRevisionId,
  };
  const document: MemoryDocument = {
    key,
    scope,
    content: input.content,
    version: revision.version,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
    updatedBy: actorId,
    latestRevisionId: revision.id,
  };
  if (index >= 0) state.documents[index] = document;
  else state.documents.push(document);
  state.revisions.push(revision);
  return cloneDocument(document);
}

export abstract class StateMemoryStore implements MemoryStore {
  protected abstract readState(): Promise<MemoryState>;

  protected abstract mutate<T>(
    operation: (state: MemoryState) => T,
  ): Promise<T>;

  async loadMemory(query: MemoryQuery): Promise<ScopedMemorySnapshot> {
    const state = await this.readState();
    const scopes = query.scopes ?? DEFAULT_SCOPE_ORDER;
    const loaded: ScopedMemorySnapshot['scopes'] = scopes.map((kind) => {
      const scope = memoryScopeFor(query, kind);
      const document = state.documents.find(
        (item) => item.key === memoryDocumentKey(query, kind),
      );
      return {
        scope,
        content: document?.content.trim() ?? '',
        document: document
          ? cloneDocument({ ...document, scope })
          : undefined,
      };
    });
    return {
      loadedAt: new Date().toISOString(),
      scopes: loaded,
      text: loaded
        .filter(({ content }) => content)
        .map(({ scope, content }) => `## ${scope.label}\n${content}`)
        .join('\n\n'),
    };
  }

  async loadThreadMemory(thread: SourceThread): Promise<string> {
    return (await this.loadMemory({ thread })).text;
  }

  async remember(thread: SourceThread, text: string): Promise<void> {
    await this.rememberScoped({
      thread,
      scope: 'thread',
      text,
      actorId: 'system:legacy-api',
      source: 'memory-api',
    });
  }

  async rememberScoped(request: MemoryWriteRequest): Promise<void> {
    const text = request.text.trim();
    if (!text) throw new Error('memory_text_required');
    await this.mutate((state) => {
      const current = state.documents.find(
        (item) => item.key === memoryDocumentKey(request, request.scope),
      );
      const timestamp = new Date().toISOString();
      const line = `- ${timestamp} ${text}`;
      const content = current?.content.trim()
        ? `${current.content.trimEnd()}\n${line}`
        : line;
      commitRevision(state, {
        query: request,
        scope: request.scope,
        action: 'remember',
        content,
        actorId: request.actorId,
        source: request.source,
      });
    });
  }

  async forget(thread: SourceThread, selector: string): Promise<void> {
    await this.forgetScoped({
      thread,
      scope: 'thread',
      selector,
      actorId: 'system:legacy-api',
      source: 'memory-api',
    });
  }

  async forgetScoped(request: MemoryForgetRequest): Promise<void> {
    const selector = request.selector.trim();
    if (!selector) throw new Error('memory_selector_required');
    await this.mutate((state) => {
      const current = state.documents.find(
        (item) => item.key === memoryDocumentKey(request, request.scope),
      );
      const content = (current?.content ?? '')
        .split('\n')
        .filter((line) => !line.includes(selector))
        .join('\n')
        .trim();
      commitRevision(state, {
        query: request,
        scope: request.scope,
        action: 'forget',
        content,
        actorId: request.actorId,
        source: request.source,
        selector,
      });
    });
  }

  async getMemoryHistory(query: MemoryHistoryQuery): Promise<MemoryHistory> {
    const state = await this.readState();
    const key = memoryDocumentKey(query, query.scope);
    const scope = memoryScopeFor(query, query.scope);
    const document = state.documents.find((item) => item.key === key);
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 20)));
    return {
      document: document
        ? cloneDocument({ ...document, scope })
        : undefined,
      revisions: state.revisions
        .filter((revision) => revision.documentKey === key)
        .sort((left, right) => right.version - left.version)
        .slice(0, limit)
        .map(cloneRevision),
    };
  }

  async restoreScoped(request: MemoryRestoreRequest): Promise<MemoryDocument> {
    const revisionId = request.revisionId.trim();
    if (!revisionId) throw new Error('memory_revision_required');
    return this.mutate((state) => {
      const key = memoryDocumentKey(request, request.scope);
      const revision = state.revisions.find(
        (item) => item.id === revisionId && item.documentKey === key,
      );
      if (!revision) throw new Error('memory_revision_not_found');
      return commitRevision(state, {
        query: request,
        scope: request.scope,
        action: 'restore',
        content: revision.content,
        actorId: request.actorId,
        source: request.source,
        restoredFromRevisionId: revision.id,
      });
    });
  }
}
