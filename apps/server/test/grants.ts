// SPDX-License-Identifier: AGPL-3.0-only

// The program grants and the program administrators as the database tests
// make them (db/README.md, the schema access). Each helper runs as the app,
// in a transaction of its own, in the company, as its owner by default, as a
// system administrator grants. The people are made up.

import type { Client } from "pg";
import type { Actor } from "./ledger.ts";
import { asMember, type Company } from "./memberships.ts";

/** A grant as the database holds it, with its times as text. */
export interface GrantRow {
  readonly id: string;
  readonly company_id: string;
  readonly membership_id: string;
  readonly program: string;
  readonly permissions: string[];
  readonly is_full: boolean;
  readonly granted_at: string;
  readonly expires_at: string | null;
}

/** The columns of a grant, with its times as text. */
export const GRANT_COLUMNS = "id, company_id, membership_id, program, permissions, is_full, granted_at::text AS granted_at, expires_at::text AS expires_at";

/** Grants `program` with `permissions` to a membership of `company`, as `who` (by default the owner), and gives the grant's row. */
export async function addGrant(
  app: Client,
  company: Company,
  membership: string,
  program: string,
  permissions: readonly (string | null)[],
  who: Actor = company.asOwner,
): Promise<GrantRow> {
  const [row] = await asMember<GrantRow>(
    app,
    company.id,
    who,
    `INSERT INTO access.program_grants (company_id, membership_id, program, permissions) VALUES ($1, $2, $3, $4) RETURNING ${GRANT_COLUMNS}`,
    [company.id, membership, program, permissions],
  );
  if (row === undefined) {
    throw new Error("The grant was not added.");
  }
  return row;
}

/** Changes a grant of `company` with `set`, whose parameters start at $2, as `who` (by default the owner), and gives its row. */
export async function changeGrant(
  app: Client,
  company: Company,
  id: string,
  set: string,
  params: readonly unknown[] = [],
  who: Actor = company.asOwner,
): Promise<GrantRow | undefined> {
  const [row] = await asMember<GrantRow>(app, company.id, who, `UPDATE access.program_grants SET ${set} WHERE id = $1 RETURNING ${GRANT_COLUMNS}`, [
    id,
    ...params,
  ]);
  return row;
}

/** When a grant of `company` was granted and when it ends, as the server reads them: to the millisecond. */
export async function grantTimes(app: Client, company: Company, id: string): Promise<{ readonly grantedAt: Date; readonly expiresAt: Date | null }> {
  const [row] = await asMember<{ granted_at: Date; expires_at: Date | null }>(
    app,
    company.id,
    company.asOwner,
    "SELECT granted_at, expires_at FROM access.program_grants WHERE id = $1",
    [id],
  );
  if (row === undefined) {
    throw new Error("The company holds no such grant.");
  }
  return { grantedAt: row.granted_at, expiresAt: row.expires_at };
}

/** Appoints a membership of `company` the administrator of `program`, as the owner, and gives the row's id. */
export async function addProgramAdmin(app: Client, company: Company, membership: string, program: string): Promise<string> {
  const [row] = await asMember<{ id: string }>(
    app,
    company.id,
    company.asOwner,
    "INSERT INTO access.program_admins (company_id, membership_id, program) VALUES ($1, $2, $3) RETURNING id",
    [company.id, membership, program],
  );
  if (row === undefined) {
    throw new Error("The program administrator was not added.");
  }
  return row.id;
}
