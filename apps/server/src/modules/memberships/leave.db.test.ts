// SPDX-License-Identifier: AGPL-3.0-only

// M9 (issue 12, "Users in a company" 6 and 7): "Koppla bort användaren", a
// person leaves a company from the company list. After leaveCompany the
// person no longer reaches the company: their session is refused on the
// next request, and the company is in no list. The membership stays, with
// the status left, as the person's own act in the behandlingshistorik, and
// its work contacts are erased. Only a new invitation lets the person back,
// as a new membership, and the old session stays refused. The last system
// administrator cannot leave (the REST half of M10, which
// last-system-administrator.db.test.ts holds with its races).

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
  holdingWrites,
  jsonOf,
  signIn,
  signInApp,
  testClock,
  untilSomeoneWaitsForLock,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, invite, joinWith, newMember, sessionIn, type ApiCompany } from "../../../test/users.ts";

describe("leaving a company", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
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
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function rowOf(id: string): Promise<{ status: string; user_id: string | null; live_user_id: string | null } | undefined> {
    const found = await superuser.query<{ status: string; user_id: string | null; live_user_id: string | null }>(
      "SELECT status, user_id, live_user_id FROM access.memberships WHERE id = $1",
      [id],
    );
    return found.rows[0];
  }

  it("the person no longer reaches the company", async () => {
    const member = await newMember(server, { app, owner }, company);
    expect((await calls.updateUser(server, company.session, member.id, { workPhone: "070-222 33 44" })).status).toBe(200);
    const session = await sessionIn(server, member.person, company.id);
    expect((await calls.leaveCompany(server, session, company.id)).status).toBe(204);
    expect(await rowOf(member.id)).toEqual({ status: "left", user_id: member.person.id, live_user_id: null });
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    server.clock.advance(MINUTE);
    const fresh = await signIn(server, member.person);
    expect(await jsonOf<ProblemBody>(await chooseCompany(server, fresh.session, company.id), 422)).toMatchObject({ code: "company-not-available" });
    expect((await jsonOf<{ items: unknown[] }>(await getAs(server, fresh.session, "/v1/companies"))).items).toEqual([]);
    expect(await jsonOf<ProblemBody>(await calls.leaveCompany(server, fresh.session, company.id), 422)).toMatchObject({
      code: "company-not-available",
      pointer: "/companyId",
    });
    // The work contacts are erased, and the leave is the person's own act in the behandlingshistorik.
    expect((await superuser.query("SELECT 1 FROM access.membership_contacts WHERE membership_id = $1", [member.id])).rows).toEqual([]);
    const history = await superuser.query<{ actor_id: string }>(
      "SELECT actor_id FROM audit.history WHERE table_name = 'access.memberships' AND row_id = $1 AND new_values->>'status' = 'left'",
      [member.id],
    );
    expect(history.rows).toEqual([{ actor_id: member.person.id }]);
    // The company sees the member no more.
    expect(await jsonOf<ProblemBody>(await calls.getUser(server, company.session, member.id), 422)).toMatchObject({ code: "user-not-found" });
  });

  it("only a new invitation lets them back, and their old credentials stay refused", async () => {
    const member = await newMember(server, { app, owner }, company);
    const session = await sessionIn(server, member.person, company.id);
    expect((await calls.leaveCompany(server, session, company.id)).status).toBe(204);
    const renewed = await joinWith(server, member.person, (await invite(server, company.session, member.person.email)).token);
    expect(renewed).not.toBe(member.id);
    expect(await rowOf(renewed)).toEqual({ status: "active", user_id: member.person.id, live_user_id: member.person.id });
    expect((await rowOf(member.id))?.status).toBe("left");
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    const next = await sessionIn(server, member.person, company.id);
    const me = await jsonOf<{ membership: { id: string } }>(await getAs(server, next, "/v1/me"));
    expect(me.membership.id).toBe(renewed);
  });

  it("a repeat with its key finds the company no longer available, as any call naming it does", async () => {
    const member = await newMember(server, { app, owner }, company);
    const session = await sessionIn(server, member.person, company.id);
    expect((await calls.leaveCompany(server, session, company.id, "leave-once")).status).toBe(204);
    // The session ended with the leave. The runner asks the one membership function before it reads the key.
    server.clock.advance(MINUTE);
    const fresh = await signIn(server, member.person);
    expect(await jsonOf<ProblemBody>(await calls.leaveCompany(server, fresh.session, company.id, "leave-once"), 422)).toMatchObject({ code: "company-not-available" });
    expect((await rowOf(member.id))?.status).toBe("left");
  });

  it("a leave that waits for the membership's removal finds the company no longer available", async () => {
    const member = await newMember(server, { app, owner }, company);
    const session = await sessionIn(server, member.person, company.id);
    // The removal holds the membership's row when it waits before its commit.
    const holding = holdingWrites(pool.database, () => true, "commit");
    const racer = signInApp(holding.database, { clock: server.clock });
    const removing = calls.removeUser(racer, company.session, member.id);
    await holding.gate.reached;
    // The leave finds the membership active, and waits for its row.
    const leaving = calls.leaveCompany(server, session, company.id);
    await untilSomeoneWaitsForLock(superuser);
    holding.gate.open();
    expect((await removing).status).toBe(204);
    expect(await jsonOf<ProblemBody>(await leaving, 422)).toMatchObject({ code: "company-not-available", pointer: "/companyId" });
    expect(await rowOf(member.id)).toMatchObject({ status: "removed" });
  });

  it.each([
    ["deactivation", "inactive"],
    ["disconnect", "invited"],
  ] as const)("a leave that waits for the membership's %s finds the company no longer available, and leaves the member as the change made it", async (change, status) => {
    const member = await newMember(server, { app, owner }, company);
    const session = await sessionIn(server, member.person, company.id);
    // The change holds the membership's row when it waits before its commit.
    const holding = holdingWrites(pool.database, () => true, "commit");
    const racer = signInApp(holding.database, { clock: server.clock });
    const changing = change === "deactivation" ? calls.updateUser(racer, company.session, member.id, { active: false }) : calls.disconnectUserIdentity(racer, company.session, member.id);
    await holding.gate.reached;
    // The leave finds the membership active, and waits for its row.
    const leaving = calls.leaveCompany(server, session, company.id);
    await untilSomeoneWaitsForLock(superuser);
    holding.gate.open();
    expect((await changing).status).toBe(200);
    expect(await jsonOf<ProblemBody>(await leaving, 422)).toMatchObject({ code: "company-not-available", pointer: "/companyId" });
    expect(await rowOf(member.id)).toEqual(
      change === "deactivation" ? { status, user_id: member.person.id, live_user_id: member.person.id } : { status, user_id: null, live_user_id: null },
    );
  });

  it("the last system administrator cannot leave", async () => {
    const alone = await apiCompany(server, { app, owner }, "Testbolaget Ensam AB");
    expect(await jsonOf<ProblemBody>(await calls.leaveCompany(server, alone.session, alone.id), 422)).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "A company needs at least one active system administrator.",
      code: "last-system-administrator",
      data: { companyId: alone.id },
    });
    expect((await rowOf(alone.membership))?.status).toBe("active");
    // Beside a second one, the owner leaves.
    const admin = await newMember(server, { app, owner }, alone);
    expect((await calls.updateUser(server, alone.session, admin.id, { adminLevel: "admin" })).status).toBe(200);
    expect((await calls.leaveCompany(server, alone.session, alone.id)).status).toBe(204);
    expect((await rowOf(alone.membership))?.status).toBe("left");
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
