// SPDX-License-Identifier: AGPL-3.0-only

// The memberships as the database tests make and change them (db/README.md,
// the schema access). Each helper runs as the app, in a transaction of its
// own, with the company and an actor set, as the server will: by default the
// company's owner, as a system administrator acts, and for a leave the
// member's own person. The people are made up.

import type { Client } from "pg";
import { inTransaction } from "./database.ts";
import { addIdentity } from "./identities.ts";
import { addCompanyWithOwner, type Actor, type MadeCompany } from "./ledger.ts";

/** A membership as the database holds it, with its time as text. */
export interface MembershipRow {
  readonly id: string;
  readonly company_id: string;
  readonly user_id: string | null;
  readonly live_user_id: string | null;
  readonly status: string;
  readonly admin_level: string | null;
  readonly idle_timeout_minutes: number;
  readonly created_at: string;
}

/** The columns of a membership, with its time as text. */
export const MEMBERSHIP_COLUMNS = "id, company_id, user_id, live_user_id, status, admin_level, idle_timeout_minutes, created_at::text AS created_at";

/** The statuses a membership can have. */
export const STATUSES = ["invited", "active", "inactive", "removed", "left"] as const;
export type Status = (typeof STATUSES)[number];

/** A company, its owner and the owner's membership, with the owner as an actor of the kind user. */
export interface Company extends MadeCompany {
  readonly id: string;
  readonly asOwner: Actor;
}

/** Adds a company with its owner (addCompanyWithOwner), and gives it with the owner as an actor. */
export async function aCompany(app: Client, name = "Testbolaget Alfa AB"): Promise<Company> {
  const made = await addCompanyWithOwner(app, undefined, { name });
  return { ...made, id: made.row.company_id, asOwner: { actor: made.owner, kind: "user" } };
}

/** What a test may give a new membership. */
export interface NewMembership {
  readonly user?: string | null;
  readonly status?: "invited" | "active";
  readonly adminLevel?: "owner" | "admin" | null;
  readonly idle?: number;
}

/** Runs `sql` as the app in one transaction in `company`, as `who`, and gives the rows it returned. */
export async function asMember<T extends object = Record<string, unknown>>(
  app: Client,
  company: string,
  who: Actor,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return inTransaction(app, { company, ...who, channel: "rest" }, async () => (await app.query<T>(sql, [...params])).rows);
}

/** Inserts a membership in `company`, as `who`, and gives its id. An active one without a user gets a new identity. */
export async function addMembership(app: Client, owner: Client, company: Company, membership: NewMembership = {}): Promise<string> {
  const status = membership.status ?? "active";
  const user = membership.user === undefined ? (status === "invited" ? null : await addIdentity(owner, { name: "Gunnar Holm" })) : membership.user;
  const [row] = await asMember<{ id: string }>(
    app,
    company.id,
    company.asOwner,
    "INSERT INTO access.memberships (company_id, user_id, status, admin_level, idle_timeout_minutes) VALUES ($1, $2, $3, $4, COALESCE($5, 120)) RETURNING id",
    [company.id, user, status, membership.adminLevel ?? null, membership.idle ?? null],
  );
  if (row === undefined) {
    throw new Error("The membership was not added.");
  }
  return row.id;
}

/** Changes a membership of `company` with `set`, whose parameters start at $2, as `who` (by default the owner), and gives its row. */
export async function changeMembership(
  app: Client,
  company: Company,
  id: string,
  set: string,
  params: readonly unknown[] = [],
  who: Actor = company.asOwner,
): Promise<MembershipRow | undefined> {
  const [row] = await asMember<MembershipRow>(app, company.id, who, `UPDATE access.memberships SET ${set} WHERE id = $1 RETURNING ${MEMBERSHIP_COLUMNS}`, [id, ...params]);
  return row;
}

/** A membership of `company`, as the app reads it. */
export async function membershipOf(app: Client, company: string, id: string): Promise<MembershipRow | undefined> {
  return inTransaction(app, { company }, async () => (await app.query<MembershipRow>(`SELECT ${MEMBERSHIP_COLUMNS} FROM access.memberships WHERE id = $1`, [id])).rows[0]);
}

/**
 * A membership of `company` in `status`, made by the way the server's
 * operations make it: invited and active by an insert, inactive and removed
 * by the owner's change of an active one, left by its person's own. Gives its
 * id and its person, if any.
 */
export async function membershipIn(app: Client, owner: Client, company: Company, status: Status): Promise<{ id: string; user: string | null }> {
  if (status === "invited") {
    return { id: await addMembership(app, owner, company, { status: "invited" }), user: null };
  }
  const user = await addIdentity(owner, { name: "Hedda Sjö" });
  const id = await addMembership(app, owner, company, { user });
  if (status === "inactive" || status === "removed") {
    await changeMembership(app, company, id, "status = $2", [status]);
  }
  if (status === "left") {
    await changeMembership(app, company, id, "status = 'left'", [], { actor: user, kind: "user" });
  }
  return { id, user };
}
