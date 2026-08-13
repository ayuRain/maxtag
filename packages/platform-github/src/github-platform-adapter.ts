import type {
  Artifact,
  PlatformAdapter,
  PlatformCapabilities,
  ProgressState,
  ProgressSurface,
  SourceThread,
} from '@opentag/core';
import type { GitHubTransport } from './types.js';

const GITHUB_COMMENT_LIMIT = 65_536;
const GITHUB_SAFE_CHUNK = 60_000;

interface GitHubThreadTarget {
  owner: string;
  repo: string;
  issueNumber: number;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function targetForThread(thread: SourceThread): GitHubThreadTarget {
  const externalRepository = thread.externalId.split('#', 1)[0];
  const channelRepository = thread.channelId?.includes('#')
    ? thread.channelId.split('#', 1)[0]
    : thread.channelId;
  const repository =
    stringValue(thread.metadata?.repository) ||
    channelRepository ||
    externalRepository;
  const separator = repository.indexOf('/');
  const owner =
    stringValue(thread.metadata?.owner) ||
    (separator > 0 ? repository.slice(0, separator) : undefined);
  const repo =
    stringValue(thread.metadata?.repo) ||
    (separator > 0 ? repository.slice(separator + 1) : undefined);
  const issueNumber =
    numericValue(thread.metadata?.issueNumber) ||
    numericValue(thread.topicId) ||
    numericValue(thread.rootMessageId) ||
    numericValue(thread.externalId.split('#').at(-1));
  if (!owner || !repo || !issueNumber) {
    throw new Error('GitHub thread requires owner, repository, and issue number.');
  }
  return { owner, repo, issueNumber };
}

function checklistMark(status: ProgressState['checklist'][number]['status']): string {
  if (status === 'done') return '[x]';
  if (status === 'running') return '[ ]';
  if (status === 'failed') return '[ ]';
  if (status === 'skipped') return '[x]';
  return '[ ]';
}

function safeSliceEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? end - 1
    : end;
}

function progressText(state: ProgressState): string {
  const lines = [
    `<!-- opentag-progress:${state.runId} -->`,
    `**MaxTag · ${state.status}**`,
    state.summary || state.title,
    '',
    ...state.checklist.map((item) => {
      const detail = item.detail ? ` - ${item.detail}` : '';
      const status = item.status === 'running' ? ' (running)' : item.status === 'failed' ? ' (failed)' : '';
      return `- ${checklistMark(item.status)} ${item.label}${status}${detail}`;
    }),
  ];
  const text = lines.join('\n').trim();
  return text.slice(0, safeSliceEnd(text, GITHUB_COMMENT_LIMIT));
}

function splitText(text: string, limit = GITHUB_SAFE_CHUNK): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1);
    const splitAt = safeSliceEnd(
      remaining,
      Math.max(
        candidate.lastIndexOf('\n\n'),
        candidate.lastIndexOf('\n'),
        candidate.lastIndexOf(' '),
        Math.floor(limit * 0.7),
      ),
    );
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

class GitHubProgressSurface implements ProgressSurface {
  constructor(
    private readonly thread: SourceThread,
    private readonly transport: GitHubTransport,
  ) {}

  async create(state: ProgressState): Promise<{ surfaceId: string }> {
    const target = targetForThread(this.thread);
    const result = await this.transport.createIssueComment({
      ...target,
      body: progressText(state),
      metadata: { runId: state.runId, thread: this.thread, stage: 'progress' },
    });
    return { surfaceId: result.commentId };
  }

  async update(surfaceId: string, state: ProgressState): Promise<void> {
    const target = targetForThread(this.thread);
    await this.transport.updateIssueComment({
      owner: target.owner,
      repo: target.repo,
      commentId: surfaceId,
      body: progressText(state),
      metadata: { runId: state.runId, thread: this.thread, stage: 'progress' },
    });
  }

  async complete(surfaceId: string, state: ProgressState): Promise<void> {
    await this.update(surfaceId, state);
  }
}

export class GitHubPlatformAdapter implements PlatformAdapter {
  readonly kind = 'github' as const;
  readonly capabilities: PlatformCapabilities = {
    supportsThreads: true,
    supportsCards: false,
    supportsFiles: false,
    supportsReactions: false,
    supportsMentions: true,
  };

  constructor(private readonly transport: GitHubTransport) {}

  createProgressSurface(thread: SourceThread): ProgressSurface {
    return new GitHubProgressSurface(thread, this.transport);
  }

  async sendMessage(
    thread: SourceThread,
    text: string,
    artifacts?: Artifact[],
    options?: {
      runId?: string;
      replyToMessageId?: string;
      stage?: 'thread-reply' | 'routine-notification';
      notificationId?: string;
    },
  ): Promise<void> {
    const links = (artifacts || [])
      .filter((artifact) => artifact.url)
      .map((artifact) => `- [${artifact.title}](${artifact.url})`);
    const local = (artifacts || [])
      .filter((artifact) => !artifact.url)
      .map((artifact) => `- ${artifact.title} (available in MaxTag)`);
    const artifactLines = [...links, ...local];
    const combined = artifactLines.length
      ? `${text}\n\n**Artifacts**\n${artifactLines.join('\n')}`
      : text;
    const target = targetForThread(thread);
    const marker = `<!-- opentag-reply:${options?.runId || 'control'} -->`;
    for (const chunk of splitText(combined, GITHUB_SAFE_CHUNK - marker.length - 1)) {
      await this.transport.createIssueComment({
        ...target,
        body: `${marker}\n${chunk}`,
        metadata: {
          runId: options?.runId,
          thread,
          stage: options?.stage || 'thread-reply',
          notificationId: options?.notificationId,
        },
      });
    }
  }
}

export { splitText as splitGitHubText };
