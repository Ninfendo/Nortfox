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

/** A voucher series of the scenario: its id, its fiscal year and its code. */
export interface ScenarioSeries {
  readonly id: string;
  readonly year: string;
  readonly code: string;
}

/** A company's vouchers in the scenario: one that is changed and stays, the last of its series, and an entry in the record of deleted vouchers. */
export interface ScenarioVouchers {
  readonly kept: string;
  readonly last: string;
  readonly deleted: string;
}

export interface Scenario {
  readonly companyA: string;
  readonly companyB: string;
  /** Each company's fiscal year 2030, by company. */
  readonly years: Readonly<Record<string, string>>;
  /** Each company's series A in its year 2030, which holds a void range, by company. */
  readonly series: Readonly<Record<string, ScenarioSeries>>;
  /** Each company's vouchers in its series A, by company. */
  readonly vouchers: Readonly<Record<string, ScenarioVouchers>>;
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
  "ledger.accounts": "id",
  "ledger.voucher_series": "id",
  "ledger.voucher_counters": "id",
  "ledger.void_ranges": "id",
  "ledger.vouchers": "id",
  "ledger.voucher_rows": "id",
  "ledger.deleted_vouchers": "id",
  "ledger.deleted_voucher_rows": "id",
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

function seriesOf(scenario: Scenario, company: string): ScenarioSeries {
  const series = scenario.series[company];
  if (series === undefined) {
    throw new Error("The scenario made no voucher series for that company.");
  }
  return series;
}

function vouchersOf(scenario: Scenario, company: string): ScenarioVouchers {
  const vouchers = scenario.vouchers[company];
  if (vouchers === undefined) {
    throw new Error("The scenario booked no voucher for that company.");
  }
  return vouchers;
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
    sql: "INSERT INTO ledger.reader_roles (company_id, role_oid) VALUES ($1, 'nortfox_test_reader_c'::pg_catalog.regrole)",
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
  "ledger.accounts": (company, scenario) => ({
    sql: "INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description) VALUES ($1, $2, 2440, 'Leverantörsskulder')",
    params: [company, yearOf(scenario, company)],
  }),
  "ledger.voucher_series": (company, scenario) => ({
    sql: "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'Y', '', false)",
    params: [company, yearOf(scenario, company)],
  }),
  // Only the database's own triggers make a counter, so the trigger refuses
  // the owner's insert before row level security does.
  "ledger.voucher_counters": (company, scenario) => ({
    sql: "INSERT INTO ledger.voucher_counters (company_id, series_id) VALUES ($1, $2)",
    params: [company, seriesOf(scenario, company).id],
  }),
  "ledger.void_ranges": (company, scenario) => ({
    sql: `INSERT INTO ledger.void_ranges (company_id, fiscal_year_id, series_code, first_number, last_number, reason)
          VALUES ($1, $2, $3, 9, 9, 'Återläsning av säkerhetskopia')`,
    params: [company, seriesOf(scenario, company).year, seriesOf(scenario, company).code],
  }),
  // The voucher triggers check no rule for a row of another company than the
  // transaction's: row level security refuses it right after them.
  "ledger.vouchers": (company, scenario) => ({
    sql: `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
          VALUES ($1, $2, 'A', 'Kontorsmaterial', '2030-05-15', 'MANUAL')`,
    params: [company, yearOf(scenario, company)],
  }),
  "ledger.voucher_rows": (company, scenario) => ({
    sql: "INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number) VALUES ($1, $2, 1930)",
    params: [company, vouchersOf(scenario, company).kept],
  }),
  // Only a deletion writes the record, so the trigger refuses the owner's
  // own insert before row level security does.
  "ledger.deleted_vouchers": (company, scenario) => ({
    sql: `INSERT INTO ledger.deleted_vouchers (voucher_id, company_id, fiscal_year_id, series_code, number, deletion_count, description, comments,
            transaction_date, reference_type, reference_number, created_at, created_by, created_by_kind, created_xact, modified_at,
            deleted_at, deleted_by, deleted_by_kind, deleted_xact)
          VALUES (pg_catalog.gen_random_uuid(), $1, $2, 'A', 99, 1, 'Kontorsmaterial', '', '2030-05-15', 'MANUAL', '', pg_catalog.now(), $1, 'user',
            pg_catalog.pg_current_xact_id(), pg_catalog.now(), pg_catalog.now(), $1, 'user', pg_catalog.pg_current_xact_id())`,
    params: [company, yearOf(scenario, company)],
  }),
  "ledger.deleted_voucher_rows": (company, scenario) => ({
    sql: `INSERT INTO ledger.deleted_voucher_rows (row_id, company_id, deleted_voucher_id, fiscal_year_id, position, account_number, debit, credit,
            transaction_information, quantity, removed, created_at, created_by, created_by_kind, account_description)
          VALUES (pg_catalog.gen_random_uuid(), $1, $2, $3, 9, 1930, 0, 0, '', 0, false, pg_catalog.now(), $1, 'user', 'Företagskonto')`,
    params: [company, vouchersOf(scenario, company).deleted, yearOf(scenario, company)],
  }),
};

/**
 * The company tables that only the database's own triggers insert rows into,
 * with the facts of the refusal that the owner's own insert gets. The app and
 * the readers have no INSERT on them at all.
 */
export const TRIGGER_ONLY_INSERTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "audit.history": { table: "audit.history", field: null },
  "ledger.voucher_counters": { table: "ledger.voucher_counters", field: null },
  "ledger.deleted_vouchers": { table: "ledger.deleted_vouchers", field: null },
  "ledger.deleted_voucher_rows": { table: "ledger.deleted_voucher_rows", field: null },
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
  "ledger.accounts": {
    INSERT: (scenario) => ({
      company: scenario.companyA,
      sql: "INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description) VALUES ($1, $2, 2440, 'Leverantörsskulder')",
      params: [scenario.companyA, yearOf(scenario, scenario.companyA)],
    }),
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.accounts SET description = 'Bankkonto' WHERE fiscal_year_id = $1 AND number = 1930",
      params: [yearOf(scenario, scenario.companyA)],
    }),
    // 6110 holds no rows, so only the missing actor stops its removal.
    DELETE: (scenario) => ({
      company: scenario.companyA,
      sql: "DELETE FROM ledger.accounts WHERE fiscal_year_id = $1 AND number = 6110",
      params: [yearOf(scenario, scenario.companyA)],
    }),
  },
  "ledger.voucher_series": {
    INSERT: (scenario) => ({
      company: scenario.companyA,
      sql: "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'X', '', false)",
      params: [scenario.companyA, yearOf(scenario, scenario.companyA)],
    }),
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.voucher_series SET manual = false WHERE fiscal_year_id = $1 AND code = 'I'",
      params: [yearOf(scenario, scenario.companyA)],
    }),
    // Series I holds no void range and no voucher, so only the missing actor stops its removal.
    DELETE: (scenario) => ({
      company: scenario.companyA,
      sql: "DELETE FROM ledger.voucher_series WHERE fiscal_year_id = $1 AND code = 'I'",
      params: [yearOf(scenario, scenario.companyA)],
    }),
  },
  // Each voucher write passes every rule up to the period lock, which needs the actor.
  "ledger.vouchers": {
    INSERT: (scenario) => ({
      company: scenario.companyA,
      sql: `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
            VALUES ($1, $2, 'A', 'Kontorsmaterial', '2030-06-15', 'MANUAL')`,
      params: [scenario.companyA, yearOf(scenario, scenario.companyA)],
    }),
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.vouchers SET description = 'Kontorsmaterial och porto' WHERE id = $1",
      params: [vouchersOf(scenario, scenario.companyA).kept],
    }),
    DELETE: (scenario) => ({
      company: scenario.companyA,
      sql: "DELETE FROM ledger.vouchers WHERE id = $1",
      params: [vouchersOf(scenario, scenario.companyA).last],
    }),
  },
  "ledger.voucher_rows": {
    INSERT: (scenario) => ({
      company: scenario.companyA,
      sql: "INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number) VALUES ($1, $2, 1930)",
      params: [scenario.companyA, vouchersOf(scenario, scenario.companyA).kept],
    }),
    UPDATE: (scenario) => ({
      company: scenario.companyA,
      sql: "UPDATE ledger.voucher_rows SET transaction_information = 'Kvitto 7' WHERE voucher_id = $1 AND position = 1",
      params: [vouchersOf(scenario, scenario.companyA).kept],
    }),
  },
};

interface Actor {
  readonly company: string;
  readonly actor: string;
  readonly kind: ActorKind;
}

/**
 * A row that a trigger inserts, updates or deletes along with a change: its
 * table, what the trigger does to it (INSERT by default), and a query that
 * finds it as { id, row }.
 */
interface Made {
  readonly table: string;
  readonly operation?: Change["operation"];
  readonly find: Write;
}

/** The row that a Made query finds, which must be `expected` rows: one, or none. */
async function findMade(client: Client, made: Made, expected: 0 | 1, when: string): Promise<{ id: string; row: Row } | undefined> {
  const found = await client.query<{ id: string; row: Row }>(made.find.sql, [...made.find.params]);
  if (found.rows.length !== expected) {
    throw new Error(`The scenario should find ${String(expected)} row in ${made.table} ${when} the change, not ${String(found.rows.length)}.`);
  }
  return found.rows[0];
}

/** One statement of a change: the row it writes, by its table, its operation and its id. */
interface Step {
  readonly table: string;
  readonly operation: Change["operation"];
  readonly rowId: string;
  readonly write: Write;
}

/**
 * Makes one change in its own transaction and notes it, with the rows that
 * its triggers insert, update or delete along with it. The statement names its table "t" and
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
  return changeOfSteps(client, who, [{ table, operation, rowId, write }], made);
}

/**
 * Makes one change of several statements in its own transaction, as a booking
 * writes its voucher and then its rows, and notes each statement's row and the
 * rows that the triggers write along with them. Each statement writes one row
 * that no other statement of the change writes.
 */
async function changeOfSteps(client: Client, who: Actor, steps: readonly Step[], made: readonly Made[] = []): Promise<Change[]> {
  return inTransaction(client, who, async () => {
    const madeBefore: ({ id: string; row: Row } | undefined)[] = [];
    for (const other of made) {
      madeBefore.push((other.operation ?? "INSERT") === "INSERT" ? undefined : await findMade(client, other, 1, "before"));
    }
    const notedSteps: { table: string; operation: Change["operation"]; id: string; oldValues: Row | null; newValues: Row | null }[] = [];
    for (const { table, operation, rowId, write } of steps) {
      const before =
        operation === "INSERT"
          ? undefined
          : await client.query<{ row: Row }>(`SELECT pg_catalog.to_jsonb(t) AS row FROM ${table} AS t WHERE t.${KEYS[table] ?? ""} = $1`, [rowId]);
      const written = await client.query<{ row: Row }>(write.sql, [...write.params]);
      if (written.rows.length !== 1) {
        throw new Error(`The scenario's ${operation} on ${table} changed ${String(written.rows.length)} rows, not one.`);
      }
      notedSteps.push({
        table,
        operation,
        id: rowId,
        oldValues: before?.rows[0]?.row ?? null,
        newValues: operation === "DELETE" ? null : (written.rows[0]?.row ?? null),
      });
    }
    const others: { table: string; operation: Change["operation"]; id: string; oldValues: Row | null; newValues: Row | null }[] = [];
    for (const [index, other] of made.entries()) {
      const madeOperation = other.operation ?? "INSERT";
      const old = madeBefore[index];
      const now = await findMade(client, other, madeOperation === "DELETE" ? 0 : 1, "after");
      others.push({
        table: other.table,
        operation: madeOperation,
        id: now?.id ?? old?.id ?? "",
        oldValues: old?.row ?? null,
        newValues: now?.row ?? null,
      });
    }
    const stamps = await client.query<{ transaction: string; started: string; changed: string }>(
      "SELECT pg_catalog.pg_current_xact_id()::text AS transaction, pg_catalog.transaction_timestamp()::text AS started, pg_catalog.clock_timestamp()::text AS changed",
    );
    const [stamp] = stamps.rows;
    if (stamp === undefined) {
      throw new Error("The database gave no transaction stamps.");
    }
    const common = {
      company: who.company,
      actor: who.actor,
      kind: who.kind,
      transaction: stamp.transaction,
      startedAt: stamp.started,
      changedBy: stamp.changed,
    };
    return [...notedSteps, ...others].map((other) => ({
      ...common,
      table: other.table,
      operation: other.operation,
      rowId: other.id,
      oldValues: other.oldValues,
      newValues: other.newValues,
    }));
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
  const bind = "INSERT INTO ledger.reader_roles AS t (id, company_id, role_oid) VALUES ($1, $2, $3::pg_catalog.regrole) RETURNING to_jsonb(t) AS row";
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

  // Accounts, by the app: A gets 1930 and 6110 and changes 6110, and adds
  // 3990 and removes it again; B gets 1930.
  const insertAccount = `INSERT INTO ledger.accounts AS t (id, company_id, fiscal_year_id, number, description, active)
                         VALUES ($1, $2, $3, $4, $5, $6) RETURNING to_jsonb(t) AS row`;
  const bankA = randomUUID();
  const officeA = randomUUID();
  const unusedA = randomUUID();
  const bankB = randomUUID();
  const salesA = randomUUID();
  const salesB = randomUUID();
  changes.push(
    ...(await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.accounts", "INSERT", salesA, {
      sql: insertAccount,
      params: [salesA, companyA, yearA, 3001, "Försäljning inom Sverige", true],
    })),
    ...(await change(app, { company: companyB, actor: integration, kind: "integration" }, "ledger.accounts", "INSERT", salesB, {
      sql: insertAccount,
      params: [salesB, companyB, yearB, 3001, "Försäljning inom Sverige", true],
    })),
  );
  changes.push(
    ...(await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.accounts", "INSERT", bankA, {
      sql: insertAccount,
      params: [bankA, companyA, yearA, 1930, "Företagskonto", true],
    })),
    ...(await change(app, { company: companyA, actor: system, kind: "system" }, "ledger.accounts", "INSERT", officeA, {
      sql: insertAccount,
      params: [officeA, companyA, yearA, 6110, "Kontorsmateriel", true],
    })),
    ...(await change(app, { company: companyA, actor: integration, kind: "integration" }, "ledger.accounts", "UPDATE", officeA, {
      sql: "UPDATE ledger.accounts AS t SET description = $2, active = false WHERE t.id = $1 RETURNING to_jsonb(t) AS row",
      params: [officeA, "Kontorsmaterial"],
    })),
    ...(await change(app, { company: companyA, actor: user, kind: "user" }, "ledger.accounts", "INSERT", unusedA, {
      sql: insertAccount,
      params: [unusedA, companyA, yearA, 3990, "Övriga ersättningar och intäkter", true],
    })),
    ...(await change(app, { company: companyA, actor: system, kind: "system" }, "ledger.accounts", "DELETE", unusedA, {
      sql: "DELETE FROM ledger.accounts AS t WHERE t.id = $1 RETURNING to_jsonb(t) AS row",
      params: [unusedA],
    })),
    ...(await change(app, { company: companyB, actor: integration, kind: "integration" }, "ledger.accounts", "INSERT", bankB, {
      sql: insertAccount,
      params: [bankB, companyB, yearB, 1930, "Företagskonto", true],
    })),
  );

  // Voucher series, by the app, each with the counter that comes with it: A
  // gets A, the closing series I, which it renames, and Z, which it removes
  // again with its counter; B gets A.
  const insertSeries = `INSERT INTO ledger.voucher_series AS t (id, company_id, fiscal_year_id, code, description, manual, is_closing)
                        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING to_jsonb(t) AS row`;
  /** The counter of a series, which a trigger makes, moves or removes along with a change. */
  const counterOf = (series: string, operation: Change["operation"] = "INSERT"): Made => ({
    table: "ledger.voucher_counters",
    operation,
    find: { sql: "SELECT t.id, pg_catalog.to_jsonb(t) AS row FROM ledger.voucher_counters AS t WHERE t.series_id = $1", params: [series] },
  });
  const seriesA = randomUUID();
  const closingA = randomUUID();
  const unusedSeriesA = randomUUID();
  const seriesB = randomUUID();
  changes.push(
    ...(await change(
      app,
      { company: companyA, actor: user, kind: "user" },
      "ledger.voucher_series",
      "INSERT",
      seriesA,
      { sql: insertSeries, params: [seriesA, companyA, yearA, "A", "Manuella verifikationer", true, false] },
      [counterOf(seriesA)],
    )),
    ...(await change(
      app,
      { company: companyA, actor: system, kind: "system" },
      "ledger.voucher_series",
      "INSERT",
      closingA,
      { sql: insertSeries, params: [closingA, companyA, yearA, "I", "Bokslut", true, true] },
      [counterOf(closingA)],
    )),
    ...(await change(app, { company: companyA, actor: integration, kind: "integration" }, "ledger.voucher_series", "UPDATE", closingA, {
      sql: "UPDATE ledger.voucher_series AS t SET description = $2 WHERE t.id = $1 RETURNING to_jsonb(t) AS row",
      params: [closingA, "Bokslutsverifikationer"],
    })),
    ...(await change(
      app,
      { company: companyA, actor: user, kind: "user" },
      "ledger.voucher_series",
      "INSERT",
      unusedSeriesA,
      { sql: insertSeries, params: [unusedSeriesA, companyA, yearA, "Z", "", false, false] },
      [counterOf(unusedSeriesA)],
    )),
    ...(await change(
      app,
      { company: companyA, actor: system, kind: "system" },
      "ledger.voucher_series",
      "DELETE",
      unusedSeriesA,
      { sql: "DELETE FROM ledger.voucher_series AS t WHERE t.id = $1 RETURNING to_jsonb(t) AS row", params: [unusedSeriesA] },
      [counterOf(unusedSeriesA, "DELETE")],
    )),
    ...(await change(
      app,
      { company: companyB, actor: integration, kind: "integration" },
      "ledger.voucher_series",
      "INSERT",
      seriesB,
      { sql: insertSeries, params: [seriesB, companyB, yearB, "A", "Manuella verifikationer", true, false] },
      [counterOf(seriesB)],
    )),
  );

  // Void ranges, by the owner, as a restore records them, each moving its
  // series' counter: A skips 1 to 3 in its series A, B skips 1.
  const insertRange = `INSERT INTO ledger.void_ranges AS t (id, company_id, fiscal_year_id, series_code, first_number, last_number, reason)
                       VALUES ($1, $2, $3, 'A', $4, $5, 'Återläsning av säkerhetskopia') RETURNING to_jsonb(t) AS row`;
  const rangeA = randomUUID();
  const rangeB = randomUUID();
  changes.push(
    ...(await change(
      owner,
      { company: companyA, actor: system, kind: "system" },
      "ledger.void_ranges",
      "INSERT",
      rangeA,
      { sql: insertRange, params: [rangeA, companyA, yearA, 1, 3] },
      [counterOf(seriesA, "UPDATE")],
    )),
    ...(await change(
      owner,
      { company: companyB, actor: user, kind: "user" },
      "ledger.void_ranges",
      "INSERT",
      rangeB,
      { sql: insertRange, params: [rangeB, companyB, yearB, 1, 1] },
      [counterOf(seriesB, "UPDATE")],
    )),
  );

  // Vouchers, by the app, in each company's series A, after its void range.
  // A books A4, changes it in every way Ändra allows, reverses it with A5,
  // then books A6 and deletes it. B books A2, deletes it, and books A2 again.
  const vouchers = new Vouchers(app, changes);
  const keptA = await vouchers.book({ company: companyA, actor: user, kind: "user" }, yearA, seriesA, [
    [1930, 12_500, 0],
    [3001, 0, 12_500],
  ]);
  await vouchers.alter({ company: companyA, actor: integration, kind: "integration" }, keptA, "ledger.vouchers", keptA.id, "description = 'Kontantförsäljning'");
  const zeroRow = await vouchers.addRow({ company: companyA, actor: system, kind: "system" }, keptA, [1930, 0, 0]);
  await vouchers.alter({ company: companyA, actor: user, kind: "user" }, keptA, "ledger.voucher_rows", zeroRow, "removed = true");
  await vouchers.alter(
    { company: companyA, actor: integration, kind: "integration" },
    keptA,
    "ledger.voucher_rows",
    keptA.rows[0] ?? "",
    "transaction_information = 'Kvitto 1'",
  );
  const lastA = await vouchers.book(
    { company: companyA, actor: system, kind: "system" },
    yearA,
    seriesA,
    [
      [1930, 0, 12_500],
      [3001, 12_500, 0],
    ],
    keptA.id,
  );
  const deletedA = await vouchers.book({ company: companyA, actor: user, kind: "user" }, yearA, seriesA, [
    [1930, 990, 0],
    [3001, 0, 990],
  ]);
  await vouchers.remove({ company: companyA, actor: integration, kind: "integration" }, seriesA, deletedA);
  const deletedB = await vouchers.book({ company: companyB, actor: integration, kind: "integration" }, yearB, seriesB, [
    [1930, 5000, 0],
    [3001, 0, 5000],
  ]);
  await vouchers.remove({ company: companyB, actor: system, kind: "system" }, seriesB, deletedB);
  const keptB = await vouchers.book({ company: companyB, actor: user, kind: "user" }, yearB, seriesB, [
    [1930, 7000, 0],
    [3001, 0, 7000],
  ]);

  return {
    companyA,
    companyB,
    years: { [companyA]: yearA, [companyB]: yearB },
    series: { [companyA]: { id: seriesA, year: yearA, code: "A" }, [companyB]: { id: seriesB, year: yearB, code: "A" } },
    vouchers: {
      [companyA]: { kept: keptA.id, last: lastA.id, deleted: deletedA.id },
      [companyB]: { kept: keptB.id, last: keptB.id, deleted: deletedB.id },
    },
    changes,
  };
}

/** A row the scenario books: its account, its debit and its credit, in öre. */
type Sides = readonly [account: number, debit: number, credit: number];

/** A voucher the scenario booked: its id and its rows' ids, in order. */
interface Booked {
  readonly id: string;
  readonly rows: readonly string[];
}

/** The scenario's voucher changes, each noted with every row that its triggers write along with it. */
class Vouchers {
  private readonly app: Client;
  private readonly changes: Change[];

  constructor(app: Client, changes: Change[]) {
    this.app = app;
    this.changes = changes;
  }

  private static counterOf(series: string): Made {
    return {
      table: "ledger.voucher_counters",
      operation: "UPDATE",
      find: { sql: "SELECT t.id, pg_catalog.to_jsonb(t) AS row FROM ledger.voucher_counters AS t WHERE t.series_id = $1", params: [series] },
    };
  }

  private static byId(table: string, id: string, operation: Change["operation"], column = "id"): Made {
    return { table, operation, find: { sql: `SELECT t.id, pg_catalog.to_jsonb(t) AS row FROM ${table} AS t WHERE t.${column} = $1`, params: [id] } };
  }

  private static row(company: string, voucher: string, id: string, [account, debit, credit]: Sides): Step {
    return {
      table: "ledger.voucher_rows",
      operation: "INSERT",
      rowId: id,
      write: {
        sql: `INSERT INTO ledger.voucher_rows AS t (id, company_id, voucher_id, account_number, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING pg_catalog.to_jsonb(t) AS row`,
        params: [id, company, voucher, account, debit, credit],
      },
    };
  }

  /** Books a voucher dated 2030-05-15 in a series, with its rows and the counter's move, and gives it. */
  async book(who: Actor, year: string, series: string, rows: readonly Sides[], reverses: string | null = null): Promise<Booked> {
    const id = randomUUID();
    const rowIds = rows.map(() => randomUUID());
    const head: Step = {
      table: "ledger.vouchers",
      operation: "INSERT",
      rowId: id,
      write: {
        sql: `INSERT INTO ledger.vouchers AS t (id, company_id, fiscal_year_id, series_code, description, transaction_date, reference_type, reverses_voucher_id)
              VALUES ($1, $2, $3, 'A', 'Kontorsmaterial', '2030-05-15', 'MANUAL', $4) RETURNING pg_catalog.to_jsonb(t) AS row`,
        params: [id, who.company, year, reverses],
      },
    };
    const steps = [head, ...rows.map((row, index) => Vouchers.row(who.company, id, rowIds[index] ?? "", row))];
    this.changes.push(...(await changeOfSteps(this.app, who, steps, [Vouchers.counterOf(series)])));
    return { id, rows: rowIds };
  }

  /** Adds a row to a booked voucher, which touches the voucher's altered stamp, and gives the row's id. */
  async addRow(who: Actor, voucher: Booked, row: Sides): Promise<string> {
    const id = randomUUID();
    this.changes.push(
      ...(await changeOfSteps(this.app, who, [Vouchers.row(who.company, voucher.id, id, row)], [Vouchers.byId("ledger.vouchers", voucher.id, "UPDATE")])),
    );
    return id;
  }

  /** Changes a booked voucher or one of its rows by Ändra. A row's change touches the voucher's altered stamp. */
  async alter(who: Actor, voucher: Booked, table: "ledger.vouchers" | "ledger.voucher_rows", id: string, set: string): Promise<void> {
    const made = table === "ledger.voucher_rows" ? [Vouchers.byId("ledger.vouchers", voucher.id, "UPDATE")] : [];
    this.changes.push(
      ...(await change(
        this.app,
        who,
        table,
        "UPDATE",
        id,
        { sql: `UPDATE ${table} AS t SET ${set} WHERE t.id = $1 RETURNING pg_catalog.to_jsonb(t) AS row`, params: [id] },
        made,
      )),
    );
  }

  /** Deletes the last voucher of a series: it moves to the record, its rows go by the cascade, and the counter goes back. */
  async remove(who: Actor, series: string, voucher: Booked): Promise<void> {
    const made: Made[] = [
      // An entry and its rows have ids of their own, and keep the voucher's id and the rows' ids.
      Vouchers.byId("ledger.deleted_vouchers", voucher.id, "INSERT", "voucher_id"),
      ...voucher.rows.map((row) => Vouchers.byId("ledger.deleted_voucher_rows", row, "INSERT", "row_id")),
      ...voucher.rows.map((row) => Vouchers.byId("ledger.voucher_rows", row, "DELETE")),
      Vouchers.counterOf(series),
    ];
    this.changes.push(
      ...(await change(
        this.app,
        who,
        "ledger.vouchers",
        "DELETE",
        voucher.id,
        { sql: "DELETE FROM ledger.vouchers AS t WHERE t.id = $1 RETURNING pg_catalog.to_jsonb(t) AS row", params: [voucher.id] },
        made,
      )),
    );
  }
}
