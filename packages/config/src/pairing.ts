import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlatformKind } from '@opentag/core';

export type PairingInvitationStatus =
  | 'pending'
  | 'consumed'
  | 'expired'
  | 'revoked';

export type PairingActivationMode = 'mention' | 'questions' | 'always';

export interface PairingInvitation {
  id: string;
  platform: PlatformKind;
  workspaceId: string;
  projectId: string;
  activationMode: PairingActivationMode;
  requireMention: boolean;
  allowedActorIds?: string[];
  status: PairingInvitationStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  consumedBy?: {
    channelId: string;
    threadExternalId: string;
    actorId?: string;
  };
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
}

export interface CreatePairingInvitationInput {
  platform: PlatformKind;
  workspaceId: string;
  projectId: string;
  activationMode?: PairingActivationMode;
  requireMention?: boolean;
  allowedActorIds?: string[];
  createdBy?: string;
}

export interface PairingInvitationWithCode {
  invitation: PairingInvitation;
  code: string;
  command: string;
  ttlSeconds: number;
}

export interface ConsumePairingCodeInput {
  platform: PlatformKind;
  code: string;
  channelId: string;
  threadExternalId: string;
  actorId?: string;
}

export type ConsumePairingCodeResult =
  | { ok: true; invitation: PairingInvitation }
  | {
      ok: false;
      reason:
        | 'invalid_code'
        | 'expired_code'
        | 'revoked_code'
        | 'consumed_code'
        | 'actor_not_allowed'
        | 'platform_mismatch';
      invitation?: PairingInvitation;
    };

export interface PairingInvitationFilter {
  platform?: PlatformKind;
  workspaceId?: string;
  projectId?: string;
  status?: PairingInvitationStatus;
  limit?: number;
}

export interface StoredPairingInvitation extends PairingInvitation {
  codeHash: string;
  codeSalt: string;
}

export interface PairingState {
  version: 1;
  invitations: StoredPairingInvitation[];
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function createEmptyPairingState(): PairingState {
  return { version: 1, invitations: [] };
}

export function normalizePairingState(
  parsed: Partial<PairingState>,
): PairingState {
  return { version: 1, invitations: parsed.invitations ?? [] };
}

function publicInvitation(
  invitation: StoredPairingInvitation,
): PairingInvitation {
  const { codeHash: _codeHash, codeSalt: _codeSalt, ...result } = invitation;
  return structuredClone(result);
}

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function formatCode(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let result = '';
  for (const byte of bytes) result += CODE_ALPHABET[byte & 31];
  return result;
}

function codeHash(code: string, salt: string): Buffer {
  return createHash('sha256')
    .update(salt)
    .update(':')
    .update(normalizeCode(code))
    .digest();
}

function matchesCode(invitation: StoredPairingInvitation, code: string): boolean {
  const expected = Buffer.from(invitation.codeHash, 'hex');
  const received = codeHash(code, invitation.codeSalt);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function invitationStatus(
  invitation: StoredPairingInvitation,
  at: string,
): PairingInvitationStatus {
  if (invitation.status === 'pending' && invitation.expiresAt <= at) {
    invitation.status = 'expired';
  }
  return invitation.status;
}

function normalizedActorAllowlist(value: string[] | undefined): string[] | undefined {
  const allowed = [
    ...new Set(
      (value ?? [])
        .map((actorId) => actorId.trim())
        .filter(Boolean),
    ),
  ];
  return allowed.length ? allowed : undefined;
}

export function consumePairingCodeInState(
  state: PairingState,
  input: ConsumePairingCodeInput,
  timestamp: string,
): ConsumePairingCodeResult {
  const code = normalizeCode(input.code);
  if (code.length !== CODE_LENGTH) return { ok: false, reason: 'invalid_code' };
  let match: StoredPairingInvitation | undefined;
  for (const invitation of state.invitations) {
    invitationStatus(invitation, timestamp);
    if (matchesCode(invitation, code)) match = invitation;
  }
  if (!match) return { ok: false, reason: 'invalid_code' };
  const invitation = publicInvitation(match);
  if (match.platform !== input.platform) {
    return { ok: false, reason: 'platform_mismatch', invitation };
  }
  if (match.status === 'expired') {
    return { ok: false, reason: 'expired_code', invitation };
  }
  if (match.status === 'revoked') {
    return { ok: false, reason: 'revoked_code', invitation };
  }
  if (match.status === 'consumed') {
    return { ok: false, reason: 'consumed_code', invitation };
  }
  if (
    match.allowedActorIds?.length &&
    (!input.actorId || !match.allowedActorIds.includes(input.actorId))
  ) {
    return { ok: false, reason: 'actor_not_allowed', invitation };
  }

  match.status = 'consumed';
  match.consumedAt = timestamp;
  match.consumedBy = {
    channelId: input.channelId,
    threadExternalId: input.threadExternalId,
    actorId: input.actorId,
  };
  return { ok: true, invitation: publicInvitation(match) };
}

export class FilePairingStore {
  private readonly stateFile: string;
  private readonly ttlMs: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string, options?: { ttlMs?: number }) {
    this.stateFile = path.join(rootDir, 'pairing-state.json');
    this.ttlMs = Math.max(30_000, options?.ttlMs ?? 5 * 60_000);
  }

  private async load(): Promise<PairingState> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as Partial<PairingState>;
      return normalizePairingState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createEmptyPairingState();
      }
      throw error;
    }
  }

  private async save(state: PairingState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporary, this.stateFile);
  }

  protected async readState(): Promise<PairingState> {
    await this.mutationQueue;
    return this.load();
  }

  protected async mutate<T>(operation: (state: PairingState) => T): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = operation(state);
      if (state.invitations.length > 500) {
        state.invitations.splice(0, state.invitations.length - 500);
      }
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async createInvitation(
    input: CreatePairingInvitationInput,
    at = new Date(),
  ): Promise<PairingInvitationWithCode> {
    const platform = String(input.platform).trim();
    const workspaceId = input.workspaceId.trim();
    const projectId = input.projectId.trim();
    if (!platform) throw new Error('pairing_platform_required');
    if (!workspaceId) throw new Error('pairing_workspace_required');
    if (!projectId) throw new Error('pairing_project_required');
    const createdAt = at.toISOString();
    const expiresAt = new Date(at.getTime() + this.ttlMs).toISOString();
    const rawCode = randomCode();
    const salt = randomBytes(16).toString('hex');

    return this.mutate((state) => {
      for (const invitation of state.invitations) {
        invitationStatus(invitation, createdAt);
        if (
          invitation.status === 'pending' &&
          invitation.platform === platform &&
          invitation.workspaceId === workspaceId &&
          invitation.projectId === projectId
        ) {
          invitation.status = 'revoked';
          invitation.revokedAt = createdAt;
          invitation.revokedBy = input.createdBy?.trim() || 'admin';
          invitation.revokeReason = 'replaced_by_new_invitation';
        }
      }
      const invitation: StoredPairingInvitation = {
        id: randomUUID(),
        platform,
        workspaceId,
        projectId,
        activationMode: input.activationMode ?? 'mention',
        requireMention: input.requireMention ?? true,
        allowedActorIds: normalizedActorAllowlist(input.allowedActorIds),
        status: 'pending',
        createdBy: input.createdBy?.trim() || 'admin',
        createdAt,
        expiresAt,
        codeSalt: salt,
        codeHash: codeHash(rawCode, salt).toString('hex'),
      };
      state.invitations.push(invitation);
      const code = formatCode(rawCode);
      return {
        invitation: publicInvitation(invitation),
        code,
        command: `/pair ${code}`,
        ttlSeconds: Math.floor(this.ttlMs / 1000),
      };
    });
  }

  async consumeCode(
    input: ConsumePairingCodeInput,
    at = new Date(),
  ): Promise<ConsumePairingCodeResult> {
    const timestamp = at.toISOString();
    return this.mutate((state) =>
      consumePairingCodeInState(state, input, timestamp),
    );
  }

  async listInvitations(
    filter: PairingInvitationFilter = {},
    at = new Date(),
  ): Promise<PairingInvitation[]> {
    const timestamp = at.toISOString();
    const state = await this.loadAndExpire(timestamp);
    return state.invitations
      .filter(
        (invitation) =>
          (!filter.platform || invitation.platform === filter.platform) &&
          (!filter.workspaceId || invitation.workspaceId === filter.workspaceId) &&
          (!filter.projectId || invitation.projectId === filter.projectId) &&
          (!filter.status || invitation.status === filter.status),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(filter.limit ?? 100, 200)))
      .map(publicInvitation);
  }

  async getInvitation(
    id: string,
    at = new Date(),
  ): Promise<PairingInvitation | undefined> {
    const state = await this.loadAndExpire(at.toISOString());
    const invitation = state.invitations.find((item) => item.id === id);
    return invitation ? publicInvitation(invitation) : undefined;
  }

  async revokeInvitation(
    id: string,
    actor = 'admin',
    at = new Date(),
  ): Promise<PairingInvitation | undefined> {
    const timestamp = at.toISOString();
    return this.mutate((state) => {
      const invitation = state.invitations.find((item) => item.id === id);
      if (!invitation) return undefined;
      invitationStatus(invitation, timestamp);
      if (invitation.status === 'pending') {
        invitation.status = 'revoked';
        invitation.revokedAt = timestamp;
        invitation.revokedBy = actor.trim() || 'admin';
        invitation.revokeReason = 'operator_revoked';
      }
      return publicInvitation(invitation);
    });
  }

  async summarize(workspaceId?: string): Promise<Record<PairingInvitationStatus, number>> {
    const state = await this.loadAndExpire(new Date().toISOString());
    const summary: Record<PairingInvitationStatus, number> = {
      pending: 0,
      consumed: 0,
      expired: 0,
      revoked: 0,
    };
    for (const invitation of state.invitations) {
      if (!workspaceId || invitation.workspaceId === workspaceId) {
        summary[invitation.status] += 1;
      }
    }
    return summary;
  }

  private async loadAndExpire(timestamp: string): Promise<PairingState> {
    const state = await this.readState();
    if (
      !state.invitations.some(
        (invitation) =>
          invitation.status === 'pending' && invitation.expiresAt <= timestamp,
      )
    ) {
      return state;
    }
    return this.mutate((next) => {
      for (const invitation of next.invitations) {
        invitationStatus(invitation, timestamp);
      }
      return next;
    });
  }
}

export type PairingStore = Pick<FilePairingStore, keyof FilePairingStore>;
