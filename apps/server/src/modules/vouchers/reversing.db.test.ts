// SPDX-License-Identifier: AGPL-3.0-only

// Ändringsverifikation (rules 27 to 30 of the slice): a booking can name an
// earlier voucher that it reverses, and the link reads both ways. A voucher
// has at most one reversing voucher at a time, of its own reference type.
// The reversing voucher is an ordinary voucher, with its own number and its
// own lock check, and its rows are not checked against the old voucher's.
// Deleting it removes the link, and the old voucher can then get a new one.
// A voucher whose date is locked for the actor can be named: the link
// changes nothing in it.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendPid, begin, expectError, expectRefusal, freshDatabase, inTransaction, untilWaitingForLock, type TestDatabase } from "../../../test/database.ts";
import {
  addBooks,
  balanced,
  bookVoucher,
  nextNumberOf,
  setLock,
  someUser,
  voucherOf,
  writeVoucher,
  type Books,
  type NewVoucher,
  type Voucher,
} from "../../../test/ledger.ts";

const FOREIGN_KEY_VIOLATION = "23503";

describe("Ändringsverifikation", () => {
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
    return { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n), ...changes };
  }

  /** The reversing voucher of `old`: its rows with debit and credit swapped. */
  function reversing(books: Books, old: Voucher, changes: Partial<NewVoucher> = {}): NewVoucher {
    return aVoucher(books, {
      description: `Ändringsverifikation A${String(old.number)}`,
      reverses: old.id,
      referenceType: old.reference_type,
      series: old.series_code,
      rows: balanced(2000n, 1930, 6110),
      ...changes,
    });
  }

  async function reversedBy(company: string, old: string): Promise<string[]> {
    return inTransaction(app, { company }, async () => {
      const found = await app.query<{ id: string }>("SELECT id FROM ledger.vouchers WHERE reverses_voucher_id = $1", [old]);
      return found.rows.map((row) => row.id);
    });
  }

  it("books a reversing voucher with its own number, linked to the old one, and the link reads both ways", async () => {
    const books = await addBooks(app);
    const old = await bookVoucher(app, books.company, aVoucher(books), who);
    const reverse = await bookVoucher(app, books.company, reversing(books, old), who);
    expect(reverse).toMatchObject({ number: 2, reverses_voucher_id: old.id, reference_type: "MANUAL", description: "Ändringsverifikation A1" });
    expect(await reversedBy(books.company, old.id)).toEqual([reverse.id]);
    // The old voucher is unchanged by the link.
    expect(await voucherOf(app, books.company, old.id)).toEqual(old);
  });

  it("checks no row of the reversing voucher against the old one's, and lets it be in another series", async () => {
    const books = await addBooks(app);
    const old = await bookVoucher(app, books.company, aVoucher(books), who);
    const reverse = await bookVoucher(
      app,
      books.company,
      reversing(books, old, { series: "I", rows: [{ account: 3001, amount: 1n }, { account: 1930, amount: -1n }] }),
      who,
    );
    expect(reverse).toMatchObject({ series_code: "I", number: 1, reverses_voucher_id: old.id });
  });

  it("refuses a second reversing voucher while the first exists, with the first one's series and number, and makes no link", async () => {
    const books = await addBooks(app);
    const old = await bookVoucher(app, books.company, aVoucher(books), who);
    const first = await bookVoucher(app, books.company, reversing(books, old, { series: "I" }), who);
    await expectRefusal(bookVoucher(app, books.company, reversing(books, old), who), "reversing_voucher_exists", { series: "I", number: first.number });
    expect(await reversedBy(books.company, old.id)).toEqual([first.id]);
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(2);
  });

  it("refuses a reversing voucher of another reference type, with both types, and makes no link", async () => {
    const books = await addBooks(app);
    const invoice = await bookVoucher(app, books.company, aVoucher(books, { series: "K", referenceType: "INVOICE" }), who);
    const manual = await bookVoucher(app, books.company, aVoucher(books), who);
    await expectRefusal(bookVoucher(app, books.company, reversing(books, invoice, { series: "A", referenceType: "MANUAL" }), who), "reversing_other_module", {
      reversed_type: "INVOICE",
      reversing_type: "MANUAL",
    });
    await expectRefusal(bookVoucher(app, books.company, reversing(books, manual, { series: "K", referenceType: "INVOICE" }), who), "reversing_other_module", {
      reversed_type: "MANUAL",
      reversing_type: "INVOICE",
    });
    expect(await reversedBy(books.company, invoice.id)).toEqual([]);
    expect(await reversedBy(books.company, manual.id)).toEqual([]);
    // The module's own booking, of the same type, may reverse it.
    const own = await bookVoucher(app, books.company, reversing(books, invoice), who);
    expect(own).toMatchObject({ series_code: "K", reference_type: "INVOICE", reverses_voucher_id: invoice.id });
  });

  it("refuses a link to a voucher that is not there, or is another company's", async () => {
    const books = await addBooks(app);
    const other = await addBooks(app);
    const theirs = await bookVoucher(app, other.company, aVoucher(other), who);
    await expectError(bookVoucher(app, books.company, aVoucher(books, { reverses: theirs.id }), who), FOREIGN_KEY_VIOLATION, /vouchers_reverses/);
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
  });

  it("keeps the old voucher while its reversing voucher exists, and after that is deleted points to none and takes a new one", async () => {
    const books = await addBooks(app);
    const old = await bookVoucher(app, books.company, aVoucher(books), who);
    const first = await bookVoucher(app, books.company, reversing(books, old, { series: "I" }), who);
    await bookVoucher(app, books.company, aVoucher(books), who);
    // The old voucher is not last in A here, so it cannot go anyway; the reversing link keeps it too.
    await expectRefusal(
      inTransaction(app, { company: books.company, ...who }, () => app.query("DELETE FROM ledger.vouchers WHERE id = $1", [old.id])),
      "not_last_in_series",
    );
    await inTransaction(app, { company: books.company, ...who }, () => app.query("DELETE FROM ledger.vouchers WHERE id = $1", [first.id]));
    expect(await reversedBy(books.company, old.id)).toEqual([]);
    const second = await bookVoucher(app, books.company, reversing(books, old), who);
    expect(await reversedBy(books.company, old.id)).toEqual([second.id]);
  });

  it("refuses to delete a voucher that a reversing voucher names, with that one's series and number, before the foreign key", async () => {
    const books = await addBooks(app);
    const old = await bookVoucher(app, books.company, aVoucher(books), who);
    const reverse = await bookVoucher(app, books.company, reversing(books, old, { series: "I" }), who);
    await expectRefusal(
      inTransaction(app, { company: books.company, ...who }, () => app.query("DELETE FROM ledger.vouchers WHERE id = $1", [old.id])),
      "reversing_voucher_exists",
      { series: "I", number: reverse.number },
    );
    expect(await voucherOf(app, books.company, old.id)).toEqual(old);
  });

  it("lets a reversing voucher dated where it is open name a voucher whose date is locked, and leaves that voucher as it was", async () => {
    const books = await addBooks(app);
    const old = await bookVoucher(app, books.company, aVoucher(books, { date: "2090-02-15" }), who);
    await setLock(app, books.company, "all", "2090-02-28");
    const before = await inTransaction(app, { company: books.company }, async () =>
      (await app.query<{ row: unknown }>("SELECT pg_catalog.to_jsonb(v) AS row FROM ledger.vouchers AS v WHERE id = $1", [old.id])).rows[0]?.row,
    );
    await expectRefusal(bookVoucher(app, books.company, reversing(books, old, { date: "2090-02-28" }), who), "period_locked_manual");
    const reverse = await bookVoucher(app, books.company, reversing(books, old, { date: "2090-03-01" }), who);
    expect(reverse.reverses_voucher_id).toBe(old.id);
    const after = await inTransaction(app, { company: books.company }, async () =>
      (await app.query<{ row: unknown }>("SELECT pg_catalog.to_jsonb(v) AS row FROM ledger.vouchers AS v WHERE id = $1", [old.id])).rows[0]?.row,
    );
    expect(after).toEqual(before);
    // The behandlingshistorik has no change of the old voucher.
    const changes = await inTransaction(app, { company: books.company }, async () =>
      app.query("SELECT operation FROM audit.history WHERE table_name = 'ledger.vouchers' AND row_id = $1 ORDER BY id", [old.id]),
    );
    expect(changes.rows).toEqual([{ operation: "INSERT" }]);
  });

  it("refuses the second of two reversing vouchers booked at the same time: it waits for the first, then sees it", async () => {
    const books = await addBooks(app);
    const old = await bookVoucher(app, books.company, aVoucher(books), who);
    const other = await db.connect("app");
    const otherPid = await backendPid(other);
    await begin(app, { company: books.company, ...who });
    await begin(other, { company: books.company, ...who });
    try {
      const first = await writeVoucher(app, books.company, reversing(books, old, { series: "I" }));
      const second = expectRefusal(writeVoucher(other, books.company, reversing(books, old)), "reversing_voucher_exists", {
        series: "I",
        number: first.number,
      });
      await untilWaitingForLock(app, otherPid);
      await app.query("COMMIT");
      await second;
    } finally {
      await other.query("ROLLBACK");
      await app.query("ROLLBACK");
    }
    expect(await reversedBy(books.company, old.id)).toHaveLength(1);
  });

  it("refuses a change of what a voucher reverses", async () => {
    const books = await addBooks(app);
    const old = await bookVoucher(app, books.company, aVoucher(books), who);
    const another = await bookVoucher(app, books.company, aVoucher(books), who);
    const reverse = await bookVoucher(app, books.company, reversing(books, old, { series: "I" }), who);
    for (const value of [another.id, null]) {
      await expectRefusal(
        inTransaction(app, { company: books.company, ...who }, () =>
          app.query("UPDATE ledger.vouchers SET reverses_voucher_id = $2 WHERE id = $1", [reverse.id, value]),
        ),
        "immutable_field",
        { field: "reverses_voucher_id", operation: "update" },
      );
    }
    expect(await voucherOf(app, books.company, reverse.id)).toEqual(reverse);
  });
});
