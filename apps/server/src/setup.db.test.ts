// SPDX-License-Identifier: AGPL-3.0-only

// The setup command's function (setup.ts): on an empty install it makes a
// setup link that works for 28 days, keeps only the token's hash, stops
// every older link, and gives the link and the text the command prints. On
// an install whose only identity a setup link made and that never confirmed
// its TOTP secret, it makes one too, and says that using it replaces that
// identity. On an install that has any other identity it makes none, and
// says why.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_NOW, appPool, type AppPool } from "../test/api.ts";
import { freshDatabase, type TestDatabase } from "../test/database.ts";
import { addIdentity, phcString, sealedSecret } from "../test/identities.ts";
import { expectNoSecretsAtRest } from "../test/secrets.ts";
import { DAY, TEST_ORIGIN } from "../test/sign-in.ts";
import { tokenHash } from "./auth/tokens.ts";
import { createSetupLink, setupLinkMessage } from "./setup.ts";
import { commit, type Database } from "./db/database.ts";

describe("the setup command's link", () => {
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

  interface StoredLink {
    readonly token_hash: Buffer;
    readonly created_at: Date;
    readonly expires_at: Date;
    readonly used_at: Date | null;
    readonly superseded_at: Date | null;
  }

  async function storedLinks(): Promise<StoredLink[]> {
    return (await owner.query<StoredLink>("SELECT token_hash, created_at, expires_at, used_at, superseded_at FROM access.setup_tokens ORDER BY created_at")).rows;
  }

  it("is a link to the install's own origin with a setup token, for 28 days, and only its hash is kept", async () => {
    const link = await createSetupLink(pool.database, TEST_ORIGIN, TEST_NOW);
    expect(link.url).toMatch(/^https:\/\/nortfox\.example\/v1\/setup\/nfu_[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt).toEqual(new Date(TEST_NOW.getTime() + 28 * DAY));
    expect(link.replaces).toBe(false);
    const token = link.url.split("/").at(-1) ?? "";
    expect(await storedLinks()).toEqual([{ token_hash: tokenHash(token), created_at: TEST_NOW, expires_at: link.expiresAt, used_at: null, superseded_at: null }]);
    expect(setupLinkMessage(link)).toBe(
      [
        "The setup link of this install. It makes the first identity once, until 2090-04-12T10:00:00.000Z, and a newer link stops it:",
        "",
        `  ${link.url}`,
        "",
        'Send it a POST with the JSON body {"name": "...", "email": "...", "password": "..."}, with a password of 12 to 1024 characters.',
        "The answer holds the TOTP secret for an authenticator app. Then sign in with the e-mail address, the password and a code.",
      ].join("\n"),
    );
    await expectNoSecretsAtRest(db);
  });

  it("stops every older link", async () => {
    const later = new Date(TEST_NOW.getTime() + DAY);
    await createSetupLink(pool.database, TEST_ORIGIN, later);
    const links = await storedLinks();
    expect(links.map((link) => [link.superseded_at, link.used_at])).toEqual([
      [later, null],
      [null, null],
    ]);
  });

  it("is not made on an install that has an identity, and the command says why", async () => {
    await addIdentity(owner);
    await expect(createSetupLink(pool.database, TEST_ORIGIN, TEST_NOW)).rejects.toThrow(
      "This install has an identity already. A setup link makes only the first identity of an empty install: the others are invited.",
    );
    expect(await storedLinks()).toHaveLength(2);
  });

  it("passes on any other failure as it is", async () => {
    const failure = new Error("The database is down.");
    const broken: Database = { ...pool.database, write: () => Promise.reject(failure) };
    await expect(createSetupLink(broken, TEST_ORIGIN, TEST_NOW)).rejects.toBe(failure);
  });
});

describe("the setup command's link while the first identity never confirmed its TOTP secret", () => {
  let db: TestDatabase;
  let pool: AppPool;

  beforeAll(async () => {
    db = await freshDatabase();
    pool = appPool(db, 2);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("is made, and the command says that using it replaces that identity", async () => {
    const first = await createSetupLink(pool.database, TEST_ORIGIN, TEST_NOW);
    expect(first.replaces).toBe(false);
    const token = first.url.split("/").at(-1) ?? "";
    await pool.database.write({ channel: "rest" }, async (tx) => {
      await tx.query("SELECT access.complete_setup($1, $2, $3, 'Alva Berg', 'alva.berg@example.com', $4, $5, $6)", [
        tokenHash(token),
        TEST_NOW,
        randomUUID(),
        phcString(),
        randomUUID(),
        sealedSecret(),
      ]);
      return commit(undefined);
    });
    const link = await createSetupLink(pool.database, TEST_ORIGIN, TEST_NOW);
    expect(link.replaces).toBe(true);
    expect(setupLinkMessage(link)).toBe(
      [
        "The setup link of this install. It makes the first identity once, until 2090-04-12T10:00:00.000Z, and a newer link stops it:",
        "",
        `  ${link.url}`,
        "",
        "This install's only identity never confirmed its TOTP secret. Using this link replaces it: that identity is deleted, with its password and its TOTP secret, and the link makes a new one.",
        'Send it a POST with the JSON body {"name": "...", "email": "...", "password": "..."}, with a password of 12 to 1024 characters.',
        "The answer holds the TOTP secret for an authenticator app. Then sign in with the e-mail address, the password and a code.",
      ].join("\n"),
    );
    await expectNoSecretsAtRest(db);
  });
});
