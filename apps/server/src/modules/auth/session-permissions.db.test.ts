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
// getMe's list. The company's owner changes the grants with assignProgram
// and removeProgram. The members are invited with inviteUser and accept
// with acceptInvitation, so the server's clock starts at the database's.

import { fullPermissions, type Me } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { rightPath, withRightChecks } from "../../../test/rights.ts";
import {
  MINUTE,
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
import { apiCompany, calls, newMember, type ApiCompany } from "../../../test/users.ts";
import { tokenHash } from "../../auth/tokens.ts";

/** The rights the checks of this file read. */
const CHECKED = ["vouchers.view", "vouchers.book", "reports.vat"] as const;

describe("a session's permissions", () => {
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
    server = signInApp(pool.database, { clock: testClock(new Date()), options: withRightChecks(CHECKED) });
    company = await apiCompany(server, { app, owner });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The owner grants `program` to a member with "Full behörighet", or with `permissions`. */
  async function assign(membership: string, program: "bookkeeping" | "read", permissions?: readonly string[]): Promise<void> {
    expect((await calls.assignProgram(server, company.session, membership, program, permissions === undefined ? { full: true } : { permissions })).status).toBe(200);
  }

  /** A member of the company with Bokföring and "Full behörighet". */
  async function bookkeeper(): Promise<{ person: TestIdentity; membership: string }> {
    const { person, id: membership } = await newMember(server, { app, owner }, company);
    await assign(membership, "bookkeeping");
    return { person, membership };
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
  async function withoutBook(membership: string): Promise<void> {
    await assign(
      membership,
      "bookkeeping",
      fullPermissions("bookkeeping").filter((permission) => permission !== "vouchers.book"),
    );
  }

  it("a removed permission works until the session chooses the company again", async () => {
    const { person, membership } = await bookkeeper();
    const session = await sessionInCompany(person);
    expect(await statusOf(session, "vouchers.book")).toBe(200);
    await withoutBook(membership);
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
    const { person, membership } = await bookkeeper();
    const first = await sessionInCompany(person);
    await withoutBook(membership);
    const next = await sessionInCompany(person);
    const refused = await getAs(server, next, rightPath("vouchers.book"));
    expect(refused.status).toBe(403);
    expect(await problemIn(refused)).toMatchObject({ code: "permission-missing", permission: "vouchers.book" });
    expect(await permissionsOf(next)).not.toContain("vouchers.book");
    // The first session still works with what it chose the company with.
    expect(await statusOf(first, "vouchers.book")).toBe(200);
  });

  it("a withdrawn program works until the session chooses the company again", async () => {
    const { person, membership } = await bookkeeper();
    const session = await sessionInCompany(person);
    expect((await calls.removeProgram(server, company.session, membership, "bookkeeping")).status).toBe(204);
    expect(await statusOf(session, "vouchers.view")).toBe(200);
    expect(await statusOf(session, "vouchers.book")).toBe(200);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    expect(await permissionsOf(session)).toEqual(["company:read", "tokens:own"]);
    expect(await statusOf(session, "vouchers.view")).toBe(403);
  });

  it("a permission given since the choice comes only when the session chooses the company again", async () => {
    const { person, id: membership } = await newMember(server, { app, owner }, company);
    await assign(membership, "read");
    const session = await sessionInCompany(person);
    expect(await statusOf(session, "vouchers.view")).toBe(200);
    expect(await statusOf(session, "vouchers.book")).toBe(403);
    await assign(membership, "bookkeeping");
    expect(await statusOf(session, "vouchers.book")).toBe(403);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    expect(await statusOf(session, "vouchers.book")).toBe(200);
  });

  it("stores each permission of the choice with no end when no grant that gives it ends", async () => {
    const { person } = await bookkeeper();
    const session = await sessionInCompany(person);
    const stored = await owner.query<{ permissions: Record<string, string | null> }>("SELECT permissions FROM access.sessions WHERE token_hash = $1", [tokenHash(session)]);
    expect(stored.rows).toEqual([
      { permissions: Object.fromEntries(["company:read", "tokens:own", ...fullPermissions("bookkeeping")].map((permission) => [permission, null])) },
    ]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
