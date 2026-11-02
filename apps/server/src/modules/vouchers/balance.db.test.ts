// SPDX-License-Identifier: AGPL-3.0-only

// The balance (rule 23 of the slice): debit equals credit over the rows that
// are not struck, checked at commit. A row's debit and its credit each count
// on their own side, also when one row holds both (rule 22). Between two
// statements a voucher may be out of balance. A struck row counts in no
// balance. The two sums in the refusal are öre, as strings.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, begin, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addBooks, balanced, bookVoucher, nextNumberOf, rowsOf, someUser, writeRow, writeVoucher, type Books, type NewRow } from "../../../test/ledger.ts";

describe("the balance of a voucher", () => {
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

  function voucher(books: Books, rows: NewRow[]) {
    return { year: books.year.id, series: "A", date: "2090-03-15", rows };
  }

  it("refuses at commit a voucher whose debit and credit differ, with both sums in öre, and uses no number", async () => {
    const books = await addBooks(app);
    await expectRefusal(
      bookVoucher(app, books.company, voucher(books, [{ account: 6110, debit: 2000n }, { account: 1930, credit: 1999n }]), who),
      "unbalanced",
      { debit: "2000", credit: "1999" },
    );
    await expectRefusal(
      bookVoucher(
        app,
        books.company,
        voucher(books, [
          { account: 6110, debit: 1000n },
          { account: 6110, credit: 300n },
          { account: 1930, credit: 1000n },
        ]),
        who,
      ),
      "unbalanced",
      { debit: "1000", credit: "1300" },
    );
    const big = 9_007_199_254_740_993n;
    await expectRefusal(
      bookVoucher(app, books.company, voucher(books, [{ account: 6110, debit: big }, { account: 1930, credit: big - 1n }]), who),
      "unbalanced",
      { debit: "9007199254740993", credit: "9007199254740992" },
    );
    // A row that holds both sides counts its debit as debit and its credit as credit.
    await expectRefusal(
      bookVoucher(app, books.company, voucher(books, [{ account: 6110, debit: 1000n, credit: 300n }, { account: 1930, credit: 1000n }]), who),
      "unbalanced",
      { debit: "1000", credit: "1300" },
    );
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
  });

  it("balances a row that holds both a debit and a credit on debit minus credit, and keeps both sides as sent", async () => {
    const books = await addBooks(app);
    const booked = await bookVoucher(
      app,
      books.company,
      voucher(books, [
        { account: 6110, debit: 1000n, credit: 400n },
        { account: 1930, credit: 600n },
      ]),
      who,
    );
    expect((await rowsOf(app, books.company, booked.id)).map((row) => [row.debit, row.credit])).toEqual([
      [1000n, 400n],
      [0n, 600n],
    ]);
  });

  it("accepts a voucher that is out of balance between two statements and balances at commit", async () => {
    const books = await addBooks(app);
    const booked = await inTransaction(app, { company: books.company, ...who }, async () => {
      const head = await writeVoucher(app, books.company, voucher(books, [{ account: 6110, debit: 2000n }]));
      // Here it is out of balance, and has one row.
      const sums = await app.query<{ sum: bigint }>("SELECT (sum(debit) - sum(credit))::bigint AS sum FROM ledger.voucher_rows WHERE voucher_id = $1", [
        head.id,
      ]);
      expect(sums.rows[0]?.sum).toBe(2000n);
      await writeRow(app, books.company, head.id, { account: 1930, credit: 1500n });
      await writeRow(app, books.company, head.id, { account: 1930, credit: 500n });
      return head;
    });
    expect((await rowsOf(app, books.company, booked.id)).map((row) => [row.debit, row.credit])).toEqual([
      [2000n, 0n],
      [0n, 1500n],
      [0n, 500n],
    ]);
  });

  it("accepts a voucher of zero rows that balance at 0", async () => {
    const books = await addBooks(app);
    const booked = await bookVoucher(app, books.company, voucher(books, [{ account: 6110 }, { account: 1930 }]), who);
    expect(booked.number).toBe(1);
  });

  it("counts a struck row in no balance: striking one side alone is refused, striking it with a new row in its place is accepted", async () => {
    const books = await addBooks(app);
    const booked = await bookVoucher(app, books.company, voucher(books, balanced(2000n)), who);
    const [debit] = await rowsOf(app, books.company, booked.id);
    await expectRefusal(
      inTransaction(app, { company: books.company, ...who }, () =>
        app.query("UPDATE ledger.voucher_rows SET removed = true WHERE id = $1", [debit?.id]),
      ),
      "unbalanced",
      { debit: "0", credit: "2000" },
    );
    expect((await rowsOf(app, books.company, booked.id)).map((row) => row.removed)).toEqual([false, false]);
    await inTransaction(app, { company: books.company, ...who }, async () => {
      await app.query("UPDATE ledger.voucher_rows SET removed = true WHERE id = $1", [debit?.id]);
      await writeRow(app, books.company, booked.id, { account: 6110, debit: 2000n, text: "Rätt konto" });
    });
    const rows = await rowsOf(app, books.company, booked.id);
    expect(rows.map((row) => [row.debit, row.credit, row.removed])).toEqual([
      [2000n, 0n, true],
      [0n, 2000n, false],
      [2000n, 0n, false],
    ]);
    // An added row that is out of balance is refused at commit, struck rows still left out of the sums.
    await expectRefusal(
      inTransaction(app, { company: books.company, ...who }, () => writeRow(app, books.company, booked.id, { account: 6110, debit: 5n })),
      "unbalanced",
      { debit: "2005", credit: "2000" },
    );
  });

  it("checks the balance at once when the transaction asks for it with SET CONSTRAINTS", async () => {
    const books = await addBooks(app);
    await begin(app, { company: books.company, ...who });
    try {
      await writeVoucher(app, books.company, voucher(books, [{ account: 6110, debit: 1n }, { account: 1930, credit: 2n }]));
      await expectRefusal(app.query("SET CONSTRAINTS ALL IMMEDIATE"), "unbalanced", { debit: "1", credit: "2" });
    } finally {
      await app.query("ROLLBACK");
    }
  });

  it("refuses a transaction that changes its company after booking, since the checks at commit read the voucher's own company", async () => {
    const books = await addBooks(app);
    const other = await addBooks(app);
    for (const company of [other.company, ""]) {
      await expectError(
        inTransaction(app, { company: books.company, ...who }, async () => {
          await writeVoucher(app, books.company, voucher(books, [{ account: 6110, debit: 1n }, { account: 1930, credit: 2n }]));
          await app.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [company]);
        }),
        INSUFFICIENT_PRIVILEGE,
        /The transaction's company changed while its vouchers were written/,
      );
    }
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
  });

  describe("keeps one company per transaction, so no check reads another company's rows", () => {
    const CHANGED = /The transaction's company changed while its vouchers were written/;

    it("at commit, after a voucher with no rows, which only the row count checks", async () => {
      const books = await addBooks(app);
      const other = await addBooks(app);
      await expectError(
        inTransaction(app, { company: books.company, ...who }, async () => {
          await writeVoucher(app, books.company, voucher(books, []));
          await app.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [other.company]);
        }),
        INSUFFICIENT_PRIVILEGE,
        CHANGED,
      );
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    });

    it("at commit, after an added row out of balance, which only the balance checks", async () => {
      const books = await addBooks(app);
      const other = await addBooks(app);
      const booked = await bookVoucher(app, books.company, voucher(books, balanced(2000n)), who);
      await expectError(
        inTransaction(app, { company: books.company, ...who }, async () => {
          await writeRow(app, books.company, booked.id, { account: 6110, debit: 7n });
          await app.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [other.company]);
        }),
        INSUFFICIENT_PRIVILEGE,
        CHANGED,
      );
      expect((await rowsOf(app, books.company, booked.id)).length).toBe(2);
    });

    /** Runs `sql` as the owner with the history trigger of `table` off, in a transaction that is rolled back. */
    async function withoutHistory(company: string, table: string, sql: string, params: readonly unknown[]): Promise<void> {
      await begin(owner, { company, ...who });
      try {
        await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER audit_history`);
        await owner.query(sql, [...params]);
      } finally {
        await owner.query("ROLLBACK");
      }
    }

    const TWO_COMPANIES_BOOKED = `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
      SELECT CASE WHEN n = 1 THEN $1::uuid ELSE pg_catalog.set_config('nortfox.company_id', $3, true)::uuid END,
        CASE WHEN n = 1 THEN $2::uuid ELSE $4::uuid END, 'A', 'Kontorsmaterial', '2090-03-15', 'MANUAL'
      FROM pg_catalog.generate_series(1, 2) AS n`;

    it("in a statement that changes the company between the vouchers it books: the history refuses it, and without the history the counter's move does", async () => {
      const books = await addBooks(app);
      const other = await addBooks(app);
      const params = [books.company, books.year.id, other.company, other.year.id];
      await expectError(
        inTransaction(app, { company: books.company, ...who }, () => app.query(TWO_COMPANIES_BOOKED, params)),
        INSUFFICIENT_PRIVILEGE,
        /new row violates row-level security policy for table "history"/,
      );
      await expectError(withoutHistory(books.company, "ledger.vouchers", TWO_COMPANIES_BOOKED, params), INSUFFICIENT_PRIVILEGE, CHANGED);
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
      expect(await nextNumberOf(app, other.company, other.year.id, "A")).toBe(1);
    });

    const TWO_COMPANIES_ADDED = `INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, debit)
      SELECT CASE WHEN n = 1 THEN $1::uuid ELSE pg_catalog.set_config('nortfox.company_id', $3, true)::uuid END,
        CASE WHEN n = 1 THEN $2::uuid ELSE $4::uuid END, 3001, 0
      FROM pg_catalog.generate_series(1, 2) AS n`;

    it("in a statement that changes the company while it adds rows: the history refuses it, and without the history the voucher's touch does", async () => {
      const books = await addBooks(app);
      const other = await addBooks(app);
      const ours = await bookVoucher(app, books.company, voucher(books, balanced(2000n)), who);
      const theirs = await bookVoucher(app, other.company, voucher(other, balanced(2000n)), who);
      const params = [books.company, ours.id, other.company, theirs.id];
      await expectError(
        inTransaction(app, { company: books.company, ...who }, () => app.query(TWO_COMPANIES_ADDED, params)),
        INSUFFICIENT_PRIVILEGE,
        /new row violates row-level security policy for table "history"/,
      );
      await expectError(withoutHistory(books.company, "ledger.voucher_rows", TWO_COMPANIES_ADDED, params), INSUFFICIENT_PRIVILEGE, CHANGED);
      expect((await rowsOf(app, books.company, ours.id)).length).toBe(2);
    });

    it("in a deletion whose condition changes the company: one that reads no column hides the row, one that reads a column is refused", async () => {
      const books = await addBooks(app);
      const other = await addBooks(app);
      const ours = await bookVoucher(app, books.company, voucher(books, balanced(2000n)), who);
      const deleted = await inTransaction(app, { company: books.company, ...who }, async () =>
        (await app.query("DELETE FROM ledger.vouchers WHERE id = $1 AND pg_catalog.set_config('nortfox.company_id', $2, true) IS NOT NULL", [ours.id, other.company]))
          .rowCount,
      );
      expect(deleted).toBe(0);
      await expectError(
        inTransaction(app, { company: books.company, ...who }, () =>
          app.query(
            "DELETE FROM ledger.vouchers WHERE id = $1 AND pg_catalog.set_config('nortfox.company_id', CASE WHEN company_id IS NOT NULL THEN $2 END, true) IS NOT NULL",
            [ours.id, other.company],
          ),
        ),
        INSUFFICIENT_PRIVILEGE,
        CHANGED,
      );
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(2);
    });
  });
});
