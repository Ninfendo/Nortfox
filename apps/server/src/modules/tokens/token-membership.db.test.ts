// SPDX-License-Identifier: AGPL-3.0-only

// A token is bound to its membership (issue 12, "API tokens" 4; choice 11):
// it works while the one membership function gives that membership as its
// person's active one in its company. So it stops on the next request when
// its person is removed, leaves or is disconnected, and stays stopped when a
// new invitation lets them back: a new invitation after a removal or a leave
// makes a new membership, and a disconnect revokes the membership's tokens,
// so the same person's acceptance of the new invitation brings none back. A
// deactivation stops it too, and keeps it: after a reactivation it works
// again, with the same rights. The people and the company are made up.

import type { Me } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, jsonOf, signInApp, testClock, type SignInApp } from "../../../test/sign-in.ts";
import { asToken, makeApiToken } from "../../../test/tokens.ts";
import { apiCompany, calls, invite, joinWith, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";

describe("a token and its membership", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads every row past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** A new member and a token of theirs with every scope, which works. */
  async function memberWithToken(): Promise<{ readonly member: TestMember; readonly token: string; readonly id: string }> {
    const member = await newMember(server, { app, owner }, company);
    const made = await makeApiToken(server, await sessionIn(server, member.person, company.id));
    expect((await asToken(server, made.token, "GET", "/v1/company")).status).toBe(200);
    return { member, token: made.token, id: made.id };
  }

  /** Whether `token` names an actor on the next request: 200 for one, 401 authentication-required for none. */
  async function refused(token: string): Promise<boolean> {
    const answer = await asToken(server, token, "GET", "/v1/me");
    if (answer.status === 200) {
      return false;
    }
    expect(await jsonOf(answer, 401)).toMatchObject({ code: "authentication-required" });
    return true;
  }

  it("is refused after a removal, also once a new invitation is accepted", async () => {
    const { member, token } = await memberWithToken();
    expect((await calls.removeUser(server, company.session, member.id)).status).toBe(204);
    expect(await refused(token)).toBe(true);
    const renewed = await joinWith(server, member.person, (await invite(server, company.session, member.person.email)).token);
    expect(renewed).not.toBe(member.id);
    expect(await refused(token)).toBe(true);
    // A new token of the new membership works.
    const next = await makeApiToken(server, await sessionIn(server, member.person, company.id));
    expect(await refused(next.token)).toBe(false);
  });

  it("is refused after leaveCompany, also once a new invitation is accepted", async () => {
    const { member, token } = await memberWithToken();
    expect((await asToken(server, token, "POST", `/v1/me/companies/${company.id}/leave`)).status).toBe(204);
    expect(await refused(token)).toBe(true);
    await joinWith(server, member.person, (await invite(server, company.session, member.person.email)).token);
    expect(await refused(token)).toBe(true);
  });

  it("is refused after a disconnect, also once the same person accepts the new invitation, and the disconnect revokes it", async () => {
    const { member, token, id } = await memberWithToken();
    expect((await calls.disconnectUserIdentity(server, company.session, member.id)).status).toBe(200);
    expect(await refused(token)).toBe(true);
    const revoked = await superuser.query<{ revoked: boolean; revoked_by: string }>("SELECT revoked_at IS NOT NULL AS revoked, revoked_by FROM access.api_tokens WHERE id = $1", [id]);
    expect(revoked.rows).toEqual([{ revoked: true, revoked_by: company.creator.id }]);
    // The disconnect invites the same membership again, and the same person accepts it.
    const again = await joinWith(server, member.person, server.mail.invitationTokenTo(member.person.email));
    expect(again).toBe(member.id);
    expect(await refused(token)).toBe(true);
  });

  it("is refused after a deactivation, and works again after a reactivation, with the same rights", async () => {
    const { member, token } = await memberWithToken();
    await jsonOf(await calls.assignProgram(server, company.session, member.id, "read", { full: true }));
    const before = await jsonOf<Me>(await asToken(server, token, "GET", "/v1/me"));
    expect((await calls.updateUser(server, company.session, member.id, { active: false })).status).toBe(200);
    expect(await refused(token)).toBe(true);
    expect((await calls.updateUser(server, company.session, member.id, { active: true })).status).toBe(200);
    expect(await jsonOf<Me>(await asToken(server, token, "GET", "/v1/me"))).toEqual(before);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
