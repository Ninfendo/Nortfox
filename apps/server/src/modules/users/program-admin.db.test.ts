// SPDX-License-Identifier: AGPL-3.0-only

// R4 (issue 12, "Roles, admin levels, programs and permissions" 3): a
// program administrator is set per program. They grant, narrow, move and
// remove that program, its Rapporter and its Register/Övrigt rights, and see
// only those programs. They cannot appoint any admin, a system
// administrator or a program administrator, and do not run the users.
//
// A system administrator appoints them with updateUser. A program
// administrator holds users:read and programs:grant from their next choice
// of the company, as every permission does (R11); which programs they reach
// is read on every request, so a program taken from them is out of reach at
// once.

import { fullPermissions, type ProgramGrant } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
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
  readonly roles: string[];
  readonly programs: ProgramGrant[];
  readonly programsAdministered: { program: string }[];
  readonly adminLevel?: string;
}

describe("a program administrator", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;
  /** The administrator of Bokföring, and their session, which chose the company after the appointment. */
  let administrator: TestMember;
  let session: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner });
    administrator = await newMember(server, { app, owner }, company);
    const appointed = await jsonOf<MemberJson>(await calls.updateUser(server, company.session, administrator.id, { programsAdministered: [{ program: "bookkeeping" }] }));
    expect(appointed.programsAdministered).toEqual([{ program: "bookkeeping" }]);
    session = await sessionIn(server, administrator.person, company.id);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  function member(): Promise<TestMember> {
    return newMember(server, { app, owner }, company);
  }

  async function programsOf(membership: string): Promise<{ program: string; permissions: string[] }[]> {
    return (await superuser.query<{ program: string; permissions: string[] }>("SELECT program, permissions FROM access.program_grants WHERE membership_id = $1 ORDER BY program", [membership]))
      .rows;
  }

  /** The refusal of a program that the administrator does not administer. */
  const OUTSIDE = {
    type: "about:blank",
    title: "Unprocessable Content",
    status: 422,
    detail: "A program administrator grants only the programs they administer.",
    code: "program-not-administered",
    pointer: "/program",
    data: { program: "auditor" },
  };

  it("holds users:read and programs:grant, and no system administrator's permission", async () => {
    const me = await jsonOf<{ permissions: string[]; membership: MemberJson }>(await getAs(server, session, "/v1/me"));
    expect(me.permissions).toEqual(["company:read", "programs:grant", "users:read"]);
    expect(me.membership).toMatchObject({ programsAdministered: [{ program: "bookkeeping" }], roles: [] });
  });

  it("grants only inside their programs", async () => {
    const target = await member();
    const other = await member();
    // Inside: grant, narrow, move and remove Bokföring.
    expect(await jsonOf<ProgramGrant>(await calls.assignProgram(server, session, target.id, "bookkeeping"))).toMatchObject({ permissions: fullPermissions("bookkeeping"), full: true });
    expect((await jsonOf<ProgramGrant>(await calls.assignProgram(server, session, target.id, "bookkeeping", { permissions: ["vouchers.view"] }))).permissions).toEqual(["vouchers.view"]);
    expect((await calls.moveProgram(server, session, target.id, "bookkeeping", { targetMemberId: other.id })).status).toBe(200);
    expect((await calls.removeProgram(server, session, other.id, "bookkeeping")).status).toBe(204);
    // Outside: Revisor, which the system administrator grants.
    expect(await jsonOf<ProblemBody>(await calls.assignProgram(server, session, target.id, "auditor"), 422)).toEqual(OUTSIDE);
    expect((await calls.assignProgram(server, company.session, target.id, "auditor")).status).toBe(200);
    expect(await jsonOf<ProblemBody>(await calls.removeProgram(server, session, target.id, "auditor"), 422)).toEqual(OUTSIDE);
    expect(await jsonOf<ProblemBody>(await calls.moveProgram(server, session, target.id, "auditor", { targetMemberId: other.id }), 422)).toEqual(OUTSIDE);
    expect(await programsOf(target.id)).toEqual([{ program: "auditor", permissions: fullPermissions("auditor") }]);
    expect(await programsOf(other.id)).toEqual([]);
  });

  it("sets the Rapporter and Register/Övrigt rights only in the grants of their programs", async () => {
    const target = await member();
    await calls.assignProgram(server, company.session, target.id, "read");
    await calls.assignProgram(server, session, target.id, "bookkeeping", { permissions: ["vouchers.view", "reports.vat"] });
    const rights = await jsonOf<{ permissions: string[]; programs: ProgramGrant[] }>(await calls.updateUserRights(server, session, target.id, ["register.projects", "reports.general-ledger"]));
    expect(rights.permissions).toEqual(["reports.general-ledger", "register.projects"]);
    expect(rights.programs.map((grant) => [grant.program, grant.permissions])).toEqual([["bookkeeping", ["vouchers.view", "reports.general-ledger", "register.projects"]]]);
    // The Läs grant, outside their reach, keeps its own.
    expect(await programsOf(target.id)).toEqual([
      { program: "bookkeeping", permissions: ["vouchers.view", "reports.general-ledger", "register.projects"] },
      { program: "read", permissions: fullPermissions("read") },
    ]);
    // A member who holds only programs outside their reach has no grant that covers a right.
    const outsider = await member();
    await calls.assignProgram(server, company.session, outsider.id, "read");
    const uncovered = await jsonOf<ProblemBody>(await calls.updateUserRights(server, session, outsider.id, ["reports.vat"]), 422);
    expect(uncovered).toMatchObject({ code: "right-not-covered", pointer: "/permissions/0", data: { permission: "reports.vat" } });
    expect(await programsOf(outsider.id)).toEqual([{ program: "read", permissions: fullPermissions("read") }]);
  });

  it("sees only their programs in listUsers and getUser", async () => {
    const target = await member();
    await calls.assignProgram(server, company.session, target.id, "read");
    await calls.assignProgram(server, company.session, target.id, "bookkeeping");
    await calls.updateUser(server, company.session, target.id, { programsAdministered: [{ program: "read" }, { program: "bookkeeping" }] });
    const seen = await jsonOf<MemberJson>(await calls.getUser(server, session, target.id));
    expect(seen.programs.map((grant) => grant.program)).toEqual(["bookkeeping"]);
    expect(seen.programsAdministered).toEqual([{ program: "bookkeeping" }]);
    // The roles are those of the programs seen: the bookkeeper, not the viewer.
    expect(seen.roles).toEqual(["bookkeeper"]);
    const all = await jsonOf<MemberJson>(await calls.getUser(server, company.session, target.id));
    expect(all.programs.map((grant) => grant.program)).toEqual(["bookkeeping", "read"]);
    expect(all.roles).toEqual(["bookkeeper", "viewer"]);
    const listed = await jsonOf<{ items: MemberJson[] }>(await calls.listUsers(server, session));
    const item = listed.items.find((each) => each.id === target.id);
    expect(item).toEqual(seen);
    // The system administrator's level stays in view.
    expect(listed.items.find((each) => each.id === company.membership)).toMatchObject({ adminLevel: "owner", roles: ["owner"] });
  });

  it("cannot make anyone an admin, and does not run the users", async () => {
    const target = await member();
    const before = await jsonOf<MemberJson>(await calls.getUser(server, company.session, target.id));
    for (const body of [{ adminLevel: "admin" }, { programsAdministered: [{ program: "bookkeeping" }] }, { active: false }, { idleTimeout: 15 }]) {
      expect(await jsonOf<ProblemBody>(await calls.updateUser(server, session, target.id, body), 403), JSON.stringify(body)).toMatchObject({
        code: "permission-missing",
        permission: "users:admin",
      });
    }
    // Not even themselves.
    expect(await jsonOf<ProblemBody>(await calls.updateUser(server, session, administrator.id, { programsAdministered: [{ program: "auditor" }] }), 403)).toMatchObject({
      permission: "users:admin",
    });
    expect(await jsonOf<ProblemBody>(await calls.removeUser(server, session, target.id), 403)).toMatchObject({ permission: "users:admin" });
    expect(await jsonOf<ProblemBody>(await calls.updateCompany(server, session, { name: "Testbolaget Beta AB" }), 403)).toMatchObject({ permission: "company:update" });
    expect(await jsonOf<MemberJson>(await calls.getUser(server, company.session, target.id))).toEqual(before);
  });

  it("reaches no program once the system administrator takes the last one away, also in the session that chose before", async () => {
    const target = await member();
    await calls.updateUser(server, company.session, administrator.id, { programsAdministered: [] });
    const outside = await jsonOf<ProblemBody>(await calls.assignProgram(server, session, target.id, "bookkeeping"), 422);
    expect(outside).toMatchObject({ code: "program-not-administered", data: { program: "bookkeeping" } });
    // The next choice of the company holds neither permission.
    const next = await sessionIn(server, administrator.person, company.id);
    expect(await jsonOf<ProblemBody>(await calls.assignProgram(server, next, target.id, "bookkeeping"), 403)).toMatchObject({ permission: "programs:grant" });
    expect(await jsonOf<ProblemBody>(await calls.listUsers(server, next), 403)).toMatchObject({ permission: "users:read" });
    expect(await programsOf(target.id)).toEqual([]);
    await calls.updateUser(server, company.session, administrator.id, { programsAdministered: [{ program: "bookkeeping" }] });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
