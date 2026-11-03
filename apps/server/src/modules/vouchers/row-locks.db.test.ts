// SPDX-License-Identifier: AGPL-3.0-only

// The row locks keep the rules, also without the company's turn (db/README.md,
// the lock order). A change of a fiscal year, a lock date, the automatic lock,
// an account or a series takes the turn of the company that is set when its
// statement starts. A statement can switch nortfox.company_id between its
// rows, and so change another company's rows without that company's turn.
// The first part shows that the app can do so. The second part runs each
// race of a change of a voucher against such a change in a database where
// no statement takes the turn alone, so that the row locks alone keep them
// apart: each test fails when the row lock it names is taken out.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRefusal, type RefusalReason } from "../../db/refusals.ts";
import { backendPid, begin, expectRefusal, failureOf, freshDatabase, inTransaction, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import {
  FISCAL_YEAR_COLUMNS,
  addBooks,
  balanced,
  bookVoucher,
  isAfter,
  rowsOf,
  setAutomaticLock,
  setLock,
  someUser,
  voucherOf,
  writeRow,
  writeVoucher,
  type Books,
  type FiscalYear,
  type Voucher,
} from "../../../test/ledger.ts";

/** The tables whose changes take the company's turn alone, from a trigger for each statement. */
const TURN_TABLES = ["ledger.accounts", "ledger.automatic_locks", "ledger.fiscal_years", "ledger.period_locks", "ledger.voucher_series"];

/** What a backend waits for, as pg_stat_activity shows it to a connection of the same role. */
async function waitEventOf(observer: Client, pid: number): Promise<string | null | undefined> {
  const found = await observer.query<{ event: string | null }>("SELECT wait_event AS event FROM pg_catalog.pg_stat_activity WHERE pid = $1", [pid]);
  return found.rows[0]?.event;
}

describe("a statement that switches the company between its rows", () => {
  let db: TestDatabase;
  let app: Client;
  const who = someUser();
  let first: Books;
  let second: Books;
  let voucher: Voucher;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    // The first company's year comes first in the table, so a scan in the
    // table's order reads it before the second company's.
    first = await addBooks(app, who);
    second = await addBooks(app, who);
    voucher = await bookVoucher(app, second.company, { year: second.year.id, series: "A", date: "2090-03-15", rows: balanced() }, who);
  });

  afterAll(async () => {
    await db.close();
  });

  // The statement starts with the first company set, so its trigger takes
  // that company's turn. Its condition then sets the second company, and
  // row level security lets it change the second company's year. The
  // change of the voucher's date takes the second company's turn at once,
  // and waits for the year's row: ledger.assert_in_own_year locks it before
  // it reads the year's dates.
  it("cuts another company's fiscal year without that company's turn, and the year's row lock still keeps a voucher's new date inside it", async () => {
    const [cutter, changer] = [await db.connect("app"), await db.connect("app")];
    const changerPid = await backendPid(changer);
    await begin(cutter, { company: first.company, ...who });
    try {
      await cutter.query("SET LOCAL enable_indexscan = off");
      await cutter.query("SET LOCAL enable_bitmapscan = off");
      const cut = await cutter.query(
        `UPDATE ledger.fiscal_years SET to_date = '2090-11-30'
         WHERE from_date = '2090-01-01' AND (company_id <> $1 OR pg_catalog.set_config('nortfox.company_id', $2, true) IS NULL)`,
        [first.company, second.company],
      );
      expect(cut.rowCount).toBe(1);
      const changed = expectRefusal(
        inTransaction(changer, { company: second.company, ...who }, () =>
          changer.query("UPDATE ledger.vouchers SET transaction_date = '2090-12-15' WHERE id = $1", [voucher.id]),
        ),
        "no_fiscal_year",
        { date: "2090-12-15" },
      );
      await untilWaitingForLock(app, changerPid);
      // It waits for the year's row, not at the turn.
      expect(await waitEventOf(app, changerPid)).toBe("transactionid");
      await cutter.query("COMMIT");
      await changed;
    } finally {
      await cutter.query("ROLLBACK");
    }
    const years = await inTransaction(app, { company: second.company }, async () =>
      (await app.query<FiscalYear>(`SELECT ${FISCAL_YEAR_COLUMNS} FROM ledger.fiscal_years`)).rows,
    );
    expect(years.map((year) => year.to_date)).toEqual(["2090-11-30"]);
    expect((await voucherOf(app, second.company, voucher.id))?.transaction_date).toBe("2090-03-15");
  });
});

describe("the row locks without the company's turn", () => {
  let db: TestDatabase;
  let app: Client;
  const who = someUser();
  const setter = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    const owner = await db.connect("owner");
    for (const table of TURN_TABLES) {
      await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER take_turn_alone`);
    }
    const found = await owner.query<{ table: string }>(
      `SELECT t.tgrelid::pg_catalog.regclass::text AS table FROM pg_catalog.pg_trigger AS t
       WHERE t.tgname = 'take_turn_alone' AND t.tgenabled = 'D' ORDER BY 1`,
    );
    expect(found.rows.map((row) => row.table)).toEqual(TURN_TABLES);
  });

  afterAll(async () => {
    await db.close();
  });

  type Work = (client: Client) => Promise<unknown>;

  /**
   * Runs `holder` open as the setter, starts `waiter` in a transaction of
   * its own, sees it wait for a row, commits the holder, and gives what the
   * waiter failed with, or undefined.
   */
  async function holds(books: Books, holder: Work, waiter: Work): Promise<unknown> {
    const [first, second] = [await db.connect("app"), await db.connect("app")];
    const secondPid = await backendPid(second);
    await begin(first, { company: books.company, ...setter });
    try {
      await holder(first);
      const waited = failureOf(inTransaction(second, { company: books.company, ...who }, () => waiter(second)));
      await untilWaitingForLock(app, secondPid);
      await first.query("COMMIT");
      return await waited;
    } finally {
      await first.query("ROLLBACK");
    }
  }

  /** Expects `failure` to be the refusal `reason`. */
  function expectRefused(failure: unknown, reason: RefusalReason): void {
    expect(readRefusal(failure)?.reason, String(failure)).toBe(reason);
  }

  const sql =
    (text: string, params: readonly unknown[] = []): Work =>
    (client) =>
      client.query(text, [...params]);
  const describeVoucher = (voucher: Voucher): Work => sql("UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [voucher.id]);
  const lockDate = (books: Books): Work => sql("INSERT INTO ledger.period_locks (company_id, scope, end_date) VALUES ($1, 'all', '2090-06-30')", [books.company]);

  /** Books with one voucher in series A, dated 2090-03-15. */
  async function oneVoucher(): Promise<{ books: Books; voucher: Voucher }> {
    const books = await addBooks(app, who);
    const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced() }, who);
    return { books, voucher };
  }

  // ledger.period_locks_rules locks the automatic lock row for update, and
  // ledger.lock_voucher_period locks it FOR SHARE.
  it("holds a change of a voucher while a lock date is being set, and then refuses it by that lock", async () => {
    const { books, voucher } = await oneVoucher();
    expectRefused(await holds(books, lockDate(books), describeVoucher(voucher)), "period_locked_manual");
    expect((await voucherOf(app, books.company, voucher.id))?.description).toBe(voucher.description);
  });

  it("holds a lock date while a change of a voucher is open, and sets it after that change", async () => {
    const { books, voucher } = await oneVoucher();
    expect(await holds(books, describeVoucher(voucher), lockDate(books))).toBeUndefined();
    const lock = await inTransaction(app, { company: books.company }, async () =>
      (await app.query<{ set_at: string }>("SELECT set_at::text AS set_at FROM ledger.period_locks")).rows[0],
    );
    expect(await isAfter(app, lock?.set_at ?? "", (await voucherOf(app, books.company, voucher.id))?.altered_at ?? "")).toBe(true);
  });

  it("holds a change of a voucher while the automatic lock is being turned on, and then refuses it by that lock", async () => {
    const books = await addBooks(app, who, "2020-01-01", "2020-12-31");
    const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2020-05-15", rows: balanced() }, who);
    expectRefused(
      await holds(books, sql("UPDATE ledger.automatic_locks SET enabled = true, interval = 'month_end_50'"), describeVoucher(voucher)),
      "period_locked_automatic",
    );
  });

  /** A day counted from today in Sweden, as the database gives it. */
  async function fromToday(days: number): Promise<string> {
    const found = await app.query<{ day: string }>("SELECT (ledger.today_in_sweden() + $1::integer)::text AS day", [days]);
    return found.rows[0]?.day ?? "";
  }

  /**
   * Books whose fiscal year runs from 200 days ago to 100 days ahead, with
   * the automatic lock on at 60 days after the year's end, and a voucher
   * dated 150 days ago. Cutting the year to end 100 days ago moves the lock
   * over the voucher.
   */
  async function yearEndBooks(): Promise<{ books: Books; voucher: Voucher; cut: Work }> {
    const books = await addBooks(app, who, await fromToday(-200), await fromToday(100));
    const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: await fromToday(-150), rows: balanced() }, who);
    await setAutomaticLock(app, books.company, "year_end_60", setter);
    return { books, voucher, cut: sql("UPDATE ledger.fiscal_years SET to_date = $1 WHERE id = $2", [await fromToday(-100), books.year.id]) };
  }

  // ledger.lock_voucher_period locks the voucher's fiscal year FOR SHARE.
  it("holds a change of a voucher while its fiscal year is cut short, and then refuses it by the automatic lock that moved over it", async () => {
    const { books, voucher, cut } = await yearEndBooks();
    expectRefused(await holds(books, cut, describeVoucher(voucher)), "period_locked_automatic");
  });

  it("holds a cut of the fiscal year while a change of one of its vouchers is open", async () => {
    const { books, voucher, cut } = await yearEndBooks();
    expect(await holds(books, describeVoucher(voucher), cut)).toBeUndefined();
    await expectRefusal(inTransaction(app, { company: books.company, ...who }, () => describeVoucher(voucher)(app)), "period_locked_automatic");
  });

  /** Books with Alla användare locked through 2090-06-30, and a voucher in the closing series I inside the lock. */
  async function closingBooks(): Promise<{ books: Books; voucher: Voucher; unmark: Work }> {
    const books = await addBooks(app, who);
    const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "I", date: "2090-03-10", rows: balanced() }, who);
    await setLock(app, books.company, "all", "2090-06-30", { who: setter });
    return { books, voucher, unmark: sql("UPDATE ledger.voucher_series SET is_closing = false WHERE fiscal_year_id = $1 AND code = 'I'", [books.year.id]) };
  }

  // ledger.lock_voucher_period reads the closing mark from the series' row, locked FOR SHARE.
  it("holds a change of a voucher in the closing series while the mark comes off, and then refuses it by the manual lock", async () => {
    const { books, voucher, unmark } = await closingBooks();
    expectRefused(await holds(books, unmark, describeVoucher(voucher)), "period_locked_manual");
  });

  it("holds taking the closing mark off while a change of a voucher in the series is open", async () => {
    const { books, voucher, unmark } = await closingBooks();
    expect(await holds(books, describeVoucher(voucher), unmark)).toBeUndefined();
    await expectRefusal(inTransaction(app, { company: books.company, ...who }, () => describeVoucher(voucher)(app)), "period_locked_manual");
  });

  // ledger.vouchers_book reads the manual flag from the series' row, locked FOR SHARE.
  it("holds a booking of a manual voucher while its series stops being manual, and then refuses it", async () => {
    const books = await addBooks(app, who);
    expectRefused(
      await holds(books, sql("UPDATE ledger.voucher_series SET manual = false WHERE fiscal_year_id = $1 AND code = 'A'", [books.year.id]), (client) =>
        writeVoucher(client, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced() }),
      ),
      "series_not_manual",
    );
  });

  // ledger.voucher_rows_add reads the active flag from the account's row, locked FOR SHARE.
  it("holds a new row on an account while the account is made inactive, and then refuses it", async () => {
    const { books, voucher } = await oneVoucher();
    expectRefused(
      await holds(books, sql("UPDATE ledger.accounts SET active = false WHERE fiscal_year_id = $1 AND number = 3001", [books.year.id]), (client) =>
        writeRow(client, books.company, voucher.id, { account: 3001 }),
      ),
      "account_inactive",
    );
    expect((await rowsOf(app, books.company, voucher.id)).length).toBe(2);
  });

  it("holds making an account inactive while a new row on it is open", async () => {
    const { books, voucher } = await oneVoucher();
    expect(
      await holds(
        books,
        (client) => writeRow(client, books.company, voucher.id, { account: 3001 }),
        sql("UPDATE ledger.accounts SET active = false WHERE fiscal_year_id = $1 AND number = 3001", [books.year.id]),
      ),
    ).toBeUndefined();
    expect((await rowsOf(app, books.company, voucher.id)).map((row) => row.account_number)).toEqual([6110, 1930, 3001]);
  });

  // ledger.voucher_series_rules locks the fiscal year's row for update before it looks for the code.
  it("holds a new series while another with the same code is being made in the year, and then refuses it with its reason", async () => {
    const books = await addBooks(app, who);
    const newSeries = sql("INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'B', 'Bank', true)", [
      books.company,
      books.year.id,
    ]);
    expectRefused(await holds(books, newSeries, newSeries), "series_code_duplicate");
  });

  // ledger.periods_rules locks the fiscal year's row FOR SHARE.
  it("holds a new period while its fiscal year is cut short, and then refuses it outside the year", async () => {
    const books = await addBooks(app, who);
    expectRefused(
      await holds(
        books,
        sql("UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1", [books.year.id]),
        sql("INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, '2090-12-01', '2090-12-31')", [books.company, books.year.id]),
      ),
      "period_outside_fiscal_year",
    );
  });

  it("holds a cut of the fiscal year while a new period of it is open, and then refuses the cut", async () => {
    const books = await addBooks(app, who);
    expectRefused(
      await holds(
        books,
        sql("INSERT INTO ledger.periods (company_id, fiscal_year_id, from_date, to_date) VALUES ($1, $2, '2090-12-01', '2090-12-31')", [books.company, books.year.id]),
        sql("UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1", [books.year.id]),
      ),
      "fiscal_year_strands_rows",
    );
  });

  // ledger.assert_in_own_year locks the voucher's own year's row FOR SHARE before it reads the years.
  it("holds a change of a voucher's date while its fiscal year is cut short, and then refuses the date outside the year", async () => {
    const { books, voucher } = await oneVoucher();
    expectRefused(
      await holds(
        books,
        sql("UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1", [books.year.id]),
        sql("UPDATE ledger.vouchers SET transaction_date = '2090-12-15' WHERE id = $1", [voucher.id]),
      ),
      "no_fiscal_year",
    );
    expect((await voucherOf(app, books.company, voucher.id))?.transaction_date).toBe("2090-03-15");
  });

  /**
   * The lock order: the setter makes `first`, `write` starts in another
   * transaction and waits for a row, and the setter then makes `second` and
   * commits. Gives how each ended.
   */
  async function inOrder(books: Books, first: Work, write: Work, second: Work): Promise<[setter: unknown, written: unknown]> {
    const [setterClient, writer] = [await db.connect("app"), await db.connect("app")];
    const writerPid = await backendPid(writer);
    await begin(setterClient, { company: books.company, ...setter });
    await first(setterClient);
    const written = failureOf(inTransaction(writer, { company: books.company, ...who }, () => write(writer)));
    await untilWaitingForLock(app, writerPid);
    const set = failureOf(
      (async () => {
        try {
          await second(setterClient);
          await setterClient.query("COMMIT");
        } catch (error) {
          await setterClient.query("ROLLBACK");
          throw error;
        }
      })(),
    );
    return [await set, await written];
  }

  // A booking locks the fiscal year's row before the series' row.
  it("never deadlocks a booking with a transaction that changes the fiscal year, then the series", async () => {
    const books = await addBooks(app, who);
    expect(
      await inOrder(
        books,
        sql("UPDATE ledger.fiscal_years SET is_default = true WHERE id = $1", [books.year.id]),
        (client) => writeVoucher(client, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced() }),
        sql("UPDATE ledger.voucher_series SET description = 'Manuella' WHERE fiscal_year_id = $1 AND code = 'A'", [books.year.id]),
      ),
    ).toEqual([undefined, undefined]);
  });

  // A new row locks the rows that the period lock reads before its account's row.
  it("never deadlocks a new row with a transaction that sets a lock date, then changes the account", async () => {
    const { books, voucher } = await oneVoucher();
    const [set, written] = await inOrder(
      books,
      lockDate(books),
      (client) => writeRow(client, books.company, voucher.id, { account: 3001 }),
      sql("UPDATE ledger.accounts SET description = 'Försäljning' WHERE fiscal_year_id = $1 AND number = 3001", [books.year.id]),
    );
    expect(set).toBeUndefined();
    expectRefused(written, "period_locked_manual");
  });
});
