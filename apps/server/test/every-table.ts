// SPDX-License-Identifier: AGPL-3.0-only

// One scenario that writes rows in every company table, for the tests that
// take the list of tables from the catalog: isolation and the
// behandlingshistorik. Each build step adds its tables here. Those tests fail
// for a company table in the catalog that this file does not cover.
//
// The companies and the people are made up. The organisation numbers are on
// the fixture guard's list of test values.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { TEST_READERS } from "./cluster.ts";
import { inTransaction, type TestDatabase } from "./database.ts";

export const ACTOR_KINDS = ["user", "system", "integration"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type Row = Record<string, unknown>;

/** A statement and its parameters. */
export interface Write {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** One row change the scenario made, as the behandlingshistorik must show it. */
export interface Change {
  readonly table: string;
  readonly operation: "INSERT" | "UPDATE" | "DELETE";
  readonly company: string;
  readonly rowId: string;
  readonly oldValues: Row | null;
  readonly newValues: Row | null;
  readonly actor: string;
  readonly kind: ActorKind;
  /** pg_current_xact_id() of its transaction, as text. */
  readonly transaction: string;
  /** transaction_timestamp() of its transaction, as text. */
  readonly startedAt: string;
  /** clock_timestamp() just after the change, in its transaction, as text. */
  readonly changedBy: string;
}

export interface Scenario {
  readonly companyA: string;
  readonly companyB: string;
  readonly changes: readonly Change[];
}

/** The key column of each company table: the row's id in the history. */
export const KEYS: Readonly<Record<string, string>> = {
  "ledger.companies": "company_id",
  "ledger.reader_roles": "id",
  "audit.history": "id",
};

/** Every company table, from the catalog: each table with a company_id column. */
export async function companyTables(client: Client): Promise<string[]> {
  const found = await client.query<{ relation: string }>(`
    SELECT n.nspname || '.' || c.relname AS relation
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attname = 'company_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1`);
  return found.rows.map((row) => row.relation);
}

/**
 * For each company table, a valid insert of a row for `company`, so a test can
 * show that a role that may not write that company's rows is refused.
 */
export const ROW_INSERTS: Readonly<Record<string, (company: string) => Write>> = {
  "ledger.companies": (company) => ({
    sql: "INSERT INTO ledger.companies (company_id, name, organization_number) VALUES ($1, 'Testbolaget Gamma AB', '556000-0167')",
    params: [company],
  }),
  "ledger.reader_roles": (company) => ({
    sql: "INSERT INTO ledger.reader_roles (company_id, role_name) VALUES ($1, 'nortfox_test_reader_c')",
    params: [company],
  }),
  "audit.history": (company) => ({
    sql: `INSERT INTO audit.history (company_id, table_name, row_id, operation, new_values, actor_id, actor_kind, transaction_id, at)
          VALUES ($1, 'ledger.companies', $1, 'INSERT', '{}', $1, 'user', pg_catalog.pg_current_xact_id(), pg_catalog.clock_timestamp())`,
    params: [company],
  }),
};

/** A write the app may make, with the company it is made in. */
export interface AppWrite extends Write {
  readonly company: string;
}

/**
 * For each table and each write the app has the privilege for, one valid
 * write. A test fails when the app may write a table in a way this list does
 * not cover.
 */
export const APP_WRITES: Readonly<Record<string, Readonly<Partial<Record<"INSERT" | "UPDATE" | "DELETE", (scenario: Scenario) => AppWrite>>>>> = {
  "ledger.companies": {
    INSERT: () => {
      const company = randomUUID();
      return {
        company,
        sql: "INSERT INTO ledger.companies (company_id, name, organization_number) VALUES ($1, 'Testbolaget Delta AB', '599999-0129')",
        params: [company],
      };
    },
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.companies SET organization_number = '599999-0129' WHERE company_id = $1",
      params: [scenario.companyA],
    }),
  },
};

interface Actor {
  readonly company: string;
  readonly actor: string;
  readonly kind: ActorKind;
}

/**
 * Makes one change in its own transaction and notes it. The statement names
 * its table "t" and ends with RETURNING to_jsonb(t) AS row.
 */
async function change(
  client: Client,
  who: Actor,
  table: string,
  operation: Change["operation"],
  rowId: string,
  write: Write,
): Promise<Change> {
  return inTransaction(client, who, async () => {
    const before =
      operation === "INSERT"
        ? undefined
        : await client.query<{ row: Row }>(`SELECT pg_catalog.to_jsonb(t) AS row FROM ${table} AS t WHERE t.${KEYS[table] ?? ""} = $1`, [rowId]);
    const written = await client.query<{ row: Row }>(write.sql, [...write.params]);
    const stamps = await client.query<{ transaction: string; started: string; changed: string }>(
      "SELECT pg_catalog.pg_current_xact_id()::text AS transaction, pg_catalog.transaction_timestamp()::text AS started, pg_catalog.clock_timestamp()::text AS changed",
    );
    const [stamp] = stamps.rows;
    if (written.rows.length !== 1 || stamp === undefined) {
      throw new Error(`The scenario's ${operation} on ${table} changed ${String(written.rows.length)} rows, not one.`);
    }
    const row = written.rows[0]?.row ?? null;
    return {
      table,
      operation,
      company: who.company,
      rowId,
      oldValues: before?.rows[0]?.row ?? null,
      newValues: operation === "DELETE" ? null : row,
      actor: who.actor,
      kind: who.kind,
      transaction: stamp.transaction,
      startedAt: stamp.started,
      changedBy: stamp.changed,
    };
  });
}

/** Two companies, A and B, with rows in every company table, made by each kind of actor. */
export async function fillEveryTable(db: TestDatabase): Promise<Scenario> {
  const app = await db.connect("app");
  const owner = await db.connect("owner");
  const companyA = randomUUID();
  const companyB = randomUUID();
  const user = randomUUID();
  const system = randomUUID();
  const integration = randomUUID();
  const [readerA, readerB] = TEST_READERS;
  const changes: Change[] = [];
  const insertCompany = "INSERT INTO ledger.companies AS t (company_id, name, organization_number) VALUES ($1, $2, $3) RETURNING to_jsonb(t) AS row";
  const bind = "INSERT INTO ledger.reader_roles AS t (id, company_id, role_name) VALUES ($1, $2, $3) RETURNING to_jsonb(t) AS row";

  // The companies, by the app: a user makes one, an integration the other.
  changes.push(
    await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.companies", "INSERT", companyA, {
      sql: insertCompany,
      params: [companyA, "Testbolaget Alfa AB", "556000-0167"],
    }),
    await change(app, { company: companyB, actor: integration, kind: "integration" }, "ledger.companies", "INSERT", companyB, {
      sql: insertCompany,
      params: [companyB, "Testbolaget Beta AB", "599999-0129"],
    }),
    await change(app, { company: companyA, actor: system, kind: "system" }, "ledger.companies", "UPDATE", companyA, {
      sql: "UPDATE ledger.companies AS t SET name = $2 WHERE t.company_id = $1 RETURNING to_jsonb(t) AS row",
      params: [companyA, "Testbolaget Alfa Konsult AB"],
    }),
  );

  // The reader roles' bindings, by the owner: reader A to company A, and
  // reader B first to A, then to B.
  const bindingA = randomUUID();
  const firstB = randomUUID();
  const bindingB = randomUUID();
  changes.push(
    await change(owner, { company: companyA, actor: system, kind: "system" }, "ledger.reader_roles", "INSERT", bindingA, {
      sql: bind,
      params: [bindingA, companyA, readerA],
    }),
    await change(owner, { company: companyA, actor: system, kind: "system" }, "ledger.reader_roles", "INSERT", firstB, {
      sql: bind,
      params: [firstB, companyA, readerB],
    }),
    await change(owner, { company: companyA, actor: user, kind: "user" }, "ledger.reader_roles", "DELETE", firstB, {
      sql: "DELETE FROM ledger.reader_roles AS t WHERE t.id = $1 RETURNING to_jsonb(t) AS row",
      params: [firstB],
    }),
    await change(owner, { company: companyB, actor: system, kind: "system" }, "ledger.reader_roles", "INSERT", bindingB, {
      sql: bind,
      params: [bindingB, companyB, readerB],
    }),
  );

  return { companyA, companyB, changes };
}
