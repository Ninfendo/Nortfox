// SPDX-License-Identifier: AGPL-3.0-only

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, failureOf, freshDatabase, type TestDatabase } from "../../test/database.ts";
import { REFUSALS, readRefusal, refusalDrift, type ReasonRow } from "./refusals.ts";

describe("the refusals in the database", () => {
  let db: TestDatabase;
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    app = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  it("lists the same reasons and codes as refusals.ts, in the order of their codes", async () => {
    const found = await owner.query<ReasonRow>("SELECT reason, code FROM ledger.refusal_reasons()");
    expect(refusalDrift(found.rows)).toEqual([]);
    expect(found.rows).toEqual(REFUSALS.map(({ reason, code }) => ({ reason, code })));
  });

  it("raises each reason with its code, the reason as the message and the facts as the detail", async () => {
    for (const { reason, code } of REFUSALS) {
      const facts = { case: reason, amount: "-123456789012345678" };
      const error = await failureOf(owner.query("SELECT ledger.refuse($1, $2)", [reason, JSON.stringify(facts)]));
      expect(readRefusal(error)).toEqual({ reason, code, facts });
    }
    await expectRefusal(owner.query("SELECT ledger.refuse('description_missing')"), "description_missing", {});
  });

  it("faults on a reason that is not on the list, which is no refusal", async () => {
    const error = await failureOf(owner.query("SELECT ledger.refuse('made_up', '{}')"));
    expect(readRefusal(error)).toBeUndefined();
    await expectError(owner.query("SELECT ledger.refuse('made_up', '{}')"), "P0001", /ledger\.refuse was given an unknown reason: made_up/);
  });

  it("raises refusals only from the database's own functions, never for the app", async () => {
    await expectError(app.query("SELECT ledger.refuse('unbalanced', '{}')"), INSUFFICIENT_PRIVILEGE);
    await expectError(app.query("SELECT * FROM ledger.refusal_reasons()"), INSUFFICIENT_PRIVILEGE);
  });
});
