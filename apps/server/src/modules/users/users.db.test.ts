// SPDX-License-Identifier: AGPL-3.0-only

// The company's users (issue 12, "Users in a company" and "Roles, admin
// levels, programs and permissions" 2): listUsers and getUser give the
// company's invited, active and inactive members, each with the person's
// name, which the people of a company give (access.company_people, never
// the personnummer or the mobile number), the status, the admin level, the
// idle logout, the work contacts and the programs. A system administrator
// changes a member with updateUser: Aktiv användare, the admin level, the
// programs administered, the idle logout, its value checked as M11 says, by
// the API and by the database, and the work contacts. A member who is no
// system administrator runs none of it. Deactivating, removing and the last
// system administrator have their own files (deactivate, remove and
// last-system-administrator in modules/memberships).

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { CHECK_VIOLATION, expectError, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { PERSONAL_IDENTITY_NUMBERS } from "../../../test/identities.ts";
import { acceptedMember, addMembership, aCompany, asMember, membershipIn } from "../../../test/memberships.ts";
import {
  HOUR,
  MINUTE,
  addSignInIdentity,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signInApp,
  testClock,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";

interface MemberJson {
  readonly id: string;
  readonly companyId: string;
  readonly userId?: string;
  readonly name?: string;
  readonly status: string;
  readonly adminLevel?: string;
  readonly idleTimeout: number;
  readonly workEmail?: string;
  readonly workPhone?: string;
  readonly roles: string[];
  readonly programs: unknown[];
  readonly programsAdministered: { program: string }[];
}

interface Page {
  readonly items: MemberJson[];
  readonly total: number;
  readonly nextCursor?: string;
}

describe("the company's users", () => {
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

  function member(): Promise<TestMember> {
    return newMember({ app, owner }, company);
  }

  async function membershipRow(id: string): Promise<{ status: string; admin_level: string | null; idle_timeout_minutes: number }> {
    const found = await superuser.query<{ status: string; admin_level: string | null; idle_timeout_minutes: number }>(
      "SELECT status, admin_level, idle_timeout_minutes FROM access.memberships WHERE id = $1",
      [id],
    );
    const [row] = found.rows;
    if (row === undefined) {
      throw new Error("No such membership.");
    }
    return row;
  }

  describe("listUsers and getUser", () => {
    it("give each member with the person's name from the people of the company, and never the personnummer or the mobile number", async () => {
      const company2 = await apiCompany(server, { app, owner }, "Testbolaget Beta AB");
      const person = await addSignInIdentity(owner, { personalIdentityNumber: PERSONAL_IDENTITY_NUMBERS[0] });
      await owner.query("UPDATE access.identities SET name = 'Elsa Fors', mobile = '070-174 06 14' WHERE id = $1", [person.id]);
      const joined = await acceptedMember(app, owner, company2, person.id);
      const invited = await addMembership(app, owner, company2, { status: "invited" });
      const page = await jsonOf<Page>(await calls.listUsers(server, company2.session));
      expect(page.total).toBe(3);
      expect(page.items.map((item) => [item.id, item.name, item.status])).toEqual([
        [company2.membership, "Alva Berg", "active"],
        [joined, "Elsa Fors", "active"],
        [invited, undefined, "invited"],
      ]);
      expect(page.items[0]).toEqual({
        id: company2.membership,
        companyId: company2.id,
        userId: company2.creator.id,
        name: "Alva Berg",
        status: "active",
        adminLevel: "owner",
        idleTimeout: 120,
        workEmail: company2.creator.email,
        roles: ["owner"],
        programs: [],
        programsAdministered: [],
      });
      expect(await jsonOf<MemberJson>(await calls.getUser(server, company2.session, joined))).toEqual(page.items[1]);
      const text = JSON.stringify(page);
      expect(text).not.toContain(PERSONAL_IDENTITY_NUMBERS[0]);
      expect(text).not.toContain("070-174 06 14");
      expect(text).not.toContain(person.email);
    });

    it("list the invited, active and inactive members in the order they were added, and leave out the removed and the left", async () => {
      const company3 = await apiCompany(server, { app, owner }, "Testbolaget Gamma AB");
      const inactive = await membershipIn(app, owner, company3, "inactive");
      const removed = await membershipIn(app, owner, company3, "removed");
      const left = await membershipIn(app, owner, company3, "left");
      const invited = await membershipIn(app, owner, company3, "invited");
      const page = await jsonOf<Page>(await calls.listUsers(server, company3.session));
      expect(page.items.map((item) => [item.id, item.status])).toEqual([
        [company3.membership, "active"],
        [inactive.id, "inactive"],
        [invited.id, "invited"],
      ]);
      expect(page.total).toBe(3);
      for (const id of [removed.id, left.id]) {
        expect(await jsonOf<ProblemBody>(await calls.getUser(server, company3.session, id), 422)).toEqual({
          type: "about:blank",
          title: "Unprocessable Content",
          status: 422,
          detail: "The company has no invited, active or inactive member with the id that memberId names.",
          code: "user-not-found",
          pointer: "/memberId",
        });
      }
    });

    it("give pages that hold each member once, and refuse a cursor of another company's list", async () => {
      const company4 = await apiCompany(server, { app, owner }, "Testbolaget Delta AB");
      for (let made = 0; made < 4; made += 1) {
        await membershipIn(app, owner, company4, "active");
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let first: string | undefined;
      do {
        const page = await jsonOf<Page>(await calls.listUsers(server, company4.session, `?limit=2${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`));
        expect(page.total).toBe(5);
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        first ??= cursor;
      } while (cursor !== undefined);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      const wrong = await jsonOf<ProblemBody>(await calls.listUsers(server, company.session, `?cursor=${encodeURIComponent(first ?? "")}`), 400);
      expect(wrong.errors?.[0]?.code).toBe("cursor-invalid");
    });

    it("find no member of another company, and no id that is not there", async () => {
      const other = await aCompany(app, "Testbolaget Epsilon AB");
      for (const id of [other.membership, randomUUID()]) {
        expect(await jsonOf<ProblemBody>(await calls.getUser(server, company.session, id), 422)).toMatchObject({ code: "user-not-found", pointer: "/memberId" });
      }
      const page = await jsonOf<Page>(await calls.listUsers(server, company.session));
      expect(page.items.map((item) => item.companyId).every((id) => id === company.id)).toBe(true);
      expect((await jsonOf<ProblemBody>(await calls.getUser(server, company.session, "medlem-ett"), 400)).errors?.[0]).toMatchObject({ code: "bad-format", pointer: "/memberId" });
    });

    it("need users:read: a plain member is refused", async () => {
      const plain = await member();
      const session = await sessionIn(server, plain.person, company.id);
      expect(await jsonOf<ProblemBody>(await calls.listUsers(server, session), 403)).toMatchObject({ code: "permission-missing", permission: "users:read" });
      expect(await jsonOf<ProblemBody>(await calls.getUser(server, session, plain.id), 403)).toMatchObject({ code: "permission-missing", permission: "users:read" });
    });
  });

  describe("updateUser", () => {
    it("makes a member system administrator and no longer one, and keeps the owner's level", async () => {
      const target = await member();
      expect(await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, { adminLevel: "admin" }))).toMatchObject({ adminLevel: "admin", roles: ["admin"] });
      expect((await membershipRow(target.id)).admin_level).toBe("admin");
      const demoted = await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, { adminLevel: null }));
      expect(demoted.adminLevel).toBeUndefined();
      expect(demoted.roles).toEqual([]);
      // admin keeps the owner's level, which only creating a company gives.
      expect((await jsonOf<MemberJson>(await calls.updateUser(server, company.session, company.membership, { adminLevel: "admin" }))).adminLevel).toBe("owner");
      expect((await membershipRow(company.membership)).admin_level).toBe("owner");
      const owner = await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, target.id, { adminLevel: "owner" }), 400);
      expect(owner.errors).toEqual([{ code: "invalid-value", detail: 'The field /adminLevel must be one of: "admin".', pointer: "/adminLevel", data: { allowed: ["admin"] } }]);
    });

    it("sets the programs a member administers, the whole list", async () => {
      const target = await member();
      const set = await jsonOf<MemberJson>(
        await calls.updateUser(server, company.session, target.id, { programsAdministered: [{ program: "auditor" }, { program: "bookkeeping" }, { program: "auditor" }] }),
      );
      expect(set.programsAdministered).toEqual([{ program: "bookkeeping" }, { program: "auditor" }]);
      const changed = await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, { programsAdministered: [{ program: "read" }, { program: "bookkeeping" }] }));
      expect(changed.programsAdministered).toEqual([{ program: "bookkeeping" }, { program: "read" }]);
      const rows = await superuser.query<{ program: string }>("SELECT program FROM access.program_admins WHERE membership_id = $1 ORDER BY program", [target.id]);
      expect(rows.rows.map((row) => row.program)).toEqual(["bookkeeping", "read"]);
      expect((await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, { programsAdministered: [] }))).programsAdministered).toEqual([]);
      const unknown = await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, target.id, { programsAdministered: [{ program: "payroll" }] }), 400);
      expect(unknown.errors?.[0]).toMatchObject({ code: "invalid-value", pointer: "/programsAdministered/0/program" });
    });

    it("sets the idle logout, as M11 says: only the five values, by the API and by the database", async () => {
      const target = await member();
      for (const idleTimeout of [15, 30, 60, 480, 120] as const) {
        expect((await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, { idleTimeout }))).idleTimeout).toBe(idleTimeout);
        expect((await membershipRow(target.id)).idle_timeout_minutes).toBe(idleTimeout);
      }
      for (const idleTimeout of [14, 481, 45, 0, 600]) {
        const problem = await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, target.id, { idleTimeout }), 400);
        expect(problem.errors?.map((error) => [error.code, error.pointer])).toEqual([["invalid-value", "/idleTimeout"]]);
      }
      await expectError(
        asMember(app, company.id, company.asOwner, "UPDATE access.memberships SET idle_timeout_minutes = 45 WHERE id = $1", [target.id]),
        CHECK_VIOLATION,
        /memberships_idle_timeout_known/,
      );
      expect((await membershipRow(target.id)).idle_timeout_minutes).toBe(120);
    });

    it("ends the member's session after the idle logout it sets, and holds a raise of one's own from the next request", async () => {
      const target = await member();
      const session = await sessionIn(server, target.person, company.id);
      expect((await calls.updateUser(server, company.session, target.id, { idleTimeout: 15 })).status).toBe(200);
      server.clock.advance(16 * MINUTE);
      expect((await getAs(server, session, "/v1/me")).status).toBe(401);
      // A system administrator's raise of their own idle logout holds for the session that made it.
      const admin = await member();
      await calls.updateUser(server, company.session, admin.id, { adminLevel: "admin", idleTimeout: 15 });
      const adminSession = await sessionIn(server, admin.person, company.id);
      expect((await calls.updateUser(server, adminSession, admin.id, { idleTimeout: 480 })).status).toBe(200);
      server.clock.advance(20 * MINUTE);
      expect((await getAs(server, adminSession, "/v1/me")).status).toBe(200);
      server.clock.advance(7 * HOUR);
      expect((await getAs(server, adminSession, "/v1/me")).status).toBe(200);
      // The owner's session made no request for more than its two hours, so it has ended too, and the owner signs in again.
      expect((await getAs(server, company.session, "/v1/me")).status).toBe(401);
      company = { ...company, session: await sessionIn(server, company.creator, company.id) };
    });

    it("turns Aktiv användare off and on, and refuses it for an invited member", async () => {
      const target = await member();
      expect((await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, { active: false }))).status).toBe("inactive");
      expect((await membershipRow(target.id)).status).toBe("inactive");
      // Off again changes nothing.
      expect((await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, { active: false }))).status).toBe("inactive");
      expect((await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, { active: true }))).status).toBe("active");
      const invited = await addMembership(app, owner, company, { status: "invited" });
      for (const active of [true, false]) {
        expect(await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, invited, { active }), 422)).toEqual({
          type: "about:blank",
          title: "Unprocessable Content",
          status: 422,
          detail: "The member has not accepted the invitation yet, so Aktiv användare cannot be set.",
          code: "user-invited",
          pointer: "/active",
        });
      }
      expect((await membershipRow(invited)).status).toBe("invited");
      // The rest of a change of an invited member is taken.
      expect((await jsonOf<MemberJson>(await calls.updateUser(server, company.session, invited, { idleTimeout: 60 }))).idleTimeout).toBe(60);
    });

    it("changes nothing for an empty change, and writes the admin level, the status and the idle logout in the behandlingshistorik", async () => {
      const target = await member();
      const before = await jsonOf<MemberJson>(await calls.getUser(server, company.session, target.id));
      expect(await jsonOf<MemberJson>(await calls.updateUser(server, company.session, target.id, {}))).toEqual(before);
      await calls.updateUser(server, company.session, target.id, { adminLevel: "admin", idleTimeout: 30, active: false });
      const history = await superuser.query<{ actor_id: string; admin_level: string; status: string; idle: string }>(
        `SELECT actor_id, new_values->>'admin_level' AS admin_level, new_values->>'status' AS status, new_values->>'idle_timeout_minutes' AS idle
         FROM audit.history WHERE table_name = 'access.memberships' AND row_id = $1 AND operation = 'UPDATE' ORDER BY id DESC LIMIT 1`,
        [target.id],
      );
      expect(history.rows).toEqual([{ actor_id: company.creator.id, admin_level: "admin", status: "inactive", idle: "30" }]);
    });

    it("finds no removed or left member, and none of another company", async () => {
      const removed = await membershipIn(app, owner, company, "removed");
      const other = await aCompany(app, "Testbolaget Zeta AB");
      for (const id of [removed.id, other.membership]) {
        expect(await jsonOf<ProblemBody>(await calls.updateUser(server, company.session, id, { idleTimeout: 30 }), 422)).toMatchObject({ code: "user-not-found", pointer: "/memberId" });
      }
      expect((await membershipRow(other.membership)).idle_timeout_minutes).toBe(120);
    });

    it("needs users:admin: a plain member is refused, and nothing changes", async () => {
      const plain = await member();
      const target = await member();
      const session = await sessionIn(server, plain.person, company.id);
      for (const body of [{ adminLevel: "admin" }, { active: false }, { idleTimeout: 15 }, { workPhone: null }]) {
        expect(await jsonOf<ProblemBody>(await calls.updateUser(server, session, target.id, body), 403)).toMatchObject({ code: "permission-missing", permission: "users:admin" });
      }
      // Not their own membership either: that is updateMyMembership.
      expect(await jsonOf<ProblemBody>(await calls.updateUser(server, session, plain.id, { idleTimeout: 15 }), 403)).toMatchObject({ permission: "users:admin" });
      expect(await membershipRow(target.id)).toEqual({ status: "active", admin_level: null, idle_timeout_minutes: 120 });
    });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
