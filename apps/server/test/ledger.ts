// SPDX-License-Identifier: AGPL-3.0-only

// Builders for the ledger's rows, for the database tests. Each one runs as the
// connection it is given, in its own transaction, with the company and an
// actor set, as the server will. The companies and the people are made up.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { connectAs } from "./cluster.ts";
import { inTransaction } from "./database.ts";
import type { ActorKind } from "./every-table.ts";
import { addIdentity } from "./identities.ts";

/** Who acts in a transaction. */
export interface Actor {
  readonly actor: string;
  readonly kind: ActorKind;
}

/** A user, made up for one test. */
export function someUser(): Actor {
  return { actor: randomUUID(), kind: "user" };
}

/** What a test may give a new company. Each value left out takes a made-up one. */
export interface CompanyValues {
  readonly id?: string;
  readonly name?: string;
  readonly organizationNumber?: string;
  /** A tenant id to give, which the database refuses: it gives each company its own. */
  readonly databaseNumber?: unknown;
}

/** A company as the database holds it. */
export interface CompanyRow {
  readonly company_id: string;
  readonly name: string;
  readonly organization_number: string;
  readonly database_number: number;
}

/** A company that a test made, with its owner. */
export interface MadeCompany {
  readonly row: CompanyRow;
  /** The owner's identity, which made the company. */
  readonly owner: string;
  /** The owner's membership, the company's first. */
  readonly membership: string;
}

/**
 * Inserts a company in the open transaction of `client`, which has the
 * company and the actor set, and gives its row. The database checks at the
 * commit that the company has an active system administrator, so the same
 * transaction adds its owner (insertOwner), unless the test wants that
 * refusal. Every test makes its companies here or with addCompany.
 */
export async function insertCompany(client: Client, values: CompanyValues & { readonly id: string }): Promise<CompanyRow> {
  const columns = ["company_id", "name", "organization_number", ...(values.databaseNumber === undefined ? [] : ["database_number"])];
  const params = [
    values.id,
    values.name ?? "Testbolaget Alfa AB",
    values.organizationNumber ?? "556000-0167",
    ...(values.databaseNumber === undefined ? [] : [values.databaseNumber]),
  ];
  const found = await client.query<CompanyRow>(
    `INSERT INTO ledger.companies (${columns.join(", ")}) VALUES (${params.map((_value, index) => `$${String(index + 1)}`).join(", ")})
     RETURNING company_id, name, organization_number, database_number`,
    params,
  );
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The company was not added.");
  }
  return row;
}

/** Adds a company's first membership, its owner's, active, in the open transaction of `client`, and gives its id. */
export async function insertOwner(client: Client, company: string, person: string): Promise<string> {
  const found = await client.query<{ id: string }>(
    "INSERT INTO access.memberships (company_id, user_id, status, admin_level) VALUES ($1, $2, 'active', 'owner') RETURNING id",
    [company, person],
  );
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The membership was not added.");
  }
  return row.id;
}

/**
 * Makes `person` a login identity, unless it is one already, as the owner
 * does: in a connection of its own as the owner, to the database of
 * `client`, committed.
 */
export async function ensureIdentity(client: Client, person: string): Promise<void> {
  if (client.database === undefined) {
    throw new Error("The connection names no database.");
  }
  const owner = await connectAs("nortfox_owner", client.database);
  try {
    const found = await owner.query("SELECT FROM access.identities WHERE id = $1", [person]);
    if (found.rows.length === 0) {
      await addIdentity(owner, { id: person, name: "Dagny Lund" });
    }
  } finally {
    await owner.end();
  }
}

/**
 * Adds a company as `client`, as createCompany does: its maker is a person,
 * a login identity, which acts in one transaction that inserts the company
 * and makes the person its owner, the company's first membership, active.
 */
export async function addCompanyWithOwner(client: Client, who: Actor = someUser(), values: CompanyValues = {}): Promise<MadeCompany> {
  if (who.kind === "system") {
    throw new Error("A person makes a company: the internal system user has no identity.");
  }
  await ensureIdentity(client, who.actor);
  const company = values.id ?? randomUUID();
  return inTransaction(client, { company, ...who }, async () => {
    const row = await insertCompany(client, { ...values, id: company });
    const membership = await insertOwner(client, company, who.actor);
    return { row, owner: who.actor, membership };
  });
}

/** Adds a company as `client`, with `who` as its owner (addCompanyWithOwner), and gives its id. */
export async function addCompany(client: Client, who: Actor = someUser(), values: CompanyValues = {}): Promise<string> {
  return (await addCompanyWithOwner(client, who, values)).row.company_id;
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

/** An account as the database holds it, with its modified time as text. */
export interface Account {
  readonly id: string;
  readonly company_id: string;
  readonly fiscal_year_id: string;
  readonly number: number;
  readonly description: string;
  readonly active: boolean;
  readonly modified_at: string;
}

export const ACCOUNT_COLUMNS = "id, company_id, fiscal_year_id, number, description, active, modified_at::text AS modified_at";

export interface NewAccount {
  readonly number: number;
  readonly description?: string;
  readonly active?: boolean;
}

/** Adds an account to a fiscal year as `client`, and gives its row. */
export async function addAccount(client: Client, company: string, year: string, account: NewAccount, who: Actor = someUser()): Promise<Account> {
  return inTransaction(client, { company, ...who }, async () => {
    const found = await client.query<Account>(
      `INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${ACCOUNT_COLUMNS}`,
      [company, year, account.number, account.description ?? "Kassa", account.active ?? true],
    );
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("The account was not added.");
    }
    return row;
  });
}

/** A voucher series as the database holds it, with its modified time as text. */
export interface VoucherSeries {
  readonly id: string;
  readonly company_id: string;
  readonly fiscal_year_id: string;
  readonly code: string;
  readonly description: string;
  readonly manual: boolean;
  readonly is_closing: boolean;
  readonly modified_at: string;
}

export const SERIES_COLUMNS = "id, company_id, fiscal_year_id, code, description, manual, is_closing, modified_at::text AS modified_at";

export interface NewSeries {
  readonly code: string;
  readonly description?: string;
  readonly manual?: boolean;
  readonly isClosing?: boolean;
}

/** Adds a voucher series to a fiscal year as `client`, and gives its row. */
export async function addSeries(client: Client, company: string, year: string, series: NewSeries, who: Actor = someUser()): Promise<VoucherSeries> {
  return inTransaction(client, { company, ...who }, async () => {
    const found = await client.query<VoucherSeries>(
      `INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual, is_closing)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SERIES_COLUMNS}`,
      [company, year, series.code, series.description ?? "Testserie", series.manual ?? true, series.isClosing ?? false],
    );
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("The voucher series was not added.");
    }
    return row;
  });
}

/** A series' counter as the database holds it. */
export interface VoucherCounter {
  readonly id: string;
  readonly company_id: string;
  readonly series_id: string;
  readonly next_number: number;
}

export const COUNTER_COLUMNS = "id, company_id, series_id, next_number";

/** The counter of a series, read as `client` in `company`, or undefined when it has none. */
export async function counterOf(client: Client, company: string, series: string): Promise<VoucherCounter | undefined> {
  return inTransaction(client, { company }, async () => {
    const found = await client.query<VoucherCounter>(`SELECT ${COUNTER_COLUMNS} FROM ledger.voucher_counters WHERE series_id = $1`, [series]);
    return found.rows[0];
  });
}

/** A void range as the database holds it, with its time and its transaction as text. */
export interface VoidRange {
  readonly id: string;
  readonly company_id: string;
  readonly fiscal_year_id: string;
  readonly series_code: string;
  readonly first_number: number;
  readonly last_number: number;
  readonly reason: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly created_by_kind: string;
  readonly created_xact: string;
}

export const VOID_RANGE_COLUMNS =
  "id, company_id, fiscal_year_id, series_code, first_number, last_number, reason, created_at::text AS created_at, created_by, created_by_kind, created_xact::text AS created_xact";

/** The internal system user, made up for one test: a restore records its void ranges as this kind of actor. */
export function someSystemUser(): Actor {
  return { actor: randomUUID(), kind: "system" };
}

export interface NewVoidRange {
  readonly year: string;
  readonly code: string;
  readonly first: number;
  readonly last: number;
  readonly reason?: string;
}

/** The statement that records a void range, as the restore tool will run it as the owner. */
export const INSERT_VOID_RANGE = `INSERT INTO ledger.void_ranges (company_id, fiscal_year_id, series_code, first_number, last_number, reason)
  VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${VOID_RANGE_COLUMNS}`;

/** Records a void range as `owner`, in its own transaction, and gives its row. */
export async function recordVoidRange(owner: Client, company: string, range: NewVoidRange, who: Actor = someSystemUser()): Promise<VoidRange> {
  return inTransaction(owner, { company, ...who }, async () => {
    const found = await owner.query<VoidRange>(INSERT_VOID_RANGE, [
      company,
      range.year,
      range.code,
      range.first,
      range.last,
      range.reason ?? "Återläsning av säkerhetskopia",
    ]);
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("The void range was not recorded.");
    }
    return row;
  });
}

/** Whether the time `later` comes after `earlier`, both as timestamptz text. */
export async function isAfter(client: Client, later: string, earlier: string): Promise<boolean> {
  const found = await client.query<{ after: boolean }>("SELECT $1::timestamptz > $2::timestamptz AS after", [later, earlier]);
  return found.rows[0]?.after === true;
}

/** The seven reference types a voucher can have. */
export const REFERENCE_TYPES = ["INVOICE", "SUPPLIERINVOICE", "INVOICEPAYMENT", "SUPPLIERPAYMENT", "MANUAL", "CASHINVOICE", "ACCRUAL"] as const;

/** A voucher as the database holds it, with its date, its times and its transaction as text. */
export interface Voucher {
  readonly id: string;
  readonly company_id: string;
  readonly fiscal_year_id: string;
  readonly series_code: string;
  readonly number: number;
  readonly description: string;
  readonly comments: string;
  readonly transaction_date: string;
  readonly reference_type: string;
  readonly reference_number: string;
  readonly reverses_voucher_id: string | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly created_by_kind: string;
  readonly created_xact: string;
  readonly modified_at: string;
  readonly altered_at: string | null;
  readonly altered_by: string | null;
  readonly altered_by_kind: string | null;
}

/** The columns of a voucher, in the table's order, with its date, times and transaction as text. */
export const VOUCHER_COLUMNS = `id, company_id, fiscal_year_id, series_code, number, description, comments, transaction_date::text AS transaction_date,
  reference_type, reference_number, reverses_voucher_id, created_at::text AS created_at, created_by, created_by_kind,
  created_xact::text AS created_xact, modified_at::text AS modified_at, altered_at::text AS altered_at, altered_by, altered_by_kind`;

/** A voucher row as the database holds it, with its times as text. The debit and the credit are whole öre, as bigints. */
export interface VoucherRow {
  readonly id: string;
  readonly company_id: string;
  readonly voucher_id: string;
  readonly fiscal_year_id: string;
  readonly position: number;
  readonly account_number: number;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly transaction_information: string;
  readonly quantity: string;
  readonly removed: boolean;
  readonly removed_at: string | null;
  readonly removed_by: string | null;
  readonly removed_by_kind: string | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly created_by_kind: string;
}

/** The columns of a voucher row, in the table's order, with its times as text. */
export const ROW_COLUMNS = `id, company_id, voucher_id, fiscal_year_id, position, account_number, debit, credit, transaction_information, quantity,
  removed, removed_at::text AS removed_at, removed_by, removed_by_kind, created_at::text AS created_at, created_by, created_by_kind`;

/** A row to book: its account, its debit and its credit in öre (0 when not given), and its text and quantity when given. */
export interface NewRow {
  readonly account: number;
  readonly debit?: bigint;
  readonly credit?: bigint;
  readonly text?: string;
  readonly quantity?: string;
}

export interface NewVoucher {
  readonly year: string;
  readonly series: string;
  readonly date: string;
  readonly description?: string;
  readonly comments?: string;
  readonly referenceType?: string;
  readonly referenceNumber?: string;
  readonly reverses?: string;
  readonly rows: readonly NewRow[];
}

/** The statement that books a voucher's head. Its rows follow, one statement each. */
export const INSERT_VOUCHER = `INSERT INTO ledger.vouchers
  (company_id, fiscal_year_id, series_code, description, comments, transaction_date, reference_type, reference_number, reverses_voucher_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${VOUCHER_COLUMNS}`;

/** The statement that adds a row to a voucher, with its quantity. */
export const INSERT_ROW = `INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, debit, credit, transaction_information, quantity)
  VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${ROW_COLUMNS}`;

/** The statement that adds a row to a voucher, with no quantity given. */
export const INSERT_ROW_WITHOUT_QUANTITY = `INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, debit, credit, transaction_information)
  VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${ROW_COLUMNS}`;

/**
 * The statement that locks a voucher until the transaction ends. Every
 * caller runs it before it changes one of the voucher's rows (db/README.md,
 * the lock order): a row's change locks the row before its trigger locks the
 * voucher, and a deletion locks the voucher before its rows, so the two
 * would otherwise deadlock.
 */
export const LOCK_VOUCHER = "SELECT 1 FROM ledger.vouchers WHERE id = $1 FOR NO KEY UPDATE";

/** Adds one row to a voucher as `client`, in the open transaction, and gives it. */
export async function writeRow(client: Client, company: string, voucher: string, row: NewRow): Promise<VoucherRow> {
  const sides = [row.debit ?? 0n, row.credit ?? 0n];
  const found =
    row.quantity === undefined
      ? await client.query<VoucherRow>(INSERT_ROW_WITHOUT_QUANTITY, [company, voucher, row.account, ...sides, row.text ?? ""])
      : await client.query<VoucherRow>(INSERT_ROW, [company, voucher, row.account, ...sides, row.text ?? "", row.quantity]);
  const [written] = found.rows;
  if (written === undefined) {
    throw new Error("The row was not added.");
  }
  return written;
}

/** Books a voucher and its rows as `client`, in the open transaction, and gives the voucher as it was booked. */
export async function writeVoucher(client: Client, company: string, voucher: NewVoucher): Promise<Voucher> {
  const found = await client.query<Voucher>(INSERT_VOUCHER, [
    company,
    voucher.year,
    voucher.series,
    voucher.description ?? "Kontorsmaterial",
    voucher.comments ?? "",
    voucher.date,
    voucher.referenceType ?? "MANUAL",
    voucher.referenceNumber ?? "",
    voucher.reverses ?? null,
  ]);
  const [booked] = found.rows;
  if (booked === undefined) {
    throw new Error("The voucher was not booked.");
  }
  for (const row of voucher.rows) {
    await writeRow(client, company, booked.id, row);
  }
  return booked;
}

/** Books a voucher and its rows as `client`, in a transaction of its own, and gives the voucher. */
export async function bookVoucher(client: Client, company: string, voucher: NewVoucher, who: Actor = someUser()): Promise<Voucher> {
  return inTransaction(client, { company, ...who }, () => writeVoucher(client, company, voucher));
}

/** Two rows that balance: `amount` öre debit on one account, the same credit on the other. */
export function balanced(amount = 2000n, debit = 6110, credit = 1930): NewRow[] {
  return [
    { account: debit, debit: amount },
    { account: credit, credit: amount },
  ];
}

/** A voucher by its id, read as `client` in `company`, or undefined when it is not there. */
export async function voucherOf(client: Client, company: string, id: string): Promise<Voucher | undefined> {
  return inTransaction(client, { company }, async () => {
    const found = await client.query<Voucher>(`SELECT ${VOUCHER_COLUMNS} FROM ledger.vouchers WHERE id = $1`, [id]);
    return found.rows[0];
  });
}

/** A voucher's rows in their order, read as `client` in `company`. */
export async function rowsOf(client: Client, company: string, voucher: string): Promise<VoucherRow[]> {
  return inTransaction(client, { company }, async () => {
    const found = await client.query<VoucherRow>(`SELECT ${ROW_COLUMNS} FROM ledger.voucher_rows WHERE voucher_id = $1 ORDER BY position`, [voucher]);
    return found.rows;
  });
}

/** The next number of the series with `code` in `year`, read as `client` in `company`. */
export async function nextNumberOf(client: Client, company: string, year: string, code: string): Promise<number | undefined> {
  return inTransaction(client, { company }, async () => {
    const found = await client.query<{ next_number: number }>(
      `SELECT c.next_number FROM ledger.voucher_counters AS c JOIN ledger.voucher_series AS s ON s.id = c.series_id
       WHERE s.fiscal_year_id = $1 AND s.code = $2`,
      [year, code],
    );
    return found.rows[0]?.next_number;
  });
}

/**
 * An entry of the record of deleted vouchers, with its dates, times and
 * transactions as text: the voucher as it was, under its own id, with the
 * entry's own id as entry_id.
 */
export interface DeletedVoucher extends Voucher {
  readonly deletion_count: number;
  readonly deleted_at: string;
  readonly deleted_by: string;
  readonly deleted_by_kind: string;
  readonly deleted_xact: string;
  readonly entry_id: string;
}

/** The columns of an entry in the record of deleted vouchers. */
export const DELETED_VOUCHER_COLUMNS = `${VOUCHER_COLUMNS.replace(/^id,/, "voucher_id AS id,")}, deletion_count, deleted_at::text AS deleted_at,
  deleted_by, deleted_by_kind, deleted_xact::text AS deleted_xact, id AS entry_id`;

/**
 * A row of an entry in the record of deleted vouchers: the row as it was,
 * under its own id, with its entry's id and its account's name at the
 * deletion.
 */
export interface DeletedVoucherRow extends Omit<VoucherRow, "voucher_id"> {
  readonly deleted_voucher_id: string;
  readonly account_description: string;
}

/** The columns of a row in the record of deleted vouchers. */
export const DELETED_ROW_COLUMNS = `${ROW_COLUMNS.replace(/^id,/, "row_id AS id,").replace("voucher_id,", "deleted_voucher_id,")}, account_description`;

/** The record of deleted vouchers of `company`, in the order they were deleted, read as `client`. */
export async function deletedVouchersOf(client: Client, company: string): Promise<DeletedVoucher[]> {
  return inTransaction(client, { company }, async () => {
    const found = await client.query<DeletedVoucher>(`SELECT ${DELETED_VOUCHER_COLUMNS} FROM ledger.deleted_vouchers ORDER BY deleted_at, number`);
    return found.rows;
  });
}

/** The rows of an entry in the record of deleted vouchers, by the entry's own id (entry_id), in their order, read as `client`. */
export async function deletedRowsOf(client: Client, company: string, entry: string): Promise<DeletedVoucherRow[]> {
  return inTransaction(client, { company }, async () => {
    const found = await client.query<DeletedVoucherRow>(
      `SELECT ${DELETED_ROW_COLUMNS} FROM ledger.deleted_voucher_rows WHERE deleted_voucher_id = $1 ORDER BY position`,
      [entry],
    );
    return found.rows;
  });
}

/** A company to book in, and its fiscal year. */
export interface Books {
  readonly company: string;
  readonly year: FiscalYear;
}

/**
 * Adds a fiscal year to book in: the accounts 1930, 3001 and 6110, and the
 * series A (manual), K (not manual) and I (manual, the closing series).
 */
export async function addBooksYear(client: Client, company: string, from: string, to: string, who: Actor = someUser()): Promise<FiscalYear> {
  const year = await addFiscalYear(client, company, { from, to }, who);
  await addAccount(client, company, year.id, { number: 1930, description: "Företagskonto" }, who);
  await addAccount(client, company, year.id, { number: 3001, description: "Försäljning inom Sverige" }, who);
  await addAccount(client, company, year.id, { number: 6110, description: "Kontorsmateriel" }, who);
  await addSeries(client, company, year.id, { code: "A", description: "Manuella verifikationer", manual: true }, who);
  await addSeries(client, company, year.id, { code: "K", description: "Kundfakturor", manual: false }, who);
  await addSeries(client, company, year.id, { code: "I", description: "Bokslut", manual: true, isClosing: true }, who);
  return year;
}

/** A new company with one fiscal year to book in, by default 2090, as addBooksYear makes it. */
export async function addBooks(client: Client, who: Actor = someUser(), from = "2090-01-01", to = "2090-12-31"): Promise<Books> {
  const company = await addCompany(client, who);
  const year = await addBooksYear(client, company, from, to, who);
  return { company, year };
}
