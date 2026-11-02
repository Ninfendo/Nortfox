// SPDX-License-Identifier: AGPL-3.0-only

// A fiscal year's periods (rule 8 of the slice): each lies inside its year,
// two periods of one year never overlap, and a year's dates never change so
// that a period falls outside it.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  EXCLUSION_VIOLATION,
  backendPid,
  begin,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  untilWaitingForLock,
  type TestDatabase,
} from "../../../test/database.ts";
import { addCompany, addFiscalYear, addPeriod, someUser } from "../../../test/ledger.ts";

describe("periods", () => {
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

  /** A company with the fiscal year 2090. */
  async function companyWithYear(): Promise<{ company: string; year: string }> {
    const company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    return { company, year: year.id };
  }

  async function asApp(company: string, sql: string, params: readonly unknown[] = []): Promise<unknown[]> {
    return inTransaction(app, { company, ...who }, async () => (await app.query<Record<string, unknown>>(sql, [...params])).rows);
  }

  it("stores a year's periods with their dates", async () => {
    const { company, year } = await companyWithYear();
    const january = await addPeriod(app, company, year, "2090-01-01", "2090-01-31");
    const december = await addPeriod(app, company, year, "2090-12-01", "2090-12-31");
    expect(
      await asApp(company, "SELECT id, fiscal_year_id, from_date::text AS from_date, to_date::text AS to_date FROM ledger.periods ORDER BY from_date"),
    ).toEqual([
      { id: january, fiscal_year_id: year, from_date: "2090-01-01", to_date: "2090-01-31" },
      { id: december, fiscal_year_id: year, from_date: "2090-12-01", to_date: "2090-12-31" },
    ]);
  });

  it("refuses a period that reaches outside its fiscal year, with its dates", async () => {
    const { company, year } = await companyWithYear();
    for (const [from, to] of [
      ["2089-12-31", "2090-01-31"],
      ["2090-12-01", "2091-01-01"],
      ["2089-12-01", "2091-01-31"],
      ["2091-01-01", "2091-01-31"],
    ] as const) {
      await expectRefusal(addPeriod(app, company, year, from, to), "period_outside_fiscal_year", { from_date: from, to_date: to });
    }
  });

  it("refuses a change that moves a period outside its fiscal year", async () => {
    const { company, year } = await companyWithYear();
    const period = await addPeriod(app, company, year, "2090-12-01", "2090-12-31");
    await expectRefusal(asApp(company, "UPDATE ledger.periods SET to_date = '2091-01-31' WHERE id = $1", [period]), "period_outside_fiscal_year", {
      from_date: "2090-12-01",
      to_date: "2091-01-31",
    });
    await asApp(company, "UPDATE ledger.periods SET from_date = '2090-12-15' WHERE id = $1", [period]);
  });

  it("refuses a period that ends before it starts, and one of a year that does not exist", async () => {
    const { company, year } = await companyWithYear();
    await expectError(addPeriod(app, company, year, "2090-02-01", "2090-01-31"), CHECK_VIOLATION);
    await expectError(addPeriod(app, company, randomUUID(), "2090-01-01", "2090-01-31"), "23503");
  });

  it("refuses two overlapping periods of one year, also when they share one day, by insert and by a change", async () => {
    const { company, year } = await companyWithYear();
    await addPeriod(app, company, year, "2090-02-01", "2090-02-28");
    for (const [from, to] of [
      ["2090-02-01", "2090-02-28"],
      ["2090-01-15", "2090-02-01"],
      ["2090-02-28", "2090-03-31"],
      ["2090-02-10", "2090-02-11"],
      ["2090-01-01", "2090-12-31"],
    ] as const) {
      await expectError(addPeriod(app, company, year, from, to), EXCLUSION_VIOLATION, /periods_no_overlap/);
    }
    const january = await addPeriod(app, company, year, "2090-01-01", "2090-01-31");
    await addPeriod(app, company, year, "2090-03-01", "2090-03-31");
    await expectError(
      asApp(company, "UPDATE ledger.periods SET to_date = '2090-02-01' WHERE id = $1", [january]),
      EXCLUSION_VIOLATION,
      /periods_no_overlap/,
    );
  });

  it("lets another company's year have periods on the same dates", async () => {
    const first = await companyWithYear();
    const second = await companyWithYear();
    await addPeriod(app, first.company, first.year, "2090-01-01", "2090-01-31");
    await addPeriod(app, second.company, second.year, "2090-01-01", "2090-01-31");
  });

  it("refuses new dates for a year that would leave any of its periods outside, with the count", async () => {
    const { company, year } = await companyWithYear();
    await addPeriod(app, company, year, "2090-01-01", "2090-01-31");
    await addPeriod(app, company, year, "2090-11-01", "2090-11-30");
    await addPeriod(app, company, year, "2090-12-01", "2090-12-31");
    for (const [set, count] of [
      ["to_date = '2090-11-30'", 1],
      ["to_date = '2090-10-31'", 2],
      ["from_date = '2090-01-02'", 1],
      ["from_date = '2090-02-01', to_date = '2090-11-29'", 3],
      ["from_date = '2091-01-01', to_date = '2091-12-31'", 3],
    ] as const) {
      await expectRefusal(asApp(company, `UPDATE ledger.fiscal_years SET ${set} WHERE id = $1`, [year]), "fiscal_year_strands_rows", {
        table: "ledger.periods",
        count,
      });
    }
    // New dates that keep every period inside are accepted.
    await asApp(company, "UPDATE ledger.fiscal_years SET from_date = '2089-07-01', to_date = '2091-06-30' WHERE id = $1", [year]);
    await asApp(company, "UPDATE ledger.fiscal_years SET from_date = '2090-01-01', to_date = '2090-12-31' WHERE id = $1", [year]);
  });

  it("holds when a year's dates and a period change at the same time: the period waits for the year, and is refused outside it", async () => {
    const { company, year } = await companyWithYear();
    const other = await db.connect("app");
    const otherPid = await backendPid(other);
    await begin(app, { company, ...who });
    await app.query("UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1", [year]);
    await begin(other, { company, ...who });
    const added = expectRefusal(
      other.query("INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, '2090-12-01', '2090-12-31')", [
        company,
        year,
      ]),
      "period_outside_fiscal_year",
      { from_date: "2090-12-01", to_date: "2090-12-31" },
    );
    await untilWaitingForLock(app, otherPid);
    await app.query("COMMIT");
    await added;
    await other.query("ROLLBACK");
  });

  it("holds when a period and a year's dates change at the same time: the year waits for the period, and its change is refused", async () => {
    const { company, year } = await companyWithYear();
    const other = await db.connect("app");
    const otherPid = await backendPid(other);
    await begin(app, { company, ...who });
    await app.query("INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, '2090-12-01', '2090-12-31')", [
      company,
      year,
    ]);
    await begin(other, { company, ...who });
    const shrunk = expectRefusal(other.query("UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1", [year]), "fiscal_year_strands_rows", {
      table: "ledger.periods",
      count: 1,
    });
    await untilWaitingForLock(app, otherPid);
    await app.query("COMMIT");
    await shrunk;
    await other.query("ROLLBACK");
  });

  it("lets the app change a period's dates inside its year, but never its id, and never delete a period", async () => {
    const { company, year } = await companyWithYear();
    const period = await addPeriod(app, company, year, "2090-01-01", "2090-01-31");
    await asApp(company, "UPDATE ledger.periods SET to_date = '2090-01-30' WHERE id = $1", [period]);
    await expectRefusal(asApp(company, "UPDATE ledger.periods SET id = $2 WHERE id = $1", [period, randomUUID()]), "immutable_field", {
      field: "id",
      operation: "update",
    });
    await expectError(asApp(company, "DELETE FROM ledger.periods WHERE id = $1", [period]), "42501", /permission denied/);
    expect(await asApp(company, "SELECT id, to_date::text AS to_date FROM ledger.periods")).toEqual([{ id: period, to_date: "2090-01-30" }]);
  });
});
