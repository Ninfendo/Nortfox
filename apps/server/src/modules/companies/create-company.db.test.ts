// SPDX-License-Identifier: AGPL-3.0-only

// M1 (issue 12, Companies 1 and 2): a signed-in person creates a company and
// holds its owner role from the same transaction; a creation that fails
// leaves neither the company nor the membership; and the company's tenant
// id, databaseNumber, is a positive whole number that fits in 32 bits and is
// never given out again, also after a creation that rolled back. These run
// through /v1, with the server's session resolver, as nortfox_app.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
  addSignInIdentity,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signIn,
  signInApp,
  testClock,
  writeAs,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import type { Database } from "../../db/database.ts";

interface MadeCompany {
  readonly id: string;
  readonly name: string;
  readonly organizationNumber: string;
  readonly databaseNumber: number;
}

/** A database whose next person's write, once armed, fails after its work, so the work rolls back. */
function failingOnce(database: Database): { readonly database: Database; arm(): void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    database: {
      ...database,
      person: (mode, settings, work) =>
        database.person(mode, settings, async (tx) => {
          const ending = await work(tx);
          if (armed && mode === "write") {
            armed = false;
            throw new Error("The test made the creation fail after its work.");
          }
          return ending;
        }),
    },
  };
}

describe("createCompany", () => {
  let db: TestDatabase;
  let owner: Client;
  /** Reads the company tables past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let failing: ReturnType<typeof failingOnce>;
  let server: SignInApp;
  let person: TestIdentity;
  let session: string;

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    failing = failingOnce(pool.database);
    server = signInApp(failing.database, { clock: testClock() });
    person = await addSignInIdentity(owner);
    session = (await signIn(server, person)).session;
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  function create(body: unknown, key?: string): Promise<Response> {
    return writeAs(server, session, "POST", "/v1/companies", body, key === undefined ? {} : { key });
  }

  it("the creator holds the owner role from the same transaction", async () => {
    const made = await jsonOf<MadeCompany>(await create({ name: "Testbolaget Alfa AB", organizationNumber: "556000-0167" }), 201);
    expect(made).toEqual({ id: expect.any(String) as unknown, name: "Testbolaget Alfa AB", organizationNumber: "556000-0167", databaseNumber: expect.any(Number) as unknown });
    const memberships = await superuser.query<{ user_id: string; status: string; admin_level: string }>(
      "SELECT user_id, status, admin_level FROM access.memberships WHERE company_id = $1",
      [made.id],
    );
    expect(memberships.rows).toEqual([{ user_id: person.id, status: "active", admin_level: "owner" }]);
    // The company, its automatic lock and the owner's membership are in the behandlingshistorik of one transaction, by the person.
    const history = await superuser.query<{ table_name: string; operation: string; actor_id: string; actor_kind: string; transaction_id: string }>(
      "SELECT table_name, operation, actor_id, actor_kind, transaction_id::text AS transaction_id FROM audit.history WHERE company_id = $1 ORDER BY id",
      [made.id],
    );
    expect(history.rows.map(({ table_name, operation, actor_id, actor_kind }) => ({ table_name, operation, actor_id, actor_kind }))).toEqual([
      { table_name: "ledger.companies", operation: "INSERT", actor_id: person.id, actor_kind: "user" },
      { table_name: "ledger.automatic_locks", operation: "INSERT", actor_id: person.id, actor_kind: "user" },
      { table_name: "access.memberships", operation: "INSERT", actor_id: person.id, actor_kind: "user" },
    ]);
    expect(new Set(history.rows.map((row) => row.transaction_id)).size).toBe(1);
    // The person's company list gives it, with the owner's level.
    const list = await jsonOf<{ items: unknown[] }>(await getAs(server, session, "/v1/companies"));
    expect(list.items).toEqual([{ company: made, adminLevel: "owner" }]);
    // Kontoaktivitet says that the person made it.
    const events = await owner.query<{ kind: string; details: unknown }>("SELECT kind, details FROM access.account_events WHERE identity_id = $1 AND kind = 'company-created'", [
      person.id,
    ]);
    expect(events.rows).toEqual([{ kind: "company-created", details: { companyId: made.id, name: "Testbolaget Alfa AB" } }]);
  });

  it("a creation that fails leaves neither", async () => {
    const companies = async (): Promise<number> => Number((await superuser.query<{ n: string }>("SELECT count(*) AS n FROM ledger.companies")).rows[0]?.n);
    const memberships = async (): Promise<number> => Number((await superuser.query<{ n: string }>("SELECT count(*) AS n FROM access.memberships")).rows[0]?.n);
    const before = { companies: await companies(), memberships: await memberships() };
    failing.arm();
    const answer = await create({ name: "Testbolaget Beta AB", organizationNumber: "599999-0129" });
    expect(answer.status).toBe(500);
    expect(server.reports.at(-1)).toEqual(new Error("The test made the creation fail after its work."));
    expect({ companies: await companies(), memberships: await memberships() }).toEqual(before);
    expect((await superuser.query("SELECT 1 FROM ledger.companies WHERE name = 'Testbolaget Beta AB'")).rows).toEqual([]);
    // The next creation works.
    expect((await create({ name: "Testbolaget Beta AB", organizationNumber: "599999-0129" })).status).toBe(201);
  });

  it("databaseNumber is a positive int32 and never given out again, also after a rollback", async () => {
    const first = await jsonOf<MadeCompany>(await create({ name: "Testbolaget Gamma AB", organizationNumber: "556000-0167" }), 201);
    failing.arm();
    expect((await create({ name: "Testbolaget Delta AB", organizationNumber: "556000-0167" })).status).toBe(500);
    // A creation as the app that rolls back takes a number too.
    const app = await db.connect("app");
    await app.query("BEGIN");
    await app.query("SELECT set_config('nortfox.company_id', '9b2f3c1e-7d4a-4f8e-a6b5-c3d2e1f0a9b8', true), set_config('nortfox.actor_id', $1, true), set_config('nortfox.actor_kind', 'user', true)", [
      person.id,
    ]);
    const taken = await app.query<{ database_number: number }>(
      "INSERT INTO ledger.companies (company_id, name, organization_number) VALUES ('9b2f3c1e-7d4a-4f8e-a6b5-c3d2e1f0a9b8', 'Testbolaget Epsilon AB', '556000-0167') RETURNING database_number",
    );
    await app.query("ROLLBACK");
    await app.end();
    const next = await jsonOf<MadeCompany>(await create({ name: "Testbolaget Zeta AB", organizationNumber: "556000-0167" }), 201);
    const rolledBack = taken.rows[0]?.database_number ?? 0;
    // The failed creation through /v1 took the number after the first; the app's took the next; the next creation gets a new one.
    expect(rolledBack).toBe(first.databaseNumber + 2);
    expect(next.databaseNumber).toBe(first.databaseNumber + 3);
    const numbers = await superuser.query<{ database_number: number }>("SELECT database_number FROM ledger.companies");
    expect(new Set(numbers.rows.map((row) => row.database_number)).size).toBe(numbers.rows.length);
    for (const { database_number: number } of numbers.rows) {
      expect(Number.isInteger(number) && number >= 1 && number <= 2147483647).toBe(true);
    }
    // The sequence gives whole numbers from 1 to the largest int32, and never starts again.
    const sequence = await superuser.query("SELECT data_type::text, min_value, max_value, cycle FROM pg_catalog.pg_sequences WHERE schemaname = 'ledger' AND sequencename = 'database_number_seq'");
    expect(sequence.rows).toEqual([{ data_type: "integer", min_value: 1n, max_value: 2147483647n, cycle: false }]);
  });

  it("refuses a company without its name or organisation number, or with a number of another form", async () => {
    const problem = async (body: unknown): Promise<ProblemBody> => jsonOf<ProblemBody>(await create(body), 400);
    expect((await problem({ organizationNumber: "556000-0167" })).errors).toEqual([{ code: "missing-field", detail: "The field /name is missing.", pointer: "/name", data: { expected: "string" } }]);
    expect((await problem({ name: "", organizationNumber: "556000-0167" })).errors?.[0]?.code).toBe("too-short");
    expect((await problem({ name: "Testbolaget Eta AB" })).errors?.[0]?.pointer).toBe("/organizationNumber");
    for (const organizationNumber of ["5560000167", "556000-016", "55600-00167", "556000-0167 "]) {
      expect((await problem({ name: "Testbolaget Eta AB", organizationNumber })).errors?.[0]).toMatchObject({ code: "bad-format", pointer: "/organizationNumber" });
    }
    expect((await problem({ name: "Testbolaget Eta AB", organizationNumber: "556000-0167", databaseNumber: 7 })).errors?.[0]).toMatchObject({
      code: "unknown-field",
      pointer: "/databaseNumber",
    });
  });

  it("refuses a name with a lone surrogate as a field problem, never a server failure, and makes nothing", async () => {
    const companies = async (): Promise<number> => Number((await superuser.query<{ n: string }>("SELECT count(*) AS n FROM ledger.companies")).rows[0]?.n);
    const before = await companies();
    const reports = server.reports.length;
    for (const name of ["Testbolaget \uD800 AB", "Testbolaget AB \uDC00"]) {
      const problem = await jsonOf<ProblemBody>(await create({ name, organizationNumber: "556677-1234" }), 400);
      expect(problem.errors?.map((error) => [error.code, error.pointer, error.detail])).toEqual([
        ["invalid-value", "/name", "The field /name holds a lone surrogate, which is not a character."],
      ]);
    }
    expect(await companies()).toBe(before);
    expect(server.reports.length).toBe(reports);
  });

  it("needs a signed-in person", async () => {
    const answer = await server.send("/v1/companies", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "no-session" },
      body: JSON.stringify({ name: "Testbolaget Theta AB", organizationNumber: "556000-0167" }),
    });
    expect(answer.status).toBe(401);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
