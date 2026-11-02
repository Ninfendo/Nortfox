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
