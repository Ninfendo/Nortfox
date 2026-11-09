// SPDX-License-Identifier: AGPL-3.0-only

// The turns of the user administration (db/README.md, the turns), as
// nortfox_app with the settings the server sets. The invitations' turn and
// the administrators' turn are each a company's own, held until the
// transaction ends. A second invitation of the company waits for the first;
// a disconnect, which takes the administrators' turn alone, waits for every
// change of an administrator, and they wait for it; such changes do not wait
// for each other. Neither turn waits for another company's, and neither is
// the company's row, so a change of a membership or of the company does not
// wait for one. A transaction in no company takes no turn: it is refused.

import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, begin, expectError, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { aCompany, type Company } from "../../../test/memberships.ts";

/** A turn, as the server takes it: its statement. */
const INVITATIONS = "SELECT access.take_invitations_turn()";
const ALONE = "SELECT access.take_administrators_turn(true)";
const SHARED = "SELECT access.take_administrators_turn(false)";

describe("the turns of the user administration", () => {
  let db: TestDatabase;
  let first: Client;
  let second: Client;
  let superuser: Client;
  let alfa: Company;
  let beta: Company;

  beforeAll(async () => {
    db = await freshDatabase();
    first = await db.connect("app");
    second = await db.connect("app");
    superuser = await db.admin();
    alfa = await aCompany(first, "Testbolaget Alfa AB");
    beta = await aCompany(first, "Testbolaget Beta AB");
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * Runs `held` in `company` in the first connection, not committed, and then
   * `next` in `other` in the second: whether the second waited for a lock
   * before the first committed.
   */
  async function waits(company: Company, held: string, other: Company, next: string): Promise<boolean> {
    await begin(first, { company: company.id, ...company.asOwner, channel: "rest" });
    await first.query(held);
    await begin(second, { company: other.id, ...other.asOwner, channel: "rest" });
    const pid = await backendPid(second);
    const state = { done: false };
    // The second commits too, so a check that its commit makes, such as the last system administrator's, counts.
    const later = (async () => {
      await second.query(next);
      await second.query("COMMIT");
    })().finally(() => {
      state.done = true;
    });
    let waited = false;
    for (let attempt = 0; attempt < 300 && !state.done; attempt += 1) {
      const found = await superuser.query<{ waiting: boolean }>("SELECT wait_event_type IS NOT DISTINCT FROM 'Lock' AS waiting FROM pg_catalog.pg_stat_activity WHERE pid = $1", [pid]);
      if (found.rows[0]?.waiting === true) {
        waited = true;
        break;
      }
      await delay(10);
    }
    await first.query("COMMIT");
    await later;
    return waited;
  }

  it("lets a second invitation of the company wait for the first, and no invitation of another company", async () => {
    expect(await waits(alfa, INVITATIONS, alfa, INVITATIONS)).toBe(true);
    expect(await waits(alfa, INVITATIONS, beta, INVITATIONS)).toBe(false);
  });

  it("lets a disconnect and a change of an administrator wait for each other, and two such changes not", async () => {
    expect(await waits(alfa, ALONE, alfa, SHARED)).toBe(true);
    expect(await waits(alfa, SHARED, alfa, ALONE)).toBe(true);
    expect(await waits(alfa, ALONE, alfa, ALONE)).toBe(true);
    expect(await waits(alfa, SHARED, alfa, SHARED)).toBe(false);
    expect(await waits(alfa, ALONE, beta, ALONE)).toBe(false);
  });

  it("keeps the two turns apart, and lets the company's row and its memberships be changed while one is held", async () => {
    expect(await waits(alfa, INVITATIONS, alfa, ALONE)).toBe(false);
    expect(await waits(alfa, ALONE, alfa, INVITATIONS)).toBe(false);
    expect(await waits(alfa, INVITATIONS, alfa, "SELECT 1 FROM ledger.companies FOR NO KEY UPDATE")).toBe(false);
    expect(await waits(alfa, ALONE, alfa, "UPDATE access.memberships SET idle_timeout_minutes = 60 WHERE admin_level = 'owner'")).toBe(false);
  });

  it("refuses a transaction that works in no company", async () => {
    for (const turn of [INVITATIONS, ALONE, SHARED]) {
      await expectError(
        inTransaction(first, { ...alfa.asOwner, channel: "rest" }, () => first.query(turn)),
        "P0001",
        /works in no company/,
      );
    }
  });
});
