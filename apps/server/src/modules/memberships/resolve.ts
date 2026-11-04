// SPDX-License-Identifier: AGPL-3.0-only

// The one membership function in the server (issue 12, "Users in a
// company", behaviour 10; decision 9). Whether a person may work in a
// company is the one question that crosses companies, and one database
// function answers it, access.active_membership (db/README.md, the schema
// access). It reads the person from the transaction's actor, never from a
// parameter. This module is its only caller, and every access check asks
// here: the resolver for a session or a token, the runner for a company that
// the input names, and the company lists. A later slice adds grants through
// an accounting firm inside that function, and nothing here or in row level
// security changes.
//
// It gives ResolvedMembership objects, which only this module can make:
// their constructor takes a token that never leaves the module. A
// principal's company access (CompanyAccess) is made only from one, and
// authorize refuses a company access that this module did not make. A
// lookup enters a company only with a membership that the function gave in
// that same transaction (tx.enter, db/database.ts). Neither object changes
// once made. scripts/guards/membership.ts keeps every other file of the
// server from naming the function, the memberships or the token, and from
// building either object by hand.

import { ADMIN_LEVELS, type AdminLevel } from "@nortfox/contract";
import type { Queryable } from "../../db/database.ts";

/** The token that only this module holds. A constructor refuses every caller without it. */
const MEMBERSHIP_TOKEN = Symbol("made by modules/memberships/resolve.ts");

/** A row of the one function, with the person it read from the transaction's actor. */
export interface MembershipRow {
  readonly membership_id: string;
  readonly company_id: string;
  readonly status: string;
  readonly admin_level: string | null;
  readonly idle_timeout_minutes: number;
  readonly company_name: string;
  readonly organization_number: string;
  readonly database_number: number;
  readonly person_id: string | null;
}

/** The query of the one function: `$1` for one company, nothing for every one. */
function membershipQuery(argument: string): string {
  return `SELECT m.membership_id, m.company_id, m.status, m.admin_level, m.idle_timeout_minutes, m.company_name, m.organization_number,
  m.database_number, access.current_person_id() AS person_id FROM access.active_membership(${argument}) AS m`;
}

/** The company of a membership, as the one function gives it. */
export interface MembershipCompany {
  readonly name: string;
  readonly organizationNumber: string;
  /** The company's tenant id. */
  readonly databaseNumber: number;
}

/**
 * The company a request works in, as a principal holds it: the membership
 * that gives it, its admin level, and the permissions the person holds
 * there. Made only from a ResolvedMembership.
 */
export class CompanyAccess {
  readonly companyId: string;
  readonly membershipId: string;
  readonly adminLevel: AdminLevel | null;
  readonly permissions: ReadonlySet<string>;

  constructor(token: symbol, membership: ResolvedMembership, permissions: Iterable<string>) {
    if (token !== MEMBERSHIP_TOKEN) {
      throw new Error("Only modules/memberships/resolve.ts makes a CompanyAccess, from a membership that the one membership function gave.");
    }
    this.companyId = membership.companyId;
    this.membershipId = membership.membershipId;
    this.adminLevel = membership.adminLevel;
    this.permissions = new Set(permissions);
    Object.freeze(this);
  }
}

/** The admin level of a row, or a throw: the database knows only these. */
function adminLevelOf(row: MembershipRow): AdminLevel | null {
  const level = row.admin_level;
  if (level !== null && !(ADMIN_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`The one membership function gave the unknown admin level ${level}.`);
  }
  return level as AdminLevel | null;
}

/**
 * A person's active membership in a company, as the one membership function
 * gave it in one transaction: the membership, its company, its admin level,
 * its idle time, and the person.
 */
export class ResolvedMembership {
  /** The person the function read from the transaction's actor. */
  readonly personId: string;
  readonly membershipId: string;
  readonly companyId: string;
  readonly adminLevel: AdminLevel | null;
  /** How long the person's session may go without a request in this company. */
  readonly idleTimeoutMinutes: number;
  readonly company: MembershipCompany;
  /** The transaction the function answered in. */
  readonly #transaction: Queryable;

  constructor(token: symbol, row: MembershipRow, transaction: Queryable) {
    if (token !== MEMBERSHIP_TOKEN) {
      throw new Error("Only modules/memberships/resolve.ts makes a ResolvedMembership, from the one membership function's answer.");
    }
    if (row.status !== "active") {
      throw new Error(`The one membership function gave a membership that is ${row.status}, not active.`);
    }
    if (row.person_id === null) {
      throw new Error("The one membership function gave a membership with no person.");
    }
    this.personId = row.person_id;
    this.membershipId = row.membership_id;
    this.companyId = row.company_id;
    this.adminLevel = adminLevelOf(row);
    this.idleTimeoutMinutes = row.idle_timeout_minutes;
    this.company = Object.freeze({ name: row.company_name, organizationNumber: row.organization_number, databaseNumber: row.database_number });
    this.#transaction = transaction;
    Object.freeze(this);
  }

  /** The company access this membership gives, with the permissions the person holds there. */
  access(permissions: Iterable<string>): CompanyAccess {
    return new CompanyAccess(MEMBERSHIP_TOKEN, this, permissions);
  }

  /** Whether the function gave this membership in `transaction`. */
  resolvedIn(transaction: Queryable): boolean {
    return this.#transaction === transaction;
  }
}

/**
 * The transaction's person's active membership in `companyId`, or undefined
 * when the person has none there: the same for a company that does not
 * exist, for a person with no active identity, and with no person set.
 */
export async function resolveActive(tx: Queryable, companyId: string): Promise<ResolvedMembership | undefined> {
  const found = await tx.query<MembershipRow>(membershipQuery("$1"), [companyId]);
  if (found.rows.length > 1) {
    throw new Error(`The one membership function gave ${String(found.rows.length)} memberships in one company.`);
  }
  const [row] = found.rows;
  return row === undefined ? undefined : new ResolvedMembership(MEMBERSHIP_TOKEN, row, tx);
}

/** The transaction's person's active memberships in every company, by the company's name: the company lists. */
export async function activeMemberships(tx: Queryable): Promise<readonly ResolvedMembership[]> {
  const found = await tx.query<MembershipRow>(membershipQuery(""));
  return found.rows.map((row) => new ResolvedMembership(MEMBERSHIP_TOKEN, row, tx));
}

/** What a page of the person's companies asks for: a part of the name or the organisation number, where the page starts, and its length. */
export interface MembershipPageRequest {
  /** A part of the company's name, in any letter case, or of its organisation number. */
  readonly query?: string;
  /** The sort key of the last company of the page before: its name and its id. */
  readonly after?: readonly string[];
  readonly limit: number;
}

/** A page of the person's active memberships, the sort key of its last one while more follow, and how many the whole list holds. */
export interface MembershipPage {
  readonly memberships: readonly ResolvedMembership[];
  /** The last company's name and id, while more follow. */
  readonly next?: readonly string[];
  readonly total: number;
}

/** The condition of the companies that a query keeps: $1 is the query, or NULL for every company. */
const KEPT = "($1::text IS NULL OR strpos(lower(m.company_name), lower($1)) > 0 OR strpos(m.organization_number, $1) > 0)";

/**
 * A page of the transaction's person's active memberships, by the company's
 * name and then its id, as the one function orders them: at most `limit`
 * after the sort key `after`, of the companies that `query` keeps. It reads
 * one more to tell whether more follow, and the total in the same
 * transaction.
 */
export async function activeMembershipPage(tx: Queryable, request: MembershipPageRequest): Promise<MembershipPage> {
  const [afterName, afterId] = request.after ?? [];
  const found = await tx.query<MembershipRow>(
    `${membershipQuery("")} WHERE ${KEPT} AND ($2::text IS NULL OR (m.company_name, m.company_id) > ($2, $3::uuid))
     ORDER BY m.company_name, m.company_id LIMIT $4`,
    [request.query ?? null, afterName ?? null, afterId ?? null, request.limit + 1],
  );
  const counted = await tx.query<{ total: string }>(`SELECT count(*) AS total FROM access.active_membership() AS m WHERE ${KEPT}`, [request.query ?? null]);
  const memberships = found.rows.slice(0, request.limit).map((row) => new ResolvedMembership(MEMBERSHIP_TOKEN, row, tx));
  // While more follow, the page is full, and its last row is the next page's start.
  const last = found.rows.length > request.limit ? found.rows[request.limit - 1] : undefined;
  // A count gives one row.
  const total = Number((counted.rows as [{ readonly total: string }])[0].total);
  return last === undefined ? { memberships, total } : { memberships, next: [last.company_name, last.company_id], total };
}
