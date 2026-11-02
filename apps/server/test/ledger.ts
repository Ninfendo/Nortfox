// SPDX-License-Identifier: AGPL-3.0-only

// Builders for the ledger's rows, for the database tests. Each one runs as the
// connection it is given, in its own transaction, with the company and an
// actor set, as the server will. The companies and the people are made up.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { inTransaction } from "./database.ts";
import type { ActorKind } from "./every-table.ts";

/** Who acts in a transaction. */
export interface Actor {
  readonly actor: string;
  readonly kind: ActorKind;
}

/** A user, made up for one test. */
export function someUser(): Actor {
  return { actor: randomUUID(), kind: "user" };
}

/** Adds a company as `client`, and gives its id. */
export async function addCompany(client: Client, who: Actor = someUser()): Promise<string> {
  const company = randomUUID();
  await inTransaction(client, { company, ...who }, () =>
    client.query("INSERT INTO ledger.companies (company_id, name, organization_number) VALUES ($1, 'Testbolaget Alfa AB', '556000-0167')", [
      company,
    ]),
  );
  return company;
}

/** A fiscal year as the database holds it, with its dates as text. */
export interface FiscalYear {
  readonly id: string;
  readonly company_id: string;
  readonly year_number: number;
  readonly from_date: string;
  readonly to_date: string;
  readonly accounting_method: string;
  readonly account_chart_type: string;
  readonly is_default: boolean;
}

/** The columns of a fiscal year, with its dates as text. */
export const FISCAL_YEAR_COLUMNS =
  "id, company_id, year_number, from_date::text AS from_date, to_date::text AS to_date, accounting_method, account_chart_type, is_default";

export interface NewFiscalYear {
  readonly from: string;
  readonly to: string;
  readonly method?: "ACCRUAL" | "CASH";
  readonly chart?: string;
  readonly isDefault?: boolean;
}

/** Adds a fiscal year to `company` as `client`, and gives its row. */
export async function addFiscalYear(client: Client, company: string, year: NewFiscalYear, who: Actor = someUser()): Promise<FiscalYear> {
  return inTransaction(client, { company, ...who }, async () => {
    const found = await client.query<FiscalYear>(
      `INSERT INTO ledger.fiscal_years (company_id, from_date, to_date, accounting_method, account_chart_type, is_default)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${FISCAL_YEAR_COLUMNS}`,
      [company, year.from, year.to, year.method ?? "ACCRUAL", year.chart ?? "Bas 2026", year.isDefault ?? false],
    );
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("The fiscal year was not added.");
    }
    return row;
  });
}

/** Adds a period to a fiscal year as `client`, and gives its id. */
export async function addPeriod(client: Client, company: string, year: string, from: string, to: string, who: Actor = someUser()): Promise<string> {
  return inTransaction(client, { company, ...who }, async () => {
    const found = await client.query<{ id: string }>(
      "INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, $3, $4) RETURNING id",
      [company, year, from, to],
    );
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("The period was not added.");
    }
    return row.id;
  });
}

/** The four rows of the manual lock: one per user, the internal system user's, the integrations' and all users'. */
export type LockScope = "user" | "system" | "integration" | "all";

/** A row of the manual lock, with its dates and its time as text. */
export interface PeriodLock {
  readonly id: string;
  readonly scope: LockScope;
  readonly user_id: string | null;
  readonly end_date: string | null;
  readonly set_by: string;
  readonly set_by_kind: string;
  readonly set_at: string;
}

export const PERIOD_LOCK_COLUMNS = "id, scope, user_id, end_date::text AS end_date, set_by, set_by_kind, set_at::text AS set_at";

/**
 * Sets a lock date, or clears it with null, as `client`: it adds the row of
 * that scope (and user) when the company has none, or else changes its date.
 */
export async function setLock(
  client: Client,
  company: string,
  scope: LockScope,
  endDate: string | null,
  options: { readonly user?: string; readonly who?: Actor } = {},
): Promise<PeriodLock> {
  const user = options.user ?? null;
  return inTransaction(client, { company, ...(options.who ?? someUser()) }, async () => {
    const changed = await client.query<PeriodLock>(
      `UPDATE ledger.period_locks SET end_date = $3 WHERE scope = $1 AND user_id IS NOT DISTINCT FROM $2::uuid RETURNING ${PERIOD_LOCK_COLUMNS}`,
      [scope, user, endDate],
    );
    const found =
      changed.rows.length > 0
        ? changed
        : await client.query<PeriodLock>(
            `INSERT INTO ledger.period_locks (company_id, scope, user_id, end_date) VALUES ($1, $2, $3, $4) RETURNING ${PERIOD_LOCK_COLUMNS}`,
            [company, scope, user, endDate],
          );
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("The lock was not set.");
    }
    return row;
  });
}

/** The intervals of the automatic lock. */
export type AutomaticInterval = "month_end_50" | "quarter_end_50" | "year_end_60";

/** The automatic lock's settings, with the time as text. */
export interface AutomaticLock {
  readonly id: string;
  readonly company_id: string;
  readonly enabled: boolean;
  readonly interval: AutomaticInterval | null;
  readonly notice_days: number | null;
  readonly set_by: string;
  readonly set_by_kind: string;
  readonly set_at: string;
}

export const AUTOMATIC_LOCK_COLUMNS = "id, company_id, enabled, interval, notice_days, set_by, set_by_kind, set_at::text AS set_at";

/** Turns the automatic lock on with an interval, or off with null, as `client`. */
export async function setAutomaticLock(
  client: Client,
  company: string,
  interval: AutomaticInterval | null,
  who: Actor = someUser(),
): Promise<AutomaticLock> {
  return inTransaction(client, { company, ...who }, async () => {
    const found = await client.query<AutomaticLock>(
      `UPDATE ledger.automatic_locks SET enabled = $1, interval = COALESCE($2, interval) RETURNING ${AUTOMATIC_LOCK_COLUMNS}`,
      [interval !== null, interval],
    );
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("The company has no automatic lock row.");
    }
    return row;
  });
}
