// SPDX-License-Identifier: AGPL-3.0-only

// The database roles (docs/decisions/0009): the app reads and writes rows,
// nothing more, and no runtime role is a superuser or bypasses row level
// security.

import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  DATABASE_FILE,
  OTHER_DATABASES_FILE,
  PREFIX,
  ROLES_FILE,
  TEMPORARY_ROLE_PREFIX,
  adminClient,
  connectAs,
  makeReaderRole,
} from "../../../test/cluster.ts";
import { INSUFFICIENT_PRIVILEGE, begin, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addCompany } from "../../../test/ledger.ts";
import { guardedRelations } from "../../db/table-guard.ts";

/** The app's privileges on each table: SELECT, and only the writes each table needs. */
const APP_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  "access.account_events": ["INSERT", "SELECT"],
  "access.attempt_counters": [],
  "access.idempotency_keys": ["INSERT", "SELECT"],
  "access.identities": ["SELECT", "UPDATE"],
  "access.install_keys": [],
  "access.known_devices": [],
  "access.login_challenges": [],
  "access.password_credentials": [],
  "access.sessions": [],
  "access.setup_tokens": [],
  "access.totp_secrets": [],
  "audit.history": ["SELECT"],
  "ledger.accounts": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "ledger.automatic_locks": ["SELECT", "UPDATE"],
  "ledger.companies": ["INSERT", "SELECT", "UPDATE"],
  "ledger.deleted_voucher_rows": ["SELECT"],
  "ledger.deleted_vouchers": ["SELECT"],
  "ledger.fiscal_years": ["INSERT", "SELECT", "UPDATE"],
  "ledger.idempotency_keys": ["INSERT", "SELECT"],
  "ledger.period_locks": ["INSERT", "SELECT", "UPDATE"],
  "ledger.periods": ["INSERT", "SELECT", "UPDATE"],
  "ledger.reader_roles": [],
  "ledger.transaction_actors": [],
  "ledger.void_ranges": ["SELECT"],
  "ledger.voucher_counters": ["SELECT"],
  "ledger.voucher_rows": ["INSERT", "SELECT", "UPDATE"],
  "ledger.voucher_series": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "ledger.vouchers": ["DELETE", "INSERT", "SELECT", "UPDATE"],
  "meta.schema_migrations": [],
};

/** A reader's privileges: SELECT on each company table, and nothing on an install-wide table. */
const READER_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  "access.account_events": [],
  "access.attempt_counters": [],
  "access.idempotency_keys": [],
  "access.identities": [],
  "access.install_keys": [],
  "access.known_devices": [],
  "access.login_challenges": [],
  "access.password_credentials": [],
  "access.sessions": [],
  "access.setup_tokens": [],
  "access.totp_secrets": [],
  "audit.history": ["SELECT"],
  "ledger.accounts": ["SELECT"],
  "ledger.automatic_locks": ["SELECT"],
  "ledger.companies": ["SELECT"],
  "ledger.deleted_voucher_rows": ["SELECT"],
  "ledger.deleted_vouchers": ["SELECT"],
  "ledger.fiscal_years": ["SELECT"],
  "ledger.idempotency_keys": ["SELECT"],
  "ledger.period_locks": ["SELECT"],
  "ledger.periods": ["SELECT"],
  "ledger.reader_roles": ["SELECT"],
  "ledger.transaction_actors": [],
  "ledger.void_ranges": ["SELECT"],
  "ledger.voucher_counters": ["SELECT"],
  "ledger.voucher_rows": ["SELECT"],
  "ledger.voucher_series": ["SELECT"],
  "ledger.vouchers": ["SELECT"],
  "meta.schema_migrations": [],
};

/**
 * The functions each role may call. The rest run only inside the database's
 * own triggers and policies, as the owner.
 */
const CALLABLE_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  nortfox_app: [
    "access.attempt_counter",
    "access.challenge_by_token",
    "access.claim_attempt",
    "access.clear_attempts",
    "access.complete_setup",
    "access.count_failure",
    "access.create_setup_token",
    "access.current_person_id",
    "access.end_other_sessions",
    "access.end_session",
    "access.find_login",
    "access.install_key",
    "access.known_device",
    "access.lock_attempts",
    "access.open_challenge",
    "access.open_session",
    "access.purge_expired",
    "access.remember_device",
    "access.session_by_token",
    "access.touch_session",
    "access.use_challenge",
    "access.use_totp_step",
    "ledger.applicable_locks",
    "ledger.automatic_lock_end_date",
    "ledger.current_company_id",
    "ledger.day_in_sweden",
    "ledger.lock_covering",
    "ledger.locked_through",
    "ledger.today_in_sweden",
  ],
  nortfox_test_reader_a: ["ledger.current_company_id", "ledger.current_role_oid", "ledger.reader_company_id"],
};

const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** db/README.md, whose steps to remove a reader a test runs. */
const README_FILE = fileURLToPath(new URL("../../../../../db/README.md", import.meta.url));

/** PostgreSQL's SQLSTATE for a role that objects or entries still depend on. */
const DEPENDENT_OBJECTS_STILL_EXIST = "2BP01";

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
    ["check a date against the lock as the triggers do", `SELECT ledger.assert_open('${randomUUID()}', '2090-01-01', true)`],
    ["check a voucher against the lock as the triggers do", `SELECT ledger.assert_voucher_open('${randomUUID()}', '${randomUUID()}', 'A', '2090-01-01')`],
    ["read the actor through the trigger's helper", "SELECT * FROM ledger.current_actor()"],
    ["read the actor that a transaction keeps", "SELECT * FROM ledger.transaction_actors"],
    ["change the actor that a transaction keeps", "DELETE FROM ledger.transaction_actors"],
    ["change the channel that a transaction keeps", "UPDATE ledger.transaction_actors SET channel = 'mcp'"],
    ["change a stored idempotency key", "UPDATE ledger.idempotency_keys SET response_status = 200"],
    ["delete a stored idempotency key", "DELETE FROM ledger.idempotency_keys"],
    ["call the trigger that stamps an idempotency key", "SELECT ledger.idempotency_keys_rules()"],
    ["give out the next tenant id", "SELECT nextval('ledger.database_number_seq')"],
    ["make a table in access", "CREATE TABLE access.mine (a integer)"],
    ["read the password hashes", "SELECT * FROM access.password_credentials"],
    ["read the sessions", "SELECT * FROM access.sessions"],
    ["delete an identity", "DELETE FROM access.identities"],
    ["empty the identities", "TRUNCATE access.identities"],
    ["call the trigger that keeps the identities' rules", "SELECT access.identities_rules()"],
    ["call the trigger that keeps a column set once", "SELECT access.keep_set_once()"],
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
      { name: "nortfox_test_reader_c", ...none, login: true, inherit: true },
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
      { member: "nortfox_test_reader_c", granted: "nortfox_reader", inherit: true, set: false, admin: false },
    ]);
  });

  it("lets the app and a reader call only the functions they need", async () => {
    for (const [role, wanted] of Object.entries(CALLABLE_FUNCTIONS)) {
      const found = await owner.query<{ name: string }>(
        `SELECT DISTINCT n.nspname || '.' || p.proname AS name
         FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('access', 'ledger', 'audit', 'meta') AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
         ORDER BY 1`,
        [role],
      );
      expect(found.rows.map((row) => row.name), role).toEqual(wanted);
    }
  });

  it("opens no function of ours to PUBLIC, pins each one's search path, and runs each trigger with the owner's rights", async () => {
    const found = await owner.query<{ name: string; owner: string; public: boolean; config: string[] | null; trigger: boolean; definer: boolean }>(`
      SELECT n.nspname || '.' || p.proname AS name, pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,
        EXISTS (
          SELECT FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a WHERE a.grantee = 0
        ) AS public,
        p.proconfig AS config, p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype AS trigger, p.prosecdef AS definer
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('access', 'ledger', 'audit', 'meta')
      ORDER BY 1`);
    expect(found.rows.filter((row) => row.trigger).length).toBeGreaterThan(0);
    for (const row of found.rows) {
      expect(row, row.name).toMatchObject({ owner: "nortfox_owner", public: false, config: ["search_path=pg_catalog, pg_temp"] });
      if (row.trigger) {
        expect(row.definer, row.name).toBe(true);
      }
    }
  });

  it.each([
    ["lo_creat", "SELECT pg_catalog.lo_creat(-1)"],
    ["lo_create", "SELECT pg_catalog.lo_create(0)"],
    ["lo_from_bytea", "SELECT pg_catalog.lo_from_bytea(0, '\\x6e6f7274666f78'::bytea)"],
  ])("refuses the app, a reader and the owner a large object, which no table, policy or history would hold: %s", async (_name, sql) => {
    const reader = await db.connect("readerA");
    for (const client of [app, reader, owner]) {
      await expectError(client.query(sql), INSUFFICIENT_PRIVILEGE, /permission denied for function/);
    }
    const admin = await db.admin();
    const found = await admin.query<{ count: bigint }>("SELECT count(*) AS count FROM pg_catalog.pg_largeobject_metadata");
    expect(found.rows[0]?.count).toBe(0n);
  });

  it.each([
    ["as text", "SELECT pg_catalog.pg_logical_emit_message(false, 'nortfox', 'made-up bytes')"],
    ["as bytes", "SELECT pg_catalog.pg_logical_emit_message(true, 'nortfox', '\\x6e6f7274666f78'::bytea, false)"],
  ])(
    "refuses the app, a reader and the owner a message in the WAL, which the backups would keep outside every table: %s",
    async (_name, sql) => {
      const reader = await db.connect("readerA");
      for (const client of [app, reader, owner]) {
        await expectError(client.query(sql), INSUFFICIENT_PRIVILEGE, /permission denied for function pg_logical_emit_message/);
      }
    },
  );

  // The ledger's triggers take an advisory lock for each company, its turn
  // (ledger.take_turn). A role that held a company's key could stop its
  // bookings, so db/database.sql leaves advisory locks to the owner alone.
  it("lets no role of ours but the owner take an advisory lock, which could hold a company's turn, and the owner only the ones it takes", async () => {
    const found = await owner.query<{ name: string; app: boolean; reader: boolean; owner: boolean }>(`
      SELECT p.oid::pg_catalog.regprocedure::text AS name,
        pg_catalog.has_function_privilege('nortfox_app', p.oid, 'EXECUTE') AS app,
        pg_catalog.has_function_privilege('nortfox_test_reader_a', p.oid, 'EXECUTE') AS reader,
        pg_catalog.has_function_privilege('nortfox_owner', p.oid, 'EXECUTE') AS owner
      FROM pg_catalog.pg_proc AS p
      WHERE p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace AND p.proname LIKE '%advisory%'`);
    expect(found.rows.length).toBe(21);
    expect(found.rows.filter((row) => row.app || row.reader)).toEqual([]);
    expect(
      found.rows
        .filter((row) => row.owner)
        .map((row) => row.name)
        .sort(),
    ).toEqual(["pg_advisory_lock(bigint)", "pg_advisory_unlock(bigint)", "pg_advisory_xact_lock(integer,integer)", "pg_advisory_xact_lock_shared(integer,integer)"]);
    const reader = await db.connect("readerA");
    for (const client of [app, reader]) {
      for (const sql of ["SELECT pg_catalog.pg_advisory_lock(4646210, 1)", "SELECT pg_catalog.pg_try_advisory_lock_shared(1)", "SELECT pg_catalog.pg_advisory_xact_lock(1)"]) {
        await expectError(client.query(sql), INSUFFICIENT_PRIVILEGE, /permission denied for function pg_(try_)?advisory/);
      }
    }
  });

  // The company's turn is an advisory lock on the hash of the company's id.
  // pg_locks, and pg_lock_status() under it, would show it to every role
  // while it is held, with its mode and its transaction: when each other
  // company books, and when it changes a lock. So db/database.sql closes both.
  it("refuses the app, a reader and the owner pg_locks, which would show another company's turn while it changes", async () => {
    const changer = await db.connect("app");
    const reader = await db.connect("readerA");
    const admin = await db.admin();
    const other = await addCompany(changer);
    await begin(changer, { company: other, actor, kind: "user" });
    try {
      // A change of the automatic lock takes the company's turn alone.
      await changer.query("UPDATE ledger.automatic_locks SET notice_days = notice_days");
      for (const client of [app, reader, owner]) {
        await expectError(client.query("SELECT classid, objid, mode FROM pg_catalog.pg_locks WHERE locktype = 'advisory'"), INSUFFICIENT_PRIVILEGE, /permission denied for view pg_locks/);
        await expectError(client.query("SELECT classid, objid, mode FROM pg_catalog.pg_lock_status()"), INSUFFICIENT_PRIVILEGE, /permission denied for function pg_lock_status/);
      }
      // The superuser still sees the turn.
      const turns = await admin.query<{ mode: string }>(
        `SELECT mode FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory' AND classid = 4646210 AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = $1)`,
        [db.name],
      );
      expect(turns.rows).toEqual([{ mode: "ExclusiveLock" }]);
    } finally {
      await changer.query("ROLLBACK");
    }
    const privileges = await admin.query<{ who: string; view: boolean; fn: boolean }>(
      `SELECT who, pg_catalog.has_table_privilege(who, 'pg_catalog.pg_locks', 'SELECT') AS view,
         pg_catalog.has_function_privilege(who, 'pg_catalog.pg_lock_status()', 'EXECUTE') AS fn
       FROM pg_catalog.unnest($1::text[]) AS who ORDER BY 1`,
      [["nortfox_app", "nortfox_owner", "nortfox_reader", "nortfox_test_reader_a"]],
    );
    expect(privileges.rows.filter((row) => row.view || row.fn)).toEqual([]);
  });

  // A limit that db/README.md states. PostgreSQL lets every role set its own
  // defaults, and has no privilege to take that away. So a reader can keep
  // some text of its own in the cluster's catalog, outside the ledger. Only
  // PostgreSQL's own settings that any role may set take it: a setting of
  // ours is refused, and so are another role's defaults. A superuser sees
  // them and clears them.
  it("lets a reader keep text only in its own role's defaults, which a superuser sees and clears", async () => {
    const reader = await db.connect("readerA");
    const admin = await db.admin();
    const stored = "'stored by a reader, one', 'two'";
    const settingsOf = async (): Promise<string[]> => {
      const found = await admin.query<{ setting: string }>(
        `SELECT pg_catalog.unnest(s.setconfig) AS setting
         FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.setdatabase
         WHERE d.datname = $1 AND s.setrole = 'nortfox_test_reader_a'::pg_catalog.regrole`,
        [db.name],
      );
      return found.rows.map((row) => row.setting);
    };
    await reader.query(`ALTER ROLE CURRENT_USER IN DATABASE ${db.name} SET search_path = ${stored}`);
    await expectError(reader.query(`ALTER ROLE CURRENT_USER IN DATABASE ${db.name} SET nortfox.company_id = '${company}'`), INSUFFICIENT_PRIVILEGE);
    await expectError(reader.query(`ALTER ROLE nortfox_test_reader_b IN DATABASE ${db.name} SET search_path = ${stored}`), INSUFFICIENT_PRIVILEGE);
    expect(await settingsOf()).toEqual(['search_path="stored by a reader, one", two']);
    await admin.query(`ALTER ROLE nortfox_test_reader_a IN DATABASE ${db.name} RESET ALL`);
    expect(await settingsOf()).toEqual([]);
  });

  // A second limit that db/README.md states. Every role may set default
  // privileges for the objects it would make, with any roles as grantees,
  // and PostgreSQL has no privilege to take that away. No role but the owner
  // can make an object, so such an entry changes no rule. But it stays in the
  // ledger database's own catalog, and it holds the roles it names: DROP
  // ROLE refuses them until a superuser runs DROP OWNED BY, as the removal
  // steps in db/README.md do.
  it("lets a reader keep default privileges of its own, which hold it and the roles they name until the removal steps of db/README.md run", async () => {
    const admin = await db.admin();
    const reader = `${TEMPORARY_ROLE_PREFIX}${randomBytes(4).toString("hex")}`;
    const named = `${reader}_named`;
    const entries = async (): Promise<string[]> => {
      const found = await admin.query<{ entry: string }>(
        `SELECT pg_catalog.pg_get_userbyid(d.defaclrole) || ' ' || d.defaclobjtype::text || ' ' || COALESCE(n.nspname, '*') || ' ' || d.defaclacl::text COLLATE "C" AS entry
         FROM pg_catalog.pg_default_acl AS d LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace
         WHERE pg_catalog.pg_get_userbyid(d.defaclrole) IN ($1, $2) ORDER BY 1`,
        [reader, named],
      );
      return found.rows.map((row) => row.entry);
    };
    try {
      await makeReaderRole(admin, reader);
      await makeReaderRole(admin, named);
      await inTransaction(owner, { company, actor, kind: "system" }, () => owner.query(BIND, [company, reader]));
      const client = await connectAs(reader, db.name);
      try {
        await client.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT ON TABLES TO ${named}, nortfox_app`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT USAGE ON TYPES TO ${named}`);
        // Never for another role.
        await expectError(client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE nortfox_owner GRANT SELECT ON TABLES TO ${named}`), INSUFFICIENT_PRIVILEGE);
      } finally {
        await client.end();
      }
      // The entries for every schema also keep the reader's own privileges on what it would make.
      expect(await entries()).toEqual([
        `${reader} T audit {${named}=U/${reader}}`,
        `${reader} r * {nortfox_app=ar/${reader},${reader}=arwdDxtm/${reader},${named}=ar/${reader}}`,
      ]);
      // A reader's entries hold the reader, and an entry that names another
      // reader holds that one too.
      await expectError(admin.query(`DROP ROLE ${named}`), DEPENDENT_OBJECTS_STILL_EXIST);
      await expectError(admin.query(`DROP ROLE ${reader}`), DEPENDENT_OBJECTS_STILL_EXIST);
      await removeReader(admin, named);
      expect(await entries()).toEqual([`${reader} r * {nortfox_app=ar/${reader},${reader}=arwdDxtm/${reader}}`]);
      await removeReader(admin, reader);
      expect(await entries()).toEqual([]);
      const left = await admin.query("SELECT FROM pg_catalog.pg_roles WHERE rolname IN ($1, $2)", [reader, named]);
      expect(left.rows).toEqual([]);
      expect(await readBindings()).toEqual([]);
    } finally {
      for (const role of [named, reader]) {
        const exists = await admin.query("SELECT FROM pg_catalog.pg_roles WHERE rolname = $1", [role]);
        if (exists.rows.length > 0) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      }
      await inTransaction(owner, { company, actor, kind: "system" }, () => owner.query("DELETE FROM ledger.reader_roles"));
    }
  });

  it("keeps the large objects, the WAL messages, the advisory locks and pg_locks closed when db/database.sql runs again", async () => {
    const admin = await db.admin();
    await admin.query(readFileSync(DATABASE_FILE, "utf8"));
    await expectError(app.query("SELECT pg_catalog.lo_create(0)"), INSUFFICIENT_PRIVILEGE, /permission denied for function/);
    await expectError(app.query("SELECT pg_catalog.pg_logical_emit_message(false, 'nortfox', 'x')"), INSUFFICIENT_PRIVILEGE, /permission denied for function/);
    await expectError(app.query("SELECT pg_catalog.pg_advisory_lock(1)"), INSUFFICIENT_PRIVILEGE, /permission denied for function/);
    await expectError(app.query("SELECT FROM pg_catalog.pg_locks"), INSUFFICIENT_PRIVILEGE, /permission denied for view pg_locks/);
    await expectError(app.query("SELECT FROM pg_catalog.pg_lock_status()"), INSUFFICIENT_PRIVILEGE, /permission denied for function pg_lock_status/);
  });

  it("lets no role of ours connect to another database of the cluster once db/other-databases.sql has run in it, as an install's first start runs it in postgres and template1", async () => {
    const admin = await adminClient();
    // A database with PostgreSQL's own privileges, as postgres and template1 come.
    const other = `${PREFIX}${inject("nortfoxRun")}_other_${randomBytes(4).toString("hex")}`;
    const roles = ["nortfox_owner", "nortfox_app", "nortfox_test_reader_a"];
    /** What each of our roles gets when it connects to the other database: "connected", or the error's code. */
    const connections = async (): Promise<string[]> =>
      Promise.all(
        roles.map(async (role) => {
          try {
            const client = await connectAs(role, other);
            await client.end();
            return "connected";
          } catch (error) {
            return String((error as { code?: unknown }).code);
          }
        }),
      );
    try {
      await admin.query(`CREATE DATABASE ${other}`);
      expect(await connections()).toEqual(["connected", "connected", "connected"]);
      const inOther = await adminClient(other);
      try {
        await inOther.query(readFileSync(DATABASE_FILE, "utf8"));
        await inOther.query(readFileSync(OTHER_DATABASES_FILE, "utf8"));
        // Safe to run again.
        await inOther.query(readFileSync(OTHER_DATABASES_FILE, "utf8"));
        const privileges = await inOther.query<{ who: string; may: boolean }>(
          `SELECT who, pg_catalog.has_database_privilege(who, pg_catalog.current_database(), 'CONNECT, TEMPORARY') AS may
           FROM pg_catalog.unnest($1::text[]) AS who ORDER BY 1`,
          [[...roles, "nortfox_reader"]],
        );
        expect(privileges.rows.filter((row) => row.may)).toEqual([]);
      } finally {
        await inOther.end();
      }
      expect(await connections()).toEqual([INSUFFICIENT_PRIVILEGE, INSUFFICIENT_PRIVILEGE, INSUFFICIENT_PRIVILEGE]);
      // The superuser still connects.
      const again = await adminClient(other);
      await again.end();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${other} WITH (FORCE)`);
      await admin.end();
    }
  });

  /** The companies that `role` reads, in a connection of its own. */
  async function readBy(role: string): Promise<string[]> {
    const reader = await connectAs(role, db.name);
    try {
      return (await reader.query<{ company_id: string }>("SELECT company_id FROM ledger.companies")).rows.map((row) => row.company_id);
    } finally {
      await reader.end();
    }
  }

  const BIND = "INSERT INTO ledger.reader_roles AS t (company_id, role_oid) VALUES ($1, $2::pg_catalog.regrole) RETURNING pg_catalog.to_jsonb(t) AS row";

  /** The names of the company's reader bindings, read as the owner. */
  async function readBindings(): Promise<string[]> {
    return inTransaction(owner, { company }, async () =>
      (await owner.query<{ name: string }>("SELECT role_name AS name FROM ledger.reader_roles ORDER BY 1")).rows.map((row) => row.name),
    );
  }

  /**
   * Removes the reader `role` by the steps that db/README.md gives: the
   * owner's statements, with the company and an actor set, then the
   * superuser's, as `admin` in the ledger database.
   */
  async function removeReader(admin: Client, role: string): Promise<void> {
    const readme = readFileSync(README_FILE, "utf8").replaceAll("\r\n", "\n");
    const steps = /^To remove a reader,.*\n\n```sql\n([\s\S]*?)```/m.exec(readme)?.[1];
    if (steps === undefined) {
      throw new Error("db/README.md gives no steps to remove a reader.");
    }
    const [asOwner = "", asSuperuser = ""] = steps.replaceAll("example_reader", role).split(/^-- then, as a superuser.*$/m);
    const statements = (sql: string): string[] =>
      sql
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n")
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement !== "");
    expect(statements(asOwner).length).toBeGreaterThan(0);
    expect(statements(asSuperuser).length).toBeGreaterThan(0);
    await inTransaction(owner, { company, actor, kind: "system" }, async () => {
      for (const statement of statements(asOwner)) {
        await owner.query(statement);
      }
    });
    for (const statement of statements(asSuperuser)) {
      await admin.query(statement);
    }
  }

  it("binds a reader role by its oid and its name: a role made again with the name, another role renamed to it, or the bound role renamed, reads nothing until the owner binds it", async () => {
    const admin = await db.admin();
    const name = `${TEMPORARY_ROLE_PREFIX}${randomBytes(4).toString("hex")}`;
    const renamed = `${name}_old`;
    try {
      await makeReaderRole(admin, name);
      await inTransaction(owner, { company, actor, kind: "system" }, () => owner.query(BIND, [company, name]));
      expect(await readBy(name)).toEqual([company]);
      // The bound role, renamed, and then given its name back.
      await admin.query(`ALTER ROLE ${name} RENAME TO ${renamed}`);
      expect(await readBy(renamed)).toEqual([]);
      await admin.query(`ALTER ROLE ${renamed} RENAME TO ${name}`);
      expect(await readBy(name)).toEqual([company]);
      // Dropped and made again with the same name, as a superuser would.
      await admin.query(`DROP ROLE ${name}`);
      await makeReaderRole(admin, name);
      expect(await readBy(name)).toEqual([]);
      // Another role, renamed to the name.
      await admin.query(`DROP ROLE ${name}`);
      await makeReaderRole(admin, renamed);
      await admin.query(`ALTER ROLE ${renamed} RENAME TO ${name}`);
      expect(await readBy(name)).toEqual([]);
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
      await admin.query(`DROP ROLE IF EXISTS ${renamed}`);
    }
  });

  it("gives nothing to a role that gets the oid of a binding that a dump of another cluster brought, and lets the owner delete such bindings and bind again", async () => {
    const admin = await db.admin();
    const old = `${TEMPORARY_ROLE_PREFIX}${randomBytes(4).toString("hex")}`;
    const landed = `${old}_new`;
    try {
      // In the old cluster: the role `old`, bound to the company.
      await makeReaderRole(admin, old);
      const bound = await inTransaction(owner, { company, actor, kind: "system" }, async () =>
        (await owner.query<{ row: Record<string, unknown> }>(BIND, [company, old])).rows[0]?.row,
      );
      // The dump holds that row as it was. In the new cluster another role,
      // `landed`, gets the oid it holds. pg_restore loads the rows before it
      // makes the triggers, so none runs.
      await makeReaderRole(admin, landed);
      const oid = (await admin.query<{ oid: string }>("SELECT $1::pg_catalog.regrole::pg_catalog.oid::text AS oid", [landed])).rows[0]?.oid;
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query("INSERT INTO ledger.reader_roles SELECT * FROM pg_catalog.jsonb_populate_record(NULL::ledger.reader_roles, $1)", [
          { ...bound, id: randomUUID(), role_oid: oid },
        ]);
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      expect(await readBy(landed)).toEqual([]);
      // The owner deletes the company's bindings, as db/README.md says to after
      // such a restore, and binds the role again.
      await inTransaction(owner, { company, actor, kind: "system" }, () => owner.query("DELETE FROM ledger.reader_roles"));
      await inTransaction(owner, { company, actor, kind: "system" }, () => owner.query(BIND, [company, landed]));
      expect(await readBy(landed)).toEqual([company]);
      await inTransaction(owner, { company, actor, kind: "system" }, () => owner.query("DELETE FROM ledger.reader_roles"));
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${old}`);
      await admin.query(`DROP ROLE IF EXISTS ${landed}`);
    }
  });

  it("writes a binding's role name itself, from the role its oid names, refuses one that is given, and never lets the oid or the name change", async () => {
    const admin = await db.admin();
    const name = `${TEMPORARY_ROLE_PREFIX}${randomBytes(4).toString("hex")}`;
    const settings = { company, actor, kind: "system" } as const;
    try {
      await makeReaderRole(admin, name);
      await expectRefusal(
        inTransaction(owner, settings, () =>
          owner.query("INSERT INTO ledger.reader_roles (company_id, role_oid, role_name) VALUES ($1, $2::pg_catalog.regrole, $2)", [company, name]),
        ),
        "immutable_field",
        { field: "role_name", operation: "create" },
      );
      const bound = await inTransaction(owner, settings, async () => (await owner.query<{ row: Record<string, unknown> }>(BIND, [company, name])).rows[0]?.row);
      expect(bound?.["role_name"]).toBe(name);
      for (const [set, field] of [
        ["role_oid = 'nortfox_test_reader_c'::pg_catalog.regrole", "role_oid"],
        ["role_name = 'nortfox_test_reader_c'", "role_name"],
      ] as const) {
        await expectRefusal(
          inTransaction(owner, settings, () => owner.query(`UPDATE ledger.reader_roles SET ${set} WHERE id = $1`, [bound?.["id"]])),
          "immutable_field",
          { field, operation: "update" },
        );
      }
      // An oid that names no role gives no name, and the NOT NULL refuses it.
      await expectError(
        inTransaction(owner, settings, () => owner.query("INSERT INTO ledger.reader_roles (company_id, role_oid) VALUES ($1, 0)", [company])),
        "23502",
        /role_name/,
      );
      await inTransaction(owner, settings, () => owner.query("DELETE FROM ledger.reader_roles"));
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
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
