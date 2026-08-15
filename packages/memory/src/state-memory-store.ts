import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  MemoryDocument,
  MemoryCompactionQuery,
  MemoryCompactionResult,
  MemoryDiff,
  MemoryDiffLine,
  MemoryDiffQuery,
  MemoryExport,
  MemoryExportQuery,
  MemoryExpiryAuditRecord,
  MemoryExpiryEntry,
  MemoryExpiryQuery,
  MemoryExpirySnapshot,
  MemoryExpiryUpdateInput,
  MemoryForgetRequest,
  MemoryHistory,
  MemoryHistoryQuery,
  MemoryProposal,
  MemoryProposalDecisionInput,
  MemoryProposalInput,
  MemoryProposalListQuery,
  MemoryQuery,
  MemoryRestoreRequest,
  MemorySearchQuery,
  MemorySearchResult,
  MemorySemanticIndexEntry,
  MemorySemanticIndexQuery,
  MemoryRevision,
  MemoryRevisionAction,
  MemoryScope,
  MemoryScopeKind,
  MemoryStore,
  MemoryWriteRequest,
  ScopedMemorySnapshot,
  SourceThread,
} from '@opentag/core';
import { memoryExpiryFromRetentionDays, normalizedMemoryRetentionDays } from '@opentag/core';

const DEFAULT_SCOPE_ORDER: MemoryScopeKind[] = [
  'global',
  'workspace',
  'project',
  'channel',
  'thread',
];

export interface MemoryState {
  version: 1;
  documents: MemoryDocument[];
  revisions: MemoryRevision[];
  proposals: MemoryProposal[];
  semanticIndex: MemorySemanticIndexEntry[];
  expiry: MemoryExpiryEntry[];
  expiryAudit: MemoryExpiryAuditRecord[];
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

function channelIdFor(query: MemoryQuery): string {
  return query.thread.channelId || query.thread.externalId;
}

export function memoryScopeFor(
  query: MemoryQuery,
  kind: MemoryScopeKind,
): MemoryScope {
  switch (kind) {
    case 'global':
      return { kind, label: 'Installation memory' };
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
    case 'channel': {
      const workspaceId = workspaceIdFor(query);
      const projectId = projectIdFor(query);
      const channelId = channelIdFor(query);
      return {
        kind,
        workspaceId,
        projectId,
        platform: query.thread.platform,
        channelId,
        label: `Channel memory / ${query.thread.platform}:${channelId}`,
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
    case 'channel':
      return `channel:${safeSegment(workspaceIdFor(query))}:${safeSegment(
        query.thread.platform,
      )}:${safeSegment(channelIdFor(query))}`;
    case 'thread':
      return `thread:${threadKey(query.thread)}`;
  }
}

export function createEmptyMemoryState(): MemoryState {
  return {
    version: 1,
    documents: [],
    revisions: [],
    proposals: [],
    semanticIndex: [],
    expiry: [],
    expiryAudit: [],
  };
}

export function normalizeMemoryState(
  input: Partial<MemoryState>,
): MemoryState {
  const semanticIndex = Array.isArray(input.semanticIndex)
    ? input.semanticIndex.flatMap((candidate) => {
        if (
          !candidate ||
          typeof candidate.documentKey !== 'string' ||
          !Number.isInteger(candidate.version) ||
          candidate.version < 1 ||
          !Number.isInteger(candidate.lineNumber) ||
          candidate.lineNumber < 1 ||
          typeof candidate.lineHash !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(candidate.lineHash) ||
          !Array.isArray(candidate.aliases) ||
          typeof candidate.indexedAt !== 'string' ||
          typeof candidate.indexedBy !== 'string'
        ) {
          return [];
        }
        const aliases = normalizeSearchAliases(candidate.aliases);
        return aliases.length
          ? [{ ...candidate, documentKey: candidate.documentKey.trim(), aliases }]
          : [];
      })
    : [];
  const expiry = Array.isArray(input.expiry)
    ? input.expiry.filter(isValidExpiryEntry).map((entry) => ({ ...entry }))
    : [];
  const expiryAudit = Array.isArray(input.expiryAudit)
    ? input.expiryAudit.filter(isValidExpiryAuditRecord).map((record) => ({ ...record }))
    : [];
  return {
    version: 1,
    documents: Array.isArray(input.documents) ? input.documents : [],
    revisions: Array.isArray(input.revisions) ? input.revisions : [],
    proposals: Array.isArray(input.proposals) ? input.proposals : [],
    semanticIndex,
    expiry,
    expiryAudit,
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
  return {
    ...revision,
    selectors: revision.selectors ? [...revision.selectors] : undefined,
  };
}

function cloneProposal(proposal: MemoryProposal): MemoryProposal {
  return {
    ...proposal,
    selectors: proposal.selectors ? [...proposal.selectors] : undefined,
    searchAliases: proposal.searchAliases ? [...proposal.searchAliases] : undefined,
    scopeRef: cloneScope(proposal.scopeRef),
    thread: {
      ...proposal.thread,
      metadata: proposal.thread.metadata
        ? { ...proposal.thread.metadata }
        : undefined,
    },
    workspace: proposal.workspace
      ? {
          ...proposal.workspace,
          metadata: proposal.workspace.metadata
            ? { ...proposal.workspace.metadata }
            : undefined,
        }
      : undefined,
    project: proposal.project
      ? {
          ...proposal.project,
          metadata: proposal.project.metadata
            ? { ...proposal.project.metadata }
            : undefined,
          platformBindings: proposal.project.platformBindings?.map((binding) => ({
            ...binding,
          })),
        }
      : undefined,
  };
}

function normalizeSearchAliases(values: string[] | undefined): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const alias = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').slice(0, 160);
    const key = alias.toLocaleLowerCase();
    if (alias.length < 2 || seen.has(key)) continue;
    aliases.push(alias);
    seen.add(key);
    if (aliases.length >= 6) break;
  }
  return aliases;
}

function memoryLineHash(line: string): string {
  return createHash('sha256').update(line).digest('hex');
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isValidExpiryEntry(value: unknown): value is MemoryExpiryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<MemoryExpiryEntry>;
  return Boolean(
    typeof entry.documentKey === 'string' &&
      Number.isInteger(entry.version) &&
      (entry.version ?? 0) > 0 &&
      Number.isInteger(entry.lineNumber) &&
      (entry.lineNumber ?? 0) > 0 &&
      typeof entry.lineHash === 'string' &&
      /^[a-f0-9]{64}$/u.test(entry.lineHash) &&
      validIsoTimestamp(entry.expiresAt) &&
      validIsoTimestamp(entry.setAt) &&
      typeof entry.setBy === 'string'
  );
}

function isValidExpiryAuditRecord(
  value: unknown,
): value is MemoryExpiryAuditRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<MemoryExpiryAuditRecord>;
  return Boolean(
    typeof record.id === 'string' &&
      (record.action === 'set' || record.action === 'clear') &&
      typeof record.documentKey === 'string' &&
      Number.isInteger(record.version) &&
      Number.isInteger(record.lineNumber) &&
      typeof record.lineHash === 'string' &&
      /^[a-f0-9]{64}$/u.test(record.lineHash) &&
      typeof record.actorId === 'string' &&
      validIsoTimestamp(record.at) &&
      (record.expiresAt === undefined || validIsoTimestamp(record.expiresAt))
  );
}

function activeExpiryForLine(
  state: MemoryState,
  document: MemoryDocument,
  line: string,
  lineNumber: number,
): MemoryExpiryEntry | undefined {
  const hash = memoryLineHash(line);
  return state.expiry.find(
    (entry) =>
      entry.documentKey === document.key &&
      entry.version === document.version &&
      entry.lineNumber === lineNumber &&
      entry.lineHash === hash,
  );
}

function isExpired(entry: MemoryExpiryEntry | undefined, now: number): boolean {
  return Boolean(entry && Date.parse(entry.expiresAt) <= now);
}

function normalizedExpiryAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('memory_expiry_invalid_timestamp');
  const max = Date.now() + 10 * 366 * 24 * 60 * 60 * 1_000;
  if (time > max) throw new Error('memory_expiry_too_far');
  return new Date(time).toISOString();
}

function updateExpiryForLine(
  state: MemoryState,
  input: {
    document: MemoryDocument;
    line: string;
    lineNumber: number;
    expiresAt?: string;
    actorId?: string;
    source?: string;
  },
): void {
  const actorId = input.actorId?.trim() || 'system:unknown';
  const lineHash = memoryLineHash(input.line);
  const timestamp = new Date().toISOString();
  const expiresAt = normalizedExpiryAt(input.expiresAt);
  const index = state.expiry.findIndex(
    (entry) =>
      entry.documentKey === input.document.key &&
      entry.version === input.document.version &&
      entry.lineNumber === input.lineNumber &&
      entry.lineHash === lineHash,
  );
  if (expiresAt) {
    const entry: MemoryExpiryEntry = {
      documentKey: input.document.key,
      version: input.document.version,
      lineNumber: input.lineNumber,
      lineHash,
      expiresAt,
      setAt: timestamp,
      setBy: actorId,
      source: input.source,
    };
    if (index >= 0) state.expiry[index] = entry;
    else state.expiry.push(entry);
  } else if (index >= 0) {
    state.expiry.splice(index, 1);
  } else {
    return;
  }
  state.expiryAudit.push({
    id: randomUUID(),
    action: expiresAt ? 'set' : 'clear',
    documentKey: input.document.key,
    version: input.document.version,
    lineNumber: input.lineNumber,
    lineHash,
    expiresAt,
    actorId,
    source: input.source,
    at: timestamp,
  });
}

function reconcileSemanticIndex(
  state: MemoryState,
  documentKey: string,
  previousVersion: number | undefined,
  nextVersion: number,
  content: string,
): void {
  const lines = content.split('\n');
  const available = new Map<string, number[]>();
  for (const [index, line] of lines.entries()) {
    const hash = memoryLineHash(line);
    const positions = available.get(hash) ?? [];
    positions.push(index + 1);
    available.set(hash, positions);
  }
  const retained = state.semanticIndex.flatMap((entry) => {
    if (entry.documentKey !== documentKey) return [entry];
    if (entry.version !== previousVersion) return [];
    const positions = available.get(entry.lineHash);
    const lineNumber = positions?.shift();
    return lineNumber
      ? [{ ...entry, version: nextVersion, lineNumber }]
      : [];
  });
  state.semanticIndex = retained;
}

function reconcileExpiry(
  state: MemoryState,
  documentKey: string,
  previousVersion: number | undefined,
  nextVersion: number,
  content: string,
): void {
  const lines = content.split('\n');
  const available = new Map<string, number[]>();
  for (const [index, line] of lines.entries()) {
    const hash = memoryLineHash(line);
    const positions = available.get(hash) ?? [];
    positions.push(index + 1);
    available.set(hash, positions);
  }
  state.expiry = state.expiry.flatMap((entry) => {
    if (entry.documentKey !== documentKey) return [entry];
    if (entry.version !== previousVersion) return [];
    const positions = available.get(entry.lineHash);
    const lineNumber = positions?.shift();
    return lineNumber ? [{ ...entry, version: nextVersion, lineNumber }] : [];
  });
}

function lineCounts(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function consumeCount(counts: Map<string, number>, line: string): boolean {
  const count = counts.get(line) ?? 0;
  if (count <= 0) return false;
  if (count === 1) counts.delete(line);
  else counts.set(line, count - 1);
  return true;
}

function rememberedContent(current: MemoryDocument | undefined, text: string): string {
  const timestamp = new Date().toISOString();
  const line = `- ${timestamp} ${text}`;
  return current?.content.trim()
    ? `${current.content.trimEnd()}\n${line}`
    : line;
}

function forgottenContent(current: MemoryDocument | undefined, selector: string): string {
  return (current?.content ?? '')
    .split('\n')
    .filter((line) => !line.includes(selector))
    .join('\n')
    .trim();
}

function replacedContent(
  current: MemoryDocument | undefined,
  selector: string,
  text: string,
): string {
  const withoutOldValue = forgottenContent(current, selector);
  return rememberedContent(
    withoutOldValue
      ? {
          ...current!,
          content: withoutOldValue,
        }
      : undefined,
    text,
  );
}

function mergedContent(
  current: MemoryDocument | undefined,
  selectors: string[],
  text: string,
): string {
  const lines = current?.content.split('\n') ?? [];
  const removed = new Set<number>();
  for (const selector of selectors) {
    const matchingIndex = lines.findIndex(
      (line, index) => !removed.has(index) && line.includes(selector),
    );
    if (matchingIndex < 0) continue;
    for (const index of memoryEntryLineRange(lines, matchingIndex)) {
      removed.add(index);
    }
  }
  const withoutSources = lines
    .filter((_line, index) => !removed.has(index))
    .join('\n')
    .trim();
  return rememberedContent(
    withoutSources
      ? {
          ...current!,
          content: withoutSources,
        }
      : undefined,
    text,
  );
}

function documentContainsSelector(
  current: MemoryDocument | undefined,
  selector: string,
): boolean {
  return Boolean(
    selector.trim() &&
      current?.content.split('\n').some((line) => line.includes(selector)),
  );
}

function documentContainsDistinctSelectors(
  current: MemoryDocument | undefined,
  selectors: string[],
): boolean {
  const lines = current?.content.split('\n') ?? [];
  const matchedEntries = new Set<number>();
  for (const selector of selectors) {
    const matchingIndex = lines.findIndex((line) => line.includes(selector));
    if (matchingIndex < 0) return false;
    const entryIndex = memoryEntryLineRange(lines, matchingIndex)[0];
    if (matchedEntries.has(entryIndex)) return false;
    matchedEntries.add(entryIndex);
  }
  return matchedEntries.size === selectors.length;
}

function memoryEntryLineRange(lines: string[], matchingIndex: number): number[] {
  const entryStart = /^- \d{4}-\d{2}-\d{2}T/u;
  let start = matchingIndex;
  while (start > 0 && !entryStart.test(lines[start])) start -= 1;
  let end = start + 1;
  while (end < lines.length && !entryStart.test(lines[end])) end += 1;
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}

function latestMemoryEntryLineIndex(lines: string[]): number {
  const entryStart = /^- \d{4}-\d{2}-\d{2}T/u;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (entryStart.test(lines[index])) return index;
  }
  return -1;
}

function memoryLineDiff(
  previousContent: string,
  nextContent: string,
): Pick<MemoryDiff, 'addedLines' | 'removedLines' | 'lines'> {
  const previous = previousContent ? previousContent.split('\n') : [];
  const next = nextContent ? nextContent.split('\n') : [];
  const nextCounts = lineCounts(next);
  const previousCounts = lineCounts(previous);
  const removedLines: string[] = [];
  const addedLines: string[] = [];
  const lines: MemoryDiffLine[] = [];
  for (const [index, line] of previous.entries()) {
    if (consumeCount(nextCounts, line)) {
      lines.push({ kind: 'context', line, oldLine: index + 1 });
      continue;
    }
    removedLines.push(line);
    lines.push({ kind: 'removed', line, oldLine: index + 1 });
  }
  for (const [index, line] of next.entries()) {
    if (consumeCount(previousCounts, line)) continue;
    addedLines.push(line);
    lines.push({ kind: 'added', line, newLine: index + 1 });
  }
  return { addedLines, removedLines, lines };
}

function matchesExportQuery(
  document: MemoryDocument,
  query: MemoryExportQuery = {},
): boolean {
  if (query.scopes?.length && !query.scopes.includes(document.scope.kind)) {
    return false;
  }
  if (
    query.workspaceId &&
    document.scope.kind !== 'global' &&
    document.scope.workspaceId !== query.workspaceId
  ) {
    return false;
  }
  if (
    query.projectId &&
    (document.scope.kind === 'global' ||
      document.scope.kind === 'workspace' ||
      document.scope.projectId !== query.projectId)
  ) {
    return false;
  }
  if (
    query.threadId &&
    (document.scope.kind !== 'thread' ||
      (document.scope.threadId !== query.threadId && document.key !== `thread:${query.threadId}`))
  ) {
    return false;
  }
  if (
    query.channelId &&
    (document.scope.kind !== 'channel' ||
      document.scope.channelId !== query.channelId)
  ) {
    return false;
  }
  return true;
}

function effectiveExportScopes(query: MemoryExportQuery = {}): MemoryScopeKind[] {
  return (
    query.scopes ??
    (query.workspaceId || query.projectId || query.channelId || query.threadId
      ? DEFAULT_SCOPE_ORDER.filter((scope) => scope !== 'global')
      : DEFAULT_SCOPE_ORDER)
  );
}

function normalizedSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function searchTerms(value: string): string[] {
  const normalized = normalizedSearchText(value);
  const terms = normalized
    .split(/[^\p{L}\p{N}_.:/-]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
  return [...new Set(terms.length ? terms : [normalized])];
}

function memoryLineSearchScore(
  line: string,
  phrase: string,
  terms: string[],
): number {
  const normalized = normalizedSearchText(line);
  if (!normalized) return 0;
  let score = normalized.includes(phrase) ? 100 : 0;
  let matchedTerms = 0;
  for (const term of terms) {
    if (normalized.includes(term)) matchedTerms += 1;
  }
  if (!score && matchedTerms !== terms.length) return 0;
  score += matchedTerms * 10;
  if (normalized === phrase) score += 25;
  return score;
}

function importedScope(relativePath: string): {
  key: string;
  scope: MemoryScope;
} | undefined {
  if (relativePath === 'global.md') {
    return {
      key: 'global',
      scope: { kind: 'global', label: 'Installation memory' },
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
  const channel = relativePath.match(
    /^workspaces\/([^/]+)\/channels\/([^/]+)\/([^/]+)\/memory\.md$/u,
  );
  if (channel) {
    const [, workspaceId, platform, channelId] = channel;
    return {
      key: `channel:${workspaceId}:${platform}:${channelId}`,
      scope: {
        kind: 'channel',
        workspaceId,
        platform,
        channelId,
        label: `Channel memory / ${platform}:${channelId}`,
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
  selectors?: string[];
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
    selectors: input.selectors,
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
  reconcileSemanticIndex(
    state,
    key,
    current?.version,
    document.version,
    document.content,
  );
  reconcileExpiry(
    state,
    key,
    current?.version,
    document.version,
    document.content,
  );
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
    const now = Date.now();
    const scopes = query.scopes ?? DEFAULT_SCOPE_ORDER;
    const loaded: ScopedMemorySnapshot['scopes'] = scopes.map((kind) => {
      const scope = memoryScopeFor(query, kind);
      const document = state.documents.find(
        (item) => item.key === memoryDocumentKey(query, kind),
      );
      const lines = document?.content ? document.content.split('\n') : [];
      const visible = lines.flatMap((line, index) =>
        isExpired(activeExpiryForLine(state, document!, line, index + 1), now)
          ? []
          : [{ line, lineNumber: index + 1 }],
      );
      const content = visible.map((entry) => entry.line).join('\n').trim();
      return {
        scope,
        content,
        document: document
          ? cloneDocument({ ...document, scope, content })
          : undefined,
        lineNumbers: visible.map((entry) => entry.lineNumber),
        expiredLines: lines.length - visible.length,
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

  async searchMemory(query: MemorySearchQuery): Promise<MemorySearchResult> {
    const phrase = normalizedSearchText(query.query);
    if (!phrase) throw new Error('memory_search_query_required');
    if (phrase.length > 200) throw new Error('memory_search_query_too_long');
    const state = await this.readState();
    const now = Date.now();
    const scopes = query.scopes ?? DEFAULT_SCOPE_ORDER;
    const selected = scopes
      .map((kind) => ({
        scope: memoryScopeFor(query, kind),
        key: memoryDocumentKey(query, kind),
      }))
      .map((selection) => ({
        ...selection,
        document: state.documents.find((item) => item.key === selection.key),
      }))
      .filter(
        (selection): selection is typeof selection & { document: MemoryDocument } =>
          Boolean(selection.document),
      );
    const terms = searchTerms(phrase);
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 25)));
    const hits = selected
      .flatMap(({ document, scope }) =>
        document.content.split('\n').flatMap((line, index) => {
          if (isExpired(activeExpiryForLine(state, document, line, index + 1), now)) {
            return [];
          }
          const score = memoryLineSearchScore(line, phrase, terms);
          return score
            ? [
                {
                  documentKey: document.key,
                  scope,
                  line,
                  lineNumber: index + 1,
                  score,
                  version: document.version,
                  updatedAt: document.updatedAt,
                },
              ]
            : [];
        }),
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.documentKey.localeCompare(right.documentKey) ||
          left.lineNumber - right.lineNumber,
      )
      .slice(0, limit);
    return {
      query: query.query.trim(),
      searchedAt: new Date().toISOString(),
      scannedDocuments: selected.length,
      hits,
    };
  }

  async listMemorySemanticIndex(
    query: MemorySemanticIndexQuery,
  ): Promise<MemorySemanticIndexEntry[]> {
    const state = await this.readState();
    const keys = new Set(
      (query.scopes ?? DEFAULT_SCOPE_ORDER).map((scope) =>
        memoryDocumentKey(query, scope),
      ),
    );
    const currentVersions = new Map(
      state.documents
        .filter((document) => keys.has(document.key))
        .map((document) => [document.key, document.version]),
    );
    const documents = new Map(
      state.documents
        .filter((document) => keys.has(document.key))
        .map((document) => [document.key, document]),
    );
    const now = Date.now();
    const limit = Math.max(1, Math.min(10_000, Math.floor(query.limit ?? 5_000)));
    return state.semanticIndex
      .filter(
        (entry) =>
          keys.has(entry.documentKey) &&
          currentVersions.get(entry.documentKey) === entry.version &&
          (() => {
            const document = documents.get(entry.documentKey);
            const line = document?.content.split('\n')[entry.lineNumber - 1];
            return Boolean(
              document &&
                line &&
                memoryLineHash(line) === entry.lineHash &&
                !isExpired(
                  activeExpiryForLine(
                    state,
                    document,
                    line,
                    entry.lineNumber,
                  ),
                  now,
                ),
            );
          })(),
      )
      .sort(
        (left, right) =>
          right.indexedAt.localeCompare(left.indexedAt) ||
          left.documentKey.localeCompare(right.documentKey) ||
          left.lineNumber - right.lineNumber,
      )
      .slice(0, limit)
      .map((entry) => ({ ...entry, aliases: [...entry.aliases] }));
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
    const expiresAt = normalizedExpiryAt(request.expiresAt);
    await this.mutate((state) => {
      const current = state.documents.find(
        (item) => item.key === memoryDocumentKey(request, request.scope),
      );
      const previousLineCount = current?.content.trim()
        ? current.content.trimEnd().split('\n').length
        : 0;
      const content = rememberedContent(current, text);
      const document = commitRevision(state, {
        query: request,
        scope: request.scope,
        action: 'remember',
        content,
        actorId: request.actorId,
        source: request.source,
      });
      if (expiresAt) {
        const lines = document.content.split('\n');
        for (let index = previousLineCount; index < lines.length; index += 1) {
          updateExpiryForLine(state, {
            document,
            line: lines[index],
            lineNumber: index + 1,
            expiresAt,
            actorId: request.actorId,
            source: request.source,
          });
        }
      }
    });
  }

  async getMemoryExpiry(
    query: MemoryExpiryQuery,
  ): Promise<MemoryExpirySnapshot> {
    const state = await this.readState();
    const scopes = query.scope ? [query.scope] : query.scopes ?? DEFAULT_SCOPE_ORDER;
    const keys = new Set(scopes.map((scope) => memoryDocumentKey(query, scope)));
    const current = new Map(
      state.documents
        .filter((document) => keys.has(document.key))
        .map((document) => [document.key, document]),
    );
    const entries = state.expiry
      .filter((entry) => {
        const document = current.get(entry.documentKey);
        const line = document?.content.split('\n')[entry.lineNumber - 1];
        return Boolean(
          document &&
            document.version === entry.version &&
            line &&
            memoryLineHash(line) === entry.lineHash,
        );
      })
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .map((entry) => ({ ...entry }));
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    const audit = query.includeAudit
      ? state.expiryAudit
          .filter((record) => keys.has(record.documentKey))
          .sort((left, right) => right.at.localeCompare(left.at))
          .slice(0, limit)
          .map((record) => ({ ...record }))
      : [];
    return { checkedAt: new Date().toISOString(), entries, audit };
  }

  async setMemoryExpiry(
    input: MemoryExpiryUpdateInput,
  ): Promise<MemoryExpirySnapshot> {
    const selector = input.selector.trim();
    if (!selector) throw new Error('memory_expiry_selector_required');
    const expiresAt = normalizedExpiryAt(input.expiresAt);
    await this.mutate((state) => {
      const document = state.documents.find(
        (item) => item.key === memoryDocumentKey(input, input.scope),
      );
      if (!document) throw new Error('memory_document_not_found');
      const lines = document.content.split('\n');
      const lineIndex = lines.findIndex((line) => line.includes(selector));
      if (lineIndex < 0) throw new Error('memory_expiry_selector_not_found');
      for (const index of memoryEntryLineRange(lines, lineIndex)) {
        updateExpiryForLine(state, {
          document,
          line: lines[index],
          lineNumber: index + 1,
          expiresAt,
          actorId: input.actorId,
          source: input.source,
        });
      }
    });
    return this.getMemoryExpiry({ ...input, includeAudit: true });
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
      const content = forgottenContent(current, selector);
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

  async proposeMemory(input: MemoryProposalInput): Promise<MemoryProposal> {
    const value = input.value.trim();
    if (!value) throw new Error('memory_value_required');
    const selector = input.selector?.trim();
    const selectors = [
      ...new Set((input.selectors ?? []).map((item) => item.trim()).filter(Boolean)),
    ];
    if (input.action === 'replace' && !selector) {
      throw new Error('memory_replace_selector_required');
    }
    if (
      input.action === 'replace' &&
      (!Number.isInteger(input.expectedDocumentVersion) ||
        (input.expectedDocumentVersion ?? -1) < 0)
    ) {
      throw new Error('memory_replace_expected_document_version_required');
    }
    if (input.action === 'merge' && selectors.length < 2) {
      throw new Error('memory_merge_selectors_required');
    }
    if (input.action === 'merge' && selectors.length > 8) {
      throw new Error('memory_merge_selectors_limit_exceeded');
    }
    if (
      input.action === 'merge' &&
      (!Number.isInteger(input.expectedDocumentVersion) ||
        (input.expectedDocumentVersion ?? -1) < 0)
    ) {
      throw new Error('memory_merge_expected_document_version_required');
    }
    if (input.action === 'index' && !selector) {
      throw new Error('memory_index_selector_required');
    }
    if (
      input.action === 'index' &&
      (!Number.isInteger(input.expectedDocumentVersion) ||
        (input.expectedDocumentVersion ?? -1) < 0)
    ) {
      throw new Error('memory_index_expected_document_version_required');
    }
    const searchAliases = normalizeSearchAliases(input.searchAliases);
    const retentionDays = normalizedMemoryRetentionDays(input.retentionDays);
    if (input.retentionDays !== undefined && retentionDays === undefined) {
      throw new Error('memory_retention_days_invalid');
    }
    return this.mutate((state) => {
      const documentKey = memoryDocumentKey(input, input.scope);
      const normalizedValue = value.toLocaleLowerCase().replace(/\s+/gu, ' ');
      const normalizedSelector = input.selector
        ?.toLocaleLowerCase()
        .replace(/\s+/gu, ' ');
      const normalizedSelectors = selectors
        .map((item) => item.toLocaleLowerCase().replace(/\s+/gu, ' '))
        .sort();
      const existing = state.proposals.find(
        (proposal) =>
          proposal.status === 'pending' &&
          proposal.action === input.action &&
          proposal.documentKey === documentKey &&
          proposal.value.toLocaleLowerCase().replace(/\s+/gu, ' ') ===
            normalizedValue &&
          proposal.selector?.toLocaleLowerCase().replace(/\s+/gu, ' ') ===
            normalizedSelector &&
          JSON.stringify(
            (proposal.selectors ?? [])
              .map((item) => item.toLocaleLowerCase().replace(/\s+/gu, ' '))
              .sort(),
          ) === JSON.stringify(normalizedSelectors) &&
          proposal.expectedDocumentVersion === input.expectedDocumentVersion,
      );
      if (existing) {
        if (searchAliases.length) {
          existing.searchAliases = normalizeSearchAliases([
            ...(existing.searchAliases ?? []),
            ...searchAliases,
          ]);
        }
        return cloneProposal(existing);
      }
      const timestamp = new Date().toISOString();
      const proposal: MemoryProposal = {
        id: randomUUID(),
        status: 'pending',
        action: input.action,
        scope: input.scope,
        documentKey,
        scopeRef: memoryScopeFor(input, input.scope),
        thread: { ...input.thread },
        workspace: input.workspace ? { ...input.workspace } : undefined,
        project: input.project ? { ...input.project } : undefined,
        value,
        selector: selector || undefined,
        selectors: selectors.length ? selectors : undefined,
        expectedDocumentVersion: input.expectedDocumentVersion,
        actorId: input.actorId,
        source: input.source,
        reason: input.reason,
        searchAliases: searchAliases.length ? searchAliases : undefined,
        retentionDays,
        createdAt: timestamp,
      };
      state.proposals.push(proposal);
      return cloneProposal(proposal);
    });
  }

  async listMemoryProposals(
    query: MemoryProposalListQuery = {},
  ): Promise<MemoryProposal[]> {
    const state = await this.readState();
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    return state.proposals
      .filter((proposal) => !query.status || proposal.status === query.status)
      .filter(
        (proposal) =>
          !query.workspaceId ||
          (proposal.scopeRef.kind !== 'global' &&
            proposal.scopeRef.workspaceId === query.workspaceId),
      )
      .filter(
        (proposal) =>
          !query.projectId ||
          (proposal.scopeRef.kind !== 'global' &&
            proposal.scopeRef.kind !== 'workspace' &&
            proposal.scopeRef.projectId === query.projectId),
      )
      .filter((proposal) => !query.scope || proposal.scope === query.scope)
      .sort((left, right) =>
        (right.decidedAt ?? right.createdAt).localeCompare(
          left.decidedAt ?? left.createdAt,
        ),
      )
      .slice(0, limit)
      .map(cloneProposal);
  }

  async getMemoryProposal(id: string): Promise<MemoryProposal | undefined> {
    const state = await this.readState();
    const proposal = state.proposals.find((item) => item.id === id);
    return proposal ? cloneProposal(proposal) : undefined;
  }

  async approveMemoryProposal(
    input: MemoryProposalDecisionInput,
  ): Promise<MemoryProposal> {
    return this.mutate((state) => {
      const proposal = state.proposals.find((item) => item.id === input.id);
      if (!proposal) throw new Error('memory_proposal_not_found');
      if (proposal.status !== 'pending') {
        throw new Error('memory_proposal_already_decided');
      }
      const current = state.documents.find(
        (item) => item.key === proposal.documentKey,
      );
      if (
        proposal.action !== 'remember' &&
        proposal.expectedDocumentVersion !== undefined &&
        (current?.version ?? 0) !== proposal.expectedDocumentVersion
      ) {
        throw new Error('memory_proposal_stale_document_version');
      }
      const selector = proposal.selector || proposal.value;
      const selectors = proposal.selectors ?? [];
      if (
        (proposal.action === 'replace' ||
          proposal.action === 'forget' ||
          proposal.action === 'index') &&
        !documentContainsSelector(current, selector)
      ) {
        throw new Error('memory_proposal_stale_selector');
      }
      if (
        proposal.action === 'merge' &&
        !documentContainsDistinctSelectors(current, selectors)
      ) {
        throw new Error('memory_proposal_stale_selectors');
      }
      if (proposal.action === 'index') {
        const lines = current?.content.split('\n') ?? [];
        const lineIndex = lines.findIndex((line) => line.includes(selector));
        if (lineIndex < 0) throw new Error('memory_proposal_stale_selector');
        const line = lines[lineIndex];
        const aliases = normalizeSearchAliases(proposal.searchAliases);
        if (!aliases.length) throw new Error('memory_index_aliases_required');
        const existing = state.semanticIndex.find(
          (entry) =>
            entry.documentKey === current!.key &&
            entry.version === current!.version &&
            entry.lineHash === memoryLineHash(line),
        );
        if (existing) {
          existing.aliases = normalizeSearchAliases([
            ...existing.aliases,
            ...aliases,
          ]);
          existing.indexedAt = new Date().toISOString();
          existing.indexedBy = proposal.actorId ?? 'memory-runner:unknown';
        } else {
          state.semanticIndex.push({
            documentKey: current!.key,
            version: current!.version,
            lineNumber: lineIndex + 1,
            lineHash: memoryLineHash(line),
            aliases,
            indexedAt: new Date().toISOString(),
            indexedBy: proposal.actorId ?? 'memory-runner:unknown',
          });
        }
        proposal.status = 'approved';
        proposal.decidedAt = new Date().toISOString();
        proposal.decidedBy = input.actorId;
        proposal.reason = input.reason ?? proposal.reason;
        return cloneProposal(proposal);
      }
      const document = commitRevision(state, {
        query: {
          thread: proposal.thread,
          workspace: proposal.workspace,
          project: proposal.project,
        },
        scope: proposal.scope,
        action: proposal.action,
        content:
          proposal.action === 'remember'
            ? rememberedContent(current, proposal.value)
            : proposal.action === 'replace'
              ? replacedContent(current, selector, proposal.value)
              : proposal.action === 'merge'
                ? mergedContent(current, selectors, proposal.value)
              : forgottenContent(current, selector),
        actorId: input.actorId,
        source: 'memory-approval',
        selector:
          proposal.action === 'replace' || proposal.action === 'forget'
            ? selector
            : undefined,
        selectors: proposal.action === 'merge' ? selectors : undefined,
      });
      if (
        (proposal.action === 'remember' ||
          proposal.action === 'replace' ||
          proposal.action === 'merge') &&
        proposal.retentionDays
      ) {
        const expiresAt = memoryExpiryFromRetentionDays(proposal.retentionDays);
        const lines = document.content.split('\n');
        const lineIndex = latestMemoryEntryLineIndex(lines);
        if (lineIndex >= 0) {
          for (const index of memoryEntryLineRange(lines, lineIndex)) {
            updateExpiryForLine(state, {
              document,
              line: lines[index],
              lineNumber: index + 1,
              expiresAt,
              actorId: input.actorId,
              source: 'memory-retention-policy',
            });
          }
        }
      }
      if (
        proposal.action !== 'forget' &&
        proposal.searchAliases?.length
      ) {
        const lines = document.content.split('\n');
        const lineIndex = latestMemoryEntryLineIndex(lines);
        if (lineIndex >= 0) {
          const line = lines[lineIndex];
          state.semanticIndex.push({
            documentKey: document.key,
            version: document.version,
            lineNumber: lineIndex + 1,
            lineHash: memoryLineHash(line),
            aliases: [...proposal.searchAliases],
            indexedAt: new Date().toISOString(),
            indexedBy: proposal.actorId ?? 'memory-runner:unknown',
          });
        }
      }
      proposal.status = 'approved';
      proposal.decidedAt = new Date().toISOString();
      proposal.decidedBy = input.actorId;
      proposal.reason = input.reason ?? proposal.reason;
      proposal.appliedRevisionId = document.latestRevisionId;
      return cloneProposal(proposal);
    });
  }

  async rejectMemoryProposal(
    input: MemoryProposalDecisionInput,
  ): Promise<MemoryProposal> {
    return this.mutate((state) => {
      const proposal = state.proposals.find((item) => item.id === input.id);
      if (!proposal) throw new Error('memory_proposal_not_found');
      if (proposal.status !== 'pending') {
        throw new Error('memory_proposal_already_decided');
      }
      proposal.status = 'rejected';
      proposal.decidedAt = new Date().toISOString();
      proposal.decidedBy = input.actorId;
      proposal.reason = input.reason ?? proposal.reason;
      return cloneProposal(proposal);
    });
  }

  async exportMemory(query: MemoryExportQuery = {}): Promise<MemoryExport> {
    const state = await this.readState();
    const scopes = effectiveExportScopes(query);
    const documents = state.documents
      .filter((document) => matchesExportQuery(document, { ...query, scopes }))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(cloneDocument);
    const documentKeys = new Set(documents.map((document) => document.key));
    const revisionLimit = query.revisionLimit
      ? Math.max(1, Math.min(1000, Math.floor(query.revisionLimit)))
      : undefined;
    const revisions = query.includeRevisions
      ? state.revisions
          .filter((revision) => documentKeys.has(revision.documentKey))
          .sort((left, right) => right.version - left.version)
          .slice(0, revisionLimit)
          .map(cloneRevision)
      : [];
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      filters: {
        workspaceId: query.workspaceId,
        projectId: query.projectId,
        channelId: query.channelId,
        threadId: query.threadId,
        scopes,
        includeRevisions: query.includeRevisions === true,
        revisionLimit,
      },
      documents,
      revisions,
    };
  }

  async compactMemory(
    query: MemoryCompactionQuery = {},
  ): Promise<MemoryCompactionResult> {
    const scopes = effectiveExportScopes(query);
    const keepLatestPerDocument = Math.max(
      1,
      Math.min(100, Math.floor(query.keepLatestPerDocument ?? 50)),
    );
    const buildResult = (state: MemoryState): MemoryCompactionResult => {
      const documents = state.documents
        .filter((document) => matchesExportQuery(document, { ...query, scopes }))
        .sort((left, right) => left.key.localeCompare(right.key));
      const documentKeys = new Set(documents.map((document) => document.key));
      const latestRevisionIds = new Set(
        documents.map((document) => document.latestRevisionId),
      );
      const restoredRevisionIds = new Set(
        state.revisions.flatMap((revision) =>
          revision.restoredFromRevisionId ? [revision.restoredFromRevisionId] : [],
        ),
      );
      const keepIds = new Set<string>([...latestRevisionIds, ...restoredRevisionIds]);
      for (const document of documents) {
        state.revisions
          .filter((revision) => revision.documentKey === document.key)
          .sort((left, right) => right.version - left.version)
          .slice(0, keepLatestPerDocument)
          .forEach((revision) => keepIds.add(revision.id));
      }
      const scopedRevisions = state.revisions.filter((revision) =>
        documentKeys.has(revision.documentKey),
      );
      const droppedRevisions = scopedRevisions
        .filter((revision) => !keepIds.has(revision.id))
        .sort((left, right) => right.version - left.version)
        .map(cloneRevision);
      const keptRevisions = scopedRevisions
        .filter((revision) => keepIds.has(revision.id))
        .sort((left, right) => right.version - left.version)
        .map(cloneRevision);
      return {
        schemaVersion: 1,
        compactedAt: new Date().toISOString(),
        dryRun: query.dryRun !== false,
        filters: {
          workspaceId: query.workspaceId,
          projectId: query.projectId,
          channelId: query.channelId,
          threadId: query.threadId,
          scopes,
          keepLatestPerDocument,
        },
        scannedDocuments: documents.length,
        scannedRevisions: scopedRevisions.length,
        droppedRevisions,
        keptRevisions,
        protectedRevisionIds: [...keepIds].sort(),
      };
    };

    if (query.dryRun !== false) {
      return buildResult(await this.readState());
    }

    return this.mutate((state) => {
      const result = buildResult(state);
      const droppedIds = new Set(
        result.droppedRevisions.map((revision) => revision.id),
      );
      state.revisions = state.revisions.filter(
        (revision) => !droppedIds.has(revision.id),
      );
      return { ...result, dryRun: false };
    });
  }

  async diffMemory(query: MemoryDiffQuery): Promise<MemoryDiff> {
    const state = await this.readState();
    const key = memoryDocumentKey(query, query.scope);
    const scope = memoryScopeFor(query, query.scope);
    const to = state.revisions.find(
      (revision) =>
        revision.id === query.revisionId && revision.documentKey === key,
    );
    if (!to) throw new Error('memory_revision_not_found');
    const from = query.compareToRevisionId
      ? state.revisions.find(
          (revision) =>
            revision.id === query.compareToRevisionId &&
            revision.documentKey === key,
        )
      : state.revisions
          .filter(
            (revision) =>
              revision.documentKey === key && revision.version < to.version,
          )
          .sort((left, right) => right.version - left.version)[0];
    if (query.compareToRevisionId && !from) {
      throw new Error('memory_compare_revision_not_found');
    }
    return {
      documentKey: key,
      scope,
      from: from ? cloneRevision(from) : undefined,
      to: cloneRevision(to),
      ...memoryLineDiff(from?.content ?? '', to.content),
    };
  }
}
