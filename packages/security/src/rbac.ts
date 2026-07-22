import type { UserRole } from '@sentinel/core';

/** Coarse-grained permissions checked at the API boundary. */
export const PERMISSIONS = [
  'workspace:read',
  'workspace:write',
  'workspace:delete',
  'connection:create',
  'connection:read',
  'scan:run',
  'issue:read',
  'issue:write',
  'report:generate',
  'report:download',
  'audit:read',
  'admin:feature-flags',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: [
    'workspace:read',
    'workspace:write',
    'workspace:delete',
    'connection:create',
    'connection:read',
    'scan:run',
    'issue:read',
    'issue:write',
    'report:generate',
    'report:download',
    'audit:read',
    'admin:feature-flags',
  ],
  manager: [
    'workspace:read',
    'workspace:write',
    'connection:create',
    'connection:read',
    'scan:run',
    'issue:read',
    'issue:write',
    'report:generate',
    'report:download',
  ],
  analyst: ['workspace:read', 'connection:read', 'scan:run', 'issue:read', 'issue:write', 'report:generate', 'report:download'],
  viewer: ['workspace:read', 'connection:read', 'issue:read', 'report:download'],
};

export function permissionsFor(role: UserRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role: UserRole, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

/** Throwing guard for use in API handlers. */
export class AuthorizationError extends Error {
  constructor(public readonly role: UserRole, public readonly permission: Permission) {
    super(`Role "${role}" lacks permission "${permission}".`);
    this.name = 'AuthorizationError';
  }
}

export function requirePermission(role: UserRole, permission: Permission): void {
  if (!can(role, permission)) throw new AuthorizationError(role, permission);
}
