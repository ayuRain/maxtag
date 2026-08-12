import type {
  GitHubDeliveryMetadata,
  GitHubTransport,
} from './types.js';

export class MemoryGitHubTransport implements GitHubTransport {
  readonly comments: Array<{
    commentId: string;
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }> = [];
  readonly updates: Array<{
    owner: string;
    repo: string;
    commentId: string;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }> = [];
  private nextCommentId = 1;

  async createIssueComment(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }): Promise<{ commentId: string; url?: string }> {
    const commentId = String(this.nextCommentId++);
    this.comments.push({ commentId, ...input });
    return {
      commentId,
      url: `https://github.test/${input.owner}/${input.repo}/issues/${input.issueNumber}#issuecomment-${commentId}`,
    };
  }

  async updateIssueComment(input: {
    owner: string;
    repo: string;
    commentId: string;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }): Promise<{ url?: string }> {
    this.updates.push(input);
    return {
      url: `https://github.test/${input.owner}/${input.repo}/issues/comments/${input.commentId}`,
    };
  }
}
