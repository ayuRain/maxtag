import type {
  AccessBundle,
  MemoryScopeKind,
  ToolGrant,
} from './types.js';

const MAX_MEMORY_RETENTION_DAYS = 3_650;

export const MEMORY_SCOPE_ORDER: MemoryScopeKind[] = [
  'global',
  'workspace',
  'project',
  'channel',
  'thread',
];

function permissionAllows(
  grant: ToolGrant,
  permission: 'read' | 'write',
): boolean {
  const permissions = grant.constraints?.permissions;
  if (!Array.isArray(permissions)) return permission === 'read';
  return permissions.some((value) => value === permission);
}

export function memoryScopeGranted(
  access: AccessBundle,
  scope: MemoryScopeKind,
  permission: 'read' | 'write' = 'read',
): boolean {
  if (scope === 'global') return false;
  return access.grants.some(
    (grant) =>
      grant.kind === 'memory' &&
      grant.scope === scope &&
      permissionAllows(grant, permission),
  );
}

export function readableMemoryScopes(
  access: AccessBundle,
): MemoryScopeKind[] {
  return MEMORY_SCOPE_ORDER.filter((scope) =>
    memoryScopeGranted(access, scope, 'read'),
  );
}

export function normalizedMemoryRetentionDays(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) return undefined;
  return value >= 1 && value <= MAX_MEMORY_RETENTION_DAYS ? value : undefined;
}

export function memoryRetentionDaysFor(
  access: AccessBundle,
  scope: MemoryScopeKind,
): number | undefined {
  if (scope === 'global') return undefined;
  return normalizedMemoryRetentionDays(access.memoryRetentionDays?.[scope]);
}

export function memoryExpiryFromRetentionDays(
  days: number | undefined,
  at: Date = new Date(),
): string | undefined {
  const normalized = normalizedMemoryRetentionDays(days);
  if (!normalized) return undefined;
  return new Date(at.getTime() + normalized * 24 * 60 * 60 * 1_000).toISOString();
}

export function memoryExpiryForAccess(
  access: AccessBundle,
  scope: MemoryScopeKind,
  at: Date = new Date(),
): string | undefined {
  return memoryExpiryFromRetentionDays(
    memoryRetentionDaysFor(access, scope),
    at,
  );
}

export function constrainWorkspaceMemoryWrite(
  access: AccessBundle,
  allowed: boolean | undefined,
): AccessBundle {
  if (allowed !== false) return access;
  return {
    ...access,
    grants: access.grants.map((grant) => {
      if (grant.kind !== 'memory' || grant.scope !== 'workspace') return grant;
      const permissions = grant.constraints?.permissions;
      if (!Array.isArray(permissions) || !permissions.includes('write')) {
        return grant;
      }
      return {
        ...grant,
        constraints: {
          ...grant.constraints,
          permissions: permissions.filter((value) => value !== 'write'),
        },
      };
    }),
  };
}
