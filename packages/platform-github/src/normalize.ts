import type { SourceMessage, SourceThread } from '@opentag/core';
import type { GitHubUser, GitHubWebhookPayload } from './types.js';

export interface NormalizeGitHubOptions {
  eventType?: string;
  botLogin?: string;
  workspaceId?: string;
  ignoreBotMessages?: boolean;
}

function normalizedLogin(value: string | undefined): string | undefined {
  const login = value?.trim().replace(/^@/u, '').toLowerCase();
  return login || undefined;
}

function userIsBot(user: GitHubUser | undefined, botLogin?: string): boolean {
  if (!user) return false;
  return (
    user.type?.toLowerCase() === 'bot' ||
    normalizedLogin(user.login) === normalizedLogin(botLogin)
  );
}

function mentionsAgent(text: string, botLogin?: string): boolean {
  const login = normalizedLogin(botLogin) || 'opentag';
  const lower = text.toLowerCase();
  return (
    lower.includes(`@${login}`) ||
    /^\s*\/opentag(?:\s|$)/iu.test(text)
  );
}

function repositoryParts(fullName: string): { owner: string; repo: string } | null {
  const separator = fullName.indexOf('/');
  if (separator <= 0 || separator === fullName.length - 1) return null;
  return {
    owner: fullName.slice(0, separator),
    repo: fullName.slice(separator + 1),
  };
}

export function normalizeGitHubWebhook(
  body: GitHubWebhookPayload,
  options: NormalizeGitHubOptions = {},
): { thread: SourceThread; message: SourceMessage } | null {
  if (options.eventType !== 'issue_comment' || body.action !== 'created') {
    return null;
  }
  const comment = body.comment;
  const issue = body.issue;
  const repository = body.repository;
  if (!comment?.id || !issue?.number || !repository?.full_name) return null;
  const parts = repositoryParts(repository.full_name);
  if (!parts) return null;

  const actor = comment.user || body.sender;
  if ((options.ignoreBotMessages ?? true) && userIsBot(actor, options.botLogin)) {
    return null;
  }

  const repositoryId = repository.full_name;
  const issueNumber = String(issue.number);
  const externalId = `${repositoryId}#${issueNumber}`;
  const text = comment.body || '';
  if (/^\s*<!--\s*opentag-(?:progress|reply):/iu.test(text)) return null;
  const actorLogin = actor?.login || 'unknown';
  const isPullRequest = Boolean(issue.pull_request);
  const thread: SourceThread = {
    id: `github:${externalId}`,
    platform: 'github',
    externalId,
    workspaceId: options.workspaceId || 'dev-workspace',
    projectId: repositoryId,
    channelId: repositoryId,
    rootMessageId: issueNumber,
    topicId: issueNumber,
    title: `${repository.name} #${issueNumber}${issue.title ? `: ${issue.title}` : ''}`,
    visibility: repository.private ? 'private' : 'public',
    permalink: issue.html_url,
    metadata: {
      owner: parts.owner,
      repo: parts.repo,
      repository: repositoryId,
      repositoryId: repository.id,
      issueNumber: issue.number,
      issueNodeId: issue.node_id,
      issueUrl: issue.html_url,
      isPullRequest,
      incomingCommentId: String(comment.id),
      incomingCommentUrl: comment.html_url,
      eventType: options.eventType,
      installationId: body.installation?.id,
    },
  };

  return {
    thread,
    message: {
      id: String(comment.id),
      threadId: thread.id,
      platform: 'github',
      text,
      actor: {
        id: actorLogin,
        platformUserId: actorLogin,
        displayName: actorLogin,
        isBot: userIsBot(actor, options.botLogin),
      },
      createdAt: comment.created_at || new Date().toISOString(),
      mentionsAgent: mentionsAgent(text, options.botLogin),
      metadata: {
        eventType: options.eventType,
        action: body.action,
        authorAssociation: comment.author_association,
        commentUrl: comment.html_url,
        issueNumber: issue.number,
        isPullRequest,
      },
    },
  };
}
