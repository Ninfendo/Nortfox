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
// invited and accept, and get their program with "Full behörighet", as
// "Tilldela program" preselects it, or are made system administrator: the
// tests write those as the database holds them, as the owner, since
// inviteUser, assignProgram and updateUser come in later steps of this part,
// which then make these members through the operations. The server's clock
// starts at the database's, so a Revisor grant holds.

import { fullPermissions, type Me, type Program, type ProgramGrant, type Role } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addGrant, addProgramAdmin, grantTimes } from "../../../test/grants.ts";
import { acceptedMember, asMember, changeMembership, type Company } from "../../../test/memberships.ts";
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
  writeAs,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";

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
  let creator: TestIdentity;
  let company: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    creator = await addSignInIdentity(owner);
    const { session } = await signIn(server, creator);
    const made = await jsonOf<{ id: string; name: string; organizationNumber: string; databaseNumber: number }>(
      await writeAs(server, session, "POST", "/v1/companies", { name: "Testbolaget Alfa AB", organizationNumber: "556000-0167" }),
      201,
    );
    const asOwner = { actor: creator.id, kind: "user" } as const;
    const [first] = await asMember<{ id: string }>(app, made.id, asOwner, "SELECT id FROM access.memberships WHERE live_user_id = $1", [creator.id]);
    if (first === undefined) {
      throw new Error("createCompany made no membership for its creator.");
    }
    company = {
      row: { company_id: made.id, name: made.name, organization_number: made.organizationNumber, database_number: made.databaseNumber },
      owner: creator.id,
      membership: first.id,
      id: made.id,
      asOwner,
    };
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** What getMe gives `person` in a new session that has chosen the company. */
  async function meInCompany(person: TestIdentity): Promise<Me> {
    // A new TOTP code comes with the next 30 seconds.
    server.clock.advance(MINUTE);
    const { session } = await signIn(server, person);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    return jsonOf<Me>(await getAs(server, session, "/v1/me"));
  }

  /** A new person, invited to the company, who accepts. */
  async function invited(): Promise<{ person: TestIdentity; membership: string }> {
    const person = await addSignInIdentity(owner);
    return { person, membership: await acceptedMember(app, owner, company, person.id) };
  }

  /** An invited member who holds the role's program with "Full behörighet", and the grant as getMe gives it. */
  async function memberWithProgram(role: keyof typeof PROGRAM_OF): Promise<{ person: TestIdentity; grant: ProgramGrant }> {
    const { person, membership } = await invited();
    const program = PROGRAM_OF[role];
    const row = await addGrant(app, company, membership, program, fullPermissions(program));
    const times = await grantTimes(app, company, row.id);
    return {
      person,
      grant: {
        program,
        permissions: fullPermissions(program),
        full: true,
        grantedAt: times.grantedAt.toISOString(),
        ...(times.expiresAt === null ? {} : { expiresAt: times.expiresAt.toISOString() }),
      },
    };
  }

  it("getMe gives exactly the owner's permissions", async () => {
    const me = await meInCompany(creator);
    expect(me.permissions).toEqual(["company:read"]);
    expect(me.membership).toMatchObject({
      companyId: company.id,
      userId: creator.id,
      status: "active",
      adminLevel: "owner",
      roles: ["owner"],
      programs: [],
      programsAdministered: [],
    });
  });

  it("getMe gives exactly the admin's permissions", async () => {
    const { person, membership } = await invited();
    await changeMembership(app, company, membership, "admin_level = 'admin'");
    const me = await meInCompany(person);
    expect(me.permissions).toEqual(["company:read"]);
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
    const { person, membership } = await invited();
    expect((await meInCompany(person)).membership?.roles).toEqual([]);
    await changeMembership(app, company, membership, "admin_level = 'admin'");
    const admin = await meInCompany(person);
    const theOwner = await meInCompany(creator);
    expect(theOwner.membership).toMatchObject({ adminLevel: "owner", roles: ["owner"] });
    expect(admin.membership).toMatchObject({ adminLevel: "admin", roles: ["admin"] });
    expect(admin.permissions).toEqual(theOwner.permissions);
  });

  it("gives a member with several programs each grant in the catalogue's order, the union of their rights, each role and the programs administered", async () => {
    const { person, membership } = await invited();
    const auditor = await addGrant(app, company, membership, "auditor", fullPermissions("auditor"));
    await addGrant(app, company, membership, "bookkeeping", ["vouchers.view", "vouchers.book", "register.projects"]);
    await addGrant(app, company, membership, "read", fullPermissions("read"));
    await addProgramAdmin(app, company, membership, "auditor");
    await addProgramAdmin(app, company, membership, "bookkeeping");
    const me = await meInCompany(person);
    expect(me.membership?.programs.map((grant) => [grant.program, grant.full])).toEqual([
      ["bookkeeping", false],
      ["read", true],
      ["auditor", true],
    ]);
    expect(me.membership?.programs[0]?.permissions).toEqual(["vouchers.view", "vouchers.book", "register.projects"]);
    expect(me.membership?.programs[0]?.expiresAt).toBeUndefined();
    expect(me.membership?.programs[2]?.expiresAt).toBe((await grantTimes(app, company, auditor.id)).expiresAt?.toISOString());
    expect(me.membership?.programsAdministered).toEqual([{ program: "bookkeeping" }, { program: "auditor" }]);
    // A narrowed Bokföring makes no bookkeeper.
    expect(me.membership?.roles).toEqual(["viewer", "auditor"]);
    expect(me.permissions).toEqual(sorted(["company:read", ...new Set([...fullPermissions("auditor"), ...fullPermissions("read"), "vouchers.book", "register.projects"])]));
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
