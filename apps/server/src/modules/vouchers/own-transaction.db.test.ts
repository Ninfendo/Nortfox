// SPDX-License-Identifier: AGPL-3.0-only

// The booking's own transaction (db/README.md, Ändra). A row added there is
// part of the booking, so its lock check is the booking's. A change there
// sets no altered stamps, and a strike there is refused. A transaction's id
// is unique only in the history of one cluster: a dump restored into another
// cluster brings the old ids in created_xact, and that cluster gives the
// same ids out again, so the app could use them up until it holds one. So a
// voucher counts as booked in the transaction only when it carries the
// transaction's id and was booked after the transaction began. Here the
// superuser gives a voucher booked earlier the id of the app's open
// transaction, with the triggers off, as such a restore would leave it.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { begin, expectRefusal, freshDatabase, type TestDatabase } from "../../../test/database.ts";
import {
  LOCK_VOUCHER,
  addBooks,
  balanced,
  bookVoucher,
  rowsOf,
  setLock,
  someUser,
  voucherOf,
  writeRow,
  type Books,
  type Voucher,
} from "../../../test/ledger.ts";

describe("the booking's own transaction", () => {
  let db: TestDatabase;
  let app: Client;
  let admin: Client;
  const booker = someUser();
  const setter = someUser();
  const changer = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    admin = await db.admin();
  });

  afterAll(async () => {
    await db.close();
  });

  /** Books with one voucher dated 2090-03-15, booked in a transaction of its own, before the test's. */
  async function bookedEarlier(): Promise<{ books: Books; voucher: Voucher }> {
    const books = await addBooks(app, booker);
    const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n) }, booker);
    return { books, voucher };
  }

  /** Opens a transaction of the app, and gives the voucher that transaction's id, as a dump restored into another cluster could. */
  async function openWithItsId(books: Books, voucher: Voucher): Promise<void> {
    await begin(app, { company: books.company, ...changer });
    const found = await app.query<{ xact: string }>("SELECT pg_catalog.pg_current_xact_id()::text AS xact");
    await admin.query("SET session_replication_role = replica");
    try {
      const given = await admin.query("UPDATE ledger.vouchers SET created_xact = $1::xid8 WHERE id = $2", [found.rows[0]?.xact, voucher.id]);
      expect(given.rowCount).toBe(1);
    } finally {
      await admin.query("RESET session_replication_role");
    }
  }

  it("checks the lock for a row added to a voucher that carries the transaction's id but was booked before it", async () => {
    const { books, voucher } = await bookedEarlier();
    await setLock(app, books.company, "all", "2090-06-30", { who: setter });
    await openWithItsId(books, voucher);
    try {
      await expectRefusal(writeRow(app, books.company, voucher.id, { account: 3001, debit: 500n }), "period_locked_manual");
    } finally {
      await app.query("ROLLBACK");
    }
    expect((await rowsOf(app, books.company, voucher.id)).length).toBe(2);
  });

  it("sets the altered stamps of a change to a voucher that carries the transaction's id but was booked before it", async () => {
    const { books, voucher } = await bookedEarlier();
    await openWithItsId(books, voucher);
    try {
      await app.query("UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [voucher.id]);
      await app.query("COMMIT");
    } finally {
      await app.query("ROLLBACK");
    }
    expect(await voucherOf(app, books.company, voucher.id)).toMatchObject({ description: "Ny text", altered_by: changer.actor, altered_by_kind: "user" });
  });

  it("sets the altered stamps of a voucher that carries the transaction's id but was booked before it, when a row's text changes", async () => {
    const { books, voucher } = await bookedEarlier();
    await openWithItsId(books, voucher);
    try {
      await app.query(LOCK_VOUCHER, [voucher.id]);
      await app.query("UPDATE ledger.voucher_rows SET transaction_information = 'Ny text' WHERE voucher_id = $1 AND position = 1", [voucher.id]);
      await app.query("COMMIT");
    } finally {
      await app.query("ROLLBACK");
    }
    expect(await voucherOf(app, books.company, voucher.id)).toMatchObject({ altered_by: changer.actor, altered_by_kind: "user" });
  });

  it("strikes a row of a voucher that carries the transaction's id but was booked before it", async () => {
    const { books, voucher } = await bookedEarlier();
    await openWithItsId(books, voucher);
    try {
      await app.query(LOCK_VOUCHER, [voucher.id]);
      await app.query("UPDATE ledger.voucher_rows SET removed = true WHERE voucher_id = $1", [voucher.id]);
      await app.query("COMMIT");
    } finally {
      await app.query("ROLLBACK");
    }
    expect((await rowsOf(app, books.company, voucher.id)).map((row) => [row.removed, row.removed_by])).toEqual([
      [true, changer.actor],
      [true, changer.actor],
    ]);
  });
});
