// SPDX-License-Identifier: AGPL-3.0-only

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { GUARD_EXCEPTIONS, INSTALL_TABLES, KEY_EXCEPTIONS, guardedRelations, tableGuardProblems, type InstallTable } from "./table-guard.ts";

const COMPANY = "(company_id = ledger.current_company_id())";
const READER_COMPANY = "(company_id = ( SELECT ledger.reader_company_id() AS reader_company_id))";
const READER = `(${READER_COMPANY} AND ${READER_COMPANY})`;
const READER_ROLE = "(role_oid = ( SELECT ledger.current_role_oid() AS current_role_oid))";

const NO_RLS = "ledger.bare: row level security is not enabled.";
const NOT_FORCED = "ledger.bare: row level security is not forced.";
const NO_APP_POLICY = `ledger.bare: has no permissive policy for nortfox_app on ALL with USING ${COMPANY} and WITH CHECK ${COMPANY}.`;
const NO_OWNER_POLICY = `ledger.bare: has no permissive policy for nortfox_owner on ALL with USING ${COMPANY} and WITH CHECK ${COMPANY}.`;
const NO_READER_POLICY = `ledger.bare: has no permissive policy for nortfox_reader on SELECT with USING ${READER}.`;
const NO_HISTORY =
  "ledger.bare: has no audit_history trigger: AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, enabled, with no WHEN and no column list, calling audit.write_history with the primary key column.";
const NO_TRUNCATE = "ledger.bare: has no refuse_truncate trigger: BEFORE TRUNCATE, FOR EACH STATEMENT, enabled, calling ledger.refuse_truncate().";
const keeps = (what: string, table = "ledger.bare"): string =>
  `${table}: keeps planner statistics of ${what}, which hold values of every company's rows: EXPLAIN shows estimates from them to every role that reads the table.`;
const partial = (name: string): string =>
  `ledger.bare: has the partial index ${name}: ANALYZE keeps its row count in pg_class, which every role reads, and that count is of the rows of every company that meet its condition.`;
const extended = (name: string): string =>
  `ledger.bare: has the extended statistics ${name}, which hold values of every company's rows: EXPLAIN shows estimates from them to every role that reads the table.`;

/** A company table that has everything the guard needs. */
const GUARDED = `
  CREATE TABLE ledger.bare (id uuid PRIMARY KEY, company_id uuid NOT NULL, note text, UNIQUE (company_id, id));
  SELECT meta.protect_company_table('ledger.bare', 'id');
`;

describe("the table guard", () => {
  let db: TestDatabase;
  let owner: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  /** The guard's problems after `setup`, run as the owner in a transaction that is then rolled back. */
  async function problemsAfter(setup: string, as: Client = owner): Promise<string[]> {
    await as.query("BEGIN");
    try {
      await as.query(setup);
      return await tableGuardProblems(as);
    } finally {
      await as.query("ROLLBACK");
    }
  }

  it("finds nothing in the migrated database", async () => {
    expect(await tableGuardProblems(owner)).toEqual([]);
  });

  it("lists every table and view, and keeps exactly the pinned exceptions", async () => {
    expect(await guardedRelations(owner)).toEqual([
      "access.account_events",
      "access.api_tokens",
      "access.attempt_counters",
      "access.catalogue_groups",
      "access.catalogue_permissions",
      "access.catalogue_program_permissions",
      "access.catalogue_programs",
      "access.consents",
      "access.events",
      "access.idempotency_keys",
      "access.identities",
      "access.install_keys",
      "access.invitation_links",
      "access.invitations",
      "access.known_devices",
      "access.login_challenges",
      "access.membership_contacts",
      "access.memberships",
      "access.oauth_access_tokens",
      "access.oauth_clients",
      "access.oauth_codes",
      "access.oauth_refresh_tokens",
      "access.oauth_requests",
      "access.password_credentials",
      "access.program_admins",
      "access.program_grants",
      "access.recent_companies",
      "access.sessions",
      "access.setup_tokens",
      "access.totp_secrets",
      "audit.history",
      "ledger.accounts",
      "ledger.automatic_locks",
      "ledger.companies",
      "ledger.deleted_voucher_rows",
      "ledger.deleted_vouchers",
      "ledger.fiscal_years",
      "ledger.idempotency_keys",
      "ledger.period_locks",
      "ledger.periods",
      "ledger.reader_roles",
      "ledger.transaction_actors",
      "ledger.void_ranges",
      "ledger.voucher_counters",
      "ledger.voucher_rows",
      "ledger.voucher_series",
      "ledger.vouchers",
      "meta.schema_migrations",
    ]);
    expect(Object.fromEntries([...GUARD_EXCEPTIONS].map(([table, exception]) => [table, exception.kind]))).toEqual({
      "access.memberships": "own policies",
      "audit.history": "no history trigger",
      "ledger.companies": "own policies",
      "ledger.reader_roles": "own policies",
      "ledger.transaction_actors": "not a company table",
      "meta.schema_migrations": "not a company table",
    });
    expect([...KEY_EXCEPTIONS.keys()]).toEqual(["audit.history_pkey", "ledger.companies_database_number_key", "ledger.reader_roles_role_oid_key"]);
    await owner.query("BEGIN");
    try {
      await owner.query("CREATE TABLE ledger.bare (id uuid); CREATE VIEW audit.seen AS SELECT 1 AS one");
      expect(await guardedRelations(owner)).toContain("ledger.bare");
      expect(await guardedRelations(owner)).toContain("audit.seen");
    } finally {
      await owner.query("ROLLBACK");
    }
  });

  it("passes a company table that has everything", async () => {
    expect(await problemsAfter(GUARDED)).toEqual([]);
  });

  it("fails a table made without row level security, its policies and its triggers", async () => {
    expect(await problemsAfter("CREATE TABLE ledger.bare (id uuid PRIMARY KEY, company_id uuid NOT NULL)")).toEqual([
      NO_RLS,
      NOT_FORCED,
      NO_APP_POLICY,
      NO_OWNER_POLICY,
      NO_READER_POLICY,
      NO_HISTORY,
      NO_TRUNCATE,
      keeps("the column id, the column company_id"),
    ]);
  });

  it("fails row level security that is enabled but not forced", async () => {
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare NO FORCE ROW LEVEL SECURITY;`)).toEqual([NOT_FORCED]);
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare DISABLE ROW LEVEL SECURITY;`)).toEqual([NO_RLS]);
  });

  it.each([
    ["the app's policy reads every row", "ALTER POLICY company_app ON ledger.bare USING (true)", [NO_APP_POLICY, "ledger.bare: has the permissive policy company_app, which the guard does not expect."]],
    [
      "the app's policy checks nothing on write",
      "DROP POLICY company_app ON ledger.bare; CREATE POLICY company_app ON ledger.bare TO nortfox_app USING (company_id = ledger.current_company_id())",
      [NO_APP_POLICY, "ledger.bare: has the permissive policy company_app, which the guard does not expect."],
    ],
    ["the owner's policy is for another role", "ALTER POLICY company_owner ON ledger.bare TO nortfox_app", [NO_OWNER_POLICY]],
    // A reader named on the app's or the owner's policy could pick any company by the setting.
    [
      "the app's policy names a reader too",
      "ALTER POLICY company_app ON ledger.bare TO nortfox_app, nortfox_reader",
      [NO_APP_POLICY, "ledger.bare: has the permissive policy company_app, which the guard does not expect."],
    ],
    [
      // PostgreSQL keeps only PUBLIC when the list names it.
      "the app's policy is for PUBLIC",
      "ALTER POLICY company_app ON ledger.bare TO nortfox_app, PUBLIC",
      [NO_APP_POLICY, "ledger.bare: has the permissive policy company_app, which the guard does not expect."],
    ],
    [
      "the owner's policy names a reader too",
      "ALTER POLICY company_owner ON ledger.bare TO nortfox_owner, nortfox_reader",
      [NO_OWNER_POLICY, "ledger.bare: has the permissive policy company_owner, which the guard does not expect."],
    ],
    [
      "the reader's policy trusts the setting",
      "ALTER POLICY company_reader ON ledger.bare USING (company_id = ledger.current_company_id())",
      [NO_READER_POLICY, "ledger.bare: has the permissive policy company_reader, which the guard does not expect."],
    ],
    [
      "the reader's policy reads its company for each row, which EXPLAIN ANALYZE counts",
      "ALTER POLICY company_reader ON ledger.bare USING (company_id = ledger.reader_company_id())",
      [NO_READER_POLICY, "ledger.bare: has the permissive policy company_reader, which the guard does not expect."],
    ],
    [
      "the reader's policy reads its company once, but only when a row passes the reader's own condition",
      `ALTER POLICY company_reader ON ledger.bare USING ${READER_COMPANY}`,
      [NO_READER_POLICY, "ledger.bare: has the permissive policy company_reader, which the guard does not expect."],
    ],
    [
      "the reader's policy is for every command",
      `DROP POLICY company_reader ON ledger.bare; CREATE POLICY company_reader ON ledger.bare TO nortfox_reader USING ${READER} WITH CHECK ${READER}`,
      [NO_READER_POLICY, "ledger.bare: has the permissive policy company_reader, which the guard does not expect."],
    ],
    ["a policy is missing", "DROP POLICY company_owner ON ledger.bare", [NO_OWNER_POLICY]],
  ])("fails a wrong policy: %s", async (_case, change, problems) => {
    expect(await problemsAfter(`${GUARDED} ${change};`)).toEqual(problems);
  });

  it("fails an extra permissive policy, and lets a restrictive one narrow the rows", async () => {
    expect(await problemsAfter(`${GUARDED} CREATE POLICY everything ON ledger.bare TO nortfox_app USING (true);`)).toEqual([
      "ledger.bare: has the permissive policy everything, which the guard does not expect.",
    ]);
    expect(await problemsAfter(`${GUARDED} CREATE POLICY everyone ON ledger.bare TO PUBLIC USING (true);`)).toEqual([
      "ledger.bare: has the permissive policy everyone, which the guard does not expect.",
    ]);
    expect(await problemsAfter(`${GUARDED} CREATE POLICY narrower ON ledger.bare AS RESTRICTIVE TO nortfox_app USING (note IS NULL);`)).toEqual(
      [],
    );
  });

  it.each([
    ["the history trigger is missing", "DROP TRIGGER audit_history ON ledger.bare", [NO_HISTORY]],
    ["the history trigger is disabled", "ALTER TABLE ledger.bare DISABLE TRIGGER audit_history", [NO_HISTORY]],
    [
      "the history trigger skips deletes",
      "DROP TRIGGER audit_history ON ledger.bare; CREATE TRIGGER audit_history AFTER INSERT OR UPDATE ON ledger.bare FOR EACH ROW EXECUTE FUNCTION audit.write_history('id')",
      [NO_HISTORY],
    ],
    [
      "the history trigger fires before the change",
      "DROP TRIGGER audit_history ON ledger.bare; CREATE TRIGGER audit_history BEFORE INSERT OR UPDATE OR DELETE ON ledger.bare FOR EACH ROW EXECUTE FUNCTION audit.write_history('id')",
      [NO_HISTORY],
    ],
    [
      "the history trigger fires once per statement",
      "DROP TRIGGER audit_history ON ledger.bare; CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON ledger.bare FOR EACH STATEMENT EXECUTE FUNCTION audit.write_history('id')",
      [NO_HISTORY],
    ],
    [
      "the history trigger has a WHEN",
      "DROP TRIGGER audit_history ON ledger.bare; CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON ledger.bare FOR EACH ROW WHEN (pg_catalog.pg_trigger_depth() < 100) EXECUTE FUNCTION audit.write_history('id')",
      [NO_HISTORY],
    ],
    [
      "the history trigger fires only on some columns",
      "DROP TRIGGER audit_history ON ledger.bare; CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OF note OR DELETE ON ledger.bare FOR EACH ROW EXECUTE FUNCTION audit.write_history('id')",
      [NO_HISTORY],
    ],
    [
      "the history trigger names another column",
      "DROP TRIGGER audit_history ON ledger.bare; CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON ledger.bare FOR EACH ROW EXECUTE FUNCTION audit.write_history('company_id')",
      [NO_HISTORY],
    ],
    [
      "the history trigger names no column",
      "DROP TRIGGER audit_history ON ledger.bare; CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON ledger.bare FOR EACH ROW EXECUTE FUNCTION audit.write_history()",
      [NO_HISTORY],
    ],
    [
      "another function writes the history",
      "DROP TRIGGER audit_history ON ledger.bare; CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON ledger.bare FOR EACH ROW EXECUTE FUNCTION ledger.refuse_truncate()",
      [NO_HISTORY],
    ],
    ["the truncate trigger is missing", "DROP TRIGGER refuse_truncate ON ledger.bare", [NO_TRUNCATE]],
    ["the truncate trigger is disabled", "ALTER TABLE ledger.bare DISABLE TRIGGER refuse_truncate", [NO_TRUNCATE]],
    [
      "the truncate trigger fires after",
      "DROP TRIGGER refuse_truncate ON ledger.bare; CREATE TRIGGER refuse_truncate AFTER TRUNCATE ON ledger.bare FOR EACH STATEMENT EXECUTE FUNCTION ledger.refuse_truncate()",
      [NO_TRUNCATE],
    ],
  ])("fails a wrong trigger: %s", async (_case, change, problems) => {
    expect(await problemsAfter(`${GUARDED} ${change};`)).toEqual(problems);
  });

  it("lets a trigger that fires always count as enabled", async () => {
    expect(
      await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare ENABLE ALWAYS TRIGGER audit_history; ALTER TABLE ledger.bare ENABLE ALWAYS TRIGGER refuse_truncate;`),
    ).toEqual([]);
  });

  it("fails a key that is not one uuid column, which the history needs as the row's id", async () => {
    const keyed = (key: string): string => `
      CREATE TABLE ledger.bare (id ${key}, company_id uuid NOT NULL);
      ALTER TABLE ledger.bare ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ledger.bare FORCE ROW LEVEL SECURITY;
      CREATE POLICY company_app ON ledger.bare TO nortfox_app USING ${COMPANY} WITH CHECK ${COMPANY};
      CREATE POLICY company_owner ON ledger.bare TO nortfox_owner USING ${COMPANY} WITH CHECK ${COMPANY};
      CREATE POLICY company_reader ON ledger.bare FOR SELECT TO nortfox_reader USING ${READER};
      CREATE TRIGGER audit_history AFTER INSERT OR UPDATE OR DELETE ON ledger.bare FOR EACH ROW EXECUTE FUNCTION audit.write_history('id');
      CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ledger.bare FOR EACH STATEMENT EXECUTE FUNCTION ledger.refuse_truncate();
      SELECT meta.hide_statistics('ledger.bare');
    `;
    const noKey = "ledger.bare: has no primary key of one uuid column, which the history needs as the row's id.";
    expect(await problemsAfter(keyed("uuid PRIMARY KEY"))).toEqual([]);
    expect(await problemsAfter(keyed("bigint PRIMARY KEY"))).toEqual([
      noKey,
      NO_HISTORY,
      "ledger.bare: the unique index bare_pkey does not have company_id as a key column, so its check compares the rows of every company.",
    ]);
    expect(await problemsAfter(keyed("uuid"))).toEqual([noKey, NO_HISTORY]);
    expect(await problemsAfter(`${keyed("uuid")} ALTER TABLE ledger.bare ADD PRIMARY KEY (id, company_id);`)).toEqual([noKey, NO_HISTORY]);
  });

  it("fails a foreign key between company tables that leaves out company_id", async () => {
    const child = (key: string): string => `${GUARDED}
      CREATE TABLE ledger.child (id uuid PRIMARY KEY, company_id uuid NOT NULL, bare_id uuid NOT NULL, ${key});
      SELECT meta.protect_company_table('ledger.child', 'id');
    `;
    expect(await problemsAfter(child("FOREIGN KEY (company_id, bare_id) REFERENCES ledger.bare (company_id, id)"))).toEqual([]);
    expect(await problemsAfter(child("CONSTRAINT to_bare FOREIGN KEY (bare_id) REFERENCES ledger.bare (id)"))).toEqual([
      "ledger.child: the foreign key to_bare to ledger.bare does not include company_id on both sides.",
    ]);
    expect(
      await problemsAfter(child("CONSTRAINT crossed FOREIGN KEY (company_id, bare_id) REFERENCES ledger.bare (id, company_id)")),
    ).toEqual(["ledger.child: the foreign key crossed to ledger.bare does not include company_id on both sides."]);
  });

  it("fails a unique key or an exclusion constraint of a company table that leaves company_id out", async () => {
    const unique = (name: string): string =>
      `ledger.bare: the unique index ${name} does not have company_id as a key column, so its check compares the rows of every company.`;
    const exclusion = (name: string): string =>
      `ledger.bare: the exclusion constraint ${name} does not compare company_id with =, so its check compares the rows of every company.`;
    expect(await problemsAfter(`${GUARDED} CREATE UNIQUE INDEX bare_note ON ledger.bare (note);`)).toEqual([unique("bare_note")]);
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare ADD CONSTRAINT bare_note_unique UNIQUE (note);`)).toEqual([unique("bare_note_unique")]);
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare ADD CONSTRAINT bare_apart EXCLUDE USING gist (note WITH =);`)).toEqual([exclusion("bare_apart")]);
    // company_id must be a key column: in INCLUDE, in the WHERE or inside an expression it is not.
    expect(await problemsAfter(`${GUARDED} CREATE UNIQUE INDEX bare_note ON ledger.bare (note) INCLUDE (company_id);`)).toEqual([unique("bare_note")]);
    expect(await problemsAfter(`${GUARDED} CREATE UNIQUE INDEX bare_note ON ledger.bare (note) WHERE company_id IS NOT NULL;`)).toEqual([
      unique("bare_note"),
      partial("bare_note"),
    ]);
    expect(
      await problemsAfter(`${GUARDED} CREATE UNIQUE INDEX bare_note ON ledger.bare ((company_id::text), note); ALTER INDEX ledger.bare_note ALTER COLUMN 1 SET STATISTICS 0;`),
    ).toEqual([unique("bare_note")]);
    // An exclusion constraint must compare company_id with =.
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare ADD CONSTRAINT bare_apart EXCLUDE USING gist (company_id WITH <>, note WITH =);`)).toEqual([
      exclusion("bare_apart"),
    ]);
    // A primary key of one uuid column is the one key without company_id; one of another type is not.
    expect(
      await problemsAfter(
        `${GUARDED} ALTER TABLE ledger.bare ADD COLUMN number bigint; ALTER TABLE ledger.bare ALTER COLUMN number SET STATISTICS 0; CREATE UNIQUE INDEX bare_number ON ledger.bare (number);`,
      ),
    ).toEqual([unique("bare_number")]);
    // With company_id as a key column, or compared with =, each passes.
    expect(
      await problemsAfter(`${GUARDED}
        CREATE UNIQUE INDEX bare_note ON ledger.bare (note, company_id);
        ALTER TABLE ledger.bare ADD CONSTRAINT bare_apart EXCLUDE USING gist (company_id WITH =, note WITH =);`),
    ).toEqual([]);
  });

  // ANALYZE counts the rows of a partial index that meet its condition, of
  // every company together, and keeps the count in pg_class, which every
  // role reads. A whole index counts every row of its table, which pg_class
  // shows anyway. NULLs are distinct in a unique index, so a whole one keeps
  // a rule for some rows only by a NULL in the others.
  it("fails a partial index of a company table, unique or not, and passes the whole index that keeps the same rule", async () => {
    expect(await problemsAfter(`${GUARDED} CREATE INDEX bare_noted ON ledger.bare (company_id) WHERE note IS NOT NULL;`)).toEqual([partial("bare_noted")]);
    expect(await problemsAfter(`${GUARDED} CREATE UNIQUE INDEX bare_one_note ON ledger.bare (company_id) WHERE note IS NOT NULL;`)).toEqual([
      partial("bare_one_note"),
    ]);
    expect(
      await problemsAfter(`${GUARDED} CREATE UNIQUE INDEX bare_one_note ON ledger.bare (company_id, (note IS NOT NULL OR NULL)); SELECT meta.hide_statistics('ledger.bare');`),
    ).toEqual([]);
    // A table that holds no company data may have one.
    expect(await problemsAfter("CREATE INDEX schema_migrations_hashed ON meta.schema_migrations (name) WHERE sha256 <> ''")).toEqual([]);
  });

  it("fails a company table that keeps planner statistics of a column or of an index's expression, or has extended statistics", async () => {
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare ALTER COLUMN note SET STATISTICS 100;`)).toEqual([keeps("the column note")]);
    // -1 gives the column the default target back, which ANALYZE uses.
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare ALTER COLUMN note SET STATISTICS -1;`)).toEqual([keeps("the column note")]);
    // A column, or an index with an expression, that comes after meta.protect_company_table keeps them until meta.hide_statistics runs again.
    const added = `${GUARDED} ALTER TABLE ledger.bare ADD COLUMN extra text; CREATE INDEX bare_lower ON ledger.bare (company_id, pg_catalog.lower(note), extra);`;
    expect(await problemsAfter(added)).toEqual([keeps("the column extra, column 2 of the index bare_lower")]);
    expect(await problemsAfter(`${added} SELECT meta.hide_statistics('ledger.bare');`)).toEqual([]);
    expect(await problemsAfter(`${GUARDED} CREATE STATISTICS ledger.bare_pairs ON company_id, note FROM ledger.bare;`)).toEqual([extended("bare_pairs")]);
    // The tables of the migrations, the exceptions that hold company data among them.
    expect(await problemsAfter("ALTER INDEX ledger.periods_no_overlap ALTER COLUMN 3 SET STATISTICS -1")).toEqual([
      keeps("column 3 of the index periods_no_overlap", "ledger.periods"),
    ]);
    expect(await problemsAfter("ALTER TABLE audit.history ALTER COLUMN new_values SET STATISTICS -1")).toEqual([keeps("the column new_values", "audit.history")]);
    expect(await problemsAfter("ALTER TABLE ledger.reader_roles ALTER COLUMN role_name SET STATISTICS -1")).toEqual([
      keeps("the column role_name", "ledger.reader_roles"),
    ]);
  });

  it.each([
    ["TRUNCATE to the app", "GRANT TRUNCATE ON ledger.bare TO nortfox_app", "ledger.bare: nortfox_app has TRUNCATE. The app never gets TRUNCATE, REFERENCES or TRIGGER."],
    ["REFERENCES to the app", "GRANT REFERENCES ON ledger.bare TO nortfox_app", "ledger.bare: nortfox_app has REFERENCES. The app never gets TRUNCATE, REFERENCES or TRIGGER."],
    ["TRIGGER to the app", "GRANT TRIGGER ON ledger.bare TO nortfox_app", "ledger.bare: nortfox_app has TRIGGER. The app never gets TRUNCATE, REFERENCES or TRIGGER."],
    [
      "REFERENCES on a column to the app",
      "GRANT REFERENCES (note) ON ledger.bare TO nortfox_app",
      "ledger.bare: nortfox_app has REFERENCES on note. The app never gets TRUNCATE, REFERENCES or TRIGGER.",
    ],
    ["INSERT to the readers", "GRANT INSERT ON ledger.bare TO nortfox_reader", "ledger.bare: nortfox_reader has INSERT. A reader only gets SELECT."],
    [
      "UPDATE on a column to the readers",
      "GRANT UPDATE (note) ON ledger.bare TO nortfox_reader",
      "ledger.bare: nortfox_reader has UPDATE on note. A reader only gets SELECT.",
    ],
    [
      "SELECT to PUBLIC",
      "GRANT SELECT ON ledger.bare TO PUBLIC",
      "ledger.bare: PUBLIC has SELECT. Only nortfox_app and nortfox_reader get privileges on a table.",
    ],
    [
      "SELECT to one reader role",
      "GRANT SELECT ON ledger.bare TO nortfox_test_reader_a",
      "ledger.bare: nortfox_test_reader_a has SELECT. Only nortfox_app and nortfox_reader get privileges on a table.",
    ],
  ])("fails a privilege that a role may not have: %s", async (_case, grant, problem) => {
    expect(await problemsAfter(`${GUARDED} ${grant};`)).toEqual([problem]);
  });

  it("fails a view that reads with its owner's rights, a materialized view and a table without company_id", async () => {
    expect(await problemsAfter(`${GUARDED} CREATE VIEW ledger.notes WITH (security_invoker = true) AS SELECT note FROM ledger.bare;`)).toEqual([]);
    expect(await problemsAfter(`${GUARDED} CREATE VIEW ledger.notes WITH (security_invoker = on) AS SELECT note FROM ledger.bare;`)).toEqual([]);
    expect(await problemsAfter(`${GUARDED} CREATE VIEW ledger.notes AS SELECT note FROM ledger.bare;`)).toEqual([
      "ledger.notes: is a view without security_invoker = true, so it would read its tables with its owner's rights.",
    ]);
    expect(
      await problemsAfter(`${GUARDED} CREATE VIEW ledger.notes WITH (security_invoker = false) AS SELECT note FROM ledger.bare; GRANT INSERT ON ledger.notes TO nortfox_reader;`),
    ).toEqual([
      "ledger.notes: is a view without security_invoker = true, so it would read its tables with its owner's rights.",
      "ledger.notes: nortfox_reader has INSERT. A reader only gets SELECT.",
    ]);
    expect(await problemsAfter(`${GUARDED} CREATE MATERIALIZED VIEW ledger.notes AS SELECT note FROM ledger.bare;`)).toEqual([
      "ledger.notes: is a materialized view, which row level security does not cover.",
    ]);
    expect(await problemsAfter("CREATE TABLE ledger.loose (id uuid PRIMARY KEY)")).toEqual([
      "ledger.loose: has no company_id column.",
    ]);
  });

  it("fails a table that another role owns", async () => {
    const admin = await db.admin();
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare OWNER TO nortfox_app;`, admin)).toEqual([
      "ledger.bare: is owned by nortfox_app, not nortfox_owner.",
    ]);
  });

  it("checks the exceptions too, each only for what it is excepted from", async () => {
    expect(await problemsAfter("ALTER TABLE audit.history NO FORCE ROW LEVEL SECURITY")).toEqual(["audit.history: row level security is not forced."]);
    // A reader's own binding is matched by its role's oid and its name, never by one alone.
    // Its oid is read once for the query, before any row, never for each row.
    for (const using of [
      "true",
      "role_oid = ledger.current_role_oid()",
      "role_name = CURRENT_USER",
      "role_oid = ledger.current_role_oid() AND role_name = CURRENT_USER",
      `${READER_ROLE} AND role_name = CURRENT_USER`,
    ]) {
      expect(await problemsAfter(`ALTER POLICY own_binding ON ledger.reader_roles USING (${using})`), using).toEqual([
        `ledger.reader_roles: has no permissive policy for nortfox_reader on SELECT with USING (${READER_ROLE} AND ${READER_ROLE} AND (role_name = CURRENT_USER)).`,
        "ledger.reader_roles: has the permissive policy own_binding, which the guard does not expect.",
      ]);
    }
    expect(await problemsAfter("DROP TRIGGER audit_history ON ledger.reader_roles")).toEqual([
      "ledger.reader_roles: has no audit_history trigger: AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, enabled, with no WHEN and no column list, calling audit.write_history with the primary key column.",
    ]);
    expect(await problemsAfter("GRANT TRUNCATE ON meta.schema_migrations TO nortfox_app")).toEqual([
      "meta.schema_migrations: nortfox_app has TRUNCATE. The app never gets TRUNCATE, REFERENCES or TRIGGER.",
    ]);
  });

  // The memberships and the companies have the company policies, and one
  // policy of the owner's own, for SELECT, by the transaction's person: only
  // the one membership function reads through it (db/README.md, the schema
  // access). The guard pins it, so it never widens, and the app never gets it.
  it("pins the owner's policy by person on the memberships and the companies, and the company policies beside it", async () => {
    const BY_PERSON = "(live_user_id = access.current_person_id())";
    const LIVE_COMPANY =
      "(EXISTS ( SELECT\n   FROM access.memberships m\n  WHERE ((m.company_id = companies.company_id) AND (m.live_user_id = access.current_person_id()))))";
    for (const [table, using] of [
      ["access.memberships", BY_PERSON],
      ["ledger.companies", LIVE_COMPANY],
    ] as const) {
      const missing = `${table}: has no permissive policy for nortfox_owner on SELECT with USING ${using}.`;
      expect(await problemsAfter(`ALTER POLICY person_owner ON ${table} USING (true)`), table).toEqual([
        missing,
        `${table}: has the permissive policy person_owner, which the guard does not expect.`,
      ]);
      expect(await problemsAfter(`DROP POLICY person_owner ON ${table}`), table).toEqual([missing]);
      expect(await problemsAfter(`ALTER POLICY person_owner ON ${table} TO nortfox_owner, nortfox_app`), table).toEqual([
        missing,
        `${table}: has the permissive policy person_owner, which the guard does not expect.`,
      ]);
      expect(await problemsAfter(`DROP POLICY company_app ON ${table}`), table).toEqual([
        `${table}: has no permissive policy for nortfox_app on ALL with USING ${COMPANY} and WITH CHECK ${COMPANY}.`,
      ]);
    }
    // A wider person: every live membership of anyone, or any membership of the person's.
    expect(await problemsAfter("ALTER POLICY person_owner ON access.memberships USING (user_id = access.current_person_id())")).toEqual([
      `access.memberships: has no permissive policy for nortfox_owner on SELECT with USING ${BY_PERSON}.`,
      "access.memberships: has the permissive policy person_owner, which the guard does not expect.",
    ]);
  });

  // The guard runs after each migration. Before 0007 made the memberships,
  // the companies had the company policies alone, and a fresh install still
  // applies those migrations one by one.
  it("holds the companies to the company policies alone until the memberships exist, and to the policy by person after", async () => {
    expect(await problemsAfter("DROP TABLE access.membership_contacts, access.memberships CASCADE")).toEqual([]);
    expect(
      await problemsAfter(`
        DROP TABLE access.membership_contacts, access.memberships CASCADE;
        CREATE POLICY person_owner ON ledger.companies FOR SELECT TO nortfox_owner USING (true);`),
    ).toEqual(["ledger.companies: has the permissive policy person_owner, which the guard does not expect."]);
  });

  // The install-wide tables hold what belongs to no company (db/README.md,
  // the schema access). Each is on the pinned list with its class, and the
  // guard holds it to that class's policies. The probes below are tables of
  // each class on a list that the test gives the guard beside the real one.
  describe("the install-wide tables", () => {
    const PROBES: ReadonlyMap<string, InstallTable> = new Map<string, InstallTable>([
      ["access.probe_person", { class: "person", column: "identity_id", commands: ["SELECT", "INSERT", "UPDATE", "DELETE"], why: "A probe of the person class." }],
      ["access.probe_company", { class: "company", column: "probe_company_id", commands: ["SELECT", "INSERT"], why: "A probe of the company class." }],
      ["access.probe_public", { class: "public", why: "A probe of the public class." }],
      ["access.probe_secret", { class: "secret", why: "A probe of the secret class." }],
      ["ledger.probe_elsewhere", { class: "secret", why: "A probe outside the schema access." }],
    ]);
    const LIST: ReadonlyMap<string, InstallTable> = new Map([...INSTALL_TABLES, ...PROBES]);

    const PERSON = "(identity_id = access.current_person_id())";
    const IN_COMPANY = "(probe_company_id = ledger.current_company_id())";
    const OWNER_POLICY = (table: string): string => `${table}: has no permissive policy for nortfox_owner on ALL with USING true and WITH CHECK true.`;
    const UNEXPECTED = (table: string, name: string): string => `${table}: has the permissive policy ${name}, which the guard does not expect.`;
    const UNPAIRED = (table: string, key: string): string => `${table}: the foreign key ${key} to ledger.bare does not pair a company column with company_id.`;

    /** A table of each class with everything the guard needs, and a company table that two of them name. */
    const PROTECTED = `${GUARDED}
      CREATE TABLE access.probe_person (id uuid PRIMARY KEY, identity_id uuid NOT NULL REFERENCES access.identities (id), note text);
      SELECT meta.protect_install_table('access.probe_person');
      CREATE POLICY person_select ON access.probe_person FOR SELECT TO nortfox_app USING (identity_id = access.current_person_id());
      CREATE POLICY person_insert ON access.probe_person FOR INSERT TO nortfox_app WITH CHECK (identity_id = access.current_person_id());
      CREATE POLICY person_update ON access.probe_person FOR UPDATE TO nortfox_app
        USING (identity_id = access.current_person_id()) WITH CHECK (identity_id = access.current_person_id());
      CREATE POLICY person_delete ON access.probe_person FOR DELETE TO nortfox_app USING (identity_id = access.current_person_id());
      GRANT SELECT, INSERT, UPDATE, DELETE ON access.probe_person TO nortfox_app;
      CREATE TABLE access.probe_company (
        id uuid PRIMARY KEY, probe_company_id uuid NOT NULL REFERENCES ledger.companies (company_id), bare_id uuid NOT NULL,
        CONSTRAINT paired FOREIGN KEY (probe_company_id, bare_id) REFERENCES ledger.bare (company_id, id));
      SELECT meta.protect_install_table('access.probe_company');
      CREATE POLICY company_select ON access.probe_company FOR SELECT TO nortfox_app USING (probe_company_id = ledger.current_company_id());
      CREATE POLICY company_insert ON access.probe_company FOR INSERT TO nortfox_app WITH CHECK (probe_company_id = ledger.current_company_id());
      GRANT SELECT, INSERT ON access.probe_company TO nortfox_app;
      CREATE TABLE access.probe_public (id uuid PRIMARY KEY, label text);
      SELECT meta.protect_install_table('access.probe_public');
      CREATE POLICY public_select ON access.probe_public FOR SELECT TO nortfox_app USING (true);
      GRANT SELECT ON access.probe_public TO nortfox_app;
      CREATE TABLE access.probe_secret (
        id uuid PRIMARY KEY, token_hash bytea, kept_company_id uuid, bare_id uuid,
        CONSTRAINT kept FOREIGN KEY (kept_company_id, bare_id) REFERENCES ledger.bare (company_id, id));
      SELECT meta.protect_install_table('access.probe_secret');
    `;

    /** The guard's problems with the probes on its list, after `setup`, in a transaction that is then rolled back. */
    async function installProblems(setup: string, list: ReadonlyMap<string, InstallTable> = LIST): Promise<string[]> {
      await owner.query("BEGIN");
      try {
        await owner.query(setup);
        return await tableGuardProblems(owner, list);
      } finally {
        await owner.query("ROLLBACK");
      }
    }

    it("pins the install-wide tables, each with its class and its reason", () => {
      expect([...INSTALL_TABLES.keys()].sort()).toEqual([
        "access.account_events",
        "access.api_tokens",
        "access.attempt_counters",
        "access.catalogue_groups",
        "access.catalogue_permissions",
        "access.catalogue_program_permissions",
        "access.catalogue_programs",
        "access.consents",
        "access.idempotency_keys",
        "access.identities",
        "access.install_keys",
        "access.invitation_links",
        "access.known_devices",
        "access.login_challenges",
        "access.membership_contacts",
        "access.oauth_access_tokens",
        "access.oauth_clients",
        "access.oauth_codes",
        "access.oauth_refresh_tokens",
        "access.oauth_requests",
        "access.password_credentials",
        "access.recent_companies",
        "access.sessions",
        "access.setup_tokens",
        "access.totp_secrets",
      ]);
      for (const [table, entry] of INSTALL_TABLES) {
        expect(entry.why, table).toMatch(/^[A-Z].*\.$/);
      }
      expect(INSTALL_TABLES.get("access.identities")).toMatchObject({ class: "person", column: "id", commands: ["SELECT", "UPDATE"] });
      expect(INSTALL_TABLES.get("access.account_events")).toMatchObject({ class: "person", column: "identity_id", commands: ["SELECT", "INSERT"] });
      expect(INSTALL_TABLES.get("access.idempotency_keys")).toMatchObject({ class: "person", column: "actor_id", commands: ["SELECT", "INSERT"] });
      expect(INSTALL_TABLES.get("access.recent_companies")).toMatchObject({ class: "person", column: "identity_id", commands: ["SELECT", "INSERT", "UPDATE"] });
      expect(INSTALL_TABLES.get("access.membership_contacts")).toMatchObject({
        class: "company",
        column: "contact_company_id",
        commands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      });
      // A token is never deleted: the app reads, adds and revokes. So is a consent.
      expect(INSTALL_TABLES.get("access.api_tokens")).toMatchObject({ class: "company", column: "token_company_id", commands: ["SELECT", "INSERT", "UPDATE"] });
      expect(INSTALL_TABLES.get("access.consents")).toMatchObject({ class: "company", column: "consent_company_id", commands: ["SELECT", "INSERT", "UPDATE"] });
      for (const table of ["access.catalogue_programs", "access.catalogue_groups", "access.catalogue_permissions", "access.catalogue_program_permissions", "access.oauth_clients"]) {
        expect(INSTALL_TABLES.get(table), table).toMatchObject({ class: "public" });
      }
      for (const table of ["access.oauth_requests", "access.oauth_codes", "access.oauth_access_tokens", "access.oauth_refresh_tokens"]) {
        expect(INSTALL_TABLES.get(table), table).toMatchObject({ class: "secret" });
      }
    });

    it("passes an install-wide table of each class that has everything, and the migrated tables only with their list", async () => {
      expect(await installProblems(PROTECTED)).toEqual([]);
      const unlisted = await installProblems("SELECT 1", new Map());
      expect(unlisted).toEqual(
        [...INSTALL_TABLES.keys()].sort().map((table) => `${table}: is in the schema access, but is neither a company table nor on the install-wide list.`),
      );
    });

    it.each([
      [
        "a person policy that reads every row",
        "ALTER POLICY person_select ON access.probe_person USING (true)",
        [`access.probe_person: has no permissive policy for nortfox_app on SELECT with USING ${PERSON}.`, UNEXPECTED("access.probe_person", "person_select")],
      ],
      [
        "a person policy on another column",
        "ALTER POLICY person_update ON access.probe_person USING (id = access.current_person_id())",
        [
          `access.probe_person: has no permissive policy for nortfox_app on UPDATE with USING ${PERSON} and WITH CHECK ${PERSON}.`,
          UNEXPECTED("access.probe_person", "person_update"),
        ],
      ],
      [
        "a person policy that checks nothing on insert",
        "ALTER POLICY person_insert ON access.probe_person WITH CHECK (true)",
        [`access.probe_person: has no permissive policy for nortfox_app on INSERT with WITH CHECK ${PERSON}.`, UNEXPECTED("access.probe_person", "person_insert")],
      ],
      [
        "a person policy for every command in one",
        "DROP POLICY person_select ON access.probe_person; CREATE POLICY person_all ON access.probe_person TO nortfox_app USING (identity_id = access.current_person_id()) WITH CHECK (identity_id = access.current_person_id())",
        [`access.probe_person: has no permissive policy for nortfox_app on SELECT with USING ${PERSON}.`, UNEXPECTED("access.probe_person", "person_all")],
      ],
      [
        "a policy for a command the table does not list",
        "CREATE POLICY company_delete ON access.probe_company FOR DELETE TO nortfox_app USING (probe_company_id = ledger.current_company_id())",
        [UNEXPECTED("access.probe_company", "company_delete")],
      ],
      [
        "a company policy that trusts any company",
        "ALTER POLICY company_select ON access.probe_company USING (probe_company_id IS NOT NULL)",
        [`access.probe_company: has no permissive policy for nortfox_app on SELECT with USING ${IN_COMPANY}.`, UNEXPECTED("access.probe_company", "company_select")],
      ],
      [
        "a company policy that names the person",
        "ALTER POLICY company_insert ON access.probe_company WITH CHECK (probe_company_id = access.current_person_id())",
        [`access.probe_company: has no permissive policy for nortfox_app on INSERT with WITH CHECK ${IN_COMPANY}.`, UNEXPECTED("access.probe_company", "company_insert")],
      ],
      [
        "a public table that the app writes",
        "CREATE POLICY public_insert ON access.probe_public FOR INSERT TO nortfox_app WITH CHECK (true)",
        [UNEXPECTED("access.probe_public", "public_insert")],
      ],
      [
        "an app policy on a secret table",
        "CREATE POLICY secret_select ON access.probe_secret FOR SELECT TO nortfox_app USING (true)",
        [UNEXPECTED("access.probe_secret", "secret_select")],
      ],
      [
        "an app policy for PUBLIC",
        "CREATE POLICY anyone ON access.probe_public FOR SELECT TO PUBLIC USING (true)",
        [UNEXPECTED("access.probe_public", "anyone")],
      ],
      ["a missing owner policy", "DROP POLICY install_owner ON access.probe_secret", [OWNER_POLICY("access.probe_secret")]],
      [
        "an owner policy that reads less than every row",
        "ALTER POLICY install_owner ON access.probe_person USING (note IS NULL)",
        [OWNER_POLICY("access.probe_person"), UNEXPECTED("access.probe_person", "install_owner")],
      ],
      [
        "an owner policy that names the app too",
        "ALTER POLICY install_owner ON access.probe_public TO nortfox_owner, nortfox_app",
        [OWNER_POLICY("access.probe_public"), UNEXPECTED("access.probe_public", "install_owner")],
      ],
      [
        "a privilege for the reader",
        "GRANT SELECT ON access.probe_public TO nortfox_reader",
        ["access.probe_public: nortfox_reader has SELECT. A reader gets nothing on an install-wide table."],
      ],
      [
        "a column privilege for the reader",
        "GRANT SELECT (token_hash) ON access.probe_secret TO nortfox_reader",
        ["access.probe_secret: nortfox_reader has SELECT on token_hash. A reader gets nothing on an install-wide table."],
      ],
      [
        "a privilege for PUBLIC",
        "GRANT SELECT ON access.probe_person TO PUBLIC",
        ["access.probe_person: PUBLIC has SELECT. Only nortfox_app and nortfox_reader get privileges on a table."],
      ],
      [
        "TRUNCATE for the app",
        "GRANT TRUNCATE ON access.probe_person TO nortfox_app",
        ["access.probe_person: nortfox_app has TRUNCATE. The app never gets TRUNCATE, REFERENCES or TRIGGER."],
      ],
      [
        "a privilege for the app on a secret table",
        "GRANT SELECT (id) ON access.probe_secret TO nortfox_app",
        ["access.probe_secret: nortfox_app has SELECT on id, but the app reaches a secret table only through the lookup functions."],
      ],
      ["row level security that is not forced", "ALTER TABLE access.probe_secret NO FORCE ROW LEVEL SECURITY", ["access.probe_secret: row level security is not forced."]],
      ["row level security that is off", "ALTER TABLE access.probe_public DISABLE ROW LEVEL SECURITY", ["access.probe_public: row level security is not enabled."]],
      [
        "no truncate trigger",
        "DROP TRIGGER refuse_truncate ON access.probe_secret",
        ["access.probe_secret: has no refuse_truncate trigger: BEFORE TRUNCATE, FOR EACH STATEMENT, enabled, calling ledger.refuse_truncate()."],
      ],
      [
        "a foreign key to a company table without its company column",
        "ALTER TABLE access.probe_company ADD CONSTRAINT loose FOREIGN KEY (bare_id) REFERENCES ledger.bare (id)",
        [UNPAIRED("access.probe_company", "loose")],
      ],
      [
        "a foreign key that pairs another column than the table's company column",
        "ALTER TABLE access.probe_company ADD COLUMN other_company_id uuid, ADD CONSTRAINT crossed FOREIGN KEY (other_company_id, bare_id) REFERENCES ledger.bare (company_id, id)",
        [UNPAIRED("access.probe_company", "crossed")],
      ],
      [
        "a foreign key that pairs a column that names no company",
        "ALTER TABLE access.probe_secret ADD COLUMN owner_id uuid, ADD CONSTRAINT owned FOREIGN KEY (owner_id, bare_id) REFERENCES ledger.bare (company_id, id)",
        [UNPAIRED("access.probe_secret", "owned")],
      ],
      [
        "a company_id column",
        "ALTER TABLE access.probe_secret ADD COLUMN company_id uuid",
        ["access.probe_secret: is on the install-wide list, but has a company_id column, which makes a company table."],
      ],
    ])("fails an install-wide table with %s", async (_case, change, problems) => {
      expect(await installProblems(`${PROTECTED} ${change};`)).toEqual(problems);
    });

    it("fails a table on the list outside the schema access, and a table in it that is on no list", async () => {
      expect(
        await installProblems(`
          CREATE TABLE ledger.probe_elsewhere (id uuid PRIMARY KEY);
          SELECT meta.protect_install_table('ledger.probe_elsewhere');`),
      ).toEqual(["ledger.probe_elsewhere: is on the install-wide list, but is not in the schema access."]);
      expect(await installProblems("CREATE TABLE access.loose (id uuid PRIMARY KEY)")).toEqual([
        "access.loose: is in the schema access, but is neither a company table nor on the install-wide list.",
      ]);
      // A company table in access is held to every company table's rules.
      expect(await installProblems("CREATE TABLE access.bare (id uuid PRIMARY KEY, company_id uuid NOT NULL)")).toEqual(
        [
          "row level security is not enabled.",
          "row level security is not forced.",
          `has no permissive policy for nortfox_app on ALL with USING ${COMPANY} and WITH CHECK ${COMPANY}.`,
          `has no permissive policy for nortfox_owner on ALL with USING ${COMPANY} and WITH CHECK ${COMPANY}.`,
          `has no permissive policy for nortfox_reader on SELECT with USING ${READER}.`,
          NO_HISTORY.replace("ledger.bare: ", ""),
          NO_TRUNCATE.replace("ledger.bare: ", ""),
          "keeps planner statistics of the column id, the column company_id, which hold values of every company's rows: EXPLAIN shows estimates from them to every role that reads the table.",
        ].map((problem) => `access.bare: ${problem}`),
      );
    });

    it("lets an install-wide table keep statistics, a partial index and a unique key without company_id, which no reader reads", async () => {
      expect(
        await installProblems(`${PROTECTED}
          ALTER TABLE access.probe_person ALTER COLUMN note SET STATISTICS 100;
          CREATE UNIQUE INDEX probe_person_noted ON access.probe_person (note) WHERE note IS NOT NULL;
          CREATE STATISTICS access.probe_person_pairs ON identity_id, note FROM access.probe_person;`),
      ).toEqual([]);
    });
  });
});
