// SPDX-License-Identifier: AGPL-3.0-only

// The limits of the TOTP step (choice 3). A login challenge takes five
// codes, and each attempt is claimed before its code is checked, so parallel
// calls on one challenge get five in all; the fifth wrong code ends it. Ten
// wrong codes of one identity in 15 minutes, across its challenges, lock its
// TOTP step for 15 minutes with 429 too-many-attempts, and Kontoaktivitet
// records the lock. A code works once: the same code sent twice at once
// gives one session.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { addTotpSecret, deleteIdentity } from "../../../test/identities.ts";
import { expectNoSecretsAtRest } from "../../../test/secrets.ts";
import {
  CODE_FAILED,
  MINUTE,
  SECOND,
  addSignInIdentity,
  challengeOf,
  codeOf,
  expectNoTokensFromSignInApps,
  holdingWrites,
  passwordStep,
  setCookiesOf,
  signInApp,
  signInFailed,
  testClock,
  totpStep,
  untilSomeoneWaitsForLock,
  wrongCodeOf,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";

describe("the limits of the TOTP step", () => {
  let db: TestDatabase;
  let owner: Client;
  let app: Client;
  let observer: Client;
  let pool: AppPool;
  let server: SignInApp;
  const people: TestIdentity[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    app = await db.connect("app");
    observer = await db.connect("app");
    pool = appPool(db, 10);
    server = signInApp(pool.database, { clock: testClock() });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function addPerson(): Promise<TestIdentity> {
    const person = await addSignInIdentity(owner, { twoStep: "every_login" });
    people.push(person);
    return person;
  }

  async function challengeFor(person: TestIdentity): Promise<string> {
    return challengeOf(await passwordStep(server, person.email, person.password));
  }

  async function wrongAttempts(challenge: string): Promise<number | undefined> {
    const found = await owner.query<{ wrong_attempts: number }>("SELECT wrong_attempts FROM access.login_challenges WHERE token_hash = sha256($1::bytea)", [Buffer.from(challenge)]);
    return found.rows[0]?.wrong_attempts;
  }

  async function failures(person: TestIdentity): Promise<number | undefined> {
    const found = await owner.query<{ failures: number }>("SELECT failures FROM access.attempt_counters WHERE subject = $1 AND kind = 'totp'", [person.id]);
    return found.rows[0]?.failures;
  }

  async function sessionsOf(person: TestIdentity): Promise<number> {
    const found = await owner.query("SELECT 1 FROM access.sessions WHERE identity_id = $1", [person.id]);
    return found.rowCount ?? 0;
  }

  it("takes five codes per challenge, and the fifth wrong code ends it", async () => {
    const person = await addPerson();
    const ending = await challengeFor(person);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await totpStep(server, ending, wrongCodeOf(person, server.clock.now()));
      expect(await problemIn(response)).toEqual(signInFailed(CODE_FAILED));
    }
    const late = await totpStep(server, ending, codeOf(person, server.clock.now()));
    expect(await problemIn(late)).toEqual(signInFailed(CODE_FAILED));
    expect(await sessionsOf(person)).toBe(0);
    // Four wrong codes leave the fifth attempt, and a right code then gives the session and its attempt back.
    server.clock.advance(15 * MINUTE);
    const lasting = await challengeFor(person);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await totpStep(server, lasting, wrongCodeOf(person, server.clock.now()))).status).toBe(422);
    }
    expect((await totpStep(server, lasting, codeOf(person, server.clock.now()))).status).toBe(204);
    expect(await wrongAttempts(lasting)).toBe(4);
  });

  it("claims each attempt before its code is checked, so parallel calls get five in all", async () => {
    server.clock.advance(15 * MINUTE);
    const person = await addPerson();
    const challenge = await challengeFor(person);
    const answers = await Promise.all(Array.from({ length: 8 }, () => totpStep(server, challenge, wrongCodeOf(person, server.clock.now()))));
    expect(answers.map((answer) => answer.status)).toEqual(Array.from({ length: 8 }, () => 422));
    expect(await wrongAttempts(challenge)).toBe(5);
    // Only the five claimed attempts were checked, and count as the identity's failures.
    expect(await failures(person)).toBe(5);
    expect((await totpStep(server, challenge, codeOf(person, server.clock.now()))).status).toBe(422);
    expect(await sessionsOf(person)).toBe(0);
  });

  it("locks the identity's TOTP step for 15 minutes after ten wrong codes in 15 minutes, and Kontoaktivitet records it", async () => {
    server.clock.advance(15 * MINUTE);
    const person = await addPerson();
    for (let round = 1; round <= 2; round += 1) {
      const challenge = await challengeFor(person);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect((await totpStep(server, challenge, wrongCodeOf(person, server.clock.now()))).status).toBe(422);
        server.clock.advance(10 * SECOND);
      }
    }
    expect(await failures(person)).toBe(10);
    const lockedAt = new Date(server.clock.now().getTime() - 10 * SECOND);
    const challenge = await challengeFor(person);
    const locked = await totpStep(server, challenge, codeOf(person, server.clock.now()));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe(String(15 * 60 - 10));
    expect(await problemIn(locked)).toEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many failed attempts. Wait the seconds that Retry-After gives before the next one.",
      code: "too-many-attempts",
    });
    // A refused attempt claims nothing of the challenge, and counts no failure.
    expect(await wrongAttempts(challenge)).toBe(0);
    expect(await failures(person)).toBe(10);
    await server.app.afterAnswer.idle();
    const events = await owner.query<{ kind: string; details: Record<string, unknown> }>(
      "SELECT kind, details FROM access.account_events WHERE identity_id = $1 AND kind = 'sign-in-locked'",
      [person.id],
    );
    expect(events.rows).toEqual([{ kind: "sign-in-locked", details: { step: "totp", until: new Date(lockedAt.getTime() + 15 * MINUTE).toISOString() } }]);
    // Once the 15 minutes have passed, the right code of the same challenge works.
    server.clock.advance(15 * MINUTE - 10 * SECOND);
    const answer = await totpStep(server, challenge, codeOf(person, server.clock.now()));
    expect(answer.status).toBe(204);
  });

  it("checks at most ten codes of one identity from a parallel burst across its challenges, and refuses the rest with 429", async () => {
    server.clock.advance(15 * MINUTE);
    const person = await addPerson();
    const challenges: string[] = [];
    for (let count = 0; count < 5; count += 1) {
      challenges.push(await challengeFor(person));
    }
    const wrong = wrongCodeOf(person, server.clock.now());
    const burst = await Promise.all(challenges.flatMap((challenge) => Array.from({ length: 5 }, () => totpStep(server, challenge, wrong))));
    const statuses = burst.map((answer) => answer.status);
    expect(statuses.filter((status) => status === 422)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
    expect(await failures(person)).toBe(10);
    // The step is locked: a right code on a new challenge is refused too.
    expect((await totpStep(server, await challengeFor(person), codeOf(person, server.clock.now()))).status).toBe(429);
    expect(await sessionsOf(person)).toBe(0);
    await server.app.afterAnswer.idle();
    const locks = await owner.query("SELECT 1 FROM access.account_events WHERE identity_id = $1 AND kind = 'sign-in-locked'", [person.id]);
    expect(locks.rowCount).toBe(1);
  });

  it("takes a right code until 20 minutes after the password step, and refuses it from then on", async () => {
    server.clock.advance(15 * MINUTE);
    const person = await addPerson();
    const inTime = await challengeFor(person);
    server.clock.advance(20 * MINUTE - SECOND);
    expect((await totpStep(server, inTime, codeOf(person, server.clock.now()))).status).toBe(204);
    const late = await challengeFor(person);
    server.clock.advance(20 * MINUTE);
    expect(await problemIn(await totpStep(server, late, codeOf(person, server.clock.now())))).toEqual(signInFailed(CODE_FAILED));
    expect(await sessionsOf(person)).toBe(1);
  });

  it("counts a code sent again, whose step is used, as a wrong code of the identity", async () => {
    server.clock.advance(MINUTE);
    const person = await addPerson();
    const code = codeOf(person, server.clock.now());
    expect((await totpStep(server, await challengeFor(person), code)).status).toBe(204);
    expect(await failures(person)).toBeUndefined();
    expect((await totpStep(server, await challengeFor(person), code)).status).toBe(422);
    expect(await failures(person)).toBe(1);
  });

  it("gives one session for one code sent twice at once, on one challenge or on two", async () => {
    server.clock.advance(MINUTE);
    const person = await addPerson();
    const challenge = await challengeFor(person);
    const code = codeOf(person, server.clock.now());
    const twice = await Promise.all([totpStep(server, challenge, code), totpStep(server, challenge, code)]);
    expect(twice.map((answer) => answer.status).sort()).toEqual([204, 422]);
    expect(twice.map((answer) => Object.keys(setCookiesOf(answer)).length).sort()).toEqual([0, 2]);
    expect(await sessionsOf(person)).toBe(1);

    server.clock.advance(MINUTE);
    const [first, second] = [await challengeFor(person), await challengeFor(person)];
    const again = codeOf(person, server.clock.now());
    const across = await Promise.all([totpStep(server, first, again), totpStep(server, second, again)]);
    expect(across.map((answer) => answer.status).sort()).toEqual([204, 422]);
    expect(await sessionsOf(person)).toBe(2);
    // A code sent again later, on a new challenge, is refused too: its step is used.
    const third = await challengeFor(person);
    expect((await totpStep(server, third, again)).status).toBe(422);
    expect(await sessionsOf(person)).toBe(2);
  });

  it("gives no attempt to a call that finds the challenge while a parallel fifth attempt has claimed the last one", async () => {
    server.clock.advance(MINUTE);
    const person = await addPerson();
    const challenge = await challengeFor(person);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await totpStep(server, challenge, wrongCodeOf(person, server.clock.now()))).status).toBe(422);
    }
    await server.app.afterAnswer.idle();
    // The fifth attempt's claim waits before its commit, holding the challenge's row.
    const holding = holdingWrites(pool.database, (settings) => settings.actorId === undefined, "commit");
    const racing = signInApp(holding.database, { clock: server.clock });
    const fifth = totpStep(racing, challenge, wrongCodeOf(person, server.clock.now()));
    await holding.gate.reached;
    // A right code finds the challenge with an attempt left, and its claim waits for the fifth's.
    const late = totpStep(racing, challenge, codeOf(person, server.clock.now()));
    await untilSomeoneWaitsForLock(observer);
    holding.gate.open();
    expect(await problemIn(await late)).toEqual(signInFailed(CODE_FAILED));
    expect((await fifth).status).toBe(422);
    await racing.app.afterAnswer.idle();
    expect(await wrongAttempts(challenge)).toBe(5);
    expect(await failures(person)).toBe(5);
    expect(await sessionsOf(person)).toBe(0);
  });

  it("gives no session to a right code whose challenge a parallel right code used first, and counts no failure for it", async () => {
    server.clock.advance(MINUTE);
    const person = await addPerson();
    const challenge = await challengeFor(person);
    const code = codeOf(person, server.clock.now());
    // The first call's session waits before its work, after its claim and its check.
    const holding = holdingWrites(pool.database, (settings) => settings.actorId === person.id, "start");
    const racing = signInApp(holding.database, { clock: server.clock });
    const first = totpStep(racing, challenge, code);
    await holding.gate.reached;
    const second = await totpStep(racing, challenge, code);
    expect(second.status).toBe(204);
    holding.gate.open();
    const lost = await first;
    expect(await problemIn(lost)).toEqual(signInFailed(CODE_FAILED));
    expect(setCookiesOf(lost)).toEqual({});
    expect(await sessionsOf(person)).toBe(1);
    expect(await failures(person)).toBeUndefined();
  });

  it("gives no session to an identity deleted before its code is checked, or while it is", async () => {
    server.clock.advance(MINUTE);
    const before = await addPerson();
    const challenge = await challengeFor(before);
    await deleteIdentity(app, before.id);
    expect(await problemIn(await totpStep(server, challenge, codeOf(before, server.clock.now())))).toEqual(signInFailed(CODE_FAILED));
    expect(await wrongAttempts(challenge)).toBe(0);

    const during = await addPerson();
    const live = await challengeFor(during);
    const holding = holdingWrites(pool.database, (settings) => settings.actorId === during.id, "start");
    const racing = signInApp(holding.database, { clock: server.clock });
    const answer = totpStep(racing, live, codeOf(during, server.clock.now()));
    await holding.gate.reached;
    await deleteIdentity(app, during.id);
    holding.gate.open();
    const refused = await answer;
    expect(await problemIn(refused)).toEqual(signInFailed(CODE_FAILED));
    expect(setCookiesOf(refused)).toEqual({});
    expect(await sessionsOf(during)).toBe(0);
  });

  it("refuses every code of an identity without a TOTP secret, or whose secret does not open with the install key, as a wrong code", async () => {
    server.clock.advance(MINUTE);
    const without = await addSignInIdentity(owner, { twoStep: "every_login", totp: "none" });
    const foreign = await addSignInIdentity(owner, { twoStep: "every_login", totp: "none" });
    await addTotpSecret(owner, foreign.id, "active");
    people.push(without, foreign);
    for (const person of [without, foreign]) {
      const challenge = await challengeFor(person);
      expect(await problemIn(await totpStep(server, challenge, "123456"))).toEqual(signInFailed(CODE_FAILED));
      expect(await failures(person)).toBe(1);
    }
  });

  it("leaves no token but its challenges in an answer or a report, and no secret in clear in the database", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRest(db, { passwords: people.map((person) => person.password), totpSecrets: people.flatMap((person) => (person.totpSecret === undefined ? [] : [person.totpSecret])) });
  });
});
