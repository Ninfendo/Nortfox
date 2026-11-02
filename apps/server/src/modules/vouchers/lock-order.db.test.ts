// SPDX-License-Identifier: AGPL-3.0-only

// The lock order (db/README.md). A deletion locks its voucher, then its rows
// by the cascade. A change of a row locks the row, and then its trigger locks
// the voucher. So a caller that changes a row locks its voucher first
// (ledger.ts, LOCK_VOUCHER): a row change and a deletion of the same voucher
// then wait for each other, and never wait in a circle. These tests hold the
// deletion back with a third transaction that books in the same series and
// so holds the counter, which makes the order of the waits certain. The
// second part shows the order in which a transaction that changes more than
// one of the rows a voucher locks makes its changes.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, begin, failureOf, freshDatabase, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import {
  LOCK_VOUCHER,
  addBooks,
  balanced,
  bookVoucher,
  deletedVouchersOf,
  nextNumberOf,
  rowsOf,
  someUser,
  voucherOf,
  writeRow,
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

// A booking locks the voucher's fiscal year, then its series, then the
// automatic lock row. A new row locks its voucher, then those three rows, and
// then its account (db/README.md, the lock order). A transaction that changes
// more than one of them makes the changes in that order too.
describe("the lock order between a voucher and a transaction that changes two of the rows it locks", () => {
  let db: TestDatabase;
  let watcher: Client;
  const who = someUser();
  const SHORTEN = "UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1";
  const RENAME_SERIES = "UPDATE ledger.voucher_series SET description = 'Manuella' WHERE fiscal_year_id = $1 AND code = 'A'";
  const LOCK = "INSERT INTO ledger.period_locks (company_id, scope, end_date) VALUES ($1, 'all', '2090-06-30')";
  const RENAME_ACCOUNT = "UPDATE ledger.accounts SET description = 'Försäljning' WHERE fiscal_year_id = $1 AND number = 3001";

  beforeAll(async () => {
    db = await freshDatabase();
    watcher = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  type Change = (books: Books) => readonly [sql: string, params: readonly unknown[]];
  const shorten: Change = (books) => [SHORTEN, [books.year.id]];
  const renameSeries: Change = (books) => [RENAME_SERIES, [books.year.id]];
  const lock: Change = (books) => [LOCK, [books.company]];
  const renameAccount: Change = (books) => [RENAME_ACCOUNT, [books.year.id]];

  /** A booking in series A, dated 2090-03-15, inside the lock that `lock` sets. */
  const booking = (client: Client, books: Books): Promise<unknown> =>
    writeVoucher(client, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(500n) });
  /** A new row on account 3001 of a voucher dated 2090-03-15. */
  const newRow = (client: Client, books: Books, voucher: Voucher): Promise<unknown> => writeRow(client, books.company, voucher.id, { account: 3001 });

  /**
   * Books a voucher dated 2090-03-15. The setter makes the first change, the
   * voucher's write starts in another transaction and waits, and the setter
   * then makes the second change and commits. Gives how each ended.
   */
  async function race(
    first: Change,
    second: Change,
    write: (client: Client, books: Books, voucher: Voucher) => Promise<unknown>,
  ): Promise<{ books: Books; voucher: Voucher; setter: unknown; written: unknown }> {
    const books = await addBooks(watcher);
    const voucher = await bookVoucher(watcher, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n) }, who);
    const [setter, writer] = await Promise.all([db.connect("app"), db.connect("app")]);
    const writerPid = await backendPid(writer);
    /** Runs `work` in the open transaction of `client`, commits it, and gives what it failed with, or undefined. */
    const finish = (client: Client, work: () => Promise<unknown>): Promise<unknown> =>
      failureOf(
        (async () => {
          try {
            await work();
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        })(),
      );
    await begin(setter, { company: books.company, ...someUser() });
    const [firstSql, firstParams] = first(books);
    await setter.query(firstSql, [...firstParams]);
    await begin(writer, { company: books.company, ...who });
    const written = finish(writer, () => write(writer, books, voucher));
    await untilWaitingForLock(watcher, writerPid);
    const [secondSql, secondParams] = second(books);
    const set = finish(setter, () => setter.query(secondSql, [...secondParams]));
    return { books, voucher, setter: await set, written: await written };
  }

  /** Expects PostgreSQL to have broken a circle of waits by rolling one of the two back. */
  function expectDeadlock(setter: unknown, written: unknown): void {
    const codes = [setter, written].map((error) => (error as { code?: unknown } | undefined)?.code);
    expect(codes.filter((code) => code === DEADLOCK_DETECTED)).toHaveLength(1);
  }

  it("never deadlocks a booking with a transaction that changes the fiscal year, then the series: the booking waits, then goes in", async () => {
    const { books, setter, written } = await race(shorten, renameSeries, booking);
    expect([setter, written]).toEqual([undefined, undefined]);
    expect(await nextNumberOf(watcher, books.company, books.year.id, "A")).toBe(3);
  });

  it("deadlocks a booking with a transaction that changes the series first, which is why it changes the fiscal year first", async () => {
    const { setter, written } = await race(renameSeries, shorten, booking);
    expectDeadlock(setter, written);
  });

  it("never deadlocks a new row with a transaction that sets a lock date, then changes the account: the row waits, then reads the lock", async () => {
    const { books, voucher, setter, written } = await race(lock, renameAccount, newRow);
    expect(setter).toBeUndefined();
    expect((written as { code?: unknown } | undefined)?.code).toBe("NF011");
    expect((await rowsOf(watcher, books.company, voucher.id)).length).toBe(2);
  });

  it("deadlocks a new row with a transaction that changes the account first, which is why it sets the lock date first", async () => {
    const { setter, written } = await race(renameAccount, lock, newRow);
    expectDeadlock(setter, written);
  });
});
