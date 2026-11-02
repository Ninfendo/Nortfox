// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { urlOf } from "../../test/cluster.ts";
import { emptyDatabase, failureOf, type TestDatabase } from "../../test/database.ts";
import { MIGRATIONS_FOLDER, checksum, migrate, migrateFromEnvironment, readMigrations, type Migration } from "./migrate.ts";
import { tableGuardProblems } from "./table-guard.ts";

const FOUNDATION = readFileSync(join(MIGRATIONS_FOLDER, "0001_foundation.sql"), "utf8");

/** A company table with everything the guard needs. */
const GUARDED_TABLE = `-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE ledger.notes (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES ledger.companies (company_id), note text);
SELECT meta.protect_company_table('ledger.notes', 'id');
`;

const folders: string[] = [];
const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

/** The foundation and the given files, as the runner reads them from a folder. */
function migrationsWith(files: Record<string, string> = {}): Migration[] {
  const folder = mkdtempSync(join(tmpdir(), "nortfox-migrations-"));
  folders.push(folder);
  for (const [name, text] of Object.entries({ "0001_foundation.sql": FOUNDATION, ...files })) {
    writeFileSync(join(folder, name), text);
  }
  return readMigrations(folder);
}

async function empty(): Promise<{ db: TestDatabase; owner: Client }> {
  const db = await emptyDatabase();
  databases.push(db);
  return { db, owner: await db.connect("owner") };
}

async function applied(owner: Client): Promise<{ name: string; sha256: string; applied_by: string }[]> {
  const found = await owner.query<{ name: string; sha256: string; applied_by: string }>(
    "SELECT name, sha256, applied_by FROM meta.schema_migrations ORDER BY name",
  );
  return found.rows;
}

async function exists(owner: Client, relation: string): Promise<boolean> {
  const found = await owner.query<{ found: boolean }>("SELECT pg_catalog.to_regclass($1) IS NOT NULL AS found", [relation]);
  return found.rows[0]?.found === true;
}

describe("the migration runner", () => {
  it("applies every migration to an empty database as the owner, records each, and then has nothing to do", async () => {
    const { owner } = await empty();
    const migrations = readMigrations();
    expect(await migrate(owner, migrations)).toEqual(migrations.map((migration) => migration.name));
    expect(await applied(owner)).toEqual(
      migrations.map((migration) => ({ name: migration.name, sha256: checksum(migration.sql), applied_by: "nortfox_owner" })),
    );
    expect(await tableGuardProblems(owner)).toEqual([]);
    expect(await migrate(owner, migrations)).toEqual([]);
  });

  it("leaves only the app and the readers able to connect, and no one able to make a temporary table", async () => {
    const { owner } = await empty();
    await migrate(owner, readMigrations());
    const found = await owner.query<{ entry: string }>(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS entry
       FROM pg_catalog.pg_database AS d, pg_catalog.aclexplode(d.datacl) AS a WHERE d.datname = current_database() ORDER BY 1`,
    );
    expect(found.rows.map((row) => row.entry)).toEqual([
      "nortfox_app:CONNECT",
      "nortfox_owner:CONNECT",
      "nortfox_owner:CREATE",
      "nortfox_owner:TEMPORARY",
      "nortfox_reader:CONNECT",
    ]);
  });

  it("refuses to run as any role but the owner", async () => {
    const { db } = await empty();
    const app = await db.connect("app");
    await expect(migrate(app, readMigrations())).rejects.toThrow("Migrations run as nortfox_owner, not nortfox_app.");
  });

  it("rolls back a migration that adds a table without its protection, and names what it lacks", async () => {
    const { owner } = await empty();
    const error = await failureOf(
      migrate(owner, migrationsWith({ "0002_bare.sql": "CREATE TABLE ledger.bare (id uuid PRIMARY KEY, company_id uuid NOT NULL);\n" })),
    );
    expect(String(error)).toContain("0002_bare.sql: the table guard found problems, so the migration was rolled back:");
    expect(String(error)).toContain("ledger.bare: row level security is not enabled.");
    expect(String(error)).toContain("ledger.bare: has no audit_history trigger");
    expect(await exists(owner, "ledger.bare")).toBe(false);
    expect((await applied(owner)).map((row) => row.name)).toEqual(["0001_foundation.sql"]);
  });

  it("rolls back a migration that fails, and records nothing of it", async () => {
    const { owner } = await empty();
    const error = await failureOf(migrate(owner, migrationsWith({ "0002_broken.sql": "CREATE TABLE ledger.half (id uuid);\nSELECT 1 / 0;\n" })));
    expect(String(error)).toContain("0002_broken.sql: division by zero");
    expect(await exists(owner, "ledger.half")).toBe(false);
    expect((await applied(owner)).map((row) => row.name)).toEqual(["0001_foundation.sql"]);
  });

  it("runs a migration with only pg_catalog on the search path, so every name of ours is written in full", async () => {
    const { owner } = await empty();
    const error = await failureOf(migrate(owner, migrationsWith({ "0002_short.sql": "SELECT current_company_id();\n" })));
    expect(String(error)).toContain("0002_short.sql: function current_company_id() does not exist");
  });

  it("refuses a migration that ends the runner's transaction", async () => {
    const { owner } = await empty();
    const error = await failureOf(migrate(owner, migrationsWith({ "0002_commit.sql": "SELECT 1;\nCOMMIT;\n" })));
    expect(String(error)).toContain(
      "0002_commit.sql ended the runner's transaction. A migration holds no BEGIN, COMMIT or ROLLBACK: the runner wraps each file in one transaction. What the file ran before that may be committed.",
    );
  });

  it("refuses an applied migration that is gone from the folder or has changed, and reads CRLF as LF", async () => {
    const { owner } = await empty();
    expect(await migrate(owner, migrationsWith({ "0002_notes.sql": GUARDED_TABLE }))).toEqual(["0001_foundation.sql", "0002_notes.sql"]);
    await expect(migrate(owner, migrationsWith())).rejects.toThrow("0002_notes.sql was applied, but it is not in the migrations folder.");
    await expect(migrate(owner, migrationsWith({ "0002_notes.sql": `${GUARDED_TABLE}-- changed\n` }))).rejects.toThrow(
      "0002_notes.sql has changed since it was applied. A migration never changes once it is applied: add a new one.",
    );
    expect(await migrate(owner, migrationsWith({ "0002_notes.sql": GUARDED_TABLE.replaceAll("\n", "\r\n") }))).toEqual([]);
  });

  it("refuses a new migration that sorts before one that is applied", async () => {
    const { owner } = await empty();
    await migrate(owner, migrationsWith({ "0003_notes.sql": GUARDED_TABLE }));
    await expect(
      migrate(owner, migrationsWith({ "0002_late.sql": "SELECT 1;\n", "0003_notes.sql": GUARDED_TABLE })),
    ).rejects.toThrow("0002_late.sql is new, but it sorts before 0003_notes.sql, which is applied already. Give it a later number.");
  });

  it("lets two runners at once apply each migration once", async () => {
    const { db } = await empty();
    const [first, second] = [await db.connect("owner"), await db.connect("owner")];
    const migrations = readMigrations();
    const results = await Promise.all([migrate(first, migrations), migrate(second, migrations)]);
    expect(results.flat()).toEqual(migrations.map((migration) => migration.name));
  });
});

describe("migrateFromEnvironment", () => {
  it("connects as the environment says and applies db/migrations", async () => {
    const db = await emptyDatabase();
    databases.push(db);
    const folder = mkdtempSync(join(tmpdir(), "nortfox-secret-"));
    folders.push(folder);
    writeFileSync(join(folder, "password"), "made-up-password\n");
    const env = { NORTFOX_DATABASE_URL: urlOf("nortfox_owner", db.name), NORTFOX_DATABASE_PASSWORD_FILE: join(folder, "password") };
    expect(await migrateFromEnvironment(env)).toEqual(readMigrations().map((migration) => migration.name));
    expect(await migrateFromEnvironment(env)).toEqual([]);
  });

  it("fails loudly without its settings, and closes the connection when the runner fails", async () => {
    await expect(migrateFromEnvironment({})).rejects.toThrow("NORTFOX_DATABASE_URL is not set.");
    const db = await emptyDatabase();
    databases.push(db);
    const folder = mkdtempSync(join(tmpdir(), "nortfox-secret-"));
    folders.push(folder);
    writeFileSync(join(folder, "password"), "made-up-password\n");
    await expect(
      migrateFromEnvironment({ NORTFOX_DATABASE_URL: urlOf("nortfox_app", db.name), NORTFOX_DATABASE_PASSWORD_FILE: join(folder, "password") }),
    ).rejects.toThrow("Migrations run as nortfox_owner, not nortfox_app.");
  });
});
