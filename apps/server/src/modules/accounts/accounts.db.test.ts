// SPDX-License-Identifier: AGPL-3.0-only

// Accounts (rules 10, 12 and 24 of the slice): each belongs to a fiscal year,
// with a number that never changes, a name and an active flag. Every accepted
// change moves its modified time, and a refused one moves nothing. An unused
// account can be removed, and the behandlingshistorik keeps its last state.
// One that holds rows cannot, with the number of vouchers that hold them.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNIQUE_VIOLATION, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  ACCOUNT_COLUMNS,
  addAccount,
  addBooks,
  addCompany,
  addFiscalYear,
  balanced,
  bookVoucher,
  isAfter,
  someUser,
  writeRow,
  type Account,
} from "../../../test/ledger.ts";

/** PostgreSQL's SQLSTATEs for a foreign key and a NOT NULL column that refused a row. */
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";

describe("accounts", () => {
  let db: TestDatabase;
  let app: Client;
  const who = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs one statement as the app, in its own transaction in `company`. */
  async function asApp(company: string, sql: string, params: readonly unknown[] = []): Promise<Account[]> {
    return inTransaction(app, { company, ...who }, async () => (await app.query<Account>(sql, [...params])).rows);
  }

  async function accountOf(company: string, id: string): Promise<Account | undefined> {
    const [found] = await asApp(company, `SELECT ${ACCOUNT_COLUMNS} FROM ledger.accounts WHERE id = $1`, [id]);
    return found;
  }

  /** A company with one fiscal year, 2090. */
  async function companyWithYear(): Promise<{ company: string; year: string }> {
    const company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    return { company, year: year.id };
  }

  it("holds an account's number, name and active flag in its fiscal year, active unless told otherwise, with a modified time", async () => {
    const { company, year } = await companyWithYear();
    const { account, started, ended } = await inTransaction(app, { company, ...who }, async () => {
      const inserted = await app.query<Account & { started: string; ended: string }>(
        `INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description) VALUES ($1, $2, 1930, 'Företagskonto')
         RETURNING ${ACCOUNT_COLUMNS}, pg_catalog.transaction_timestamp()::text AS started, pg_catalog.clock_timestamp()::text AS ended`,
        [company, year],
      );
      const [row] = inserted.rows;
      return { account: row, started: row?.started ?? "", ended: row?.ended ?? "" };
    });
    expect(account).toEqual({
      id: account?.id,
      company_id: company,
      fiscal_year_id: year,
      number: 1930,
      description: "Företagskonto",
      active: true,
      modified_at: account?.modified_at,
      started,
      ended,
    });
    // The modified time is the time of the insert.
    expect(await isAfter(app, account?.modified_at ?? "", started)).toBe(true);
    expect(await isAfter(app, account?.modified_at ?? "", ended)).toBe(false);
    expect((await addAccount(app, company, year, { number: 6110, description: "Kontorsmateriel", active: false })).active).toBe(false);
    const columns = await app.query<{ name: string }>(
      "SELECT attname::text AS name FROM pg_catalog.pg_attribute WHERE attrelid = 'ledger.accounts'::pg_catalog.regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
    );
    expect(columns.rows.map((row) => row.name)).toEqual(["id", "company_id", "fiscal_year_id", "number", "description", "active", "modified_at"]);
  });

  it("refuses the same number twice in one year, and lets another year and another company have it", async () => {
    const { company, year } = await companyWithYear();
    await addAccount(app, company, year, { number: 1930 });
    await expectError(addAccount(app, company, year, { number: 1930 }), UNIQUE_VIOLATION, /accounts_number_unique/);
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    expect((await addAccount(app, company, next.id, { number: 1930 })).fiscal_year_id).toBe(next.id);
    const other = await companyWithYear();
    expect((await addAccount(app, other.company, other.year, { number: 1930 })).company_id).toBe(other.company);
  });

  it("refuses an account in a fiscal year of another company", async () => {
    const { year } = await companyWithYear();
    const other = await addCompany(app);
    await expectError(addAccount(app, other, year, { number: 1930 }), FOREIGN_KEY_VIOLATION, /accounts_fiscal_year/);
  });

  it("never changes an account's number, its fiscal year or its id", async () => {
    const { company, year } = await companyWithYear();
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    const account = await addAccount(app, company, year, { number: 1930 });
    for (const [set, field] of [
      ["number = 1931", "number"],
      ["fiscal_year_id = $2", "fiscal_year_id"],
      [`id = '${randomUUID()}'`, "id"],
    ] as const) {
      await expectRefusal(
        asApp(company, `UPDATE ledger.accounts SET ${set} WHERE id = $1`, set.includes("$2") ? [account.id, next.id] : [account.id]),
        "immutable_field",
        { field, operation: "update" },
      );
    }
    expect(await accountOf(company, account.id)).toEqual(account);
  });

  it("takes the modified time from the database: one given on insert, or written by an update, is refused", async () => {
    const { company, year } = await companyWithYear();
    await expectRefusal(
      asApp(
        company,
        "INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description, modified_at) VALUES ($1, $2, 1930, 'Kassa', '2090-01-01')",
        [company, year],
      ),
      "immutable_field",
      { field: "modified_at", operation: "create" },
    );
    const account = await addAccount(app, company, year, { number: 1930 });
    await expectRefusal(asApp(company, "UPDATE ledger.accounts SET modified_at = '2090-01-01' WHERE id = $1", [account.id]), "internal_only", {
      table: "ledger.accounts",
      field: "modified_at",
    });
    expect(await accountOf(company, account.id)).toEqual(account);
  });

  it("moves the modified time with every accepted change, and with no refused one", async () => {
    const { company, year } = await companyWithYear();
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    let account = await addAccount(app, company, year, { number: 1930, description: "Kassa" });
    for (const set of ["description = 'Företagskonto'", "active = false", "active = true, description = 'Bankkonto'"]) {
      const [changed] = await asApp(company, `UPDATE ledger.accounts SET ${set} WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`, [account.id]);
      expect(await isAfter(app, changed?.modified_at ?? "", account.modified_at), set).toBe(true);
      account = changed ?? account;
    }
    expect(account).toMatchObject({ description: "Bankkonto", active: true });
    // Refused changes, each by another rule: none moves the modified time.
    await expectRefusal(asApp(company, "UPDATE ledger.accounts SET description = 'Kassa', number = 1910 WHERE id = $1", [account.id]), "immutable_field");
    await expectRefusal(
      asApp(company, "UPDATE ledger.accounts SET description = 'Kassa', fiscal_year_id = $2 WHERE id = $1", [account.id, next.id]),
      "immutable_field",
    );
    await expectRefusal(asApp(company, "UPDATE ledger.accounts SET modified_at = pg_catalog.clock_timestamp() WHERE id = $1", [account.id]), "internal_only");
    await expectError(asApp(company, "UPDATE ledger.accounts SET description = NULL WHERE id = $1", [account.id]), NOT_NULL_VIOLATION);
    await addAccount(app, company, year, { number: 1910 });
    await expectError(
      inTransaction(app, { company, ...who }, async () => {
        await app.query("UPDATE ledger.accounts SET description = 'Kassa' WHERE id = $1", [account.id]);
        await app.query("INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description) VALUES ($1, $2, 1910, 'Kassa')", [company, year]);
      }),
      UNIQUE_VIOLATION,
    );
    expect(await accountOf(company, account.id)).toEqual(account);
  });

  it("lets an unused account be removed, and keeps its last state in the behandlingshistorik", async () => {
    const { company, year } = await companyWithYear();
    const account = await addAccount(app, company, year, { number: 3990, description: "Övriga ersättningar och intäkter" });
    await asApp(company, "UPDATE ledger.accounts SET active = false WHERE id = $1", [account.id]);
    const remover = someUser();
    const { last, transaction } = await inTransaction(app, { company, ...remover }, async () => {
      const before = await app.query<{ row: unknown }>("SELECT pg_catalog.to_jsonb(t) AS row FROM ledger.accounts AS t WHERE t.id = $1", [account.id]);
      const removed = await app.query("DELETE FROM ledger.accounts WHERE id = $1", [account.id]);
      expect(removed.rowCount).toBe(1);
      const stamp = await app.query<{ transaction: string }>("SELECT pg_catalog.pg_current_xact_id()::text AS transaction");
      return { last: before.rows[0]?.row, transaction: stamp.rows[0]?.transaction };
    });
    expect(await accountOf(company, account.id)).toBeUndefined();
    const history = await inTransaction(app, { company }, async () =>
      app.query<{ operation: string; old_values: unknown; new_values: unknown; actor_id: string; actor_kind: string; transaction: string }>(
        `SELECT operation, old_values, new_values, actor_id, actor_kind, transaction_id::text AS transaction
         FROM audit.history WHERE table_name = 'ledger.accounts' AND row_id = $1 ORDER BY id`,
        [account.id],
      ),
    );
    expect(history.rows.map((row) => row.operation)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect(history.rows[2]).toEqual({
      operation: "DELETE",
      old_values: last,
      new_values: null,
      actor_id: remover.actor,
      actor_kind: "user",
      transaction,
    });
    expect(last).toMatchObject({ number: 3990, description: "Övriga ersättningar och intäkter", active: false });
  });

  it("refuses to remove an account that holds rows, with its number and the count of vouchers, struck rows included", async () => {
    const books = await addBooks(app, who);
    const { company } = books;
    const year = books.year.id;
    const voucher = { year, series: "A", date: "2090-03-15" };
    // Two vouchers hold rows on 6110, one of them two rows; a third holds 6110 only on a row that is struck.
    await bookVoucher(app, company, { ...voucher, rows: balanced(2000n, 6110, 1930) }, who);
    await bookVoucher(app, company, { ...voucher, rows: [{ account: 6110, debit: 100n }, { account: 6110, debit: 100n }, { account: 1930, credit: 200n }] }, who);
    const struck = await bookVoucher(app, company, { ...voucher, rows: balanced(300n, 6110, 1930) }, who);
    await inTransaction(app, { company, ...who }, async () => {
      await app.query("UPDATE ledger.voucher_rows SET removed = true WHERE voucher_id = $1 AND account_number = 6110", [struck.id]);
      await writeRow(app, company, struck.id, { account: 3001, debit: 300n });
    });
    const remove = (number: number) => asApp(company, "DELETE FROM ledger.accounts WHERE fiscal_year_id = $1 AND number = $2", [year, number]);
    await expectRefusal(remove(6110), "account_has_rows", { number: 6110, count: 3 });
    await expectRefusal(remove(1930), "account_has_rows", { number: 1930, count: 3 });
    await expectRefusal(remove(3001), "account_has_rows", { number: 3001, count: 1 });
    // A voucher that is deleted holds no rows any more: its account can go.
    await addAccount(app, company, year, { number: 2440, description: "Leverantörsskulder" });
    const deleted = await bookVoucher(app, company, { ...voucher, rows: balanced(500n, 6110, 2440) }, who);
    await expectRefusal(remove(2440), "account_has_rows", { number: 2440, count: 1 });
    await asApp(company, "DELETE FROM ledger.vouchers WHERE id = $1", [deleted.id]);
    await remove(2440);
    const left = await asApp(company, `SELECT ${ACCOUNT_COLUMNS} FROM ledger.accounts ORDER BY number`);
    expect(left.map((account) => account.number)).toEqual([1930, 3001, 6110]);
  });

  it("counts only the rows of the account's own fiscal year", async () => {
    const books = await addBooks(app, who);
    const next = await addFiscalYear(app, books.company, { from: "2091-01-01", to: "2091-12-31" }, who);
    const nextAccount = await addAccount(app, books.company, next.id, { number: 6110 });
    await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n, 6110, 1930) }, who);
    await asApp(books.company, "DELETE FROM ledger.accounts WHERE id = $1", [nextAccount.id]);
    expect(await accountOf(books.company, nextAccount.id)).toBeUndefined();
  });
});
