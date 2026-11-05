// SPDX-License-Identifier: AGPL-3.0-only

// A session that works in a company keeps the membership it chose the
// company with (issue 12, Sessions 2 and 3). The resolver asks the one
// membership function on every request: when the session's membership is no
// longer the person's active membership there, because it was deactivated,
// removed, left, or given another person, or the person holds another
// membership there now, the request is refused as one with no actor, and the
// session ends with the reason membership. The database ends it already
// when the membership stops being active, so it stays ended when the
// membership comes back, also with no request between. access.choose_company, the lookup function that
// stores the session's choice, chooses only for the transaction's person's
// own live session.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, gate, type AppPool } from "../../../test/api.ts";
import { CHECK_VIOLATION, expectError, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, anonymously, deleteIdentity, tokenHash as someTokenHash } from "../../../test/identities.ts";
import { aCompany, addMembership, changeMembership, membershipOf, type Company } from "../../../test/memberships.ts";
import {
  MINUTE,
  addSignInIdentity,
  chooseCompany,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  signIn,
  signInApp,
  testClock,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { newToken, tokenHash } from "../../auth/tokens.ts";
import type { Database } from "../../db/database.ts";

describe("a session's membership", () => {
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

  /** A member of the company, signed in, whose session works in the company. */
  async function memberInCompany(): Promise<{ person: TestIdentity; session: string; membership: string }> {
    const person = await addSignInIdentity(owner);
    const membership = await addMembership(app, owner, company, { user: person.id });
    const { session } = await signIn(server, person);
    expect((await chooseCompany(server, session, company.id)).status).toBe(200);
    expect((await getAs(server, session, "/v1/company")).status).toBe(200);
    return { person, session, membership };
  }

  async function endOf(session: string): Promise<string | null | undefined> {
    return (await owner.query<{ end_reason: string | null }>("SELECT end_reason FROM access.sessions WHERE token_hash = $1", [tokenHash(session)])).rows[0]?.end_reason;
  }

  /** The session is refused on its next request, and ended with the reason membership. */
  async function expectEnded(session: string): Promise<void> {
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    expect(await endOf(session)).toBe("membership");
    expect((await getAs(server, session, "/v1/session")).status).toBe(401);
  }

  it("is refused and ends once its membership is deactivated, and stays ended when it is active again", async () => {
    const { session, membership } = await memberInCompany();
    await changeMembership(app, company, membership, "status = 'inactive'");
    await expectEnded(session);
    await changeMembership(app, company, membership, "status = 'active'");
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
  });

  it("ends when its membership is deactivated, and stays ended when it is active again before its next request", async () => {
    const { session, membership } = await memberInCompany();
    await changeMembership(app, company, membership, "status = 'inactive'");
    expect(await endOf(session)).toBe("membership");
    await changeMembership(app, company, membership, "status = 'active'");
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    expect(await endOf(session)).toBe("membership");
  });

  it("ends when its membership is disconnected, and stays ended when the same person accepts it again before its next request", async () => {
    const { person, session, membership } = await memberInCompany();
    await changeMembership(app, company, membership, "status = 'invited', user_id = NULL");
    await changeMembership(app, company, membership, "status = 'active', user_id = $2", [person.id]);
    expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    expect(await endOf(session)).toBe("membership");
  });

  it("ends only the sessions of the membership that stops being active, and not one that never chose its company", async () => {
    const { person, session, membership } = await memberInCompany();
    const { session: another } = await memberInCompany();
    // A new TOTP code comes with the next 30 seconds.
    server.clock.advance(MINUTE);
    const { session: elsewhere } = await signIn(server, person);
    await changeMembership(app, company, membership, "status = 'removed'");
    expect(await endOf(session)).toBe("membership");
    expect([await endOf(another), await endOf(elsewhere)]).toEqual([null, null]);
    expect((await getAs(server, another, "/v1/company")).status).toBe(200);
    expect((await getAs(server, elsewhere, "/v1/session")).status).toBe(200);
  });

  it("refuses a request whose lookup read the session just before the membership was removed", async () => {
    const { session, membership } = await memberInCompany();
    // The lookup reads the session, and waits before it asks for the membership.
    const held = gate();
    let armed = true;
    const holding: Database = {
      ...pool.database,
      lookup: (channel, work) =>
        pool.database.lookup(channel, (tx) => {
          if (armed) {
            armed = false;
            const actAs = tx.actAs.bind(tx);
            tx.actAs = async (personId, kind) => {
              await held.pass();
              await actAs(personId, kind);
            };
          }
          return work(tx);
        }),
    };
    const reader = signInApp(holding, { clock: server.clock });
    const request = getAs(reader, session, "/v1/company");
    await held.reached;
    await changeMembership(app, company, membership, "status = 'removed'");
    held.open();
    expect((await request).status).toBe(401);
    expect(await endOf(session)).toBe("membership");
  });

  it("is refused and ends once its membership is removed", async () => {
    const { session, membership } = await memberInCompany();
    await changeMembership(app, company, membership, "status = 'removed'");
    await expectEnded(session);
  });

  it("is refused and ends once the person leaves the company", async () => {
    const { person, session, membership } = await memberInCompany();
    await changeMembership(app, company, membership, "status = 'left'", [], { actor: person.id, kind: "user" });
    await expectEnded(session);
  });

  it("is refused and ends once the membership is disconnected and another person accepts it", async () => {
    const { session, membership } = await memberInCompany();
    await changeMembership(app, company, membership, "status = 'invited', user_id = NULL");
    const other = await addIdentity(owner, { name: "Rut Norén" });
    await changeMembership(app, company, membership, "status = 'active', user_id = $2", [other]);
    await expectEnded(session);
  });

  it("is refused and ends when the person holds another membership there now, after a removal and a new invitation", async () => {
    const { person, session, membership } = await memberInCompany();
    await changeMembership(app, company, membership, "status = 'removed'");
    const again = await addMembership(app, owner, company, { status: "invited" });
    await changeMembership(app, company, again, "status = 'active', user_id = $2", [person.id]);
    expect((await membershipOf(app, company.id, again))?.user_id).toBe(person.id);
    await expectEnded(session);
  });

  it("is refused once the person's identity is deleted", async () => {
    const { person, session, membership } = await memberInCompany();
    // The identity leaves the company first, as a deletion will ask (part 6).
    await changeMembership(app, company, membership, "status = 'left'", [], { actor: person.id, kind: "user" });
    await deleteIdentity(app, person.id);
    expect((await getAs(server, session, "/v1/session")).status).toBe(401);
  });

  it("keeps working while the membership stays the person's active one, also when another member changes", async () => {
    const { session } = await memberInCompany();
    const { membership: another } = await memberInCompany();
    await changeMembership(app, company, another, "status = 'inactive'");
    expect((await getAs(server, session, "/v1/company")).status).toBe(200);
  });

  describe("access.choose_company", () => {
    async function choose(app: Client, actor: string, session: string, company: string, membership: string): Promise<boolean> {
      return inTransaction(app, { actor, kind: "user", channel: "rest" }, async () => {
        const found = await app.query<{ chosen: boolean }>("SELECT access.choose_company($1, $2, $3, '{}'::jsonb, 120, pg_catalog.now()) AS chosen", [session, company, membership]);
        return found.rows[0]?.chosen ?? false;
      });
    }

    async function sessionRow(token: string): Promise<{ id: string; current_company_id: string | null }> {
      const found = await owner.query<{ id: string; current_company_id: string | null }>("SELECT id, current_company_id FROM access.sessions WHERE token_hash = $1", [tokenHash(token)]);
      const [row] = found.rows;
      if (row === undefined) {
        throw new Error("No such session.");
      }
      return row;
    }

    it("chooses for the transaction's person's own live session only", async () => {
      const { person, session, membership } = await memberInCompany();
      const { id } = await sessionRow(session);
      const other = await addIdentity(owner, { name: "Tor Lind" });
      expect(await choose(app, other, id, company.id, membership)).toBe(false);
      expect(await choose(app, person.id, randomUUID(), company.id, membership)).toBe(false);
      expect(await choose(app, person.id, id, company.id, membership)).toBe(true);
      expect((await sessionRow(session)).current_company_id).toBe(company.id);
      await owner.query("UPDATE access.sessions SET ended_at = now(), end_reason = 'logout' WHERE id = $1", [id]);
      expect(await choose(app, person.id, id, company.id, membership)).toBe(false);
    });

    it("refuses a membership of another company, by the paired key", async () => {
      const { person, session } = await memberInCompany();
      const elsewhere = await aCompany(app, "Testbolaget Beta AB");
      const { id } = await sessionRow(session);
      await expect(choose(app, person.id, id, company.id, elsewhere.membership)).rejects.toThrow(/sessions_current_membership_fkey/);
    });

    it("holds the second step of a password session, and none of a session of another method", async () => {
      const person = await addIdentity(owner, { name: "Ebba Strand" });
      const at = new Date("2090-03-15T10:00:00.000Z");
      const open = (method: string, secondStep: string | null): Promise<unknown> =>
        anonymously(app, "SELECT access.open_session($1, $2, $3, $4, NULL, $5) AS id", [someTokenHash(), person, method, secondStep, at]);
      await expectError(open("password-email", null), CHECK_VIOLATION, /sessions_second_step_by_method/);
      await expectError(open("password-personnummer", null), CHECK_VIOLATION, /sessions_second_step_by_method/);
      await expectError(open("bankid", "totp"), CHECK_VIOLATION, /sessions_second_step_by_method/);
      await expectError(open("oidc", "known-device"), CHECK_VIOLATION, /sessions_second_step_by_method/);
      await expectError(open("password-email", "sms"), CHECK_VIOLATION, /sessions_second_step_known/);
      for (const [method, secondStep] of [
        ["password-email", "totp"],
        ["password-personnummer", "known-device"],
        ["bankid", null],
        ["oidc", null],
      ] as const) {
        await open(method, secondStep);
      }
      const steps = await owner.query<{ method: string; second_step: string | null }>("SELECT method, second_step FROM access.sessions WHERE identity_id = $1 ORDER BY method", [person]);
      expect(steps.rows).toEqual([
        { method: "bankid", second_step: null },
        { method: "oidc", second_step: null },
        { method: "password-email", second_step: "totp" },
        { method: "password-personnummer", second_step: "known-device" },
      ]);
    });

    it("resolves a session of a method with no second step, and chooses its company", async () => {
      // A BankID sign-in comes in a later part; the owner opens such a session as the lookup function does.
      const person = await addSignInIdentity(owner);
      await addMembership(app, owner, company, { user: person.id });
      const token = newToken("session");
      await owner.query("SELECT access.open_session($1, $2, 'bankid', NULL, NULL, $3)", [tokenHash(token), person.id, server.clock.now()]);
      expect((await getAs(server, token, "/v1/session")).status).toBe(200);
      expect((await chooseCompany(server, token, company.id)).status).toBe(200);
      // The sign-in's entry names no second step: the method had none.
      const superuser = await db.admin();
      const details = await superuser.query<{ details: unknown }>("SELECT details FROM access.events WHERE subject_id = $1", [person.id]);
      expect(details.rows).toEqual([{ details: { method: "bankid", identifiedAt: server.clock.now().toISOString(), application: "web", outcome: "succeeded" } }]);
    });

    it("cannot be read past by the app: the app reads no session", async () => {
      await expect(inTransaction(app, {}, () => app.query("SELECT * FROM access.sessions"))).rejects.toThrow(/permission denied/);
    });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
