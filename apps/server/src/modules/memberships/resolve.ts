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
