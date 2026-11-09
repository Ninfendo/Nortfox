// SPDX-License-Identifier: AGPL-3.0-only

// M7 (issue 12, "Users in a company" 4; Sessions 2): "Aktiv användare" off.
// A deactivated member cannot choose the company, and their session for it
// is refused on the next request. Their rights are kept, and reactivating
// restores the same rights. This is the session half: API tokens (part 4)
// and MCP tokens (part 5) extend this file.

import { fullPermissions } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
  MINUTE,
  chooseCompany,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signIn,
  signInApp,
  testClock,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany } from "../../../test/users.ts";

describe("a deactivated member", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("cannot choose the company", async () => {
    const member = await newMember(server, { app, owner }, company);
    expect((await calls.updateUser(server, company.session, member.id, { active: false })).status).toBe(200);
    server.clock.advance(MINUTE);
    const { session } = await signIn(server, member.person);
    expect(await jsonOf<ProblemBody>(await chooseCompany(server, session, company.id), 422)).toMatchObject({ code: "company-not-available", pointer: "/companyId" });
    const companies = await jsonOf<{ items: unknown[] }>(await getAs(server, session, "/v1/companies"));
    expect(companies.items).toEqual([]);
  });

  it("their session is refused on the next request", async () => {
    const member = await newMember(server, { app, owner }, company);
    const session = await sessionIn(server, member.person, company.id);
    expect((await getAs(server, session, "/v1/company")).status).toBe(200);
    expect((await calls.updateUser(server, company.session, member.id, { active: false })).status).toBe(200);
    const refused = await getAs(server, session, "/v1/company");
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as ProblemBody).code).toBe("authentication-required");
    // It stays ended when the member is active again.
    expect((await calls.updateUser(server, company.session, member.id, { active: true })).status).toBe(200);
    expect((await getAs(server, session, "/v1/me")).status).toBe(401);
  });

  it("reactivating restores the same rights", async () => {
    const member = await newMember(server, { app, owner }, company);
    await calls.assignProgram(server, company.session, member.id, "bookkeeping", { permissions: ["vouchers.view", "vouchers.book", "reports.vat"] });
    await calls.assignProgram(server, company.session, member.id, "auditor");
    await calls.updateUser(server, company.session, member.id, { programsAdministered: [{ program: "read" }], idleTimeout: 60 });
    const before = await jsonOf<{ permissions: string[]; membership: unknown }>(await getAs(server, await sessionIn(server, member.person, company.id), "/v1/me"));
    expect(before.permissions).toEqual(["company:read", "programs:grant", "users:read", ...new Set([...fullPermissions("auditor"), "vouchers.book", "reports.vat"])].sort());
    await calls.updateUser(server, company.session, member.id, { active: false });
    const inactive = await jsonOf<{ status: string; programs: unknown[] }>(await calls.getUser(server, company.session, member.id));
    expect(inactive.status).toBe("inactive");
    expect(inactive.programs).toHaveLength(2);
    await calls.updateUser(server, company.session, member.id, { active: true });
    const after = await jsonOf<{ permissions: string[]; membership: unknown }>(await getAs(server, await sessionIn(server, member.person, company.id), "/v1/me"));
    expect(after).toEqual(before);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
