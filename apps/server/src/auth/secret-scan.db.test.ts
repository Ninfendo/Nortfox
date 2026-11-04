// SPDX-License-Identifier: AGPL-3.0-only

// The scan of the database at the end of each sign-in test file is a guard
// of its own. It must fail on every password and TOTP code that a sign-in app
// of the file sent, right or wrong, once it is stored in clear, also when the
// test names only the right passwords. It must fail on every TOTP secret that
// the file made for a person, or that an answer gave, also when the test
// names none.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import {
  addSignInIdentity,
  challengeOf,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  passwordStep,
  sentSecrets,
  signInApp,
  totpStep,
  wrongCodeOf,
} from "../../test/sign-in.ts";
import { base32Encode, newTotpSecret, otpauthUri } from "./totp.ts";

describe("the scan of the database after sign-ins", () => {
  let db: TestDatabase;
  let owner: Client;
  let pool: AppPool;

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    pool = appPool(db, 2);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("fails on a wrong password or a code that a sign-in app sent, once it is in clear in a table", async () => {
    const server = signInApp(pool.database);
    const person = await addSignInIdentity(owner, { twoStep: "every_login" });
    const typed = "fel-lösenord-som-läcker";
    expect((await passwordStep(server, person.email, typed)).status).toBe(422);
    const challenge = await challengeOf(await passwordStep(server, person.email, person.password));
    const code = wrongCodeOf(person, server.clock.now());
    expect((await totpStep(server, challenge, code)).status).toBe(422);
    await server.app.afterAnswer.idle();
    expect(sentSecrets()).toEqual({ passwords: [typed, person.password], codes: [code] });
    const named = { passwords: [person.password], totpSecrets: person.totpSecret === undefined ? [] : [person.totpSecret] };
    await expectNoSecretsAtRestFromSignInApps(db, named);
    for (const leak of [typed, code]) {
      await owner.query("UPDATE access.identities SET name = $2 WHERE id = $1", [person.id, leak]);
      await expect(expectNoSecretsAtRestFromSignInApps(db, named)).rejects.toThrow("The database holds a token or a secret in clear.");
    }
    await owner.query("UPDATE access.identities SET name = 'Alva Berg' WHERE id = $1", [person.id]);
    await expectNoSecretsAtRestFromSignInApps(db, named);
    expectNoTokensFromSignInApps();
  });

  it("fails on a TOTP secret that the test file made or that an answer gave, once it is in clear, though the test names none", async () => {
    const server = signInApp(pool.database);
    const person = await addSignInIdentity(owner);
    // An answer that holds a new secret in its otpauth URI, as completeSetup's does.
    const enrolled = newTotpSecret();
    server.bodies.push(JSON.stringify({ totpEnrolment: { otpauthUri: otpauthUri(enrolled, "signe.ek@example.com") } }));
    await expectNoSecretsAtRestFromSignInApps(db);
    for (const leak of [person.totpSecret?.toString("hex") ?? "", base32Encode(enrolled)]) {
      await owner.query("UPDATE access.identities SET name = $2 WHERE id = $1", [person.id, leak]);
      await expect(expectNoSecretsAtRestFromSignInApps(db)).rejects.toThrow("The database holds a token or a secret in clear.");
    }
    await owner.query("UPDATE access.identities SET name = 'Signe Ek' WHERE id = $1", [person.id]);
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
