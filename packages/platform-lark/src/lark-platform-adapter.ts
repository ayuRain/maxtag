import type {
  Artifact,
  MemoryProposal,
  PlatformAdapter,
  PlatformCapabilities,
  ProgressState,
  ProgressSurface,
  SourceThread,
  ToolApprovalRecord,
} from '@opentag/core';
import {
  buildLarkMemoryProposalCard,
  buildLarkProgressCard,
  buildLarkToolApprovalCard,
} from '@opentag/ui-cards';
import path from 'node:path';
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

  async sendMemoryProposalCard(
    thread: SourceThread,
    proposal: MemoryProposal,
    options?: {
      runId?: string;
      replyToMessageId?: string;
    },
  ): Promise<{ cardId: string }> {
    return this.transport.createCard({
      chatId: thread.channelId || thread.externalId,
      rootId: thread.rootMessageId,
      replyToMessageId: options?.replyToMessageId,
      card: buildLarkMemoryProposalCard(proposal) as unknown as Record<
        string,
        unknown
      >,
      metadata: {
        runId: options?.runId,
        thread,
        stage: 'memory-proposal-card',
        proposalId: proposal.id,
      },
    });
  }

  async updateMemoryProposalCard(input: {
    thread: SourceThread;
    proposal: MemoryProposal;
    cardId: string;
    runId?: string;
  }): Promise<void> {
    await this.transport.updateCard({
      cardId: input.cardId,
      card: buildLarkMemoryProposalCard(
        input.proposal,
      ) as unknown as Record<string, unknown>,
      metadata: {
        runId: input.runId,
        thread: input.thread,
        stage: 'memory-proposal-card',
        proposalId: input.proposal.id,
      },
    });
  }

  async sendToolApprovalCard(
    thread: SourceThread,
    approval: ToolApprovalRecord,
    options?: {
      runId?: string;
      replyToMessageId?: string;
    },
  ): Promise<{ cardId: string }> {
    return this.transport.createCard({
      chatId: thread.channelId || thread.externalId,
      rootId: thread.rootMessageId,
      replyToMessageId: options?.replyToMessageId,
      card: buildLarkToolApprovalCard(approval) as unknown as Record<
        string,
        unknown
      >,
      metadata: {
        runId: options?.runId,
        thread,
        stage: 'tool-approval-card',
        approvalId: approval.id,
      },
    });
  }

  async updateToolApprovalCard(input: {
    thread: SourceThread;
    approval: ToolApprovalRecord;
    cardId: string;
    runId?: string;
  }): Promise<void> {
    await this.transport.updateCard({
      cardId: input.cardId,
      card: buildLarkToolApprovalCard(
        input.approval,
      ) as unknown as Record<string, unknown>,
      metadata: {
        runId: input.runId,
        thread: input.thread,
        stage: 'tool-approval-card',
        approvalId: input.approval.id,
      },
    });
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
    const artifactLines = (artifacts || [])
      .filter((artifact) => artifact.url)
      .map((artifact) => `- ${artifact.title}: ${artifact.url}`)
      .join('\n');
    await this.transport.sendText({
      chatId: thread.channelId || thread.externalId,
      rootId: thread.rootMessageId,
      replyToMessageId: options?.replyToMessageId,
      text: artifactLines ? `${text}\n\nArtifacts:\n${artifactLines}` : text,
      metadata: {
        runId: options?.runId,
        thread,
        stage: options?.stage || 'thread-reply',
        notificationId: options?.notificationId,
      },
    });

    for (const artifact of artifacts || []) {
      if (!artifact.path) continue;
      await this.transport.sendFile({
        chatId: thread.channelId || thread.externalId,
        rootId: thread.rootMessageId,
        replyToMessageId: options?.replyToMessageId,
        file: {
          path: artifact.path,
          name:
            typeof artifact.metadata?.filename === 'string'
              ? artifact.metadata.filename
              : path.basename(artifact.path),
          mimeType:
            typeof artifact.metadata?.mimeType === 'string'
              ? artifact.metadata.mimeType
              : undefined,
        },
        metadata: {
          runId: options?.runId,
          thread,
          stage: 'artifact',
          artifactId: artifact.id,
        },
      });
    }
  }
}
