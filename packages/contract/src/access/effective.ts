// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A member's effective permissions, and the plan's six roles (issue 12,
 * "Roles, admin levels, programs and permissions"). Both are pure: they read
 * what a membership holds, and the moment they are asked for.
 *
 * - A member holds the platform's permissions: a member's own, a system
 *   administrator's by the admin level, and a program administrator's while
 *   the member administers a program (permissions.ts). They have no end.
 * - A member holds the rights of each program grant that still holds: one
 *   with no end, or whose end is later than the moment. A Revisor grant ends
 *   30 days after it was granted, with no action by anyone (open point 3).
 *   A right that several grants give ends with the latest of them, and has
 *   no end while one of them has none. So "Register/Övrigt rights are shared
 *   by all programs": a right of two programs stays while either holds.
 * - A grant gives only the rights of its list that its program's set holds,
 *   and an action right only beside its group's view right in the same list
 *   (open point 4). The database refuses every other grant; a grant made
 *   before a change of the catalogue then gives no more than the catalogue
 *   allows now.
 *
 * The roles are sets in this model: owner and admin are the two admin
 * levels, the system administrator's; bookkeeper is the program Bokföring
 * with "Full behörighet"; approver is Bokföring - Attest & Läs (open point
 * 2); viewer is Läs; auditor is Revisor. A member may hold several. The
 * owner and the admin hold the same permissions (open point 1).
 */

import { CATALOGUE_PERMISSIONS, fullPermissions, programPermissions, viewPermissionOf, type CataloguePermissionKey, type Program } from "./catalogue.ts";
import { PROGRAM_ADMINISTRATOR_PERMISSIONS, platformPermissions, type AdminLevel } from "./permissions.ts";

/** A program grant as the permissions read it: its program, the rights it lists, and when it ends by itself, or null for never. */
export interface GrantAccess {
  readonly program: Program;
  readonly permissions: readonly string[];
  readonly expiresAt: Date | null;
}

/** What a membership holds: its admin level, its program grants, and the programs it administers. */
export interface MemberAccess {
  readonly adminLevel: AdminLevel | null;
  readonly grants: readonly GrantAccess[];
  readonly programsAdministered: readonly Program[];
}

/** Whether a grant still holds at `now`: it has no end, or its end is later than `now`. At its end it holds no more. */
export function grantHolds(grant: Pick<GrantAccess, "expiresAt">, now: Date): boolean {
  return grant.expiresAt === null || now.getTime() < grant.expiresAt.getTime();
}

/**
 * The rights a grant gives, once each, in the catalogue's order: those of its
 * list that its program's set holds, an action right only when the list also
 * holds its group's view right. Each call gives a new list.
 */
export function grantRights(grant: Pick<GrantAccess, "program" | "permissions">): CataloguePermissionKey[] {
  const set = programPermissions(grant.program);
  return CATALOGUE_PERMISSIONS.map((permission) => permission.key).filter((key) => {
    const view = viewPermissionOf(key);
    return set.includes(key) && grant.permissions.includes(key) && (view === null || grant.permissions.includes(view));
  });
}

/**
 * The permissions a member holds at `now`, each with the end of what gives
 * it, or null for no end: first the platform's, then the rights of the
 * grants that hold at `now`, in the catalogue's order. Each call gives a new
 * map.
 */
export function effectivePermissions(access: MemberAccess, now: Date): Map<string, Date | null> {
  const effective = new Map<string, Date | null>();
  const platform = [...platformPermissions(access.adminLevel), ...(access.programsAdministered.length > 0 ? PROGRAM_ADMINISTRATOR_PERMISSIONS : [])];
  for (const permission of platform) {
    effective.set(permission, null);
  }
  const given = new Map<CataloguePermissionKey, Date | null>();
  for (const grant of access.grants.filter((each) => grantHolds(each, now))) {
    for (const right of grantRights(grant)) {
      const end = given.get(right);
      // The latest end: none while any grant has none.
      given.set(right, end === undefined ? grant.expiresAt : end === null || grant.expiresAt === null ? null : new Date(Math.max(end.getTime(), grant.expiresAt.getTime())));
    }
  }
  for (const permission of CATALOGUE_PERMISSIONS) {
    const end = given.get(permission.key);
    if (end !== undefined) {
      effective.set(permission.key, end);
    }
  }
  return effective;
}

/** The plan's six roles, in their order. */
export const ROLE_KEYS = ["owner", "admin", "bookkeeper", "approver", "viewer", "auditor"] as const;

export type Role = (typeof ROLE_KEYS)[number];

/**
 * What makes a member hold a role: an admin level, or a grant of a program
 * that holds; with `full`, a grant that gives every right of the program's
 * "Full behörighet".
 */
export type RoleDefinition =
  | { readonly key: Role; readonly adminLevel: AdminLevel }
  | { readonly key: Role; readonly program: Program; readonly full: boolean };

/** The six roles, as the issue sets them in this model (open points 1 and 2). */
export const ROLES: readonly RoleDefinition[] = Object.freeze(
  (
    [
      { key: "owner", adminLevel: "owner" },
      { key: "admin", adminLevel: "admin" },
      { key: "bookkeeper", program: "bookkeeping", full: true },
      { key: "approver", program: "approval-read", full: false },
      { key: "viewer", program: "read", full: false },
      { key: "auditor", program: "auditor", full: false },
    ] satisfies RoleDefinition[]
  ).map((role) => Object.freeze(role)),
);

/** Whether `access` holds `role` at `now`. */
function holdsRole(role: RoleDefinition, access: MemberAccess, now: Date): boolean {
  if ("adminLevel" in role) {
    return access.adminLevel === role.adminLevel;
  }
  return access.grants.some((grant) => {
    if (grant.program !== role.program || !grantHolds(grant, now)) {
      return false;
    }
    const rights: readonly string[] = grantRights(grant);
    return !role.full || fullPermissions(role.program).every((right) => rights.includes(right));
  });
}

/** The roles a member holds at `now`, in the roles' order. Each call gives a new list. */
export function rolesOf(access: MemberAccess, now: Date): Role[] {
  return ROLES.filter((role) => holdsRole(role, access, now)).map((role) => role.key);
}
