// SPDX-License-Identifier: AGPL-3.0-only

// Where a signed-in write keeps its idempotency key (plan 2.2). createCompany
// keeps it per person, in access.idempotency_keys with no company, since its
// company is new on each try: a repeat gives the first company again and
// makes no second one. A write in a company whose answer holds a person's
// contact data, such as updateMyMembership and selectCompany, keeps it in
// access.idempotency_keys with the company, so no work contact reaches
// ledger.idempotency_keys, whose rows the behandlingshistorik copies, or
// audit.history at all. These run through /v1 as nortfox_app.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { aCompany, addMembership, type Company } from "../../../test/memberships.ts";
import {
  addSignInIdentity,
  chooseCompany,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  jsonOf,
  signIn,
  signInApp,
  testClock,
  writeAs,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";

interface KeyRow {
  readonly key_company_id: string | null;
  readonly actor_id: string;
  readonly operation_id: string;
  readonly response_status: number;
}

describe("the key stores of the signed-in writes", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads the company tables past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let person: TestIdentity;
  let session: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock() });
    person = await addSignInIdentity(owner);
    session = (await signIn(server, person)).session;
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function personKeys(key: string): Promise<KeyRow[]> {
    return (await owner.query<KeyRow>(
      "SELECT key_company_id, actor_id, operation_id, response_status FROM access.idempotency_keys WHERE idempotency_key = $1 ORDER BY created_at",
      [key],
    )).rows;
  }

  async function companyKeys(key: string): Promise<{ company_id: string }[]> {
    return (await superuser.query<{ company_id: string }>("SELECT company_id FROM ledger.idempotency_keys WHERE idempotency_key = $1", [key])).rows;
  }

  async function companiesNamed(name: string): Promise<number> {
    return Number((await superuser.query<{ n: string }>("SELECT count(*) AS n FROM ledger.companies WHERE name = $1", [name])).rows[0]?.n);
  }

  it("keeps createCompany's key per person, with no company, so a repeat gives the first company and makes none", async () => {
    const body = { name: "Testbolaget Alfa AB", organizationNumber: "556000-0167" };
    const first = await writeAs(server, session, "POST", "/v1/companies", body, { key: "make-alfa" });
    const made = await jsonOf(first, 201);
    const again = await writeAs(server, session, "POST", "/v1/companies", body, { key: "make-alfa" });
    expect(await jsonOf(again, 201)).toEqual(made);
    expect(await companiesNamed("Testbolaget Alfa AB")).toBe(1);
    expect(await personKeys("make-alfa")).toEqual([{ key_company_id: null, actor_id: person.id, operation_id: "createCompany", response_status: 201 }]);
    expect(await companyKeys("make-alfa")).toEqual([]);
    // The key with another request is refused.
    const other = await writeAs(server, session, "POST", "/v1/companies", { ...body, name: "Testbolaget Beta AB" }, { key: "make-alfa" });
    expect((await jsonOf<ProblemBody>(other, 422)).code).toBe("idempotency-key-reused");
    expect(await companiesNamed("Testbolaget Beta AB")).toBe(0);
    // Another person's key is their own.
    const someone = await addSignInIdentity(owner);
    const theirs = await writeAs(server, (await signIn(server, someone)).session, "POST", "/v1/companies", body, { key: "make-alfa" });
    expect((await jsonOf<{ id: string }>(theirs, 201)).id).not.toBe((made as { id: string }).id);
    expect(await companiesNamed("Testbolaget Alfa AB")).toBe(2);
  });

  describe("in a company", () => {
    let company: Company;

    beforeAll(async () => {
      company = await aCompany(app, "Testbolaget Gamma AB");
      await addMembership(app, owner, company, { user: person.id });
    });

    it("keeps updateMyMembership's key in access.idempotency_keys with the company, since its output is personal", async () => {
      const body = { workEmail: "alva.berg@example.com", workPhone: "070-174 06 07" };
      const first = await jsonOf(await writeAs(server, session, "PATCH", `/v1/me/companies/${company.id}`, body, { key: "my-contacts" }));
      const history = async (): Promise<number> => Number((await superuser.query<{ n: string }>("SELECT count(*) AS n FROM audit.history WHERE company_id = $1", [company.id])).rows[0]?.n);
      const before = await history();
      expect(await jsonOf(await writeAs(server, session, "PATCH", `/v1/me/companies/${company.id}`, body, { key: "my-contacts" }))).toEqual(first);
      expect(await history()).toBe(before);
      expect(await personKeys("my-contacts")).toEqual([{ key_company_id: company.id, actor_id: person.id, operation_id: "updateMyMembership", response_status: 200 }]);
      expect(await companyKeys("my-contacts")).toEqual([]);
    });

    it("keeps selectCompany's key the same way, since its output names the person", async () => {
      expect((await chooseCompany(server, session, company.id, { key: "choose-gamma" })).status).toBe(200);
      expect(await personKeys("choose-gamma")).toEqual([{ key_company_id: company.id, actor_id: person.id, operation_id: "selectCompany", response_status: 200 }]);
      expect(await companyKeys("choose-gamma")).toEqual([]);
    });

    it("lets no work contact reach ledger.idempotency_keys or audit.history", async () => {
      const body = { workEmail: "alva.arbete@example.org", workPhone: "070-174 06 08", idleTimeout: 60 };
      await jsonOf(await writeAs(server, session, "PATCH", `/v1/me/companies/${company.id}`, body));
      const contacts = await owner.query("SELECT work_email, work_phone FROM access.membership_contacts WHERE contact_company_id = $1", [company.id]);
      expect(contacts.rows).toEqual([{ work_email: "alva.arbete@example.org", work_phone: "070-174 06 08" }]);
      for (const text of ["alva.berg@example.com", "070-174 06 07", "alva.arbete@example.org", "070-174 06 08"]) {
        const inKeys = await superuser.query("SELECT 1 FROM ledger.idempotency_keys WHERE response_body::text LIKE '%' || $1 || '%'", [text]);
        const inHistory = await superuser.query("SELECT 1 FROM audit.history WHERE coalesce(old_values::text, '') || coalesce(new_values::text, '') LIKE '%' || $1 || '%'", [text]);
        expect({ text, keys: inKeys.rows.length, history: inHistory.rows.length }).toEqual({ text, keys: 0, history: 0 });
      }
      // The idle time is company data: its change is in the behandlingshistorik.
      const changes = await superuser.query<{ idle: number }>(
        "SELECT (new_values ->> 'idle_timeout_minutes')::int AS idle FROM audit.history WHERE company_id = $1 AND table_name = 'access.memberships' AND operation = 'UPDATE' ORDER BY id DESC LIMIT 1",
        [company.id],
      );
      expect(changes.rows).toEqual([{ idle: 60 }]);
    });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
