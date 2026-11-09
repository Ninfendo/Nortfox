// SPDX-License-Identifier: AGPL-3.0-only

// Migration 0008 on an install that was set up before it (issue 54). Before
// 0008 a used setup link named no identity, and the purge deleted it at its
// end. Then completeSetup was the only way to make an identity, and only on
// an empty install, so a used link made the install's one identity. 0008
// gives such a link that identity, and from then the purge keeps it. So the
// setup command can make a new link for an install whose first answer was
// lost before the upgrade. A used link that 0008 cannot pair so, on an
// install with no identity or more than one, or beside another used link,
// works for nothing and names no identity: 0008 deletes it. An unused link
// stays as it was.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { emptyDatabase, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, anonymously, later, phcString, sealedSecret, someEmail, tokenHash } from "../../../test/identities.ts";
import { expectNoSecretsAtRest } from "../../../test/secrets.ts";
import { migrate, readMigrations } from "../../db/migrate.ts";
import { tableGuardProblems } from "../../db/table-guard.ts";

/** The server's clock in these tests. */
const T0 = new Date("2090-03-15T10:00:00.000Z");
const END = later(T0, 28 * 24 * 60);

const databases: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

/** An install migrated up to 0007, as one set up before 0008: its owner and the app. */
async function installBefore0008(): Promise<{ db: TestDatabase; owner: Client; app: Client }> {
  const db = await emptyDatabase();
  databases.push(db);
  const owner = await db.connect("owner");
  const before = readMigrations().filter((migration) => migration.name < "0008");
  expect(before.map((migration) => migration.name).at(-1)).toBe("0007_companies_memberships.sql");
  await migrate(owner, before);
  return { db, owner, app: await db.connect("app") };
}

/** Applies the rest of the migrations, 0008 among them, and checks the guard. */
async function upgrade(owner: Client): Promise<void> {
  expect(await migrate(owner, readMigrations())).toContain("0008_setup_new_link.sql");
  expect(await tableGuardProblems(owner)).toEqual([]);
}

async function linksOf(owner: Client): Promise<{ token_hash: Buffer; identity_id: string | null; used: boolean }[]> {
  return (await owner.query<{ token_hash: Buffer; identity_id: string | null; used: boolean }>("SELECT token_hash, identity_id, used_at IS NOT NULL AS used FROM access.setup_tokens ORDER BY created_at, token_hash")).rows;
}

describe("migration 0008 on an install set up before it", () => {
  it("gives the used link the install's one identity, which it made, and the setup command then makes a link that replaces it", async () => {
    const { db, owner, app } = await installBefore0008();
    // The setup as 0006 ran it: a link, and its use as the app.
    const [stopped, used] = [tokenHash(), tokenHash()];
    for (const [hash, at] of [
      [stopped, T0],
      [used, later(T0, 1)],
    ] as const) {
      await anonymously(app, "SELECT access.create_setup_token($1, $2, $3)", [hash, at, END]);
    }
    const person = randomUUID();
    await anonymously(app, "SELECT access.complete_setup($1, $2, $3, 'Alva Berg', $4, $5, $6, $7)", [used, later(T0, 2), person, someEmail(), phcString(), randomUUID(), sealedSecret()]);
    await upgrade(owner);
    expect(await linksOf(owner)).toEqual([
      { token_hash: stopped, identity_id: null, used: false },
      { token_hash: used, identity_id: person, used: true },
    ]);
    const made = await anonymously<{ replaces: boolean }>(app, "SELECT replaces_identity AS replaces FROM access.create_setup_token($1, $2, $3)", [tokenHash(), later(T0, 3), END]);
    expect(made).toEqual([{ replaces: true }]);
    await expectNoSecretsAtRest(db);
  });

  it("deletes a used link that it cannot pair with one identity, and keeps every unused link", async () => {
    for (const identities of [0, 2]) {
      const { db, owner } = await installBefore0008();
      for (let made = 0; made < identities; made += 1) {
        await addIdentity(owner);
      }
      const unused = tokenHash();
      await owner.query("INSERT INTO access.setup_tokens (token_hash, created_at, expires_at, used_at) VALUES ($1, $2, $3, $2), ($4, $2, $3, NULL)", [tokenHash(), T0, END, unused]);
      await upgrade(owner);
      expect(await linksOf(owner)).toEqual([{ token_hash: unused, identity_id: null, used: false }]);
      await expectNoSecretsAtRest(db);
    }
    // Two used links beside one identity, as only the owner could leave them: neither is known to have made it.
    const { owner } = await installBefore0008();
    await addIdentity(owner);
    await owner.query("INSERT INTO access.setup_tokens (token_hash, created_at, expires_at, used_at) VALUES ($1, $2, $3, $2), ($4, $2, $3, $2)", [tokenHash(), T0, END, tokenHash()]);
    await upgrade(owner);
    expect(await linksOf(owner)).toEqual([]);
  });
});
