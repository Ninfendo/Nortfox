// SPDX-License-Identifier: AGPL-3.0-only

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { GUARD_EXCEPTIONS, KEY_EXCEPTIONS, guardedRelations, tableGuardProblems } from "./table-guard.ts";

const COMPANY = "(company_id = ledger.current_company_id())";
const READER = "(company_id = ledger.reader_company_id())";

const NO_RLS = "ledger.bare: row level security is not enabled.";
const NOT_FORCED = "ledger.bare: row level security is not forced.";
const NO_APP_POLICY = `ledger.bare: has no permissive policy for nortfox_app on ALL with USING ${COMPANY} and WITH CHECK ${COMPANY}.`;
const NO_OWNER_POLICY = `ledger.bare: has no permissive policy for nortfox_owner on ALL with USING ${COMPANY} and WITH CHECK ${COMPANY}.`;
const NO_READER_POLICY = `ledger.bare: has no permissive policy for nortfox_reader on SELECT with USING ${READER}.`;
const NO_HISTORY =
  "ledger.bare: has no audit_history trigger: AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, enabled, with no WHEN and no column list, calling audit.write_history with the primary key column.";
const NO_TRUNCATE = "ledger.bare: has no refuse_truncate trigger: BEFORE TRUNCATE, FOR EACH STATEMENT, enabled, calling ledger.refuse_truncate().";

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
      "audit.history",
      "ledger.accounts",
      "ledger.automatic_locks",
      "ledger.companies",
      "ledger.deleted_voucher_rows",
      "ledger.deleted_vouchers",
      "ledger.fiscal_years",
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
      "audit.history": "no history trigger",
      "ledger.reader_roles": "own policies",
      "ledger.transaction_actors": "not a company table",
      "meta.schema_migrations": "not a company table",
    });
    expect([...KEY_EXCEPTIONS.keys()]).toEqual(["audit.history_pkey", "ledger.companies_database_number_key", "ledger.reader_roles_role_name_key"]);
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
    [
      "the reader's policy trusts the setting",
      "ALTER POLICY company_reader ON ledger.bare USING (company_id = ledger.current_company_id())",
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
    expect(await problemsAfter(`${GUARDED} CREATE UNIQUE INDEX bare_note ON ledger.bare (note) WHERE company_id IS NOT NULL;`)).toEqual([unique("bare_note")]);
    expect(await problemsAfter(`${GUARDED} CREATE UNIQUE INDEX bare_note ON ledger.bare ((company_id::text), note);`)).toEqual([unique("bare_note")]);
    // An exclusion constraint must compare company_id with =.
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare ADD CONSTRAINT bare_apart EXCLUDE USING gist (company_id WITH <>, note WITH =);`)).toEqual([
      exclusion("bare_apart"),
    ]);
    // A primary key of one uuid column is the one key without company_id; one of another type is not.
    expect(await problemsAfter(`${GUARDED} ALTER TABLE ledger.bare ADD COLUMN number bigint; CREATE UNIQUE INDEX bare_number ON ledger.bare (number);`)).toEqual([
      unique("bare_number"),
    ]);
    // With company_id as a key column, or compared with =, each passes, a partial one too.
    expect(
      await problemsAfter(`${GUARDED}
        CREATE UNIQUE INDEX bare_note ON ledger.bare (note, company_id) WHERE note IS NOT NULL;
        ALTER TABLE ledger.bare ADD CONSTRAINT bare_apart EXCLUDE USING gist (company_id WITH =, note WITH =);`),
    ).toEqual([]);
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
    expect(await problemsAfter("ALTER POLICY own_binding ON ledger.reader_roles USING (true)")).toEqual([
      "ledger.reader_roles: has no permissive policy for nortfox_reader on SELECT with USING (role_name = CURRENT_USER).",
      "ledger.reader_roles: has the permissive policy own_binding, which the guard does not expect.",
    ]);
    expect(await problemsAfter("DROP TRIGGER audit_history ON ledger.reader_roles")).toEqual([
      "ledger.reader_roles: has no audit_history trigger: AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, enabled, with no WHEN and no column list, calling audit.write_history with the primary key column.",
    ]);
    expect(await problemsAfter("GRANT TRUNCATE ON meta.schema_migrations TO nortfox_app")).toEqual([
      "meta.schema_migrations: nortfox_app has TRUNCATE. The app never gets TRUNCATE, REFERENCES or TRIGGER.",
    ]);
  });
});
