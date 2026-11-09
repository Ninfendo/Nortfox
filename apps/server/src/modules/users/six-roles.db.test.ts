// SPDX-License-Identifier: AGPL-3.0-only

// R2 and R3 (issue 12, "Roles, admin levels, programs and permissions" 1, 2,
// 4, 10 and 11). For each of the plan's six roles, a member who holds it
// gets exactly that role's permissions in getMe, once the session has chosen
// the company: the owner and the admin a member's own and a system
// administrator's, and none of Bokföring's; the bookkeeper every permission
// of the Bokföring program and its Rapporter and Register/Övrigt rights, but
// none of the six that only Bokföring - Attest & Läs holds and none of the
// manual-only ones; the approver, the viewer and the auditor only their
// programs' sets. The membership in getMe names the role, the admin level,
// the program grants and the programs administered. The creator of the
// company holds the owner role, and a member made system administrator holds
// the admin role, with the same permissions (open point 1).
//
// The creator makes the company with createCompany. The other members are
// invited and accept, as the database holds it, since inviteUser and
// acceptInvitation come in the next step of this part, which then makes
// them through the operations. The owner gives them their program with
// assignProgram and "Full behörighet", as "Tilldela program" preselects
// it, or makes them system administrator with updateUser. The server's
// clock starts at the database's, so a Revisor grant holds.

import { fullPermissions, type Me, type Program, type ProgramGrant, type Role } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, getAs, jsonOf, signInApp, testClock, type SignInApp, type TestIdentity } from "../../../test/sign-in.ts";
import { apiCompany, calls, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";

/** The six that only Bokföring - Attest & Läs holds (issue 12, catalogue item 9). */
const APPROVAL_READ_ONLY = [
  "vouchers.approve-own-series",
  "vouchers.see-all-series",
  "reports.supplier-invoices",
  "reports.supplier-statistics",
  "reports.supplier-ledger",
  "reports.supplier-due-list",
];

/** The manual-only rights that this slice builds. */
const MANUAL_ONLY = ["register.anonymise-fiscal-year", "register.removed-users", "register.delete-processing-history"];

/** What a system administrator holds, the owner and the admin alike: a member's own, the company's details, its users and their programs. */
const SYSTEM_ADMINISTRATOR = ["company:read", "company:update", "programs:grant", "users:admin", "users:read"];

/** The program of each role that is one. */
const PROGRAM_OF = { bookkeeper: "bookkeeping", approver: "approval-read", viewer: "read", auditor: "auditor" } as const satisfies Partial<Record<Role, Program>>;

/** A list in the order getMe gives its permissions: alphabetical. */
function sorted(permissions: readonly string[]): string[] {
  return [...permissions].sort();
}

describe("the six roles in getMe", () => {
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

  /** What getMe gives `person` in a new session that has chosen the company. */
  async function meInCompany(person: TestIdentity): Promise<Me> {
    return jsonOf<Me>(await getAs(server, await sessionIn(server, person, company.id), "/v1/me"));
  }

  /** A new person, invited to the company, who accepts. */
  function invited(): Promise<TestMember> {
    return newMember({ app, owner }, company);
  }

  /** The owner's call of an operation that answers JSON. */
  async function asOwner<T>(response: Promise<Response>): Promise<T> {
    return jsonOf<T>(await response);
  }

  /** An invited member to whom the owner grants the role's program with "Full behörighet", and the grant as assignProgram answers it. */
  async function memberWithProgram(role: keyof typeof PROGRAM_OF): Promise<{ person: TestIdentity; grant: ProgramGrant }> {
    const { person, id } = await invited();
    const grant = await asOwner<ProgramGrant>(calls.assignProgram(server, company.session, id, PROGRAM_OF[role], { full: true }));
    expect(grant).toMatchObject({ program: PROGRAM_OF[role], permissions: fullPermissions(PROGRAM_OF[role]), full: true });
    return { person, grant };
  }

  it("getMe gives exactly the owner's permissions", async () => {
    const me = await meInCompany(company.creator);
    expect(me.permissions).toEqual(SYSTEM_ADMINISTRATOR);
    expect(me.membership).toMatchObject({
      id: company.membership,
      companyId: company.id,
      userId: company.creator.id,
      status: "active",
      adminLevel: "owner",
      roles: ["owner"],
      programs: [],
      programsAdministered: [],
    });
  });

  it("getMe gives exactly the admin's permissions", async () => {
    const { person, id } = await invited();
    expect((await calls.updateUser(server, company.session, id, { adminLevel: "admin" })).status).toBe(200);
    const me = await meInCompany(person);
    expect(me.permissions).toEqual(SYSTEM_ADMINISTRATOR);
    expect(me.membership).toMatchObject({ userId: person.id, status: "active", adminLevel: "admin", roles: ["admin"], programs: [], programsAdministered: [] });
  });

  it("getMe gives exactly the bookkeeper's permissions", async () => {
    const { person, grant } = await memberWithProgram("bookkeeper");
    const me = await meInCompany(person);
    expect(me.permissions).toEqual(sorted(["company:read", ...fullPermissions("bookkeeping")]));
    // Every right of the two Bokföring groups, its eighteen reports and seven Register/Övrigt rights.
    expect(me.permissions).toHaveLength(1 + 17 + 13 + 18 + 7);
    for (const permission of [...APPROVAL_READ_ONLY, ...MANUAL_ONLY]) {
      expect(me.permissions).not.toContain(permission);
    }
    for (const permission of ["vouchers.view", "vouchers.book", "vouchers.lock-period", "supplier-invoices.settings", "reports.processing-history", "register.export-files"]) {
      expect(me.permissions).toContain(permission);
    }
    expect(me.membership).toMatchObject({ userId: person.id, roles: ["bookkeeper"], programs: [grant], programsAdministered: [] });
    expect(me.membership?.adminLevel).toBeUndefined();
  });

  it.each(["approver", "viewer", "auditor"] as const)("getMe gives exactly the %s's permissions", async (role) => {
    const { person, grant } = await memberWithProgram(role);
    const me = await meInCompany(person);
    expect(me.permissions).toEqual(sorted(["company:read", ...fullPermissions(PROGRAM_OF[role])]));
    for (const permission of MANUAL_ONLY) {
      expect(me.permissions).not.toContain(permission);
    }
    expect(me.membership).toMatchObject({ userId: person.id, roles: [role], programs: [grant], programsAdministered: [] });
  });

  it("gives the viewer no action right, and the auditor neither Exportera filer nor Sie-export", async () => {
    const viewer = await meInCompany((await memberWithProgram("viewer")).person);
    expect(viewer.permissions.filter((permission) => /^(vouchers|supplier-invoices)\./.test(permission))).toEqual(["supplier-invoices.view", "vouchers.view"]);
    const auditor = await meInCompany((await memberWithProgram("auditor")).person);
    expect(auditor.permissions).not.toContain("register.export-files");
    expect(auditor.permissions).not.toContain("register.sie-export");
    expect(auditor.membership?.programs[0]?.expiresAt).toBeDefined();
  });

  it("the creator holds owner, a member made system administrator holds admin, and both hold the same permissions", async () => {
    const { person, id } = await invited();
    expect((await meInCompany(person)).membership?.roles).toEqual([]);
    expect((await calls.updateUser(server, company.session, id, { adminLevel: "admin" })).status).toBe(200);
    const admin = await meInCompany(person);
    const theOwner = await meInCompany(company.creator);
    expect(theOwner.membership).toMatchObject({ adminLevel: "owner", roles: ["owner"] });
    expect(admin.membership).toMatchObject({ adminLevel: "admin", roles: ["admin"] });
    expect(admin.permissions).toEqual(theOwner.permissions);
  });

  it("gives a member with several programs each grant in the catalogue's order, the union of their rights, each role and the programs administered", async () => {
    const { person, id } = await invited();
    const auditor = await asOwner<ProgramGrant>(calls.assignProgram(server, company.session, id, "auditor", { full: true }));
    await asOwner(calls.assignProgram(server, company.session, id, "bookkeeping", { permissions: ["vouchers.view", "vouchers.book", "register.projects"] }));
    await asOwner(calls.assignProgram(server, company.session, id, "read", { full: true }));
    await asOwner(calls.updateUser(server, company.session, id, { programsAdministered: [{ program: "auditor" }, { program: "bookkeeping" }] }));
    const me = await meInCompany(person);
    expect(me.membership?.programs.map((grant) => [grant.program, grant.full])).toEqual([
      ["bookkeeping", false],
      ["read", true],
      ["auditor", true],
    ]);
    expect(me.membership?.programs[0]?.permissions).toEqual(["vouchers.view", "vouchers.book", "register.projects"]);
    expect(me.membership?.programs[0]?.expiresAt).toBeUndefined();
    expect(me.membership?.programs[2]?.expiresAt).toBe(auditor.expiresAt);
    expect(me.membership?.programsAdministered).toEqual([{ program: "bookkeeping" }, { program: "auditor" }]);
    // A narrowed Bokföring makes no bookkeeper.
    expect(me.membership?.roles).toEqual(["viewer", "auditor"]);
    // A program administrator reads the users and grants programs, beside the grants' rights.
    expect(me.permissions).toEqual(
      sorted(["company:read", "programs:grant", "users:read", ...new Set([...fullPermissions("auditor"), ...fullPermissions("read"), "vouchers.book", "register.projects"])]),
    );
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
