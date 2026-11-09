// SPDX-License-Identifier: AGPL-3.0-only

// M8 (issue 12, "Users in a company" 5; What the law requires: a removed
// member stays the actor on every entry). "Ta bort användaren" needs a
// system administrator and never works on yourself. The member's row stays,
// with the status removed, and their session is refused on the next request,
// also after they accept a new invitation, which makes a new membership.
// The removed member's work contacts are erased. This is the session half:
// API tokens (part 4) and MCP tokens (part 5) extend this file.
//
// The new invitation is made and accepted as the database holds it: the
// invitations come in the next step of this part, which then makes it
// through inviteUser and acceptInvitation.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { acceptedMember, addMembership } from "../../../test/memberships.ts";
import {
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signInApp,
  testClock,
  writeAs,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany } from "../../../test/users.ts";

describe("removing a member", () => {
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
    server = signInApp(pool.database, { clock: testClock() });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function statusOf(id: string): Promise<{ status: string; user_id: string | null; live_user_id: string | null } | undefined> {
    return (await superuser.query<{ status: string; user_id: string | null; live_user_id: string | null }>("SELECT status, user_id, live_user_id FROM access.memberships WHERE id = $1", [id]))
      .rows[0];
  }

  it("needs a system administrator", async () => {
    const target = await newMember({ app, owner }, company);
    const programAdmin = await newMember({ app, owner }, company);
    await calls.updateUser(server, company.session, programAdmin.id, { programsAdministered: [{ program: "bookkeeping" }] });
    const plain = await newMember({ app, owner }, company);
    for (const actor of [programAdmin, plain]) {
      const session = await sessionIn(server, actor.person, company.id);
      expect(await jsonOf<ProblemBody>(await calls.removeUser(server, session, target.id), 403)).toMatchObject({ code: "permission-missing", permission: "users:admin" });
    }
    expect((await statusOf(target.id))?.status).toBe("active");
    // A member made system administrator removes from their next choice of the company.
    const admin = await newMember({ app, owner }, company);
    await calls.updateUser(server, company.session, admin.id, { adminLevel: "admin" });
    expect((await calls.removeUser(server, await sessionIn(server, admin.person, company.id), target.id)).status).toBe(204);
    expect((await statusOf(target.id))?.status).toBe("removed");
  });

  it("never works on yourself", async () => {
    const problem = await jsonOf<ProblemBody>(await calls.removeUser(server, company.session, company.membership), 422);
    expect(problem).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "A system administrator cannot remove themselves.",
      code: "cannot-remove-yourself",
      pointer: "/memberId",
    });
    // Not even beside another system administrator.
    const admin = await newMember({ app, owner }, company);
    await calls.updateUser(server, company.session, admin.id, { adminLevel: "admin" });
    const session = await sessionIn(server, admin.person, company.id);
    expect(await jsonOf<ProblemBody>(await calls.removeUser(server, session, admin.id), 422)).toMatchObject({ code: "cannot-remove-yourself" });
    expect((await statusOf(admin.id))?.status).toBe("active");
    expect((await statusOf(company.membership))?.status).toBe("active");
  });

  it("the row stays with status removed, its work contacts are erased, and no user operation finds it", async () => {
    const target = await newMember({ app, owner }, company);
    await calls.updateUser(server, company.session, target.id, { workEmail: "hedda.arbete@example.com", workPhone: "070-174 06 12" });
    await calls.assignProgram(server, company.session, target.id, "read");
    expect((await calls.removeUser(server, company.session, target.id)).status).toBe(204);
    expect(await statusOf(target.id)).toEqual({ status: "removed", user_id: target.person.id, live_user_id: null });
    const contacts = await superuser.query("SELECT 1 FROM access.membership_contacts WHERE membership_id = $1", [target.id]);
    expect(contacts.rows).toEqual([]);
    expect(await jsonOf<ProblemBody>(await calls.getUser(server, company.session, target.id), 422)).toMatchObject({ code: "user-not-found" });
    expect(await jsonOf<ProblemBody>(await calls.removeUser(server, company.session, target.id), 422)).toMatchObject({ code: "user-not-found", pointer: "/memberId" });
    const listed = await jsonOf<{ items: { id: string }[] }>(await calls.listUsers(server, company.session));
    expect(listed.items.map((item) => item.id)).not.toContain(target.id);
    // The removal is in the behandlingshistorik, with its actor.
    const history = await superuser.query<{ status: string; actor_id: string }>(
      `SELECT new_values->>'status' AS status, actor_id FROM audit.history WHERE table_name = 'access.memberships' AND row_id = $1 AND operation = 'UPDATE' ORDER BY id DESC LIMIT 1`,
      [target.id],
    );
    expect(history.rows).toEqual([{ status: "removed", actor_id: company.creator.id }]);
    // A repeat with the same key gives the first answer.
    const again = await newMember({ app, owner }, company);
    const key = "remove-again-once";
    expect((await calls.removeUser(server, company.session, again.id, key)).status).toBe(204);
    expect((await calls.removeUser(server, company.session, again.id, key)).status).toBe(204);
  });

  it("removes an invited member", async () => {
    const invited = await addMembership(app, owner, company, { status: "invited" });
    expect((await calls.removeUser(server, company.session, invited)).status).toBe(204);
    expect((await statusOf(invited))?.status).toBe("removed");
  });

  it("their session is refused on the next request, also after a new invitation is accepted", async () => {
    const target = await newMember({ app, owner }, company);
    const session = await sessionIn(server, target.person, company.id);
    expect((await getAs(server, session, "/v1/company")).status).toBe(200);
    expect((await calls.removeUser(server, company.session, target.id)).status).toBe(204);
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    // Invited again, and accepted: a new membership, active, and the old one stays removed.
    const renewed = await acceptedMember(app, owner, company, target.person.id);
    expect(renewed).not.toBe(target.id);
    expect(await statusOf(renewed)).toEqual({ status: "active", user_id: target.person.id, live_user_id: target.person.id });
    expect((await statusOf(target.id))?.status).toBe("removed");
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    expect((await writeAs(server, session, "PATCH", `/v1/me/companies/${company.id}`, { idleTimeout: 30 })).status).toBe(401);
    // A new session works with the new membership.
    const next = await sessionIn(server, target.person, company.id);
    const me = await jsonOf<{ membership: { id: string; status: string } }>(await getAs(server, next, "/v1/me"));
    expect(me.membership).toMatchObject({ id: renewed, status: "active" });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
