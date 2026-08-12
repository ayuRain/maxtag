import type { SourceThread } from '@opentag/core';

export interface GitHubUser {
  id?: number;
  node_id?: string;
  login: string;
  type?: string;
}

export interface GitHubRepository {
  id?: number;
  node_id?: string;
  name: string;
  full_name: string;
  private?: boolean;
  html_url?: string;
  owner?: GitHubUser;
}

export interface GitHubIssue {
  id?: number;
  node_id?: string;
  number: number;
  title?: string;
  html_url?: string;
  pull_request?: Record<string, unknown>;
}

export interface GitHubIssueComment {
  id: number;
  node_id?: string;
  body?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  author_association?: string;
  user?: GitHubUser;
}

export interface GitHubWebhookPayload {
  action?: string;
  zen?: string;
  hook_id?: number;
  comment?: GitHubIssueComment;
  issue?: GitHubIssue;
  repository?: GitHubRepository;
  sender?: GitHubUser;
  installation?: { id?: number; node_id?: string };
  [key: string]: unknown;
}

export interface GitHubDeliveryMetadata {
  runId?: string;
  thread?: SourceThread;
  stage?: 'progress' | 'thread-reply';
}

export interface GitHubTransport {
  createIssueComment(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }): Promise<{ commentId: string; url?: string }>;
  updateIssueComment(input: {
    owner: string;
    repo: string;
    commentId: string;
    body: string;
    metadata?: GitHubDeliveryMetadata;
  }): Promise<{ url?: string }>;
}
