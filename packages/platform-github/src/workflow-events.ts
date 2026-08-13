import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepository,
  GitHubUser,
  GitHubWebhookPayload,
  GitHubWorkflowRun,
} from './types.js';

export const GITHUB_WORKFLOW_EVENT_CATALOG = [
  { value: 'github.pull_request.opened', label: 'GitHub / PR opened' },
  { value: 'github.pull_request.reopened', label: 'GitHub / PR reopened' },
  { value: 'github.pull_request.synchronize', label: 'GitHub / PR updated' },
  { value: 'github.pull_request.ready_for_review', label: 'GitHub / PR ready' },
  { value: 'github.pull_request.closed', label: 'GitHub / PR closed' },
  { value: 'github.pull_request.labeled', label: 'GitHub / PR labeled' },
  { value: 'github.issue.opened', label: 'GitHub / Issue opened' },
  { value: 'github.issue.reopened', label: 'GitHub / Issue reopened' },
  { value: 'github.issue.closed', label: 'GitHub / Issue closed' },
  { value: 'github.issue.labeled', label: 'GitHub / Issue labeled' },
  { value: 'github.workflow_run.failure', label: 'GitHub / CI failed' },
  { value: 'github.workflow_run.success', label: 'GitHub / CI passed' },
  { value: 'github.workflow_run.cancelled', label: 'GitHub / CI cancelled' },
  { value: 'github.workflow_run.timed_out', label: 'GitHub / CI timed out' },
  { value: 'github.workflow_run.requested', label: 'GitHub / CI requested' },
  { value: 'github.workflow_run.in_progress', label: 'GitHub / CI running' },
] as const;

export interface GitHubWorkflowEvent {
  provider: 'github';
  eventType: string;
  eventId: string;
  repositoryExternalId: string;
  resourceExternalId: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface NormalizeGitHubWorkflowEventOptions {
  eventType: string;
  deliveryId: string;
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function actionName(value: unknown): string | undefined {
  const normalized = bounded(value, 60)?.toLowerCase();
  return normalized && /^[a-z0-9_]+$/u.test(normalized)
    ? normalized
    : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function userPayload(user: GitHubUser | undefined): Record<string, unknown> | undefined {
  if (!user?.login) return undefined;
  return {
    id: safeNumber(user.id),
    nodeId: bounded(user.node_id, 200),
    login: bounded(user.login, 200),
    type: bounded(user.type, 40),
  };
}

function labelsPayload(
  labels: Array<{ id?: number; name?: string; color?: string }> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(labels)) return undefined;
  const selected = labels.slice(0, 50).flatMap((label) => {
    const name = bounded(label.name, 100);
    if (!name) return [];
    return [{ id: safeNumber(label.id), name, color: bounded(label.color, 20) }];
  });
  return selected.length ? selected : undefined;
}

function repositoryPayload(repository: GitHubRepository): Record<string, unknown> {
  return {
    id: safeNumber(repository.id),
    nodeId: bounded(repository.node_id, 200),
    name: bounded(repository.name, 200),
    fullName: bounded(repository.full_name, 500),
    private: Boolean(repository.private),
    url: bounded(repository.html_url, 2_000),
    owner: userPayload(repository.owner),
  };
}

function commonPayload(input: {
  body: GitHubWebhookPayload;
  eventType: string;
  deliveryId: string;
  normalizedEventType: string;
}): Record<string, unknown> {
  const actor = input.body.sender;
  return {
    schemaVersion: 1,
    provider: 'github',
    eventType: input.normalizedEventType,
    source: {
      kind: 'webhook',
      webhookEvent: input.eventType,
      action: actionName(input.body.action),
      deliveryId: input.deliveryId.slice(0, 500),
    },
    repository: repositoryPayload(input.body.repository as GitHubRepository),
    actor: userPayload(actor),
    installationId: safeNumber(input.body.installation?.id),
  };
}

function pullRequestPayload(pullRequest: GitHubPullRequest): Record<string, unknown> {
  return {
    id: safeNumber(pullRequest.id),
    nodeId: bounded(pullRequest.node_id, 200),
    number: safeNumber(pullRequest.number),
    title: bounded(pullRequest.title, 500),
    body: bounded(pullRequest.body, 8_000),
    state: bounded(pullRequest.state, 40),
    draft: Boolean(pullRequest.draft),
    merged: Boolean(pullRequest.merged),
    url: bounded(pullRequest.html_url, 2_000),
    author: userPayload(pullRequest.user),
    labels: labelsPayload(pullRequest.labels),
    head: {
      ref: bounded(pullRequest.head?.ref, 300),
      sha: bounded(pullRequest.head?.sha, 100),
    },
    base: {
      ref: bounded(pullRequest.base?.ref, 300),
      sha: bounded(pullRequest.base?.sha, 100),
    },
  };
}

function issuePayload(issue: GitHubIssue): Record<string, unknown> {
  return {
    id: safeNumber(issue.id),
    nodeId: bounded(issue.node_id, 200),
    number: safeNumber(issue.number),
    title: bounded(issue.title, 500),
    body: bounded(issue.body, 8_000),
    state: bounded(issue.state, 40),
    url: bounded(issue.html_url, 2_000),
    author: userPayload(issue.user),
    labels: labelsPayload(issue.labels),
  };
}

function workflowRunPayload(workflowRun: GitHubWorkflowRun): Record<string, unknown> {
  return {
    id: safeNumber(workflowRun.id),
    nodeId: bounded(workflowRun.node_id, 200),
    name: bounded(workflowRun.name, 300),
    displayTitle: bounded(workflowRun.display_title, 500),
    trigger: bounded(workflowRun.event, 80),
    status: bounded(workflowRun.status, 40),
    conclusion: actionName(workflowRun.conclusion),
    url: bounded(workflowRun.html_url, 2_000),
    runNumber: safeNumber(workflowRun.run_number),
    runAttempt: safeNumber(workflowRun.run_attempt),
    headBranch: bounded(workflowRun.head_branch, 300),
    headSha: bounded(workflowRun.head_sha, 100),
    createdAt: bounded(workflowRun.created_at, 80),
    updatedAt: bounded(workflowRun.updated_at, 80),
    actor: userPayload(workflowRun.actor),
    triggeringActor: userPayload(workflowRun.triggering_actor),
  };
}

export function normalizeGitHubWorkflowEvent(
  body: GitHubWebhookPayload,
  options: NormalizeGitHubWorkflowEventOptions,
): GitHubWorkflowEvent | null {
  const repository = body.repository;
  const repositoryExternalId = bounded(repository?.full_name, 500);
  const action = actionName(body.action);
  const deliveryId = bounded(options.deliveryId, 500);
  if (!repository || !repositoryExternalId || !action || !deliveryId) return null;

  let normalizedEventType: string;
  let resourceExternalId: string;
  let resource: Record<string, unknown>;
  if (options.eventType === 'pull_request') {
    const pullRequest = body.pull_request;
    if (!pullRequest?.number) return null;
    normalizedEventType = `github.pull_request.${action}`;
    resourceExternalId = `${repositoryExternalId}#${pullRequest.number}`;
    resource = { pullRequest: pullRequestPayload(pullRequest) };
  } else if (options.eventType === 'issues') {
    const issue = body.issue;
    if (!issue?.number || issue.pull_request) return null;
    normalizedEventType = `github.issue.${action}`;
    resourceExternalId = `${repositoryExternalId}#${issue.number}`;
    resource = { issue: issuePayload(issue) };
  } else if (options.eventType === 'workflow_run') {
    const workflowRun = body.workflow_run;
    if (!workflowRun?.id) return null;
    const outcome =
      action === 'completed'
        ? actionName(workflowRun.conclusion) || action
        : action;
    normalizedEventType = `github.workflow_run.${outcome}`;
    resourceExternalId = `${repositoryExternalId}/actions/runs/${workflowRun.id}`;
    resource = { workflowRun: workflowRunPayload(workflowRun) };
  } else {
    return null;
  }

  const actorLogin = bounded(body.sender?.login, 200) || 'github';
  return {
    provider: 'github',
    eventType: normalizedEventType,
    eventId: deliveryId,
    repositoryExternalId,
    resourceExternalId,
    actor: `github:${actorLogin}`,
    payload: {
      ...commonPayload({
        body,
        eventType: options.eventType,
        deliveryId,
        normalizedEventType,
      }),
      resourceExternalId,
      ...resource,
    },
  };
}
