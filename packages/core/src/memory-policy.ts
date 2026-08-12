import type {
  AccessBundle,
  MemoryScopeKind,
  ToolGrant,
} from './types.js';

export const MEMORY_SCOPE_ORDER: MemoryScopeKind[] = [
  'global',
  'workspace',
  'project',
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
