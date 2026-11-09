// SPDX-License-Identifier: AGPL-3.0-only

// The company's users as the user administration reads and changes them
// (issue 12, "Users in a company"): the memberships of the transaction's
// company, which row level security keeps to that company, with the
// person's name from the people of the company (access.company_people,
// which never gives the personnummer or the mobile number), or for an
// invited member the name of their latest invitation, the work contacts and
// the programs. The operations reach the invited, active and
// inactive members; a removed or a left member's row stays, and none of
// these finds it. Only this module names the memberships' table and the
// people of a company (scripts/guards/membership.ts).
//
// A change locks the member's row first, FOR NO KEY UPDATE, and reads it
// after the lock, at READ COMMITTED, so two changes of one member take
// turns, and a change that waited for a removal finds no member. The
// database keeps a company's last active system administrator at the commit
// of every change, and refuses the owner's level on an update; the server
// refuses the last one's removal, deactivation, demotion, disconnect and
// leave first, with the same answer, after it took the company's turn of its
// administrators (hasOtherAdministrator).

import { rolesOf, type AdminLevel, type JsonValue, type Member, type Program } from "@nortfox/contract";
import { LEDGER_REFUSALS } from "../../api/ledger-refusals.ts";
import { refused, type Answer, type PageRequest, type PageResult } from "../../api/operation.ts";
import type { Queryable } from "../../db/database.ts";
import { grantOutput, memberAccess, readProgramsOf, type MembershipPrograms } from "./programs.ts";

/**
 * Which programs a reader of the users sees, and a granter reaches: every
 * program for a system administrator, or the programs a program
 * administrator administers.
 */
export type Reach = { readonly all: true } | { readonly all: false; readonly programs: readonly Program[] };

/** Whether `reach` holds `program`. */
export function reaches(reach: Reach, program: Program): boolean {
  return reach.all || reach.programs.includes(program);
}

/** The statuses of the members that the user administration reaches. */
const REACHED = "('invited', 'active', 'inactive')";

interface MemberRow {
  readonly id: string;
  readonly company_id: string;
  readonly user_id: string | null;
  readonly status: Member["status"];
  readonly admin_level: AdminLevel | null;
  readonly idle_timeout_minutes: Member["idleTimeout"];
  readonly work_email: string | null;
  readonly work_phone: string | null;
  readonly created_at: string;
}

const MEMBER_COLUMNS = `m.id, m.company_id, m.user_id, m.status, m.admin_level, m.idle_timeout_minutes, c.work_email, c.work_phone, m.created_at::text AS created_at`;

const MEMBERS = `access.memberships AS m
  LEFT JOIN access.membership_contacts AS c ON c.contact_company_id = m.company_id AND c.membership_id = m.id`;

/** The programs of a member that `reach` sees. */
function seen(programs: MembershipPrograms, reach: Reach): MembershipPrograms {
  return {
    grants: programs.grants.filter((grant) => reaches(reach, grant.program)),
    administered: programs.administered.filter((program) => reaches(reach, program)),
  };
}

/**
 * The members of `rows` as the API gives them, with the names of their
 * people, or of their latest invitations for the invited ones, the programs
 * that `reach` sees, and their roles at `at`.
 */
async function membersOf(tx: Queryable, rows: readonly MemberRow[], at: Date, reach: Reach): Promise<Member[]> {
  const people = rows.flatMap((row) => (row.user_id === null ? [] : [row.user_id]));
  const named = await tx.query<{ id: string; name: string }>("SELECT id, name FROM access.company_people($1)", [people]);
  const names = new Map(named.rows.map((person) => [person.id, person.name]));
  const invited = await tx.query<{ membership_id: string; name: string }>(
    "SELECT DISTINCT ON (membership_id) membership_id, name FROM access.invitations WHERE membership_id = ANY ($1) ORDER BY membership_id, created_at DESC, id DESC",
    [rows.flatMap((row) => (row.user_id === null ? [row.id] : []))],
  );
  const invitedNames = new Map(invited.rows.map((invitation) => [invitation.membership_id, invitation.name]));
  const programs = await readProgramsOf(
    tx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const visible = seen(programs(row.id), reach);
    const name = row.user_id === null ? invitedNames.get(row.id) : names.get(row.user_id);
    return {
      id: row.id,
      companyId: row.company_id,
      ...(row.user_id === null ? {} : { userId: row.user_id }),
      ...(name === undefined ? {} : { name }),
      status: row.status,
      ...(row.admin_level === null ? {} : { adminLevel: row.admin_level }),
      idleTimeout: row.idle_timeout_minutes,
      ...(row.work_email === null ? {} : { workEmail: row.work_email }),
      ...(row.work_phone === null ? {} : { workPhone: row.work_phone }),
      roles: rolesOf(memberAccess(row.admin_level, visible), at),
      programs: visible.grants.map(grantOutput),
      programsAdministered: visible.administered.map((program) => ({ program })),
    };
  });
}

/** An invited, active or inactive member of the transaction's company, as `reach` sees it at `at`, or nothing. */
export async function readMember(tx: Queryable, memberId: string, at: Date, reach: Reach): Promise<Member | undefined> {
  const found = await tx.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM ${MEMBERS} WHERE m.id = $1 AND m.status IN ${REACHED}`, [memberId]);
  const [member] = await membersOf(tx, found.rows, at, reach);
  return member;
}

/** A member that the transaction holds (holdMember) or has just made, as a system administrator sees it at `at`, after its change. */
export async function heldMemberNow(tx: Queryable, member: Pick<HeldMember, "id">, at: Date): Promise<Member> {
  const found = await tx.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM ${MEMBERS} WHERE m.id = $1`, [member.id]);
  // The member is held, so its one row is there.
  return ((await membersOf(tx, found.rows, at, { all: true })) as [Member])[0];
}

/**
 * A page of the company's invited, active and inactive members, in the
 * order they were added, then by id: at most `limit` after the sort key
 * `after`, with the total. It reads one more to tell whether more follow.
 */
export async function memberPage(tx: Queryable, page: PageRequest, at: Date, reach: Reach): Promise<PageResult<Member>> {
  const [afterTime, afterId] = page.after ?? [];
  const found = await tx.query<MemberRow>(
    `SELECT ${MEMBER_COLUMNS} FROM ${MEMBERS}
     WHERE m.status IN ${REACHED} AND ($1::timestamptz IS NULL OR (m.created_at, m.id) > ($1::timestamptz, $2::uuid))
     ORDER BY m.created_at, m.id LIMIT $3`,
    [afterTime ?? null, afterId ?? null, page.limit + 1],
  );
  const counted = await tx.query<{ total: string }>(`SELECT count(*) AS total FROM access.memberships WHERE status IN ${REACHED}`);
  const rows = found.rows.slice(0, page.limit);
  const items = await membersOf(tx, rows, at, reach);
  // A count gives one row; while more follow, the page is full.
  const total = Number((counted.rows as [{ readonly total: string }])[0].total);
  const last = found.rows.length > page.limit ? rows.at(-1) : undefined;
  return last === undefined ? { items, total } : { items, total, next: [last.created_at, last.id] };
}

/** A member of the transaction's company, held by its row's lock: its company, its person, its status and its admin level. */
export interface HeldMember {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string | null;
  readonly status: "invited" | "active" | "inactive";
  readonly adminLevel: AdminLevel | null;
  readonly idleTimeoutMinutes: number;
}

/**
 * Locks the rows of the invited, active and inactive members of the
 * transaction's company among `ids`, in the order of their ids, so two
 * changes that lock two members never wait for each other in a circle, and
 * gives each by its id. An id that names no such member is not among them.
 */
export async function holdMembers(tx: Queryable, ids: readonly string[]): Promise<ReadonlyMap<string, HeldMember>> {
  const found = await tx.query<{ id: string; company_id: string; user_id: string | null; status: HeldMember["status"]; admin_level: AdminLevel | null; idle_timeout_minutes: number }>(
    `SELECT id, company_id, user_id, status, admin_level, idle_timeout_minutes FROM access.memberships WHERE id = ANY ($1) AND status IN ${REACHED} ORDER BY id FOR NO KEY UPDATE`,
    [ids],
  );
  return new Map(found.rows.map((row) => [row.id, { id: row.id, companyId: row.company_id, userId: row.user_id, status: row.status, adminLevel: row.admin_level, idleTimeoutMinutes: row.idle_timeout_minutes }]));
}

/** Locks one member (holdMembers), or gives nothing. */
export async function holdMember(tx: Queryable, id: string): Promise<HeldMember | undefined> {
  return (await holdMembers(tx, [id])).get(id);
}

/**
 * Whether the company has an active system administrator besides `member`.
 * The server asks it before it removes, deactivates, demotes or disconnects
 * one, and before one leaves; the database checks the same at the commit,
 * after it locked the company's row, which settles a race. It first takes the
 * company's turn of its administrators (access.take_administrators_turn):
 * alone for a disconnect, which sends its mail before its commit, and with
 * the others for every other change. So a disconnect's check reads every
 * competing change settled, and none of them commits while it sends its
 * mail; two changes that send no mail still meet at the database's check.
 */
export async function hasOtherAdministrator(tx: Queryable, member: HeldMember, turn: "alone" | "shared" = "shared"): Promise<boolean> {
  await tx.query("SELECT access.take_administrators_turn($1)", [turn === "alone"]);
  const found = await tx.query("SELECT 1 FROM access.memberships WHERE id <> $1 AND status = 'active' AND admin_level IS NOT NULL LIMIT 1", [member.id]);
  return found.rows.length > 0;
}

/**
 * The refusal of a change that takes the company's last active system
 * administrator away: the same as the database's at the commit, which the
 * runner gives when a race got past the server's check.
 */
export function lastAdministrator(member: HeldMember): Answer<never> {
  const data: Readonly<Record<string, JsonValue>> = { companyId: member.companyId };
  return refused({ code: "last-system-administrator", detail: LEDGER_REFUSALS.last_system_administrator.detail, data });
}

/** Whether a change takes the last active system administrator away: a removal, a deactivation, a demotion, a disconnect or a leave of one. */
export function takesAdministrator(member: HeldMember, after: { readonly status: string; readonly adminLevel: AdminLevel | null }): boolean {
  return member.status === "active" && member.adminLevel !== null && (after.status !== "active" || after.adminLevel === null);
}

/** What updateUser changes in a membership's own row: its status, its admin level and its idle time, each as it is to be. */
export interface MemberRowChange {
  readonly status: HeldMember["status"];
  readonly adminLevel: AdminLevel | null;
  readonly idleTimeoutMinutes: number;
}

/**
 * Writes a held member's status, admin level and idle time, when one of them
 * changes, in one update, so the behandlingshistorik gets one row for the
 * change. An idle time that a session works under is lowered with it by the
 * database, and a session ends when its membership stops being active.
 */
export async function writeMember(tx: Queryable, member: HeldMember, change: MemberRowChange): Promise<void> {
  await tx.query(
    `UPDATE access.memberships SET status = $2, admin_level = $3, idle_timeout_minutes = $4
     WHERE id = $1 AND (status, admin_level, idle_timeout_minutes) IS DISTINCT FROM ($2, $3, $4)`,
    [member.id, change.status, change.adminLevel, change.idleTimeoutMinutes],
  );
}

/**
 * Removes a held member: the status removed, which is final, and its
 * sessions end, by the database. The row stays, so the member stays the
 * actor on every entry. The work contacts are erased: they are profile
 * data, which only an active or inactive member keeps.
 */
export async function removeMember(tx: Queryable, member: HeldMember): Promise<void> {
  await tx.query("UPDATE access.memberships SET status = 'removed' WHERE id = $1", [member.id]);
  await tx.query("DELETE FROM access.membership_contacts WHERE contact_company_id = $1 AND membership_id = $2", [member.companyId, member.id]);
}

/**
 * Disconnects a held active or inactive member's identity: the membership
 * is invited again, with no person, in one update, which the
 * behandlingshistorik holds, and keeps its admin level, its idle time and
 * its programs. The database ends its sessions. The old person's work
 * contacts are erased. Gives whom the new invitation goes to: the person's
 * name, and the member's work e-mail address, read before it is erased.
 * Every active and inactive member has a work e-mail, so a member without
 * one is a fault of the server.
 */
export async function disconnectMember(tx: Queryable, member: HeldMember): Promise<{ readonly name: string; readonly email: string }> {
  const found = await tx.query<{ name: string; email: string }>(
    `SELECT p.name, c.work_email AS email FROM access.company_people($1) AS p
     JOIN access.membership_contacts AS c ON c.contact_company_id = $2 AND c.membership_id = $3
     WHERE c.work_email IS NOT NULL`,
    [[member.userId], member.companyId, member.id],
  );
  const [to] = found.rows;
  if (to === undefined) {
    throw new Error(`The member ${member.id} has no person with a work e-mail address in the company to invite again.`);
  }
  await tx.query("UPDATE access.memberships SET status = 'invited', user_id = NULL WHERE id = $1", [member.id]);
  await tx.query("DELETE FROM access.membership_contacts WHERE contact_company_id = $1 AND membership_id = $2", [member.companyId, member.id]);
  return to;
}

/**
 * The person leaves the company with their held active membership: the
 * status left, which is final and only the member's own person sets, and
 * the database ends its sessions. The row stays, and the work contacts are
 * erased.
 */
export async function leaveMember(tx: Queryable, member: HeldMember): Promise<void> {
  await tx.query("UPDATE access.memberships SET status = 'left' WHERE id = $1", [member.id]);
  await tx.query("DELETE FROM access.membership_contacts WHERE contact_company_id = $1 AND membership_id = $2", [member.companyId, member.id]);
}
