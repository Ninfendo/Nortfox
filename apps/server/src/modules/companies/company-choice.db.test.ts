// SPDX-License-Identifier: AGPL-3.0-only

// M2 (issue 12, Companies 4): listCompanies lists only the companies where
// the person has an active membership; selectCompany ("Byt företag")
// switches the session's company without a new sign-in, and refuses any
// other company with the same answer as a company that does not exist. With
// it, getSession, getMe and getCompany work in the chosen company, and
// listRecentCompanies gives the last three chosen. These run through /v1,
// with the server's session resolver, as nortfox_app.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addCompanyWithOwner } from "../../../test/ledger.ts";
import { aCompany, addMembership, changeMembership, type Company } from "../../../test/memberships.ts";
import {
  addSignInIdentity,
  chooseCompany,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signIn,
  signInApp,
  testClock,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { tokenHash } from "../../auth/tokens.ts";
import type { Database } from "../../db/database.ts";

interface CompanyJson {
  readonly id: string;
  readonly name: string;
  readonly organizationNumber: string;
  readonly databaseNumber: number;
}

interface Page {
  readonly items: readonly { readonly company: CompanyJson; readonly adminLevel?: string }[];
  readonly total: number;
  readonly nextCursor?: string;
}

/** The one answer for a company the person may not choose. */
const NOT_AVAILABLE: ProblemBody = {
  type: "about:blank",
  title: "Unprocessable Content",
  status: 422,
  detail: "The person is no active member of the company that companyId names, or it does not exist.",
  code: "company-not-available",
  pointer: "/companyId",
};

describe("the company choice", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads the company tables past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let person: TestIdentity;
  let session: string;
  let alfa: Company;
  let beta: Company;
  /** The companies the person is no active member of: inactive, removed, left, invited by address only, and never a member. */
  let others: Readonly<Record<string, string>>;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock() });
    person = await addSignInIdentity(owner);
    const as = { actor: person.id, kind: "user" as const };
    // The person made Alfa, so owns it, and is an active member of Beta.
    const made = await addCompanyWithOwner(app, as, { name: "Testbolaget Alfa AB", organizationNumber: "556000-0167" });
    alfa = { ...made, id: made.row.company_id, asOwner: as };
    beta = await aCompany(app, "Testbolaget Beta AB");
    await addMembership(app, owner, beta, { user: person.id });
    const gamma = await aCompany(app, "Testbolaget Gamma AB");
    await changeMembership(app, gamma, await addMembership(app, owner, gamma, { user: person.id }), "status = 'inactive'");
    const delta = await aCompany(app, "Testbolaget Delta AB");
    await changeMembership(app, delta, await addMembership(app, owner, delta, { user: person.id }), "status = 'removed'");
    const epsilon = await aCompany(app, "Testbolaget Epsilon AB");
    await changeMembership(app, epsilon, await addMembership(app, owner, epsilon, { user: person.id }), "status = 'left'", [], as);
    const zeta = await aCompany(app, "Testbolaget Zeta AB");
    await addMembership(app, owner, zeta, { status: "invited" });
    const eta = await aCompany(app, "Testbolaget Eta AB");
    others = { inactive: gamma.id, removed: delta.id, left: epsilon.id, invited: zeta.id, stranger: eta.id, unknown: randomUUID() };
    session = (await signIn(server, person)).session;
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function companyOf(id: string): Promise<CompanyJson> {
    const found = await superuser.query<{ name: string; organization_number: string; database_number: number }>(
      "SELECT name, organization_number, database_number FROM ledger.companies WHERE company_id = $1",
      [id],
    );
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("No such company.");
    }
    return { id, name: row.name, organizationNumber: row.organization_number, databaseNumber: row.database_number };
  }

  async function sessionsOf(who: string): Promise<{ id: string; current_company_id: string | null; ended_at: Date | null }[]> {
    return (await owner.query<{ id: string; current_company_id: string | null; ended_at: Date | null }>(
      "SELECT id, current_company_id, ended_at FROM access.sessions WHERE identity_id = $1 ORDER BY started_at",
      [who],
    )).rows;
  }

  it("lists only active memberships", async () => {
    const page = await jsonOf<Page>(await getAs(server, session, "/v1/companies"));
    expect(page).toEqual({ items: [{ company: await companyOf(alfa.id), adminLevel: "owner" }, { company: await companyOf(beta.id) }], total: 2 });
  });

  it("finds a company by a part of its name in any letter case, or of its organisation number, and pages by name", async () => {
    expect((await jsonOf<Page>(await getAs(server, session, "/v1/companies?query=BETA"))).items.map((item) => item.company.name)).toEqual(["Testbolaget Beta AB"]);
    expect((await jsonOf<Page>(await getAs(server, session, "/v1/companies?query=6000-01"))).items.map((item) => item.company.name)).toEqual(["Testbolaget Alfa AB", "Testbolaget Beta AB"]);
    expect(await jsonOf<Page>(await getAs(server, session, "/v1/companies?query=599999"))).toEqual({ items: [], total: 0 });
    expect(await jsonOf<Page>(await getAs(server, session, "/v1/companies?query=Gamma"))).toEqual({ items: [], total: 0 });
    const first = await jsonOf<Page>(await getAs(server, session, "/v1/companies?limit=1"));
    expect(first.items.map((item) => item.company.name)).toEqual(["Testbolaget Alfa AB"]);
    expect(first.total).toBe(2);
    const second = await jsonOf<Page>(await getAs(server, session, `/v1/companies?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`));
    expect(second).toEqual({ items: [{ company: await companyOf(beta.id) }], total: 2 });
    // A cursor is the person's own: another person's session refuses it.
    const other = await addSignInIdentity(owner);
    const otherSession = (await signIn(server, other)).session;
    const refused = await jsonOf<ProblemBody>(await getAs(server, otherSession, `/v1/companies?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`), 400);
    expect(refused.errors?.[0]?.code).toBe("cursor-invalid");
    expect(await jsonOf<Page>(await getAs(server, otherSession, "/v1/companies"))).toEqual({ items: [], total: 0 });
  });

  it("works in no company before a choice", async () => {
    expect(await jsonOf(await getAs(server, session, "/v1/session"))).toEqual({ user: { id: person.id, name: "Alva Berg", email: person.email, language: "sv" } });
    const me = await jsonOf(await getAs(server, session, "/v1/me"));
    expect(me["company"]).toBeUndefined();
    expect(me["membership"]).toBeUndefined();
    expect(me["permissions"]).toEqual([]);
    expect((await jsonOf<ProblemBody>(await getAs(server, session, "/v1/company"), 403)).code).toBe("company-required");
  });

  it("switches company without a new login", async () => {
    const before = await sessionsOf(person.id);
    const chose = await chooseCompany(server, session, alfa.id);
    expect(chose.headers.getSetCookie()).toEqual([]);
    expect(await jsonOf(chose)).toEqual({ user: { id: person.id, name: "Alva Berg", email: person.email, language: "sv" }, company: await companyOf(alfa.id) });
    expect(await jsonOf(await getAs(server, session, "/v1/company"))).toEqual(await companyOf(alfa.id));
    expect((await jsonOf(await getAs(server, session, "/v1/session")))["company"]).toEqual(await companyOf(alfa.id));
    // Then Beta, in the same session.
    expect((await jsonOf(await chooseCompany(server, session, beta.id)))["company"]).toEqual(await companyOf(beta.id));
    expect(await jsonOf(await getAs(server, session, "/v1/company"))).toEqual(await companyOf(beta.id));
    const after = await sessionsOf(person.id);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    const stored = await owner.query<{ current_company_id: string; current_membership_id: string; permissions: unknown }>(
      "SELECT current_company_id, current_membership_id, permissions FROM access.sessions WHERE token_hash = $1",
      [tokenHash(session)],
    );
    const membership = await superuser.query<{ id: string }>("SELECT id FROM access.memberships WHERE company_id = $1 AND user_id = $2", [beta.id, person.id]);
    expect(stored.rows).toEqual([{ current_company_id: beta.id, current_membership_id: membership.rows[0]?.id, permissions: { "company:read": null } }]);
  });

  it("gives getMe the current company, the membership and the permissions there", async () => {
    await chooseCompany(server, session, alfa.id);
    const me = await jsonOf(await getAs(server, session, "/v1/me"));
    expect(me).toEqual({
      user: { id: person.id, name: "Alva Berg", email: person.email, language: "sv" },
      twoStep: "new_device_90_days",
      company: await companyOf(alfa.id),
      membership: { companyId: alfa.id, userId: person.id, status: "active", adminLevel: "owner", idleTimeout: 120 },
      permissions: ["company:read"],
    });
    await chooseCompany(server, session, beta.id);
    const inBeta = await jsonOf(await getAs(server, session, "/v1/me"));
    expect(inBeta["membership"]).toEqual({ companyId: beta.id, userId: person.id, status: "active", idleTimeout: 120 });
    expect(inBeta["permissions"]).toEqual(["company:read"]);
  });

  it("refuses any other company with the same answer as a company that does not exist", async () => {
    await chooseCompany(server, session, beta.id);
    for (const [why, id] of Object.entries(others)) {
      const answer = await chooseCompany(server, session, id);
      expect(answer.status, why).toBe(422);
      expect(await answer.json(), why).toEqual(NOT_AVAILABLE);
    }
    // The session still works in the company it chose last.
    expect(await jsonOf(await getAs(server, session, "/v1/company"))).toEqual(await companyOf(beta.id));
    // A company id of the wrong form is a field problem.
    const malformed = await jsonOf<ProblemBody>(await chooseCompany(server, session, "Testbolaget Beta AB"), 400);
    expect(malformed.errors?.[0]).toMatchObject({ code: "bad-format", pointer: "/companyId" });
  });

  it("gives the three companies chosen last, the latest first, where the person is still an active member", async () => {
    const recent = async (): Promise<string[]> =>
      (await jsonOf<{ companies: { company: CompanyJson }[] }>(await getAs(server, session, "/v1/me/companies/recent"))).companies.map((item) => item.company.name);
    const third = await aCompany(app, "Testbolaget Iota AB");
    await addMembership(app, owner, third, { user: person.id });
    const fourth = await aCompany(app, "Testbolaget Kappa AB");
    const inFourth = await addMembership(app, owner, fourth, { user: person.id });
    for (const company of [alfa, beta, third, fourth]) {
      server.clock.advance(1000);
      expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    }
    expect(await recent()).toEqual(["Testbolaget Kappa AB", "Testbolaget Iota AB", "Testbolaget Beta AB"]);
    server.clock.advance(1000);
    await chooseCompany(server, session, alfa.id);
    expect(await recent()).toEqual(["Testbolaget Alfa AB", "Testbolaget Kappa AB", "Testbolaget Iota AB"]);
    // A company the person is no longer an active member of leaves the list.
    await changeMembership(app, fourth, inFourth, "status = 'inactive'");
    expect(await recent()).toEqual(["Testbolaget Alfa AB", "Testbolaget Iota AB", "Testbolaget Beta AB"]);
    // Another person's list is their own.
    const other = await addSignInIdentity(owner);
    expect(await jsonOf(await getAs(server, (await signIn(server, other)).session, "/v1/me/companies/recent"))).toEqual({ companies: [] });
  });

  it("answers 401 as for no actor, reports nothing and chooses nothing when the session ends while it chooses", async () => {
    const someone = await addSignInIdentity(owner);
    const company = (await addCompanyWithOwner(app, { actor: someone.id, kind: "user" }, { name: "Testbolaget Omega AB" })).row.company_id;
    // A logout at once ends the session after the resolver read it, before the choice is stored.
    let armed = true;
    const racing: Database = {
      ...pool.database,
      person: (mode, settings, work) =>
        pool.database.person(mode, settings, async (tx) => {
          if (armed) {
            armed = false;
            await owner.query("UPDATE access.sessions SET ended_at = pg_catalog.now(), end_reason = 'logout' WHERE identity_id = $1 AND ended_at IS NULL", [someone.id]);
          }
          return work(tx);
        }),
    };
    const racer = signInApp(racing, { clock: testClock() });
    const racingSession = (await signIn(racer, someone)).session;
    const answer = await chooseCompany(racer, racingSession, company);
    expect(answer.headers.get("www-authenticate")).toBe(`Cookie realm="NortFox", cookie-name="__Host-nortfox-session"`);
    expect(await jsonOf<ProblemBody>(answer, 401)).toMatchObject({ status: 401, code: "authentication-required" });
    // The session's own end is no fault of the server.
    expect(racer.reports).toEqual([]);
    expect((await owner.query("SELECT 1 FROM access.recent_companies WHERE identity_id = $1", [someone.id])).rows).toEqual([]);
    expect((await superuser.query("SELECT 1 FROM access.events WHERE company_id = $1", [company])).rows).toEqual([]);
    expect((await owner.query("SELECT current_company_id FROM access.sessions WHERE identity_id = $1", [someone.id])).rows).toEqual([{ current_company_id: null }]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
