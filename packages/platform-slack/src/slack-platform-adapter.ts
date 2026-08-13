import type {
  Artifact,
  PlatformAdapter,
  PlatformCapabilities,
  ProgressState,
  ProgressSurface,
  SourceThread,
} from '@opentag/core';
import type { SlackTransport } from './types.js';

const SLACK_SAFE_CHUNK = 3_900;

function targetChannelId(thread: SourceThread): string {
  return thread.channelId || thread.externalId.split(':', 1)[0];
}

function targetThreadTs(thread: SourceThread): string | undefined {
  const candidate =
    thread.rootMessageId ||
    thread.topicId ||
    thread.metadata?.slackThreadTs;
  return typeof candidate === 'string' && /^\d+\.\d+$/u.test(candidate)
    ? candidate
    : undefined;
}

function checklistMark(status: ProgressState['checklist'][number]['status']): string {
  if (status === 'done') return '[x]';
  if (status === 'running') return '[~]';
  if (status === 'failed') return '[!]';
  if (status === 'skipped') return '[-]';
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
  const text = [
    state.title,
    `Status: ${state.status}`,
    state.summary || '',
    ...state.checklist.map((item) => {
      const detail = item.detail ? ` - ${item.detail}` : '';
      return `${checklistMark(item.status)} ${item.label}${detail}`;
    }),
  ].filter(Boolean).join('\n');
  return text.slice(0, safeSliceEnd(text, SLACK_SAFE_CHUNK));
}

function splitText(text: string, limit = SLACK_SAFE_CHUNK): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1);
    const splitCandidate = Math.max(
      candidate.lastIndexOf('\n\n'),
      candidate.lastIndexOf('\n'),
      candidate.lastIndexOf(' '),
      Math.floor(limit * 0.7),
    );
    const splitAt = safeSliceEnd(remaining, splitCandidate);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

class SlackProgressSurface implements ProgressSurface {
  constructor(
    private readonly thread: SourceThread,
    private readonly transport: SlackTransport,
  ) {}

  async create(state: ProgressState): Promise<{ surfaceId: string }> {
    const result = await this.transport.sendText({
      channelId: targetChannelId(this.thread),
      text: progressText(state),
      threadTs: targetThreadTs(this.thread),
      metadata: { runId: state.runId, thread: this.thread, stage: 'progress' },
    });
    return { surfaceId: result.messageId };
  }

  async update(surfaceId: string, state: ProgressState): Promise<void> {
    await this.transport.editText({
      channelId: targetChannelId(this.thread),
      messageId: surfaceId,
      text: progressText(state),
      metadata: { runId: state.runId, thread: this.thread, stage: 'progress' },
    });
  }

  async complete(surfaceId: string, state: ProgressState): Promise<void> {
    await this.update(surfaceId, state);
  }
}

export class SlackPlatformAdapter implements PlatformAdapter {
  readonly kind = 'slack' as const;
  readonly capabilities: PlatformCapabilities = {
    supportsThreads: true,
    supportsCards: false,
    supportsFiles: true,
    supportsReactions: false,
    supportsMentions: true,
  };

  constructor(private readonly transport: SlackTransport) {}

  createProgressSurface(thread: SourceThread): ProgressSurface {
    return new SlackProgressSurface(thread, this.transport);
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
      .map((artifact) => `- ${artifact.title}: ${artifact.url}`);
    const combined = links.length
      ? `${text}\n\nArtifacts:\n${links.join('\n')}`
      : text;
    const threadTs = targetThreadTs(thread);
    for (const chunk of splitText(combined)) {
      await this.transport.sendText({
        channelId: targetChannelId(thread),
        text: chunk,
        threadTs,
        metadata: {
          runId: options?.runId,
          thread,
          stage: options?.stage || 'thread-reply',
          notificationId: options?.notificationId,
        },
      });
    }
    for (const artifact of artifacts || []) {
      if (!artifact.path) continue;
      await this.transport.sendFile({
        channelId: targetChannelId(thread),
        file: {
          path: artifact.path,
          name:
            typeof artifact.metadata?.filename === 'string'
              ? artifact.metadata.filename
              : artifact.title,
          title: artifact.title,
        },
        comment: artifact.title.slice(0, 900),
        threadTs,
        metadata: { runId: options?.runId, thread, stage: 'artifact' },
      });
    }
  }
}

export { splitText as splitSlackText };
