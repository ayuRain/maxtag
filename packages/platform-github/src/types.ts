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
  body?: string;
  state?: string;
  html_url?: string;
  pull_request?: Record<string, unknown>;
  user?: GitHubUser;
  labels?: Array<{ id?: number; name?: string; color?: string }>;
}

export interface GitHubPullRequest {
  id?: number;
  node_id?: string;
  number: number;
  title?: string;
  body?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  html_url?: string;
  user?: GitHubUser;
  labels?: Array<{ id?: number; name?: string; color?: string }>;
  head?: {
    ref?: string;
    sha?: string;
  };
  base?: {
    ref?: string;
    sha?: string;
  };
}

export interface GitHubWorkflowRun {
  id?: number;
  node_id?: string;
  name?: string;
  display_title?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  run_number?: number;
  run_attempt?: number;
  head_branch?: string;
  head_sha?: string;
  created_at?: string;
  updated_at?: string;
  actor?: GitHubUser;
  triggering_actor?: GitHubUser;
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
  number?: number;
  zen?: string;
  hook_id?: number;
  comment?: GitHubIssueComment;
  issue?: GitHubIssue;
  pull_request?: GitHubPullRequest;
  workflow_run?: GitHubWorkflowRun;
  repository?: GitHubRepository;
  sender?: GitHubUser;
  installation?: { id?: number; node_id?: string };
  [key: string]: unknown;
}

export interface GitHubDeliveryMetadata {
  runId?: string;
  thread?: SourceThread;
  stage?: 'progress' | 'thread-reply' | 'routine-notification';
  notificationId?: string;
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
