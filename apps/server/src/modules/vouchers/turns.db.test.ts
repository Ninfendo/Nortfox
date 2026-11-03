// SPDX-License-Identifier: AGPL-3.0-only

// The company's turn (db/README.md, the lock order). A change of a voucher
// locks FOR SHARE the rows that its checks read: its fiscal year, its series,
// the company's automatic lock row and its rows' accounts. PostgreSQL gives a
// new share lock at once to a row that only share locks hold, ahead of a
// change that waits for that row. So while bookings overlap, a change of one
// of those rows would wait until they pause, and never get its turn under a
// steady load. Each first takes the company's turn, which PostgreSQL queues
// in order: a change of a voucher with the others, a change of those rows
// alone. Such a change then waits only for the changes of vouchers that were
// open when it came, and the bookings that come after it wait for it.

import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, begin, failureOf, freshDatabase, inTransaction, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import { addBooks, balanced, bookVoucher, someUser, writeRow, writeVoucher, type Actor, type Books, type Voucher } from "../../../test/ledger.ts";

/** How many connections book at the same time, back to back. Three kept a change waiting for as long as they ran. */
const BOOKERS = 3;

/** How long the bookers book, at most, in milliseconds. */
const BOOK_FOR = 8_000;

/** How long the bookers go on booking before the change starts, once each could have booked once, in milliseconds. */
const OVERLAP_FIRST = 300;

/** How long the test waits at most for the first bookings, and for a booking after the change, in milliseconds. */
const WAIT_AT_MOST = 3_000;

type Change = (books: Books) => readonly [sql: string, params: readonly unknown[]];

/** Each change of a row that a booking in series A of 2090, on the accounts 6110 and 1930, locks FOR SHARE, or that waits for such a lock. */
const CHANGES: readonly (readonly [string, Change])[] = [
  ["a lock date", (books) => ["INSERT INTO ledger.period_locks (company_id, scope, end_date) VALUES ($1, 'all', '2090-01-31')", [books.company]]],
  ["the automatic lock turned on", () => ["UPDATE ledger.automatic_locks SET enabled = true, interval = 'year_end_60'", []]],
  ["a new end of the fiscal year", (books) => ["UPDATE ledger.fiscal_years SET to_date = '2090-12-30' WHERE id = $1", [books.year.id]]],
  ["the fiscal year made the default", (books) => ["UPDATE ledger.fiscal_years SET is_default = true WHERE id = $1", [books.year.id]]],
  ["a new name of the series", (books) => ["UPDATE ledger.voucher_series SET description = 'Manuella' WHERE fiscal_year_id = $1 AND code = 'A'", [books.year.id]]],
  [
    "a new series in the fiscal year",
    (books) => ["INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'B', 'Bank', true)", [books.company, books.year.id]],
  ],
  ["a new name of an account that the bookings use", (books) => ["UPDATE ledger.accounts SET description = 'Bankkonto' WHERE fiscal_year_id = $1 AND number = 1930", [books.year.id]]],
];

describe("the company's turn", () => {
  let db: TestDatabase;
  let app: Client;
  let changer: Client;
  let bookers: Client[];
  const who = someUser();
  const setter = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    changer = await db.connect("app");
    bookers = await Promise.all(Array.from({ length: BOOKERS }, () => db.connect("app")));
  });

  afterAll(async () => {
    await db.close();
  });

  it.each(CHANGES)("commits %s while bookings overlap, and the bookings go on after it", async (_name, change) => {
    const books = await addBooks(app, who);
    const deadline = Date.now() + BOOK_FOR;
    let stop = false;
    /** When each booking committed, by the clock of this process. */
    const committed: number[] = [];
    const booking = bookers.map(async (client) => {
      while (!stop && Date.now() < deadline) {
        await bookVoucher(client, books.company, { year: books.year.id, series: "A", date: "2090-06-15", rows: balanced(500n) }, who);
        committed.push(Date.now());
      }
    });
    /** Waits, for at most WAIT_AT_MOST, until `done` holds. */
    const until = async (done: () => boolean): Promise<void> => {
      for (let waited = 0; waited < WAIT_AT_MOST && !done(); waited += 10) {
        await delay(10);
      }
    };
    try {
      await until(() => committed.length >= BOOKERS);
      await delay(OVERLAP_FIRST);
      const [sql, params] = change(books);
      const startedAt = Date.now();
      await inTransaction(changer, { company: books.company, ...setter }, () => changer.query(sql, [...params]));
      const changedAt = Date.now();
      // The change committed while the bookings still ran, and soon, not when they would have stopped by themselves.
      expect(changedAt).toBeLessThan(deadline);
      expect(changedAt - startedAt).toBeLessThan(BOOK_FOR / 2);
      await until(() => committed.some((at) => at > changedAt));
      expect(committed.filter((at) => at > changedAt).length).toBeGreaterThan(0);
    } finally {
      stop = true;
      await Promise.all(booking);
    }
  });

  it("takes the company's turn alone before each statement that changes a row that a change of a voucher locks, or a new series", async () => {
    const found = await app.query<{ name: string }>(`
      SELECT t.tgrelid::pg_catalog.regclass::text || ' ' ||
        pg_catalog.concat_ws(' OR ',
          CASE WHEN t.tgtype & 4 <> 0 THEN 'INSERT' END,
          CASE WHEN t.tgtype & 16 <> 0 THEN 'UPDATE' END,
          CASE WHEN t.tgtype & 8 <> 0 THEN 'DELETE' END) COLLATE "C" AS name
      FROM pg_catalog.pg_trigger AS t
      WHERE t.tgfoid = 'ledger.take_turn_alone()'::pg_catalog.regprocedure
        AND t.tgtype & 1 = 0 AND t.tgtype & 2 <> 0 AND t.tgenabled = 'O' AND t.tgqual IS NULL
      ORDER BY 1`);
    expect(found.rows.map((row) => row.name)).toEqual([
      "ledger.accounts UPDATE OR DELETE",
      "ledger.automatic_locks UPDATE",
      "ledger.fiscal_years UPDATE",
      "ledger.period_locks INSERT OR UPDATE",
      "ledger.voucher_series INSERT OR UPDATE OR DELETE",
    ]);
  });

  /**
   * Each change of a voucher, and a new period, that the test runs while a
   * change of the fiscal year waits for the company's turn. Each must take
   * the turn before it locks the year's row: otherwise it holds the row that
   * the change of the year will lock, and then waits behind that change at
   * the turn, and the two wait in a circle.
   */
  const WRITES: readonly (readonly [string, (client: Client, books: Books, voucher: Voucher) => Promise<unknown>])[] = [
    ["a booking", (client, books) => writeVoucher(client, books.company, { year: books.year.id, series: "A", date: "2090-03-16", rows: balanced(500n) })],
    ["a change of a voucher's date", (client, _books, voucher) => client.query("UPDATE ledger.vouchers SET transaction_date = '2090-03-16' WHERE id = $1", [voucher.id])],
    ["a new row", (client, books, voucher) => writeRow(client, books.company, voucher.id, { account: 3001 })],
    [
      "a new period, then a booking",
      async (client, books) => {
        await client.query("INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, '2090-01-01', '2090-01-31')", [
          books.company,
          books.year.id,
        ]);
        await writeVoucher(client, books.company, { year: books.year.id, series: "A", date: "2090-03-16", rows: balanced(500n) });
      },
    ],
  ];

  it.each(WRITES)("lets %s wait at the turn behind a change of the fiscal year that waits there, and never deadlocks with it", async (_name, write) => {
    const books = await addBooks(app, who);
    const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n) }, who);
    const [holder, yearChanger, writer] = await Promise.all([db.connect("app"), db.connect("app"), db.connect("app")]);
    const [changerPid, writerPid] = [await backendPid(yearChanger), await backendPid(writer)];
    /** Runs `work` in a transaction of `client`, and gives what it failed with, or undefined. */
    const run = (client: Client, actor: Actor, work: () => Promise<unknown>): Promise<unknown> =>
      failureOf(inTransaction(client, { company: books.company, ...actor }, work));
    // An open booking in series K holds the turn with the others.
    await begin(holder, { company: books.company, ...who });
    await writeVoucher(holder, books.company, { year: books.year.id, series: "K", date: "2090-03-15", referenceType: "INVOICE", rows: balanced(100n) });
    const changed = run(yearChanger, setter, () => yearChanger.query("UPDATE ledger.fiscal_years SET is_default = true WHERE id = $1", [books.year.id]));
    await untilWaitingForLock(app, changerPid);
    const written = run(writer, who, () => write(writer, books, voucher));
    await untilWaitingForLock(app, writerPid);
    await holder.query("COMMIT");
    expect([await changed, await written]).toEqual([undefined, undefined]);
  });
});
