// SPDX-License-Identifier: AGPL-3.0-only

// The modified time (rule 24 of the slice): every accepted change to a
// voucher or its rows moves the voucher's modified time, and a refused change
// moves nothing. Every move of a series' next number, by a booking, by the
// deletion of the last voucher or by a void range, moves the series' modified
// time as lastmodified reads it, as in the established system, where a booked
// voucher moves its series' lastmodified. The counter keeps that time, and the
// series' lastmodified is the later of its own and its counter's. The
// accounts' and the series' own modified times are tested with them.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectError, expectRefusal, failureOf, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  addBooks,
  balanced,
  bookVoucher,
  isAfter,
  recordVoidRange,
  setLock,
  someUser,
  voucherOf,
  writeRow,
  writeVoucher,
  type Books,
  type Voucher,
} from "../../../test/ledger.ts";

/** PostgreSQL's SQLSTATE for a NOT NULL column that refused a value. */
const NOT_NULL_VIOLATION = "23502";

describe("a voucher's modified time", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  const who = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  async function booked(books: Books): Promise<Voucher> {
    return bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n) }, who);
  }

  async function asApp(company: string, sql: string, params: readonly unknown[]): Promise<void> {
    await inTransaction(app, { company, ...who }, () => app.query(sql, [...params]));
  }

  it("moves with every accepted change to the voucher or its rows", async () => {
    const books = await addBooks(app);
    let voucher = await booked(books);
    const changes: readonly (readonly [string, () => Promise<unknown>])[] = [
      ["the description", () => asApp(books.company, "UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [voucher.id])],
      ["the date", () => asApp(books.company, "UPDATE ledger.vouchers SET transaction_date = '2090-03-16' WHERE id = $1", [voucher.id])],
      ["a row's text", () => asApp(books.company, "UPDATE ledger.voucher_rows SET transaction_information = 'Rad' WHERE voucher_id = $1 AND position = 1", [voucher.id])],
      ["an added row", () => inTransaction(app, { company: books.company, ...who }, () => writeRow(app, books.company, voucher.id, { account: 3001 }))],
      ["a strike", () => asApp(books.company, "UPDATE ledger.voucher_rows SET removed = true WHERE voucher_id = $1 AND position = 3", [voucher.id])],
    ];
    for (const [change, run] of changes) {
      await run();
      const after = await voucherOf(app, books.company, voucher.id);
      expect(await isAfter(app, after?.modified_at ?? "", voucher.modified_at), change).toBe(true);
      expect(after?.modified_at, change).toBe(after?.altered_at);
      voucher = after ?? voucher;
    }
  });

  it("moves with no refused change, and with no change that leaves everything as it was", async () => {
    const books = await addBooks(app);
    const voucher = await booked(books);
    await expectRefusal(asApp(books.company, "UPDATE ledger.vouchers SET description = 'Ny', series_code = 'I' WHERE id = $1", [voucher.id]), "immutable_field");
    await expectRefusal(asApp(books.company, "UPDATE ledger.vouchers SET description = '' WHERE id = $1", [voucher.id]), "description_missing");
    await expectRefusal(asApp(books.company, "UPDATE ledger.vouchers SET transaction_date = '2091-01-01' WHERE id = $1", [voucher.id]), "no_fiscal_year");
    await expectRefusal(asApp(books.company, "UPDATE ledger.voucher_rows SET transaction_information = 'Ny', debit = 1 WHERE voucher_id = $1", [voucher.id]), "immutable_field");
    // Refused at commit: a strike that leaves the voucher out of balance, and an added row out of balance.
    await expectRefusal(asApp(books.company, "UPDATE ledger.voucher_rows SET removed = true WHERE voucher_id = $1 AND position = 1", [voucher.id]), "unbalanced");
    await expectRefusal(
      inTransaction(app, { company: books.company, ...who }, () => writeRow(app, books.company, voucher.id, { account: 3001, debit: 1n })),
      "unbalanced",
    );
    await expectError(asApp(books.company, "UPDATE ledger.voucher_rows SET transaction_information = NULL WHERE voucher_id = $1", [voucher.id]), NOT_NULL_VIOLATION);
    // Refused by the lock.
    await setLock(app, books.company, "all", "2090-03-31");
    await expectRefusal(asApp(books.company, "UPDATE ledger.vouchers SET description = 'Låst' WHERE id = $1", [voucher.id]), "period_locked_manual");
    await setLock(app, books.company, "all", null);
    // A change to the same values.
    await asApp(books.company, "UPDATE ledger.vouchers SET description = description, transaction_date = transaction_date WHERE id = $1", [voucher.id]);
    await asApp(books.company, "UPDATE ledger.voucher_rows SET transaction_information = transaction_information WHERE voucher_id = $1", [voucher.id]);
    expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
  });

  /** The series A of the books' year: its own modified time, its counter's, the next number, and lastmodified, the later of the two times. */
  async function seriesA(books: Books): Promise<{ own: string; counter: string; next: number; lastmodified: string }> {
    return inTransaction(app, { company: books.company }, async () => {
      const found = await app.query<{ own: string; counter: string; next: number; lastmodified: string }>(
        `SELECT s.modified_at::text AS own, c.modified_at::text AS counter, c.next_number AS next,
           greatest(s.modified_at, c.modified_at)::text AS lastmodified
         FROM ledger.voucher_series AS s JOIN ledger.voucher_counters AS c ON c.series_id = s.id
         WHERE s.fiscal_year_id = $1 AND s.code = 'A'`,
        [books.year.id],
      );
      const [row] = found.rows;
      if (row === undefined) {
        throw new Error("The books have no series A.");
      }
      return row;
    });
  }

  it("moves the series' modified time with every move of its next number: a booking, a deletion and a void range", async () => {
    const books = await addBooks(app);
    let before = await seriesA(books);
    expect(before.counter).toBe(before.lastmodified);
    let last: Voucher | undefined;
    const moves: readonly (readonly [string, () => Promise<unknown>])[] = [
      ["a booking", async () => (last = await booked(books))],
      ["the deletion of the last voucher", () => asApp(books.company, "DELETE FROM ledger.vouchers WHERE id = $1", [last?.id])],
      ["a void range", () => recordVoidRange(owner, books.company, { year: books.year.id, code: "A", first: 1, last: 2 })],
    ];
    for (const [move, run] of moves) {
      await run();
      const after = await seriesA(books);
      expect(after.next, move).not.toBe(before.next);
      expect(await isAfter(app, after.counter, before.counter), move).toBe(true);
      expect(after.lastmodified, move).toBe(after.counter);
      // The series' own row stays as it was: a booking never writes it.
      expect(after.own, move).toBe(before.own);
      before = after;
    }
  });

  it("leaves the series' modified time with a booking that is refused or rolled back, a deletion that is refused, and a change of a voucher", async () => {
    const books = await addBooks(app);
    const first = await booked(books);
    await booked(books);
    const before = await seriesA(books);
    await expectRefusal(
      bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: [{ account: 6110, debit: 1n }] }, who),
      "too_few_rows",
    );
    const rolledBack = await failureOf(
      inTransaction(app, { company: books.company, ...who }, async () => {
        await writeVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n) });
        throw new Error("rolled back");
      }),
    );
    expect(String(rolledBack)).toContain("rolled back");
    await expectRefusal(asApp(books.company, "DELETE FROM ledger.vouchers WHERE id = $1", [first.id]), "not_last_in_series");
    await asApp(books.company, "UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [first.id]);
    expect(await seriesA(books)).toEqual(before);
  });
});
