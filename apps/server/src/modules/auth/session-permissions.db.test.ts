// SPDX-License-Identifier: AGPL-3.0-only

// R11 (issue 12, "Roles, admin levels, programs and permissions" 12): a
// permission change reaches a session when the session next chooses the
// company, with selectCompany ("Byt företag"), or at the next sign-in. Until
// then the session keeps the permissions it took when it chose the company:
// a permission removed from the member still works in it, and one given
// since does not. The member's next session takes them as they are then.
// When the session chooses the company, it stores each permission with the
// end of the grant that gives it, or none.
//
// No operation of slice 2c needs a catalogue permission yet, so the test-only
// right checks (test/rights.ts) show whether a request holds one, beside
// getMe's list. The grants are changed as the database holds them, as the
// company's owner: assignProgram, removeProgram and updateUserRights come in
// a later step of this part.

import { fullPermissions, type Me } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addGrant, changeGrant } from "../../../test/grants.ts";
import { aCompany, addMembership, asMember, type Company } from "../../../test/memberships.ts";
import { rightPath, withRightChecks } from "../../../test/rights.ts";
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
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { tokenHash } from "../../auth/tokens.ts";

/** The rights the checks of this file read. */
const CHECKED = ["vouchers.view", "vouchers.book", "reports.vat"] as const;

describe("a session's permissions", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock(), options: withRightChecks(CHECKED) });
    company = await aCompany(app, "Testbolaget Alfa AB");
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** A member of the company with Bokföring and "Full behörighet", and the grant's id. */
  async function bookkeeper(): Promise<{ person: TestIdentity; membership: string; grant: string }> {
    const person = await addSignInIdentity(owner);
    const membership = await addMembership(app, owner, company, { user: person.id });
    const grant = await addGrant(app, company, membership, "bookkeeping", fullPermissions("bookkeeping"));
    return { person, membership, grant: grant.id };
  }

  /** A new session of `person` that has chosen the company. A new TOTP code comes with the next 30 seconds. */
  async function sessionInCompany(person: TestIdentity): Promise<string> {
    server.clock.advance(MINUTE);
    const { session } = await signIn(server, person);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    return session;
  }

  /** The status of the session's request that needs `permission`. */
  async function statusOf(session: string, permission: (typeof CHECKED)[number]): Promise<number> {
    return (await getAs(server, session, rightPath(permission))).status;
  }

  /** The permissions getMe gives the session. */
  async function permissionsOf(session: string): Promise<readonly string[]> {
    return (await jsonOf<Me>(await getAs(server, session, "/v1/me"))).permissions;
  }

  /** Takes Bokför off the grant, as the owner narrows it. */
  async function withoutBook(grant: string): Promise<void> {
    await changeGrant(app, company, grant, "permissions = $2", [fullPermissions("bookkeeping").filter((permission) => permission !== "vouchers.book")]);
  }

  it("a removed permission works until the session chooses the company again", async () => {
    const { person, grant } = await bookkeeper();
    const session = await sessionInCompany(person);
    expect(await statusOf(session, "vouchers.book")).toBe(200);
    await withoutBook(grant);
    // The session keeps what it took when it chose the company, on every request until it chooses again.
    for (let request = 0; request < 3; request += 1) {
      server.clock.advance(MINUTE);
      expect(await statusOf(session, "vouchers.book")).toBe(200);
    }
    expect(await permissionsOf(session)).toContain("vouchers.book");
    // The membership in getMe shows the grant as it is now.
    const me = await jsonOf<Me>(await getAs(server, session, "/v1/me"));
    expect(me.membership?.programs[0]?.permissions).not.toContain("vouchers.book");
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    const refused = await getAs(server, session, rightPath("vouchers.book"));
    expect(refused.status).toBe(403);
    expect(await problemIn(refused)).toMatchObject({ code: "permission-missing", permission: "vouchers.book" });
    expect(await permissionsOf(session)).not.toContain("vouchers.book");
    // The rest of the grant stays.
    expect(await statusOf(session, "vouchers.view")).toBe(200);
    expect(await statusOf(session, "reports.vat")).toBe(200);
  });

  it("and is refused in the next session", async () => {
    const { person, grant } = await bookkeeper();
    const first = await sessionInCompany(person);
    await withoutBook(grant);
    const next = await sessionInCompany(person);
    const refused = await getAs(server, next, rightPath("vouchers.book"));
    expect(refused.status).toBe(403);
    expect(await problemIn(refused)).toMatchObject({ code: "permission-missing", permission: "vouchers.book" });
    expect(await permissionsOf(next)).not.toContain("vouchers.book");
    // The first session still works with what it chose the company with.
    expect(await statusOf(first, "vouchers.book")).toBe(200);
  });

  it("a withdrawn program works until the session chooses the company again", async () => {
    const { person, grant } = await bookkeeper();
    const session = await sessionInCompany(person);
    await asMember(app, company.id, company.asOwner, "DELETE FROM access.program_grants WHERE id = $1", [grant]);
    expect(await statusOf(session, "vouchers.view")).toBe(200);
    expect(await statusOf(session, "vouchers.book")).toBe(200);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    expect(await permissionsOf(session)).toEqual(["company:read"]);
    expect(await statusOf(session, "vouchers.view")).toBe(403);
  });

  it("a permission given since the choice comes only when the session chooses the company again", async () => {
    const person = await addSignInIdentity(owner);
    const membership = await addMembership(app, owner, company, { user: person.id });
    await addGrant(app, company, membership, "read", fullPermissions("read"));
    const session = await sessionInCompany(person);
    expect(await statusOf(session, "vouchers.view")).toBe(200);
    expect(await statusOf(session, "vouchers.book")).toBe(403);
    await addGrant(app, company, membership, "bookkeeping", fullPermissions("bookkeeping"));
    expect(await statusOf(session, "vouchers.book")).toBe(403);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    expect(await statusOf(session, "vouchers.book")).toBe(200);
  });

  it("stores each permission of the choice with no end when no grant that gives it ends", async () => {
    const { person } = await bookkeeper();
    const session = await sessionInCompany(person);
    const stored = await owner.query<{ permissions: Record<string, string | null> }>("SELECT permissions FROM access.sessions WHERE token_hash = $1", [tokenHash(session)]);
    expect(stored.rows).toEqual([
      { permissions: Object.fromEntries(["company:read", ...fullPermissions("bookkeeping")].map((permission) => [permission, null])) },
    ]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
