// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";

describe("a connection to the real database", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await freshDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  it("reads a bigint as a bigint, also past 2^53, and a numeric as its exact text", async () => {
    const app = await db.connect("app");
    const found = await app.query(
      "SELECT 9007199254740993::bigint AS big, '-9223372036854775808'::bigint AS least, 1.23456::numeric AS quantity, -1.5::numeric AS negative, 7::integer AS small",
    );
    expect(found.rows).toEqual([{ big: 9007199254740993n, least: -9223372036854775808n, quantity: "1.23456", negative: "-1.5", small: 7 }]);
  });
});
