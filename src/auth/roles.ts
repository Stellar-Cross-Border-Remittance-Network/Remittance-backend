export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Coarse-grained permission set per role. Fine-grained checks happen in services. */
export const PERMISSIONS = {
  user: [
    'remittance:create',
    'remittance:read',
    'remittance:fund',
    'remittance:release',
    'remittance:refund',
    'quote:create',
    'sep10:challenge',
    'sep10:verify',
    'sep24:deposit',
    'sep24:withdraw',
    'sep6:deposit',
    'sep6:withdraw',
    'anchor:read',
    'account:manage',
  ],
  admin: [
    'remittance:*',
    'quote:*',
    'sep10:*',
    'sep24:*',
    'sep6:*',
    'anchor:*',
    'account:*',
    'audit:read',
  ],
} as const satisfies Record<Role, readonly string[]>;

export function hasPermission(role: Role, permission: string): boolean {
  return (PERMISSIONS[role] as readonly string[]).includes(permission);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}