// SPDX-License-Identifier: AGPL-3.0-only

// Kontoaktivitet (access.account_events): the person's own events across
// companies. H2's first half: a wrong password and a wrong TOTP code are in
// the person's Kontoaktivitet, each one, with the method, the application
// and the IP address; so is a sign-in. A failed sign-in's actor is the
// identity whose identifier was tried (choice 7), and its entries are
// written after the answer. One for an identifier that names no identity is
// written nowhere. The behandlingshistorik of the person's companies gets
// its entries in a later part, with the companies.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { PERSONAL_IDENTITY_NUMBERS } from "../../../test/identities.ts";
import {
  addSignInIdentity,
  challengeOf,
  codeOf,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  passwordStep,
  signInApp,
  testClock,
  totpStep,
  wrongCodeOf,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";

/** An address of the documentation range (RFC 5737), as a browser's request comes from it. */
const ADDRESS = "192.0.2.24";

interface AccountEvent {
  readonly kind: string;
  readonly details: Record<string, unknown>;
}

describe("Kontoaktivitet of a sign-in", () => {
  let db: TestDatabase;
  let owner: Client;
  let pool: AppPool;
  let server: SignInApp;
  const people: TestIdentity[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock() });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function addPerson(wanted: Parameters<typeof addSignInIdentity>[1] = {}): Promise<TestIdentity> {
    const person = await addSignInIdentity(owner, wanted);
    people.push(person);
    return person;
  }

  async function eventsOf(person: TestIdentity): Promise<AccountEvent[]> {
    await server.app.afterAnswer.idle();
    return (await owner.query<AccountEvent>("SELECT kind, details FROM access.account_events WHERE identity_id = $1 ORDER BY at, id", [person.id])).rows;
  }

  it("holds a wrong password, a wrong TOTP code and the sign-in, each with the method, the application and the IP address", async () => {
    const person = await addPerson();
    const browser = { ipAddress: ADDRESS };
    // Each failure's entry is written after its answer: the test waits for it, so the order is the order of the attempts.
    expect((await passwordStep(server, person.email, "fel-lösenord-först", browser)).status).toBe(422);
    await server.app.afterAnswer.idle();
    const challenge = await challengeOf(await passwordStep(server, person.email, person.password, browser));
    expect((await totpStep(server, challenge, wrongCodeOf(person, server.clock.now()), browser)).status).toBe(422);
    await server.app.afterAnswer.idle();
    expect((await totpStep(server, challenge, codeOf(person, server.clock.now()), browser)).status).toBe(204);
    expect(await eventsOf(person)).toEqual([
      { kind: "sign-in", details: { method: "password-email", application: "web", ipAddress: ADDRESS, outcome: "failed" } },
      { kind: "sign-in", details: { method: "password-email", secondStep: "totp", application: "web", ipAddress: ADDRESS, outcome: "failed" } },
      { kind: "sign-in", details: { method: "password-email", secondStep: "totp", application: "web", ipAddress: ADDRESS, outcome: "succeeded" } },
    ]);
  });

  it("names the personnummer's method, and a sign-in on a known device, and leaves out an address the server does not know", async () => {
    const [number] = PERSONAL_IDENTITY_NUMBERS;
    const person = await addPerson({ personalIdentityNumber: number });
    expect((await passwordStep(server, number, "fel-lösenord-här")).status).toBe(422);
    await server.app.afterAnswer.idle();
    const challenge = await challengeOf(await passwordStep(server, number, person.password));
    const answer = await totpStep(server, challenge, codeOf(person, server.clock.now()));
    const device = answer.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-nortfox-device="))?.split(";")[0]?.split("=")[1] ?? "";
    server.clock.advance(60_000);
    expect((await passwordStep(server, number, person.password, { cookies: { device } })).status).toBe(200);
    expect(await eventsOf(person)).toEqual([
      { kind: "sign-in", details: { method: "password-personnummer", application: "web", outcome: "failed" } },
      { kind: "sign-in", details: { method: "password-personnummer", secondStep: "totp", application: "web", outcome: "succeeded" } },
      { kind: "sign-in", details: { method: "password-personnummer", secondStep: "known-device", application: "web", outcome: "succeeded" } },
    ]);
  });

  it("writes nothing for an identifier that names no identity, nor for an attempt that a limit refused", async () => {
    const person = await addPerson();
    const before = (await owner.query<{ count: bigint }>("SELECT count(*) AS count FROM access.account_events")).rows[0]?.count;
    expect((await passwordStep(server, "ingen.alls@example.com", "något-lösenord")).status).toBe(422);
    await server.app.afterAnswer.idle();
    const after = (await owner.query<{ count: bigint }>("SELECT count(*) AS count FROM access.account_events")).rows[0]?.count;
    expect(after).toBe(before);
    for (let failure = 1; failure <= 5; failure += 1) {
      expect((await passwordStep(server, person.email, "fel-lösenord-igen")).status).toBe(422);
    }
    expect((await passwordStep(server, person.email, "fel-lösenord-igen")).status).toBe(429);
    expect(await eventsOf(person)).toHaveLength(5);
  });

  it("is the person's own: the app reads and adds only the transaction's person's events", async () => {
    const [first, second] = [await addPerson(), await addPerson()];
    expect((await passwordStep(server, first.email, "fel-för-första")).status).toBe(422);
    expect((await passwordStep(server, second.email, "fel-för-andra")).status).toBe(422);
    await server.app.afterAnswer.idle();
    const app = await db.connect("app");
    await app.query("BEGIN");
    await app.query("SELECT set_config('nortfox.actor_id', $1, true), set_config('nortfox.actor_kind', 'user', true), set_config('nortfox.channel', 'rest', true)", [first.id]);
    const seen = await app.query<{ identity_id: string }>("SELECT identity_id FROM access.account_events");
    await app.query("ROLLBACK");
    expect(new Set(seen.rows.map((row) => row.identity_id))).toEqual(new Set([first.id]));
  });

  it("leaves no token in an answer or a report, and no secret in clear in the database", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db, { passwords: people.map((person) => person.password), totpSecrets: people.flatMap((person) => (person.totpSecret === undefined ? [] : [person.totpSecret])) });
  });
});
