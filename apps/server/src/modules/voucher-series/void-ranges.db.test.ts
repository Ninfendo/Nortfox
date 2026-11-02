// SPDX-License-Identifier: AGPL-3.0-only

// Void ranges (rules 15 and 16 of the slice): a recorded skip in a series,
// with the series, the year, the first and the last number skipped, and the
// reason. Only the owner role records one, as a restore will, and only from
// the series' counter, which then moves past it. No role changes or deletes
// one. Its history row is written like any other. That the voucher just below
// one cannot be deleted is tested with the vouchers.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  backendPid,
  begin,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  untilWaitingForLock,
  type Settings,
  type TestDatabase,
} from "../../../test/database.ts";
import {
  INSERT_VOID_RANGE,
  VOID_RANGE_COLUMNS,
  addCompany,
  addFiscalYear,
  addSeries,
  counterOf,
  isAfter,
  recordVoidRange,
  someSystemUser,
  someUser,
  type VoidRange,
  type VoucherSeries,
} from "../../../test/ledger.ts";

/**
 * PostgreSQL's SQLSTATEs for a foreign key that refused a row, and for one
 * whose ON DELETE RESTRICT refused to let the row it points to go.
 */
const FOREIGN_KEY_VIOLATION = "23503";
const RESTRICT_VIOLATION = "23001";

const REASON = "Återläsning av säkerhetskopia";

describe("void ranges", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let reader: Client;
  const who = someUser();
  const restorer = someSystemUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    reader = await db.connect("readerA");
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

  async function nextNumber(company: string, series: VoucherSeries): Promise<number | undefined> {
    return (await counterOf(app, company, series.id))?.next_number;
  }

  async function rangesOf(company: string): Promise<VoidRange[]> {
    return inTransaction(app, { company }, async () => {
      const found = await app.query<VoidRange>(`SELECT ${VOID_RANGE_COLUMNS} FROM ledger.void_ranges ORDER BY first_number`);
      return found.rows;
    });
  }

  /** Records a void range as the owner, in its own transaction, with these settings. */
  async function record(settings: Settings, values: readonly unknown[], sql = INSERT_VOID_RANGE): Promise<unknown> {
    return inTransaction(owner, settings, () => owner.query(sql, [...values]));
  }

  it("lets the owner record a void range at the counter, with who recorded it and when, moves the counter past it, and writes its history", async () => {
    const { company, year, series } = await companyWithSeries();
    const { range, transaction, started } = await inTransaction(owner, { company, ...restorer }, async () => {
      const found = await owner.query<VoidRange>(INSERT_VOID_RANGE, [company, year, "A", 1, 3, REASON]);
      const stamp = await owner.query<{ transaction: string; started: string }>(
        "SELECT pg_catalog.pg_current_xact_id()::text AS transaction, pg_catalog.transaction_timestamp()::text AS started",
      );
      return { range: found.rows[0], transaction: stamp.rows[0]?.transaction, started: stamp.rows[0]?.started ?? "" };
    });
    expect(range).toEqual({
      id: range?.id,
      company_id: company,
      fiscal_year_id: year,
      series_code: "A",
      first_number: 1,
      last_number: 3,
      reason: REASON,
      created_at: range?.created_at,
      created_by: restorer.actor,
      created_by_kind: "system",
      created_xact: transaction,
    });
    expect(await isAfter(app, range?.created_at ?? "", started)).toBe(true);
    expect(await nextNumber(company, series)).toBe(4);
    const { rangeRow, counterRow, history } = await inTransaction(app, { company }, async () => {
      const ranges = await app.query<{ row: Record<string, unknown> }>("SELECT pg_catalog.to_jsonb(t) AS row FROM ledger.void_ranges AS t");
      const counters = await app.query<{ row: Record<string, unknown> }>("SELECT pg_catalog.to_jsonb(t) AS row FROM ledger.voucher_counters AS t");
      const found = await app.query<{
        table_name: string;
        operation: string;
        old_values: unknown;
        new_values: unknown;
        actor_id: string;
        actor_kind: string;
        transaction: string;
      }>(
        `SELECT table_name, operation, old_values, new_values, actor_id, actor_kind, transaction_id::text AS transaction
         FROM audit.history
         WHERE table_name = 'ledger.void_ranges' OR (table_name = 'ledger.voucher_counters' AND operation = 'UPDATE')
         ORDER BY table_name`,
      );
      return { rangeRow: ranges.rows[0]?.row, counterRow: counters.rows[0]?.row, history: found.rows };
    });
    expect(history).toEqual([
      { table_name: "ledger.void_ranges", operation: "INSERT", old_values: null, new_values: rangeRow, actor_id: restorer.actor, actor_kind: "system", transaction },
      {
        table_name: "ledger.voucher_counters",
        operation: "UPDATE",
        old_values: { ...counterRow, next_number: 1 },
        new_values: counterRow,
        actor_id: restorer.actor,
        actor_kind: "system",
        transaction,
      },
    ]);
    expect(rangeRow).toMatchObject({ id: range?.id, first_number: 1, last_number: 3, reason: REASON, created_by: restorer.actor });
    expect(counterRow).toMatchObject({ series_id: series.id, next_number: 4 });
    // The next range starts where this one left the counter.
    await recordVoidRange(owner, company, { year, code: "A", first: 4, last: 10 });
    expect(await nextNumber(company, series)).toBe(11);
    expect((await rangesOf(company)).map((row) => [row.first_number, row.last_number])).toEqual([
      [1, 3],
      [4, 10],
    ]);
  });

  it("refuses a void range that does not start at the counter, and leaves the counter as it was", async () => {
    const { company, year, series } = await companyWithSeries();
    await expectRefusal(record({ company, ...restorer }, [company, year, "A", 2, 5, REASON]), "void_range_not_at_counter", {
      first_number: 2,
      next_number: 1,
    });
    await recordVoidRange(owner, company, { year, code: "A", first: 1, last: 3 });
    // Over numbers already skipped, inside them, and past the counter, which would leave a gap.
    for (const [first, last] of [
      [1, 5],
      [3, 3],
      [2, 9],
      [5, 9],
    ] as const) {
      await expectRefusal(record({ company, ...restorer }, [company, year, "A", first, last, REASON]), "void_range_not_at_counter", {
        first_number: first,
        next_number: 4,
      });
    }
    expect(await nextNumber(company, series)).toBe(4);
    expect((await rangesOf(company)).length).toBe(1);
  });

  it("refuses a range that ends before it starts, an empty reason, a series that is not there, stamps given by the caller, and no actor", async () => {
    const { company, year, series } = await companyWithSeries();
    const other = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    const settings = { company, ...restorer };
    await expectError(record(settings, [company, year, "A", 1, 0, REASON]), CHECK_VIOLATION, /void_ranges_numbers_in_order/);
    await expectError(record(settings, [company, year, "A", 1, 1, ""]), CHECK_VIOLATION, /void_ranges_reason_given/);
    await expectError(record(settings, [company, year, "B", 1, 1, REASON]), FOREIGN_KEY_VIOLATION, /void_ranges_series/);
    await expectError(record(settings, [company, other.id, "A", 1, 1, REASON]), FOREIGN_KEY_VIOLATION, /void_ranges_series/);
    for (const [column, value] of [
      ["created_at", "2090-01-01"],
      ["created_by", restorer.actor],
      ["created_by_kind", "system"],
      ["created_xact", "1"],
    ] as const) {
      await expectRefusal(
        record(
          settings,
          [company, year, "A", 1, 1, REASON, value],
          `INSERT INTO ledger.void_ranges (company_id, fiscal_year_id, series_code, first_number, last_number, reason, ${column})
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ),
        "immutable_field",
        { field: column, operation: "create" },
      );
    }
    await expectRefusal(record({ company }, [company, year, "A", 1, 1, REASON]), "actor_missing", { setting: "nortfox.actor_id" });
    expect(await nextNumber(company, series)).toBe(1);
    expect(await rangesOf(company)).toEqual([]);
  });

  it("refuses the app and a reader to record, change or delete a void range: they have no privilege", async () => {
    const { company, year, series } = await companyWithSeries();
    await recordVoidRange(owner, company, { year, code: "A", first: 1, last: 2 });
    for (const client of [app, reader]) {
      for (const [sql, params] of [
        [INSERT_VOID_RANGE, [company, year, "A", 3, 3, REASON]],
        ["UPDATE ledger.void_ranges SET reason = 'Ändrad'", []],
        ["UPDATE ledger.void_ranges SET last_number = 1", []],
        ["DELETE FROM ledger.void_ranges", []],
      ] as const) {
        await expectError(
          inTransaction(client, { company, ...who }, () => client.query(sql, [...params])),
          INSUFFICIENT_PRIVILEGE,
          /permission denied/,
        );
      }
    }
    expect(await nextNumber(company, series)).toBe(3);
    expect((await rangesOf(company)).map((row) => [row.first_number, row.last_number, row.reason])).toEqual([[1, 2, REASON]]);
  });

  it("refuses the owner too to change or delete a void range", async () => {
    const { company, year, series } = await companyWithSeries();
    const range = await recordVoidRange(owner, company, { year, code: "A", first: 1, last: 2 });
    for (const [sql, operation] of [
      ["UPDATE ledger.void_ranges SET reason = 'Ändrad' WHERE id = $1", "UPDATE"],
      ["UPDATE ledger.void_ranges SET last_number = 1 WHERE id = $1", "UPDATE"],
      ["UPDATE ledger.void_ranges SET reason = reason WHERE id = $1", "UPDATE"],
      ["DELETE FROM ledger.void_ranges WHERE id = $1", "DELETE"],
    ] as const) {
      await expectRefusal(inTransaction(owner, { company, ...restorer }, () => owner.query(sql, [range.id])), "append_only", {
        table: "ledger.void_ranges",
        operation,
      });
    }
    expect(await rangesOf(company)).toEqual([range]);
    expect(await nextNumber(company, series)).toBe(3);
  });

  it("keeps a series that holds a void range: it cannot be removed", async () => {
    const { company, year, series } = await companyWithSeries();
    await recordVoidRange(owner, company, { year, code: "A", first: 1, last: 1 });
    await expectError(
      inTransaction(app, { company, ...who }, () => app.query("DELETE FROM ledger.voucher_series WHERE id = $1", [series.id])),
      RESTRICT_VIOLATION,
      /void_ranges_series/,
    );
    expect(await nextNumber(company, series)).toBe(2);
  });

  it("records the second of two void ranges made at the same time only from where the first left the counter", async () => {
    const { company, year, series } = await companyWithSeries();
    const other = await db.connect("owner");
    const otherPid = await backendPid(other);
    await begin(owner, { company, ...restorer });
    await begin(other, { company, ...restorer });
    try {
      await owner.query(INSERT_VOID_RANGE, [company, year, "A", 1, 2, REASON]);
      // The second waits on the counter's row until the first commits, then reads the counter it left.
      const second = expectRefusal(other.query(INSERT_VOID_RANGE, [company, year, "A", 1, 5, REASON]), "void_range_not_at_counter", {
        first_number: 1,
        next_number: 3,
      });
      await untilWaitingForLock(owner, otherPid);
      await owner.query("COMMIT");
      await second;
    } finally {
      await other.query("ROLLBACK");
      await owner.query("ROLLBACK");
    }
    expect(await nextNumber(company, series)).toBe(3);
    expect((await rangesOf(company)).map((row) => [row.first_number, row.last_number])).toEqual([[1, 2]]);
  });

  it("keeps each series' counter to its own series and year", async () => {
    const { company, year, series } = await companyWithSeries();
    const b = await addSeries(app, company, year, { code: "B" }, who);
    const next = await addFiscalYear(app, company, { from: "2091-01-01", to: "2091-12-31" });
    const nextA = await addSeries(app, company, next.id, { code: "A" }, who);
    await recordVoidRange(owner, company, { year, code: "A", first: 1, last: 7 });
    expect([await nextNumber(company, series), await nextNumber(company, b), await nextNumber(company, nextA)]).toEqual([8, 1, 1]);
    await recordVoidRange(owner, company, { year: next.id, code: "A", first: 1, last: 2 }, { actor: randomUUID(), kind: "user" });
    expect([await nextNumber(company, series), await nextNumber(company, b), await nextNumber(company, nextA)]).toEqual([8, 1, 3]);
  });
});
