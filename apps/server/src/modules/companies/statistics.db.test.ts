// SPDX-License-Identifier: AGPL-3.0-only

// The planner's statistics tell no role anything of another company's rows
// (docs/decisions/0009). ANALYZE keeps the most common values and a histogram
// of each column in pg_statistic, of every company's rows together, and
// autovacuum runs it by itself. Under row level security the planner still
// reads them for an operator that is leakproof, such as = and < on text and
// on integers, and EXPLAIN shows its row estimates to every role that may
// read the table. So no company table keeps statistics of its values: each
// column, and each expression column of its indexes, has a statistics target
// of 0. The table guard checks it.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { fillEveryTable, type Scenario } from "../../../test/every-table.ts";

/** A name that only company B's accounts have, 150 of them, numbered from 5000. */
const SECRET = "Hemlig affär Zeta";

interface Explained {
  readonly "QUERY PLAN": readonly { readonly Plan: { readonly "Plan Rows": number } }[];
}

describe("the planner's statistics", () => {
  let db: TestDatabase;
  let scenario: Scenario;
  let admin: Client;
  let reader: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    scenario = await fillEveryTable(db);
    const app = await db.connect("app");
    const yearB = scenario.years[scenario.companyB];
    await inTransaction(app, { company: scenario.companyB, actor: randomUUID(), kind: "user" }, () =>
      app.query(
        `INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description)
         SELECT $1, $2, 5000 + n, $3 FROM pg_catalog.generate_series(0, 149) AS n`,
        [scenario.companyB, yearB, SECRET],
      ),
    );
    // As autovacuum would, in an install.
    admin = await db.admin();
    await admin.query("ANALYZE");
    // Reader A is bound to company A.
    reader = await db.connect("readerA");
  });

  afterAll(async () => {
    await db.close();
  });

  it("keeps none, after ANALYZE, of a company table's columns or of its indexes' expressions", async () => {
    const kept = await admin.query<{ kept: string }>(`
      SELECT DISTINCT n.nspname || '.' || c.relname || ' ' || s.staattnum::text AS kept
      FROM pg_catalog.pg_statistic AS s
      JOIN pg_catalog.pg_class AS c ON c.oid = s.starelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_index AS x ON x.indexrelid = c.oid
      WHERE EXISTS (
        SELECT FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = COALESCE(x.indrelid, c.oid) AND a.attname = 'company_id' AND a.attnum > 0 AND NOT a.attisdropped
      )
      ORDER BY 1`);
    expect(kept.rows.map((row) => row.kept)).toEqual([]);
    // ANALYZE ran: it counted the rows, and kept statistics of a table without company data.
    const counted = await admin.query<{ rows: number }>("SELECT reltuples::integer AS rows FROM pg_catalog.pg_class WHERE oid = 'ledger.accounts'::pg_catalog.regclass");
    expect(counted.rows[0]?.rows).toBeGreaterThan(150);
    const migrations = await admin.query<{ count: bigint }>(
      "SELECT count(*) AS count FROM pg_catalog.pg_statistic WHERE starelid = 'meta.schema_migrations'::pg_catalog.regclass",
    );
    expect(migrations.rows[0]?.count).toBeGreaterThan(0n);
  });

  // ANALYZE counts the rows of each index too, and keeps the count in
  // pg_class, which every role reads. A partial index would count the rows of
  // every company that meet its condition, such as the reversing vouchers.
  // So each index of a company table holds every row of its table.
  it("counts every row of its table in each index of a company table, so no index tells a reader how many rows of every company hold a value", async () => {
    const found = await reader.query<{ index: string }>(`
      SELECT i.oid::pg_catalog.regclass::text AS index
      FROM pg_catalog.pg_index AS x
      JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid
      JOIN pg_catalog.pg_class AS t ON t.oid = x.indrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
      WHERE n.nspname IN ('ledger', 'audit')
        AND EXISTS (
          SELECT FROM pg_catalog.pg_attribute AS a
          WHERE a.attrelid = t.oid AND a.attname = 'company_id' AND a.attnum > 0 AND NOT a.attisdropped
        )
        AND (t.reltuples < 0 OR i.reltuples < t.reltuples)
      ORDER BY 1`);
    expect(found.rows.map((row) => row.index)).toEqual([]);
    // The reversing vouchers, one of A's: the table holds more vouchers than that.
    const vouchers = await reader.query<{ rows: number }>("SELECT reltuples::integer AS rows FROM pg_catalog.pg_class WHERE oid = 'ledger.vouchers'::pg_catalog.regclass");
    expect(vouchers.rows[0]?.rows).toBeGreaterThan(1);
  });

  /** The planner's row estimate for `sql`, as the reader's EXPLAIN shows it. */
  async function estimate(sql: string): Promise<number> {
    const found = await reader.query<Explained>(`EXPLAIN (FORMAT JSON) ${sql}`);
    const rows = found.rows[0]?.["QUERY PLAN"][0]?.Plan["Plan Rows"];
    if (rows === undefined) {
      throw new Error("EXPLAIN gave no row estimate.");
    }
    return rows;
  }

  it("gives a reader the same estimates for another company's values as for values that no company has", async () => {
    // A frequent value: B's name against one that no account has.
    expect(await estimate(`SELECT * FROM ledger.accounts WHERE description = '${SECRET}'`)).toBe(
      await estimate("SELECT * FROM ledger.accounts WHERE description = 'Hemlig affär Eta'"),
    );
    // Range bounds just below and just above B's name, which would pin it by a binary search.
    expect(await estimate(`SELECT * FROM ledger.accounts WHERE description < '${SECRET}'`)).toBe(
      await estimate("SELECT * FROM ledger.accounts WHERE description < 'Hemlig affär Zetb'"),
    );
    // Range bounds around B's account numbers.
    expect(await estimate("SELECT * FROM ledger.accounts WHERE number < 5000")).toBe(await estimate("SELECT * FROM ledger.accounts WHERE number < 5150"));
    // The reader reads none of B's accounts.
    const seen = await reader.query<{ count: bigint }>("SELECT count(*) AS count FROM ledger.accounts WHERE description = $1", [SECRET]);
    expect(seen.rows[0]?.count).toBe(0n);
  });
});
