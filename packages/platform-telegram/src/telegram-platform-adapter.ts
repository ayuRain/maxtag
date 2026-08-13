import type {
  Artifact,
  PlatformAdapter,
  PlatformCapabilities,
  ProgressState,
  ProgressSurface,
  SourceThread,
} from '@opentag/core';
import type { TelegramTransport } from './types.js';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SAFE_CHUNK = 4000;

function numericId(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  return /^-?\d+$/u.test(text) ? text : undefined;
}

function targetChatId(thread: SourceThread): string {
  return thread.channelId || thread.externalId.split(':', 1)[0];
}

function topicId(thread: SourceThread): string | undefined {
  return numericId(thread.topicId || thread.metadata?.messageThreadId);
}

function incomingMessageId(thread: SourceThread): string | undefined {
  return numericId(thread.metadata?.incomingMessageId);
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
  const lines = [
    state.title,
    `Status: ${state.status}`,
    state.summary || '',
    ...state.checklist.map((item) => {
      const detail = item.detail ? ` - ${item.detail}` : '';
      return `${checklistMark(item.status)} ${item.label}${detail}`;
    }),
  ].filter(Boolean);
  const text = lines.join('\n');
  return text.slice(0, safeSliceEnd(text, TELEGRAM_MESSAGE_LIMIT));
}

function splitText(text: string, limit = TELEGRAM_SAFE_CHUNK): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1);
    const paragraph = candidate.lastIndexOf('\n\n');
    const line = candidate.lastIndexOf('\n');
    const space = candidate.lastIndexOf(' ');
    const candidateSplit = Math.max(
      paragraph,
      line,
      space,
      Math.floor(limit * 0.7),
    );
    const splitAt = safeSliceEnd(remaining, candidateSplit);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

class TelegramProgressSurface implements ProgressSurface {
  constructor(
    private readonly thread: SourceThread,
    private readonly transport: TelegramTransport,
  ) {}

  async create(state: ProgressState): Promise<{ surfaceId: string }> {
    const result = await this.transport.sendText({
      chatId: targetChatId(this.thread),
      text: progressText(state),
      messageThreadId: topicId(this.thread),
      replyToMessageId: incomingMessageId(this.thread),
      metadata: { runId: state.runId, thread: this.thread, stage: 'progress' },
    });
    return { surfaceId: result.messageId };
  }

  async update(surfaceId: string, state: ProgressState): Promise<void> {
    await this.transport.editText({
      chatId: targetChatId(this.thread),
      messageId: surfaceId,
      text: progressText(state),
      metadata: { runId: state.runId, thread: this.thread, stage: 'progress' },
    });
  }

  async complete(surfaceId: string, state: ProgressState): Promise<void> {
    await this.update(surfaceId, state);
  }
}

export class TelegramPlatformAdapter implements PlatformAdapter {
  readonly kind = 'telegram' as const;
  readonly capabilities: PlatformCapabilities = {
    supportsThreads: true,
    supportsCards: false,
    supportsFiles: true,
    supportsReactions: false,
    supportsMentions: true,
  };

  constructor(private readonly transport: TelegramTransport) {}

  createProgressSurface(thread: SourceThread): ProgressSurface {
    return new TelegramProgressSurface(thread, this.transport);
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
    const chunks = splitText(combined);
    const replyToMessageId =
      numericId(options?.replyToMessageId) || incomingMessageId(thread);
    for (const [index, chunk] of chunks.entries()) {
      await this.transport.sendText({
        chatId: targetChatId(thread),
        text: chunk,
        messageThreadId: topicId(thread),
        replyToMessageId: index === 0 ? replyToMessageId : undefined,
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
      await this.transport.sendDocument({
        chatId: targetChatId(thread),
        document: {
          path: artifact.path,
          name:
            typeof artifact.metadata?.filename === 'string'
              ? artifact.metadata.filename
              : artifact.title,
        },
        caption: artifact.title.slice(0, 900),
        messageThreadId: topicId(thread),
        metadata: { runId: options?.runId, thread, stage: 'artifact' },
      });
    }
  }
}

export { splitText as splitTelegramText };
