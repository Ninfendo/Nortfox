// SPDX-License-Identifier: AGPL-3.0-only

// A membership as the API gives it, and the changes that a person makes to
// their own (issue 12, "Users in a company" 8 and 9). The rows live in
// access.memberships, a company table, and the work contacts in
// access.membership_contacts, which keeps no history: a transaction reads
// and changes them only in its own company, by row level security. The
// membership's roles, program grants and administered programs come with it
// (programs.ts). Only this module names the memberships' table
// (scripts/guards/membership.ts).

import { rolesOf, type AdminLevel, type Membership } from "@nortfox/contract";
import type { Queryable } from "../../db/database.ts";
import { grantOutput, memberAccess, readPrograms } from "./programs.ts";

interface MembershipRow {
  readonly company_id: string;
  readonly user_id: string | null;
  readonly status: Membership["status"];
  readonly admin_level: NonNullable<Membership["adminLevel"]> | null;
  readonly idle_timeout_minutes: Membership["idleTimeout"];
  readonly work_email: string | null;
  readonly work_phone: string | null;
}

/**
 * Makes `person` the owner of the company that the transaction makes: its
 * first membership, active, at the owner's level. The database gives the
 * owner's level only to a company's first membership, and refuses the
 * company's commit without an active system administrator.
 */
export async function addOwner(tx: Queryable, companyId: string, person: string): Promise<void> {
  await tx.query("INSERT INTO access.memberships (company_id, user_id, status, admin_level) VALUES ($1, $2, 'active', 'owner')", [companyId, person]);
}

/**
 * A membership of the transaction's company, with the work contacts, its
 * program grants and the programs it administers, and the roles it holds at
 * `at`, as they are now. A membership that the request named and the
 * database does not hold is a fault of the server.
 */
export async function readMembership(tx: Queryable, membershipId: string, at: Date): Promise<Membership> {
  const found = await tx.query<MembershipRow>(
    `SELECT m.company_id, m.user_id, m.status, m.admin_level, m.idle_timeout_minutes, c.work_email, c.work_phone
     FROM access.memberships AS m
     LEFT JOIN access.membership_contacts AS c ON c.contact_company_id = m.company_id AND c.membership_id = m.id
     WHERE m.id = $1`,
    [membershipId],
  );
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error(`The membership ${membershipId} is not in the transaction's company.`);
  }
  const programs = await readPrograms(tx, membershipId);
  return {
    companyId: row.company_id,
    ...(row.user_id === null ? {} : { userId: row.user_id }),
    status: row.status,
    ...(row.admin_level === null ? {} : { adminLevel: row.admin_level }),
    idleTimeout: row.idle_timeout_minutes,
    ...(row.work_email === null ? {} : { workEmail: row.work_email }),
    ...(row.work_phone === null ? {} : { workPhone: row.work_phone }),
    roles: rolesOf(memberAccess(row.admin_level, programs), at),
    programs: programs.grants.map(grantOutput),
    programsAdministered: programs.administered.map((program) => ({ program })),
  };
}

/** The admin level and the idle time of a membership that the transaction holds. */
export interface HeldMembership {
  readonly adminLevel: AdminLevel | null;
  readonly idleTimeoutMinutes: number;
}

/**
 * Holds the person's active membership in the transaction's company until
 * the transaction ends, and gives its admin level and idle time; or gives
 * nothing when it is no longer the person's active one. A choice of the
 * company holds it before the session stores it.
 *
 * It locks the membership's row FOR SHARE, and reads it after the lock, at
 * READ COMMITTED. A change of the membership's status, person, admin level
 * or idle time takes a lock that waits for this one. So a deactivation, a
 * disconnect, a removal or a leave either committed first, and the
 * membership is not given, or waits for this transaction's commit, and the
 * trigger memberships_end_sessions then ends the session that chose it.
 */
export async function holdActive(tx: Queryable, membershipId: string, personId: string): Promise<HeldMembership | undefined> {
  const found = await tx.query<{ admin_level: AdminLevel | null; idle_timeout_minutes: number }>(
    "SELECT admin_level, idle_timeout_minutes FROM access.memberships WHERE id = $1 AND status = 'active' AND live_user_id = $2 FOR SHARE",
    [membershipId, personId],
  );
  const [row] = found.rows;
  return row === undefined ? undefined : { adminLevel: row.admin_level, idleTimeoutMinutes: row.idle_timeout_minutes };
}

/** What a person changes in their own membership: each field that is given, and null takes a work contact away. */
export interface OwnChange {
  readonly workEmail?: string | null | undefined;
  readonly workPhone?: string | null | undefined;
  readonly idleTimeout?: Membership["idleTimeout"] | undefined;
}

/**
 * Changes the person's own membership in the transaction's company, and
 * gives it with its roles at `at`, or gives nothing when the membership is
 * no longer active. The
 * idle time is the membership's own column, so its change is in the
 * behandlingshistorik. The work contacts are kept beside it, in a row that
 * holds no history, and that goes when neither is left.
 *
 * It locks the membership's row first, FOR NO KEY UPDATE, and reads its
 * status after the lock, at READ COMMITTED. So two changes of one membership
 * at once take turns: the second reads the first's work contacts, and keeps
 * the field it leaves out. A change that waited for a removal, a leave or a
 * deactivation finds the membership no longer active, and changes nothing.
 */
export async function changeOwnMembership(tx: Queryable, membershipId: string, change: OwnChange, at: Date): Promise<Membership | undefined> {
  const locked = await tx.query("SELECT 1 FROM access.memberships WHERE id = $1 AND status = 'active' FOR NO KEY UPDATE", [membershipId]);
  if (locked.rows.length === 0) {
    return undefined;
  }
  if (change.idleTimeout !== undefined) {
    await tx.query("UPDATE access.memberships SET idle_timeout_minutes = $2 WHERE id = $1 AND idle_timeout_minutes <> $2", [membershipId, change.idleTimeout]);
  }
  if (change.workEmail !== undefined || change.workPhone !== undefined) {
    const before = await readMembership(tx, membershipId, at);
    const workEmail = change.workEmail === undefined ? (before.workEmail ?? null) : change.workEmail;
    const workPhone = change.workPhone === undefined ? (before.workPhone ?? null) : change.workPhone;
    if (workEmail === null && workPhone === null) {
      await tx.query("DELETE FROM access.membership_contacts WHERE contact_company_id = $1 AND membership_id = $2", [before.companyId, membershipId]);
    } else {
      await tx.query(
        `INSERT INTO access.membership_contacts (contact_company_id, membership_id, work_email, work_phone) VALUES ($1, $2, $3, $4)
         ON CONFLICT (contact_company_id, membership_id) DO UPDATE SET work_email = excluded.work_email, work_phone = excluded.work_phone`,
        [before.companyId, membershipId, workEmail, workPhone],
      );
    }
  }
  return readMembership(tx, membershipId, at);
}
