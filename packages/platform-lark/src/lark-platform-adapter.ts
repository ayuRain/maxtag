import type {
  Artifact,
  PlatformAdapter,
  PlatformCapabilities,
  ProgressState,
  ProgressSurface,
  SourceThread,
} from '@opentag/core';
import { buildLarkProgressCard } from '@opentag/ui-cards';
import type { LarkTransport } from './types.js';

class LarkProgressSurface implements ProgressSurface {
  private readonly thread: SourceThread;
  private readonly transport: LarkTransport;

  constructor(thread: SourceThread, transport: LarkTransport) {
    this.thread = thread;
    this.transport = transport;
  }

  async create(state: ProgressState): Promise<{ surfaceId: string }> {
    const result = await this.transport.createCard({
      chatId: this.thread.channelId || this.thread.externalId,
      rootId: this.thread.rootMessageId,
      card: buildLarkProgressCard(state) as unknown as Record<string, unknown>,
      metadata: {
        runId: state.runId,
        thread: this.thread,
        stage: 'progress-card',
      },
    });
    return { surfaceId: result.cardId };
  }

  async update(surfaceId: string, state: ProgressState): Promise<void> {
    await this.transport.updateCard({
      cardId: surfaceId,
      card: buildLarkProgressCard(state) as unknown as Record<string, unknown>,
      metadata: {
        runId: state.runId,
        thread: this.thread,
        stage: 'progress-card',
      },
    });
  }

  async complete(surfaceId: string, state: ProgressState): Promise<void> {
    await this.update(surfaceId, state);
  }
}

export class LarkPlatformAdapter implements PlatformAdapter {
  readonly kind = 'lark' as const;
  readonly capabilities: PlatformCapabilities = {
    supportsThreads: true,
    supportsCards: true,
    supportsFiles: true,
    supportsReactions: true,
    supportsMentions: true,
  };

  private readonly transport: LarkTransport;

  constructor(transport: LarkTransport) {
    this.transport = transport;
  }

  createProgressSurface(thread: SourceThread): ProgressSurface {
    return new LarkProgressSurface(thread, this.transport);
  }

  async sendMessage(
    thread: SourceThread,
    text: string,
    artifacts?: Artifact[],
    options?: { runId?: string },
  ): Promise<void> {
    const artifactLines = (artifacts || [])
      .filter((artifact) => artifact.url)
      .map((artifact) => `- ${artifact.title}: ${artifact.url}`)
      .join('\n');
    await this.transport.sendText({
      chatId: thread.channelId || thread.externalId,
      rootId: thread.rootMessageId,
      text: artifactLines ? `${text}\n\nArtifacts:\n${artifactLines}` : text,
      metadata: {
        runId: options?.runId,
        thread,
        stage: 'thread-reply',
      },
    });
  }
}
