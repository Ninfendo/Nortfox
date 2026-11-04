// SPDX-License-Identifier: AGPL-3.0-only

// The limits of the password step (choice 21). Failures count per account:
// the identity's id when the identifier names one, otherwise the HMAC of the
// normalised identifier, so an unknown identifier is counted and limited the
// same way, and the answers never tell the two apart. After 5 failures in an
// hour each further attempt waits 2^(n-5) seconds after the last failure, at
// most 60, and one that comes sooner gets 429 too-many-attempts with
// Retry-After, without its password being checked. At 100 failures in an
// hour every attempt gets that answer until the hour has passed. A right
// password clears the count. The cap writes one Kontoaktivitet event.

import type { Argon2Parameters } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_INSTALL_KEY, appPool, gate, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { expectNoSecretsAtRest, expectNoTokens } from "../../../test/secrets.ts";
import { MINUTE, SECOND, addSignInIdentity, passwordStep, signInApp, testClock, type SignInApp, type TestIdentity } from "../../../test/sign-in.ts";
import { PasswordHasher, nodeArgon2id, type Argon2id } from "../../auth/password.ts";
import { readIdentifier, unknownSubject } from "./identifier.ts";

/** An answer as the tests compare them: its status, Retry-After and problem. */
interface Seen {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly code: string;
}

describe("the limits of the password step", () => {
  let db: TestDatabase;
  let owner: Client;
  let pool: AppPool;
  const people: TestIdentity[] = [];
  const servers: SignInApp[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    pool = appPool(db, 6);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** A server of its own, with a clock of its own and a count of the passwords it checked. */
  function serverWithCount(): { server: SignInApp; checked: Argon2Parameters[] } {
    const checked: Argon2Parameters[] = [];
    const counting: Argon2id = (parameters) => {
      checked.push(parameters);
      return nodeArgon2id(parameters);
    };
    const server = signInApp(pool.database, { clock: testClock(), passwords: new PasswordHasher({ cost: { memory: 64, passes: 1, parallelism: 1 }, argon2id: counting }) });
    servers.push(server);
    return { server, checked };
  }

  async function seen(response: Response): Promise<Seen> {
    return { status: response.status, retryAfter: response.headers.get("retry-after"), code: (await problemIn(response)).code };
  }

  const FAILED: Seen = { status: 422, retryAfter: null, code: "sign-in-failed" };
  const wait = (seconds: number): Seen => ({ status: 429, retryAfter: String(seconds), code: "too-many-attempts" });

  /** The delays after the fifth failure, each twice the one before, at most 60 seconds. */
  const STEPS = [1, 2, 4, 8, 16, 32, 60, 60];

  /**
   * Runs the delays from the first failure on, and gives every answer: five
   * failures, then for each delay an attempt right after the last failure, one
   * a second before its time, and one in time.
   */
  async function delays(server: SignInApp, checked: Argon2Parameters[], identifier: string, password: string): Promise<Seen[]> {
    const answers: Seen[] = [];
    for (let failure = 1; failure <= 5; failure += 1) {
      answers.push(await seen(await passwordStep(server, identifier, password)));
    }
    const tooSoon = async (): Promise<void> => {
      const before = checked.length;
      answers.push(await seen(await passwordStep(server, identifier, password)));
      // An attempt that came too soon checked no password.
      expect(checked.length).toBe(before);
    };
    for (const delay of STEPS) {
      await tooSoon();
      if (delay > 1) {
        server.clock.advance((delay - 1) * SECOND);
        await tooSoon();
      }
      server.clock.advance(SECOND);
      answers.push(await seen(await passwordStep(server, identifier, password)));
    }
    return answers;
  }

  const DELAYS: Seen[] = [FAILED, FAILED, FAILED, FAILED, FAILED, ...STEPS.flatMap((delay) => (delay > 1 ? [wait(delay), wait(1), FAILED] : [wait(1), FAILED]))];

  it("delays every attempt after 5 failures in an hour, for a known identity and for an unknown identifier alike", async () => {
    const person = await addSignInIdentity(owner);
    people.push(person);
    const known = serverWithCount();
    expect(await delays(known.server, known.checked, person.email, "fel-lösenord-varje-gång")).toEqual(DELAYS);
    const unknown = serverWithCount();
    expect(await delays(unknown.server, unknown.checked, "ingen.sadan@example.com", "fel-lösenord-varje-gång")).toEqual(DELAYS);
    // Each answer is the same, also in its detail.
    const sooner = await passwordStep(known.server, person.email, "x");
    const soonerUnknown = await passwordStep(unknown.server, "ingen.sadan@example.com", "x");
    expect(await problemIn(sooner)).toEqual(await problemIn(soonerUnknown));
  });

  it("forgets the failures of a window that has passed, and a right password clears them", async () => {
    const person = await addSignInIdentity(owner);
    people.push(person);
    const { server } = serverWithCount();
    for (let failure = 1; failure <= 5; failure += 1) {
      expect((await passwordStep(server, person.email, "fel-lösenord-här")).status).toBe(422);
    }
    expect((await passwordStep(server, person.email, person.password)).status).toBe(429);
    server.clock.advance(60 * MINUTE);
    expect((await passwordStep(server, person.email, "fel-lösenord-här")).status).toBe(422);
    expect((await passwordStep(server, person.email, person.password)).status).toBe(200);
    const counters = await owner.query("SELECT 1 FROM access.attempt_counters WHERE subject = $1", [person.id]);
    expect(counters.rowCount).toBe(0);
  });

  /** Puts a subject's counter at 99 failures of a window that began `ago` milliseconds before `at`, as only a burst of parallel attempts could. */
  async function ninetyNine(subject: string, at: Date, ago: number): Promise<void> {
    await owner.query(
      `INSERT INTO access.attempt_counters (subject, kind, window_started_at, failures, last_failure_at) VALUES ($1, 'password', $2, 99, $3)`,
      [subject, new Date(at.getTime() - ago), new Date(at.getTime() - 2 * MINUTE)],
    );
  }

  it("stops every attempt at 100 failures until the hour has passed, for a known identity and an unknown identifier alike, and records it once", async () => {
    const person = await addSignInIdentity(owner);
    people.push(person);
    const cases: [string, string][] = [
      [person.email, person.id],
      ["okand.person@example.com", unknownSubject(TEST_INSTALL_KEY, readIdentifier("okand.person@example.com", new Date()))],
    ];
    const answers: Seen[][] = [];
    for (const [identifier, subject] of cases) {
      const { server, checked } = serverWithCount();
      await ninetyNine(subject, server.clock.now(), 20 * MINUTE);
      const seenHere: Seen[] = [await seen(await passwordStep(server, identifier, "det-hundrade-felet"))];
      for (const password of ["fel-igen-efter-taket", person.password]) {
        server.clock.advance(MINUTE);
        const before = checked.length;
        seenHere.push(await seen(await passwordStep(server, identifier, password)));
        expect(checked.length).toBe(before);
      }
      // 40 minutes are left of the window's hour: the attempt after them is checked again.
      server.clock.advance(38 * MINUTE);
      seenHere.push(await seen(await passwordStep(server, identifier, "fel-när-timmen-gått")));
      answers.push(seenHere);
      await server.app.afterAnswer.idle();
    }
    const expected = [FAILED, wait(39 * 60), wait(38 * 60), FAILED];
    expect(answers).toEqual([expected, expected]);
    const events = await owner.query<{ kind: string; details: Record<string, unknown> }>("SELECT kind, details FROM access.account_events WHERE identity_id = $1 AND kind = 'sign-in-locked'", [person.id]);
    expect(events.rows).toEqual([{ kind: "sign-in-locked", details: { step: "password", until: expect.any(String) as unknown } }]);
  });

  it("answers 503 server-busy with Retry-After 1 when the password wrapper runs and queues as many as it may", async () => {
    const person = await addSignInIdentity(owner);
    people.push(person);
    const held = gate();
    const holding: Argon2id = async (parameters) => {
      await held.pass();
      return nodeArgon2id(parameters);
    };
    let checks = 0;
    // The wrapper takes a check into its queue before verify gives its promise.
    class Counting extends PasswordHasher {
      override verify(password: string, stored: string | undefined): Promise<boolean> {
        checks += 1;
        return super.verify(password, stored);
      }
    }
    const server = signInApp(pool.database, { clock: testClock(), passwords: new Counting({ cost: { memory: 64, passes: 1, parallelism: 1 }, argon2id: holding, concurrency: 1 }) });
    servers.push(server);
    const running = passwordStep(server, person.email, "första-i-kön-här");
    await held.reached;
    const queued = passwordStep(server, person.email, "andra-i-kön-här");
    await vi.waitFor(() => {
      expect(checks).toBe(2);
    });
    const busy = await passwordStep(server, person.email, "tredje-får-vänta");
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await problemIn(busy)).toEqual({
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      detail: "The server checks as many passwords as it can at once. Send the request again after the seconds that Retry-After gives.",
      code: "server-busy",
    });
    held.open();
    expect([(await running).status, (await queued).status]).toEqual([422, 422]);
  });

  it("leaves no token in an answer or a report, and no secret in clear in the database", async () => {
    for (const server of servers) {
      const challenges = server.bodies.flatMap((body) => [...body.matchAll(/nfc_[A-Za-z0-9_-]{43}/g)].map((match) => match[0]));
      expectNoTokens([...server.bodies, ...server.reports], challenges);
    }
    await expectNoSecretsAtRest(db, { passwords: people.map((person) => person.password) });
  });
});
