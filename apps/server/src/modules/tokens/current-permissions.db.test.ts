// SPDX-License-Identifier: AGPL-3.0-only

// R12 (issue 12, "API tokens" 4; "Roles, admin levels, programs and
// permissions" 12). This is the API token's half: a token follows its
// person's current permissions on every request, so a permission removed
// from a member is refused on the next request of the member's API token,
// while a session that chose the company before the change keeps it until it
// chooses again (R11). A permission given back reaches the token at once
// too, and a Revisor grant's end holds for the token on its next request
// ("Roles" 12). Part 5 completes this file with the MCP token. The people
// and the company are made up.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { grantTimes } from "../../../test/grants.ts";
import { asMember } from "../../../test/memberships.ts";
import { rightPath, withRightChecks } from "../../../test/rights.ts";
import { HOUR, expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, getAs, jsonOf, signInApp, testClock, type SignInApp } from "../../../test/sign-in.ts";
import { asToken, makeApiToken } from "../../../test/tokens.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany } from "../../../test/users.ts";

describe("a token's current permissions", () => {
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
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()), options: withRightChecks(["vouchers.view"]) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("a removed permission is refused on the next request of the API token", async () => {
    const member = await newMember(server, { app, owner }, company);
    await jsonOf(await calls.assignProgram(server, company.session, member.id, "bookkeeping", { permissions: ["vouchers.view"] }));
    const session = await sessionIn(server, member.person, company.id);
    const { token } = await makeApiToken(server, session, { scopes: ["bookkeeping"] });
    const view = rightPath("vouchers.view");
    expect(await jsonOf(await asToken(server, token, "GET", view))).toEqual({ permission: "vouchers.view" });
    expect((await calls.removeProgram(server, company.session, member.id, "bookkeeping")).status).toBe(204);
    expect(await jsonOf<ProblemBody>(await asToken(server, token, "GET", view), 403)).toMatchObject({ code: "permission-missing", permission: "vouchers.view" });
    // The session that chose the company before keeps it until it chooses again (R11).
    expect((await getAs(server, session, view)).status).toBe(200);
    // Given back, it reaches the token at once.
    await jsonOf(await calls.assignProgram(server, company.session, member.id, "bookkeeping", { permissions: ["vouchers.view"] }));
    expect(await jsonOf(await asToken(server, token, "GET", view))).toEqual({ permission: "vouchers.view" });
  });

  it("an admin level taken away is refused on the next request of the API token", async () => {
    const member = await newMember(server, { app, owner }, company);
    await jsonOf(await calls.updateUser(server, company.session, member.id, { adminLevel: "admin" }));
    const { token } = await makeApiToken(server, await sessionIn(server, member.person, company.id), { scopes: ["users"] });
    expect((await asToken(server, token, "GET", "/v1/users")).status).toBe(200);
    await jsonOf(await calls.updateUser(server, company.session, member.id, { adminLevel: null }));
    expect(await jsonOf<ProblemBody>(await asToken(server, token, "GET", "/v1/users"), 403)).toMatchObject({ code: "permission-missing", permission: "users:read" });
  });

  it("a Revisor grant's end holds for the API token at once, with no action by anyone", async () => {
    const member = await newMember(server, { app, owner }, company);
    expect((await calls.assignProgram(server, company.session, member.id, "auditor", { full: true })).status).toBe(200);
    const [grant] = await asMember<{ id: string }>(app, company.id, company.asOwner, "SELECT id FROM access.program_grants WHERE membership_id = $1", [member.id]);
    const { expiresAt } = await grantTimes(app, company, grant?.id ?? "");
    if (expiresAt === null) {
      throw new Error("The Revisor grant has no end.");
    }
    // The database stamps the grant with its own clock, so this server's clock starts an hour before the grant's end.
    const late = signInApp(pool.database, { clock: testClock(new Date(expiresAt.getTime() - HOUR)), options: withRightChecks(["vouchers.view"]) });
    const { token } = await makeApiToken(late, await sessionIn(late, member.person, company.id), { scopes: ["bookkeeping"] });
    const view = rightPath("vouchers.view");
    expect(await jsonOf(await asToken(late, token, "GET", view))).toEqual({ permission: "vouchers.view" });
    // Past the end the token holds the grant's rights no more, on its next request.
    late.clock.advance(HOUR);
    expect(late.clock.now().getTime()).toBeGreaterThan(expiresAt.getTime());
    expect(await jsonOf<ProblemBody>(await asToken(late, token, "GET", view), 403)).toMatchObject({ code: "permission-missing", permission: "vouchers.view" });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
