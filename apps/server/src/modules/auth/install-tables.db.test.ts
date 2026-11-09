// SPDX-License-Identifier: AGPL-3.0-only

// The install-wide tables (db/README.md, the schema access). They hold
// what belongs to no company: the login identities and what a sign-in
// needs. Each is of one class, and row level security holds the app to it.
// A person table shows the app only the rows of the transaction's person,
// a user or an integration acting for one: with no person set, and for the
// internal system user, it shows nothing. A secret table has no app policy
// and no privilege at all: the app reaches it only through the lookup
// functions. A reader gets nothing on either.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type Settings, type TestDatabase } from "../../../test/database.ts";
import { REQUEST_HASH } from "../../../test/every-table.ts";
import { addCompany } from "../../../test/ledger.ts";
import { addIdentity, asPerson } from "../../../test/identities.ts";
import { INSTALL_TABLES } from "../../db/table-guard.ts";

/** Each person table, and the column that names the person. */
const PERSON_TABLES = {
  "access.identities": "id",
  "access.account_events": "identity_id",
  "access.idempotency_keys": "actor_id",
  "access.recent_companies": "identity_id",
} as const;

describe("the install-wide tables", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let alva: string;
  let bodil: string;
  let company: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    company = await addCompany(app);
    alva = await addIdentity(owner, { name: "Alva Berg" });
    bodil = await addIdentity(owner, { name: "Bodil Ek" });
    for (const person of [alva, bodil]) {
      await asPerson(app, person, async () => {
        await app.query("INSERT INTO access.account_events (identity_id, kind, details) VALUES ($1, 'sign-in', '{}')", [person]);
        await app.query(
          "INSERT INTO access.idempotency_keys (idempotency_key, operation_id, request_hash, response_status, response_body) VALUES ('k-1', 'logout', $1, 204, '{}')",
          [REQUEST_HASH],
        );
        await app.query("INSERT INTO access.recent_companies (identity_id, chosen_company_id, chosen_at) VALUES ($1, $2, '2030-05-15 08:30:00+00')", [person, company]);
      });
    }
  });

  afterAll(async () => {
    await db.close();
  });

  /** The people whose rows of `table` the app reads with `settings`. */
  async function seen(table: keyof typeof PERSON_TABLES, settings: Settings): Promise<string[]> {
    const column = PERSON_TABLES[table];
    return inTransaction(app, settings, async () =>
      (await app.query<{ person: string }>(`SELECT DISTINCT ${column} AS person FROM ${table} ORDER BY 1`)).rows.map((row) => row.person),
    );
  }

  it("is the list the guard pins: four person tables, one company table, four public tables and eight secret tables", () => {
    expect(Object.fromEntries([...INSTALL_TABLES].map(([table, entry]) => [table, entry.class]))).toEqual({
      "access.account_events": "person",
      "access.attempt_counters": "secret",
      "access.catalogue_groups": "public",
      "access.catalogue_permissions": "public",
      "access.catalogue_program_permissions": "public",
      "access.catalogue_programs": "public",
      "access.idempotency_keys": "person",
      "access.identities": "person",
      "access.install_keys": "secret",
      "access.known_devices": "secret",
      "access.login_challenges": "secret",
      "access.membership_contacts": "company",
      "access.password_credentials": "secret",
      "access.recent_companies": "person",
      "access.sessions": "secret",
      "access.setup_tokens": "secret",
      "access.totp_secrets": "secret",
    });
  });

  it.each(Object.keys(PERSON_TABLES) as (keyof typeof PERSON_TABLES)[])(
    "shows the app nothing of %s with no person set, and with a person only that person's rows",
    async (table) => {
      expect(await seen(table, {})).toEqual([]);
      expect(await seen(table, { channel: "rest" })).toEqual([]);
      expect(await seen(table, { company })).toEqual([]);
      expect(await seen(table, { actor: alva, kind: "user" })).toEqual([alva]);
      expect(await seen(table, { actor: bodil, kind: "user", company })).toEqual([bodil]);
      // A token acts as an integration for its person (decision 2).
      expect(await seen(table, { actor: alva, kind: "integration" })).toEqual([alva]);
      // The internal system user is nobody's person, and an actor without a kind is none.
      expect(await seen(table, { actor: alva, kind: "system" })).toEqual([]);
      expect(await seen(table, { actor: alva })).toEqual([]);
    },
  );

  it("lets the app change only the person's own identity, and add only the person's own events and keys", async () => {
    const renamed = await asPerson(app, alva, () => app.query("UPDATE access.identities SET name = 'Alva Berg Holm' WHERE id = ANY ($1::uuid[])", [[alva, bodil]]));
    expect(renamed.rowCount).toBe(1);
    const names = await owner.query("SELECT id, name FROM access.identities WHERE id = ANY ($1::uuid[]) ORDER BY name", [[alva, bodil]]);
    expect(names.rows).toEqual([
      { id: alva, name: "Alva Berg Holm" },
      { id: bodil, name: "Bodil Ek" },
    ]);
    // Not another person's id, and not with no person or as the system user.
    const event = "INSERT INTO access.account_events (identity_id, kind) VALUES ($1, 'logout')";
    await expectError(asPerson(app, alva, () => app.query(event, [bodil])), INSUFFICIENT_PRIVILEGE, /row-level security/);
    await expectError(inTransaction(app, { channel: "rest" }, () => app.query(event, [alva])), INSUFFICIENT_PRIVILEGE, /row-level security/);
    await expectError(inTransaction(app, { actor: alva, kind: "system" }, () => app.query(event, [alva])), INSUFFICIENT_PRIVILEGE, /row-level security/);
    // The app never changes or deletes an event or a key, and never adds or deletes an identity.
    for (const sql of [
      "UPDATE access.account_events SET kind = 'sign-in'",
      "DELETE FROM access.account_events",
      "UPDATE access.idempotency_keys SET response_status = 200",
      "DELETE FROM access.idempotency_keys",
      "INSERT INTO access.identities (name, email) VALUES ('Dag Ström', 'dag.strom@example.com')",
      "DELETE FROM access.identities",
    ]) {
      await expectError(asPerson(app, alva, () => app.query(sql)), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
    }
  });

  it("stamps an event's time, refuses one that is given, and takes a kind in kebab-case and details as an object", async () => {
    const add = (columns: string, values: string, params: readonly unknown[] = []): Promise<unknown> =>
      asPerson(app, alva, () => app.query(`INSERT INTO access.account_events (identity_id, ${columns}) VALUES ($1, ${values})`, [alva, ...params]));
    await expectRefusal(add("kind, at", "'logout', pg_catalog.now()"), "immutable_field", { field: "at", operation: "create" });
    await expectError(add("kind", "'Sign in'"), CHECK_VIOLATION, /account_events_kind_form/);
    await expectError(add("kind, details", "'sign-in', '[1]'"), CHECK_VIOLATION, /account_events_details_object/);
    const before = new Date();
    await add("kind, details", "'sign-in-failed', $2", [{ method: "password-email" }]);
    const found = await asPerson(app, alva, () =>
      app.query<{ kind: string; details: unknown; at: Date }>("SELECT kind, details, at FROM access.account_events WHERE kind = 'sign-in-failed'"),
    );
    expect(found.rows).toEqual([{ kind: "sign-in-failed", details: { method: "password-email" }, at: expect.any(Date) as unknown }]);
    expect(found.rows[0]?.at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000);
  });

  it("gives every secret table no app policy and no app privilege, and every install-wide table one owner policy over every row", async () => {
    const policies = await owner.query<{ relation: string; name: string; roles: string[]; command: string; using: string | null; check: string | null }>(`
      SELECT c.oid::pg_catalog.regclass::text AS relation, p.polname AS name,
        ARRAY(SELECT pg_catalog.pg_get_userbyid(r)::text FROM pg_catalog.unnest(p.polroles) AS r) AS roles,
        p.polcmd::text AS command, pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
      FROM pg_catalog.pg_policy AS p JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid
      WHERE c.relnamespace = 'access'::pg_catalog.regnamespace
      ORDER BY 1, 2`);
    for (const [table, entry] of INSTALL_TABLES) {
      const own = policies.rows.filter((row) => row.relation === table);
      expect(own.filter((row) => row.roles.includes("nortfox_owner")), table).toEqual([
        { relation: table, name: "install_owner", roles: ["nortfox_owner"], command: "*", using: "true", check: "true" },
      ]);
      if (entry.class === "secret") {
        expect(own.filter((row) => !row.roles.includes("nortfox_owner")), table).toEqual([]);
        const privileges = await owner.query<{ may: boolean }>(
          "SELECT pg_catalog.has_any_column_privilege('nortfox_app', $1, 'SELECT, INSERT, UPDATE, REFERENCES') OR pg_catalog.has_table_privilege('nortfox_app', $1, 'DELETE, TRUNCATE, TRIGGER') AS may",
          [table],
        );
        expect(privileges.rows[0]?.may, table).toBe(false);
      }
    }
  });

  // The schema access holds company tables too, the memberships among them,
  // which a reader reads as any company table. So a reader may use the schema,
  // and still reads no install-wide table.
  it("gives a reader nothing on any install-wide table, though it may use the schema access for its company tables", async () => {
    const reader = await db.connect("readerA");
    for (const table of INSTALL_TABLES.keys()) {
      await expectError(reader.query(`SELECT * FROM ${table}`), INSUFFICIENT_PRIVILEGE, new RegExp(`permission denied for table ${table.replace("access.", "")}$`));
    }
    const found = await owner.query<{ reader: boolean; app: boolean }>(
      "SELECT pg_catalog.has_schema_privilege('nortfox_reader', 'access', 'USAGE') AS reader, pg_catalog.has_schema_privilege('nortfox_app', 'access', 'USAGE') AS app",
    );
    expect(found.rows).toEqual([{ reader: true, app: true }]);
  });

  it("lets a person record a company as recently chosen, and change only the person's own record", async () => {
    const chosen = await asPerson(app, alva, () =>
      app.query("UPDATE access.recent_companies SET chosen_at = '2030-05-16 08:30:00+00' WHERE chosen_company_id = $1", [company]),
    );
    expect(chosen.rowCount).toBe(1);
    await expectError(
      asPerson(app, alva, () => app.query("INSERT INTO access.recent_companies (identity_id, chosen_company_id, chosen_at) VALUES ($1, $2, pg_catalog.now())", [bodil, company])),
      INSUFFICIENT_PRIVILEGE,
      /row-level security/,
    );
    await expectError(asPerson(app, alva, () => app.query("DELETE FROM access.recent_companies")), INSUFFICIENT_PRIVILEGE, /permission denied for table/);
  });

  it("keeps each person's rows apart also when the app names a person who has none", async () => {
    const nobody = randomUUID();
    expect(await seen("access.identities", { actor: nobody, kind: "user" })).toEqual([]);
    expect(await seen("access.account_events", { actor: nobody, kind: "user" })).toEqual([]);
  });
});
