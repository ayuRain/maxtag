import { randomUUID } from 'node:crypto';
import type {
  Artifact,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformKind,
  ProgressState,
  ProgressSurface,
  SourceThread,
} from '@opentag/core';
import type { DeliveryStore } from './file-delivery-store.js';

function targetChatId(thread: SourceThread): string {
  return thread.channelId || thread.externalId;
}

function artifactLines(artifacts: Artifact[] | undefined): string {
  return (artifacts || [])
    .filter((artifact) => artifact.url || artifact.path)
    .map((artifact) => {
      const target = artifact.url || artifact.path;
      return `- ${artifact.title}: ${target}`;
    })
    .join('\n');
}

function progressText(state: ProgressState): string {
  const lines = [
    `Status: ${state.status}`,
    state.summary ? `Summary: ${state.summary}` : '',
    ...state.checklist.map((item) => {
      const detail = item.detail ? ` - ${item.detail}` : '';
      return `${item.status}: ${item.label}${detail}`;
    }),
  ].filter(Boolean);
  return lines.join('\n');
}

class TrackedTextProgressSurface implements ProgressSurface {
  private readonly platform: PlatformKind;
  private readonly thread: SourceThread;
  private readonly store: DeliveryStore;

  constructor(
    platform: PlatformKind,
    thread: SourceThread,
    store: DeliveryStore,
  ) {
    this.platform = platform;
    this.thread = thread;
    this.store = store;
  }

  async create(state: ProgressState): Promise<{ surfaceId: string }> {
    const surfaceId = `${this.platform}.surface.${randomUUID()}`;
    await this.record('progress.create', state, surfaceId);
    return { surfaceId };
  }

  async update(surfaceId: string, state: ProgressState): Promise<void> {
    await this.record('progress.update', state, surfaceId);
  }

  async complete(surfaceId: string, state: ProgressState): Promise<void> {
    await this.record('progress.complete', state, surfaceId);
  }

  private async record(
    kind: string,
    state: ProgressState,
    surfaceId: string,
  ): Promise<void> {
    const envelope = await this.store.enqueue({
      kind: `${this.platform}.${kind}`,
      target: {
        platform: this.platform,
        chatId: targetChatId(this.thread),
        cardId: surfaceId,
        rootId: this.thread.rootMessageId,
      },
      payload: {
        state,
        text: progressText(state),
      },
      runId: state.runId,
      thread: this.thread,
    });
    await this.store.markSending(envelope.id);
    await this.store.markDelivered(envelope.id, surfaceId);
  }
}

export class TrackedTextPlatformAdapter implements PlatformAdapter {
  readonly kind: PlatformKind;
  readonly capabilities: PlatformCapabilities;
  private readonly store: DeliveryStore;

  constructor(options: {
    kind: PlatformKind;
    store: DeliveryStore;
    capabilities?: Partial<PlatformCapabilities>;
  }) {
    this.kind = options.kind;
    this.store = options.store;
    this.capabilities = {
      supportsThreads: true,
      supportsCards: false,
      supportsFiles: true,
      supportsReactions: false,
      supportsMentions: true,
      ...options.capabilities,
    };
  }

  createProgressSurface(thread: SourceThread): ProgressSurface {
    return new TrackedTextProgressSurface(this.kind, thread, this.store);
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
    const artifactsText = artifactLines(artifacts);
    const envelope = await this.store.enqueue({
      kind: `${this.kind}.text`,
      target: {
        platform: this.kind,
        chatId: targetChatId(thread),
        rootId: thread.rootMessageId,
        replyToMessageId: options?.replyToMessageId,
      },
      payload: {
        text: artifactsText ? `${text}\n\nArtifacts:\n${artifactsText}` : text,
        stage: options?.stage || 'thread-reply',
        notificationId: options?.notificationId,
      },
      runId: options?.runId,
      thread,
      maxAttempts: options?.stage === 'routine-notification' ? 1 : undefined,
    });
    await this.store.markSending(envelope.id);
    await this.store.markDelivered(envelope.id);
  }
}
