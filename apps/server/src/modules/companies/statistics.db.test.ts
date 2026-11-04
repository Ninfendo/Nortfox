// SPDX-License-Identifier: AGPL-3.0-only

// The planner's statistics tell no role anything of another company's rows
// (docs/decisions/0009). ANALYZE keeps the most common values and a histogram
// of each column in pg_statistic, of every company's rows together, and
// autovacuum runs it by itself. Under row level security the planner still
// reads them for an operator that is leakproof, such as = and < on text and
// on integers, and EXPLAIN shows its row estimates to every role that may
// read the table. So no company table keeps statistics of its values: each
// column, and each expression column of its indexes, has a statistics target
// of 0. The table guard checks it. EXPLAIN ANALYZE shows real counts too, so
// a reader's policy reads its company once, before any row.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPORARY_ROLE_PREFIX } from "../../../test/cluster.ts";
import { freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { companyTables, fillEveryTable, type Scenario } from "../../../test/every-table.ts";

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
      WHERE n.nspname IN ('ledger', 'audit', 'access')
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

  /**
   * What the reader's EXPLAIN ANALYZE counts for `sql`, run twice so that the
   * first run's work (pruning, hint bits, caches) is done: each plan node's
   * type and every number it shows but a time.
   *
   * A node's pages count its children's too, so each node gives only its
   * own: its pages less its children's. The pages of the policy's subqueries
   * (the InitPlans and what runs under them) are left out. They read the
   * reader's binding and the catalog, never a row of the table, and how many
   * pages they read depends on what the reader's caches of roles hold, which
   * a change of any role in the cluster resets. Their rows and loops stay in.
   */
  async function counts(sql: string): Promise<unknown[]> {
    const run = async (): Promise<unknown[]> => {
      const found = await reader.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
      const nodes: unknown[] = [];
      const walk = (node: Record<string, unknown>, underPolicy: boolean): void => {
        const children = (node["Plans"] as Record<string, unknown>[] | undefined) ?? [];
        const kept: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
          if (key === "Node Type") {
            kept[key] = value;
          } else if (typeof value === "number" && !key.includes("Time")) {
            if (!key.endsWith(" Blocks")) {
              kept[key] = value;
            } else if (!underPolicy) {
              kept[key] = children.reduce((own, child) => own - ((child[key] as number | undefined) ?? 0), value);
            }
          }
        }
        nodes.push(kept);
        for (const child of children) {
          walk(child, underPolicy || child["Parent Relationship"] === "InitPlan");
        }
      };
      walk((found.rows[0]?.["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0]?.Plan ?? {}, false);
      return nodes;
    };
    await run();
    return run();
  }

  /** The pairs of `sql` whose EXPLAIN ANALYZE counts differ for the reader, with both counts. */
  async function differing(pairs: readonly (readonly [string, string])[]): Promise<string[]> {
    const found: string[] = [];
    for (const [one, other] of pairs) {
      const [ofOne, ofOther] = [JSON.stringify(await counts(one)), JSON.stringify(await counts(other))];
      if (ofOne !== ofOther) {
        found.push(`${one}: ${ofOne}, against ${other}: ${ofOther}`);
      }
    }
    return found;
  }

  /** Runs `work` with the reader's scans by index off, so the planner checks every row of a table in one filter. */
  async function scanningEveryRow<T>(work: () => Promise<T>): Promise<T> {
    const kinds = ["enable_indexscan", "enable_indexonlyscan", "enable_bitmapscan", "enable_tidscan"];
    for (const kind of kinds) {
      await reader.query(`SET ${kind} = off`);
    }
    try {
      return await work();
    } finally {
      for (const kind of kinds) {
        await reader.query(`RESET ${kind}`);
      }
    }
  }

  // Under row level security the planner checks a cheap leakproof condition
  // of the reader's own, such as number < 5150, before a costly policy. A
  // policy that ran a query for each row would then run it only for the rows
  // that pass the reader's condition, other companies' rows among them, and
  // EXPLAIN ANALYZE counts the pages that query reads. A policy that read its
  // company once, when the first row passes, would show whether one did. A
  // binary search would then read another company's values. So each reader
  // policy reads its company once for the whole query, before any row.
  it("gives a reader the same counts in EXPLAIN ANALYZE for another company's values as for values that no company has", async () => {
    const pairs = [
      [`SELECT * FROM ledger.accounts WHERE description = '${SECRET}'`, "SELECT * FROM ledger.accounts WHERE description = 'Hemlig affär Eta'"],
      ["SELECT * FROM ledger.accounts WHERE number < 5150", "SELECT * FROM ledger.accounts WHERE number < 5000"],
    ] as const;
    expect(await scanningEveryRow(() => differing(pairs))).toEqual([]);
    expect(await differing(pairs)).toEqual([]);
  });

  // The same on every company table, by a range of one company's id: a range
  // and not =, which the planner would fold into the policy's own =.
  it("gives a reader the same counts in EXPLAIN ANALYZE for another company's rows as for rows that no company has, on every company table", async () => {
    const tables = await companyTables(admin);
    expect(tables.length).toBeGreaterThan(10);
    const nobody = randomUUID();
    const of = (table: string, company: string): string => `SELECT * FROM ${table} WHERE company_id BETWEEN '${company}' AND '${company}'`;
    const pairs = tables.map((table) => [of(table, scenario.companyB), of(table, nobody)] as const);
    expect(await scanningEveryRow(() => differing(pairs))).toEqual([]);
    expect(await differing(pairs)).toEqual([]);
  });

  // A role made, changed or dropped anywhere in the cluster resets every
  // backend's caches of roles, and the reader's next query reads pg_roles
  // again, in its policy's subqueries. So the counts above must not depend on
  // what the reader's caches hold, or the comparison fails now and then, on a
  // correct database, whenever another connection changes a role.
  it("gives a reader the same counts in EXPLAIN ANALYZE while another connection makes and drops roles", async () => {
    const tables = await companyTables(admin);
    const nobody = randomUUID();
    const of = (table: string, company: string): string => `SELECT * FROM ${table} WHERE company_id BETWEEN '${company}' AND '${company}'`;
    const pairs = [
      [`SELECT * FROM ledger.accounts WHERE description = '${SECRET}'`, "SELECT * FROM ledger.accounts WHERE description = 'Hemlig affär Eta'"] as const,
      ...tables.map((table) => [of(table, scenario.companyB), of(table, nobody)] as const),
    ];
    const maker = await db.admin();
    const stop = new AbortController();
    let made = 0;
    const changing = (async () => {
      while (!stop.signal.aborted) {
        const role = `${TEMPORARY_ROLE_PREFIX}${randomBytes(4).toString("hex")}`;
        await maker.query(`CREATE ROLE ${role}`);
        await maker.query(`DROP ROLE ${role}`);
        made += 1;
      }
    })();
    try {
      expect(await scanningEveryRow(() => differing(pairs))).toEqual([]);
      expect(await differing(pairs)).toEqual([]);
    } finally {
      stop.abort();
      await changing;
    }
    expect(made).toBeGreaterThan(pairs.length);
  });

  /** The rows that the filters of the reader's EXPLAIN ANALYZE of `sql` removed, over every plan node. */
  async function removedByFilter(sql: string): Promise<number> {
    const found = await reader.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
    const sum = (node: Record<string, unknown>): number =>
      ((node["Rows Removed by Filter"] as number | undefined) ?? 0) +
      ((node["Plans"] as Record<string, unknown>[] | undefined) ?? []).reduce((total, child) => total + sum(child), 0);
    return sum((found.rows[0]?.["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0]?.Plan ?? {});
  }

  // What PostgreSQL cannot hide (db/README.md). A key of one column leaves
  // company_id out, and EXPLAIN ANALYZE counts the rows that the reader's
  // policy removes after a lookup by that key. So a reader learns whether
  // another company's row holds an id, and how many such rows fall in a range
  // of ids. The history's id only orders the changes of every company, and
  // each other id is random, so they tell a reader nothing else. If this
  // test fails, PostgreSQL hides them now, and db/README.md can say so.
  it("shows a reader, in EXPLAIN ANALYZE, whether another company's row holds an id of a key that leaves company_id out", async () => {
    const ofB = await admin.query<{ id: string }>("SELECT max(id)::text AS id FROM audit.history WHERE company_id = $1", [scenario.companyB]);
    const id = ofB.rows[0]?.id ?? "";
    expect(id).not.toBe("");
    expect(await removedByFilter(`SELECT 1 FROM audit.history WHERE id = ${id}`)).toBe(1);
    expect(await removedByFilter("SELECT 1 FROM audit.history WHERE id = 9000000000000")).toBe(0);
    const seen = await reader.query<{ count: bigint }>(`SELECT count(*) AS count FROM audit.history WHERE id = ${id}`);
    expect(seen.rows[0]?.count).toBe(0n);
  });

  // So no id of a company table may say more than the history's: each uuid
  // key is random, from gen_random_uuid(), or given by the app, which makes
  // it random too. A time-ordered id, such as uuidv7(), would tell a reader
  // when each of another company's rows was made.
  it("makes every uuid key of a company table at random, or leaves it to the app", async () => {
    const found = await admin.query<{ key: string; made: string | null }>(`
      SELECT c.oid::pg_catalog.regclass::text || '.' || a.attname AS key, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS made
      FROM pg_catalog.pg_constraint AS k
      JOIN pg_catalog.pg_class AS c ON c.oid = k.conrelid
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
      LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE k.contype = 'p' AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
        AND EXISTS (SELECT FROM pg_catalog.pg_attribute AS t WHERE t.attrelid = c.oid AND t.attname = 'company_id' AND t.attnum > 0 AND NOT t.attisdropped)
      ORDER BY 1`);
    expect(found.rows.length).toBeGreaterThan(10);
    expect(found.rows.filter((row) => row.made !== "gen_random_uuid()").map((row) => `${row.key} ${row.made ?? "given"}`)).toEqual([
      "ledger.companies.company_id given",
    ]);
  });
});
