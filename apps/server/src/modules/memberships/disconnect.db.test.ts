// SPDX-License-Identifier: AGPL-3.0-only

// M6 (issue 12, The login identity 12, Users in a company 2 and 3): a
// system administrator disconnects a member's identity and sends a new
// invitation, to help a person who lost their way in. After
// disconnectUserIdentity the old identity no longer reaches the company: its
// session is refused on the next request, also once the next identity has
// accepted, and the company is not in its list. The membership goes back to
// invited, with no person (the transitions of the memberships' rules), and
// keeps its admin level and programs, which the identity that accepts the
// new invitation gets: a new identity or an existing one. The old person's
// work contacts are erased, and the new invitation goes to the work e-mail.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
  MINUTE,
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
} from "../../../test/sign-in.ts";
import { apiCompany, calls, joinWith, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";

describe("disconnecting a member's identity", () => {
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

  async function rowOf(id: string): Promise<{ status: string; user_id: string | null; live_user_id: string | null; admin_level: string | null } | undefined> {
    const found = await superuser.query<{ status: string; user_id: string | null; live_user_id: string | null; admin_level: string | null }>(
      "SELECT status, user_id, live_user_id, admin_level FROM access.memberships WHERE id = $1",
      [id],
    );
    return found.rows[0];
  }

  /** A member with a work e-mail of their own, a program and the admin level, and a session that works in the company. */
  async function aMember(workEmail: string): Promise<{ member: TestMember; session: string }> {
    const member = await newMember(server, { app, owner }, company);
    expect((await calls.updateUser(server, company.session, member.id, { workEmail, workPhone: "070-111 22 33", adminLevel: "admin" })).status).toBe(200);
    expect((await calls.assignProgram(server, company.session, member.id, "read")).status).toBe(200);
    return { member, session: await sessionIn(server, member.person, company.id) };
  }

  it("the old identity no longer reaches the company, and the member is invited again", async () => {
    const { member, session } = await aMember("bo.arbete@example.com");
    expect((await getAs(server, session, "/v1/company")).status).toBe(200);
    const response = await calls.disconnectUserIdentity(server, company.session, member.id);
    const disconnected = await jsonOf(response);
    expect(disconnected).toEqual({
      id: member.id,
      companyId: company.id,
      name: "Alva Berg",
      status: "invited",
      adminLevel: "admin",
      idleTimeout: 120,
      roles: ["admin", "viewer"],
      programs: [expect.objectContaining({ program: "read", full: true }) as unknown],
      programsAdministered: [],
    });
    expect(await rowOf(member.id)).toEqual({ status: "invited", user_id: null, live_user_id: null, admin_level: "admin" });
    // The session is refused on its next request, the company cannot be chosen, and it is in no list.
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    server.clock.advance(MINUTE);
    const fresh = await signIn(server, member.person);
    expect(await jsonOf<ProblemBody>(await chooseCompany(server, fresh.session, company.id), 422)).toMatchObject({ code: "company-not-available" });
    const listed = await jsonOf<{ items: unknown[] }>(await getAs(server, fresh.session, "/v1/companies"));
    expect(listed.items).toEqual([]);
    // The old person's work contacts are erased, and the new invitation went to the work e-mail.
    expect((await superuser.query("SELECT 1 FROM access.membership_contacts WHERE membership_id = $1", [member.id])).rows).toEqual([]);
    expect(server.mail.lastTo("bo.arbete@example.com").subject).toBe("Inbjudan till Testbolaget Alfa AB i NortFox");
    const shown = await jsonOf<{ name: string; email: string }>(await calls.getInvitation(server, server.mail.invitationTokenTo("bo.arbete@example.com")));
    expect(shown).toMatchObject({ name: "Alva Berg", email: "bo.arbete@example.com" });
    // The behandlingshistorik holds the disconnect, by the system administrator.
    const history = await superuser.query<{ actor_id: string; old_user: string; new_user: string | null; status: string }>(
      `SELECT actor_id, old_values->>'user_id' AS old_user, new_values->>'user_id' AS new_user, new_values->>'status' AS status
       FROM audit.history WHERE table_name = 'access.memberships' AND row_id = $1 ORDER BY id DESC LIMIT 1`,
      [member.id],
    );
    expect(history.rows).toEqual([{ actor_id: company.creator.id, old_user: member.person.id, new_user: null, status: "invited" }]);
  });

  it("a new identity accepts the new invitation, and gets the member's rights", async () => {
    const { member, session } = await aMember("cilla.arbete@example.com");
    expect((await calls.disconnectUserIdentity(server, company.session, member.id)).status).toBe(200);
    const token = server.mail.invitationTokenTo("cilla.arbete@example.com");
    const accepted = await jsonOf<{ user: { id: string; email: string }; membership: { id: string; adminLevel: string; programs: { program: string }[]; workEmail: string } }>(
      await calls.acceptInvitation(server, token, { newIdentity: { name: "Cilla Ny", password: "cillas-lösenord" } }),
    );
    expect(accepted.user.email).toBe("cilla.arbete@example.com");
    expect(accepted.membership).toMatchObject({ id: member.id, adminLevel: "admin", workEmail: "cilla.arbete@example.com" });
    expect(accepted.membership.programs.map((grant) => grant.program)).toEqual(["read"]);
    expect(await rowOf(member.id)).toEqual({ status: "active", user_id: accepted.user.id, live_user_id: accepted.user.id, admin_level: "admin" });
    // The old identity's session stays refused.
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
  });

  it("an existing identity accepts the new invitation", async () => {
    const { member, session } = await aMember("dan.arbete@example.com");
    expect((await calls.disconnectUserIdentity(server, company.session, member.id)).status).toBe(200);
    const next = await addSignInIdentity(owner);
    expect(await joinWith(server, next, server.mail.invitationTokenTo("dan.arbete@example.com"))).toBe(member.id);
    expect(await rowOf(member.id)).toEqual({ status: "active", user_id: next.id, live_user_id: next.id, admin_level: "admin" });
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    // The next identity works in the company.
    const nextSession = await sessionIn(server, next, company.id);
    expect((await getAs(server, nextSession, "/v1/company")).status).toBe(200);
  });

  it("disconnects an inactive member", async () => {
    const { member } = await aMember("eva.arbete@example.com");
    expect((await calls.updateUser(server, company.session, member.id, { active: false })).status).toBe(200);
    expect((await calls.disconnectUserIdentity(server, company.session, member.id)).status).toBe(200);
    expect(await rowOf(member.id)).toEqual({ status: "invited", user_id: null, live_user_id: null, admin_level: "admin" });
  });

  it("refuses an invited member, one the company does not have, and the last system administrator", async () => {
    const invited = await jsonOf<{ id: string }>(await calls.inviteUser(server, company.session, { name: "Frida Bjuden", email: "frida.bjuden@example.com" }), 201);
    expect(await jsonOf<ProblemBody>(await calls.disconnectUserIdentity(server, company.session, invited.id), 422)).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "The member has not accepted the invitation yet, so no identity is connected.",
      code: "user-invited",
      pointer: "/memberId",
    });
    expect(await jsonOf<ProblemBody>(await calls.disconnectUserIdentity(server, company.session, "00000000-0000-4000-8000-000000000000"), 422)).toMatchObject({
      code: "user-not-found",
    });
    const alone = await apiCompany(server, { app, owner }, "Testbolaget Ensam AB");
    expect(await jsonOf<ProblemBody>(await calls.disconnectUserIdentity(server, alone.session, alone.membership), 422)).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "A company needs at least one active system administrator.",
      code: "last-system-administrator",
      data: { companyId: alone.id },
    });
    expect((await rowOf(alone.membership))?.status).toBe("active");
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
