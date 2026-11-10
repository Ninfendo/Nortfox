// SPDX-License-Identifier: AGPL-3.0-only

// R5, R6 and R7 (issue 12, "Roles, admin levels, programs and permissions"
// 3 to 8), and the rest of the program operations, by a system
// administrator through /v1:
//
// - "Tilldela program" (assignProgram) preselects "Full behörighet": every
//   permission of the program and its Rapporter and Register/Övrigt rights,
//   and never a manual-only right. A list of permissions narrows it. A
//   second grant of a held program replaces its list and keeps its time and
//   its end; a grant that has ended is granted again.
// - An action permission without its group's view permission is refused, by
//   the API with a pointer at the right, and by the database. So is a right
//   that the program's set does not hold.
// - "Ta bort program" (removeProgram) takes the grant away.
// - "Flytta program" (moveProgram) leaves the grant on the target member and
//   none on the source, narrowed first if the list says so.
// - "Anpassa Rapporter" and "Anpassa Register/Övrigt" (updateUserRights) set
//   the member's Rapporter and Register/Övrigt rights in every grant whose
//   program covers them.
//
// The operations reach the company's invited, active and inactive members.
// The server's clock starts at the database's, so a Revisor grant holds.

import { CATALOGUE_PERMISSIONS, fullPermissions, PROGRAMS, type Program, type ProgramGrant } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addMembership, aCompany, changeMembership, membershipIn } from "../../../test/memberships.ts";
import {
  DAY,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  jsonOf,
  signInApp,
  testClock,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";

/** The manual-only rights that this slice builds. */
const MANUAL_ONLY = ["register.anonymise-fiscal-year", "register.removed-users", "register.delete-processing-history"];

interface GrantRow {
  readonly id: string;
  readonly membership_id: string;
  readonly permissions: string[];
  readonly is_full: boolean;
  readonly granted_at: Date;
}

describe("the program grants", () => {
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

  function member(): Promise<TestMember> {
    return newMember(server, { app, owner }, company);
  }

  async function grantsOf(membership: string): Promise<(GrantRow & { program: string })[]> {
    return (
      await superuser.query<GrantRow & { program: string }>(
        "SELECT id, membership_id, program, permissions, is_full, granted_at FROM access.program_grants WHERE membership_id = $1 ORDER BY program",
        [membership],
      )
    ).rows;
  }

  async function assigned(membership: string, program: Program, body: unknown = { full: true }): Promise<ProgramGrant> {
    return jsonOf<ProgramGrant>(await calls.assignProgram(server, company.session, membership, program, body));
  }

  it.each(PROGRAMS)("Full behörighet gives the program's set and never a manual-only right: %s", async (program) => {
    const { person, id } = await member();
    const grant = await assigned(id, program);
    expect(grant).toMatchObject({ program, permissions: fullPermissions(program), full: true });
    expect(grant.expiresAt === undefined).toBe(program !== "auditor");
    for (const permission of MANUAL_ONLY) {
      expect(grant.permissions).not.toContain(permission);
    }
    expect(await grantsOf(id)).toMatchObject([{ program, permissions: fullPermissions(program), is_full: true }]);
    // The member's next session holds them.
    const session = await sessionIn(server, person, company.id);
    const me = await jsonOf<{ permissions: string[] }>(await getAs(server, session, "/v1/me"));
    expect(me.permissions).toEqual(["company:read", "tokens:own", ...fullPermissions(program)].sort());
  });

  it("refuses an action permission without its group's view permission, by the API and by the database", async () => {
    const { id } = await member();
    const alone = await jsonOf<ProblemBody>(await calls.assignProgram(server, company.session, id, "bookkeeping", { permissions: ["vouchers.book"] }), 422);
    expect(alone).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "An action right needs the view right of its group.",
      code: "view-permission-missing",
      pointer: "/permissions/0",
      data: { permission: "vouchers.book", view: "vouchers.view" },
    });
    const other = await jsonOf<ProblemBody>(
      await calls.assignProgram(server, company.session, id, "bookkeeping", { permissions: ["vouchers.view", "reports.vat", "supplier-invoices.book"] }),
      422,
    );
    expect(other).toMatchObject({ code: "view-permission-missing", pointer: "/permissions/2", data: { permission: "supplier-invoices.book", view: "supplier-invoices.view" } });
    expect(await grantsOf(id)).toEqual([]);
    await expectRefusal(
      inTransaction(app, { company: company.id, ...company.asOwner, channel: "rest" }, () =>
        app.query("INSERT INTO access.program_grants (company_id, membership_id, program, permissions) VALUES ($1, $2, 'bookkeeping', ARRAY['vouchers.book'])", [company.id, id]),
      ),
      "view_permission_missing",
      { permission: "vouchers.book", view: "vouchers.view" },
    );
  });

  it("refuses a right that the program's set does not hold, with its pointer, and a key the catalogue does not know", async () => {
    const { id } = await member();
    const outside = await jsonOf<ProblemBody>(await calls.assignProgram(server, company.session, id, "read", { permissions: ["vouchers.view", "vouchers.book"] }), 422);
    expect(outside).toMatchObject({ code: "not-in-program", detail: "The program does not hold that right.", pointer: "/permissions/1", data: { permission: "vouchers.book", program: "read" } });
    const unknown = await jsonOf<ProblemBody>(await calls.assignProgram(server, company.session, id, "read", { permissions: ["vouchers.fly"] }), 400);
    expect(unknown.errors?.map((error) => [error.code, error.pointer])).toEqual([["invalid-value", "/permissions/0"]]);
    const program = await jsonOf<ProblemBody>(await calls.assignProgram(server, company.session, id, "payroll", { full: true }), 400);
    expect(program.errors?.map((error) => [error.code, error.pointer])).toEqual([["invalid-value", "/program"]]);
    expect(await grantsOf(id)).toEqual([]);
  });

  it("takes Full behörighet or a list of permissions, one of the two", async () => {
    const { id } = await member();
    const cases: readonly (readonly [unknown, string, string])[] = [
      [{}, "missing-field", "/full"],
      [{ full: true, permissions: [] }, "invalid-value", "/permissions"],
      [{ full: false }, "invalid-value", "/full"],
    ];
    for (const [body, code, pointer] of cases) {
      const problem = await jsonOf<ProblemBody>(await calls.assignProgram(server, company.session, id, "read", body), 400);
      expect(problem.errors?.map((error) => [error.code, error.pointer]), JSON.stringify(body)).toEqual([[code, pointer]]);
    }
    expect(await grantsOf(id)).toEqual([]);
  });

  it("narrows with a list, and a second grant of a held program replaces its list and keeps its time", async () => {
    const { id } = await member();
    const full = await assigned(id, "bookkeeping");
    const narrowed = await assigned(id, "bookkeeping", { permissions: ["reports.vat", "vouchers.book", "vouchers.view", "vouchers.book"] });
    // In the catalogue's order, once each.
    expect(narrowed).toEqual({ program: "bookkeeping", permissions: ["vouchers.view", "vouchers.book", "reports.vat"], full: false, grantedAt: full.grantedAt });
    const [row] = await grantsOf(id);
    expect(await grantsOf(id)).toHaveLength(1);
    // Widened again with the manual-only rights beside Full behörighet: still full.
    const widened = await assigned(id, "bookkeeping", { permissions: [...fullPermissions("bookkeeping"), ...MANUAL_ONLY] });
    expect(widened.full).toBe(true);
    expect(widened.permissions).toHaveLength(fullPermissions("bookkeeping").length + 3);
    expect((await grantsOf(id))[0]?.id).toBe(row?.id);
    // An empty list is a grant with no right.
    expect(await assigned(id, "bookkeeping", { permissions: [] })).toMatchObject({ permissions: [], full: false });
  });

  it("grants to an invited and an inactive member, and finds no removed or left member, nor one of another company", async () => {
    const invited = await addMembership(app, owner, company, { status: "invited" });
    expect((await assigned(invited, "read")).program).toBe("read");
    const inactive = await member();
    await changeMembership(app, company, inactive.id, "status = 'inactive'");
    expect((await assigned(inactive.id, "read")).program).toBe("read");
    const other = await aCompany(app, "Testbolaget Beta AB");
    const outsiders = [
      (await membershipIn(app, owner, company, "removed")).id,
      (await membershipIn(app, owner, company, "left")).id,
      other.membership,
      "00000000-0000-4000-8000-000000000000",
    ];
    for (const id of outsiders) {
      const problem = await jsonOf<ProblemBody>(await calls.assignProgram(server, company.session, id, "read"), 422);
      expect(problem, id).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "The company has no invited, active or inactive member with the id that memberId names.",
        code: "user-not-found",
        pointer: "/memberId",
      });
      expect(await grantsOf(id)).toEqual([]);
    }
  });

  it("removeProgram takes the grant away, and refuses a program the member does not hold", async () => {
    const { id } = await member();
    await assigned(id, "approval-read");
    await assigned(id, "read");
    expect((await calls.removeProgram(server, company.session, id, "approval-read")).status).toBe(204);
    expect((await grantsOf(id)).map((grant) => grant.program)).toEqual(["read"]);
    const problem = await jsonOf<ProblemBody>(await calls.removeProgram(server, company.session, id, "approval-read"), 422);
    expect(problem).toMatchObject({ code: "program-not-granted", pointer: "/program", detail: "The member holds no grant of the program." });
    const user = await jsonOf<{ programs: ProgramGrant[] }>(await calls.getUser(server, company.session, id));
    expect(user.programs.map((grant) => grant.program)).toEqual(["read"]);
    // A member the company does not have, also one who left, is not found.
    const left = await membershipIn(app, owner, company, "left");
    expect(await jsonOf<ProblemBody>(await calls.removeProgram(server, company.session, left.id, "read"), 422)).toMatchObject({ code: "user-not-found", pointer: "/memberId" });
  });

  it("moveProgram leaves the grant on the target and none on the source", async () => {
    const source = await member();
    const target = await member();
    const granted = await assigned(source.id, "bookkeeping");
    const [before] = await grantsOf(source.id);
    const moved = await jsonOf<ProgramGrant>(await calls.moveProgram(server, company.session, source.id, "bookkeeping", { targetMemberId: target.id }));
    expect(moved).toEqual(granted);
    expect(await grantsOf(source.id)).toEqual([]);
    expect(await grantsOf(target.id)).toEqual([{ ...before, membership_id: target.id }]);
    // The move is one change of the grant in the behandlingshistorik, with its actor.
    const history = await superuser.query<{ operation: string; actor_id: string; old_member: string; new_member: string }>(
      `SELECT operation, actor_id, old_values->>'membership_id' AS old_member, new_values->>'membership_id' AS new_member FROM audit.history
       WHERE table_name = 'access.program_grants' AND row_id = $1 ORDER BY id`,
      [before?.id],
    );
    expect(history.rows.map((row) => row.operation)).toEqual(["INSERT", "UPDATE"]);
    expect(history.rows[1]).toEqual({ operation: "UPDATE", actor_id: company.creator.id, old_member: source.id, new_member: target.id });
  });

  it("moveProgram narrows the grant first with a list of the rights it holds, and refuses one it does not", async () => {
    const source = await member();
    const target = await member();
    await assigned(source.id, "bookkeeping", { permissions: ["vouchers.view", "vouchers.book", "reports.vat"] });
    const wider = await jsonOf<ProblemBody>(
      await calls.moveProgram(server, company.session, source.id, "bookkeeping", { targetMemberId: target.id, permissions: ["vouchers.view", "vouchers.delete"] }),
      422,
    );
    expect(wider).toMatchObject({ code: "not-in-grant", pointer: "/permissions/1", data: { permission: "vouchers.delete" }, detail: "The grant does not hold that right, so a move cannot give it." });
    const unseen = await jsonOf<ProblemBody>(
      await calls.moveProgram(server, company.session, source.id, "bookkeeping", { targetMemberId: target.id, permissions: ["reports.vat", "vouchers.book"] }),
      422,
    );
    expect(unseen).toMatchObject({ code: "view-permission-missing", pointer: "/permissions/1", data: { permission: "vouchers.book", view: "vouchers.view" } });
    expect(await grantsOf(target.id)).toEqual([]);
    const moved = await jsonOf<ProgramGrant>(
      await calls.moveProgram(server, company.session, source.id, "bookkeeping", { targetMemberId: target.id, permissions: ["reports.vat", "vouchers.view"] }),
    );
    expect(moved).toMatchObject({ program: "bookkeeping", permissions: ["vouchers.view", "reports.vat"], full: false });
    expect(await grantsOf(source.id)).toEqual([]);
  });

  it("moveProgram refuses a target that holds the program, a source that does not, and a target the company does not have", async () => {
    const source = await member();
    const target = await member();
    await assigned(source.id, "read");
    await assigned(target.id, "read");
    for (const to of [target.id, source.id]) {
      const held = await jsonOf<ProblemBody>(await calls.moveProgram(server, company.session, source.id, "read", { targetMemberId: to }), 422);
      expect(held).toMatchObject({ code: "program-already-granted", pointer: "/targetMemberId", detail: "The member that targetMemberId names holds the program already." });
    }
    const none = await jsonOf<ProblemBody>(await calls.moveProgram(server, company.session, source.id, "auditor", { targetMemberId: target.id }), 422);
    expect(none).toMatchObject({ code: "program-not-granted", pointer: "/program" });
    const removed = await membershipIn(app, owner, company, "removed");
    const nobody = await jsonOf<ProblemBody>(await calls.moveProgram(server, company.session, source.id, "read", { targetMemberId: removed.id }), 422);
    expect(nobody).toMatchObject({ code: "user-not-found", pointer: "/targetMemberId" });
    const noSource = await jsonOf<ProblemBody>(await calls.moveProgram(server, company.session, removed.id, "read", { targetMemberId: target.id }), 422);
    expect(noSource).toMatchObject({ code: "user-not-found", pointer: "/memberId" });
    expect((await grantsOf(source.id)).map((grant) => grant.program)).toEqual(["read"]);
  });

  it("updateUserRights sets the Rapporter and Register/Övrigt rights in every grant whose program covers them", async () => {
    const { id } = await member();
    await assigned(id, "bookkeeping");
    await assigned(id, "read");
    const rights = await jsonOf<{ permissions: string[]; programs: ProgramGrant[] }>(
      await calls.updateUserRights(server, company.session, id, ["register.projects", "reports.vat", "register.anonymise-fiscal-year"]),
    );
    expect(rights.permissions).toEqual(["reports.vat", "register.projects", "register.anonymise-fiscal-year"]);
    const programOwn = (program: Program): string[] => fullPermissions(program).filter((key) => /^(vouchers|supplier-invoices)\./.test(key));
    expect(rights.programs.map((grant) => [grant.program, grant.permissions, grant.full])).toEqual([
      ["bookkeeping", [...programOwn("bookkeeping"), "reports.vat", "register.projects", "register.anonymise-fiscal-year"], false],
      ["read", [...programOwn("read"), "reports.vat"], false],
    ]);
    expect((await grantsOf(id)).map((grant) => grant.permissions)).toEqual(rights.programs.map((grant) => grant.permissions));
    // The same list again changes no grant, so it writes no history.
    const changes = async (): Promise<number> =>
      Number(
        (
          await superuser.query<{ n: string }>(
            "SELECT count(*) AS n FROM audit.history WHERE table_name = 'access.program_grants' AND row_id = ANY (SELECT id FROM access.program_grants WHERE membership_id = $1)",
            [id],
          )
        ).rows[0]?.n,
      );
    const before = await changes();
    expect(await jsonOf(await calls.updateUserRights(server, company.session, id, ["reports.vat", "register.projects", "register.anonymise-fiscal-year"]))).toEqual(rights);
    expect(await changes()).toBe(before);
    // An empty list takes every such right away, and leaves the programs' own.
    const none = await jsonOf<{ permissions: string[]; programs: ProgramGrant[] }>(await calls.updateUserRights(server, company.session, id, []));
    expect(none.permissions).toEqual([]);
    expect(none.programs.map((grant) => grant.permissions)).toEqual([programOwn("bookkeeping"), programOwn("read")]);
  });

  it("updateUserRights refuses a right that no grant of the member covers, and a right of a program's own", async () => {
    const { id } = await member();
    await assigned(id, "read");
    const before = await grantsOf(id);
    const uncovered = await jsonOf<ProblemBody>(await calls.updateUserRights(server, company.session, id, ["reports.vat", "register.sie-import"]), 422);
    expect(uncovered).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "No program that the member holds covers the right.",
      code: "right-not-covered",
      pointer: "/permissions/1",
      data: { permission: "register.sie-import" },
    });
    const own = await jsonOf<ProblemBody>(await calls.updateUserRights(server, company.session, id, ["reports.vat", "vouchers.view"]), 400);
    // The schema takes the Rapporter and Register/Övrigt rights alone, and names them.
    const rights = CATALOGUE_PERMISSIONS.filter((permission) => permission.group === "reports" || permission.group === "register").map((permission) => permission.key);
    expect(own.errors).toEqual([expect.objectContaining({ code: "invalid-value", pointer: "/permissions/1", data: expect.objectContaining({ allowed: rights }) as unknown })]);
    expect(await grantsOf(id)).toEqual(before);
    const nobody = await jsonOf<ProblemBody>(await calls.updateUserRights(server, company.session, (await membershipIn(app, owner, company, "left")).id, []), 422);
    expect(nobody).toMatchObject({ code: "user-not-found", pointer: "/memberId" });
  });

  it("needs programs:grant: a plain member is refused every program operation, and nothing changes", async () => {
    const plain = await member();
    const target = await member();
    await assigned(target.id, "read");
    const before = await grantsOf(target.id);
    const session = await sessionIn(server, plain.person, company.id);
    for (const response of [
      await calls.assignProgram(server, session, target.id, "bookkeeping"),
      await calls.removeProgram(server, session, target.id, "read"),
      await calls.moveProgram(server, session, target.id, "read", { targetMemberId: plain.id }),
      await calls.updateUserRights(server, session, target.id, ["reports.vat"]),
    ]) {
      expect(await jsonOf<ProblemBody>(response, 403)).toMatchObject({ code: "permission-missing", permission: "programs:grant" });
    }
    expect(await grantsOf(target.id)).toEqual(before);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});

describe("a Revisor grant that has ended", () => {
  it("is granted again by assignProgram, with a new time and a new end, and the old one is in the behandlingshistorik", async () => {
    const db = await freshDatabase();
    const pool = appPool(db, 4);
    try {
      const app = await db.connect("app");
      const owner = await db.connect("owner");
      const superuser = await db.admin();
      const server = signInApp(pool.database, { clock: testClock(new Date()) });
      const company = await apiCompany(server, { app, owner });
      const { id } = await newMember(server, { app, owner }, company);
      const first = await jsonOf<ProgramGrant>(await calls.assignProgram(server, company.session, id, "auditor"));
      const [old] = (await superuser.query<{ id: string }>("SELECT id FROM access.program_grants WHERE membership_id = $1", [id])).rows;
      // 31 days on, by the server's clock: the grant has ended, and so has every session.
      server.clock.advance(31 * DAY);
      const session = await sessionIn(server, company.creator, company.id);
      const again = await jsonOf<ProgramGrant>(await calls.assignProgram(server, session, id, "auditor", { permissions: ["vouchers.view", "register.export-files"] }));
      expect(again).toMatchObject({ program: "auditor", permissions: ["vouchers.view", "register.export-files"], full: false });
      expect(new Date(again.grantedAt).getTime()).toBeGreaterThan(new Date(first.grantedAt).getTime());
      expect(new Date(again.expiresAt ?? "").getTime()).toBe(new Date(again.grantedAt).getTime() + 30 * DAY);
      const rows = await superuser.query<{ id: string }>("SELECT id FROM access.program_grants WHERE membership_id = $1", [id]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.id).not.toBe(old?.id);
      const history = await superuser.query<{ operation: string }>("SELECT operation FROM audit.history WHERE table_name = 'access.program_grants' AND row_id = $1 ORDER BY id", [old?.id]);
      expect(history.rows.map((row) => row.operation)).toEqual(["INSERT", "DELETE"]);
      expectNoTokensFromSignInApps();
      await expectNoSecretsAtRestFromSignInApps(db);
    } finally {
      await pool.pool.end();
      await db.close();
    }
  });
});
