// SPDX-License-Identifier: AGPL-3.0-only

// Each company sees only its own rows (docs/decisions/0009). These tests read
// the list of company tables from the catalog, so a new table is covered as
// soon as test/every-table.ts fills it.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSUFFICIENT_PRIVILEGE,
  ROLES,
  expectError,
  expectRefusal,
  failureOf,
  freshDatabase,
  inTransaction,
  type Role,
  type TestDatabase,
} from "../../../test/database.ts";
import { ROW_INSERTS, TRIGGER_ONLY_INSERTS, companyTables, fillEveryTable, type Scenario } from "../../../test/every-table.ts";
import { addCompany, addFiscalYear, addPeriod, setLock } from "../../../test/ledger.ts";

/** PostgreSQL's SQLSTATE for a foreign key that refused a row. */
const FOREIGN_KEY_VIOLATION = "23503";

describe("company isolation", () => {
  let db: TestDatabase;
  let scenario: Scenario;
  let tables: string[];
  const clients: Partial<Record<Role, Client>> = {};
  const actor = randomUUID();

  beforeAll(async () => {
    db = await freshDatabase();
    scenario = await fillEveryTable(db);
    for (const role of ["owner", "app", "readerA", "readerB"] as const) {
      clients[role] = await db.connect(role);
    }
    tables = await companyTables(as("app"));
  });

  afterAll(async () => {
    await db.close();
  });

  function as(role: Role): Client {
    const client = clients[role];
    if (client === undefined) {
      throw new Error(`No connection as ${role}.`);
    }
    return client;
  }

  /** Whether `role` may read `table` at all. */
  async function maySelect(role: Role, table: string): Promise<boolean> {
    const found = await as("owner").query<{ may: boolean }>("SELECT pg_catalog.has_table_privilege($1, $2, 'SELECT') AS may", [ROLES[role], table]);
    return found.rows[0]?.may === true;
  }

  /** The rows of `table` that `role` sees, in one transaction with `company` set, or none set. */
  async function rows(role: Role, table: string, company?: string): Promise<{ company_id: string }[]> {
    const client = as(role);
    return inTransaction(client, company === undefined ? {} : { company }, async () => {
      const found = await client.query<{ company_id: string }>(`SELECT company_id FROM ${table}`);
      return found.rows;
    });
  }

  /** Runs one statement as `role` in its own transaction, with `company` and an actor set, and gives the rows it changed. */
  async function write(role: Role, company: string, sql: string, params: readonly unknown[]): Promise<number | null> {
    const client = as(role);
    return inTransaction(client, { company, actor, kind: "user" }, async () => (await client.query(sql, [...params])).rowCount);
  }

  /** A write that changes no row of the other company: it changes none, or it is refused. */
  async function expectNothingOrRefused(promise: Promise<number | null>): Promise<void> {
    const error = await failureOf(
      promise.then((count) => {
        expect(count).toBe(0);
      }),
    );
    if (error !== undefined) {
      expect((error as { code?: unknown }).code, error instanceof Error ? error.message : "").toBe(INSUFFICIENT_PRIVILEGE);
    }
  }

  it("covers every company table in the catalog", () => {
    expect([...tables].sort()).toEqual(Object.keys(ROW_INSERTS).sort());
  });

  it("returns no rows from any company table when no company is set", async () => {
    for (const table of tables) {
      for (const role of ["owner", "app"] as const) {
        if (await maySelect(role, table)) {
          expect(await rows(role, table), `${role} on ${table}`).toEqual([]);
        } else {
          await expectError(rows(role, table), INSUFFICIENT_PRIVILEGE, /permission denied/);
        }
      }
    }
    // With the company set, the same reads find its rows.
    expect(await rows("app", "ledger.companies", scenario.companyA)).toEqual([{ company_id: scenario.companyA }]);
    expect((await rows("owner", "ledger.reader_roles", scenario.companyA)).length).toBe(1);
  });

  it("shows another company's rows to no one, and lets no one change them or write rows for it", async () => {
    const other = scenario.companyA;
    for (const table of tables) {
      for (const role of ["owner", "app"] as const) {
        if (await maySelect(role, table)) {
          const seen = await rows(role, table, scenario.companyB);
          expect(seen.length, `${role} sees its own rows in ${table}`).toBeGreaterThan(0);
          expect(seen.filter((row) => row.company_id === other), `${role} on ${table}`).toEqual([]);
        }
        await expectNothingOrRefused(write(role, scenario.companyB, `UPDATE ${table} SET company_id = company_id WHERE company_id = $1`, [other]));
        await expectNothingOrRefused(write(role, scenario.companyB, `DELETE FROM ${table} WHERE company_id = $1`, [other]));
        const insert = ROW_INSERTS[table]?.(other, scenario);
        expect(insert, `a row for ${table} in test/every-table.ts`).toBeDefined();
        const inserted = write(role, scenario.companyB, insert?.sql ?? "", insert?.params ?? []);
        // Only the database's own triggers write the history and the counters, so their triggers refuse the owner first.
        const internal = TRIGGER_ONLY_INSERTS[table];
        await (role === "owner" && internal !== undefined
          ? expectRefusal(inserted, "internal_only", internal)
          : expectError(inserted, INSUFFICIENT_PRIVILEGE));
      }
    }
  });

  /** How many rows of each company table, and of the history, each company holds, as the owner sees them. */
  async function rowCounts(companies: readonly string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const company of companies) {
      for (const table of tables) {
        const found = await inTransaction(as("owner"), { company }, () => as("owner").query<{ count: bigint }>(`SELECT count(*) AS count FROM ${table}`));
        counts[`${company} ${table}`] = Number(found.rows[0]?.count);
      }
    }
    return counts;
  }

  it("refuses to move a row to another company by a switch of the company inside the statement, on every company table", async () => {
    const [from, to] = [scenario.companyA, scenario.companyB];
    const before = await rowCounts([from, to]);
    // Row level security lets the old row through while `from` is set. The
    // statement then sets `to`, and the new row is checked against that.
    const move = (table: string): string =>
      `UPDATE ${table} SET company_id = $2::uuid WHERE company_id = $1 AND pg_catalog.set_config('nortfox.company_id', $2::text, true) IS NOT NULL`;
    for (const table of tables) {
      for (const role of ["owner", "app"] as const) {
        const error = await failureOf(write(role, from, move(table), [from, to]));
        expect(error, `${role} moved rows of ${table} to another company`).toBeDefined();
      }
    }
    expect(await rowCounts([from, to])).toEqual(before);
  });

  it("refuses that move with immutable_field where nothing else stops it: a lock date row and an empty fiscal year", async () => {
    const app = as("app");
    const who = { actor, kind: "user" } as const;
    const [from, to] = [await addCompany(app), await addCompany(app)];
    await setLock(app, from, "all", "2090-06-30");
    const year = await addFiscalYear(app, from, { from: "2095-01-01", to: "2095-12-31" });
    const before = await rowCounts([from, to]);
    for (const [table, where] of [
      ["ledger.period_locks", "scope = 'all'"],
      ["ledger.fiscal_years", `id = '${year.id}'`],
    ] as const) {
      await expectRefusal(
        inTransaction(app, { company: from, ...who }, () =>
          app.query(
            `UPDATE ${table} SET company_id = $2::uuid
             WHERE company_id = $1 AND ${where} AND pg_catalog.set_config('nortfox.company_id', $2::text, true) IS NOT NULL`,
            [from, to],
          ),
        ),
        "immutable_field",
        { field: "company_id", operation: "update" },
      );
    }
    expect(await rowCounts([from, to])).toEqual(before);
    const lockedThrough = await inTransaction(app, { company: from }, () =>
      app.query<{ through: string | null }>("SELECT ledger.locked_through($1, 'user', $2, ledger.today_in_sweden())::text AS through", [from, actor]),
    );
    expect(lockedThrough.rows[0]?.through).toBe("2090-06-30");
  });

  it("tells a company nothing about another company's periods: a period that names that company's year gets one error, period or not", async () => {
    const app = as("app");
    const [owner, prober] = [await addCompany(app), await addCompany(app)];
    const theirs = await addFiscalYear(app, owner, { from: "2091-01-01", to: "2091-12-31" });
    await addPeriod(app, owner, theirs.id, "2091-03-01", "2091-03-31");
    const ownYear = await addFiscalYear(app, prober, { from: "2091-01-01", to: "2091-12-31" });
    const ownPeriod = await addPeriod(app, prober, ownYear.id, "2091-01-01", "2091-01-31");
    for (const day of ["2091-03-15", "2091-04-15"]) {
      await expectError(
        inTransaction(app, { company: prober, actor, kind: "user" }, () =>
          app.query("INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, $3, $3)", [prober, theirs.id, day]),
        ),
        FOREIGN_KEY_VIOLATION,
        /periods_company_id_fiscal_year_id_fkey/,
      );
      await expectError(
        inTransaction(app, { company: prober, actor, kind: "user" }, () =>
          app.query("UPDATE ledger.periods SET fiscal_year_id = $2, from_date = $3, to_date = $3 WHERE id = $1", [ownPeriod, theirs.id, day]),
        ),
        FOREIGN_KEY_VIOLATION,
        /periods_company_id_fiscal_year_id_fkey/,
      );
    }
  });

  it("shows a reader only its own company's rows, whatever company it sets, and refuses its every write", async () => {
    const readers = [
      { role: "readerA", own: scenario.companyA, other: scenario.companyB },
      { role: "readerB", own: scenario.companyB, other: scenario.companyA },
    ] as const;
    for (const { role, own, other } of readers) {
      for (const table of tables) {
        expect(await maySelect(role, table), `${role} may read ${table}`).toBe(true);
        for (const company of [other, own, undefined]) {
          const seen = await rows(role, table, company);
          expect(seen.length, `${role} sees its company's rows in ${table}`).toBeGreaterThan(0);
          expect(seen.filter((row) => row.company_id !== own), `${role} on ${table} with ${String(company)} set`).toEqual([]);
        }
        for (const company of [other, own]) {
          const insert = ROW_INSERTS[table]?.(company, scenario);
          await expectError(write(role, company, insert?.sql ?? "", insert?.params ?? []), INSUFFICIENT_PRIVILEGE, /permission denied/);
          await expectError(write(role, company, `UPDATE ${table} SET company_id = company_id`, []), INSUFFICIENT_PRIVILEGE, /permission denied/);
          await expectError(write(role, company, `DELETE FROM ${table}`, []), INSUFFICIENT_PRIVILEGE, /permission denied/);
        }
      }
    }
  });

  it("gives a reader role that is bound to no company nothing", async () => {
    const owner = as("owner");
    await inTransaction(owner, { company: scenario.companyB, actor, kind: "system" }, async () => {
      await owner.query("DELETE FROM ledger.reader_roles WHERE role_name = 'nortfox_test_reader_b'");
    });
    for (const table of tables) {
      expect(await rows("readerB", table, scenario.companyB), table).toEqual([]);
    }
  });
});
