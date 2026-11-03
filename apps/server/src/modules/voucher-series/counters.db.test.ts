// SPDX-License-Identifier: AGPL-3.0-only

// The counter of each series and year (rules 14 and 15 of the slice): the
// next number, made at 1 with its series, in a table of its own. Only the
// database's own triggers write it, and only with proof in the same
// transaction: a void range that starts at the counter moves it past the
// range, a booking of the voucher with the next number moves it up by one,
// and the deletion of the voucher just below it moves it back by one.
// Anything else is refused.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, begin, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  COUNTER_COLUMNS,
  addAccount,
  addCompany,
  addFiscalYear,
  addSeries,
  balanced,
  bookVoucher,
  counterOf,
  recordVoidRange,
  someSystemUser,
  someUser,
  writeRow,
  type VoucherSeries,
} from "../../../test/ledger.ts";

/**
 * A trigger of the test's own, which runs the statement in each row inserted
 * into ledger.poke. A statement run there is at pg_trigger_depth() 2, as the
 * database's own triggers run theirs. Only the owner can make one, inside a
 * transaction that the test rolls back.
 */
const POKE = [
  "CREATE TABLE ledger.poke (statement text NOT NULL)",
  "CREATE FUNCTION ledger.poke() RETURNS trigger LANGUAGE plpgsql AS $poke$ BEGIN EXECUTE NEW.statement; RETURN NULL; END $poke$",
  "CREATE TRIGGER poke AFTER INSERT ON ledger.poke FOR EACH ROW EXECUTE FUNCTION ledger.poke()",
];

describe("the voucher counters", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  const who = someUser();
  const restorer = someSystemUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  /** A company with the fiscal year 2090 and its series A. */
  async function companyWithSeries(): Promise<{ company: string; year: string; series: VoucherSeries }> {
    const company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    const series = await addSeries(app, company, year.id, { code: "A" }, who);
    return { company, year: year.id, series };
  }

  /**
   * Runs `statement` from inside a trigger, after `before`, in one transaction
   * as the owner in `company`, and gives the rows of `after`. The transaction
   * is rolled back.
   */
  async function fromATrigger(
    company: string,
    statement: string,
    options: { before?: readonly string[]; after?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    await begin(owner, { company, ...restorer });
    try {
      for (const sql of [...POKE, ...(options.before ?? [])]) {
        await owner.query(sql);
      }
      await owner.query("INSERT INTO ledger.poke (statement) VALUES ($1)", [statement]);
      return options.after === undefined ? [] : (await owner.query<Record<string, unknown>>(options.after)).rows;
    } finally {
      await owner.query("ROLLBACK");
    }
  }

  function moveTo(series: VoucherSeries, next: string | number): string {
    return `UPDATE ledger.voucher_counters SET next_number = ${String(next)} WHERE series_id = '${series.id}'`;
  }

  it("makes each new series' counter at 1, in every fiscal year, by the trigger, with its history row", async () => {
    const { company, series } = await companyWithSeries();
    const counter = await counterOf(app, company, series.id);
    expect(counter).toEqual({ id: counter?.id, company_id: company, series_id: series.id, next_number: 1 });
    expect(counter?.id).not.toBe(series.id);
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    const nextSeries = await addSeries(app, company, next.id, { code: "A" }, who);
    expect((await counterOf(app, company, nextSeries.id))?.next_number).toBe(1);
    const history = await inTransaction(app, { company }, async () =>
      app.query<{ operation: string; series: string; next: number; actor_id: string }>(
        `SELECT operation, new_values ->> 'series_id' AS series, (new_values ->> 'next_number')::integer AS next, actor_id
         FROM audit.history WHERE table_name = 'ledger.voucher_counters' ORDER BY id`,
      ),
    );
    expect(history.rows).toEqual([
      { operation: "INSERT", series: series.id, next: 1, actor_id: who.actor },
      { operation: "INSERT", series: nextSeries.id, next: 1, actor_id: who.actor },
    ]);
  });

  it.each([
    ["make a counter", "INSERT INTO ledger.voucher_counters (company_id, series_id) VALUES ($1, $2)"],
    ["move a counter", "UPDATE ledger.voucher_counters SET next_number = next_number + 1 WHERE series_id = $2 AND company_id = $1"],
    ["leave a counter as it is by an update", "UPDATE ledger.voucher_counters SET next_number = next_number WHERE series_id = $2 AND company_id = $1"],
    ["remove a counter", "DELETE FROM ledger.voucher_counters WHERE series_id = $2 AND company_id = $1"],
  ])("refuses the app to %s: it has no privilege", async (_case, sql) => {
    const { company, series } = await companyWithSeries();
    await expectError(
      inTransaction(app, { company, ...who }, () => app.query(sql, [company, series.id])),
      INSUFFICIENT_PRIVILEGE,
      /permission denied/,
    );
    expect((await counterOf(app, company, series.id))?.next_number).toBe(1);
  });

  it.each([
    ["make a counter", "INSERT INTO ledger.voucher_counters (company_id, series_id) VALUES ($1, $2)", null],
    ["move a counter", "UPDATE ledger.voucher_counters SET next_number = next_number + 1 WHERE series_id = $2 AND company_id = $1", "next_number"],
    ["leave a counter as it is by an update", "UPDATE ledger.voucher_counters SET next_number = next_number WHERE series_id = $2 AND company_id = $1", "next_number"],
    ["remove a counter", "DELETE FROM ledger.voucher_counters WHERE series_id = $2 AND company_id = $1", null],
  ])("refuses the owner to %s by its own statement", async (_case, sql, field) => {
    const { company, series } = await companyWithSeries();
    await expectRefusal(inTransaction(owner, { company, ...restorer }, () => owner.query(sql, [company, series.id])), "internal_only", {
      table: "ledger.voucher_counters",
      field,
    });
    expect((await counterOf(app, company, series.id))?.next_number).toBe(1);
  });

  it("jumps over a void range recorded in the same transaction, to the number after it", async () => {
    const { company, year, series } = await companyWithSeries();
    await recordVoidRange(owner, company, { year, code: "A", first: 1, last: 4 });
    expect((await counterOf(app, company, series.id))?.next_number).toBe(5);
    await recordVoidRange(owner, company, { year, code: "A", first: 5, last: 5 });
    expect((await counterOf(app, company, series.id))?.next_number).toBe(6);
    // A void range from inside a trigger moves the counter the same way.
    const rows = await fromATrigger(
      company,
      `INSERT INTO ledger.void_ranges (company_id, fiscal_year_id, series_code, first_number, last_number, reason)
       VALUES ('${company}', '${year}', 'A', 6, 9, 'Återläsning av säkerhetskopia')`,
      { after: `SELECT ${COUNTER_COLUMNS} FROM ledger.voucher_counters WHERE series_id = '${series.id}'` },
    );
    expect(rows).toMatchObject([{ next_number: 10 }]);
  });

  it("refuses every other move of the counter, even from inside a trigger", async () => {
    const { company, year, series } = await companyWithSeries();
    const facts = (from: number, to: number): Record<string, unknown> => ({ series: "A", from, to });
    // Up by one, with no voucher booked in the transaction.
    await expectRefusal(fromATrigger(company, moveTo(series, "next_number + 1")), "counter_move", facts(1, 2));
    // A jump, with no void range.
    await expectRefusal(fromATrigger(company, moveTo(series, 6)), "counter_move", facts(1, 6));
    // An update that leaves the number as it is: a trigger has no reason to write one.
    await expectRefusal(fromATrigger(company, moveTo(series, "next_number")), "counter_move", facts(1, 1));
    // A jump to another number than the one after a void range of the
    // transaction, which here does not move the counter itself.
    const range = (first: number, last: number): string =>
      `INSERT INTO ledger.void_ranges (company_id, fiscal_year_id, series_code, first_number, last_number, reason)
       VALUES ('${company}', '${year}', 'A', ${String(first)}, ${String(last)}, 'Återläsning av säkerhetskopia')`;
    const withoutTheirMoves = (...ranges: string[]): string[] => [
      "ALTER TABLE ledger.void_ranges DISABLE TRIGGER void_ranges_move_counter",
      ...ranges,
      "ALTER TABLE ledger.void_ranges ENABLE TRIGGER void_ranges_move_counter",
    ];
    await expectRefusal(fromATrigger(company, moveTo(series, 10), { before: withoutTheirMoves(range(1, 3)) }), "counter_move", facts(1, 10));
    await expectRefusal(fromATrigger(company, moveTo(series, 3), { before: withoutTheirMoves(range(1, 3)) }), "counter_move", facts(1, 3));
    expect(
      await fromATrigger(company, moveTo(series, 4), {
        before: withoutTheirMoves(range(1, 3)),
        after: `SELECT next_number FROM ledger.voucher_counters WHERE series_id = '${series.id}'`,
      }),
    ).toEqual([{ next_number: 4 }]);
    // A jump to the end of a void range of the transaction that starts below the counter.
    await expectRefusal(
      fromATrigger(company, moveTo(series, 6), {
        before: [...withoutTheirMoves(range(1, 3), range(1, 5)), `INSERT INTO ledger.poke (statement) VALUES ('${moveTo(series, 4).replaceAll("'", "''")}')`],
      }),
      "counter_move",
      facts(4, 6),
    );
    // A jump over a void range of an earlier transaction: the owner first
    // puts the counter back below it, with the counter's rules off.
    await recordVoidRange(owner, company, { year, code: "A", first: 1, last: 3 });
    const backBelowTheRange = [
      "ALTER TABLE ledger.voucher_counters DISABLE TRIGGER voucher_counters_rules",
      moveTo(series, 1),
      "ALTER TABLE ledger.voucher_counters ENABLE TRIGGER voucher_counters_rules",
    ];
    await expectRefusal(fromATrigger(company, moveTo(series, 4), { before: backBelowTheRange }), "counter_move", facts(1, 4));
    // Back by one, with no voucher deleted in the transaction.
    await expectRefusal(fromATrigger(company, moveTo(series, 3)), "counter_move", facts(4, 3));
    await expectRefusal(fromATrigger(company, moveTo(series, "next_number - 1")), "counter_move", facts(4, 3));
    // A counter changes neither its id nor its series.
    const other = await addSeries(app, company, year, { code: "B" });
    await expectRefusal(
      fromATrigger(company, `UPDATE ledger.voucher_counters SET series_id = '${other.id}' WHERE series_id = '${series.id}'`),
      "immutable_field",
      { field: "series_id", operation: "update" },
    );
    await expectRefusal(
      fromATrigger(company, `UPDATE ledger.voucher_counters SET id = pg_catalog.gen_random_uuid() WHERE series_id = '${series.id}'`),
      "immutable_field",
      { field: "id", operation: "update" },
    );
    expect((await counterOf(app, company, series.id))?.next_number).toBe(4);
  });

  /** A booking in series `code` of `year`, dated `date`, as the owner writes it from inside fromATrigger's transaction. It needs no rows: the transaction is rolled back. */
  function booking(company: string, year: string, code: string, date = "2090-03-15"): string {
    return `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
            VALUES ('${company}', '${year}', '${code}', 'Kontorsmaterial', '${date}', 'MANUAL')`;
  }

  /**
   * The deletion of the voucher with `number` in series `code` of `year`. A
   * deletion checks the voucher's two rows and its balance, so it first gets
   * two rows that balance, on the accounts 1930 and 6110.
   */
  function deletion(company: string, year: string, code: string, number: number): string[] {
    const which = `company_id = '${company}' AND fiscal_year_id = '${year}' AND series_code = '${code}' AND number = ${String(number)}`;
    const row = (account: number, debit: number, credit: number): string =>
      `INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, debit, credit)
       SELECT company_id, id, ${String(account)}, ${String(debit)}, ${String(credit)} FROM ledger.vouchers WHERE ${which}`;
    return [row(6110, 100, 0), row(1930, 0, 100), `DELETE FROM ledger.vouchers WHERE ${which}`];
  }

  it("moves up by one with each booking and back by one with the deletion of the last voucher, and only so", async () => {
    const { company, year, series } = await companyWithSeries();
    await addAccount(app, company, year, { number: 1930 });
    await addAccount(app, company, year, { number: 6110 });
    const counterAfter = `SELECT next_number FROM ledger.voucher_counters WHERE series_id = '${series.id}'`;
    // A booking moves it up by one, and the next booking once more.
    expect(await fromATrigger(company, "SELECT 1", { before: [booking(company, year, "A"), booking(company, year, "A")], after: counterAfter })).toEqual([
      { next_number: 3 },
    ]);
    // A deletion of the last moves it back, also of a voucher booked in the same transaction.
    expect(
      await fromATrigger(company, "SELECT 1", {
        before: [booking(company, year, "A"), booking(company, year, "A"), ...deletion(company, year, "A", 2)],
        after: counterAfter,
      }),
    ).toEqual([{ next_number: 2 }]);
    const other = await addSeries(app, company, year, { code: "B" });
    const facts = (from: number, to: number): Record<string, unknown> => ({ series: "A", from, to });
    // A booking in another series is no proof for this one.
    await expectRefusal(fromATrigger(company, moveTo(series, "next_number + 1"), { before: [booking(company, year, "B")] }), "counter_move", facts(1, 2));
    // A booking proves one step only: a second step needs a second booking.
    await expectRefusal(fromATrigger(company, moveTo(series, "next_number + 1"), { before: [booking(company, year, "A")] }), "counter_move", facts(2, 3));
    await expectRefusal(fromATrigger(company, moveTo(series, 3), { before: [booking(company, year, "A")] }), "counter_move", facts(2, 3));
    // A deletion proves one step back only, and only in its own series.
    await expectRefusal(
      fromATrigger(company, moveTo(series, "next_number - 1"), { before: [booking(company, year, "A"), ...deletion(company, year, "A", 1)] }),
      "counter_move",
      facts(1, 0),
    );
    await expectRefusal(
      fromATrigger(company, moveTo(series, "next_number - 1"), {
        before: [booking(company, year, "A"), booking(company, year, "B"), ...deletion(company, year, "B", 1)],
      }),
      "counter_move",
      facts(2, 1),
    );
    // A deletion proves the step back only while its voucher is being deleted:
    // once the number is booked again, the old deletion proves nothing.
    await expectRefusal(
      fromATrigger(company, moveTo(series, "next_number - 1"), {
        before: [booking(company, year, "A"), booking(company, year, "A"), ...deletion(company, year, "A", 2), booking(company, year, "A")],
      }),
      "counter_move",
      facts(3, 2),
    );
    expect((await counterOf(app, company, series.id))?.next_number).toBe(1);
    expect((await counterOf(app, company, other.id))?.next_number).toBe(1);
  });

  it("takes no booking of an earlier transaction as proof, and refuses a step back with no deletion", async () => {
    const { company, year, series } = await companyWithSeries();
    await addAccount(app, company, year, { number: 1930 });
    await addAccount(app, company, year, { number: 6110 });
    await bookVoucher(app, company, { year, series: "A", date: "2090-03-15", rows: balanced() }, who);
    expect((await counterOf(app, company, series.id))?.next_number).toBe(2);
    await expectRefusal(fromATrigger(company, moveTo(series, "next_number - 1")), "counter_move", { series: "A", from: 2, to: 1 });
    // Voucher 1 was booked in an earlier transaction. The owner puts the
    // counter back to 1, with the counter's rules off, so that voucher would
    // prove the step to 2 if a booking of another transaction counted.
    const backToOne = [
      "ALTER TABLE ledger.voucher_counters DISABLE TRIGGER voucher_counters_rules",
      moveTo(series, 1),
      "ALTER TABLE ledger.voucher_counters ENABLE TRIGGER voucher_counters_rules",
    ];
    await expectRefusal(fromATrigger(company, moveTo(series, "next_number + 1"), { before: backToOne }), "counter_move", { series: "A", from: 1, to: 2 });
    expect((await counterOf(app, company, series.id))?.next_number).toBe(2);
  });

  // Each fiscal year has its own series, and a series of another year may
  // have the same code. Its booking, its deletion or its void range proves
  // nothing for this year's counter, also in the same transaction.
  it("takes no booking, deletion or void range of the series with the same code in another fiscal year as proof", async () => {
    const { company, year, series } = await companyWithSeries();
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    const nextSeries = await addSeries(app, company, next.id, { code: "A" }, who);
    for (const books of [year, next.id]) {
      await addAccount(app, company, books, { number: 1930 });
      await addAccount(app, company, books, { number: 6110 });
    }
    const facts = (from: number, to: number): Record<string, unknown> => ({ series: "A", from, to });
    // A void range from 1 to 3 in 2091's series A, recorded in the
    // transaction, which here does not move that series' own counter.
    await expectRefusal(
      fromATrigger(company, moveTo(series, 4), {
        before: [
          "ALTER TABLE ledger.void_ranges DISABLE TRIGGER void_ranges_move_counter",
          `INSERT INTO ledger.void_ranges (company_id, fiscal_year_id, series_code, first_number, last_number, reason)
           VALUES ('${company}', '${next.id}', 'A', 1, 3, 'Återläsning av säkerhetskopia')`,
          "ALTER TABLE ledger.void_ranges ENABLE TRIGGER void_ranges_move_counter",
        ],
      }),
      "counter_move",
      facts(1, 4),
    );
    // Voucher 1 of 2091's series A, booked in the transaction.
    await expectRefusal(
      fromATrigger(company, moveTo(series, "next_number + 1"), { before: [booking(company, next.id, "A", "2091-03-15")] }),
      "counter_move",
      facts(1, 2),
    );
    // Voucher 1 of 2091's series A, while it is being deleted in the
    // transaction: a trigger of the test on the record moves this year's
    // counter back from 2 then.
    await bookVoucher(app, company, { year, series: "A", date: "2090-03-15", rows: balanced() }, who);
    const whileDeleting = [
      `CREATE FUNCTION ledger.poke_deletion() RETURNS trigger LANGUAGE plpgsql AS $poke$ BEGIN ${moveTo(series, "next_number - 1")}; RETURN NULL; END $poke$`,
      "CREATE TRIGGER poke_deletion AFTER INSERT ON ledger.deleted_vouchers FOR EACH ROW EXECUTE FUNCTION ledger.poke_deletion()",
    ];
    await expectRefusal(
      fromATrigger(company, "SELECT 1", { before: [...whileDeleting, booking(company, next.id, "A", "2091-03-15"), ...deletion(company, next.id, "A", 1)] }),
      "counter_move",
      facts(2, 1),
    );
    // Without the trigger of the test, the same deletion moves only its own year's counter.
    expect(
      await fromATrigger(company, "SELECT 1", {
        before: [booking(company, next.id, "A", "2091-03-15"), ...deletion(company, next.id, "A", 1)],
        after: `SELECT s.fiscal_year_id::text = '${year}' AS this_year, c.next_number FROM ledger.voucher_counters AS c
                JOIN ledger.voucher_series AS s ON s.id = c.series_id WHERE s.code = 'A' ORDER BY 1 DESC`,
      }),
    ).toEqual([
      { this_year: true, next_number: 2 },
      { this_year: false, next_number: 1 },
    ]);
    expect((await counterOf(app, company, series.id))?.next_number).toBe(2);
    expect((await counterOf(app, company, nextSeries.id))?.next_number).toBe(1);
  });

  it("takes no deletion of an earlier transaction as proof, also when a voucher with the deleted voucher's id is booked again with its number", async () => {
    const { company, year, series } = await companyWithSeries();
    await addAccount(app, company, year, { number: 1930 });
    await addAccount(app, company, year, { number: 6110 });
    const id = randomUUID();
    const bookWithId = (): Promise<unknown> =>
      inTransaction(app, { company, ...who }, async () => {
        await app.query(
          `INSERT INTO ledger.vouchers (id, company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
           VALUES ($1, $2, $3, 'A', 'Kontorsmaterial', '2090-03-15', 'MANUAL')`,
          [id, company, year],
        );
        for (const row of balanced()) {
          await writeRow(app, company, id, row);
        }
      });
    await bookWithId();
    await inTransaction(app, { company, ...who }, () => app.query("DELETE FROM ledger.vouchers WHERE id = $1", [id]));
    await bookWithId();
    expect((await counterOf(app, company, series.id))?.next_number).toBe(2);
    // The record holds a deletion of number 1 by this id, and the vouchers a
    // voucher with this id and number 1, but the deletion was not in this
    // transaction.
    await expectRefusal(fromATrigger(company, moveTo(series, "next_number - 1")), "counter_move", { series: "A", from: 2, to: 1 });
    expect((await counterOf(app, company, series.id))?.next_number).toBe(2);
    // The same when the deletion carries the transaction's id but was made before it.
    await expectRefusal(
      fromATrigger(company, moveTo(series, "next_number - 1"), { before: withTheTransactionsId("ledger.deleted_vouchers", "deleted_vouchers_append_only", "deleted_xact") }),
      "counter_move",
      { series: "A", from: 2, to: 1 },
    );
    expect((await counterOf(app, company, series.id))?.next_number).toBe(2);
  });

  /**
   * Statements that give every row of `table` the transaction's id in
   * `column`, with the trigger that keeps it off, as a dump restored into
   * another cluster can leave a row: that cluster gives the old ids out again.
   */
  function withTheTransactionsId(table: string, trigger: string, column: string): string[] {
    return [
      `ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`,
      `UPDATE ${table} SET ${column} = pg_catalog.pg_current_xact_id()`,
      `ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`,
    ];
  }

  /** Statements that put the counter of `series` back to `next`, with the counter's rules off. */
  function counterBackTo(series: VoucherSeries, next: number): string[] {
    return [
      "ALTER TABLE ledger.voucher_counters DISABLE TRIGGER voucher_counters_rules",
      moveTo(series, next),
      "ALTER TABLE ledger.voucher_counters ENABLE TRIGGER voucher_counters_rules",
    ];
  }

  // A proof must also be made after the transaction began: an id alone
  // could be one that a dump restored into another cluster brought along.
  it("takes no booking or void range that carries the transaction's id but was made before the transaction began as proof", async () => {
    const booked = await companyWithSeries();
    await addAccount(app, booked.company, booked.year, { number: 1930 });
    await addAccount(app, booked.company, booked.year, { number: 6110 });
    await bookVoucher(app, booked.company, { year: booked.year, series: "A", date: "2090-03-15", rows: balanced() }, who);
    // Voucher 1, booked earlier, with the counter put back to 1.
    await expectRefusal(
      fromATrigger(booked.company, moveTo(booked.series, "next_number + 1"), {
        before: [...counterBackTo(booked.series, 1), ...withTheTransactionsId("ledger.vouchers", "vouchers_alter", "created_xact")],
      }),
      "counter_move",
      { series: "A", from: 1, to: 2 },
    );
    expect((await counterOf(app, booked.company, booked.series.id))?.next_number).toBe(2);
    // A void range from 1 to 3, recorded earlier, with the counter put back to 1.
    const voided = await companyWithSeries();
    await recordVoidRange(owner, voided.company, { year: voided.year, code: "A", first: 1, last: 3 });
    await expectRefusal(
      fromATrigger(voided.company, moveTo(voided.series, 4), {
        before: [...counterBackTo(voided.series, 1), ...withTheTransactionsId("ledger.void_ranges", "void_ranges_rules", "created_xact")],
      }),
      "counter_move",
      { series: "A", from: 1, to: 4 },
    );
    expect((await counterOf(app, voided.company, voided.series.id))?.next_number).toBe(4);
  });

  it("removes a counter only with its series: never from inside a trigger while the series is there", async () => {
    const { company, series } = await companyWithSeries();
    await expectRefusal(fromATrigger(company, `DELETE FROM ledger.voucher_counters WHERE series_id = '${series.id}'`), "internal_only", {
      table: "ledger.voucher_counters",
      field: null,
    });
    expect((await counterOf(app, company, series.id))?.next_number).toBe(1);
    await inTransaction(app, { company, ...who }, () => app.query("DELETE FROM ledger.voucher_series WHERE id = $1", [series.id]));
    expect(await counterOf(app, company, series.id)).toBeUndefined();
  });
});
