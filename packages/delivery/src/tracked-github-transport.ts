import type {
  GitHubDeliveryMetadata,
  GitHubTransport,
} from '@opentag/platform-github';
import type { DeliveryStore } from './file-delivery-store.js';
import type { OutboundTarget } from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function target(
  input: {
    owner: string;
    repo: string;
    issueNumber?: number;
    commentId?: string;
  },
  metadata?: GitHubDeliveryMetadata,
): OutboundTarget {
  return {
    platform: 'github',
    chatId: `${input.owner}/${input.repo}`,
    topicId:
      input.issueNumber === undefined ? metadata?.thread?.topicId : String(input.issueNumber),
    cardId: input.commentId,
    rootId: metadata?.thread?.rootMessageId,
  };
}

export class TrackedGitHubTransport implements GitHubTransport {
  constructor(
    private readonly delegate: GitHubTransport,
    private readonly store: DeliveryStore,
  ) {}

  async createIssueComment(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }): Promise<{ commentId: string; url?: string }> {
    const envelope = await this.store.enqueue({
      kind:
        input.metadata?.stage === 'progress'
          ? 'github.progress.create'
          : 'github.comment',
      target: target(input, input.metadata),
      payload: { body: input.body, stage: input.metadata?.stage },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      const result = await this.delegate.createIssueComment(input);
      await this.store.markDelivered(envelope.id, result.commentId);
      return result;
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }

  async updateIssueComment(input: {
    owner: string;
    repo: string;
    commentId: string;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }): Promise<{ url?: string }> {
    const envelope = await this.store.enqueue({
      kind: 'github.progress.update',
      target: target(input, input.metadata),
      payload: { body: input.body, stage: input.metadata?.stage },
      runId: input.metadata?.runId,
      thread: input.metadata?.thread,
    });
    await this.store.markSending(envelope.id);
    try {
      const result = await this.delegate.updateIssueComment(input);
      await this.store.markDelivered(envelope.id, input.commentId);
      return result;
    } catch (error) {
      await this.store.markFailed(envelope.id, errorMessage(error));
      throw error;
    }
  }
}
