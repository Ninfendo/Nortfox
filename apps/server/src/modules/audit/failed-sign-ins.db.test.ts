// SPDX-License-Identifier: AGPL-3.0-only

// H2's company half (issue 12, Behandlingshistorik 2; open point 17 with
// choice 22): a failed sign-in, a wrong password for an identifier that names
// an identity or a wrong TOTP code, is written in the behandlingshistorik of
// each company where the identity is an active member, after the answer, as
// one entry of access.events with the tried identity as the person (choice
// 7): Program "Användare", Rubrik "Inloggning", with the method, the
// application, the IP address and the outcome failed. A burst writes at most
// one entry per identity, company and minute, with the count of failed
// sign-ins of the last hour. One for an identifier that names no identity is
// written nowhere. The person's Kontoaktivitet gets each one
// (account-events.db.test.ts). The server's clock is moved forwards.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addCompanyWithOwner } from "../../../test/ledger.ts";
import { aCompany, addMembership, changeMembership, type Company } from "../../../test/memberships.ts";
import {
  SECOND,
  addSignInIdentity,
  challengeOf,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  passwordStep,
  signIn,
  signInApp,
  testClock,
  totpStep,
  wrongCodeOf,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import type { Database } from "../../db/database.ts";

/** An address of the documentation range (RFC 5737), as a browser's request comes from it. */
const ADDRESS = "192.0.2.31";

interface Entry {
  readonly company_id: string;
  readonly program: string;
  readonly heading: string;
  readonly subject_id: string | null;
  readonly details: Record<string, unknown>;
}

describe("the behandlingshistorik of a failed sign-in", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads the company tables past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock() });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /**
   * A person who owns Alfa, is an active member of Beta, and an inactive one
   * of Gamma, with the three companies.
   */
  async function memberOfTwo(wanted: Parameters<typeof addSignInIdentity>[1] = {}): Promise<{ person: TestIdentity; alfa: string; beta: string; gamma: string }> {
    const person = await addSignInIdentity(owner, wanted);
    const alfa = (await addCompanyWithOwner(app, { actor: person.id, kind: "user" }, { name: "Testbolaget Alfa AB" })).row.company_id;
    const beta: Company = await aCompany(app, "Testbolaget Beta AB");
    await addMembership(app, owner, beta, { user: person.id });
    const gamma: Company = await aCompany(app, "Testbolaget Gamma AB");
    await changeMembership(app, gamma, await addMembership(app, owner, gamma, { user: person.id }), "status = 'inactive'");
    return { person, alfa, beta: beta.id, gamma: gamma.id };
  }

  async function entriesOf(person: TestIdentity): Promise<Entry[]> {
    await server.app.afterAnswer.idle();
    return (await superuser.query<Entry>(
      "SELECT company_id, program, heading, subject_id, details FROM access.events WHERE subject_id = $1 AND details ->> 'outcome' = 'failed' ORDER BY at, company_id",
      [person.id],
    )).rows;
  }

  function failed(company: string, person: TestIdentity, details: Record<string, unknown>): Entry {
    return {
      company_id: company,
      program: "users",
      heading: "sign-in",
      subject_id: person.id,
      details: { application: "web", ipAddress: ADDRESS, outcome: "failed", ...details },
    };
  }

  it("writes a wrong password in each company where the person is an active member, as the person", async () => {
    const { person, alfa, beta } = await memberOfTwo();
    expect((await passwordStep(server, person.email, "fel-lösenord-ett", { ipAddress: ADDRESS })).status).toBe(422);
    const entries = await entriesOf(person);
    expect([...entries].sort((a, b) => a.company_id.localeCompare(b.company_id))).toEqual(
      [failed(alfa, person, { method: "password-email", failuresInLastHour: 1 }), failed(beta, person, { method: "password-email", failuresInLastHour: 1 })].sort((a, b) =>
        a.company_id.localeCompare(b.company_id),
      ),
    );
    // Each entry's history row names the tried identity as the actor, a user.
    const history = await superuser.query<{ actor_id: string; actor_kind: string }>(
      "SELECT DISTINCT actor_id, actor_kind FROM audit.history WHERE table_name = 'access.events' AND company_id IN ($1, $2)",
      [alfa, beta],
    );
    expect(history.rows).toEqual([{ actor_id: person.id, actor_kind: "user" }]);
  });

  it("writes a wrong TOTP code the same way, with the second step", async () => {
    const { person, alfa, beta } = await memberOfTwo({ twoStep: "every_login" });
    const challenge = await challengeOf(await passwordStep(server, person.email, person.password, { ipAddress: ADDRESS }));
    expect((await totpStep(server, challenge, wrongCodeOf(person, server.clock.now()), { ipAddress: ADDRESS })).status).toBe(422);
    const entries = await entriesOf(person);
    expect(entries.map((entry) => entry.company_id).sort()).toEqual([alfa, beta].sort());
    for (const entry of entries) {
      expect(entry).toEqual(failed(entry.company_id, person, { method: "password-email", secondStep: "totp", failuresInLastHour: 1 }));
    }
  });

  it("writes a burst once a minute per company, with the count of the last hour", async () => {
    const { person, alfa, beta } = await memberOfTwo();
    for (const password of ["fel-ett", "fel-två", "fel-tre"]) {
      expect((await passwordStep(server, person.email, password, { ipAddress: ADDRESS })).status).toBe(422);
      await server.app.afterAnswer.idle();
    }
    expect((await entriesOf(person)).map((entry) => [entry.company_id, entry.details["failuresInLastHour"]]).sort()).toEqual(
      [
        [alfa, 1],
        [beta, 1],
      ].sort(),
    );
    server.clock.advance(61 * SECOND);
    expect((await passwordStep(server, person.email, "fel-fyra", { ipAddress: ADDRESS })).status).toBe(422);
    const entries = await entriesOf(person);
    expect(entries).toHaveLength(4);
    expect(entries.slice(2).map((entry) => [entry.company_id, entry.details["failuresInLastHour"]]).sort()).toEqual(
      [
        [alfa, 4],
        [beta, 4],
      ].sort(),
    );
    // Kontoaktivitet got each of the four.
    const account = await owner.query("SELECT 1 FROM access.account_events WHERE identity_id = $1 AND kind = 'sign-in' AND details ->> 'outcome' = 'failed'", [person.id]);
    expect(account.rows).toHaveLength(4);
  });

  it("writes nothing in a company that the person stops being an active member of before its entry is written", async () => {
    const person = await addSignInIdentity(owner);
    const alfa = (await addCompanyWithOwner(app, { actor: person.id, kind: "user" }, { name: "Testbolaget Alfa AB" })).row.company_id;
    const beta: Company = await aCompany(app, "Testbolaget Beta AB");
    const inBeta = await addMembership(app, owner, beta, { user: person.id });
    // Beta deactivates the person once the list of companies is read, before the first entry is written.
    let armed = true;
    const racing: Database = {
      ...pool.database,
      person: (mode, settings, work) =>
        pool.database.person(mode, settings, async (tx) => {
          if (armed && mode === "write" && settings.actorId === person.id) {
            armed = false;
            await changeMembership(app, beta, inBeta, "status = 'inactive'");
          }
          return work(tx);
        }),
    };
    const racer = signInApp(racing, { clock: testClock() });
    expect((await passwordStep(racer, person.email, "fel-lösenord-i-tid", { ipAddress: ADDRESS })).status).toBe(422);
    await racer.app.afterAnswer.idle();
    const entries = await superuser.query<{ company_id: string }>("SELECT company_id FROM access.events WHERE subject_id = $1", [person.id]);
    expect(entries.rows).toEqual([{ company_id: alfa }]);
    // The work after the answer did not fail on it.
    expect(racer.reports).toEqual([]);
  });

  it("writes one for an unknown identifier nowhere", async () => {
    const before = (await superuser.query("SELECT 1 FROM access.events")).rows.length;
    expect((await passwordStep(server, "ingen.alls@example.com", "fel-lösenord", { ipAddress: ADDRESS })).status).toBe(422);
    await server.app.afterAnswer.idle();
    expect((await superuser.query("SELECT 1 FROM access.events")).rows.length).toBe(before);
  });

  it("writes nothing failed for a sign-in that succeeds", async () => {
    const { person } = await memberOfTwo();
    await signIn(server, person, { ipAddress: ADDRESS });
    expect(await entriesOf(person)).toEqual([]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
