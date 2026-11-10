// SPDX-License-Identifier: AGPL-3.0-only

// A token's permissions (issue 12, "API tokens" 2; "Roles, admin levels,
// programs and permissions" 12). A token has no snapshot: on every request
// the server enters the token's company, from the one membership function,
// and reads its person's program grants and administered programs there.
// So a token of a member with a Bokföring grant holds vouchers.view in
// getMe, and passes a test-only read that needs it, and holds nothing that
// the member's grants in another company give. The people and the
// companies are made up.

import type { Me } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { rightPath, withRightChecks } from "../../../test/rights.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, jsonOf, signInApp, testClock, type SignInApp } from "../../../test/sign-in.ts";
import { asToken, makeApiToken } from "../../../test/tokens.ts";
import { apiCompany, calls, invite, joinWith, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";

describe("a token's permissions", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let pool: AppPool;
  let server: SignInApp;
  let alfa: ApiCompany;
  let beta: ApiCompany;
  let member: TestMember;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 4);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()), options: withRightChecks(["vouchers.view", "vouchers.book"]) });
    alfa = await apiCompany(server, { app, owner }, "Testbolaget Alfa AB");
    beta = await apiCompany(server, { app, owner }, "Testbolaget Beta AB");
    member = await newMember(server, { app, owner }, alfa);
    // In alfa the member sees vouchers; in beta they book them too.
    await jsonOf(await calls.assignProgram(server, alfa.session, member.id, "bookkeeping", { permissions: ["vouchers.view"] }));
    const inBeta = await joinWith(server, member.person, (await invite(server, beta.session, member.person.email)).token);
    await jsonOf(await calls.assignProgram(server, beta.session, inBeta, "bookkeeping", { permissions: ["vouchers.view", "vouchers.book"] }));
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("a token of a member with a Bokföring grant holds vouchers.view in getMe and passes a read that needs it, from the grants of its own company", async () => {
    const { token } = await makeApiToken(server, await sessionIn(server, member.person, alfa.id), { scopes: ["profile", "bookkeeping"] });
    const me = await jsonOf<Me>(await asToken(server, token, "GET", "/v1/me"));
    expect(me.permissions).toEqual(["company:read", "tokens:own", "vouchers.view"]);
    expect(me.company?.id).toBe(alfa.id);
    expect(me.membership?.programs.map((grant) => [grant.program, grant.permissions])).toEqual([["bookkeeping", ["vouchers.view"]]]);
    expect(await jsonOf(await asToken(server, token, "GET", rightPath("vouchers.view")))).toEqual({ permission: "vouchers.view" });
    // Bokför is the member's in beta, not in the token's company.
    expect(await jsonOf<ProblemBody>(await asToken(server, token, "GET", rightPath("vouchers.book")), 403)).toMatchObject({
      code: "permission-missing",
      permission: "vouchers.book",
    });
  });

  it("holds a program administrator's rights while the member administers a program in its company", async () => {
    const administrator = await newMember(server, { app, owner }, alfa);
    await jsonOf(await calls.updateUser(server, alfa.session, administrator.id, { programsAdministered: [{ program: "read" }] }));
    const { token } = await makeApiToken(server, await sessionIn(server, administrator.person, alfa.id), { scopes: ["profile", "users"] });
    const me = await jsonOf<Me>(await asToken(server, token, "GET", "/v1/me"));
    expect(me.permissions).toEqual(["company:read", "programs:grant", "tokens:own", "users:read"]);
    expect(me.membership?.programsAdministered).toEqual([{ program: "read" }]);
    // A program administrator sees the users, and only the programs they administer.
    const users = await jsonOf<{ items: { id: string; programs: { program: string }[] }[] }>(await asToken(server, token, "GET", "/v1/users"));
    expect(users.items.find((item) => item.id === member.id)?.programs).toEqual([]);
  });

  it("holds a system administrator's rights, all the tokens of the company among them", async () => {
    const { token } = await makeApiToken(server, alfa.session, { scopes: ["profile"] });
    const me = await jsonOf<Me>(await asToken(server, token, "GET", "/v1/me"));
    expect(me.permissions).toEqual(["company:read", "company:update", "programs:grant", "tokens:all", "tokens:own", "users:admin", "users:read"]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
