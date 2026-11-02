// SPDX-License-Identifier: AGPL-3.0-only

// Booking a voucher (rules 9, 11, 17, 20 to 22 and 24 of the slice): Bokför
// gives the voucher its number at once, in the same transaction. The voucher
// has a description of 1 to 200 characters, a date inside its own fiscal
// year, a series, comments of at most 1000 characters, one of seven reference
// types, a reference number and at least two rows. A row has an account of
// the voucher's year that is active, one signed amount in öre, a text of at
// most 100 characters and a quantity. A refused voucher uses no number.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_VIOLATION, begin, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  INSERT_VOUCHER,
  REFERENCE_TYPES,
  ROW_COLUMNS,
  VOUCHER_COLUMNS,
  addAccount,
  addBooks,
  addBooksYear,
  addSeries,
  balanced,
  bookVoucher,
  isAfter,
  nextNumberOf,
  rowsOf,
  someUser,
  writeRow,
  writeVoucher,
  type Books,
  type NewVoucher,
  type Voucher,
  type VoucherRow,
} from "../../../test/ledger.ts";

describe("booking a voucher", () => {
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

  /** A voucher in series A of the books' year, dated 2090-03-15, with two rows that balance. */
  function aVoucher(books: Books, changes: Partial<NewVoucher> = {}): NewVoucher {
    return { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(), ...changes };
  }

  async function book(books: Books, changes: Partial<NewVoucher> = {}): Promise<Voucher> {
    return bookVoucher(app, books.company, aVoucher(books, changes), who);
  }

  it("gives the voucher its number at once, and keeps every field, its rows in order, and who booked it and when", async () => {
    const books = await addBooks(app);
    const { voucher, rows, started, ended } = await inTransaction(app, { company: books.company, ...who }, async () => {
      const booked = await writeVoucher(app, books.company, {
        year: books.year.id,
        series: "A",
        date: "2090-03-15",
        description: "Kontorsmaterial",
        comments: "Kvitto i pärmen",
        referenceType: "MANUAL",
        referenceNumber: "K-17",
        rows: [
          { account: 6110, amount: 1600n, text: "Pennor" },
          { account: 6110, amount: 400n, text: "Papper" },
          { account: 1930, amount: -2000n },
        ],
      });
      const stamps = await app.query<{ started: string; ended: string }>(
        "SELECT pg_catalog.transaction_timestamp()::text AS started, pg_catalog.clock_timestamp()::text AS ended",
      );
      // The number is there inside the booking's own transaction.
      expect(booked.number).toBe(1);
      return { voucher: booked, rows: await rowsOf(app, books.company, booked.id), started: stamps.rows[0]?.started ?? "", ended: stamps.rows[0]?.ended ?? "" };
    });
    expect(voucher).toEqual({
      id: voucher.id,
      company_id: books.company,
      fiscal_year_id: books.year.id,
      series_code: "A",
      number: 1,
      description: "Kontorsmaterial",
      comments: "Kvitto i pärmen",
      transaction_date: "2090-03-15",
      reference_type: "MANUAL",
      reference_number: "K-17",
      reverses_voucher_id: null,
      created_at: voucher.created_at,
      created_by: who.actor,
      created_by_kind: "user",
      created_xact: voucher.created_xact,
      modified_at: voucher.created_at,
      altered_at: null,
      altered_by: null,
      altered_by_kind: null,
    });
    expect(await isAfter(app, voucher.created_at, started)).toBe(true);
    expect(await isAfter(app, voucher.created_at, ended)).toBe(false);
    expect(rows.map((row) => [row.position, row.account_number, row.amount, row.transaction_information])).toEqual([
      [1, 6110, 1600n, "Pennor"],
      [2, 6110, 400n, "Papper"],
      [3, 1930, -2000n, ""],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        company_id: books.company,
        voucher_id: voucher.id,
        fiscal_year_id: books.year.id,
        quantity: "0",
        removed: false,
        removed_at: null,
        removed_by: null,
        removed_by_kind: null,
        created_by: who.actor,
        created_by_kind: "user",
      });
      expect(await isAfter(app, row.created_at, voucher.created_at)).toBe(true);
    }
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(2);
  });

  it("stores one signed amount in öre as a bigint, debit positive and credit negative, beyond 2^53 too, and accepts a zero row", async () => {
    const books = await addBooks(app);
    const big = 9_007_199_254_740_993n;
    const voucher = await book(books, {
      rows: [
        { account: 6110, amount: big },
        { account: 1930, amount: -big },
        { account: 3001, amount: 0n },
      ],
    });
    const rows = await rowsOf(app, books.company, voucher.id);
    expect(rows.map((row) => row.amount)).toEqual([big, -big, 0n]);
    expect(typeof rows[0]?.amount).toBe("bigint");
    const type = await app.query<{ type: string }>(
      "SELECT pg_catalog.format_type(atttypid, atttypmod) AS type FROM pg_catalog.pg_attribute WHERE attrelid = 'ledger.voucher_rows'::pg_catalog.regclass AND attname = 'amount'",
    );
    expect(type.rows[0]?.type).toBe("bigint");
  });

  it("keeps a row's quantity as given, 1.23456 and -1.5, and makes it 0 when none is given", async () => {
    const books = await addBooks(app);
    const voucher = await book(books, {
      rows: [
        { account: 6110, amount: 2000n, quantity: "1.23456" },
        { account: 1930, amount: -2000n, quantity: "-1.5" },
        { account: 3001, amount: 0n },
      ],
    });
    expect((await rowsOf(app, books.company, voucher.id)).map((row) => row.quantity)).toEqual(["1.23456", "-1.5", "0"]);
  });

  it("numbers the vouchers of a statement that books several of them one after the other", async () => {
    const books = await addBooks(app);
    const numbers = await inTransaction(app, { company: books.company, ...who }, async () => {
      const found = await app.query<{ id: string; number: number }>(
        `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
         SELECT $1, $2, 'A', 'Kontorsmaterial ' || n, '2090-03-15', 'MANUAL' FROM pg_catalog.generate_series(1, 3) AS n
         RETURNING id, number`,
        [books.company, books.year.id],
      );
      for (const voucher of found.rows) {
        for (const row of balanced()) {
          await writeRow(app, books.company, voucher.id, row);
        }
      }
      return found.rows.map((row) => row.number);
    });
    expect([...numbers].sort()).toEqual([1, 2, 3]);
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(4);
  });

  describe("refuses, each with its reason, and uses no number", () => {
    it("a voucher with one row or none, at commit, with the count", async () => {
      const books = await addBooks(app);
      await expectRefusal(book(books, { rows: [{ account: 6110, amount: 0n }] }), "too_few_rows", { count: 1 });
      await expectRefusal(book(books, { rows: [] }), "too_few_rows", { count: 0 });
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    });

    it("an empty description, and one of 201 characters, and accepts one of 200 and a text of spaces", async () => {
      const books = await addBooks(app);
      await expectRefusal(book(books, { description: "" }), "description_missing", {});
      const long = "B".repeat(201);
      await expectRefusal(book(books, { description: long }), "value_too_long", { field: "description", value: long });
      // Counted in characters, not bytes.
      expect((await book(books, { description: "Å".repeat(200) })).description).toBe("Å".repeat(200));
      expect((await book(books, { description: "   " })).description).toBe("   ");
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(3);
    });

    it("a NULL description as a missing one", async () => {
      const books = await addBooks(app);
      await expectRefusal(
        inTransaction(app, { company: books.company, ...who }, () =>
          app.query(INSERT_VOUCHER, [books.company, books.year.id, "A", null, "", "2090-03-15", "MANUAL", "", null]),
        ),
        "description_missing",
        {},
      );
    });

    it("comments of 1001 characters, and accepts 1000", async () => {
      const books = await addBooks(app);
      const long = "k".repeat(1001);
      await expectRefusal(book(books, { comments: long }), "value_too_long", { field: "comments", value: long });
      expect((await book(books, { comments: "ö".repeat(1000) })).comments).toBe("ö".repeat(1000));
    });

    it("a row text of 101 characters, and accepts 100", async () => {
      const books = await addBooks(app);
      const long = "t".repeat(101);
      await expectRefusal(
        book(books, { rows: [{ account: 6110, amount: 2000n, text: long }, { account: 1930, amount: -2000n }] }),
        "value_too_long",
        { field: "transaction_information", value: long },
      );
      const voucher = await book(books, { rows: [{ account: 6110, amount: 2000n, text: "ä".repeat(100) }, { account: 1930, amount: -2000n }] });
      expect((await rowsOf(app, books.company, voucher.id))[0]?.transaction_information).toBe("ä".repeat(100));
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(2);
    });

    it("a series that the year does not have, and a series of another company's year", async () => {
      const books = await addBooks(app);
      await expectRefusal(book(books, { series: "TZ" }), "series_missing", { code: "TZ" });
      const other = await addBooks(app);
      await expectRefusal(book(books, { year: other.year.id }), "series_missing", { code: "A" });
    });

    it("a MANUAL voucher in a series that is not manual, and accepts the other reference types there", async () => {
      const books = await addBooks(app);
      await expectRefusal(book(books, { series: "K" }), "series_not_manual", { code: "K" });
      for (const type of REFERENCE_TYPES.filter((reference) => reference !== "MANUAL")) {
        expect((await book(books, { series: "K", referenceType: type })).reference_type).toBe(type);
      }
      expect(await nextNumberOf(app, books.company, books.year.id, "K")).toBe(7);
    });

    it("a reference type outside the seven, by PostgreSQL's check, and accepts each of the seven in a manual series", async () => {
      const books = await addBooks(app);
      for (const type of ["MANUELL", "manual", ""]) {
        await expectError(book(books, { referenceType: type }), CHECK_VIOLATION, /vouchers_reference_type/);
      }
      for (const type of REFERENCE_TYPES) {
        expect((await book(books, { referenceType: type })).reference_type).toBe(type);
      }
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(8);
    });

    it("a date outside every fiscal year, and a date in another year than the voucher's own, also in the closing series", async () => {
      const books = await addBooks(app);
      const next = await addBooksYear(app, books.company, "2091-01-01", "2091-12-31");
      const year = { year_number: books.year.year_number, from_date: "2090-01-01", to_date: "2090-12-31" };
      for (const series of ["A", "I"]) {
        await expectRefusal(book(books, { series, date: "2089-12-31" }), "no_fiscal_year", { date: "2089-12-31" });
        await expectRefusal(book(books, { series, date: "2092-01-01" }), "no_fiscal_year", { date: "2092-01-01" });
        await expectRefusal(book(books, { series, date: "2091-01-01" }), "date_outside_fiscal_year", { date: "2091-01-01", year });
        // The first and the last day are inside.
        expect((await book(books, { series, date: "2090-01-01" })).transaction_date).toBe("2090-01-01");
        expect((await book(books, { series, date: "2090-12-31" })).transaction_date).toBe("2090-12-31");
      }
      expect(await nextNumberOf(app, books.company, books.year.id, "I")).toBe(3);
      expect(await nextNumberOf(app, books.company, next.id, "A")).toBe(1);
    });

    it("a row on an account that the voucher's year does not have, also when another year has it", async () => {
      const books = await addBooks(app);
      const next = await addBooksYear(app, books.company, "2091-01-01", "2091-12-31");
      await addAccount(app, books.company, next.id, { number: 2440, description: "Leverantörsskulder" });
      await expectRefusal(book(books, { rows: balanced(2000n, 6110, 2440) }), "account_missing", { number: 2440 });
      await expectRefusal(book(books, { rows: balanced(2000n, 998, 1930) }), "account_missing", { number: 998 });
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    });

    it("a row for a voucher that is not there, or is another company's: it has no fiscal year, and its NOT NULL refuses it", async () => {
      const books = await addBooks(app);
      const other = await addBooks(app);
      const theirs = await book(other);
      for (const voucher of [randomUUID(), theirs.id]) {
        await expectError(
          inTransaction(app, { company: books.company, ...who }, () => writeRow(app, books.company, voucher, { account: 1930, amount: 0n })),
          "23502",
          /fiscal_year_id/,
        );
      }
    });

    it("a row on an inactive account", async () => {
      const books = await addBooks(app);
      await addAccount(app, books.company, books.year.id, { number: 1910, description: "Kassa", active: false });
      await expectRefusal(book(books, { rows: balanced(2000n, 1910, 1930) }), "account_inactive", { number: 1910 });
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    });

    it.each([
      ["number", "7"],
      ["created_at", "'2090-01-01'"],
      ["created_by", `'${randomUUID()}'`],
      ["created_by_kind", "'user'"],
      ["created_xact", "'1'"],
      ["modified_at", "'2090-01-01'"],
      ["altered_at", "'2090-01-01'"],
      ["altered_by", `'${randomUUID()}'`],
      ["altered_by_kind", "'user'"],
    ])("a voucher's %s given by the caller: the database sets it", async (column, value) => {
      const books = await addBooks(app);
      await expectRefusal(
        inTransaction(app, { company: books.company, ...who }, () =>
          app.query(
            `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type, ${column})
             VALUES ($1, $2, 'A', 'Kontorsmaterial', '2090-03-15', 'MANUAL', ${value})`,
            [books.company, books.year.id],
          ),
        ),
        "immutable_field",
        { field: column, operation: "create" },
      );
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    });

    it.each([
      ["fiscal_year_id", "$3"],
      ["position", "1"],
      ["removed", "true"],
      ["removed_at", "'2090-01-01'"],
      ["removed_by", `'${randomUUID()}'`],
      ["removed_by_kind", "'user'"],
      ["created_at", "'2090-01-01'"],
      ["created_by", `'${randomUUID()}'`],
      ["created_by_kind", "'user'"],
    ])("a row's %s given by the caller: the database sets it", async (column, value) => {
      const books = await addBooks(app);
      await expectRefusal(
        inTransaction(app, { company: books.company, ...who }, async () => {
          const voucher = await writeVoucher(app, books.company, aVoucher(books, { rows: balanced() }));
          await app.query(
            `INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, amount, ${column}) VALUES ($1, $2, 6110, 0, ${value})`,
            column === "fiscal_year_id" ? [books.company, voucher.id, books.year.id] : [books.company, voucher.id],
          );
        }),
        "immutable_field",
        { field: column, operation: "create" },
      );
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    });

    it("a voucher that breaks several rules with the first in a fixed order: description, comments, series, manual, year, date, rows", async () => {
      const books = await addBooks(app);
      await addBooksYear(app, books.company, "2091-01-01", "2091-12-31");
      const long = "c".repeat(1001);
      const all = { description: "", comments: long, series: "K", date: "2089-01-01", rows: [{ account: 998, amount: 1n }] };
      await expectRefusal(book(books, all), "description_missing", {});
      await expectRefusal(book(books, { ...all, description: "Ok" }), "value_too_long", { field: "comments", value: long });
      await expectRefusal(book(books, { ...all, description: "Ok", comments: "", series: "TZ" }), "series_missing", { code: "TZ" });
      await expectRefusal(book(books, { ...all, description: "Ok", comments: "" }), "series_not_manual", { code: "K" });
      await expectRefusal(book(books, { ...all, description: "Ok", comments: "", series: "A" }), "no_fiscal_year", { date: "2089-01-01" });
      await expectRefusal(book(books, { ...all, description: "Ok", comments: "", series: "A", date: "2091-06-01" }), "date_outside_fiscal_year");
      await expectRefusal(book(books, { ...all, description: "Ok", comments: "", series: "A", date: "2090-06-01" }), "account_missing", { number: 998 });
      await expectRefusal(
        book(books, { ...all, description: "Ok", comments: "", series: "A", date: "2090-06-01", rows: [{ account: 6110, amount: 1n }] }),
        "too_few_rows",
        { count: 1 },
      );
      expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    });
  });

  it("leaves the counter as it was after a refused voucher, also one refused at commit, and after a rollback", async () => {
    const books = await addBooks(app);
    await book(books);
    await expectRefusal(book(books, { description: "" }), "description_missing");
    await expectRefusal(book(books, { rows: [{ account: 6110, amount: 2000n }, { account: 1930, amount: -1999n }] }), "unbalanced");
    await expectRefusal(book(books, { rows: [{ account: 6110, amount: 0n }] }), "too_few_rows");
    await begin(app, { company: books.company, ...who });
    expect((await writeVoucher(app, books.company, aVoucher(books))).number).toBe(2);
    await app.query("ROLLBACK");
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(2);
    expect((await book(books)).number).toBe(2);
  });

  it("refuses a voucher with no actor, and names who booked it from the transaction, for each kind of actor", async () => {
    const books = await addBooks(app);
    await expectRefusal(
      inTransaction(app, { company: books.company }, () => writeVoucher(app, books.company, aVoucher(books))),
      "actor_missing",
      { setting: "nortfox.actor_id" },
    );
    for (const kind of ["user", "system", "integration"] as const) {
      const actor = { actor: randomUUID(), kind };
      const voucher = await bookVoucher(app, books.company, aVoucher(books), actor);
      expect(voucher).toMatchObject({ created_by: actor.actor, created_by_kind: kind });
      for (const row of await rowsOf(app, books.company, voucher.id)) {
        expect(row).toMatchObject({ created_by: actor.actor, created_by_kind: kind });
      }
    }
  });

  it("holds the length rules, the stamps and the numbers in checks too, as a backstop when the triggers are off (as the owner)", async () => {
    const books = await addBooks(app);
    const owner = await db.connect("owner");
    const voucher = await book(books);
    await owner.query("BEGIN");
    try {
      await owner.query("SELECT pg_catalog.set_config('nortfox.company_id', $1, true)", [books.company]);
      await owner.query("ALTER TABLE ledger.vouchers DISABLE TRIGGER USER");
      await owner.query("ALTER TABLE ledger.voucher_rows DISABLE TRIGGER USER");
      for (const [sql, constraint] of [
        ["UPDATE ledger.vouchers SET description = '' WHERE id = $1", "vouchers_description_length"],
        [`UPDATE ledger.vouchers SET description = repeat('x', 201) WHERE id = $1`, "vouchers_description_length"],
        [`UPDATE ledger.vouchers SET comments = repeat('x', 1001) WHERE id = $1`, "vouchers_comments_length"],
        ["UPDATE ledger.vouchers SET number = 0 WHERE id = $1", "vouchers_number_positive"],
        ["UPDATE ledger.vouchers SET altered_at = pg_catalog.now() WHERE id = $1", "vouchers_altered_stamps"],
        [`UPDATE ledger.voucher_rows SET transaction_information = repeat('x', 101) WHERE voucher_id = $1`, "voucher_rows_text_length"],
        ["UPDATE ledger.voucher_rows SET removed = true WHERE voucher_id = $1", "voucher_rows_removed_stamps"],
        ["UPDATE ledger.voucher_rows SET position = 0 WHERE voucher_id = $1", "voucher_rows_position_positive"],
      ] as const) {
        await owner.query("SAVEPOINT backstop");
        await expectError(owner.query(sql, [voucher.id]), CHECK_VIOLATION, new RegExp(constraint));
        await owner.query("ROLLBACK TO SAVEPOINT backstop");
      }
    } finally {
      await owner.query("ROLLBACK");
    }
  });

  it("books in another series and another fiscal year independently, and keeps the row's year the voucher's", async () => {
    const books = await addBooks(app);
    const next = await addBooksYear(app, books.company, "2091-01-01", "2091-12-31");
    await addSeries(app, books.company, books.year.id, { code: "B" });
    const a = await book(books);
    const b = await book(books, { series: "B" });
    const nextA = await book(books, { year: next.id, date: "2091-02-01" });
    expect([a.number, b.number, nextA.number]).toEqual([1, 1, 1]);
    const rows: VoucherRow[] = await rowsOf(app, books.company, nextA.id);
    expect(rows.map((row) => row.fiscal_year_id)).toEqual([next.id, next.id]);
    const columns = await app.query<{ name: string }>(
      "SELECT attname::text AS name FROM pg_catalog.pg_attribute WHERE attrelid = 'ledger.vouchers'::pg_catalog.regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
    );
    expect(columns.rows.map((row) => row.name).join(", ")).toBe(VOUCHER_COLUMNS.replaceAll(/::text AS \w+/g, "").replaceAll(/\s+/g, " ").trim());
    const rowColumns = await app.query<{ name: string }>(
      "SELECT attname::text AS name FROM pg_catalog.pg_attribute WHERE attrelid = 'ledger.voucher_rows'::pg_catalog.regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
    );
    expect(rowColumns.rows.map((row) => row.name).join(", ")).toBe(ROW_COLUMNS.replaceAll(/::text AS \w+/g, "").replaceAll(/\s+/g, " ").trim());
  });
});
