// SPDX-License-Identifier: AGPL-3.0-only

// M11 (issue 12, Users in a company 8, Sessions 2): "Utloggning efter
// inaktivitet" is set per membership, and only to one of the five values the
// established screen offers, 15, 30, 60, 120 or 480 minutes: a value outside
// 15 minutes to 8 hours is refused by updateMyMembership and by the
// database, and so is a value inside that the screen does not offer (choice
// 1). A session that works in a company ends after the membership's idle
// time without a request. After logout the cookie is refused: that half is
// in sessions.db.test.ts. The server's clock is moved forwards.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { CHECK_VIOLATION, expectError, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { aCompany, addMembership, asMember, type Company } from "../../../test/memberships.ts";
import {
  MINUTE,
  SECOND,
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
import { tokenHash } from "../../auth/tokens.ts";

describe("idle logout", () => {
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
    server = signInApp(pool.database, { clock: testClock() });
    company = await aCompany(app, "Testbolaget Alfa AB");
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** A member of the company with `idle` minutes, signed in, whose session works in the company. */
  async function memberInCompany(idle: number): Promise<{ person: TestIdentity; session: string; membership: string }> {
    const person = await addSignInIdentity(owner);
    const membership = await addMembership(app, owner, company, { user: person.id, idle });
    const { session } = await signIn(server, person);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    return { person, session, membership };
  }

  async function endOf(session: string): Promise<{ ended_at: Date | null; end_reason: string | null } | undefined> {
    return (await owner.query<{ ended_at: Date | null; end_reason: string | null }>("SELECT ended_at, end_reason FROM access.sessions WHERE token_hash = $1", [tokenHash(session)]))
      .rows[0];
  }

  function changeOwn(session: string, body: unknown): Promise<Response> {
    return writeAs(server, session, "PATCH", `/v1/me/companies/${company.id}`, body);
  }

  it("refuses an idle time outside 15 minutes to 8 hours, by updateMyMembership and by the database", async () => {
    const { session, membership } = await memberInCompany(120);
    for (const idleTimeout of [0, 14, 481, 500, 1440, -15, 45, 90, 240, 120.5, "120"]) {
      const problem = await jsonOf<ProblemBody>(await changeOwn(session, { idleTimeout }), 400);
      expect(problem.errors?.[0], JSON.stringify(idleTimeout)).toMatchObject({ pointer: "/idleTimeout" });
    }
    const outside = await jsonOf<ProblemBody>(await changeOwn(session, { idleTimeout: 481 }), 400);
    expect(outside.errors).toEqual([
      { code: "invalid-value", detail: "The field /idleTimeout must be one of: 15, 30, 60, 120, 480.", pointer: "/idleTimeout", data: { allowed: [15, 30, 60, 120, 480] } },
    ]);
    for (const idleTimeout of [15, 30, 60, 480, 120]) {
      const changed = await jsonOf<{ idleTimeout: number }>(await changeOwn(session, { idleTimeout }));
      expect(changed.idleTimeout).toBe(idleTimeout);
    }
    // The database refuses the same, from the app.
    for (const minutes of [0, 14, 481, 45]) {
      await expectError(
        asMember(app, company.id, company.asOwner, "UPDATE access.memberships SET idle_timeout_minutes = $2 WHERE id = $1", [membership, minutes]),
        CHECK_VIOLATION,
        /memberships_idle_timeout_known/,
      );
    }
  });

  it("a session ends after the membership's idle time", async () => {
    const { session } = await memberInCompany(15);
    // A request inside the 15 minutes keeps it, and moves its last sight on.
    server.clock.advance(15 * MINUTE - SECOND);
    expect((await getAs(server, session, "/v1/company")).status).toBe(200);
    server.clock.advance(15 * MINUTE - SECOND);
    expect((await getAs(server, session, "/v1/company")).status).toBe(200);
    // 15 minutes without a request end it.
    server.clock.advance(15 * MINUTE);
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    expect(await endOf(session)).toEqual({ ended_at: server.clock.now(), end_reason: "idle" });
    // It stays ended.
    expect((await getAs(server, session, "/v1/session")).status).toBe(401);
  });

  it("uses the membership's own idle time: 8 hours outlast the 2 hours of a session in no company", async () => {
    const { session } = await memberInCompany(480);
    server.clock.advance(3 * 60 * MINUTE);
    expect((await getAs(server, session, "/v1/session")).status).toBe(200);
    server.clock.advance(8 * 60 * MINUTE - SECOND);
    expect((await getAs(server, session, "/v1/session")).status).toBe(200);
    // The session is 11 hours old, inside its 12, and 8 hours without a request end it.
    server.clock.advance(8 * 60 * MINUTE);
    expect((await getAs(server, session, "/v1/session")).status).toBe(401);
    expect((await endOf(session))?.end_reason).toBe("absolute");
  });

  it("ends a session in a company after 8 hours without a request, inside its 12 hours", async () => {
    const { session } = await memberInCompany(480);
    server.clock.advance(3 * 60 * MINUTE);
    expect((await getAs(server, session, "/v1/session")).status).toBe(200);
    server.clock.advance(8 * 60 * MINUTE);
    expect((await getAs(server, session, "/v1/session")).status).toBe(401);
    expect((await endOf(session))?.end_reason).toBe("idle");
  });

  it("a person's own change of the idle time holds from the next request", async () => {
    const { session } = await memberInCompany(480);
    expect((await changeOwn(session, { idleTimeout: 30 })).status).toBe(200);
    server.clock.advance(30 * MINUTE);
    expect((await getAs(server, session, "/v1/session")).status).toBe(401);
    expect((await endOf(session))?.end_reason).toBe("idle");
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
