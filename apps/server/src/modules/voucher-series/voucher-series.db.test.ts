// SPDX-License-Identifier: AGPL-3.0-only

// Voucher series (rules 13, 18, 19 and 24 of the slice): each belongs to a
// fiscal year, with a code of 1 to 10 digits and capital letters that is
// unique in its year and never changes, a name of at most 200 characters that
// may be empty, the manual flag, and at most one closing series per year.
// Every accepted change moves its modified time, and a refused one moves
// nothing. An unused series can be removed. A series that holds any voucher,
// live or deleted, stays.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  UNIQUE_VIOLATION,
  backendPid,
  begin,
  expectError,
  expectRefusal,
  failureOf,
  freshDatabase,
  inTransaction,
  untilWaitingForLock,
  type TestDatabase,
} from "../../../test/database.ts";
import {
  SERIES_COLUMNS,
  addBooks,
  addCompany,
  addFiscalYear,
  addSeries,
  balanced,
  bookVoucher,
  counterOf,
  isAfter,
  recordVoidRange,
  someUser,
  type VoucherSeries,
} from "../../../test/ledger.ts";

/** PostgreSQL's SQLSTATE for a row that an ON DELETE RESTRICT foreign key keeps. */
const RESTRICT_VIOLATION = "23001";

describe("voucher series", () => {
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
  async function asApp(company: string, sql: string, params: readonly unknown[] = []): Promise<VoucherSeries[]> {
    return inTransaction(app, { company, ...who }, async () => (await app.query<VoucherSeries>(sql, [...params])).rows);
  }

  async function seriesOf(company: string, id: string): Promise<VoucherSeries | undefined> {
    const [found] = await asApp(company, `SELECT ${SERIES_COLUMNS} FROM ledger.voucher_series WHERE id = $1`, [id]);
    return found;
  }

  /** A company with one fiscal year, 2090. */
  async function companyWithYear(): Promise<{ company: string; year: string }> {
    const company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    return { company, year: year.id };
  }

  const INSERT = "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, $3, $4, true)";

  it("holds a series' code, name, manual flag and closing mark in its fiscal year, with a modified time", async () => {
    const { company, year } = await companyWithYear();
    const { series, started } = await inTransaction(app, { company, ...who }, async () => {
      const inserted = await app.query<VoucherSeries & { started: string }>(
        `INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'A', 'Manuella verifikationer', true)
         RETURNING ${SERIES_COLUMNS}, pg_catalog.transaction_timestamp()::text AS started`,
        [company, year],
      );
      const [row] = inserted.rows;
      return { series: row, started: row?.started ?? "" };
    });
    expect(series).toEqual({
      id: series?.id,
      company_id: company,
      fiscal_year_id: year,
      code: "A",
      description: "Manuella verifikationer",
      manual: true,
      is_closing: false,
      modified_at: series?.modified_at,
      started,
    });
    expect(await isAfter(app, series?.modified_at ?? "", started)).toBe(true);
    const closing = await addSeries(app, company, year, { code: "I", description: "", manual: false, isClosing: true });
    expect(closing).toMatchObject({ code: "I", description: "", manual: false, is_closing: true });
    const columns = await app.query<{ name: string }>(
      "SELECT attname::text AS name FROM pg_catalog.pg_attribute WHERE attrelid = 'ledger.voucher_series'::pg_catalog.regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
    );
    expect(columns.rows.map((row) => row.name)).toEqual(["id", "company_id", "fiscal_year_id", "code", "description", "manual", "is_closing", "modified_at"]);
  });

  it.each([
    ["that is empty", ""],
    ["of 11 characters", "ABCDEFGHIJK"],
    ["of a small letter", "a"],
    ["with a small letter", "Ab"],
    ["with a small å", "Aå"],
    ["with a space", "A B"],
    ["that starts with a space", " A"],
    ["with a hyphen", "A-B"],
    ["with a capital letter outside A to Z, Å, Ä and Ö", "É"],
    ["with a line break", "A\n"],
    ["that is missing", null],
  ])("refuses a series code %s, and makes no series", async (_case, code) => {
    const { company, year } = await companyWithYear();
    await expectRefusal(asApp(company, INSERT, [company, year, code, "Testserie"]), "series_code_invalid", { code });
    expect(await asApp(company, "SELECT id FROM ledger.voucher_series")).toEqual([]);
  });

  it.each([
    ["of one capital letter", "A"],
    ["of one digit", "1"],
    ["that starts with a digit", "1A"],
    ["with Å", "Å"],
    ["with Ä and Ö", "ÄÖ"],
    ["of 10 characters", "ABCDEFGHIJ"],
    ["of the next 10 letters", "KLMNOPQRST"],
    ["of the last letters", "UVWXYZÅÄÖ"],
    ["of every digit", "0123456789"],
  ])("accepts a series code %s", async (_case, code) => {
    const { company, year } = await companyWithYear();
    expect((await addSeries(app, company, year, { code })).code).toBe(code);
  });

  it("refuses a code that the year already has, and lets another year and another company have it", async () => {
    const { company, year } = await companyWithYear();
    const first = await addSeries(app, company, year, { code: "A" });
    await expectRefusal(addSeries(app, company, year, { code: "A" }), "series_code_duplicate", { code: "A" });
    await addSeries(app, company, year, { code: "Å" });
    await expectRefusal(addSeries(app, company, year, { code: "Å" }), "series_code_duplicate", { code: "Å" });
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    expect((await addSeries(app, company, next.id, { code: "A" })).fiscal_year_id).toBe(next.id);
    const other = await companyWithYear();
    expect((await addSeries(app, other.company, other.year, { code: "A" })).company_id).toBe(other.company);
    expect(await seriesOf(company, first.id)).toEqual(first);
  });

  it("refuses the second of two series with one code made at the same time, with its reason", async () => {
    const { company, year } = await companyWithYear();
    const other = await db.connect("app");
    const otherPid = await backendPid(other);
    await begin(app, { company, ...who });
    await begin(other, { company, ...who });
    try {
      await app.query(INSERT, [company, year, "A", "Testserie"]);
      // The second waits on the fiscal year's row until the first commits, then sees its code.
      const second = expectRefusal(other.query(INSERT, [company, year, "A", "Testserie"]), "series_code_duplicate", { code: "A" });
      await untilWaitingForLock(app, otherPid);
      await app.query("COMMIT");
      await second;
    } finally {
      await other.query("ROLLBACK");
      await app.query("ROLLBACK");
    }
    expect((await asApp(company, "SELECT code FROM ledger.voucher_series")).map((row) => row.code)).toEqual(["A"]);
  });

  it("never changes a series' code, its fiscal year or its id", async () => {
    const { company, year } = await companyWithYear();
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    const series = await addSeries(app, company, year, { code: "A" });
    for (const code of ["B", "a", "AB"]) {
      await expectRefusal(asApp(company, "UPDATE ledger.voucher_series SET code = $2 WHERE id = $1", [series.id, code]), "series_code_changed", {
        code: "A",
      });
    }
    await expectRefusal(asApp(company, "UPDATE ledger.voucher_series SET fiscal_year_id = $2 WHERE id = $1", [series.id, next.id]), "immutable_field", {
      field: "fiscal_year_id",
      operation: "update",
    });
    await expectRefusal(asApp(company, "UPDATE ledger.voucher_series SET id = $2 WHERE id = $1", [series.id, randomUUID()]), "immutable_field", {
      field: "id",
      operation: "update",
    });
    expect(await seriesOf(company, series.id)).toEqual(series);
  });

  it("refuses a name of 201 characters, and accepts one of 200, counted in characters, and an empty one, by insert and by a change", async () => {
    const { company, year } = await companyWithYear();
    const tooLong = "N".repeat(201);
    await expectRefusal(asApp(company, INSERT, [company, year, "A", tooLong]), "value_too_long", { field: "description", value: tooLong });
    const longest = "Å".repeat(100) + "N".repeat(100);
    const series = await addSeries(app, company, year, { code: "A", description: longest });
    expect(series.description).toBe(longest);
    expect((await addSeries(app, company, year, { code: "B", description: "" })).description).toBe("");
    const alsoTooLong = `${longest}Ö`;
    await expectRefusal(
      asApp(company, "UPDATE ledger.voucher_series SET description = $2 WHERE id = $1", [series.id, alsoTooLong]),
      "value_too_long",
      { field: "description", value: alsoTooLong },
    );
    const [emptied] = await asApp(company, `UPDATE ledger.voucher_series SET description = '' WHERE id = $1 RETURNING ${SERIES_COLUMNS}`, [series.id]);
    expect(emptied?.description).toBe("");
  });

  it("keeps the code's form, its length, the name's length and the code's uniqueness even when the trigger is off (as the owner)", async () => {
    const { company, year } = await companyWithYear();
    await addSeries(app, company, year, { code: "A" });
    for (const [code, description, state, constraint] of [
      ["a", "Testserie", CHECK_VIOLATION, /voucher_series_code_form/],
      ["ABCDEFGHIJK", "Testserie", CHECK_VIOLATION, /voucher_series_code_form/],
      ["", "Testserie", CHECK_VIOLATION, /voucher_series_code_form/],
      ["B", "N".repeat(201), CHECK_VIOLATION, /voucher_series_description_length/],
      ["A", "Testserie", UNIQUE_VIOLATION, /voucher_series_code_unique/],
    ] as const) {
      await begin(owner, { company, ...who });
      try {
        await owner.query("ALTER TABLE ledger.voucher_series DISABLE TRIGGER voucher_series_rules");
        await expectError(
          owner.query(
            "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual, modified_at) VALUES ($1, $2, $3, $4, true, pg_catalog.clock_timestamp())",
            [company, year, code, description],
          ),
          state,
          constraint,
        );
      } finally {
        await owner.query("ROLLBACK");
      }
    }
  });

  it("refuses a second closing series in one fiscal year, by insert and by a change, lets the mark move, and writes each change to the history", async () => {
    const { company, year } = await companyWithYear();
    const closing = await addSeries(app, company, year, { code: "I", isClosing: true });
    const other = await addSeries(app, company, year, { code: "A" });
    await expectError(addSeries(app, company, year, { code: "B", isClosing: true }), UNIQUE_VIOLATION, /voucher_series_one_closing/);
    await expectError(
      asApp(company, "UPDATE ledger.voucher_series SET is_closing = true WHERE id = $1", [other.id]),
      UNIQUE_VIOLATION,
      /voucher_series_one_closing/,
    );
    // Another year has a closing series of its own.
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    expect((await addSeries(app, company, next.id, { code: "I", isClosing: true })).is_closing).toBe(true);
    // The mark moves when the old closing series gives it up first.
    const mover = someUser();
    await inTransaction(app, { company, ...mover }, async () => {
      await app.query("UPDATE ledger.voucher_series SET is_closing = false WHERE id = $1", [closing.id]);
      await app.query("UPDATE ledger.voucher_series SET is_closing = true WHERE id = $1", [other.id]);
    });
    const closings = await asApp(company, `SELECT ${SERIES_COLUMNS} FROM ledger.voucher_series WHERE is_closing ORDER BY code`);
    expect(closings.map((row) => [row.fiscal_year_id, row.code])).toEqual([
      [year, "A"],
      [next.id, "I"],
    ]);
    const history = await inTransaction(app, { company }, async () =>
      app.query<{ row_id: string; old_closing: boolean; new_closing: boolean; actor_id: string }>(
        `SELECT row_id, (old_values ->> 'is_closing')::boolean AS old_closing, (new_values ->> 'is_closing')::boolean AS new_closing, actor_id
         FROM audit.history WHERE table_name = 'ledger.voucher_series' AND operation = 'UPDATE' ORDER BY id`,
      ),
    );
    expect(history.rows).toEqual([
      { row_id: closing.id, old_closing: true, new_closing: false, actor_id: mover.actor },
      { row_id: other.id, old_closing: false, new_closing: true, actor_id: mover.actor },
    ]);
  });

  it("takes the modified time from the database: one given on insert, or written by an update, is refused", async () => {
    const { company, year } = await companyWithYear();
    await expectRefusal(
      asApp(
        company,
        "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual, modified_at) VALUES ($1, $2, 'A', '', true, '2090-01-01')",
        [company, year],
      ),
      "immutable_field",
      { field: "modified_at", operation: "create" },
    );
    const series = await addSeries(app, company, year, { code: "A" });
    await expectRefusal(asApp(company, "UPDATE ledger.voucher_series SET modified_at = '2090-01-01' WHERE id = $1", [series.id]), "internal_only", {
      table: "ledger.voucher_series",
      field: "modified_at",
    });
    expect(await seriesOf(company, series.id)).toEqual(series);
  });

  it("moves the modified time with every accepted change, and with no refused one", async () => {
    const { company, year } = await companyWithYear();
    await addSeries(app, company, year, { code: "I", isClosing: true });
    let series = await addSeries(app, company, year, { code: "A", description: "Testserie", manual: true });
    for (const set of ["description = 'Manuella verifikationer'", "manual = false", "description = ''", "manual = true"]) {
      const [changed] = await asApp(company, `UPDATE ledger.voucher_series SET ${set} WHERE id = $1 RETURNING ${SERIES_COLUMNS}`, [series.id]);
      expect(await isAfter(app, changed?.modified_at ?? "", series.modified_at), set).toBe(true);
      series = changed ?? series;
    }
    // Refused changes, each by another rule: none moves the modified time.
    await expectRefusal(asApp(company, "UPDATE ledger.voucher_series SET description = 'Ny', code = 'B' WHERE id = $1", [series.id]), "series_code_changed");
    await expectRefusal(
      asApp(company, "UPDATE ledger.voucher_series SET manual = false, description = $2 WHERE id = $1", [series.id, "N".repeat(201)]),
      "value_too_long",
    );
    await expectRefusal(asApp(company, "UPDATE ledger.voucher_series SET modified_at = pg_catalog.clock_timestamp() WHERE id = $1", [series.id]), "internal_only");
    await expectError(asApp(company, "UPDATE ledger.voucher_series SET manual = false, is_closing = true WHERE id = $1", [series.id]), UNIQUE_VIOLATION);
    expect(await seriesOf(company, series.id)).toEqual(series);
  });

  it("lets an unused series be removed with its counter, and writes both removals to the history", async () => {
    const { company, year } = await companyWithYear();
    const series = await addSeries(app, company, year, { code: "A" });
    expect((await counterOf(app, company, series.id))?.next_number).toBe(1);
    const removed = await asApp(company, "DELETE FROM ledger.voucher_series WHERE id = $1 RETURNING id", [series.id]);
    expect(removed).toEqual([{ id: series.id }]);
    expect(await seriesOf(company, series.id)).toBeUndefined();
    expect(await counterOf(app, company, series.id)).toBeUndefined();
    const history = await inTransaction(app, { company }, async () =>
      app.query<{ table_name: string; series: string | null; new_values: unknown; actor_id: string }>(
        `SELECT table_name, COALESCE(old_values ->> 'series_id', old_values ->> 'id') AS series, new_values, actor_id
         FROM audit.history WHERE operation = 'DELETE' ORDER BY table_name`,
      ),
    );
    expect(history.rows).toEqual([
      { table_name: "ledger.voucher_counters", series: series.id, new_values: null, actor_id: who.actor },
      { table_name: "ledger.voucher_series", series: series.id, new_values: null, actor_id: who.actor },
    ]);
    // The code is free again in its year, and the new series' counter starts at 1.
    const again = await addSeries(app, company, year, { code: "A" });
    expect((await counterOf(app, company, again.id))?.next_number).toBe(1);
  });

  it("keeps a series that holds a voucher, and one that holds only deleted vouchers, and lets the unused ones go", async () => {
    const books = await addBooks(app, who);
    const voucher = { year: books.year.id, date: "2090-03-15", rows: balanced() };
    await bookVoucher(app, books.company, { ...voucher, series: "A" }, who);
    const deleted = await bookVoucher(app, books.company, { ...voucher, series: "I" }, who);
    await asApp(books.company, "DELETE FROM ledger.vouchers WHERE id = $1", [deleted.id]);
    const remove = (code: string) => asApp(books.company, "DELETE FROM ledger.voucher_series WHERE fiscal_year_id = $1 AND code = $2", [books.year.id, code]);
    await expectError(remove("A"), RESTRICT_VIOLATION, /constraint "vouchers_series"/);
    await expectError(remove("I"), RESTRICT_VIOLATION, /constraint "deleted_vouchers_series"/);
    await remove("K");
    const left = await asApp(books.company, `SELECT ${SERIES_COLUMNS} FROM ledger.voucher_series ORDER BY code`);
    expect(left.map((series) => series.code)).toEqual(["A", "I"]);
  });

  // The removal's trigger refuses a series that a row names before the
  // foreign keys lock those rows (db/README.md, the lock order). It gives the
  // foreign key's own error, in the foreign keys' order, and the foreign keys
  // keep the rule when the trigger is off.
  it("refuses the removal of a series that a row names with the error that the foreign key gives with the trigger off", async () => {
    const books = await addBooks(app, who);
    await addSeries(app, books.company, books.year.id, { code: "B" }, who);
    const voucher = { year: books.year.id, date: "2090-03-15", rows: balanced() };
    // A: a voucher, and an entry in the record. B: a void range, and a voucher. I: only an entry in the record.
    await bookVoucher(app, books.company, { ...voucher, series: "A" }, who);
    const deleted = [
      await bookVoucher(app, books.company, { ...voucher, series: "A" }, who),
      await bookVoucher(app, books.company, { ...voucher, series: "I" }, who),
    ];
    for (const { id } of deleted) {
      await asApp(books.company, "DELETE FROM ledger.vouchers WHERE id = $1", [id]);
    }
    await recordVoidRange(owner, books.company, { year: books.year.id, code: "B", first: 1, last: 1 });
    await bookVoucher(app, books.company, { ...voucher, series: "B" }, who);
    const REMOVE = "DELETE FROM ledger.voucher_series WHERE fiscal_year_id = $1 AND code = $2";
    const fields = (error: unknown): Record<string, unknown> => {
      const { code, message, detail, schema, table, constraint } = error as Record<string, unknown>;
      return { code, message, detail, schema, table, constraint };
    };
    for (const [code, table] of [
      ["A", "vouchers"],
      ["B", "void_ranges"],
      ["I", "deleted_vouchers"],
    ] as const) {
      const refused = fields(await failureOf(asApp(books.company, REMOVE, [books.year.id, code])));
      expect(refused, code).toEqual({
        code: RESTRICT_VIOLATION,
        message: `update or delete on table "voucher_series" violates RESTRICT setting of foreign key constraint "${table}_series" on table "${table}"`,
        detail: `Key is referenced from table "${table}".`,
        schema: "ledger",
        table,
        constraint: `${table}_series`,
      });
      await begin(owner, { company: books.company, ...who });
      try {
        await owner.query("ALTER TABLE ledger.voucher_series DISABLE TRIGGER voucher_series_keep_named");
        expect(fields(await failureOf(owner.query(REMOVE, [books.year.id, code]))), code).toEqual(refused);
      } finally {
        await owner.query("ROLLBACK");
      }
    }
    const left = await asApp(books.company, `SELECT ${SERIES_COLUMNS} FROM ledger.voucher_series ORDER BY code`);
    expect(left.map((series) => series.code)).toEqual(["A", "B", "I", "K"]);
  });
});
