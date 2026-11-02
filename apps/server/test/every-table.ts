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
  /** Each company's fiscal year 2030, by company. */
  readonly years: Readonly<Record<string, string>>;
  readonly changes: readonly Change[];
}

/** The key column of each company table: the row's id in the history. */
export const KEYS: Readonly<Record<string, string>> = {
  "ledger.companies": "company_id",
  "ledger.reader_roles": "id",
  "audit.history": "id",
  "ledger.fiscal_years": "id",
  "ledger.periods": "id",
  "ledger.period_locks": "id",
  "ledger.automatic_locks": "id",
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

function yearOf(scenario: Scenario, company: string): string {
  const year = scenario.years[company];
  if (year === undefined) {
    throw new Error("The scenario made no fiscal year for that company.");
  }
  return year;
}

/**
 * For each company table, a valid insert of a row for `company`, so a test can
 * show that a role that may not write that company's rows is refused.
 */
export const ROW_INSERTS: Readonly<Record<string, (company: string, scenario: Scenario) => Write>> = {
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
  "ledger.fiscal_years": (company) => ({
    sql: "INSERT INTO ledger.fiscal_years (company_id, from_date, to_date, accounting_method, account_chart_type) VALUES ($1, '2093-01-01', '2093-12-31', 'ACCRUAL', 'Bas 2093')",
    params: [company],
  }),
  "ledger.periods": (company, scenario) => ({
    sql: "INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, '2030-06-01', '2030-06-30')",
    params: [company, yearOf(scenario, company)],
  }),
  "ledger.period_locks": (company) => ({
    sql: "INSERT INTO ledger.period_locks (company_id, scope, end_date) VALUES ($1, 'system', '2030-01-31')",
    params: [company],
  }),
  // Every company has its automatic lock row from the start, so this insert
  // would also break its unique key. The privileges and row level security
  // refuse it first.
  "ledger.automatic_locks": (company) => ({
    sql: "INSERT INTO ledger.automatic_locks (company_id) VALUES ($1)",
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
  "ledger.fiscal_years": {
    INSERT: (scenario) => ({
      company: scenario.companyA,
      sql: "INSERT INTO ledger.fiscal_years (company_id, from_date, to_date, accounting_method, account_chart_type) VALUES ($1, '2092-01-01', '2092-12-31', 'ACCRUAL', 'Bas 2092')",
      params: [scenario.companyA],
    }),
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.fiscal_years SET account_chart_type = 'Bas 2030 B' WHERE id = $1",
      params: [yearOf(scenario, scenario.companyA)],
    }),
  },
  "ledger.periods": {
    INSERT: (scenario) => ({
      company: scenario.companyA,
      sql: "INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, '2030-03-01', '2030-03-31')",
      params: [scenario.companyA, yearOf(scenario, scenario.companyA)],
    }),
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.periods SET to_date = to_date WHERE fiscal_year_id = $1 AND from_date = '2030-01-01'",
      params: [yearOf(scenario, scenario.companyA)],
    }),
  },
  "ledger.period_locks": {
    INSERT: (scenario) => ({
      company: scenario.companyA,
      sql: "INSERT INTO ledger.period_locks (company_id, scope, end_date) VALUES ($1, 'integration', '2030-01-31')",
      params: [scenario.companyA],
    }),
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.period_locks SET end_date = '2030-02-28' WHERE scope = 'all'",
      params: [],
    }),
  },
  "ledger.automatic_locks": {
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.automatic_locks SET notice_days = 3",
      params: [],
    }),
  },
};

interface Actor {
  readonly company: string;
  readonly actor: string;
  readonly kind: ActorKind;
}

/** A row that a trigger inserts along with a change: its table, and a query that finds it as { id, row }. */
interface Made {
  readonly table: string;
  readonly find: Write;
}

/**
 * Makes one change in its own transaction and notes it, with the rows that
 * its triggers insert along with it. The statement names its table "t" and
 * ends with RETURNING to_jsonb(t) AS row.
 */
async function change(
  client: Client,
  who: Actor,
  table: string,
  operation: Change["operation"],
  rowId: string,
  write: Write,
  made: readonly Made[] = [],
): Promise<Change[]> {
  return inTransaction(client, who, async () => {
    const before =
      operation === "INSERT"
        ? undefined
        : await client.query<{ row: Row }>(`SELECT pg_catalog.to_jsonb(t) AS row FROM ${table} AS t WHERE t.${KEYS[table] ?? ""} = $1`, [rowId]);
    const written = await client.query<{ row: Row }>(write.sql, [...write.params]);
    const others: { table: string; id: string; row: Row }[] = [];
    for (const { table: madeIn, find } of made) {
      const found = await client.query<{ id: string; row: Row }>(find.sql, [...find.params]);
      if (found.rows.length !== 1) {
        throw new Error(`The scenario's ${operation} on ${table} should make one row in ${madeIn}, not ${String(found.rows.length)}.`);
      }
      others.push(...found.rows.map((row) => ({ table: madeIn, ...row })));
    }
    const stamps = await client.query<{ transaction: string; started: string; changed: string }>(
      "SELECT pg_catalog.pg_current_xact_id()::text AS transaction, pg_catalog.transaction_timestamp()::text AS started, pg_catalog.clock_timestamp()::text AS changed",
    );
    const [stamp] = stamps.rows;
    if (written.rows.length !== 1 || stamp === undefined) {
      throw new Error(`The scenario's ${operation} on ${table} changed ${String(written.rows.length)} rows, not one.`);
    }
    const common = {
      company: who.company,
      actor: who.actor,
      kind: who.kind,
      transaction: stamp.transaction,
      startedAt: stamp.started,
      changedBy: stamp.changed,
    };
    const row = written.rows[0]?.row ?? null;
    return [
      {
        ...common,
        table,
        operation,
        rowId,
        oldValues: before?.rows[0]?.row ?? null,
        newValues: operation === "DELETE" ? null : row,
      },
      ...others.map((other) => ({ ...common, table: other.table, operation: "INSERT" as const, rowId: other.id, oldValues: null, newValues: other.row })),
    ];
  });
}

/** The id of the one change the scenario noted for `table` in `company`. */
function rowIdOf(changes: readonly Change[], table: string, company: string): string {
  const found = changes.find((noted) => noted.table === table && noted.company === company);
  if (found === undefined) {
    throw new Error(`The scenario noted no row of ${table} for that company.`);
  }
  return found.rowId;
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
  /** The automatic lock row that a new company gets with it. */
  const automaticLockOf = (company: string): Made => ({
    table: "ledger.automatic_locks",
    find: { sql: "SELECT t.id, pg_catalog.to_jsonb(t) AS row FROM ledger.automatic_locks AS t WHERE t.company_id = $1", params: [company] },
  });

  // The companies, by the app: a user makes one, an integration the other.
  // Each comes with its automatic lock row.
  changes.push(
    ...(await change(
      app,
      { company: companyA, actor: user, kind: "user" },
      "ledger.companies",
      "INSERT",
      companyA,
      { sql: insertCompany, params: [companyA, "Testbolaget Alfa AB", "556000-0167"] },
      [automaticLockOf(companyA)],
    )),
    ...(await change(
      app,
      { company: companyB, actor: integration, kind: "integration" },
      "ledger.companies",
      "INSERT",
      companyB,
      { sql: insertCompany, params: [companyB, "Testbolaget Beta AB", "599999-0129"] },
      [automaticLockOf(companyB)],
    )),
    ...(await change(app, { company: companyA, actor: system, kind: "system" }, "ledger.companies", "UPDATE", companyA, {
      sql: "UPDATE ledger.companies AS t SET name = $2 WHERE t.company_id = $1 RETURNING to_jsonb(t) AS row",
      params: [companyA, "Testbolaget Alfa Konsult AB"],
    })),
  );

  // The reader roles' bindings, by the owner: reader A to company A, and
  // reader B first to A, then to B.
  const bindingA = randomUUID();
  const firstB = randomUUID();
  const bindingB = randomUUID();
  changes.push(
    ...(await change(owner, { company: companyA, actor: system, kind: "system" }, "ledger.reader_roles", "INSERT", bindingA, {
      sql: bind,
      params: [bindingA, companyA, readerA],
    })),
    ...(await change(owner, { company: companyA, actor: system, kind: "system" }, "ledger.reader_roles", "INSERT", firstB, {
      sql: bind,
      params: [firstB, companyA, readerB],
    })),
    ...(await change(owner, { company: companyA, actor: user, kind: "user" }, "ledger.reader_roles", "DELETE", firstB, {
      sql: "DELETE FROM ledger.reader_roles AS t WHERE t.id = $1 RETURNING to_jsonb(t) AS row",
      params: [firstB],
    })),
    ...(await change(owner, { company: companyB, actor: system, kind: "system" }, "ledger.reader_roles", "INSERT", bindingB, {
      sql: bind,
      params: [bindingB, companyB, readerB],
    })),
  );

  // Fiscal years, by the app: A gets 2030, its default, and 2031; B gets 2030.
  const yearA = randomUUID();
  const nextA = randomUUID();
  const yearB = randomUUID();
  const insertYear = `INSERT INTO ledger.fiscal_years AS t (id, company_id, from_date, to_date, accounting_method, account_chart_type, is_default)
                      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING to_jsonb(t) AS row`;
  changes.push(
    ...(await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.fiscal_years", "INSERT", yearA, {
      sql: insertYear,
      params: [yearA, companyA, "2030-01-01", "2030-12-31", "ACCRUAL", "Bas 2030", true],
    })),
    ...(await change(app, { company: companyA, actor: system, kind: "system" }, "ledger.fiscal_years", "INSERT", nextA, {
      sql: insertYear,
      params: [nextA, companyA, "2031-01-01", "2031-12-31", "CASH", "Bas 2031", false],
    })),
    ...(await change(app, { company: companyA, actor: integration, kind: "integration" }, "ledger.fiscal_years", "UPDATE", nextA, {
      sql: "UPDATE ledger.fiscal_years AS t SET to_date = $2 WHERE t.id = $1 RETURNING to_jsonb(t) AS row",
      params: [nextA, "2032-06-30"],
    })),
    ...(await change(app, { company: companyB, actor: integration, kind: "integration" }, "ledger.fiscal_years", "INSERT", yearB, {
      sql: insertYear,
      params: [yearB, companyB, "2030-01-01", "2030-12-31", "ACCRUAL", "Bas 2030", false],
    })),
  );

  // Periods, by the app: January and February 2030 for A, January for B.
  const januaryA = randomUUID();
  const februaryA = randomUUID();
  const januaryB = randomUUID();
  const insertPeriod = `INSERT INTO ledger.periods AS t (id, company_id, fiscal_year_id, from_date, to_date)
                        VALUES ($1, $2, $3, $4, $5) RETURNING to_jsonb(t) AS row`;
  changes.push(
    ...(await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.periods", "INSERT", januaryA, {
      sql: insertPeriod,
      params: [januaryA, companyA, yearA, "2030-01-01", "2030-01-31"],
    })),
    ...(await change(app, { company: companyA, actor: system, kind: "system" }, "ledger.periods", "INSERT", februaryA, {
      sql: insertPeriod,
      params: [februaryA, companyA, yearA, "2030-02-01", "2030-02-27"],
    })),
    ...(await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.periods", "UPDATE", februaryA, {
      sql: "UPDATE ledger.periods AS t SET to_date = $2 WHERE t.id = $1 RETURNING to_jsonb(t) AS row",
      params: [februaryA, "2030-02-28"],
    })),
    ...(await change(app, { company: companyB, actor: integration, kind: "integration" }, "ledger.periods", "INSERT", januaryB, {
      sql: insertPeriod,
      params: [januaryB, companyB, yearB, "2030-01-01", "2030-01-31"],
    })),
  );

  // Lock dates, by the app: A locks one user and all users, then clears the
  // user's date; B locks integrations.
  const userLockA = randomUUID();
  const allLockA = randomUUID();
  const integrationLockB = randomUUID();
  const insertLock = `INSERT INTO ledger.period_locks AS t (id, company_id, scope, user_id, end_date)
                      VALUES ($1, $2, $3, $4, $5) RETURNING to_jsonb(t) AS row`;
  changes.push(
    ...(await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.period_locks", "INSERT", userLockA, {
      sql: insertLock,
      params: [userLockA, companyA, "user", user, "2030-03-31"],
    })),
    ...(await change(app, { company: companyA, actor: system, kind: "system" }, "ledger.period_locks", "INSERT", allLockA, {
      sql: insertLock,
      params: [allLockA, companyA, "all", null, "2030-01-31"],
    })),
    ...(await change(app, { company: companyA, actor: integration, kind: "integration" }, "ledger.period_locks", "UPDATE", userLockA, {
      sql: "UPDATE ledger.period_locks AS t SET end_date = NULL WHERE t.id = $1 RETURNING to_jsonb(t) AS row",
      params: [userLockA],
    })),
    ...(await change(app, { company: companyB, actor: integration, kind: "integration" }, "ledger.period_locks", "INSERT", integrationLockB, {
      sql: insertLock,
      params: [integrationLockB, companyB, "integration", null, "2030-02-28"],
    })),
  );

  // The automatic lock, by the app: A turns it on and off again, B turns it on.
  const automaticA = rowIdOf(changes, "ledger.automatic_locks", companyA);
  const automaticB = rowIdOf(changes, "ledger.automatic_locks", companyB);
  const setAutomatic = "UPDATE ledger.automatic_locks AS t SET enabled = $2, interval = $3, notice_days = $4 WHERE t.id = $1 RETURNING to_jsonb(t) AS row";
  changes.push(
    ...(await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.automatic_locks", "UPDATE", automaticA, {
      sql: setAutomatic,
      params: [automaticA, true, "month_end_50", 7],
    })),
    ...(await change(app, { company: companyA, actor: system, kind: "system" }, "ledger.automatic_locks", "UPDATE", automaticA, {
      sql: setAutomatic,
      params: [automaticA, false, "month_end_50", 7],
    })),
    ...(await change(app, { company: companyB, actor: integration, kind: "integration" }, "ledger.automatic_locks", "UPDATE", automaticB, {
      sql: setAutomatic,
      params: [automaticB, true, "quarter_end_50", null],
    })),
  );

  return { companyA, companyB, years: { [companyA]: yearA, [companyB]: yearB }, changes };
}
