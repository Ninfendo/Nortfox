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
  readonly membership_id: string;
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
 * The program grants and the administered programs of memberships of the
 * transaction's company, as they are now, read at once for `membershipIds`:
 * it gives each membership's, none or not. The database keeps a program of
 * the catalogue on each row, and each grant's rights in the catalogue's
 * order. Its times come to the millisecond, so an end is read at most a
 * millisecond early, never late.
 */
export async function readProgramsOf(tx: Queryable, membershipIds: readonly string[]): Promise<(membershipId: string) => MembershipPrograms> {
  const grants = await tx.query<GrantRow>(
    "SELECT membership_id, program, permissions, is_full, granted_at, expires_at FROM access.program_grants WHERE membership_id = ANY ($1)",
    [membershipIds],
  );
  const administered = await tx.query<{ membership_id: string; program: Program }>("SELECT membership_id, program FROM access.program_admins WHERE membership_id = ANY ($1)", [
    membershipIds,
  ]);
  return (id) => ({
    grants: grants.rows
      .filter((row) => row.membership_id === id)
      .sort(byProgram)
      .map(grantOf),
    administered: administered.rows
      .filter((row) => row.membership_id === id)
      .sort(byProgram)
      .map((row) => row.program),
  });
}

/** The program grants and the administered programs of one membership of the transaction's company, as they are now (readProgramsOf). */
export async function readPrograms(tx: Queryable, membershipId: string): Promise<MembershipPrograms> {
  return (await readProgramsOf(tx, [membershipId]))(membershipId);
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

/** A grant as a change reads it: its id, its program, its rights and its end. */
export interface HeldGrant {
  readonly id: string;
  readonly program: Program;
  readonly permissions: readonly string[];
  readonly expiresAt: Date | null;
}

/** The grants of a membership of the transaction's company, in the catalogue's order. The caller holds the membership's row. */
export async function grantsOf(tx: Queryable, membershipId: string): Promise<HeldGrant[]> {
  const found = await tx.query<{ id: string; program: Program; permissions: string[]; expires_at: Date | null }>(
    "SELECT id, program, permissions, expires_at FROM access.program_grants WHERE membership_id = $1",
    [membershipId],
  );
  return [...found.rows].sort(byProgram).map((row) => ({ id: row.id, program: row.program, permissions: row.permissions, expiresAt: row.expires_at }));
}

/** The columns a grant's write gives back. */
const WRITTEN = "membership_id, program, permissions, is_full, granted_at, expires_at";

/** A grant's row as the server reads it. */
function grantOf(row: GrantRow): Grant {
  return { program: row.program, permissions: row.permissions, full: row.is_full, grantedAt: row.granted_at, expiresAt: row.expires_at };
}

/** The one row a write of a grant gives back. */
function writtenGrant(found: { readonly rows: readonly GrantRow[] }): Grant {
  return grantOf((found.rows as readonly [GrantRow])[0]);
}

/**
 * Grants `program` with `permissions` to a membership of the transaction's
 * company. The database holds the rights to the program's set and to the
 * view rule, keeps them in the catalogue's order, and stamps the time and
 * the end.
 */
export async function insertGrant(tx: Queryable, companyId: string, membershipId: string, program: Program, permissions: readonly string[]): Promise<Grant> {
  return writtenGrant(
    await tx.query<GrantRow>(`INSERT INTO access.program_grants (company_id, membership_id, program, permissions) VALUES ($1, $2, $3, $4) RETURNING ${WRITTEN}`, [
      companyId,
      membershipId,
      program,
      permissions,
    ]),
  );
}

/** Gives a grant other rights: it keeps its time and its end. */
export async function setGrantRights(tx: Queryable, grant: HeldGrant, permissions: readonly string[]): Promise<Grant> {
  return writtenGrant(await tx.query<GrantRow>(`UPDATE access.program_grants SET permissions = $2 WHERE id = $1 RETURNING ${WRITTEN}`, [grant.id, permissions]));
}

/** "Flytta program": gives a grant to another membership of the company, with `permissions`. It keeps its id, its time and its end. */
export async function moveGrant(tx: Queryable, grant: HeldGrant, membershipId: string, permissions: readonly string[]): Promise<Grant> {
  return writtenGrant(
    await tx.query<GrantRow>(`UPDATE access.program_grants SET membership_id = $2, permissions = $3 WHERE id = $1 RETURNING ${WRITTEN}`, [grant.id, membershipId, permissions]),
  );
}

/** "Ta bort program": takes a grant away. The behandlingshistorik keeps it. */
export async function deleteGrant(tx: Queryable, grant: HeldGrant): Promise<void> {
  await tx.query("DELETE FROM access.program_grants WHERE id = $1", [grant.id]);
}

/**
 * Makes a membership of the transaction's company the administrator of
 * exactly `programs`: it appoints those it does not administer, and removes
 * the others. The caller holds the membership's row.
 */
export async function setAdministered(tx: Queryable, companyId: string, membershipId: string, programs: readonly Program[]): Promise<void> {
  await tx.query("DELETE FROM access.program_admins WHERE membership_id = $1 AND NOT (program = ANY ($2))", [membershipId, programs]);
  await tx.query(
    `INSERT INTO access.program_admins (company_id, membership_id, program) SELECT $1, $2, p FROM unnest($3::text[]) AS p
     ON CONFLICT (company_id, membership_id, program) DO NOTHING`,
    [companyId, membershipId, programs],
  );
}
