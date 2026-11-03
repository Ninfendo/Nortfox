// SPDX-License-Identifier: AGPL-3.0-only

// The period lock on vouchers (rules 34 and 37 to 39 of the slice). Where a
// date is locked for an actor, the database refuses that actor: booking a
// voucher dated there, any change to a voucher or its rows dated there, by
// its old date or its new date, and deleting one. Each refusal names the
// through-date, the kind of lock and, for a manual lock, who set it. Once the
// date is cleared, or the automatic lock turned off, the same acts pass. The
// closing series of the voucher's year passes every lock. A change of what a
// lock depends on and a change of a voucher never overlap: each waits for the
// other, so no change goes in under a lock that it did not see. That holds
// for a lock date, the automatic lock's settings, the end of the voucher's
// fiscal year, which places the automatic lock at 60 days after it, and the
// closing mark of the voucher's series.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, begin, expectRefusal, freshDatabase, inTransaction, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import {
  LOCK_VOUCHER,
  addBooks,
  addBooksYear,
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
  type Actor,
  type Books,
  type LockScope,
  type NewVoucher,
  type PeriodLock,
  type Voucher,
} from "../../../test/ledger.ts";

describe("the period lock on vouchers", () => {
  let db: TestDatabase;
  let app: Client;
  const setter = someUser();
  const booker = someUser();
  const userOne: Actor = someUser();
  const userTwo: Actor = someUser();
  const system: Actor = { actor: randomUUID(), kind: "system" };
  const integration: Actor = { actor: randomUUID(), kind: "integration" };
  // The database takes an actor as its id and its kind (ledger.current_actor).
  // So the internal system user or an integration with userOne's id is not
  // userOne, and userOne's own date never locks it.
  const systemWithOnesId: Actor = { actor: userOne.actor, kind: "system" };
  const integrationWithOnesId: Actor = { actor: userOne.actor, kind: "integration" };
  const ACTORS = { userOne, userTwo, system, integration, systemWithOnesId, integrationWithOnesId } as const;
  type ActorName = keyof typeof ACTORS;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  function aVoucher(books: Books, changes: Partial<NewVoucher> = {}): NewVoucher {
    return { year: books.year.id, series: "A", date: "2090-06-30", rows: balanced(2000n), ...changes };
  }

  /**
   * Strikes both rows of a voucher of two that balance, in one statement and
   * with no other write: the voucher still balances, so only the lock can
   * refuse it. Two checks of the lock see the strike: the row's own, and the
   * voucher's, when the strike moves the voucher's altered stamps. A write
   * that changes nothing in the row moves no stamps, so only the row's own
   * check sees it (below).
   */
  const STRIKE_BOTH = "UPDATE ledger.voucher_rows SET removed = true WHERE voucher_id = $1";

  /** The set_at of a lock row as the refusal's JSON gives it. */
  async function setAtAsJson(company: string, id: string): Promise<string> {
    return inTransaction(app, { company }, async () => {
      const found = await app.query<{ at: string }>("SELECT pg_catalog.to_jsonb(set_at) #>> '{}' AS at FROM ledger.period_locks WHERE id = $1", [id]);
      return found.rows[0]?.at ?? "";
    });
  }

  /** The facts of a refusal by a manual lock row. */
  async function manualFacts(company: string, lock: PeriodLock): Promise<Record<string, unknown>> {
    return {
      end_date: lock.end_date,
      source: lock.scope,
      user_id: lock.user_id,
      set_by: lock.set_by,
      set_by_kind: lock.set_by_kind,
      set_at: await setAtAsJson(company, lock.id),
    };
  }

  /** The facts of a refusal by the automatic lock, on month_end_50. */
  async function automaticFacts(company: string): Promise<Record<string, unknown>> {
    const through = await inTransaction(app, { company }, async () => {
      const found = await app.query<{ through: string }>("SELECT ledger.automatic_lock_end_date($1, ledger.today_in_sweden())::text AS through", [company]);
      return found.rows[0]?.through;
    });
    return { end_date: through, interval: "month_end_50" };
  }

  /** The acts that a lock refuses, each in its own transaction as `who`, on `voucher`, dated `day`. */
  function acts(books: Books, voucher: Voucher, who: Actor, day: string, open: string) {
    const as = <T>(work: () => Promise<T>): Promise<T> => inTransaction(app, { company: books.company, ...who }, work);
    return {
      book: () => bookVoucher(app, books.company, aVoucher(books, { series: voucher.series_code, referenceType: voucher.reference_type, date: day }), who),
      describe: () => as(() => app.query("UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [voucher.id])),
      moveOut: () => as(() => app.query("UPDATE ledger.vouchers SET transaction_date = $2 WHERE id = $1", [voucher.id, open])),
      moveIn: (other: Voucher) => as(() => app.query("UPDATE ledger.vouchers SET transaction_date = $2 WHERE id = $1", [other.id, day])),
      text: () => as(() => app.query("UPDATE ledger.voucher_rows SET transaction_information = 'Ny text' WHERE voucher_id = $1 AND position = 1", [voucher.id])),
      strike: () => as(() => app.query(STRIKE_BOTH, [voucher.id])),
      add: () => as(() => writeRow(app, books.company, voucher.id, { account: 3001 })),
      remove: () => as(() => app.query("DELETE FROM ledger.vouchers WHERE id = $1", [voucher.id])),
    };
  }

  /** Expects every act that the lock refuses to be refused with `reason` and `facts`, and nothing to change. */
  async function expectAllRefused(
    books: Books,
    voucher: Voucher,
    open: Voucher,
    who: Actor,
    day: string,
    reason: "period_locked_manual" | "period_locked_automatic",
    facts: Record<string, unknown>,
  ): Promise<void> {
    const act = acts(books, voucher, who, day, open.transaction_date);
    for (const [name, attempt] of [
      ["booking", act.book],
      ["a change of the description", act.describe],
      ["a change by its old date", act.moveOut],
      ["a change by its new date", () => act.moveIn(open)],
      ["a change of a row's text", act.text],
      ["a strike", act.strike],
      ["an added row", act.add],
      ["a deletion", act.remove],
    ] as const) {
      await expectRefusal(attempt(), reason, facts).catch((error: unknown) => {
        throw new Error(`${name}: ${String(error)}`, { cause: error });
      });
    }
    expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    expect(await voucherOf(app, books.company, open.id)).toEqual(open);
    expect((await rowsOf(app, books.company, voucher.id)).length).toBe(2);
  }

  /** Expects every act to pass: the last voucher can be changed and deleted, and a voucher booked. */
  async function expectAllAccepted(books: Books, voucher: Voucher, open: Voucher, who: Actor, day: string): Promise<void> {
    const act = acts(books, voucher, who, day, open.transaction_date);
    await act.describe();
    await act.text();
    await act.strike();
    await act.add();
    await act.moveOut();
    await act.moveIn(open);
    await act.remove();
    const booked = await act.book();
    expect(booked.transaction_date).toBe(day);
  }

  /** Books, while nothing is locked, a voucher dated `day` and, as the last of the series, an open one dated after the lock. */
  async function twoVouchers(books: Books, day: string, open: string, series = "A"): Promise<{ voucher: Voucher; open: Voucher }> {
    const referenceType = series === "K" ? "INVOICE" : "MANUAL";
    const openVoucher = await bookVoucher(app, books.company, aVoucher(books, { series, referenceType, date: open }), booker);
    const voucher = await bookVoucher(app, books.company, aVoucher(books, { series, referenceType, date: day }), booker);
    return { voucher, open: openVoucher };
  }

  describe("a manual date", () => {
    const END = "2090-06-30";
    const cases: readonly { scope: LockScope; user?: ActorName; locks: readonly ActorName[] }[] = [
      { scope: "user", user: "userOne", locks: ["userOne"] },
      { scope: "system", locks: ["system", "systemWithOnesId"] },
      { scope: "integration", locks: ["integration", "integrationWithOnesId"] },
      { scope: "all", locks: ["userOne", "userTwo", "system", "integration", "systemWithOnesId", "integrationWithOnesId"] },
    ];

    it.each(cases)("set only for $scope $user refuses those it applies to, the date itself included, and no one else, not the system user or an integration with the user's id", async ({ scope, user, locks }) => {
      for (const name of Object.keys(ACTORS) as ActorName[]) {
        const who = ACTORS[name];
        const books = await addBooks(app);
        const { voucher, open } = await twoVouchers(books, END, "2090-07-01");
        const lock = await setLock(app, books.company, scope, END, user === undefined ? { who: setter } : { user: ACTORS[user].actor, who: setter });
        if (locks.includes(name)) {
          await expectAllRefused(books, voucher, open, who, END, "period_locked_manual", await manualFacts(books.company, lock));
          // A day before is locked too, the day after is open.
          await expectRefusal(bookVoucher(app, books.company, aVoucher(books, { date: "2090-01-01" }), who), "period_locked_manual");
          expect((await bookVoucher(app, books.company, aVoucher(books, { date: "2090-07-01" }), who)).transaction_date).toBe("2090-07-01");
        } else {
          await expectAllAccepted(books, voucher, open, who, END);
        }
      }
    });

    it("with two dates for one actor, locks up to the later, and names the later lock", async () => {
      const books = await addBooks(app);
      const { voucher, open } = await twoVouchers(books, "2090-05-31", "2090-07-01");
      await setLock(app, books.company, "user", "2090-03-31", { user: userOne.actor, who: setter });
      const all = await setLock(app, books.company, "all", "2090-06-30", { who: setter });
      await expectAllRefused(books, voucher, open, userOne, "2090-05-31", "period_locked_manual", await manualFacts(books.company, all));
      const later = await setLock(app, books.company, "user", "2090-06-30", { user: userOne.actor, who: integration });
      // On a tie the actor's own lock is named.
      const facts = await manualFacts(books.company, later);
      await expectRefusal(bookVoucher(app, books.company, aVoucher(books, { date: "2090-02-01" }), userOne), "period_locked_manual", facts);
    });

    it("after the date is cleared, accepts the change and the deletion it refused", async () => {
      const books = await addBooks(app);
      const { voucher, open } = await twoVouchers(books, END, "2090-07-01");
      const lock = await setLock(app, books.company, "all", END, { who: setter });
      await expectAllRefused(books, voucher, open, userTwo, END, "period_locked_manual", await manualFacts(books.company, lock));
      await setLock(app, books.company, "all", null, { who: setter });
      await expectAllAccepted(books, voucher, open, userTwo, END);
    });

    it("refuses a strike, a text and an added row by the voucher's date, in a series that is not manual too", async () => {
      const books = await addBooks(app);
      const { voucher } = await twoVouchers(books, "2090-02-15", "2090-07-01", "K");
      const lock = await setLock(app, books.company, "integration", "2090-02-28", { who: setter });
      const facts = await manualFacts(books.company, lock);
      const act = acts(books, voucher, integration, "2090-02-15", "2090-07-01");
      await expectRefusal(act.text(), "period_locked_manual", facts);
      await expectRefusal(act.add(), "period_locked_manual", facts);
      await expectRefusal(act.strike(), "period_locked_manual", facts);
    });

    // A write that changes nothing in a row moves no stamps of its voucher,
    // so the voucher's own check of the lock never runs for it. The row's
    // check refuses it, and the behandlingshistorik gets no row of it.
    it("refuses a strike of a struck row and a row's text set to itself by the lock, and writes no history", async () => {
      const books = await addBooks(app);
      const voucher = await bookVoucher(app, books.company, aVoucher(books, { date: "2090-03-10", rows: [...balanced(2000n), { account: 3001 }] }), booker);
      const rows = await rowsOf(app, books.company, voucher.id);
      const zero = rows[2]?.id;
      await inTransaction(app, { company: books.company, ...userOne }, () => app.query("UPDATE ledger.voucher_rows SET removed = true WHERE id = $1", [zero]));
      const struck = await rowsOf(app, books.company, voucher.id);
      const lock = await setLock(app, books.company, "all", END, { who: setter });
      const facts = await manualFacts(books.company, lock);
      const historyCount = async (): Promise<bigint | undefined> =>
        inTransaction(app, { company: books.company }, async () => {
          const found = await app.query<{ count: bigint }>(
            "SELECT count(*) AS count FROM audit.history WHERE table_name IN ('ledger.vouchers', 'ledger.voucher_rows')",
          );
          return found.rows[0]?.count;
        });
      const before = await historyCount();
      const as = <T>(work: () => Promise<T>): Promise<T> => inTransaction(app, { company: books.company, ...userOne }, work);
      await expectRefusal(as(() => app.query("UPDATE ledger.voucher_rows SET removed = true WHERE id = $1", [zero])), "period_locked_manual", facts);
      await expectRefusal(
        as(() => app.query("UPDATE ledger.voucher_rows SET transaction_information = transaction_information WHERE id = $1", [rows[0]?.id])),
        "period_locked_manual",
        facts,
      );
      expect(await historyCount()).toBe(before);
      expect(await rowsOf(app, books.company, voucher.id)).toEqual(struck);
    });

    // The row's own check of the lock comes before the table's checks of its
    // values, as each check of a booking comes in its order. So a row that a
    // check would refuse too is refused by the lock.
    it("refuses an added row by the lock before the table's checks of its values", async () => {
      const books = await addBooks(app);
      const { voucher } = await twoVouchers(books, "2090-03-10", "2090-07-01");
      const lock = await setLock(app, books.company, "all", END, { who: setter });
      const facts = await manualFacts(books.company, lock);
      for (const row of [{ account: 3001, debit: -1n }, { account: 3001, credit: -1n }, { account: 3001, quantity: "NaN" }]) {
        await expectRefusal(inTransaction(app, { company: books.company, ...userOne }, () => writeRow(app, books.company, voucher.id, row)), "period_locked_manual", facts);
      }
      expect((await rowsOf(app, books.company, voucher.id)).length).toBe(2);
    });
  });

  describe("set while a voucher changes", () => {
    const DESCRIBE = "UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1";

    it("holds a change of a voucher until a lock that is being set commits, and then refuses it by that lock", async () => {
      const books = await addBooks(app);
      const voucher = await bookVoucher(app, books.company, aVoucher(books, { date: "2090-06-10" }), booker);
      const other = await db.connect("app");
      const otherPid = await backendPid(other);
      await begin(app, { company: books.company, ...setter });
      try {
        await app.query("INSERT INTO ledger.period_locks (company_id, scope, end_date) VALUES ($1, 'all', '2090-06-30')", [books.company]);
        const changed = expectRefusal(
          inTransaction(other, { company: books.company, ...userOne }, () => other.query(DESCRIBE, [voucher.id])),
          "period_locked_manual",
        );
        await untilWaitingForLock(app, otherPid);
        await app.query("COMMIT");
        await changed;
      } finally {
        await app.query("ROLLBACK");
      }
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    });

    it("holds a lock that is being set until an open change of a voucher commits, and sets it after that change", async () => {
      const books = await addBooks(app);
      const voucher = await bookVoucher(app, books.company, aVoucher(books, { date: "2090-06-10" }), booker);
      const other = await db.connect("app");
      const otherPid = await backendPid(other);
      await begin(app, { company: books.company, ...userOne });
      let altered: string | null | undefined;
      try {
        altered = (await app.query<{ altered_at: string | null }>(`${DESCRIBE} RETURNING altered_at::text AS altered_at`, [voucher.id])).rows[0]?.altered_at;
        const locked = setLock(other, books.company, "all", "2090-06-30", { who: setter });
        await untilWaitingForLock(app, otherPid);
        await app.query("COMMIT");
        const lock = await locked;
        expect(await isAfter(app, lock.set_at, altered ?? "")).toBe(true);
      } finally {
        await app.query("ROLLBACK");
      }
      expect((await voucherOf(app, books.company, voucher.id))?.altered_at).toBe(altered);
      await expectRefusal(inTransaction(app, { company: books.company, ...userOne }, () => app.query(DESCRIBE, [voucher.id])), "period_locked_manual");
    });

    /**
     * Each kind of change of a voucher, run as `client` in its open
     * transaction. A row change locks its voucher first, as every caller
     * does (db/README.md, the lock order).
     */
    const CHANGES: readonly (readonly [string, (client: Client, books: Books, voucher: Voucher) => Promise<unknown>])[] = [
      ["a booking", (client, books, voucher) => writeVoucher(client, books.company, aVoucher(books, { series: voucher.series_code, date: voucher.transaction_date }))],
      ["a change of the description", (client, _books, voucher) => client.query(DESCRIBE, [voucher.id])],
      [
        "a change of a row's text",
        async (client, _books, voucher) => {
          await client.query(LOCK_VOUCHER, [voucher.id]);
          await client.query("UPDATE ledger.voucher_rows SET transaction_information = 'Ny text' WHERE voucher_id = $1 AND position = 1", [voucher.id]);
        },
      ],
      [
        "a strike",
        async (client, _books, voucher) => {
          await client.query(LOCK_VOUCHER, [voucher.id]);
          await client.query(STRIKE_BOTH, [voucher.id]);
        },
      ],
      ["an added row", (client, books, voucher) => writeRow(client, books.company, voucher.id, { account: 3001 })],
      ["a deletion", (client, _books, voucher) => client.query("DELETE FROM ledger.vouchers WHERE id = $1", [voucher.id])],
    ];

    /** A day counted from today in Sweden, as the database gives it. */
    async function fromToday(days: number): Promise<string> {
      const found = await app.query<{ day: string }>("SELECT (ledger.today_in_sweden() + $1::integer)::text AS day", [days]);
      return found.rows[0]?.day ?? "";
    }

    /**
     * Books whose one fiscal year runs from 200 days ago to 100 days ahead,
     * with the automatic lock on at 60 days after the year's end, so it locks
     * nothing yet, and one voucher in series A, dated 150 days ago. Cutting
     * the year short to end 100 days ago moves the lock over the voucher.
     */
    async function yearEndBooks(): Promise<{ books: Books; voucher: Voucher; shorten: string; shortEnd: string }> {
      const books = await addBooks(app, someUser(), await fromToday(-200), await fromToday(100));
      const voucher = await bookVoucher(app, books.company, aVoucher(books, { date: await fromToday(-150) }), booker);
      await setAutomaticLock(app, books.company, "year_end_60", setter);
      const shortEnd = await fromToday(-100);
      return { books, voucher, shorten: `UPDATE ledger.fiscal_years SET to_date = '${shortEnd}' WHERE id = '${books.year.id}'`, shortEnd };
    }

    /** Books with Alla användare locked through 2090-06-30 and one voucher in the closing series I, dated 2090-03-10, inside the lock. */
    async function closingBooks(): Promise<{ books: Books; voucher: Voucher; unmark: string }> {
      const books = await addBooks(app);
      const voucher = await bookVoucher(app, books.company, aVoucher(books, { series: "I", date: "2090-03-10" }), booker);
      await setLock(app, books.company, "all", "2090-06-30", { who: setter });
      return { books, voucher, unmark: `UPDATE ledger.voucher_series SET is_closing = false WHERE fiscal_year_id = '${books.year.id}' AND code = 'I'` };
    }

    /** Runs `change` open as `userOne`, starts `writer` in another connection, sees it wait, then commits both, the change first. */
    async function changeFirst(books: Books, voucher: Voucher, change: (typeof CHANGES)[number][1], writer: string): Promise<void> {
      const other = await db.connect("app");
      const otherPid = await backendPid(other);
      await begin(app, { company: books.company, ...userOne });
      try {
        await change(app, books, voucher);
        const written = inTransaction(other, { company: books.company, ...setter }, () => other.query(writer));
        await untilWaitingForLock(app, otherPid);
        await app.query("COMMIT");
        await written;
      } finally {
        await app.query("ROLLBACK");
      }
    }

    /** Runs `writer` open, starts `change` in another connection, sees it wait, then commits the writer and expects the change refused with `reason`. */
    async function writerFirst(
      books: Books,
      voucher: Voucher,
      change: (typeof CHANGES)[number][1],
      writer: string,
      reason: "period_locked_manual" | "period_locked_automatic",
    ): Promise<void> {
      const other = await db.connect("app");
      const otherPid = await backendPid(other);
      await begin(app, { company: books.company, ...setter });
      try {
        await app.query(writer);
        const changed = expectRefusal(
          inTransaction(other, { company: books.company, ...userOne }, () => change(other, books, voucher)),
          reason,
        );
        await untilWaitingForLock(app, otherPid);
        await app.query("COMMIT");
        await changed;
      } finally {
        await app.query("ROLLBACK");
      }
    }

    it.each(CHANGES)("holds a cut of the voucher's fiscal year, which moves the automatic lock over it, until %s commits", async (_name, change) => {
      const { books, voucher, shorten, shortEnd } = await yearEndBooks();
      await changeFirst(books, voucher, change, shorten);
      // The cut came after the change, and now locks the voucher's date.
      await expectRefusal(bookVoucher(app, books.company, aVoucher(books, { date: voucher.transaction_date }), userOne), "period_locked_automatic", {
        end_date: shortEnd,
        interval: "year_end_60",
      });
    });

    it.each(CHANGES)("holds %s until a cut of the fiscal year commits, and then refuses it by the automatic lock that moved over it", async (_name, change) => {
      const { books, voucher, shorten } = await yearEndBooks();
      const rows = await rowsOf(app, books.company, voucher.id);
      await writerFirst(books, voucher, change, shorten, "period_locked_automatic");
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
      expect(await rowsOf(app, books.company, voucher.id)).toEqual(rows);
    });

    it.each(CHANGES)("holds taking the closing mark off a series until %s in it commits", async (_name, change) => {
      const { books, voucher, unmark } = await closingBooks();
      await changeFirst(books, voucher, change, unmark);
      // The mark came off after the change, and the lock now holds the series.
      await expectRefusal(bookVoucher(app, books.company, aVoucher(books, { series: "I", date: "2090-03-10" }), userOne), "period_locked_manual");
    });

    it.each(CHANGES)("holds %s in the closing series until the mark comes off, and then refuses it by the manual lock", async (_name, change) => {
      const { books, voucher, unmark } = await closingBooks();
      const rows = await rowsOf(app, books.company, voucher.id);
      await writerFirst(books, voucher, change, unmark, "period_locked_manual");
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
      expect(await rowsOf(app, books.company, voucher.id)).toEqual(rows);
    });
  });

  describe("the automatic lock", () => {
    /** Books in a fiscal year 2020, which the automatic lock covers on any day this slice runs. */
    async function books2020(): Promise<Books> {
      return addBooks(app, someUser(), "2020-01-01", "2020-12-31");
    }

    it("refuses a user, the internal system user and an integration every act on a voucher dated on or before its date", async () => {
      for (const who of Object.values(ACTORS)) {
        const books = await books2020();
        const { voucher, open } = await twoVouchers(books, "2020-05-15", "2020-06-15");
        await setAutomaticLock(app, books.company, "month_end_50", setter);
        await expectAllRefused(books, voucher, open, who, "2020-05-15", "period_locked_automatic", await automaticFacts(books.company));
      }
    });

    it("after it is turned off, accepts the change and the deletion it refused", async () => {
      const books = await books2020();
      const { voucher, open } = await twoVouchers(books, "2020-05-15", "2020-06-15");
      await setAutomaticLock(app, books.company, "month_end_50", setter);
      await expectAllRefused(books, voucher, open, system, "2020-05-15", "period_locked_automatic", await automaticFacts(books.company));
      await setAutomaticLock(app, books.company, null, setter);
      await expectAllAccepted(books, voucher, open, system, "2020-05-15");
    });

    it("holds a change of a voucher until the automatic lock that is being turned on commits, and then refuses it by that lock", async () => {
      const books = await books2020();
      const voucher = await bookVoucher(app, books.company, aVoucher(books, { date: "2020-05-15" }), booker);
      const other = await db.connect("app");
      const otherPid = await backendPid(other);
      await begin(app, { company: books.company, ...setter });
      try {
        await app.query("UPDATE ledger.automatic_locks SET enabled = true, interval = 'month_end_50'");
        const changed = expectRefusal(
          inTransaction(other, { company: books.company, ...userOne }, () =>
            other.query("UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [voucher.id]),
          ),
          "period_locked_automatic",
        );
        await untilWaitingForLock(app, otherPid);
        await app.query("COMMIT");
        await changed;
      } finally {
        await app.query("ROLLBACK");
      }
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    });

    it("names a manual lock with a later date than the automatic one", async () => {
      const books = await books2020();
      await setAutomaticLock(app, books.company, "month_end_50", setter);
      const lock = await setLock(app, books.company, "all", "2099-12-31", { who: setter });
      const facts = await manualFacts(books.company, lock);
      await expectRefusal(bookVoucher(app, books.company, aVoucher(books, { date: "2020-05-15" }), userOne), "period_locked_manual", facts);
    });
  });

  describe("the closing series", () => {
    it("is booked, changed and deleted as the last of its series inside the manual and the automatic lock", async () => {
      for (const lockIt of ["manual", "automatic"] as const) {
        const books = lockIt === "manual" ? await addBooks(app) : await addBooks(app, someUser(), "2020-01-01", "2020-12-31");
        const day = lockIt === "manual" ? "2090-06-30" : "2020-06-30";
        const other = lockIt === "manual" ? "2090-01-15" : "2020-01-15";
        const { voucher, open } = await twoVouchers(books, day, other, "I");
        if (lockIt === "manual") {
          await setLock(app, books.company, "all", "2090-12-31", { who: setter });
        } else {
          await setAutomaticLock(app, books.company, "month_end_50", setter);
        }
        for (const who of Object.values(ACTORS)) {
          // Another series of the same year is locked.
          await expectRefusal(bookVoucher(app, books.company, aVoucher(books, { date: day }), who), lockIt === "manual" ? "period_locked_manual" : "period_locked_automatic");
        }
        await expectAllAccepted(books, voucher, open, userOne, day);
      }
    });

    // The closing mark is set per fiscal year. A series with the code of
    // another year's closing series is not the closing series of its own
    // year, so the lock holds it.
    it("passes the lock only in the closing series of the voucher's own fiscal year, not in a series of another year with that year's closing code", async () => {
      for (const lockIt of ["manual", "automatic"] as const) {
        const [first, second] = lockIt === "manual" ? ["2090", "2091"] : ["2020", "2021"];
        const books = await addBooks(app, someUser(), `${first}-01-01`, `${first}-12-31`);
        const next: Books = { company: books.company, year: await addBooksYear(app, books.company, `${second}-01-01`, `${second}-12-31`) };
        // Series I is the closing series of the first year only.
        const unmarked = await inTransaction(app, { company: books.company, ...setter }, () =>
          app.query("UPDATE ledger.voucher_series SET is_closing = false WHERE fiscal_year_id = $1 AND code = 'I' AND is_closing", [next.year.id]),
        );
        expect(unmarked.rowCount).toBe(1);
        const closing = await twoVouchers(books, `${first}-06-30`, `${first}-01-15`, "I");
        const day = `${second}-03-15`;
        const inSecond = await twoVouchers(next, day, `${second}-09-15`, "I");
        let reason: "period_locked_manual" | "period_locked_automatic";
        let facts: Record<string, unknown>;
        if (lockIt === "manual") {
          const lock = await setLock(app, books.company, "all", `${second}-06-30`, { who: setter });
          reason = "period_locked_manual";
          facts = await manualFacts(books.company, lock);
        } else {
          await setAutomaticLock(app, books.company, "month_end_50", setter);
          reason = "period_locked_automatic";
          facts = await automaticFacts(books.company);
        }
        await expectAllRefused(next, inSecond.voucher, inSecond.open, userOne, day, reason, facts);
        await expectAllAccepted(books, closing.voucher, closing.open, userOne, `${first}-06-30`);
      }
    });
  });
});
