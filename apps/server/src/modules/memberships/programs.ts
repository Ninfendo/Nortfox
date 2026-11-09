// SPDX-License-Identifier: AGPL-3.0-only

// A membership's programs (issue 12, "Roles, admin levels, programs and
// permissions"): its program grants, access.program_grants, and the programs
// it administers, access.program_admins. Both are company tables, so a
// transaction reads them only in its own company, by row level security.
// From them, and the membership's admin level, the contract gives the
// member's effective permissions and roles (packages/contract,
// access/effective.ts). The database holds each grant to its program's set
// and to the view rule, and stamps when it was granted and when it ends.

import { PROGRAMS, type AdminLevel, type GrantAccess, type MemberAccess, type Program, type ProgramGrant } from "@nortfox/contract";
import type { Queryable } from "../../db/database.ts";

/** A program grant as the server reads it: as the effective permissions take it, with whether it holds Full behörighet and when it was granted. */
export interface Grant extends GrantAccess {
  readonly full: boolean;
  readonly grantedAt: Date;
}

/** A membership's program grants and the programs it administers, each in the catalogue's order. */
export interface MembershipPrograms {
  readonly grants: readonly Grant[];
  readonly administered: readonly Program[];
}

interface GrantRow {
  readonly program: Program;
  readonly permissions: string[];
  readonly is_full: boolean;
  readonly granted_at: Date;
  readonly expires_at: Date | null;
}

/** Orders by the program, in the catalogue's order. */
function byProgram(first: { readonly program: Program }, second: { readonly program: Program }): number {
  return PROGRAMS.indexOf(first.program) - PROGRAMS.indexOf(second.program);
}

/**
 * The program grants and the administered programs of a membership of the
 * transaction's company, as they are now. The database keeps a program of
 * the catalogue on each row, and each grant's rights in the catalogue's
 * order. Its times come to the millisecond, so an end is read at most a
 * millisecond early, never late.
 */
export async function readPrograms(tx: Queryable, membershipId: string): Promise<MembershipPrograms> {
  const grants = await tx.query<GrantRow>("SELECT program, permissions, is_full, granted_at, expires_at FROM access.program_grants WHERE membership_id = $1", [
    membershipId,
  ]);
  const administered = await tx.query<{ program: Program }>("SELECT program FROM access.program_admins WHERE membership_id = $1", [membershipId]);
  return {
    grants: [...grants.rows].sort(byProgram).map((row) => ({
      program: row.program,
      permissions: row.permissions,
      full: row.is_full,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
    })),
    administered: [...administered.rows].sort(byProgram).map((row) => row.program),
  };
}

/** What a membership with `adminLevel` and `programs` holds, as the effective permissions and the roles read it. */
export function memberAccess(adminLevel: AdminLevel | null, programs: MembershipPrograms): MemberAccess {
  return { adminLevel, grants: programs.grants, programsAdministered: programs.administered };
}

/** A grant as the API gives it. */
export function grantOutput(grant: Grant): ProgramGrant {
  return {
    program: grant.program,
    permissions: [...grant.permissions],
    full: grant.full,
    grantedAt: grant.grantedAt.toISOString(),
    ...(grant.expiresAt === null ? {} : { expiresAt: grant.expiresAt.toISOString() }),
  };
}
