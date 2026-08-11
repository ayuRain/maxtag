import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlatformKind, SourceActor } from '@opentag/core';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';
export type WorkspaceMemberStatus = 'active' | 'suspended';
export type ProjectRole = 'manager' | 'contributor' | 'viewer';
export type ProjectAccessMode = 'open' | 'workspace' | 'members';
export type ActorCapability =
  | 'invoke_agent'
  | 'write_memory'
  | 'manage_routines';

export interface WorkspaceMemberIdentity {
  platform: PlatformKind;
  externalId: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  displayName: string;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  identities: WorkspaceMemberIdentity[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMembership {
  id: string;
  workspaceId: string;
  projectId: string;
  memberId: string;
  role: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAccessPolicy {
  id: string;
  workspaceId: string;
  projectId: string;
  mode: ProjectAccessMode;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceAccessAuditAction =
  | 'member.created'
  | 'member.updated'
  | 'member.removed'
  | 'project_access.updated'
  | 'project_member.added'
  | 'project_member.updated'
  | 'project_member.removed';

export interface WorkspaceAccessAuditRecord {
  id: string;
  workspaceId: string;
  projectId?: string;
  memberId?: string;
  action: WorkspaceAccessAuditAction;
  actor: string;
  at: string;
  snapshot?: Record<string, unknown>;
}

export interface WorkspaceAccessState {
  version: 1;
  members: WorkspaceMember[];
  projectMemberships: ProjectMembership[];
  projectPolicies: ProjectAccessPolicy[];
  audit: WorkspaceAccessAuditRecord[];
}

export interface UpsertWorkspaceMemberInput {
  id?: string;
  workspaceId: string;
  displayName: string;
  role?: WorkspaceRole;
  status?: WorkspaceMemberStatus;
  identities: WorkspaceMemberIdentity[];
  actor?: string;
}

export interface UpsertProjectMembershipInput {
  workspaceId: string;
  projectId: string;
  memberId: string;
  role: ProjectRole;
  actor?: string;
}

export interface SetProjectAccessPolicyInput {
  workspaceId: string;
  projectId: string;
  mode: ProjectAccessMode;
  actor?: string;
}

export interface AuthorizeSourceActorInput {
  workspaceId: string;
  projectId: string;
  platform: PlatformKind;
  actor: SourceActor;
  capability: ActorCapability;
}

export interface ActorAuthorizationDecision {
  allowed: boolean;
  capability: ActorCapability;
  mode: ProjectAccessMode;
  reason:
    | 'open_access'
    | 'workspace_role'
    | 'project_role'
    | 'workspace_member_required'
    | 'workspace_member_suspended'
    | 'project_member_required'
    | 'capability_not_granted';
  member?: WorkspaceMember;
  projectMembership?: ProjectMembership;
  capabilities: ActorCapability[];
}

export interface WorkspaceAccessSnapshot {
  workspaceId: string;
  members: WorkspaceMember[];
  projectMemberships: ProjectMembership[];
  projectPolicies: ProjectAccessPolicy[];
  audit: WorkspaceAccessAuditRecord[];
}

const ALL_CAPABILITIES: ActorCapability[] = [
  'invoke_agent',
  'write_memory',
  'manage_routines',
];

function now(): string {
  return new Date().toISOString();
}

function required(value: string, error: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(error);
  return normalized;
}

function projectKey(workspaceId: string, value: string): string {
  const normalized = required(value, 'project_access_project_required');
  const prefix = `${workspaceId}:`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function policyId(workspaceId: string, projectId: string): string {
  return `${workspaceId}:${projectId}`;
}

function membershipId(
  workspaceId: string,
  projectId: string,
  memberId: string,
): string {
  return `${workspaceId}:${projectId}:${memberId}`;
}

function normalizeIdentities(
  identities: WorkspaceMemberIdentity[],
): WorkspaceMemberIdentity[] {
  const normalized = new Map<string, WorkspaceMemberIdentity>();
  for (const identity of identities) {
    const platform = required(
      String(identity.platform || ''),
      'workspace_member_identity_platform_required',
    ) as PlatformKind;
    const externalId = required(
      identity.externalId,
      'workspace_member_identity_external_id_required',
    );
    normalized.set(`${platform}:${externalId}`, { platform, externalId });
  }
  if (!normalized.size) {
    throw new Error('workspace_member_identity_required');
  }
  return [...normalized.values()];
}

function cloneMember(member: WorkspaceMember): WorkspaceMember {
  return {
    ...member,
    identities: member.identities.map((identity) => ({ ...identity })),
  };
}

function cloneMembership(membership: ProjectMembership): ProjectMembership {
  return { ...membership };
}

function clonePolicy(policy: ProjectAccessPolicy): ProjectAccessPolicy {
  return { ...policy };
}

function cloneAudit(record: WorkspaceAccessAuditRecord): WorkspaceAccessAuditRecord {
  return {
    ...record,
    snapshot: record.snapshot ? { ...record.snapshot } : undefined,
  };
}

export function createEmptyWorkspaceAccessState(): WorkspaceAccessState {
  return {
    version: 1,
    members: [],
    projectMemberships: [],
    projectPolicies: [],
    audit: [],
  };
}

export function normalizeWorkspaceAccessState(
  input: Partial<WorkspaceAccessState>,
): WorkspaceAccessState {
  return {
    version: 1,
    members: input.members ?? [],
    projectMemberships: input.projectMemberships ?? [],
    projectPolicies: input.projectPolicies ?? [],
    audit: input.audit ?? [],
  };
}

function appendAudit(
  state: WorkspaceAccessState,
  input: Omit<WorkspaceAccessAuditRecord, 'id' | 'at'>,
  timestamp: string,
): void {
  state.audit.push({
    id: randomUUID(),
    at: timestamp,
    ...input,
  });
  if (state.audit.length > 1_000) {
    state.audit.splice(0, state.audit.length - 1_000);
  }
}

function activeOwnerCount(
  state: WorkspaceAccessState,
  workspaceId: string,
  exceptMemberId?: string,
): number {
  return state.members.filter(
    (member) =>
      member.workspaceId === workspaceId &&
      member.id !== exceptMemberId &&
      member.status === 'active' &&
      member.role === 'owner',
  ).length;
}

function ensureIdentityIsAvailable(
  state: WorkspaceAccessState,
  workspaceId: string,
  memberId: string,
  identities: WorkspaceMemberIdentity[],
): void {
  const requested = new Set(
    identities.map((identity) => `${identity.platform}:${identity.externalId}`),
  );
  const conflict = state.members.find(
    (member) =>
      member.workspaceId === workspaceId &&
      member.id !== memberId &&
      member.identities.some((identity) =>
        requested.has(`${identity.platform}:${identity.externalId}`),
      ),
  );
  if (conflict) throw new Error('workspace_member_identity_already_linked');
}

function capabilitiesForWorkspaceRole(role: WorkspaceRole): ActorCapability[] {
  if (role === 'owner' || role === 'admin') return [...ALL_CAPABILITIES];
  if (role === 'member') return ['invoke_agent', 'write_memory'];
  return ['invoke_agent'];
}

function capabilitiesForProjectRole(role: ProjectRole): ActorCapability[] {
  if (role === 'manager') return [...ALL_CAPABILITIES];
  if (role === 'contributor') return ['invoke_agent', 'write_memory'];
  return [];
}

export class FileWorkspaceAccessStore {
  private readonly stateFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'workspace-access.json');
  }

  protected async load(): Promise<WorkspaceAccessState> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as Partial<WorkspaceAccessState>;
      return normalizeWorkspaceAccessState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createEmptyWorkspaceAccessState();
      }
      throw error;
    }
  }

  protected async save(state: WorkspaceAccessState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporaryFile, this.stateFile);
  }

  protected async readState(): Promise<WorkspaceAccessState> {
    await this.mutationQueue;
    return this.load();
  }

  protected async mutate<T>(
    operation: (state: WorkspaceAccessState) => T,
  ): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = operation(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async snapshot(workspaceId: string, auditLimit = 50): Promise<WorkspaceAccessSnapshot> {
    const normalizedWorkspaceId = required(
      workspaceId,
      'workspace_access_workspace_required',
    );
    const state = await this.readState();
    return {
      workspaceId: normalizedWorkspaceId,
      members: state.members
        .filter((member) => member.workspaceId === normalizedWorkspaceId)
        .sort((left, right) => left.displayName.localeCompare(right.displayName))
        .map(cloneMember),
      projectMemberships: state.projectMemberships
        .filter((membership) => membership.workspaceId === normalizedWorkspaceId)
        .map(cloneMembership),
      projectPolicies: state.projectPolicies
        .filter((policy) => policy.workspaceId === normalizedWorkspaceId)
        .map(clonePolicy),
      audit: state.audit
        .filter((record) => record.workspaceId === normalizedWorkspaceId)
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, Math.max(1, Math.min(auditLimit, 200)))
        .map(cloneAudit),
    };
  }

  async upsertMember(input: UpsertWorkspaceMemberInput): Promise<WorkspaceMember> {
    return this.mutate((state) => {
      const workspaceId = required(
        input.workspaceId,
        'workspace_member_workspace_required',
      );
      const displayName = required(
        input.displayName,
        'workspace_member_display_name_required',
      );
      const identities = normalizeIdentities(input.identities);
      const existing = input.id
        ? state.members.find(
            (member) => member.id === input.id && member.workspaceId === workspaceId,
          )
        : undefined;
      if (input.id && !existing) throw new Error('workspace_member_not_found');
      const role = input.role ?? existing?.role ?? 'member';
      const status = input.status ?? existing?.status ?? 'active';
      const workspaceMembers = state.members.filter(
        (member) => member.workspaceId === workspaceId,
      );
      if (!existing && !workspaceMembers.length && role !== 'owner') {
        throw new Error('workspace_first_member_must_be_owner');
      }
      const id = existing?.id ?? input.id ?? randomUUID();
      ensureIdentityIsAvailable(state, workspaceId, id, identities);
      if (
        existing?.role === 'owner' &&
        existing.status === 'active' &&
        (role !== 'owner' || status !== 'active') &&
        activeOwnerCount(state, workspaceId, existing.id) === 0
      ) {
        throw new Error('workspace_last_owner_required');
      }
      const timestamp = now();
      const member: WorkspaceMember = {
        id,
        workspaceId,
        displayName,
        role,
        status,
        identities,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (existing) {
        state.members.splice(state.members.indexOf(existing), 1, member);
      } else {
        state.members.push(member);
      }
      appendAudit(
        state,
        {
          workspaceId,
          memberId: member.id,
          action: existing ? 'member.updated' : 'member.created',
          actor: input.actor?.trim() || 'admin-console',
          snapshot: cloneMember(member) as unknown as Record<string, unknown>,
        },
        timestamp,
      );
      return cloneMember(member);
    });
  }

  async removeMember(
    workspaceId: string,
    memberId: string,
    actor = 'admin-console',
  ): Promise<WorkspaceMember | undefined> {
    return this.mutate((state) => {
      const member = state.members.find(
        (candidate) =>
          candidate.workspaceId === workspaceId && candidate.id === memberId,
      );
      if (!member) return undefined;
      if (
        member.role === 'owner' &&
        member.status === 'active' &&
        activeOwnerCount(state, workspaceId, member.id) === 0
      ) {
        throw new Error('workspace_last_owner_required');
      }
      state.members.splice(state.members.indexOf(member), 1);
      state.projectMemberships = state.projectMemberships.filter(
        (membership) => membership.memberId !== member.id,
      );
      appendAudit(
        state,
        {
          workspaceId,
          memberId: member.id,
          action: 'member.removed',
          actor,
          snapshot: cloneMember(member) as unknown as Record<string, unknown>,
        },
        now(),
      );
      return cloneMember(member);
    });
  }

  async setProjectPolicy(
    input: SetProjectAccessPolicyInput,
  ): Promise<ProjectAccessPolicy> {
    return this.mutate((state) => {
      const workspaceId = required(
        input.workspaceId,
        'project_access_workspace_required',
      );
      const projectId = projectKey(workspaceId, input.projectId);
      const existing = state.projectPolicies.find(
        (policy) =>
          policy.workspaceId === workspaceId && policy.projectId === projectId,
      );
      const timestamp = now();
      const policy: ProjectAccessPolicy = {
        id: policyId(workspaceId, projectId),
        workspaceId,
        projectId,
        mode: input.mode,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (existing) {
        state.projectPolicies.splice(state.projectPolicies.indexOf(existing), 1, policy);
      } else {
        state.projectPolicies.push(policy);
      }
      appendAudit(
        state,
        {
          workspaceId,
          projectId,
          action: 'project_access.updated',
          actor: input.actor?.trim() || 'admin-console',
          snapshot: { ...policy },
        },
        timestamp,
      );
      return clonePolicy(policy);
    });
  }

  async upsertProjectMembership(
    input: UpsertProjectMembershipInput,
  ): Promise<ProjectMembership> {
    return this.mutate((state) => {
      const workspaceId = required(
        input.workspaceId,
        'project_member_workspace_required',
      );
      const projectId = projectKey(workspaceId, input.projectId);
      const member = state.members.find(
        (candidate) =>
          candidate.workspaceId === workspaceId && candidate.id === input.memberId,
      );
      if (!member) throw new Error('workspace_member_not_found');
      const existing = state.projectMemberships.find(
        (membership) =>
          membership.workspaceId === workspaceId &&
          membership.projectId === projectId &&
          membership.memberId === member.id,
      );
      const timestamp = now();
      const membership: ProjectMembership = {
        id: membershipId(workspaceId, projectId, member.id),
        workspaceId,
        projectId,
        memberId: member.id,
        role: input.role,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (existing) {
        state.projectMemberships.splice(
          state.projectMemberships.indexOf(existing),
          1,
          membership,
        );
      } else {
        state.projectMemberships.push(membership);
      }
      appendAudit(
        state,
        {
          workspaceId,
          projectId,
          memberId: member.id,
          action: existing ? 'project_member.updated' : 'project_member.added',
          actor: input.actor?.trim() || 'admin-console',
          snapshot: { ...membership },
        },
        timestamp,
      );
      return cloneMembership(membership);
    });
  }

  async removeProjectMembership(
    workspaceId: string,
    projectIdInput: string,
    memberId: string,
    actor = 'admin-console',
  ): Promise<ProjectMembership | undefined> {
    return this.mutate((state) => {
      const projectId = projectKey(workspaceId, projectIdInput);
      const membership = state.projectMemberships.find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.projectId === projectId &&
          candidate.memberId === memberId,
      );
      if (!membership) return undefined;
      state.projectMemberships.splice(
        state.projectMemberships.indexOf(membership),
        1,
      );
      appendAudit(
        state,
        {
          workspaceId,
          projectId,
          memberId,
          action: 'project_member.removed',
          actor,
          snapshot: { ...membership },
        },
        now(),
      );
      return cloneMembership(membership);
    });
  }

  async authorize(
    input: AuthorizeSourceActorInput,
  ): Promise<ActorAuthorizationDecision> {
    const workspaceId = required(
      input.workspaceId,
      'workspace_access_workspace_required',
    );
    const projectId = projectKey(workspaceId, input.projectId);
    const state = await this.readState();
    const policy = state.projectPolicies.find(
      (candidate) =>
        candidate.workspaceId === workspaceId && candidate.projectId === projectId,
    );
    const mode = policy?.mode ?? 'open';
    const actorIds = new Set(
      [input.actor.id, input.actor.platformUserId]
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim()),
    );
    const member = state.members.find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.identities.some(
          (identity) =>
            identity.platform === input.platform && actorIds.has(identity.externalId),
        ),
    );
    const clonedMember = member ? cloneMember(member) : undefined;

    if (mode === 'open') {
      return {
        allowed: true,
        capability: input.capability,
        mode,
        reason: 'open_access',
        member: clonedMember,
        capabilities: [...ALL_CAPABILITIES],
      };
    }
    if (!member) {
      return {
        allowed: false,
        capability: input.capability,
        mode,
        reason: 'workspace_member_required',
        capabilities: [],
      };
    }
    if (member.status !== 'active') {
      return {
        allowed: false,
        capability: input.capability,
        mode,
        reason: 'workspace_member_suspended',
        member: clonedMember,
        capabilities: [],
      };
    }

    if (member.role === 'owner' || member.role === 'admin') {
      return {
        allowed: true,
        capability: input.capability,
        mode,
        reason: 'workspace_role',
        member: clonedMember,
        capabilities: [...ALL_CAPABILITIES],
      };
    }

    if (mode === 'workspace') {
      const capabilities = capabilitiesForWorkspaceRole(member.role);
      return {
        allowed: capabilities.includes(input.capability),
        capability: input.capability,
        mode,
        reason: capabilities.includes(input.capability)
          ? 'workspace_role'
          : 'capability_not_granted',
        member: clonedMember,
        capabilities,
      };
    }

    const projectMembership = state.projectMemberships.find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.projectId === projectId &&
        candidate.memberId === member.id,
    );
    if (!projectMembership) {
      return {
        allowed: false,
        capability: input.capability,
        mode,
        reason: 'project_member_required',
        member: clonedMember,
        capabilities: [],
      };
    }
    const capabilities = capabilitiesForProjectRole(projectMembership.role);
    const allowed = capabilities.includes(input.capability);
    return {
      allowed,
      capability: input.capability,
      mode,
      reason: allowed ? 'project_role' : 'capability_not_granted',
      member: clonedMember,
      projectMembership: cloneMembership(projectMembership),
      capabilities,
    };
  }
}

export type WorkspaceAccessStore = Pick<
  FileWorkspaceAccessStore,
  keyof FileWorkspaceAccessStore
>;
