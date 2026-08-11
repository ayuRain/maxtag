import type { Artifact, ToolGrant } from '@opentag/core';

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
  defaultBranch?: string;
}

export interface DraftPullRequestInput {
  repository: GitHubRepositoryRef;
  branch: string;
  title: string;
  body: string;
  baseBranch?: string;
}

export interface GitHubToolProvider {
  readonly grant: ToolGrant;
  createDraftPullRequest(input: DraftPullRequestInput): Promise<Artifact>;
}

export function githubGrant(input: {
  id: string;
  label: string;
  repositories?: GitHubRepositoryRef[];
}): ToolGrant {
  return {
    id: input.id,
    kind: 'github',
    scope: 'channel',
    label: input.label,
    constraints: {
      repositories: input.repositories ?? [],
    },
  };
}

