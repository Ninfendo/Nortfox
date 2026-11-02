// SPDX-License-Identifier: AGPL-3.0-only

// The database roles (docs/decisions/0009): the app reads and writes rows,
// nothing more, and no runtime role is a superuser or bypasses row level
// security.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES_FILE } from "../../../test/cluster.ts";
import { INSUFFICIENT_PRIVILEGE, expectError, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { guardedRelations } from "../../db/table-guard.ts";

/** The app's privileges on each table: SELECT, and only the writes each table needs. */
const APP_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  "audit.history": ["SELECT"],
  "ledger.companies": ["INSERT", "SELECT", "UPDATE"],
  "ledger.reader_roles": [],
  "meta.schema_migrations": [],
};

/** A reader's privileges: SELECT on each company table. */
const READER_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  "audit.history": ["SELECT"],
  "ledger.companies": ["SELECT"],
  "ledger.reader_roles": ["SELECT"],
  "meta.schema_migrations": [],
};

const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

describe("the database roles", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  const company = randomUUID();
  const actor = randomUUID();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    await inTransaction(app, { company, actor, kind: "user" }, () =>
      app.query("INSERT INTO ledger.companies (company_id, name, organization_number) VALUES ($1, 'Testbolaget Alfa AB', '556000-0167')", [company]),
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it.each([
    ["make a table in ledger", "CREATE TABLE ledger.mine (a integer)"],
    ["make a table in public", "CREATE TABLE public.mine (a integer)"],
    ["make a schema", "CREATE SCHEMA mine"],
    ["add a column", "ALTER TABLE ledger.companies ADD COLUMN mine integer"],
    ["drop a table", "DROP TABLE audit.history"],
    ["take a table over", "ALTER TABLE ledger.companies OWNER TO nortfox_app"],
    ["drop a trigger", "DROP TRIGGER audit_history ON ledger.companies"],
    ["disable a trigger", "ALTER TABLE ledger.companies DISABLE TRIGGER audit_history"],
    ["disable every trigger", "ALTER TABLE ledger.companies DISABLE TRIGGER ALL"],
    ["make a trigger", "CREATE TRIGGER mine BEFORE INSERT ON ledger.companies FOR EACH ROW EXECUTE FUNCTION ledger.refuse_truncate()"],
    ["stop forcing row level security", "ALTER TABLE ledger.companies NO FORCE ROW LEVEL SECURITY"],
    ["turn row level security off", "ALTER TABLE ledger.companies DISABLE ROW LEVEL SECURITY"],
    ["drop a policy", "DROP POLICY company_app ON ledger.companies"],
    ["make a policy", "CREATE POLICY mine ON ledger.companies TO nortfox_app USING (true)"],
    ["replace a function", "CREATE OR REPLACE FUNCTION ledger.current_company_id() RETURNS uuid LANGUAGE sql RETURN NULL"],
    ["make a function", "CREATE FUNCTION public.mine() RETURNS integer LANGUAGE sql RETURN 1"],
    ["make a temporary table", "CREATE TEMPORARY TABLE mine (a integer)"],
    ["make a temporary function", "CREATE FUNCTION pg_temp.mine() RETURNS integer LANGUAGE sql RETURN 1"],
    ["install an extension", "CREATE EXTENSION pgcrypto"],
    ["empty a table", "TRUNCATE ledger.companies"],
    ["switch the triggers off as for replication", "SET session_replication_role = replica"],
    ["become the owner", "SET ROLE nortfox_owner"],
    ["become a reader", "SET ROLE nortfox_reader"],
    ["give itself a role", "GRANT nortfox_owner TO nortfox_app"],
    ["call a function that only triggers call", "SELECT ledger.refuse('unbalanced', '{}')"],
    ["read the actor through the trigger's helper", "SELECT * FROM ledger.current_actor()"],
    ["give out the next tenant id", "SELECT nextval('ledger.database_number_seq')"],
  ])("refuses the app to %s", async (_case, sql) => {
    await expectError(app.query(sql), INSUFFICIENT_PRIVILEGE);
  });

  it("refuses the app to read past row level security", async () => {
    await app.query("SET row_security = off");
    try {
      await expectError(
        inTransaction(app, { company }, () => app.query("SELECT * FROM ledger.companies")),
        INSUFFICIENT_PRIVILEGE,
        /query would be affected by row-level security policy/,
      );
    } finally {
      await app.query("RESET row_security");
    }
  });

  it("gives the app exactly the privileges each table needs, and a reader only SELECT", async () => {
    const tables = await guardedRelations(owner);
    expect([...tables].sort()).toEqual(Object.keys(APP_PRIVILEGES).sort());
    for (const [role, wanted] of [
      ["nortfox_app", APP_PRIVILEGES],
      ["nortfox_test_reader_a", READER_PRIVILEGES],
    ] as const) {
      for (const table of tables) {
        const found = await owner.query<{ privilege: string }>(
          "SELECT p AS privilege FROM pg_catalog.unnest($3::text[]) AS p WHERE pg_catalog.has_table_privilege($1, $2, p) ORDER BY 1",
          [role, table, TABLE_PRIVILEGES],
        );
        expect(found.rows.map((row) => row.privilege), `${role} on ${table}`).toEqual(wanted[table]);
      }
      const sequence = await owner.query<{ may: boolean }>(
        "SELECT pg_catalog.has_sequence_privilege($1, 'ledger.database_number_seq', 'USAGE, SELECT, UPDATE') AS may",
        [role],
      );
      expect(sequence.rows[0]?.may).toBe(false);
    }
  });

  it("makes no runtime role, nor the owner, a superuser, or able to make roles or databases, replicate or bypass row level security", async () => {
    const found = await app.query<{
      name: string;
      super: boolean;
      createrole: boolean;
      createdb: boolean;
      replication: boolean;
      bypassrls: boolean;
      login: boolean;
      inherit: boolean;
    }>(`
      SELECT rolname::text AS name, rolsuper AS super, rolcreaterole AS createrole, rolcreatedb AS createdb,
        rolreplication AS replication, rolbypassrls AS bypassrls, rolcanlogin AS login, rolinherit AS inherit
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('nortfox_owner', 'nortfox_app', 'nortfox_reader')
        OR oid IN (SELECT m.member FROM pg_catalog.pg_auth_members AS m WHERE m.roleid = 'nortfox_reader'::pg_catalog.regrole)
      ORDER BY 1`);
    const none = { super: false, createrole: false, createdb: false, replication: false, bypassrls: false };
    expect(found.rows).toEqual([
      { name: "nortfox_app", ...none, login: true, inherit: false },
      { name: "nortfox_owner", ...none, login: true, inherit: true },
      { name: "nortfox_reader", ...none, login: false, inherit: false },
      { name: "nortfox_test_reader_a", ...none, login: true, inherit: true },
      { name: "nortfox_test_reader_b", ...none, login: true, inherit: true },
    ]);
  });

  it("makes the app, the owner and the reader group members of no role, and each reader role a member of the group that cannot SET ROLE to it", async () => {
    const found = await app.query<{ member: string; granted: string; inherit: boolean; set: boolean; admin: boolean }>(`
      SELECT member.rolname::text AS member, granted.rolname::text AS granted,
        m.inherit_option AS inherit, m.set_option AS set, m.admin_option AS admin
      FROM pg_catalog.pg_auth_members AS m
      JOIN pg_catalog.pg_roles AS member ON member.oid = m.member
      JOIN pg_catalog.pg_roles AS granted ON granted.oid = m.roleid
      WHERE member.rolname IN ('nortfox_owner', 'nortfox_app', 'nortfox_reader')
        OR granted.rolname IN ('nortfox_owner', 'nortfox_app', 'nortfox_reader')
      ORDER BY 1, 2`);
    expect(found.rows).toEqual([
      { member: "nortfox_test_reader_a", granted: "nortfox_reader", inherit: true, set: false, admin: false },
      { member: "nortfox_test_reader_b", granted: "nortfox_reader", inherit: true, set: false, admin: false },
    ]);
  });

  it("opens no function of ours to PUBLIC, pins each one's search path, and runs each trigger with the owner's rights", async () => {
    const found = await owner.query<{ name: string; owner: string; public: boolean; config: string[] | null; trigger: boolean; definer: boolean }>(`
      SELECT n.nspname || '.' || p.proname AS name, pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,
        EXISTS (
          SELECT FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a WHERE a.grantee = 0
        ) AS public,
        p.proconfig AS config, p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype AS trigger, p.prosecdef AS definer
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('ledger', 'audit', 'meta')
      ORDER BY 1`);
    expect(found.rows.filter((row) => row.trigger).length).toBeGreaterThan(0);
    for (const row of found.rows) {
      expect(row, row.name).toMatchObject({ owner: "nortfox_owner", public: false, config: ["search_path=pg_catalog, pg_temp"] });
      if (row.trigger) {
        expect(row.definer, row.name).toBe(true);
      }
    }
  });

  it("puts a wrong attribute or membership right when db/roles.sql runs again", async () => {
    const admin = await db.admin();
    const roles = readFileSync(ROLES_FILE, "utf8");
    try {
      await admin.query("ALTER ROLE nortfox_app CREATEDB");
      await admin.query("GRANT nortfox_reader TO nortfox_app");
      await admin.query(roles);
      const found = await admin.query<{ createdb: boolean; memberships: bigint }>(`
        SELECT r.rolcreatedb AS createdb, (SELECT count(*) FROM pg_catalog.pg_auth_members AS m WHERE m.member = r.oid) AS memberships
        FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'nortfox_app'`);
      expect(found.rows).toEqual([{ createdb: false, memberships: 0n }]);
    } finally {
      await admin.query(roles);
    }
  });
});
