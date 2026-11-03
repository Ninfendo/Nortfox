// SPDX-License-Identifier: AGPL-3.0-only

// Fiscal years (rules 5 to 7 of the slice): each has a from and a to date, an
// accounting method and a chart name; an integer that is unique in its
// company and never changes; at most one default year per company; and the
// years of one company never overlap.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  EXCLUSION_VIOLATION,
  UNIQUE_VIOLATION,
  backendPid,
  begin,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  untilWaitingForLock,
  type TestDatabase,
} from "../../../test/database.ts";
import {
  FISCAL_YEAR_COLUMNS,
  addBooks,
  addCompany,
  addFiscalYear,
  balanced,
  bookVoucher,
  someUser,
  voucherOf,
  writeVoucher,
  type FiscalYear,
} from "../../../test/ledger.ts";

describe("fiscal years", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  const who = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs one statement as the app, in its own transaction in `company`. */
  async function asApp(company: string, sql: string, params: readonly unknown[] = []): Promise<FiscalYear[]> {
    return inTransaction(app, { company, ...who }, async () => (await app.query<FiscalYear>(sql, [...params])).rows);
  }

  it("holds the dates, the accounting method and the chart name, with no open or closed state", async () => {
    const company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31", method: "CASH", chart: "Bas 2090" });
    expect(year).toEqual({
      id: year.id,
      company_id: company,
      year_number: 1,
      from_date: "2090-01-01",
      to_date: "2090-12-31",
      accounting_method: "CASH",
      account_chart_type: "Bas 2090",
      is_default: false,
    });
    const columns = await app.query<{ name: string }>(
      "SELECT attname::text AS name FROM pg_catalog.pg_attribute WHERE attrelid = 'ledger.fiscal_years'::pg_catalog.regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
    );
    expect(columns.rows.map((row) => row.name)).toEqual([
      "id",
      "company_id",
      "year_number",
      "from_date",
      "to_date",
      "accounting_method",
      "account_chart_type",
      "is_default",
    ]);
  });

  it("refuses an accounting method other than ACCRUAL and CASH, and a to date before the from date", async () => {
    const company = await addCompany(app);
    await expectError(addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31", method: "OTHER" as "CASH" }), CHECK_VIOLATION);
    await expectError(addFiscalYear(app, company, { from: "2090-12-31", to: "2090-01-01" }), CHECK_VIOLATION);
    await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-01-01" });
  });

  it("numbers each company's years 1, 2, 3 in the order they are made, and another company's from 1 again", async () => {
    const first = await addCompany(app);
    const second = await addCompany(app);
    const numbers = [
      (await addFiscalYear(app, first, { from: "2091-01-01", to: "2091-12-31" })).year_number,
      (await addFiscalYear(app, first, { from: "2089-01-01", to: "2089-12-31" })).year_number,
      (await addFiscalYear(app, second, { from: "2091-01-01", to: "2091-12-31" })).year_number,
      (await addFiscalYear(app, first, { from: "2090-01-01", to: "2090-12-31" })).year_number,
    ];
    expect(numbers).toEqual([1, 2, 1, 3]);
  });

  it("gives two years made at the same time the next two numbers, one after the other", async () => {
    const company = await addCompany(app);
    const other = await db.connect("app");
    const otherPid = await backendPid(other);
    const insert = `INSERT INTO ledger.fiscal_years (company_id, from_date, to_date, accounting_method, account_chart_type)
                    VALUES ($1, $2, $3, 'ACCRUAL', 'Bas 2090') RETURNING year_number`;
    await begin(app, { company, ...who });
    await begin(other, { company, ...who });
    const firstNumber = (await app.query<{ year_number: number }>(insert, [company, "2090-01-01", "2090-12-31"])).rows[0]?.year_number;
    // The second waits on the company's row until the first commits, then counts it.
    const second = other.query<{ year_number: number }>(insert, [company, "2091-01-01", "2091-12-31"]);
    await untilWaitingForLock(app, otherPid);
    await app.query("COMMIT");
    const secondNumber = (await second).rows[0]?.year_number;
    await other.query("COMMIT");
    expect([firstNumber, secondNumber]).toEqual([1, 2]);
  });

  it("refuses a year number given on insert", async () => {
    const company = await addCompany(app);
    await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    for (const given of [1, 2]) {
      await expectRefusal(
        asApp(
          company,
          `INSERT INTO ledger.fiscal_years (company_id, year_number, from_date, to_date, accounting_method, account_chart_type)
           VALUES ($1, $2, '2091-01-01', '2091-12-31', 'ACCRUAL', 'Bas 2091')`,
          [company, given],
        ),
        "immutable_field",
        { field: "year_number", operation: "create" },
      );
    }
  });

  it("never changes a year's number or its id", async () => {
    const company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    for (const [set, field] of [
      ["year_number = 2", "year_number"],
      ["year_number = 9", "year_number"],
      [`id = '${randomUUID()}'`, "id"],
    ] as const) {
      await expectRefusal(asApp(company, `UPDATE ledger.fiscal_years SET ${set} WHERE id = $1`, [year.id]), "immutable_field", {
        field,
        operation: "update",
      });
    }
    const [kept] = await asApp(company, `SELECT ${FISCAL_YEAR_COLUMNS} FROM ledger.fiscal_years WHERE id = $1`, [year.id]);
    expect(kept?.year_number).toBe(1);
  });

  it("keeps the year number unique in its company even when the numbering trigger is off (as the owner)", async () => {
    const company = await addCompany(app);
    await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    await begin(owner, { company, ...who });
    try {
      await owner.query("ALTER TABLE ledger.fiscal_years DISABLE TRIGGER fiscal_years_rules");
      await expectError(
        owner.query(
          `INSERT INTO ledger.fiscal_years (company_id, year_number, from_date, to_date, accounting_method, account_chart_type)
           VALUES ($1, 1, '2091-01-01', '2091-12-31', 'ACCRUAL', 'Bas 2091')`,
          [company],
        ),
        UNIQUE_VIOLATION,
        /fiscal_years_year_number_unique/,
      );
    } finally {
      await owner.query("ROLLBACK");
    }
  });

  it("refuses two overlapping years of one company, also when they share one day, by insert and by a change", async () => {
    const company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    for (const [from, to] of [
      ["2090-07-01", "2091-06-30"],
      ["2089-07-01", "2090-06-30"],
      ["2090-03-01", "2090-03-31"],
      ["2089-01-01", "2091-12-31"],
      ["2090-12-31", "2091-12-30"],
      ["2089-01-02", "2090-01-01"],
    ] as const) {
      await expectError(addFiscalYear(app, company, { from, to }), EXCLUSION_VIOLATION, /fiscal_years_no_overlap/);
    }
    // The day after the year's last day is free, and so is the day before its first.
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    await addFiscalYear(app, company, { from: "2089-01-01", to: "2089-12-31" });
    await expectError(
      asApp(company, "UPDATE ledger.fiscal_years SET from_date = '2090-12-31' WHERE id = $1", [next.id]),
      EXCLUSION_VIOLATION,
      /fiscal_years_no_overlap/,
    );
    await expectError(
      asApp(company, "UPDATE ledger.fiscal_years SET to_date = '2091-01-01' WHERE id = $1", [year.id]),
      EXCLUSION_VIOLATION,
      /fiscal_years_no_overlap/,
    );
  });

  it("lets another company have a year on the same dates", async () => {
    const first = await addCompany(app);
    const second = await addCompany(app);
    await addFiscalYear(app, first, { from: "2090-01-01", to: "2090-12-31" });
    expect((await addFiscalYear(app, second, { from: "2090-01-01", to: "2090-12-31" })).company_id).toBe(second);
  });

  it("refuses a second default year in one company, by insert and by a change, and lets the default move", async () => {
    const company = await addCompany(app);
    const other = await addCompany(app);
    const first = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31", isDefault: true });
    const second = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    await expectError(addFiscalYear(app, company, { from: "2092-01-01", to: "2092-12-31", isDefault: true }), UNIQUE_VIOLATION, /fiscal_years_one_default/);
    await expectError(
      asApp(company, "UPDATE ledger.fiscal_years SET is_default = true WHERE id = $1", [second.id]),
      UNIQUE_VIOLATION,
      /fiscal_years_one_default/,
    );
    // Another company's default year is its own.
    expect((await addFiscalYear(app, other, { from: "2090-01-01", to: "2090-12-31", isDefault: true })).is_default).toBe(true);
    // The default moves when the old one gives it up first.
    await inTransaction(app, { company, ...who }, async () => {
      await app.query("UPDATE ledger.fiscal_years SET is_default = false WHERE id = $1", [first.id]);
      await app.query("UPDATE ledger.fiscal_years SET is_default = true WHERE id = $1", [second.id]);
    });
    const defaults = await asApp(company, `SELECT ${FISCAL_YEAR_COLUMNS} FROM ledger.fiscal_years WHERE is_default`);
    expect(defaults.map((row) => row.id)).toEqual([second.id]);
  });

  it("lets the app change a year's dates, method and chart name, but never delete a year", async () => {
    const company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    const [changed] = await asApp(
      company,
      `UPDATE ledger.fiscal_years SET to_date = '2091-06-30', accounting_method = 'CASH', account_chart_type = 'Bas 2091'
       WHERE id = $1 RETURNING ${FISCAL_YEAR_COLUMNS}`,
      [year.id],
    );
    expect(changed).toEqual({ ...year, to_date: "2091-06-30", accounting_method: "CASH", account_chart_type: "Bas 2091" });
    await expectError(asApp(company, "DELETE FROM ledger.fiscal_years WHERE id = $1", [year.id]), "42501", /permission denied/);
  });

  describe("with vouchers (rule 9: a voucher's date stays inside its own year)", () => {
    it("refuses new dates that would leave any of the year's vouchers outside it, with the count", async () => {
      const books = await addBooks(app, who);
      for (const date of ["2090-01-01", "2090-06-15", "2090-12-31"]) {
        await bookVoucher(app, books.company, { year: books.year.id, series: "A", date, rows: balanced() }, who);
      }
      for (const [set, count] of [
        ["to_date = '2090-12-30'", 1],
        ["from_date = '2090-01-02'", 1],
        ["from_date = '2090-06-16'", 2],
        ["from_date = '2091-01-01', to_date = '2091-12-31'", 3],
      ] as const) {
        await expectRefusal(asApp(books.company, `UPDATE ledger.fiscal_years SET ${set} WHERE id = $1`, [books.year.id]), "fiscal_year_strands_rows", {
          table: "ledger.vouchers",
          count,
        });
      }
      // New dates that keep every voucher inside are accepted.
      await asApp(books.company, "UPDATE ledger.fiscal_years SET from_date = '2089-07-01', to_date = '2091-06-30' WHERE id = $1", [books.year.id]);
    });

    it("holds when a voucher is booked and the year's dates change at the same time: the year waits for the booking, and its change is refused", async () => {
      const books = await addBooks(app, who);
      const other = await db.connect("app");
      const otherPid = await backendPid(other);
      await begin(app, { company: books.company, ...who });
      await writeVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-12-15", rows: balanced() });
      await begin(other, { company: books.company, ...who });
      const shrunk = expectRefusal(
        other.query("UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1", [books.year.id]),
        "fiscal_year_strands_rows",
        { table: "ledger.vouchers", count: 1 },
      );
      await untilWaitingForLock(app, otherPid);
      await app.query("COMMIT");
      await shrunk;
      await other.query("ROLLBACK");
    });

    it("holds when the year's dates change and a voucher is booked at the same time: the booking waits for the year, and is refused outside it", async () => {
      const books = await addBooks(app, who);
      const other = await db.connect("app");
      const otherPid = await backendPid(other);
      await begin(app, { company: books.company, ...who });
      await app.query("UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1", [books.year.id]);
      await begin(other, { company: books.company, ...who });
      const booked = expectRefusal(
        writeVoucher(other, books.company, { year: books.year.id, series: "A", date: "2090-12-15", rows: balanced() }),
        "no_fiscal_year",
        { date: "2090-12-15" },
      );
      await untilWaitingForLock(app, otherPid);
      await app.query("COMMIT");
      await booked;
      await other.query("ROLLBACK");
    });

    // A change of a voucher's date locks its year's row first in
    // ledger.assert_in_own_year, before it reads the year's dates. Nothing
    // else in that change locks the year before the check.
    it.each([
      { cut: "to_date = '2090-11-30'", moved: "2090-12-15" },
      { cut: "from_date = '2090-02-01'", moved: "2090-01-15" },
    ])(
      "holds when the year's dates change ($cut) and a voucher's date changes at the same time: the change waits for the year, and is refused outside it",
      async ({ cut, moved }) => {
        const books = await addBooks(app, who);
        const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced() }, who);
        const other = await db.connect("app");
        const otherPid = await backendPid(other);
        await begin(app, { company: books.company, ...who });
        await app.query(`UPDATE ledger.fiscal_years SET ${cut} WHERE id = $1`, [books.year.id]);
        await begin(other, { company: books.company, ...who });
        const changed = expectRefusal(
          other.query("UPDATE ledger.vouchers SET transaction_date = $2 WHERE id = $1", [voucher.id, moved]),
          "no_fiscal_year",
          { date: moved },
        );
        await untilWaitingForLock(app, otherPid);
        await app.query("COMMIT");
        await changed;
        await other.query("ROLLBACK");
        expect((await voucherOf(app, books.company, voucher.id))?.transaction_date).toBe("2090-03-15");
      },
    );
  });
});
