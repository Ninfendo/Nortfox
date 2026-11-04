// SPDX-License-Identifier: AGPL-3.0-only

// The key check at start, on PostgreSQL as nortfox_app. The first start of
// an install stores, in access.install_keys, the key id and a fixed text
// sealed under the install secret. Each later start opens it with its own
// key, and refuses to start when it cannot, or when its key id is not the
// one stored: a key made again by mistake, with any key id, fails loudly,
// before it writes anything the old key cannot read.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { InstallKey, checkInstallKey, opensCheckValue } from "./install-key.ts";

const SECRET = Buffer.from("4b6d8f0a2c4e6b8d0f1a3c5e7b9d1f3a5c7e9b0d2f4a6c8e0b1d3f5a7c9e1b3d", "hex");
const OTHER_SECRET = Buffer.from("a3c5e7b9d1f3a5c7e9b0d2f4a6c8e0b1d3f5a7c9e1b3d4b6d8f0a2c4e6b8d0f1", "hex");

describe("the key check at start", () => {
  let db: TestDatabase;
  let pool: AppPool;
  let owner: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    pool = appPool(db, 2);
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function stored(): Promise<{ key_id: number; check_value: Buffer }[]> {
    return (await owner.query<{ key_id: number; check_value: Buffer }>("SELECT key_id, check_value FROM access.install_keys ORDER BY key_id")).rows;
  }

  it("stores the check value on the first start, as the app, and the value opens with the key", async () => {
    expect(await stored()).toEqual([]);
    const key = new InstallKey(1, SECRET);
    await checkInstallKey(pool.database, key);
    const rows = await stored();
    expect(rows.map((row) => row.key_id)).toEqual([1]);
    expect(opensCheckValue(key, rows[0]?.check_value ?? Buffer.alloc(0))).toBe(true);
    expect(rows[0]?.check_value.includes(SECRET)).toBe(false);
  });

  it("lets a later start with the same key pass, and stores nothing new", async () => {
    const before = await stored();
    await checkInstallKey(pool.database, new InstallKey(1, SECRET));
    expect(await stored()).toEqual(before);
  });

  it("stops a start whose key does not open the check value of its id, and never names the secret", async () => {
    const before = await stored();
    const failure = checkInstallKey(pool.database, new InstallKey(1, OTHER_SECRET));
    await expect(failure).rejects.toThrow(
      "The install secret does not open the check value that this install stored for key id 1 at its first start. " +
        "It is not the key that the install was set up with. Start the server with that key, from your backup of it.",
    );
    const message = await failure.catch((error: unknown) => String(error));
    expect(message).not.toContain(OTHER_SECRET.toString("hex"));
    expect(message).not.toContain(SECRET.toString("hex"));
    expect(await stored()).toEqual(before);
  });

  it("stops a start with another key id, while the install has the check value of its first key, names that key id, and stores nothing", async () => {
    // A key made again by mistake with the next key id: the server cannot open what the first key sealed.
    const before = await stored();
    for (const key of [new InstallKey(2, OTHER_SECRET), new InstallKey(2, SECRET)]) {
      const failure = checkInstallKey(pool.database, key);
      await expect(failure).rejects.toThrow(
        "The install secret has key id 2, but this install stored the check value of key id 1 at its first start. " +
          "It is not the key that the install was set up with. Start the server with that key, from your backup of it.",
      );
      const message = await failure.catch((error: unknown) => String(error));
      expect(message).not.toContain(OTHER_SECRET.toString("hex"));
      expect(message).not.toContain(SECRET.toString("hex"));
    }
    expect(await stored()).toEqual(before);
    // The first key still starts.
    await checkInstallKey(pool.database, new InstallKey(1, SECRET));
  });

  it("leaves the app no way to change a stored check value", async () => {
    const app = await db.connect("app");
    await expect(app.query("UPDATE access.install_keys SET check_value = '\\x00'")).rejects.toThrow(/permission denied/);
    await expect(app.query("SELECT key_id FROM access.install_keys")).rejects.toThrow(/permission denied/);
  });
});
