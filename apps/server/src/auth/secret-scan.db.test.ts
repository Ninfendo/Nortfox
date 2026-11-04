// SPDX-License-Identifier: AGPL-3.0-only

// The scan of the database at the end of each sign-in test file is a guard
// of its own. It must fail on every password and TOTP code that a sign-in app
// of the file sent, right or wrong, once it is stored in clear, also when the
// test names only the right passwords.

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
});
