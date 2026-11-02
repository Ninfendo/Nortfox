// SPDX-License-Identifier: AGPL-3.0-only

// The counter of each series and year (rules 14 and 15 of the slice): the
// next number, made at 1 with its series, in a table of its own. Only the
// database's own triggers write it, and only with proof in the same
// transaction: here, a void range that starts at the counter moves it past the
// range. The booking that moves it up by one and the deletion that moves it
// back by one come with the vouchers. Anything else is refused.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, begin, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  COUNTER_COLUMNS,
  addCompany,
  addFiscalYear,
  addSeries,
  counterOf,
  recordVoidRange,
  someSystemUser,
  someUser,
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
