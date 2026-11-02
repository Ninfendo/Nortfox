// SPDX-License-Identifier: AGPL-3.0-only

// Radera (rules 31 to 33 of the slice). Only the last voucher of its series
// in its fiscal year can be deleted: the one directly below the counter. A
// void range counts as used numbers, so the voucher just below one is never
// last. The voucher moves, with everything it held, to the record of deleted
// vouchers, with who deleted it and when, and the counter goes back by one,
// so the number is given out again. Each deletion is its own entry, counted
// per number. Nothing in the record changes or goes, and no row is removed
// from a voucher that stays. The locks come in period-lock.db.test.ts.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  addBooks,
  balanced,
  bookVoucher,
  deletedRowsOf,
  deletedVouchersOf,
  isAfter,
  nextNumberOf,
  recordVoidRange,
  rowsOf,
  someUser,
  voucherOf,
  writeRow,
  type Actor,
  type Books,
  type NewVoucher,
  type Voucher,
} from "../../../test/ledger.ts";

describe("Radera", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let reader: Client;
  const booker = someUser();
  const deleter: Actor = { actor: randomUUID(), kind: "system" };

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    reader = await db.connect("readerA");
  });

  afterAll(async () => {
    await db.close();
  });

  function aVoucher(books: Books, changes: Partial<NewVoucher> = {}): NewVoucher {
    return { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n), ...changes };
  }

  async function remove(company: string, id: string, who: Actor = deleter): Promise<number | null> {
    return inTransaction(app, { company, ...who }, async () => (await app.query("DELETE FROM ledger.vouchers WHERE id = $1", [id])).rowCount);
  }

  it("moves the last voucher to the record with who and when, its rows and their accounts' names, and gives its number out again", async () => {
    const books = await addBooks(app);
    await bookVoucher(app, books.company, aVoucher(books), booker);
    const voucher = await bookVoucher(
      app,
      books.company,
      aVoucher(books, {
        description: "Fel konto",
        comments: "Bokades två gånger",
        rows: [
          { account: 6110, amount: 2000n, text: "Pennor", quantity: "2.5" },
          { account: 1930, amount: -2000n },
        ],
      }),
      booker,
    );
    // Strike the first row and put a new one in its place, so the record shows a struck row.
    await inTransaction(app, { company: books.company, ...booker }, async () => {
      await app.query("UPDATE ledger.voucher_rows SET removed = true WHERE voucher_id = $1 AND position = 1", [voucher.id]);
      await writeRow(app, books.company, voucher.id, { account: 3001, amount: 2000n });
    });
    const changed = await voucherOf(app, books.company, voucher.id);
    const rows = await rowsOf(app, books.company, voucher.id);
    // The account's name is the one it has when the voucher is deleted.
    await inTransaction(app, { company: books.company, ...booker }, () =>
      app.query("UPDATE ledger.accounts SET description = 'Kontorsmaterial' WHERE fiscal_year_id = $1 AND number = 6110", [books.year.id]),
    );
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(3);
    const { started, ended, transaction } = await inTransaction(app, { company: books.company, ...deleter }, async () => {
      const deleted = await app.query("DELETE FROM ledger.vouchers WHERE id = $1", [voucher.id]);
      expect(deleted.rowCount).toBe(1);
      const stamps = await app.query<{ started: string; ended: string; transaction: string }>(
        "SELECT pg_catalog.transaction_timestamp()::text AS started, pg_catalog.clock_timestamp()::text AS ended, pg_catalog.pg_current_xact_id()::text AS transaction",
      );
      return stamps.rows[0] ?? { started: "", ended: "", transaction: "" };
    });
    expect(await voucherOf(app, books.company, voucher.id)).toBeUndefined();
    expect(await rowsOf(app, books.company, voucher.id)).toEqual([]);
    const [entry] = await deletedVouchersOf(app, books.company);
    expect(entry).toEqual({
      ...changed,
      deletion_count: 1,
      deleted_at: entry?.deleted_at,
      deleted_by: deleter.actor,
      deleted_by_kind: "system",
      deleted_xact: transaction,
    });
    expect(await isAfter(app, entry?.deleted_at ?? "", started)).toBe(true);
    expect(await isAfter(app, entry?.deleted_at ?? "", ended)).toBe(false);
    const names: Record<number, string> = { 1930: "Företagskonto", 3001: "Försäljning inom Sverige", 6110: "Kontorsmaterial" };
    expect(await deletedRowsOf(app, books.company, voucher.id)).toEqual(
      rows.map((row) => {
        const { voucher_id: voucherId, ...kept } = row;
        expect(voucherId).toBe(voucher.id);
        return { ...kept, deleted_voucher_id: voucher.id, account_description: names[row.account_number] };
      }),
    );
    expect((await deletedRowsOf(app, books.company, voucher.id)).map((row) => [row.position, row.account_number, row.amount, row.removed])).toEqual([
      [1, 6110, 2000n, true],
      [2, 1930, -2000n, false],
      [3, 3001, 2000n, false],
    ]);
    // The counter went back by one, and the next voucher gets the same number.
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(2);
    expect((await bookVoucher(app, books.company, aVoucher(books), booker)).number).toBe(2);
  });

  it("refuses to delete any voucher but the last of its series, with its series and number", async () => {
    const books = await addBooks(app);
    const first = await bookVoucher(app, books.company, aVoucher(books), booker);
    const second = await bookVoucher(app, books.company, aVoucher(books), booker);
    await bookVoucher(app, books.company, aVoucher(books, { series: "I" }), booker);
    await expectRefusal(remove(books.company, first.id), "not_last_in_series", { series: "A", number: 1 });
    expect(await voucherOf(app, books.company, first.id)).toEqual(first);
    await remove(books.company, second.id);
    // Now the first is the last.
    await remove(books.company, first.id);
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    expect((await deletedVouchersOf(app, books.company)).map((entry) => [entry.number, entry.deletion_count])).toEqual([
      [2, 1],
      [1, 1],
    ]);
  });

  it("keeps each deletion of a number as its own entry, counted (1) and (2)", async () => {
    const books = await addBooks(app);
    const first = await bookVoucher(app, books.company, aVoucher(books, { description: "Första" }), booker);
    await remove(books.company, first.id);
    const second = await bookVoucher(app, books.company, aVoucher(books, { description: "Andra" }), booker);
    expect(second.number).toBe(1);
    await remove(books.company, second.id);
    const entries = await deletedVouchersOf(app, books.company);
    expect(entries.map((entry) => [entry.id, entry.number, entry.deletion_count, entry.description])).toEqual([
      [first.id, 1, 1, "Första"],
      [second.id, 1, 2, "Andra"],
    ]);
    // Another series and another year count on their own.
    const closing = await bookVoucher(app, books.company, aVoucher(books, { series: "I" }), booker);
    await remove(books.company, closing.id);
    expect((await deletedVouchersOf(app, books.company)).at(-1)).toMatchObject({ series_code: "I", number: 1, deletion_count: 1 });
  });

  it("refuses to delete the voucher just below a void range, and books the next voucher above the range", async () => {
    const books = await addBooks(app);
    const below = await bookVoucher(app, books.company, aVoucher(books), booker);
    await recordVoidRange(owner, books.company, { year: books.year.id, code: "A", first: 2, last: 4 });
    await expectRefusal(remove(books.company, below.id), "not_last_in_series", { series: "A", number: 1 });
    const above = await bookVoucher(app, books.company, aVoucher(books), booker);
    expect(above.number).toBe(5);
    await remove(books.company, above.id);
    // The counter goes back to the end of the range, never below it.
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(5);
    await expectRefusal(remove(books.company, below.id), "not_last_in_series", { series: "A", number: 1 });
  });

  it("moves the counter back only with the deletion, and writes every row of the move to the history", async () => {
    const books = await addBooks(app);
    const voucher = await bookVoucher(app, books.company, aVoucher(books), booker);
    const transaction = await inTransaction(app, { company: books.company, ...deleter }, async () => {
      await app.query("DELETE FROM ledger.vouchers WHERE id = $1", [voucher.id]);
      return (await app.query<{ id: string }>("SELECT pg_catalog.pg_current_xact_id()::text AS id")).rows[0]?.id;
    });
    const history = await inTransaction(app, { company: books.company }, async () =>
      app.query<{ table_name: string; operation: string; actor_id: string; actor_kind: string }>(
        "SELECT table_name, operation, actor_id, actor_kind FROM audit.history WHERE transaction_id = $1::xid8 ORDER BY table_name, operation",
        [transaction],
      ),
    );
    const by = { actor_id: deleter.actor, actor_kind: "system" };
    expect(history.rows).toEqual([
      { table_name: "ledger.deleted_voucher_rows", operation: "INSERT", ...by },
      { table_name: "ledger.deleted_voucher_rows", operation: "INSERT", ...by },
      { table_name: "ledger.deleted_vouchers", operation: "INSERT", ...by },
      { table_name: "ledger.voucher_counters", operation: "UPDATE", ...by },
      { table_name: "ledger.voucher_rows", operation: "DELETE", ...by },
      { table_name: "ledger.voucher_rows", operation: "DELETE", ...by },
      { table_name: "ledger.vouchers", operation: "DELETE", ...by },
    ]);
  });

  it("refuses a deletion with no actor, and leaves the voucher and the counter", async () => {
    const books = await addBooks(app);
    const voucher = await bookVoucher(app, books.company, aVoucher(books), booker);
    await expectRefusal(
      inTransaction(app, { company: books.company }, () => app.query("DELETE FROM ledger.vouchers WHERE id = $1", [voucher.id])),
      "actor_missing",
      { setting: "nortfox.actor_id" },
    );
    expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(2);
  });

  describe("the record of deleted vouchers", () => {
    async function withEntry(): Promise<{ books: Books; voucher: Voucher }> {
      const books = await addBooks(app);
      const voucher = await bookVoucher(app, books.company, aVoucher(books), booker);
      await remove(books.company, voucher.id);
      await inTransaction(owner, { company: books.company, ...deleter }, () =>
        owner.query("INSERT INTO ledger.reader_roles (company_id, role_name) VALUES ($1, 'nortfox_test_reader_a')", [books.company]),
      );
      return { books, voucher };
    }

    async function unbindReader(company: string): Promise<void> {
      await inTransaction(owner, { company, ...deleter }, () => owner.query("DELETE FROM ledger.reader_roles WHERE role_name = 'nortfox_test_reader_a'"));
    }

    const WRITES = [
      "UPDATE ledger.deleted_vouchers SET description = 'Ändrad'",
      "DELETE FROM ledger.deleted_vouchers",
      "UPDATE ledger.deleted_voucher_rows SET amount = 0",
      "DELETE FROM ledger.deleted_voucher_rows",
    ];

    it("lets the app and a reader read it, and refuses them every change and deletion: they have no privilege", async () => {
      const { books, voucher } = await withEntry();
      try {
        for (const client of [app, reader]) {
          const seen = await inTransaction(client, { company: books.company }, async () =>
            (await client.query<{ id: string }>("SELECT id FROM ledger.deleted_vouchers")).rows.map((row) => row.id),
          );
          expect(seen).toEqual([voucher.id]);
          for (const sql of [...WRITES, "TRUNCATE ledger.deleted_vouchers CASCADE"]) {
            await expectError(
              inTransaction(client, { company: books.company, ...deleter }, () => client.query(sql)),
              INSUFFICIENT_PRIVILEGE,
              /permission denied/,
            );
          }
        }
      } finally {
        await unbindReader(books.company);
      }
      expect((await deletedVouchersOf(app, books.company)).map((entry) => entry.id)).toEqual([voucher.id]);
    });

    it("refuses the owner too: an entry is only written by the deletion, and stays as written", async () => {
      const { books, voucher } = await withEntry();
      await unbindReader(books.company);
      const settings = { company: books.company, ...deleter };
      for (const [sql, table, operation] of [
        [WRITES[0], "ledger.deleted_vouchers", "UPDATE"],
        [WRITES[1], "ledger.deleted_vouchers", "DELETE"],
        [WRITES[2], "ledger.deleted_voucher_rows", "UPDATE"],
        [WRITES[3], "ledger.deleted_voucher_rows", "DELETE"],
        ["TRUNCATE ledger.deleted_voucher_rows", "ledger.deleted_voucher_rows", "TRUNCATE"],
      ] as const) {
        await expectRefusal(inTransaction(owner, settings, () => owner.query(sql ?? "")), "append_only", { table, operation });
      }
      const entry = (await deletedVouchersOf(app, books.company))[0];
      await expectRefusal(
        inTransaction(owner, settings, () =>
          owner.query(
            `INSERT INTO ledger.deleted_vouchers (id, company_id, fiscal_year_id, series_code, number, deletion_count, description, comments,
               transaction_date, reference_type, reference_number, created_at, created_by, created_by_kind, created_xact, modified_at,
               deleted_at, deleted_by, deleted_by_kind, deleted_xact)
             SELECT gen_random_uuid(), company_id, fiscal_year_id, series_code, number, 2, description, comments, transaction_date, reference_type,
               reference_number, created_at, created_by, created_by_kind, created_xact, modified_at, deleted_at, deleted_by, deleted_by_kind, deleted_xact
             FROM ledger.deleted_vouchers WHERE id = $1`,
            [voucher.id],
          ),
        ),
        "internal_only",
        { table: "ledger.deleted_vouchers", field: null },
      );
      await expectRefusal(
        inTransaction(owner, settings, () =>
          owner.query(
            `INSERT INTO ledger.deleted_voucher_rows (id, company_id, deleted_voucher_id, fiscal_year_id, position, account_number, amount,
               transaction_information, quantity, removed, created_at, created_by, created_by_kind, account_description)
             SELECT gen_random_uuid(), company_id, deleted_voucher_id, fiscal_year_id, position + 10, account_number, amount,
               transaction_information, quantity, removed, created_at, created_by, created_by_kind, account_description
             FROM ledger.deleted_voucher_rows WHERE deleted_voucher_id = $1`,
            [voucher.id],
          ),
        ),
        "internal_only",
        { table: "ledger.deleted_voucher_rows", field: null },
      );
      expect(await deletedVouchersOf(app, books.company)).toEqual([entry]);
    });

    it("keeps a series that holds only deleted vouchers: it cannot be removed", async () => {
      const { books } = await withEntry();
      await unbindReader(books.company);
      await expectError(
        inTransaction(app, { company: books.company, ...deleter }, () =>
          app.query("DELETE FROM ledger.voucher_series WHERE fiscal_year_id = $1 AND code = 'A'", [books.year.id]),
        ),
        "23001",
        /deleted_vouchers_series/,
      );
    });
  });
});
