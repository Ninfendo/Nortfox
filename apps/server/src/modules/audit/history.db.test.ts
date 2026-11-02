// SPDX-License-Identifier: AGPL-3.0-only

// The behandlingshistorik (docs/decisions/0002): triggers write one row per
// row change of every company table, with the actor, and no role changes or
// deletes it. The tables come from the catalog, so a new table is covered as
// soon as test/every-table.ts fills it.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { APP_WRITES, KEYS, companyTables, fillEveryTable, type Scenario } from "../../../test/every-table.ts";
import { GUARD_EXCEPTIONS } from "../../db/table-guard.ts";

describe("the behandlingshistorik", () => {
  let db: TestDatabase;
  let scenario: Scenario;
  let app: Client;
  let owner: Client;
  let reader: Client;
  const actor = randomUUID();

  beforeAll(async () => {
    db = await freshDatabase();
    scenario = await fillEveryTable(db);
    app = await db.connect("app");
    owner = await db.connect("owner");
    reader = await db.connect("readerA");
  });

  afterAll(async () => {
    await db.close();
  });

  /** The company tables that have a history trigger: all but the one the table guard excepts, the history itself. */
  async function historyTables(): Promise<string[]> {
    return (await companyTables(app)).filter((table) => GUARD_EXCEPTIONS.get(table)?.kind !== "no history trigger");
  }

  async function historyCount(company: string): Promise<number> {
    return inTransaction(app, { company }, async () => {
      const found = await app.query<{ count: bigint }>("SELECT count(*) AS count FROM audit.history");
      return Number(found.rows[0]?.count);
    });
  }

  it("has a key for every company table, and excepts only the history itself from the history trigger", async () => {
    expect([...(await companyTables(app))].sort()).toEqual(Object.keys(KEYS).sort());
    const withHistory = await historyTables();
    expect((await companyTables(app)).filter((table) => !withHistory.includes(table))).toEqual(["audit.history"]);
  });

  it("holds an INSERT row for every company table, after the scenario wrote one", async () => {
    for (const table of await historyTables()) {
      const inserts = scenario.changes.filter((change) => change.table === table && change.operation === "INSERT");
      expect(inserts.length, `the scenario inserts into ${table}`).toBeGreaterThan(0);
    }
  });

  it("holds each insert, update and delete with the operation, the old and new row, the actor, its kind, the transaction and the time", async () => {
    for (const change of scenario.changes) {
      const found = await inTransaction(app, { company: change.company }, async () =>
        app.query<{ count: bigint }>(
          `SELECT count(*) AS count FROM audit.history
           WHERE company_id = $1 AND table_name = $2 AND row_id = $3 AND operation = $4
             AND old_values IS NOT DISTINCT FROM $5::jsonb AND new_values IS NOT DISTINCT FROM $6::jsonb
             AND actor_id = $7 AND actor_kind = $8 AND transaction_id = $9::xid8
             AND at >= $10::timestamptz AND at <= $11::timestamptz`,
          [
            change.company,
            change.table,
            change.rowId,
            change.operation,
            change.oldValues === null ? null : JSON.stringify(change.oldValues),
            change.newValues === null ? null : JSON.stringify(change.newValues),
            change.actor,
            change.kind,
            change.transaction,
            change.startedAt,
            change.changedBy,
          ],
        ),
      );
      expect(found.rows[0]?.count, `${change.operation} on ${change.table}`).toBe(1n);
    }
    expect(scenario.changes.map((change) => change.operation)).toContain("DELETE");
    expect(new Set(scenario.changes.map((change) => change.kind))).toEqual(new Set(["user", "system", "integration"]));
    // No row more than the changes: each change wrote exactly one.
    for (const company of [scenario.companyA, scenario.companyB]) {
      expect(await historyCount(company)).toBe(scenario.changes.filter((change) => change.company === company).length);
    }
  });

  it("refuses a write with no actor, on every table the app can write", async () => {
    const writable = await app.query<{ relation: string; privilege: string }>(`
      SELECT n.nspname || '.' || c.relname AS relation, p.privilege
      FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) AS p (privilege)
      WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('ledger', 'audit', 'meta')
        AND pg_catalog.has_table_privilege('nortfox_app', c.oid, p.privilege)
      ORDER BY 1, 2`);
    expect(writable.rows.length).toBeGreaterThan(0);
    const before = await historyCount(scenario.companyA);
    for (const { relation, privilege } of writable.rows) {
      const build = APP_WRITES[relation]?.[privilege as "INSERT" | "UPDATE" | "DELETE"];
      expect(build, `test/every-table.ts has an app write for ${privilege} on ${relation}`).toBeDefined();
      for (const [settings, setting] of [
        [{}, "nortfox.actor_id"],
        [{ kind: "user" }, "nortfox.actor_id"],
        [{ actor: "", kind: "user" }, "nortfox.actor_id"],
        [{ actor }, "nortfox.actor_kind"],
        [{ actor, kind: "" }, "nortfox.actor_kind"],
        [{ actor, kind: "robot" }, "nortfox.actor_kind"],
      ] as const) {
        const write = build?.(scenario);
        await expectRefusal(
          inTransaction(app, { company: write?.company ?? "", ...settings }, () => app.query(write?.sql ?? "", [...(write?.params ?? [])])),
          "actor_missing",
          { setting },
        );
      }
    }
    // The owner's writes need an actor too.
    await expectRefusal(
      inTransaction(owner, { company: scenario.companyA }, () =>
        owner.query("INSERT INTO ledger.reader_roles (company_id, role_name) VALUES ($1, 'nortfox_test_reader_c')", [scenario.companyA]),
      ),
      "actor_missing",
      { setting: "nortfox.actor_id" },
    );
    expect(await historyCount(scenario.companyA)).toBe(before);
  });

  it("lets neither the app nor a reader write, change, delete or empty a history row", async () => {
    for (const client of [app, reader]) {
      for (const sql of [
        "UPDATE audit.history SET actor_kind = 'user'",
        "DELETE FROM audit.history",
        "TRUNCATE audit.history",
        `INSERT INTO audit.history (company_id, table_name, row_id, operation, new_values, actor_id, actor_kind, transaction_id, at)
         VALUES ($1, 'ledger.companies', $1, 'INSERT', '{}', $1, 'user', pg_catalog.pg_current_xact_id(), pg_catalog.clock_timestamp())`,
      ]) {
        await expectError(
          inTransaction(client, { company: scenario.companyA, actor, kind: "user" }, () =>
            client.query(sql, sql.includes("$1") ? [scenario.companyA] : []),
          ),
          INSUFFICIENT_PRIVILEGE,
          /permission denied/,
        );
      }
    }
  });

  it("refuses the owner too: a history row is only written by the trigger, and stays as written", async () => {
    const settings = { company: scenario.companyA, actor, kind: "system" } as const;
    await expectRefusal(
      inTransaction(owner, settings, () => owner.query("UPDATE audit.history SET actor_kind = 'user'")),
      "append_only",
      { table: "audit.history", operation: "UPDATE" },
    );
    await expectRefusal(inTransaction(owner, settings, () => owner.query("DELETE FROM audit.history")), "append_only", {
      table: "audit.history",
      operation: "DELETE",
    });
    await expectRefusal(inTransaction(owner, settings, () => owner.query("TRUNCATE audit.history")), "append_only", {
      table: "audit.history",
      operation: "TRUNCATE",
    });
    await expectRefusal(
      inTransaction(owner, settings, () =>
        owner.query(
          `INSERT INTO audit.history (company_id, table_name, row_id, operation, new_values, actor_id, actor_kind, transaction_id, at)
           VALUES ($1, 'ledger.companies', $1, 'INSERT', '{}', $1, 'user', pg_catalog.pg_current_xact_id(), pg_catalog.clock_timestamp())`,
          [scenario.companyA],
        ),
      ),
      "internal_only",
      { table: "audit.history", field: null },
    );
  });

  it("refuses TRUNCATE, which skips the row triggers, on every company table, for the owner too", async () => {
    for (const table of await companyTables(app)) {
      await expectRefusal(
        inTransaction(owner, { company: scenario.companyA, actor, kind: "system" }, () => owner.query(`TRUNCATE ${table} CASCADE`)),
        "append_only",
        { table, operation: "TRUNCATE" },
      );
    }
  });
});
