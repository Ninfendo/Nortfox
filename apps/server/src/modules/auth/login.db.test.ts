// SPDX-License-Identifier: AGPL-3.0-only

// I3: a password login works with the e-mail address, in any letter case,
// and with the personnummer, which the test sets as the owner, since the
// operation that adds one comes in a later part. I2's half here: a stored
// password is an Argon2id hash with the pinned parameters. Every failure of
// the password step gets the one answer, 422 sign-in-failed: an unknown
// identifier, a deleted identity, an identity without a password, and a
// wrong password. With no identity or no password, the check runs against
// the dummy hash, so the time does not tell them apart, and the entries of a
// failure are written only after the answer.

import type { Argon2Parameters } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, gate, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { PERSONAL_IDENTITY_NUMBERS, addIdentity, deleteIdentity } from "../../../test/identities.ts";
import { expectNoSecretsAtRest, expectNoTokens } from "../../../test/secrets.ts";
import {
  PASSWORD_FAILED,
  TEST_ORIGIN,
  addSignInIdentity,
  challengeOf,
  codeOf,
  passwordStep,
  postAsBrowser,
  setCookiesOf,
  signIn,
  signInApp,
  signInFailed,
  totpStep,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { PasswordHasher, nodeArgon2id, type Argon2id } from "../../auth/password.ts";
import { base32Decode } from "../../auth/totp.ts";
import type { Database, TransactionSettings } from "../../db/database.ts";
import { createSetupLink } from "../../setup.ts";

/** The first person of the install, made through completeSetup at the production cost. */
const FIRST = { name: "Maja Lind", email: "Maja.Lind@example.com", password: "majas-lösenord-på-riktigt" };

describe("the password sign-in", () => {
  let db: TestDatabase;
  let owner: Client;
  let app: Client;
  let pool: AppPool;
  let server: SignInApp;
  const challenges: string[] = [];
  const passwords: string[] = [FIRST.password];
  const secrets: Buffer[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    app = await db.connect("app");
    pool = appPool(db, 4);
    server = signInApp(pool.database);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function addPerson(wanted: Parameters<typeof addSignInIdentity>[1] = {}): Promise<TestIdentity> {
    const person = await addSignInIdentity(owner, wanted);
    passwords.push(person.password);
    if (person.totpSecret !== undefined) {
      secrets.push(person.totpSecret);
    }
    return person;
  }

  async function challengeFor(identifier: string, password: string): Promise<string> {
    const challenge = await challengeOf(await passwordStep(server, identifier, password));
    challenges.push(challenge);
    return challenge;
  }

  it("keeps a stored password as an Argon2id hash with the pinned parameters, and signs in with it", async () => {
    // The production cost, as main.ts gives the server: this test pins it.
    const production = signInApp(pool.database, { passwords: new PasswordHasher() });
    const link = await createSetupLink(pool.database, TEST_ORIGIN, production.clock.now());
    const made = await postAsBrowser(production, new URL(link.url).pathname, FIRST);
    expect(made.status).toBe(201);
    const { user, totpEnrolment } = (await made.json()) as { user: { id: string }; totpEnrolment: { otpauthUri: string } };
    const stored = await owner.query<{ password_hash: string }>("SELECT password_hash FROM access.password_credentials WHERE identity_id = $1", [user.id]);
    const hash = stored.rows[0]?.password_hash ?? "";
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(hash).not.toContain(FIRST.password);
    const secret = base32Decode(new URL(totpEnrolment.otpauthUri).searchParams.get("secret") ?? "") ?? Buffer.alloc(0);
    secrets.push(secret);
    const person: TestIdentity = { id: user.id, email: FIRST.email, password: FIRST.password, totpSecret: secret };
    // The first code of the pending secret confirms it, and signs the person in.
    const signedIn = await signIn(production, person);
    expect(signedIn.session).toMatch(/^nfs_/);
    const states = await owner.query<{ state: string }>("SELECT state FROM access.totp_secrets WHERE identity_id = $1", [user.id]);
    expect(states.rows.map((row) => row.state)).toEqual(["active"]);
    expectNoTokens([...production.bodies, ...production.reports], challengesIn(production.bodies));
  });

  it("logs in with the e-mail address, in any letter case and in either form of Å", async () => {
    const person = await addPerson({ email: "Åsa.Nilsson@example.com" });
    for (const identifier of ["Åsa.Nilsson@example.com", "åSA.NILSSON@EXAMPLE.COM", "Åsa.nilsson@Example.com", "  åsa.nilsson@example.com "]) {
      const challenge = await challengeFor(identifier, person.password);
      expect(challenge).toMatch(/^nfc_[A-Za-z0-9_-]{43}$/);
    }
    const methods = await owner.query<{ method: string }>("SELECT DISTINCT method FROM access.login_challenges WHERE identity_id = $1", [person.id]);
    expect(methods.rows).toEqual([{ method: "password-email" }]);
  });

  it("logs in with the personnummer, in 12 digits with or without the hyphen and in 10 digits", async () => {
    const [, number] = PERSONAL_IDENTITY_NUMBERS;
    const person = await addPerson({ personalIdentityNumber: number });
    // The server's clock is in 2090, so a person born in 2000 writes 000101-2384 in 10 digits.
    for (const identifier of ["20000101-2384", "200001012384", "000101-2384", "0001012384"]) {
      await challengeFor(identifier, person.password);
    }
    const challenge = await challengeFor(number, person.password);
    expect((await totpStep(server, challenge, codeOf(person, server.clock.now()))).status).toBe(204);
    const sessions = await owner.query<{ method: string }>("SELECT method FROM access.sessions WHERE identity_id = $1", [person.id]);
    expect(sessions.rows).toEqual([{ method: "password-personnummer" }]);
  });

  it("gives one answer, 422 sign-in-failed, for an unknown identifier, a deleted identity, no password and a wrong password", async () => {
    const wrong = await addPerson();
    const deleted = await addPerson();
    await deleteIdentity(app, deleted.id);
    await addIdentity(owner, { email: "utan.losenord@example.com" });
    const tries: [string, string][] = [
      ["nobody@example.com", "något-lösenord-alls"],
      [PERSONAL_IDENTITY_NUMBERS[2], "något-lösenord-alls"],
      [deleted.email, deleted.password],
      ["utan.losenord@example.com", "något-lösenord-alls"],
      [wrong.email, `${wrong.password}x`],
      [wrong.email, "å".repeat(1025)],
    ];
    const answers: unknown[] = [];
    for (const [identifier, password] of tries) {
      const response = await passwordStep(server, identifier, password);
      answers.push({ status: response.status, headers: [...response.headers].sort(), body: await problemIn(response), cookies: response.headers.getSetCookie() });
    }
    expect(answers).toEqual(
      tries.map(() => ({
        status: 422,
        headers: [
          ["cache-control", "no-store"],
          ["content-type", "application/problem+json"],
        ],
        body: signInFailed(PASSWORD_FAILED),
        cookies: [],
      })),
    );
  });

  it("checks against the dummy hash when there is no identity or no password, and against the person's own hash otherwise", async () => {
    const calls: Argon2Parameters[] = [];
    const spy: Argon2id = (parameters) => {
      calls.push(parameters);
      return nodeArgon2id(parameters);
    };
    const watched = signInApp(pool.database, { passwords: new PasswordHasher({ cost: { memory: 64, passes: 1, parallelism: 1 }, argon2id: spy }) });
    const person = await addPerson();
    await addIdentity(owner, { email: "inget.losenord@example.com" });
    const zeroSalt = (call: Argon2Parameters | undefined): boolean => Buffer.from(call?.nonce as Uint8Array).equals(Buffer.alloc(16));
    for (const identifier of ["ingen.alls@example.com", "inget.losenord@example.com"]) {
      calls.length = 0;
      expect((await passwordStep(watched, identifier, "ett-lösenord-här")).status).toBe(422);
      expect(calls).toHaveLength(1);
      expect(zeroSalt(calls[0])).toBe(true);
    }
    calls.length = 0;
    expect((await passwordStep(watched, person.email, "fel-lösenord-här")).status).toBe(422);
    expect(calls).toHaveLength(1);
    expect(zeroSalt(calls[0])).toBe(false);
  });

  it("writes the entries of a failure only after the answer", async () => {
    const person = await addPerson();
    const held = gate();
    const order: string[] = [];
    // The person's own writes wait at the gate: in a failed sign-in, only its entries are such writes.
    const holding: Database = {
      ...pool.database,
      write: async (settings: TransactionSettings, work) => {
        if (settings.actorId === person.id) {
          order.push("entry");
          await held.pass();
        }
        return pool.database.write(settings, work);
      },
    };
    const holdingServer = signInApp(holding);
    const response = await passwordStep(holdingServer, person.email, "fel-lösenord-igen");
    order.push("answer");
    expect(response.status).toBe(422);
    await held.reached;
    const before = await owner.query("SELECT 1 FROM access.account_events WHERE identity_id = $1", [person.id]);
    expect(before.rowCount).toBe(0);
    held.open();
    await holdingServer.app.afterAnswer.idle();
    expect(order).toEqual(["answer", "entry"]);
    const after = await owner.query<{ kind: string; details: Record<string, unknown> }>("SELECT kind, details FROM access.account_events WHERE identity_id = $1", [person.id]);
    expect(after.rows).toEqual([{ kind: "sign-in", details: { method: "password-email", application: "web", outcome: "failed" } }]);
  });

  it("gives no challenge and no session to an identity deleted while its password is checked", async () => {
    for (const twoStep of ["every_login", "new_device_90_days"] as const) {
      const person = await addPerson({ twoStep });
      const device = twoStep === "new_device_90_days" ? (await signIn(server, person)).device : undefined;
      const deleting: Argon2id = async (parameters) => {
        const hash = await nodeArgon2id(parameters);
        await deleteIdentity(app, person.id);
        return hash;
      };
      const racing = signInApp(pool.database, { passwords: new PasswordHasher({ cost: { memory: 64, passes: 1, parallelism: 1 }, argon2id: deleting }) });
      const response = await passwordStep(racing, person.email, person.password, device === undefined ? {} : { cookies: { device } });
      expect(response.status).toBe(422);
      expect(await problemIn(response)).toEqual(signInFailed(PASSWORD_FAILED));
      expect(setCookiesOf(response)).toEqual({});
    }
  });

  it("refuses an identifier or a password of the wrong shape as a field problem", async () => {
    const response = await postAsBrowser(server, "/v1/auth/password", { identifier: "", password: "", extra: true });
    expect(response.status).toBe(400);
    expect((await problemIn(response)).errors?.map((error) => [error.code, error.pointer])).toEqual([
      ["too-short", "/identifier"],
      ["too-short", "/password"],
      ["unknown-field", "/extra"],
    ]);
  });

  it("leaves no token but its challenges in an answer or a report, and no secret in clear in the database", async () => {
    expect(challengesIn(server.bodies)).toEqual(expect.arrayContaining(challenges));
    expectNoTokens([...server.bodies, ...server.reports], challengesIn(server.bodies));
    await expectNoSecretsAtRest(db, { passwords, totpSecrets: secrets });
  });
});

/** The login challenges in a list of answers' bodies. */
function challengesIn(bodies: readonly string[]): string[] {
  return bodies.flatMap((body) => [...body.matchAll(/"challenge":"(nfc_[A-Za-z0-9_-]{43})"/g)].map((match) => match[1] ?? ""));
}
