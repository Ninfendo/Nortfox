// SPDX-License-Identifier: AGPL-3.0-only

// The modified time (rule 24 of the slice): every accepted change to a
// voucher or its rows moves the voucher's modified time, and a refused change
// moves nothing. A booking never moves its series' modified time, since the
// counter is a table of its own. The accounts' and the series' own modified
// times are tested with them.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  SERIES_COLUMNS,
  addBooks,
  balanced,
  bookVoucher,
  isAfter,
  setLock,
  someUser,
  voucherOf,
  writeRow,
  type Books,
  type Voucher,
  type VoucherSeries,
} from "../../../test/ledger.ts";

/** PostgreSQL's SQLSTATE for a NOT NULL column that refused a value. */
const NOT_NULL_VIOLATION = "23502";

describe("a voucher's modified time", () => {
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

  it("never moves the series' modified time: a booking and a deletion only move its counter", async () => {
    const books = await addBooks(app);
    const read = async (): Promise<VoucherSeries | undefined> =>
      inTransaction(app, { company: books.company }, async () => {
        const found = await app.query<VoucherSeries>(`SELECT ${SERIES_COLUMNS} FROM ledger.voucher_series WHERE fiscal_year_id = $1 AND code = 'A'`, [books.year.id]);
        return found.rows[0];
      });
    const series = await read();
    const voucher = await booked(books);
    await asApp(books.company, "UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [voucher.id]);
    await asApp(books.company, "DELETE FROM ledger.vouchers WHERE id = $1", [voucher.id]);
    expect(await read()).toEqual(series);
  });
});
