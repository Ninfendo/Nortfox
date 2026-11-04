// SPDX-License-Identifier: AGPL-3.0-only

// I4: with every_login, a password login gives no session without a valid
// TOTP code. With new_device_90_days, it gives none on a new device, nor on a
// known device 90 days after its last TOTP step, and on a known device
// inside those 90 days it gives a session without a code. A device is known
// once a TOTP step has passed on it. A new identity starts with
// new_device_90_days (open point 15). The test sets every_login as the
// owner, since the operation that changes it comes in a later part. The
// server's clock is moved forwards for the 90 days.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, problemIn, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
  DAY,
  MINUTE,
  TEST_ORIGIN,
  addSignInIdentity,
  challengeOf,
  codeOf,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  passwordStep,
  postAsBrowser,
  sendAsBrowser,
  setCookiesOf,
  signIn,
  signInApp,
  testClock,
  totpStep,
  type SignInApp,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { base32Decode } from "../../auth/totp.ts";
import { tokenHash } from "../../auth/tokens.ts";
import { createSetupLink } from "../../setup.ts";

describe("the TOTP step of a password sign-in", () => {
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

  async function addPerson(twoStep?: "every_login" | "new_device_90_days"): Promise<TestIdentity> {
    const person = await addSignInIdentity(owner, twoStep === undefined ? {} : { twoStep });
    people.push(person);
    return person;
  }

  /** The answer of a password step: a session, or the TOTP step. */
  async function passwordAnswer(person: TestIdentity, device?: string): Promise<{ status: number; body: unknown; cookies: string[] }> {
    const response = await passwordStep(server, person.email, person.password, device === undefined ? {} : { cookies: { device } });
    return { status: response.status, body: await response.json(), cookies: Object.keys(setCookiesOf(response)) };
  }

  const TOTP_REQUIRED = { outcome: "totp-required", challenge: expect.stringMatching(/^nfc_/) as unknown };

  it("is the first identity's default: new_device_90_days", async () => {
    const link = await createSetupLink(pool.database, TEST_ORIGIN, server.clock.now());
    const made = await postAsBrowser(server, new URL(link.url).pathname, { name: "Ines Ek", email: "ines.ek@example.com", password: "ines-eget-lösenord" });
    expect(made.status).toBe(201);
    const { user, totpEnrolment } = (await made.json()) as { user: { id: string }; totpEnrolment: { otpauthUri: string } };
    const stored = await owner.query<{ two_step: string }>("SELECT two_step FROM access.identities WHERE id = $1", [user.id]);
    expect(stored.rows).toEqual([{ two_step: "new_device_90_days" }]);
    const secret = base32Decode(new URL(totpEnrolment.otpauthUri).searchParams.get("secret") ?? "") ?? Buffer.alloc(0);
    const person: TestIdentity = { id: user.id, email: "ines.ek@example.com", password: "ines-eget-lösenord", totpSecret: secret };
    people.push(person);
    // So, once a TOTP step has passed on the device, the next password login there gives a session at once.
    const { device } = await signIn(server, person);
    server.clock.advance(MINUTE);
    expect(await passwordAnswer(person, device)).toEqual({ status: 200, body: { outcome: "signed-in" }, cookies: ["__Host-nortfox-session"] });
  });

  it("every_login asks a code on every login, also on a known device", async () => {
    const person = await addPerson("every_login");
    expect(await passwordAnswer(person)).toEqual({ status: 200, body: TOTP_REQUIRED, cookies: [] });
    const { device } = await signIn(server, person);
    server.clock.advance(MINUTE);
    expect(await passwordAnswer(person, device)).toEqual({ status: 200, body: TOTP_REQUIRED, cookies: [] });
    // No session comes without the code: the challenge alone signs nobody in.
    const sessions = await owner.query("SELECT 1 FROM access.sessions WHERE identity_id = $1", [person.id]);
    expect(sessions.rowCount).toBe(1);
  });

  it("new_device_90_days asks a code on a new device, and on a device the person does not know", async () => {
    const person = await addPerson("new_device_90_days");
    const other = await addPerson();
    expect(await passwordAnswer(person)).toEqual({ status: 200, body: TOTP_REQUIRED, cookies: [] });
    // A device that another person knows is new to this one.
    const { device } = await signIn(server, other);
    expect(await passwordAnswer(person, device)).toEqual({ status: 200, body: TOTP_REQUIRED, cookies: [] });
    // A device cookie that is no device token is no device.
    expect(await passwordAnswer(person, "nfs_" + "A".repeat(43))).toEqual({ status: 200, body: TOTP_REQUIRED, cookies: [] });
  });

  it("and gives a session without a code on a known device inside its 90 days", async () => {
    const person = await addPerson();
    const { device } = await signIn(server, person);
    server.clock.advance(90 * DAY - MINUTE);
    const response = await passwordStep(server, person.email, person.password, { cookies: { device } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "signed-in" });
    const session = setCookiesOf(response)["__Host-nortfox-session"]?.value ?? "";
    const me = await sendAsBrowser(server, "GET", "/v1/session", { cookies: { session } });
    expect(me.status).toBe(200);
    const stored = await owner.query<{ device_id: string | null }>("SELECT device_id FROM access.sessions WHERE token_hash = $1", [tokenHash(session)]);
    const known = await owner.query<{ id: string }>("SELECT id FROM access.known_devices WHERE device_hash = $1", [tokenHash(device)]);
    expect(stored.rows[0]?.device_id).toBe(known.rows[0]?.id);
  });

  it("and on a known device 90 days after its last TOTP step", async () => {
    const person = await addPerson();
    const { device } = await signIn(server, person);
    server.clock.advance(90 * DAY);
    expect(await passwordAnswer(person, device)).toEqual({ status: 200, body: TOTP_REQUIRED, cookies: [] });
    // A new TOTP step on the device counts its 90 days again, and keeps the device it was.
    const challenge = await challengeOf(await passwordStep(server, person.email, person.password, { cookies: { device } }));
    const answer = await totpStep(server, challenge, codeOf(person, server.clock.now()), { cookies: { device } });
    expect(answer.status).toBe(204);
    expect(Object.keys(setCookiesOf(answer))).toEqual(["__Host-nortfox-session"]);
    server.clock.advance(MINUTE);
    expect(await passwordAnswer(person, device)).toEqual({ status: 200, body: { outcome: "signed-in" }, cookies: ["__Host-nortfox-session"] });
  });

  it("makes the browser a known device when the TOTP step passes, and sets its cookie when it had none", async () => {
    const person = await addPerson();
    const challenge = await challengeOf(await passwordStep(server, person.email, person.password));
    const answer = await totpStep(server, challenge, codeOf(person, server.clock.now()));
    expect(answer.status).toBe(204);
    const device = setCookiesOf(answer)["__Host-nortfox-device"]?.value ?? "";
    expect(device).toMatch(/^nfd_[A-Za-z0-9_-]{43}$/);
    const known = await owner.query<{ identity_id: string; last_totp_at: Date }>("SELECT identity_id, last_totp_at FROM access.known_devices WHERE device_hash = $1", [tokenHash(device)]);
    expect(known.rows).toEqual([{ identity_id: person.id, last_totp_at: server.clock.now() }]);
  });

  it("never makes a device token that the server did not give the person a known device, so a token put in the browser before skips no TOTP step", async () => {
    const person = await addPerson();
    const other = await addPerson();
    // A token someone chose, and one the server gave another person: neither is this person's device.
    const chosen = `nfd_${"Q".repeat(43)}`;
    const othersDevice = (await signIn(server, other)).device;
    for (const planted of [chosen, othersDevice]) {
      const challenge = await challengeOf(await passwordStep(server, person.email, person.password, { cookies: { device: planted } }));
      const answer = await totpStep(server, challenge, codeOf(person, server.clock.now()), { cookies: { device: planted } });
      expect(answer.status).toBe(204);
      const given = setCookiesOf(answer)["__Host-nortfox-device"]?.value ?? "";
      expect(given).toMatch(/^nfd_[A-Za-z0-9_-]{43}$/);
      expect(given).not.toBe(planted);
      server.clock.advance(MINUTE);
      // The planted token still asks for a code, and the one the server gave signs in at once.
      expect(await passwordAnswer(person, planted)).toEqual({ status: 200, body: TOTP_REQUIRED, cookies: [] });
      expect(await passwordAnswer(person, given)).toEqual({ status: 200, body: { outcome: "signed-in" }, cookies: ["__Host-nortfox-session"] });
      const known = await owner.query("SELECT 1 FROM access.known_devices WHERE identity_id = $1 AND device_hash = $2", [person.id, tokenHash(planted)]);
      expect(known.rowCount).toBe(0);
    }
  });

  it("refuses a code that is not the person's, and gives no session for it", async () => {
    const person = await addPerson();
    const other = await addPerson();
    const challenge = await challengeOf(await passwordStep(server, person.email, person.password));
    const response = await totpStep(server, challenge, codeOf(other, server.clock.now()));
    expect(response.status).toBe(422);
    expect((await problemIn(response)).code).toBe("sign-in-failed");
    expect(setCookiesOf(response)).toEqual({});
  });

  it("leaves no token but its challenges in an answer or a report, and no secret in clear in the database", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db, { passwords: people.map((person) => person.password), totpSecrets: people.flatMap((person) => (person.totpSecret === undefined ? [] : [person.totpSecret])) });
  });
});
