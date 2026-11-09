// SPDX-License-Identifier: AGPL-3.0-only

// R8 (issue 12, "Roles, admin levels, programs and permissions" 10 and 12;
// open point 3): a Revisor grant stops working 30 days after it was
// granted, with no action by anyone, also in a session that chose the company
// before its end: the session keeps each permission with the end of the
// grant that gives it, and a request after the end no longer holds it.
// Exportera filer and Sie-export are off in the grant until they are
// switched on.
//
// The database stamps the grant with its own clock, so each test starts the
// server's clock where the grant's end is near. No operation of slice 2c
// needs a catalogue permission yet, so the test-only right checks
// (test/rights.ts) show whether a request holds one, beside getMe's list. The
// company's owner grants Revisor with assignProgram and switches its rights
// on with updateUserRights. The member is invited and accepts as the
// database holds it, since the invitations come in the next step of this
// part.

import { fullPermissions, type Me } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { grantTimes } from "../../../test/grants.ts";
import { acceptedMember, asMember } from "../../../test/memberships.ts";
import { rightPath, withRightChecks } from "../../../test/rights.ts";
import {
  DAY,
  HOUR,
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
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { apiCompany, calls, type ApiCompany } from "../../../test/users.ts";
import { tokenHash } from "../../auth/tokens.ts";

/** The rights the checks of this file read. */
const CHECKED = ["vouchers.view", "reports.processing-history", "register.export-files", "register.sie-export"] as const;

describe("a Revisor grant", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let pool: AppPool;
  /** The owner's server, whose clock is the database's. */
  let admin: SignInApp;
  let company: ApiCompany;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 4);
    admin = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(admin, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** A member of the company with Revisor and "Full behörighet", the grant's id, and when it was granted and ends. */
  async function auditor(): Promise<{ person: TestIdentity; membership: string; grant: string; grantedAt: Date; end: Date }> {
    const person = await addSignInIdentity(owner);
    const membership = await acceptedMember(app, owner, company, person.id);
    expect((await calls.assignProgram(admin, company.session, membership, "auditor", { full: true })).status).toBe(200);
    const [grant] = await asMember<{ id: string }>(app, company.id, company.asOwner, "SELECT id FROM access.program_grants WHERE membership_id = $1", [membership]);
    if (grant === undefined) {
      throw new Error("assignProgram made no grant.");
    }
    const { grantedAt, expiresAt } = await grantTimes(app, company, grant.id);
    if (expiresAt === null) {
      throw new Error("The Revisor grant has no end.");
    }
    return { person, membership, grant: grant.id, grantedAt, end: expiresAt };
  }

  /** A sign-in app whose clock starts at `start`, with the right checks. */
  function serverAt(start: Date): SignInApp {
    return signInApp(pool.database, { clock: testClock(start), options: withRightChecks(CHECKED) });
  }

  /** A new session of `person` on `server` that has chosen the company. */
  async function sessionInCompany(server: SignInApp, person: TestIdentity): Promise<string> {
    const { session } = await signIn(server, person);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    return session;
  }

  /** The status of the session's request that needs `permission`. */
  async function statusOf(server: SignInApp, session: string, permission: (typeof CHECKED)[number]): Promise<number> {
    return (await getAs(server, session, rightPath(permission))).status;
  }

  /** What getMe gives the session. */
  async function meOf(server: SignInApp, session: string): Promise<Me> {
    return jsonOf<Me>(await getAs(server, session, "/v1/me"));
  }

  it("stops 30 days after it was granted, also in a session that began before", async () => {
    const { person, grant, grantedAt, end } = await auditor();
    expect(end.getTime() - grantedAt.getTime()).toBe(30 * DAY);
    const before = await asMember(app, company.id, company.asOwner, "SELECT * FROM access.program_grants WHERE id = $1", [grant]);
    const history = async (): Promise<unknown[]> =>
      asMember(app, company.id, company.asOwner, "SELECT id FROM audit.history WHERE table_name = 'access.program_grants' AND row_id = $1", [grant]);
    const written = await history();
    expect(written).toHaveLength(1);
    // The session begins an hour before the end, and chooses the company then.
    const server = serverAt(new Date(end.getTime() - HOUR));
    const session = await sessionInCompany(server, person);
    expect(await statusOf(server, session, "vouchers.view")).toBe(200);
    expect(await statusOf(server, session, "reports.processing-history")).toBe(200);
    const inside = await meOf(server, session);
    expect(inside.permissions).toEqual(["company:read", ...fullPermissions("auditor")].sort());
    expect(inside.membership?.roles).toEqual(["auditor"]);
    // The session keeps each of the grant's rights with the grant's end.
    const stored = await owner.query<{ permissions: Record<string, string | null> }>("SELECT permissions FROM access.sessions WHERE token_hash = $1", [tokenHash(session)]);
    expect(stored.rows).toEqual([
      { permissions: { "company:read": null, ...Object.fromEntries(fullPermissions("auditor").map((permission) => [permission, end.toISOString()])) } },
    ]);
    // A millisecond before the end it still holds.
    server.clock.advance(HOUR - 1);
    expect(await statusOf(server, session, "vouchers.view")).toBe(200);
    // At the end it holds no more, in the same session, with no action by anyone.
    server.clock.advance(1);
    const refused = await getAs(server, session, rightPath("vouchers.view"));
    expect(refused.status).toBe(403);
    expect(await problemIn(refused)).toMatchObject({ code: "permission-missing", permission: "vouchers.view" });
    expect(await statusOf(server, session, "reports.processing-history")).toBe(403);
    const after = await meOf(server, session);
    expect(after.permissions).toEqual(["company:read"]);
    expect(after.membership?.roles).toEqual([]);
    // The grant stays, with its end, and nobody changed it.
    expect(after.membership?.programs).toEqual([{ program: "auditor", permissions: fullPermissions("auditor"), full: true, grantedAt: grantedAt.toISOString(), expiresAt: end.toISOString() }]);
    expect(await asMember(app, company.id, company.asOwner, "SELECT * FROM access.program_grants WHERE id = $1", [grant])).toEqual(before);
    expect(await history()).toEqual(written);
    // The session itself still works, in the company.
    expect((await getAs(server, session, "/v1/company")).status).toBe(200);
    // A choice of the company after the end takes none of it.
    server.clock.advance(MINUTE);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    expect((await meOf(server, session)).permissions).toEqual(["company:read"]);
    const chosenAgain = await owner.query<{ permissions: Record<string, string | null> }>("SELECT permissions FROM access.sessions WHERE token_hash = $1", [tokenHash(session)]);
    expect(chosenAgain.rows).toEqual([{ permissions: { "company:read": null } }]);
  });

  it("gives nothing to a session that begins after the end", async () => {
    const { person, end } = await auditor();
    const server = serverAt(new Date(end.getTime() + DAY));
    const session = await sessionInCompany(server, person);
    expect(await statusOf(server, session, "vouchers.view")).toBe(403);
    expect((await meOf(server, session)).permissions).toEqual(["company:read"]);
  });

  it("Exportera filer and Sie-export are off until switched on", async () => {
    const { person, membership } = await auditor();
    const server = serverAt(new Date());
    const session = await sessionInCompany(server, person);
    const off = await meOf(server, session);
    expect(off.permissions).not.toContain("register.export-files");
    expect(off.permissions).not.toContain("register.sie-export");
    expect(await statusOf(server, session, "register.export-files")).toBe(403);
    expect(await statusOf(server, session, "register.sie-export")).toBe(403);
    // Anpassa Register/Övrigt: the Rapporter stay as they were, and the two are switched on.
    const reports = fullPermissions("auditor").filter((permission) => permission.startsWith("reports."));
    expect((await calls.updateUserRights(admin, company.session, membership, [...reports, "register.export-files", "register.sie-export"])).status).toBe(200);
    // They come with the session's next choice of the company.
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    expect(await statusOf(server, session, "register.export-files")).toBe(200);
    expect(await statusOf(server, session, "register.sie-export")).toBe(200);
    const on = await meOf(server, session);
    expect(on.permissions).toContain("register.export-files");
    expect(on.permissions).toContain("register.sie-export");
    // It is still the auditor's Revisor with "Full behörighet".
    expect(on.membership?.roles).toEqual(["auditor"]);
    expect(on.membership?.programs[0]).toMatchObject({ program: "auditor", full: true });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
