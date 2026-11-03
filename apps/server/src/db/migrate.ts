// SPDX-License-Identifier: AGPL-3.0-only

// The migration runner. The files in db/migrations are plain SQL, applied in
// name order, never edited once applied.
//
// - Only the owner role runs it: it checks current_user.
// - An advisory lock keeps two runners apart.
// - meta.schema_migrations records each applied file with its SHA-256, read
//   with CRLF as LF, and who applied it. A file that was applied and is now
//   gone or changed stops the run, so "never edited after merge" is checked
//   at every deploy.
// - Each pending file runs in its own transaction, with search_path set to
//   pg_catalog, pg_temp, so every name of ours in it is written in full. The
//   table guard runs inside the same transaction, and any problem rolls the
//   file back. So a migration that adds an unguarded table fails everywhere.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ClientBase } from "pg";
import { configFromEnvironment, type Environment } from "./connect.ts";
import { tableGuardProblems } from "./table-guard.ts";

/** db/migrations, from src/db here and from dist/db once built. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));

const OWNER = "nortfox_owner";

/** The advisory lock that keeps two runners apart. */
const LOCK = 4_646_209;

const NAME = /^([0-9]{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

/** The SHA-256 of a migration's text, with CRLF read as LF. */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

/** What is wrong with the names in a migrations folder; empty when nothing is. */
export function nameProblems(names: readonly string[]): string[] {
  const problems: string[] = [];
  const byNumber = new Map<string, string>();
  for (const name of [...names].sort()) {
    const number = NAME.exec(name)?.[1];
    if (number === undefined) {
      problems.push(
        `${name} is not a migration name: four digits, an underscore, lower-case words joined by underscores, and .sql, as in 0001_foundation.sql.`,
      );
      continue;
    }
    const earlier = byNumber.get(number);
    if (earlier !== undefined) {
      problems.push(`${earlier} and ${name} have the same number.`);
    }
    byNumber.set(number, name);
  }
  return problems;
}

/** The migrations in a folder, in order. A name that is not a migration's, or a folder among them, fails. */
export function readMigrations(folder: string = MIGRATIONS_FOLDER): Migration[] {
  const names = readdirSync(folder).sort();
  const problems = nameProblems(names);
  for (const name of names) {
    if (statSync(join(folder, name)).isDirectory()) {
      problems.push(`${name} is a folder, not a migration file.`);
    }
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return names.map((name) => {
    const sql = readFileSync(join(folder, name), "utf8");
    return { name, sql, sha256: checksum(sql) };
  });
}

async function single<T>(client: ClientBase, sql: string): Promise<T> {
  const found = await client.query<{ value: T }>(sql);
  return (found.rows[0] as { value: T }).value;
}

/** Applies one migration in its own transaction, with the table guard before the commit. */
async function apply(client: ClientBase, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)");
    const before = await single<string>(client, "SELECT pg_catalog.pg_current_xact_id()::text AS value");
    try {
      await client.query(migration.sql);
    } catch (error) {
      // The driver rejects a failed query with an Error.
      throw new Error(`${migration.name}: ${(error as Error).message}`, { cause: error });
    }
    if ((await single<string>(client, "SELECT pg_catalog.pg_current_xact_id()::text AS value")) !== before) {
      throw new Error(
        `${migration.name} ended the runner's transaction. A migration holds no BEGIN, COMMIT or ROLLBACK: the runner wraps each file in one transaction. What the file ran before that may be committed.`,
      );
    }
    await client.query("INSERT INTO meta.schema_migrations (name, sha256, applied_by) VALUES ($1, $2, current_user)", [
      migration.name,
      migration.sha256,
    ]);
    const problems = await tableGuardProblems(client);
    if (problems.length > 0) {
      throw new Error(`${migration.name}: the table guard found problems, so the migration was rolled back:\n${problems.join("\n")}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Applies the pending migrations, in order, and gives their names. */
export async function migrate(client: ClientBase, migrations: readonly Migration[]): Promise<string[]> {
  const role = await single<string>(client, "SELECT current_user::text AS value");
  if (role !== OWNER) {
    throw new Error(`Migrations run as ${OWNER}, not ${role}.`);
  }
  await client.query("SELECT pg_catalog.pg_advisory_lock($1)", [LOCK]);
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS meta;
      CREATE TABLE IF NOT EXISTS meta.schema_migrations (
        name text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_by name NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT pg_catalog.now()
      )`);
    const found = await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM meta.schema_migrations ORDER BY name");
    const onDisk = new Map(migrations.map((migration) => [migration.name, migration]));
    for (const { name, sha256 } of found.rows) {
      const migration = onDisk.get(name);
      if (migration === undefined) {
        throw new Error(`${name} was applied, but it is not in the migrations folder.`);
      }
      if (migration.sha256 !== sha256) {
        throw new Error(`${name} has changed since it was applied. A migration never changes once it is applied: add a new one.`);
      }
    }
    const done = new Set(found.rows.map((row) => row.name));
    const last = found.rows.at(-1)?.name ?? "";
    const pending = migrations.filter((migration) => !done.has(migration.name));
    const early = pending.find((migration) => migration.name < last);
    if (early !== undefined) {
      throw new Error(`${early.name} is new, but it sorts before ${last}, which is applied already. Give it a later number.`);
    }
    for (const migration of pending) {
      await apply(client, migration);
    }
    return pending.map((migration) => migration.name);
  } finally {
    await client.query("SELECT pg_catalog.pg_advisory_unlock($1)", [LOCK]);
  }
}

/** Connects as NORTFOX_DATABASE_URL and NORTFOX_DATABASE_PASSWORD_FILE say, and applies db/migrations. */
export async function migrateFromEnvironment(env: Environment): Promise<string[]> {
  const client = new Client(configFromEnvironment(env));
  await client.connect();
  try {
    return await migrate(client, readMigrations());
  } finally {
    await client.end();
  }
}
