import type {
  Artifact,
  PlatformAdapter,
  PlatformCapabilities,
  ProgressSurface,
  SourceThread,
} from '@opentag/core';

class TelegramReceiptSurface implements ProgressSurface {
  async create(): Promise<{ surfaceId: string }> {
    return { surfaceId: 'telegram-receipt-placeholder' };
  }

  async update(): Promise<void> {
    return undefined;
  }

  async complete(): Promise<void> {
    return undefined;
  }
}

export class TelegramPlatformAdapter implements PlatformAdapter {
  readonly kind = 'telegram' as const;
  readonly capabilities: PlatformCapabilities = {
    supportsThreads: false,
    supportsCards: false,
    supportsFiles: true,
    supportsReactions: false,
    supportsMentions: true,
  };

  createProgressSurface(_thread: SourceThread): ProgressSurface {
    return new TelegramReceiptSurface();
  }

  async sendMessage(
    _thread: SourceThread,
    _text: string,
    _artifacts?: Artifact[],
    _options?: { runId?: string; replyToMessageId?: string },
  ): Promise<void> {
    throw new Error('Telegram transport is not implemented yet.');
  }
}
