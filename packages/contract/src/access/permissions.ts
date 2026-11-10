// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The permissions a membership holds by being one, and by its admin level
 * (issue 12, "Roles, admin levels, programs and permissions"). Every active
 * member reads the company. A system administrator is a member whose admin
 * level is owner or admin: the owner and the admin hold the same (open point
 * 1), and neither holds any of the catalogue's work rights by being one. A
 * program administrator holds the rights to grant their programs. The
 * programs grant the work rights, beside these (effective.ts).
 */

import type { Permission } from "../operation.ts";

/** The admin levels a membership can have, as the database takes them. Either one makes the member a system administrator. */
export const ADMIN_LEVELS = ["owner", "admin"] as const;

export type AdminLevel = (typeof ADMIN_LEVELS)[number];

/** What every active member holds in their company: they read it, and make, list and revoke their own API tokens. */
export const MEMBER_PERMISSIONS: readonly Permission[] = ["company:read", "tokens:own"];

/**
 * What a system administrator holds beside a member's own: the company's
 * details, its users and their programs, and every API token of the
 * company. None of it is a work right.
 */
export const SYSTEM_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = ["company:update", "users:read", "users:admin", "programs:grant", "tokens:all"];

/**
 * What a program administrator holds beside a member's own: a member who
 * administers at least one program. They read the users and grant
 * programs, and the handlers keep them to the programs they administer.
 */
export const PROGRAM_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = ["users:read", "programs:grant"];

/** The permissions a membership holds by being one, with `adminLevel`, or with none for a plain member. Each call gives a new set. */
export function platformPermissions(adminLevel: AdminLevel | null): ReadonlySet<Permission> {
  return new Set(adminLevel === null ? MEMBER_PERMISSIONS : [...MEMBER_PERMISSIONS, ...SYSTEM_ADMINISTRATOR_PERMISSIONS]);
}
