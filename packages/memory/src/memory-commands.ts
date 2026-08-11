import type { MemoryScopeKind } from '@opentag/core';

export type MemoryCommandKind = 'remember' | 'forget' | 'show';

export interface ParsedMemoryCommand {
  kind: MemoryCommandKind;
  scope: MemoryScopeKind;
  value: string;
}

const SCOPE_ALIASES: Record<string, MemoryScopeKind> = {
  global: 'global',
  workspace: 'workspace',
  project: 'project',
  thread: 'thread',
  全局: 'global',
  工作区: 'workspace',
  项目: 'project',
  群: 'project',
  话题: 'thread',
  线程: 'thread',
};

function stripAddressing(text: string): string {
  return text
    .trim()
    .replace(/^(@\S+\s*)+/u, '')
    .replace(/^\/+/, '')
    .trim();
}

function consumeScope(
  text: string,
  defaultScope: MemoryScopeKind,
): { scope: MemoryScopeKind; value: string } {
  const normalized = text.trim().replace(/^[:：]\s*/, '');
  const [first = '', ...rest] = normalized.split(/\s+/u);
  const scope = SCOPE_ALIASES[first.replace(/[:：]$/u, '').toLowerCase()];
  if (!scope) return { scope: defaultScope, value: normalized };
  return {
    scope,
    value: rest.join(' ').replace(/^[:：]\s*/, '').trim(),
  };
}

function consumeCommand(
  text: string,
): { kind: MemoryCommandKind; value: string } | null {
  const normalized = stripAddressing(text);
  const lower = normalized.toLowerCase();
  const phrases: Array<[string, MemoryCommandKind]> = [
    ['show memory', 'show'],
    ['memory', 'show'],
    ['remember', 'remember'],
    ['forget', 'forget'],
    ['查看记忆', 'show'],
    ['看记忆', 'show'],
    ['记忆', 'show'],
    ['记住', 'remember'],
    ['忘记', 'forget'],
  ];

  for (const [phrase, kind] of phrases) {
    if (lower === phrase) return { kind, value: '' };
    if (lower.startsWith(`${phrase} `)) {
      return {
        kind,
        value: normalized.slice(phrase.length).trim(),
      };
    }
    if (normalized.startsWith(`${phrase}：`) || normalized.startsWith(`${phrase}:`)) {
      return {
        kind,
        value: normalized.slice(phrase.length + 1).trim(),
      };
    }
  }
  return null;
}

export function parseMemoryCommand(
  text: string,
  options?: { defaultScope?: MemoryScopeKind },
): ParsedMemoryCommand | null {
  const consumed = consumeCommand(text);
  if (!consumed) return null;
  const { scope, value } = consumeScope(
    consumed.value,
    options?.defaultScope ?? 'thread',
  );
  const cleanedValue =
    consumed.kind === 'forget'
      ? value.replace(/^(matching|contains)\s+/iu, '').trim()
      : value.trim();

  if (consumed.kind !== 'show' && !cleanedValue) return null;
  return {
    kind: consumed.kind,
    scope,
    value: cleanedValue,
  };
}
