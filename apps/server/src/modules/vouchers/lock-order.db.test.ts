// SPDX-License-Identifier: AGPL-3.0-only

// The lock order (db/README.md). A deletion locks its voucher, then its rows
// by the cascade. A change of a row locks the row, and then its trigger locks
// the voucher. So a caller that changes a row locks its voucher first
// (ledger.ts, LOCK_VOUCHER): a row change and a deletion of the same voucher
// then wait for each other, and never wait in a circle. These tests hold the
// deletion back with a third transaction that books in the same series and
// so holds the counter, which makes the order of the waits certain.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, begin, failureOf, freshDatabase, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import {
  LOCK_VOUCHER,
  addBooks,
  balanced,
  bookVoucher,
  deletedVouchersOf,
  rowsOf,
  someUser,
  voucherOf,
  writeVoucher,
  type Books,
  type Voucher,
} from "../../../test/ledger.ts";

/** PostgreSQL's SQLSTATE for a deadlock that it found and broke. */
const DEADLOCK_DETECTED = "40P01";

const TEXT = "UPDATE ledger.voucher_rows SET transaction_information = 'Fel konto' WHERE voucher_id = $1 AND position = 1";

describe("the lock order between a deletion and a change of a row", () => {
  let db: TestDatabase;
  let watcher: Client;
  const who = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    watcher = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * Books a voucher, the last of series A, then: a booking in A that holds
   * the counter open; a deletion of the voucher, which locks it and waits for
   * the counter; and `change`, started once the deletion waits. When `change`
   * waits too, the booking rolls back. Gives how the deletion and the change
   * ended.
   */
  async function race(change: (client: Client, voucher: Voucher) => Promise<unknown>): Promise<{ books: Books; voucher: Voucher; deletion: unknown; changed: unknown }> {
    const books = await addBooks(watcher);
    const voucher = await bookVoucher(watcher, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n) }, who);
    const [booker, deleter, changer] = await Promise.all([db.connect("app"), db.connect("app"), db.connect("app")]);
    const [deleterPid, changerPid] = [await backendPid(deleter), await backendPid(changer)];
    const settings = { company: books.company, ...who };
    await begin(booker, settings);
    await writeVoucher(booker, books.company, { year: books.year.id, series: "A", date: "2090-03-16", rows: balanced(500n) });
    /** Runs `work` in a transaction of `client`, and gives what it failed with, or undefined. */
    const run = (client: Client, work: () => Promise<unknown>): Promise<unknown> =>
      failureOf(
        (async () => {
          await begin(client, settings);
          try {
            await work();
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        })(),
      );
    const deletion = run(deleter, () => deleter.query("DELETE FROM ledger.vouchers WHERE id = $1", [voucher.id]));
    await untilWaitingForLock(watcher, deleterPid);
    const changed = run(changer, () => change(changer, voucher));
    await untilWaitingForLock(watcher, changerPid);
    await booker.query("ROLLBACK");
    return { books, voucher, deletion: await deletion, changed: await changed };
  }

  it("makes a change of a row that locks its voucher first wait for the deletion, and then find no row: no deadlock", async () => {
    const { books, voucher, deletion, changed } = await race(async (client, target) => {
      const locked = await client.query(LOCK_VOUCHER, [target.id]);
      expect(locked.rowCount).toBe(0);
      expect((await client.query(TEXT, [target.id])).rowCount).toBe(0);
    });
    expect(deletion).toBeUndefined();
    expect(changed).toBeUndefined();
    expect(await voucherOf(watcher, books.company, voucher.id)).toBeUndefined();
    expect((await deletedVouchersOf(watcher, books.company)).map((entry) => entry.id)).toEqual([voucher.id]);
  });

  it("deadlocks a change of a row that locks the row first against the deletion, which is why every caller locks the voucher first", async () => {
    const { books, voucher, deletion, changed } = await race((client, target) => client.query(TEXT, [target.id]));
    // PostgreSQL breaks the circle by rolling one of the two back.
    const codes = [deletion, changed].map((error) => (error as { code?: unknown } | undefined)?.code);
    expect(codes.filter((code) => code === DEADLOCK_DETECTED)).toHaveLength(1);
    expect(codes.filter((code) => code === undefined)).toHaveLength(1);
    const kept = await voucherOf(watcher, books.company, voucher.id);
    if (deletion === undefined) {
      expect(kept).toBeUndefined();
    } else {
      expect((await rowsOf(watcher, books.company, voucher.id))[0]?.transaction_information).toBe("Fel konto");
    }
  });
});
