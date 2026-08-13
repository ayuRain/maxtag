import type {
  GitHubDeliveryMetadata,
  GitHubTransport,
} from './types.js';

export interface HttpGitHubTransportOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface GitHubCommentResponse {
  id?: number;
  html_url?: string;
  message?: string;
  documentation_url?: string;
}

function repositoryPath(owner: string, repo: string): string {
  if (!owner.trim() || !repo.trim()) {
    throw new Error('GitHub owner and repository are required.');
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export class GitHubApiError extends Error {
  readonly statusCode?: number;
  readonly documentationUrl?: string;

  constructor(input: {
    message: string;
    statusCode?: number;
    documentationUrl?: string;
  }) {
    super(input.message);
    this.name = 'GitHubApiError';
    this.statusCode = input.statusCode;
    this.documentationUrl = input.documentationUrl;
  }
}

export class HttpGitHubTransport implements GitHubTransport {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpGitHubTransportOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl || 'https://api.github.com').replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createIssueComment(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }): Promise<{ commentId: string; url?: string }> {
    const result = await this.request(
      'POST',
      `/repos/${repositoryPath(input.owner, input.repo)}/issues/${input.issueNumber}/comments`,
      input.body,
    );
    if (typeof result.id !== 'number') {
      throw new GitHubApiError({
        message: 'GitHub create issue comment response did not include an id.',
      });
    }
    return { commentId: String(result.id), url: result.html_url };
  }

  async updateIssueComment(input: {
    owner: string;
    repo: string;
    commentId: string;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }): Promise<{ url?: string }> {
    const result = await this.request(
      'PATCH',
      `/repos/${repositoryPath(input.owner, input.repo)}/issues/comments/${encodeURIComponent(input.commentId)}`,
      input.body,
    );
    return { url: result.html_url };
  }

  private async request(
    method: 'POST' | 'PATCH',
    pathname: string,
    body: string,
  ): Promise<GitHubCommentResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'MaxTag',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
    });
    const text = await response.text();
    let parsed: GitHubCommentResponse;
    try {
      parsed = text ? (JSON.parse(text) as GitHubCommentResponse) : {};
    } catch {
      throw new GitHubApiError({
        statusCode: response.status,
        message:
          text ||
          `GitHub issue comment request returned invalid JSON with HTTP ${response.status}.`,
      });
    }
    if (!response.ok) {
      throw new GitHubApiError({
        statusCode: response.status,
        documentationUrl: parsed.documentation_url,
        message:
          parsed.message ||
          `GitHub issue comment request failed with HTTP ${response.status}.`,
      });
    }
    return parsed;
  }
}
