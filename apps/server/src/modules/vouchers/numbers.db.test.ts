// SPDX-License-Identifier: AGPL-3.0-only

// Voucher numbers (rules 14 and 15 of the slice): each series numbers its
// vouchers 1, 2, 3 in each fiscal year, and starts again at 1 in the next
// year. A booking takes its number from the series' counter, in its own
// transaction, so two bookings at once get the next two numbers, and a
// refused or rolled-back voucher uses none. A number never changes.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, begin, expectRefusal, freshDatabase, inTransaction, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import { addBooks, addBooksYear, balanced, bookVoucher, nextNumberOf, someUser, writeVoucher, type Books, type NewVoucher } from "../../../test/ledger.ts";

describe("voucher numbers", () => {
  let db: TestDatabase;
  let app: Client;
  const who = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  function aVoucher(books: Books, changes: Partial<NewVoucher> = {}): NewVoucher {
    return { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(), ...changes };
  }

  it("gives 1, 2, 3 in each series and fiscal year, and starts again at 1 in the next year", async () => {
    const books = await addBooks(app);
    const next = await addBooksYear(app, books.company, "2091-01-01", "2091-12-31");
    const numbers: [string, number][] = [];
    for (const [year, series, date] of [
      [books.year.id, "A", "2090-01-10"],
      [books.year.id, "A", "2090-12-20"],
      [books.year.id, "I", "2090-12-31"],
      [next.id, "A", "2091-01-02"],
      [books.year.id, "A", "2090-02-01"],
      [next.id, "A", "2091-05-05"],
      [next.id, "I", "2091-12-31"],
    ] as const) {
      const voucher = await bookVoucher(app, books.company, aVoucher(books, { year, series, date }), who);
      numbers.push([`${year === next.id ? "2091" : "2090"} ${series}`, voucher.number]);
    }
    expect(numbers).toEqual([
      ["2090 A", 1],
      ["2090 A", 2],
      ["2090 I", 1],
      ["2091 A", 1],
      ["2090 A", 3],
      ["2091 A", 2],
      ["2091 I", 1],
    ]);
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(4);
    expect(await nextNumberOf(app, books.company, next.id, "A")).toBe(3);
    // Another company numbers its own series from 1.
    const other = await addBooks(app);
    expect((await bookVoucher(app, other.company, aVoucher(other), who)).number).toBe(1);
  });

  it("gives two bookings at once the next two numbers: the second waits for the first's counter", async () => {
    const books = await addBooks(app);
    const other = await db.connect("app");
    const otherPid = await backendPid(other);
    await begin(app, { company: books.company, ...who });
    await begin(other, { company: books.company, ...who });
    try {
      const first = await writeVoucher(app, books.company, aVoucher(books));
      const second = writeVoucher(other, books.company, aVoucher(books));
      await untilWaitingForLock(app, otherPid);
      await app.query("COMMIT");
      expect(first.number).toBe(1);
      expect((await second).number).toBe(2);
      await other.query("COMMIT");
    } finally {
      await other.query("ROLLBACK");
      await app.query("ROLLBACK");
    }
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(3);
  });

  it("gives the number of a booking that rolled back to the next one, while the other waits", async () => {
    const books = await addBooks(app);
    const other = await db.connect("app");
    const otherPid = await backendPid(other);
    await begin(app, { company: books.company, ...who });
    await begin(other, { company: books.company, ...who });
    try {
      await writeVoucher(app, books.company, aVoucher(books));
      const second = writeVoucher(other, books.company, aVoucher(books));
      await untilWaitingForLock(app, otherPid);
      await app.query("ROLLBACK");
      expect((await second).number).toBe(1);
      await other.query("COMMIT");
    } finally {
      await other.query("ROLLBACK");
    }
  });

  it("never changes a voucher's number, even to a free one", async () => {
    const books = await addBooks(app);
    const voucher = await bookVoucher(app, books.company, aVoucher(books), who);
    await expectRefusal(
      inTransaction(app, { company: books.company, ...who }, () => app.query("UPDATE ledger.vouchers SET number = 9 WHERE id = $1", [voucher.id])),
      "immutable_field",
      { field: "number", operation: "update" },
    );
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(2);
  });
});
