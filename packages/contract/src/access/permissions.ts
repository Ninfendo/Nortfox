// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The permissions a membership holds by being one, and by its admin level
 * (issue 12, "Roles, admin levels, programs and permissions"). Every active
 * member reads the company. A system administrator is a member whose admin
 * level is owner or admin: the owner and the admin hold the same (open point
 * 1), and neither holds any of the catalogue's work rights by being one. The
 * programs grant those, beside these, later in slice 2c.
 */

import type { Permission } from "../operation.ts";

/** The admin levels a membership can have, as the database takes them. Either one makes the member a system administrator. */
export const ADMIN_LEVELS = ["owner", "admin"] as const;

export type AdminLevel = (typeof ADMIN_LEVELS)[number];

/** What every active member holds in their company. */
export const MEMBER_PERMISSIONS: readonly Permission[] = ["company:read"];

/**
 * What a system administrator holds beside a member's own. The operations
 * that need it (the company's details, its users and their programs) come
 * later in slice 2c, and their permissions with them, so for now it is
 * empty: a permission that no operation needs is never on the list.
 */
export const SYSTEM_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = [];

/** The permissions a membership holds by being one, with `adminLevel`, or with none for a plain member. Each call gives a new set. */
export function platformPermissions(adminLevel: AdminLevel | null): ReadonlySet<Permission> {
  return new Set(adminLevel === null ? MEMBER_PERMISSIONS : [...MEMBER_PERMISSIONS, ...SYSTEM_ADMINISTRATOR_PERMISSIONS]);
}
