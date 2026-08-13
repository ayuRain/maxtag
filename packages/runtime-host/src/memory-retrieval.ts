import { createHash, randomUUID } from 'node:crypto';
import {
  type AccessBundle,
  type AgentMemorySelection,
  type ExecutorDescriptor,
  type ExecutorRegistry,
  type MemoryScopeKind,
  type MemorySemanticIndexEntry,
  type MemoryStore,
  type RuntimeMemoryRetrievalInput,
  type RuntimeMemoryRetrievalResult,
  type RuntimeMemoryRetriever,
  type ScopedMemorySnapshot,
} from '@opentag/core';
import type { DeliveryStore } from '@opentag/delivery';

const SCOPE_PRIORITY: Record<MemoryScopeKind, number> = {
  global: 0,
  workspace: 1,
  project: 2,
  channel: 3,
  thread: 4,
};

interface MemoryCandidateLine {
  documentKey: string;
  version: number;
  scope: MemoryScopeKind;
  lineNumber: number;
  line: string;
  contextLines: Array<{ lineNumber: number; line: string }>;
  updatedAt: string;
  lexicalScore: number;
  indexScore: number;
}

interface QueryTerm {
  value: string;
  weight: number;
}

export interface MemoryRetrievalServiceOptions {
  executorRegistry: ExecutorRegistry;
  deliveryStore?: DeliveryStore;
  memoryStore?: MemoryStore;
  executorId?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxCandidateLines?: number;
  maxCandidateChars?: number;
  maxSelectedLines?: number;
  minConfidence?: number;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

const HAN_STOP_WORDS = new Set([
  '一个',
  '一下',
  '一些',
  '之前',
  '以后',
  '以前',
  '我们',
  '你们',
  '他们',
  '不要',
  '应该',
  '自己',
  '什么',
  '事情',
  '问题',
  '为什么',
  '怎么',
  '怎样',
  '哪里',
  '哪个',
  '现在',
  '当前',
  '这个',
  '那个',
  '发现',
  '可以',
  '可能',
  '还是',
  '时候',
  '通过',
  '关于',
  '帮我',
  '看看',
]);

const HAN_STOP_CHARS = new Set(
  '的一了是在有和与及或也都就而又还着把被给让从到对为于呢吗吧呀哦谁哪怎这那',
);

const QUERY_ALIAS_GROUPS = [
  ['假说', 'thesis', 'hypothesis'],
  ['重启', '重新启动', 'restart', 'reboot'],
  ['飞书', 'lark'],
  ['多维表格', 'base', 'bitable'],
] as const;

const MEMORY_ENTRY_START = /^- \d{4}-\d{2}-\d{2}T/u;
const MAX_CONTEXT_LINES = 12;
const MAX_CONTEXT_CHARS = 1_500;
const MIN_RECALL_SCORE = 2.5;

function addSearchTerm(
  terms: Map<string, number>,
  raw: string,
  weight: number,
  allowSingle = false,
): void {
  const value = raw.trim();
  if ((!allowSingle && value.length < 2) || HAN_STOP_WORDS.has(value)) return;
  terms.set(value, Math.max(terms.get(value) ?? 0, weight));
}

function segmentedHanWords(value: string): string[] {
  try {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    return Array.from(segmenter.segment(value))
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  } catch {
    return [];
  }
}

function searchTerms(value: string): QueryTerm[] {
  const normalized = normalizeSearchText(value);
  const terms = new Map<string, number>();
  for (const token of normalized.match(/[\p{L}\p{N}_.:/-]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const words = segmentedHanWords(token);
      for (const word of words.length ? words : [token]) {
        if (word.length === 1 && !HAN_STOP_CHARS.has(word)) {
          addSearchTerm(terms, word, 1.15, true);
        }
        addSearchTerm(terms, word, word.length >= 3 ? 3.4 : 2.6);
        for (let size = 2; size <= Math.min(4, word.length); size += 1) {
          const weight = size === 2 ? 0.55 : size === 3 ? 0.95 : 1.35;
          for (let index = 0; index <= word.length - size; index += 1) {
            addSearchTerm(terms, word.slice(index, index + size), weight);
          }
        }
      }
    } else {
      addSearchTerm(terms, token, token.length >= 6 ? 2.2 : 1.6);
    }
  }
  for (const aliases of QUERY_ALIAS_GROUPS) {
    if (!aliases.some((alias) => normalized.includes(alias))) continue;
    for (const alias of aliases) addSearchTerm(terms, alias, 2.4);
  }
  return [...terms.entries()]
    .map(([term, weight]) => ({ value: term, weight }))
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        right.value.length - left.value.length ||
        left.value.localeCompare(right.value),
    )
    .slice(0, 80);
}

function lexicalScore(
  line: string,
  phrase: string,
  terms: QueryTerm[],
  inverseFrequency: Map<string, number>,
  presentIntent: boolean,
  totalQueryWeight: number,
): number {
  const normalized = normalizeSearchText(line);
  if (!normalized) return 0;
  let score =
    phrase.length >= 3 && phrase.length <= 160 && normalized.includes(phrase)
      ? 100
      : 0;
  let matched = 0;
  let matchedWeight = 0;
  for (const term of terms) {
    if (!normalized.includes(term.value)) continue;
    matched += 1;
    matchedWeight += term.weight;
    score += term.weight * (inverseFrequency.get(term.value) ?? 1);
  }
  if (matched) {
    const coverage = totalQueryWeight > 0 ? matchedWeight / totalQueryWeight : 0;
    score += coverage * coverage * 18 + Math.min(12, matched * 0.6);
  }
  if (
    presentIntent &&
    ['current', 'currently', 'now', '现行', '当前', '目前', '默认', '已决定', '取代', '不再'].some(
      (marker) => normalized.includes(marker),
    )
  ) {
    score += 8;
  }
  return score;
}

function semanticIndexScore(
  aliases: string[],
  phrase: string,
  terms: QueryTerm[],
  inverseFrequency: Map<string, number>,
  presentIntent: boolean,
  totalQueryWeight: number,
): number {
  return aliases.reduce(
    (best, alias) =>
      Math.max(
        best,
        lexicalScore(
          alias,
          phrase,
          terms,
          inverseFrequency,
          presentIntent,
          totalQueryWeight,
        ),
      ),
    0,
  );
}

function boundedFactContext(
  lines: Array<{ lineNumber: number; line: string }>,
  anchorIndex: number,
): Array<{ lineNumber: number; line: string }> {
  let entryStart = anchorIndex;
  while (entryStart >= 0 && !MEMORY_ENTRY_START.test(lines[entryStart].line)) {
    entryStart -= 1;
  }
  if (entryStart < 0) return [lines[anchorIndex]];
  let entryEnd = entryStart + 1;
  while (
    entryEnd < lines.length &&
    !MEMORY_ENTRY_START.test(lines[entryEnd].line)
  ) {
    entryEnd += 1;
  }

  const selected = new Set([anchorIndex]);
  let chars = lines[anchorIndex].line.length;
  for (let distance = 1; selected.size < MAX_CONTEXT_LINES; distance += 1) {
    let added = false;
    for (const index of [anchorIndex - distance, anchorIndex + distance]) {
      if (
        index < entryStart ||
        index >= entryEnd ||
        selected.has(index) ||
        selected.size >= MAX_CONTEXT_LINES
      ) {
        continue;
      }
      const cost = lines[index].line.length + 1;
      if (chars + cost > MAX_CONTEXT_CHARS) continue;
      selected.add(index);
      chars += cost;
      added = true;
    }
    if (
      !added &&
      anchorIndex - distance < entryStart &&
      anchorIndex + distance >= entryEnd
    ) {
      break;
    }
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => lines[index]);
}

function retrievalQuery(input: RuntimeMemoryRetrievalInput): string {
  const recent = input.transcript?.entries
    .filter((entry) => entry.role === 'user')
    .slice(-4)
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join('\n');
  return [recent, input.message.text.trim()].filter(Boolean).join('\n');
}

function snapshotLines(
  snapshot: ScopedMemorySnapshot,
  query: string,
  semanticIndex: MemorySemanticIndexEntry[] = [],
): MemoryCandidateLine[] {
  const phrase = normalizeSearchText(query);
  const terms = searchTerms(query);
  const totalQueryWeight = terms.reduce((total, term) => total + term.weight, 0);
  const visibleLines = snapshot.scopes.flatMap(({ content }) =>
    content
      .split('\n')
      .map((line) => normalizeSearchText(line))
      .filter(Boolean),
  );
  const inverseFrequency = new Map(
    terms.map((term) => {
      const frequency = visibleLines.filter((line) => line.includes(term.value)).length;
      return [
        term.value,
        Math.log(1 + (visibleLines.length - frequency + 0.5) / (frequency + 0.5)),
      ];
    }),
  );
  const presentIntent = /(?:current|currently|now|latest|现在|当前|如今|最新|现行|默认|目前)/u.test(
    phrase,
  );
  const indexByLine = new Map(
    semanticIndex.map((entry) => [
      `${entry.documentKey}:${entry.version}:${entry.lineNumber}:${entry.lineHash}`,
      entry,
    ]),
  );
  return snapshot.scopes.flatMap(({ scope, content, document, lineNumbers }) => {
    if (!document || !content.trim()) return [];
    const documentLines = content.split('\n').map((line, index) => ({
      lineNumber: lineNumbers?.[index] ?? index + 1,
      line,
    }));
    return documentLines.flatMap((entry, index) => {
      const value = entry.line.trim();
      if (!value) return [];
      const contextLines = boundedFactContext(documentLines, index);
      const context = contextLines.map((line) => line.line.trim()).join('\n');
      const hash = createHash('sha256').update(entry.line).digest('hex');
      const lineNumber = entry.lineNumber;
      const indexed = indexByLine.get(
        `${document.key}:${document.version}:${lineNumber}:${hash}`,
      );
      return [
            {
              documentKey: document.key,
              version: document.version,
              scope: scope.kind,
              lineNumber,
              line: context,
              contextLines,
              updatedAt: document.updatedAt,
              lexicalScore: lexicalScore(
                context,
                phrase,
                terms,
                inverseFrequency,
                presentIntent,
                totalQueryWeight,
              ),
              indexScore: indexed
                ? semanticIndexScore(
                    indexed.aliases,
                    phrase,
                    terms,
                    inverseFrequency,
                    presentIntent,
                    totalQueryWeight,
                  )
                : 0,
            },
          ];
    });
  });
}

function candidateKey(
  candidate: Pick<MemoryCandidateLine, 'documentKey' | 'version' | 'lineNumber'>,
): string {
  return `${candidate.documentKey}:${candidate.version}:${candidate.lineNumber}`;
}

function candidateFactKey(line: string): string {
  return normalizeSearchText(line).replace(
    /^-\s+\d{4}-\d{2}-\d{2}t\S+\s+/u,
    '',
  );
}

function candidateHasRecallSignal(candidate: MemoryCandidateLine): boolean {
  return Math.max(candidate.lexicalScore, candidate.indexScore) >= MIN_RECALL_SCORE;
}

function boundedCandidates(
  lines: MemoryCandidateLine[],
  maxLines: number,
  maxChars: number,
): MemoryCandidateLine[] {
  const ranked = [...lines].sort(
    (left, right) =>
      Math.max(right.lexicalScore, right.indexScore) -
        Math.max(left.lexicalScore, left.indexScore) ||
      SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope] ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.lineNumber - left.lineNumber,
  );
  const selected: MemoryCandidateLine[] = [];
  const seen = new Set<string>();
  const seenText = new Set<string>();
  let chars = 0;
  const add = (candidate: MemoryCandidateLine): boolean => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return true;
    const textKey = candidateFactKey(candidate.line);
    if (seenText.has(textKey)) return true;
    const cost = candidate.line.length + candidate.documentKey.length + 100;
    if (selected.length >= maxLines || chars + cost > maxChars) return false;
    selected.push(candidate);
    seen.add(key);
    seenText.add(textKey);
    chars += cost;
    return true;
  };

  for (const candidate of ranked.filter(candidateHasRecallSignal)) {
    if (!add(candidate)) break;
  }
  for (const scope of ['thread', 'channel', 'project', 'workspace'] as const) {
    for (const candidate of ranked.filter((item) => item.scope === scope).slice(0, 8)) {
      if (!add(candidate)) break;
    }
  }
  for (const candidate of ranked) {
    if (!add(candidate)) break;
  }
  return selected;
}

function candidatePrompt(candidates: MemoryCandidateLine[]): string {
  return candidates
    .map((candidate) =>
      [
        `REF ${JSON.stringify({
          documentKey: candidate.documentKey,
          version: candidate.version,
          lineNumber: candidate.lineNumber,
          scope: candidate.scope,
        })}`,
        candidate.contextLines
          .map((line) => `[line ${line.lineNumber}] ${line.line}`)
          .join('\n'),
      ].join('\n'),
    )
    .join('\n\n');
}

function selectedSnapshot(
  source: ScopedMemorySnapshot,
  candidates: MemoryCandidateLine[],
): ScopedMemorySnapshot {
  const byDocument = new Map<string, MemoryCandidateLine[]>();
  for (const candidate of candidates) {
    const values = byDocument.get(candidate.documentKey) ?? [];
    values.push(candidate);
    byDocument.set(candidate.documentKey, values);
  }
  const scopes = source.scopes.flatMap((entry) => {
    if (!entry.document) return [];
    const seen = new Set<number>();
    const lines = (byDocument.get(entry.document.key) ?? [])
      .flatMap((candidate) => candidate.contextLines)
      .sort((left, right) => left.lineNumber - right.lineNumber)
      .filter((line) => {
        if (seen.has(line.lineNumber)) return false;
        seen.add(line.lineNumber);
        return true;
      });
    if (!lines.length) return [];
    const content = lines
      .map((line) => `[line ${line.lineNumber}] ${line.line}`)
      .join('\n');
    return [{
      ...entry,
      content,
      lineNumbers: lines.map((line) => line.lineNumber),
      expiredLines: entry.expiredLines,
    }];
  });
  return {
    loadedAt: new Date().toISOString(),
    scopes,
    text: scopes
      .map(({ scope, content, document }) =>
        [
          `## ${scope.label} [scope=${scope.kind} documentKey=${document?.key ?? 'none'} version=${document?.version ?? 0}]`,
          content,
        ].join('\n'),
      )
      .join('\n\n'),
  };
}

function readOnlyAccess(source: AccessBundle): AccessBundle {
  return {
    ...source,
    id: `memory-retrieval:${source.id}`,
    grants: source.grants
      .filter((grant) => grant.kind === 'memory')
      .map((grant) => ({
        ...grant,
        constraints: { ...grant.constraints, permissions: ['read'] },
      })),
    networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
  };
}

function validatedSelections(
  selections: AgentMemorySelection[],
  candidates: MemoryCandidateLine[],
  maxSelected: number,
  minConfidence: number,
): MemoryCandidateLine[] {
  const available = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const selected: MemoryCandidateLine[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if ((selection.confidence ?? 1) < minConfidence) continue;
    const key = candidateKey(selection);
    const candidate = available.get(key);
    if (!candidate || seen.has(key)) continue;
    selected.push(candidate);
    seen.add(key);
    if (selected.length >= maxSelected) break;
  }
  return selected;
}

function localFallback(
  candidates: MemoryCandidateLine[],
  maxSelected: number,
): {
  lines: MemoryCandidateLine[];
  strategy: 'indexed' | 'lexical' | 'recent' | 'empty';
} {
  const lexical = candidates
    .filter(candidateHasRecallSignal)
    .sort(
      (left, right) =>
        Math.max(right.lexicalScore, right.indexScore) -
          Math.max(left.lexicalScore, left.indexScore) ||
        SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope],
    )
    .slice(0, maxSelected);
  if (lexical.length) {
    return {
      lines: lexical,
      strategy: lexical.some((candidate) => candidate.indexScore > candidate.lexicalScore)
        ? 'indexed'
        : 'lexical',
    };
  }
  const recent = [...candidates]
    .sort(
      (left, right) =>
        SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope] ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.lineNumber - left.lineNumber,
    )
    .slice(0, Math.min(4, maxSelected));
  return recent.length
    ? { lines: recent, strategy: 'recent' }
    : { lines: [], strategy: 'empty' };
}

export class MemoryRetrievalService implements RuntimeMemoryRetriever {
  constructor(private readonly options: MemoryRetrievalServiceOptions) {}

  status(): {
    enabled: boolean;
    executor?: ExecutorDescriptor;
    timeoutMs: number;
    maxCandidateLines: number;
    maxCandidateChars: number;
    maxSelectedLines: number;
    minConfidence: number;
  } {
    const executorId =
      this.options.executorId ?? this.options.executorRegistry.defaultExecutorId;
    const executor = this.options.executorRegistry.describe(executorId);
    return {
      enabled: (this.options.enabled ?? true) && executor?.status === 'ready',
      executor,
      timeoutMs: Math.max(25, Math.min(this.options.timeoutMs ?? 15_000, 60_000)),
      maxCandidateLines: Math.max(
        8,
        Math.min(this.options.maxCandidateLines ?? 120, 500),
      ),
      maxCandidateChars: Math.max(
        4_000,
        Math.min(this.options.maxCandidateChars ?? 48_000, 100_000),
      ),
      maxSelectedLines: Math.max(
        1,
        Math.min(this.options.maxSelectedLines ?? 16, 50),
      ),
      minConfidence: Math.max(0, Math.min(this.options.minConfidence ?? 0.5, 1)),
    };
  }

  async retrieve(
    input: RuntimeMemoryRetrievalInput,
  ): Promise<RuntimeMemoryRetrievalResult> {
    const started = Date.now();
    const query = retrievalQuery(input);
    const semanticIndex = this.options.memoryStore?.listMemorySemanticIndex
      ? await this.options.memoryStore
          .listMemorySemanticIndex({
            thread: input.thread,
            workspace: input.workspace,
            project: input.project,
            scopes: input.memorySnapshot.scopes.map((entry) => entry.scope.kind),
          })
          .catch(() => [])
      : [];
    const allLines = snapshotLines(input.memorySnapshot, query, semanticIndex);
    if (!allLines.length) {
      return {
        snapshot: selectedSnapshot(input.memorySnapshot, []),
        strategy: 'empty',
        candidateLines: 0,
        selectedLines: 0,
        durationMs: Date.now() - started,
      };
    }
    const status = this.status();
    const candidates = boundedCandidates(
      allLines,
      status.maxCandidateLines,
      status.maxCandidateChars,
    );
    const fallback = (reason: string): RuntimeMemoryRetrievalResult => {
      const result = localFallback(candidates, status.maxSelectedLines);
      return {
        snapshot: selectedSnapshot(input.memorySnapshot, result.lines),
        strategy: result.strategy,
        candidateLines: candidates.length,
        selectedLines: result.lines.length,
        fallbackReason: reason,
        durationMs: Date.now() - started,
      };
    };
    if (!status.enabled || !status.executor) {
      return fallback('memory_retrieval_executor_not_ready');
    }
    const executorId = status.executor.id;
    const executor = this.options.executorRegistry.get(executorId);
    if (!executor) return fallback('memory_retrieval_executor_not_found');
    if (input.abortSignal?.aborted) {
      throw input.abortSignal.reason instanceof Error
        ? input.abortSignal.reason
        : new Error('memory_retrieval_aborted');
    }
    const controller = new AbortController();
    let timedOut = false;
    let rejectCancellation: (reason: Error) => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = (): void => {
      const reason =
        input.abortSignal?.reason instanceof Error
          ? input.abortSignal.reason
          : new Error('memory_retrieval_aborted');
      controller.abort(reason);
      rejectCancellation(reason);
    };
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      const reason = new Error('memory_retrieval_timeout');
      controller.abort(reason);
      rejectCancellation(reason);
    }, status.timeoutMs);
    try {
      const result = await Promise.race([
        executor.run({
          runId: `memory-retrieval:${input.runId}`,
          purpose: 'memory_retrieval',
          workspace: input.workspace,
          project: input.project,
          thread: input.thread,
          message: {
            ...input.message,
            id: `memory-retrieval:${input.message.id}`,
            text: query,
          },
          identity: {
            id: 'opentag-memory-retrieval',
            displayName: 'MaxTag Memory Retrieval',
            instructions: 'Select approved memory references for the current turn.',
            defaultExecutorId: executorId,
          },
          access: readOnlyAccess(input.access),
          memory: candidatePrompt(candidates),
          memorySnapshot: input.memorySnapshot,
          abortSignal: controller.signal,
        }),
        cancellation,
      ]);
      const selected = validatedSelections(
        result.memorySelections ?? [],
        candidates,
        status.maxSelectedLines,
        status.minConfidence,
      );
      if (this.options.deliveryStore) {
        try {
          await this.options.deliveryStore.recordAgentRunUsage({
            runId: input.runId,
            recordKey: `memory_retrieval:${randomUUID()}`,
            purpose: 'memory_retrieval',
            thread: input.thread,
            quantity: { runs: 0, costUsd: result.usage?.costUsd ?? 0 },
            source: 'memory-runner:memory_retrieval',
            policies: input.access.budgetPolicies,
            metadata: {
              executorId,
              model: status.executor.model,
              purpose: 'memory_retrieval',
              inputTokens: result.usage?.inputTokens,
              outputTokens: result.usage?.outputTokens,
              costReported: typeof result.usage?.costUsd === 'number',
            },
          });
        } catch {
          // Usage telemetry must not make an otherwise valid retrieval fail.
        }
      }
      if (
        !selected.length &&
        candidates.some(candidateHasRecallSignal)
      ) {
        return fallback('memory_retrieval_no_valid_selections');
      }
      return {
        snapshot: selectedSnapshot(input.memorySnapshot, selected),
        strategy: 'semantic',
        candidateLines: candidates.length,
        selectedLines: selected.length,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (input.abortSignal?.aborted) {
        throw input.abortSignal.reason instanceof Error
          ? input.abortSignal.reason
          : new Error('memory_retrieval_aborted');
      }
      return fallback(
        timedOut
          ? `memory_retrieval_timeout:${status.timeoutMs}ms`
          : 'memory_retrieval_executor_failed',
      );
    } finally {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', onAbort);
    }
  }
}
