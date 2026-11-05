// SPDX-License-Identifier: AGPL-3.0-only

// A session that works in a company keeps the membership it chose the
// company with (issue 12, Sessions 2 and 3). The resolver asks the one
// membership function on every request: when the session's membership is no
// longer the person's active membership there, because it was deactivated,
// removed, left, or given another person, or the person holds another
// membership there now, the request is refused as one with no actor, and the
// session ends with the reason membership. The database ends it already
// when the membership stops being active, so it stays ended when the
// membership comes back, also with no request between. A choice of the
// company that runs while the membership is deactivated either is refused,
// or comes first and its session ends with the deactivation, so it never
// keeps the membership; one that runs while the membership is disconnected
// and given another person is refused too. access.choose_company, the lookup function that
// stores the session's choice, chooses only for the transaction's person's
// own live session.

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Client, QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, gate, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { CHECK_VIOLATION, backendPid, expectError, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, anonymously, deleteIdentity, tokenHash as someTokenHash } from "../../../test/identities.ts";
import { aCompany, addMembership, changeMembership, membershipOf, type Company } from "../../../test/memberships.ts";
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
import { newToken, tokenHash } from "../../auth/tokens.ts";
import type { Database, PersonQueryable } from "../../db/database.ts";

/**
 * Waits until `change`, which runs on the backend `pid`, has ended, or
 * waits for a lock that another transaction holds. `observer` logs in as the
 * same role, which pg_stat_activity shows that backend's wait to.
 */
async function untilDoneOrWaiting(observer: Client, pid: number, change: Promise<unknown>): Promise<void> {
  const state = { done: false };
  const settle = (): void => {
    state.done = true;
  };
  void change.then(settle, settle);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const found = await observer.query<{ waiting: boolean }>(
      "SELECT wait_event_type IS NOT DISTINCT FROM 'Lock' AS waiting FROM pg_catalog.pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (state.done || found.rows[0]?.waiting === true) {
      return;
    }
    await delay(10);
  }
  throw new Error(`The change on the backend ${String(pid)} neither ended nor waited for a lock.`);
}

/** Notes in `seen` each statement of `tx` that names `text`, once it has run. */
function noteStatements(tx: PersonQueryable, text: string, seen: { count: number }): void {
  const query = tx.query.bind(tx);
  tx.query = async <Row extends QueryResultRow = QueryResultRow>(statement: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
    const result = await query<Row>(statement, values);
    if (statement.includes(text)) {
      seen.count += 1;
    }
    return result;
  };
}

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

  it("refuses a request whose lookup read the session just before the person got another membership there", async () => {
    const { person, session, membership } = await memberInCompany();
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
    // The membership is removed, and the person accepts a new invitation to the same company: the one function gives that one now.
    await changeMembership(app, company, membership, "status = 'removed'");
    const again = await addMembership(app, owner, company, { status: "invited" });
    await changeMembership(app, company, again, "status = 'active', user_id = $2", [person.id]);
    held.open();
    expect((await request).status).toBe(401);
    expect(await endOf(session)).toBe("membership");
    expect((await getAs(server, session, "/v1/session")).status).toBe(401);
  });

  describe("a choice of the company while its membership is deactivated", () => {
    /** A member of the company, signed in, whose session works in no company yet. */
    async function memberInNoCompany(): Promise<{ person: TestIdentity; session: string; membership: string }> {
      const person = await addSignInIdentity(owner);
      const membership = await addMembership(app, owner, company, { user: person.id });
      const { session } = await signIn(server, person);
      return { person, session, membership };
    }

    async function choiceOf(session: string): Promise<{ current_membership_id: string | null; idle_timeout_minutes: number; end_reason: string | null } | undefined> {
      return (await owner.query<{ current_membership_id: string | null; idle_timeout_minutes: number; end_reason: string | null }>(
        "SELECT current_membership_id, idle_timeout_minutes, end_reason FROM access.sessions WHERE token_hash = $1",
        [tokenHash(session)],
      )).rows[0];
    }

    /** The server over a database whose first entry of a company runs `afterEnter` after it, in the choice's transaction. */
    function enteringWith(afterEnter: () => Promise<unknown>): SignInApp {
      let armed = true;
      const racing: Database = {
        ...pool.database,
        person: (mode, settings, work) =>
          pool.database.person(mode, settings, (tx) => {
            const enter = tx.enter.bind(tx);
            tx.enter = async (membership) => {
              await enter(membership);
              if (armed) {
                armed = false;
                await afterEnter();
              }
            };
            return work(tx);
          }),
      };
      return signInApp(racing, { clock: server.clock });
    }

    it("refuses the choice when the deactivation commits after the runner found the membership active", async () => {
      const { person, session, membership } = await memberInNoCompany();
      // The runner has asked the one function and entered the company; the deactivation commits before the choice is stored.
      const racer = enteringWith(() => changeMembership(app, company, membership, "status = 'inactive'"));
      const refused = await jsonOf<ProblemBody>(await chooseCompany(racer, session, company.id), 422);
      expect(refused).toMatchObject({ code: "company-not-available", pointer: "/companyId" });
      // Nothing of the choice is kept: the session works in no company, and there is no recent company and no sign-in entry.
      expect(await choiceOf(session)).toEqual({ current_membership_id: null, idle_timeout_minutes: 120, end_reason: null });
      expect((await owner.query("SELECT 1 FROM access.recent_companies WHERE identity_id = $1", [person.id])).rows).toEqual([]);
      const superuser = await db.admin();
      expect((await superuser.query("SELECT 1 FROM access.events WHERE company_id = $1 AND subject_id = $2", [company.id, person.id])).rows).toEqual([]);
      // When the membership is active again, the session still works in no company.
      await changeMembership(app, company, membership, "status = 'active'");
      expect((await jsonOf<ProblemBody>(await getAs(server, session, "/v1/company"), 403)).code).toBe("company-required");
    });

    it("refuses the choice when the membership is disconnected and another person accepts it after the runner found it active", async () => {
      const { person, session, membership } = await memberInNoCompany();
      // Both changes commit after the runner entered the company, before the choice locks the membership: it is active, and someone else's.
      const other = await addIdentity(owner, { name: "Rut Norén" });
      const racer = enteringWith(async () => {
        await changeMembership(app, company, membership, "status = 'invited', user_id = NULL");
        await changeMembership(app, company, membership, "status = 'active', user_id = $2", [other]);
      });
      const refused = await jsonOf<ProblemBody>(await chooseCompany(racer, session, company.id), 422);
      expect(refused).toMatchObject({ code: "company-not-available", pointer: "/companyId" });
      // Nothing of the choice is kept for the person.
      expect(await choiceOf(session)).toEqual({ current_membership_id: null, idle_timeout_minutes: 120, end_reason: null });
      expect((await owner.query("SELECT 1 FROM access.recent_companies WHERE identity_id = $1", [person.id])).rows).toEqual([]);
      const superuser = await db.admin();
      expect((await superuser.query("SELECT 1 FROM access.events WHERE company_id = $1 AND subject_id = $2", [company.id, person.id])).rows).toEqual([]);
      expect((await jsonOf<ProblemBody>(await getAs(server, session, "/v1/company"), 403)).code).toBe("company-required");
    });

    it("ends the session when the deactivation comes while the choice is stored but not committed, and keeps it ended after a reactivation", async () => {
      const { session, membership } = await memberInNoCompany();
      // A connection of its own for the deactivation, which close() ends.
      const changer = await db.connect("app");
      const changerPid = await backendPid(changer);
      let deactivation: Promise<unknown> | undefined;
      const racing: Database = {
        ...pool.database,
        person: (mode, settings, work) =>
          pool.database.person(mode, settings, async (tx) => {
            const chose = { count: 0 };
            noteStatements(tx, "access.choose_company", chose);
            const ending = await work(tx);
            if (chose.count > 0 && deactivation === undefined) {
              // The choice is stored and not committed. The deactivation comes now: it either waits for the choice's commit or goes through.
              deactivation = changeMembership(changer, company, membership, "status = 'inactive'");
              await untilDoneOrWaiting(app, changerPid, deactivation);
            }
            return ending;
          }),
      };
      const racer = signInApp(racing, { clock: server.clock });
      expect((await chooseCompany(racer, session, company.id)).status).toBe(200);
      await deactivation;
      expect((await choiceOf(session))?.end_reason).toBe("membership");
      await changeMembership(app, company, membership, "status = 'active'");
      expect((await getAs(server, session, "/v1/company")).status).toBe(401);
    });

    it("stores the idle time that the membership holds once the choice has locked it", async () => {
      const { session, membership } = await memberInNoCompany();
      // The idle time changes after the runner read the membership, before the choice locks it.
      const racer = enteringWith(() => changeMembership(app, company, membership, "idle_timeout_minutes = 15"));
      expect((await chooseCompany(racer, session, company.id)).status).toBe(200);
      expect(await choiceOf(session)).toEqual({ current_membership_id: membership, idle_timeout_minutes: 15, end_reason: null });
    });
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
