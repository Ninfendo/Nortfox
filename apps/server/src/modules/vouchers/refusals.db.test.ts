// SPDX-License-Identifier: AGPL-3.0-only

// The refusals of rule 44 of the slice: each reason is raised by a real write,
// as the app role, with the facts that the rule names for it. The series'
// reasons come first. The voucher's reasons come with the vouchers, and then a
// last test checks that the cases cover the whole list.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addCompany, addFiscalYear, addSeries, someUser } from "../../../test/ledger.ts";
import { REFUSALS, type RefusalReason } from "../../db/refusals.ts";

/** The reasons of rule 44, NF001 to NF020, which later slices answer with the established system's messages. */
const RULE_44: readonly RefusalReason[] = REFUSALS.filter(({ code }) => Number(code.slice(2)) <= 20).map(({ reason }) => reason);

/** What every case writes in: a company with the fiscal year 2090 and its series A. */
interface Ledger {
  readonly company: string;
  readonly year: string;
  readonly series: string;
}

interface Case {
  readonly reason: RefusalReason;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly sql: string;
  readonly params: (ledger: Ledger) => readonly unknown[];
}

const TOO_LONG_NAME = "N".repeat(201);

const CASES: readonly Case[] = [
  {
    reason: "value_too_long",
    facts: { field: "description", value: TOO_LONG_NAME },
    sql: "UPDATE ledger.voucher_series SET description = $2 WHERE id = $1",
    params: (ledger) => [ledger.series, TOO_LONG_NAME],
  },
  {
    reason: "series_code_invalid",
    facts: { code: "a" },
    sql: "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'a', '', true)",
    params: (ledger) => [ledger.company, ledger.year],
  },
  {
    reason: "series_code_duplicate",
    facts: { code: "A" },
    sql: "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'A', '', true)",
    params: (ledger) => [ledger.company, ledger.year],
  },
  {
    reason: "series_code_changed",
    facts: { code: "A" },
    sql: "UPDATE ledger.voucher_series SET code = 'B' WHERE id = $1",
    params: (ledger) => [ledger.series],
  },
];

describe("the refusals of rule 44", () => {
  let db: TestDatabase;
  let app: Client;
  let ledger: Ledger;
  const who = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    const company = await addCompany(app, who);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" }, who);
    const series = await addSeries(app, company, year.id, { code: "A" }, who);
    ledger = { company, year: year.id, series: series.id };
  });

  afterAll(async () => {
    await db.close();
  });

  it.each(CASES.map((refusal) => [refusal.reason, refusal] as const))("raises %s with its facts", async (_reason, refusal) => {
    await expectRefusal(
      inTransaction(app, { company: ledger.company, ...who }, () => app.query(refusal.sql, [...refusal.params(ledger)])),
      refusal.reason,
      refusal.facts,
    );
  });

  it("raises only reasons of rule 44, each in one case", () => {
    const reasons = CASES.map((refusal) => refusal.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons.filter((reason) => !RULE_44.includes(reason))).toEqual([]);
    expect(RULE_44.length).toBe(20);
  });
});
