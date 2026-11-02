// SPDX-License-Identifier: AGPL-3.0-only

// One actor per transaction (rules 38, 41 and 42 of the slice). A rule that
// depends on the actor, such as the period lock, is checked for the actor
// that is set when its trigger runs. The stamps and the behandlingshistorik
// record the actor that is set when their triggers run. So the first write
// of a transaction keeps its actor and its kind, and a write under another
// actor or kind is refused, in a later statement or later in the same
// statement. Otherwise one actor could add rows to, change or delete a
// voucher dated inside its own lock, under a check made for another actor.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  addBooks,
  balanced,
  bookVoucher,
  nextNumberOf,
  rowsOf,
  setLock,
  someUser,
  voucherOf,
  writeRow,
  writeVoucher,
  type Actor,
  type Books,
  type NewVoucher,
  type Voucher,
} from "../../../test/ledger.ts";

const ANOTHER_ACTOR = /A transaction keeps one actor/;

describe("the transaction's actor", () => {
  let db: TestDatabase;
  let app: Client;
  const booker = someUser();
  const locked = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  function aVoucher(books: Books, changes: Partial<NewVoucher> = {}): NewVoucher {
    return { year: books.year.id, series: "A", date: "2090-08-12", rows: balanced(900n, 1930, 3001), ...changes };
  }

  /** Books whose dates up to 2090-09-30 are locked for the user `locked` alone, with one voucher booked by `booker`, dated inside that lock. */
  async function lockedBooks(): Promise<{ books: Books; voucher: Voucher }> {
    const books = await addBooks(app);
    await setLock(app, books.company, "user", "2090-09-30", { user: locked.actor });
    const voucher = await bookVoucher(app, books.company, aVoucher(books), booker);
    return { books, voucher };
  }

  /** The history rows of `company`, as the app reads them. */
  async function historyOf(company: string): Promise<{ table_name: string; operation: string; actor_id: string }[]> {
    return inTransaction(app, { company }, async () => {
      const found = await app.query<{ table_name: string; operation: string; actor_id: string }>(
        "SELECT table_name, operation, actor_id FROM audit.history ORDER BY id",
      );
      return found.rows;
    });
  }

  /** The statement that sets the actor and its kind for the rest of the transaction, as the server does. */
  const SWITCH = "SELECT pg_catalog.set_config('nortfox.actor_id', $1, true), pg_catalog.set_config('nortfox.actor_kind', $2, true)";

  async function switchTo(who: Actor): Promise<void> {
    await app.query(SWITCH, [who.actor, who.kind]);
  }

  it("refuses rows that another actor adds to a voucher booked earlier in the same transaction", async () => {
    const books = await addBooks(app);
    await setLock(app, books.company, "user", "2090-09-30", { user: locked.actor });
    await expectError(
      inTransaction(app, { company: books.company, ...booker }, async () => {
        const voucher = await writeVoucher(app, books.company, aVoucher(books, { rows: [] }));
        await switchTo(locked);
        await writeRow(app, books.company, voucher.id, { account: 1930, debit: 900n });
        await writeRow(app, books.company, voucher.id, { account: 3001, credit: 900n });
      }),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_ACTOR,
    );
    expect(await nextNumberOf(app, books.company, books.year.id, "A")).toBe(1);
    // The same rows from `locked` in a transaction of its own are refused by its lock.
    const voucher = await bookVoucher(app, books.company, aVoucher(books), booker);
    await expectRefusal(
      inTransaction(app, { company: books.company, ...locked }, () => writeRow(app, books.company, voucher.id, { account: 3001 })),
      "period_locked_manual",
    );
  });

  it("refuses a change whose statement switches the actor after the change was checked, before its history is written", async () => {
    const { books, voucher } = await lockedBooks();
    const history = await historyOf(books.company);
    const changer = someUser();
    await expectError(
      inTransaction(app, { company: books.company, ...changer }, () =>
        app.query(
          `WITH changed AS (UPDATE ledger.vouchers SET description = 'Av en annan' WHERE id = $1 RETURNING id)
           SELECT pg_catalog.set_config('nortfox.actor_id', $2, true) FROM changed`,
          [voucher.id, locked.actor],
        ),
      ),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_ACTOR,
    );
    expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    expect(await historyOf(books.company)).toEqual(history);
  });

  it("refuses a deletion whose statement switches the actor after the deletion was checked", async () => {
    const { books, voucher } = await lockedBooks();
    const rows = await rowsOf(app, books.company, voucher.id);
    const deleter = someUser();
    await expectError(
      inTransaction(app, { company: books.company, ...deleter }, () =>
        app.query(
          `WITH gone AS (DELETE FROM ledger.vouchers WHERE id = $1 RETURNING id)
           SELECT pg_catalog.set_config('nortfox.actor_id', $2, true) FROM gone`,
          [voucher.id, locked.actor],
        ),
      ),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_ACTOR,
    );
    expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    expect(await rowsOf(app, books.company, voucher.id)).toEqual(rows);
  });

  it("refuses another kind of actor with the same id", async () => {
    const { books, voucher } = await lockedBooks();
    await expectError(
      inTransaction(app, { company: books.company, ...booker }, async () => {
        await app.query("UPDATE ledger.vouchers SET description = 'Ändrad' WHERE id = $1", [voucher.id]);
        await switchTo({ actor: booker.actor, kind: "integration" });
        await writeRow(app, books.company, voucher.id, { account: 3001 });
      }),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_ACTOR,
    );
    expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
  });

  it("holds on every table, not only on vouchers: a lock date set by one actor, then an account changed by another", async () => {
    const books = await addBooks(app);
    await expectError(
      inTransaction(app, { company: books.company, ...booker }, async () => {
        await app.query("INSERT INTO ledger.period_locks (company_id, scope, end_date) VALUES ($1, 'all', '2090-06-30')", [books.company]);
        await switchTo(locked);
        await app.query("UPDATE ledger.accounts SET description = 'Bank' WHERE fiscal_year_id = $1 AND number = 1930", [books.year.id]);
      }),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_ACTOR,
    );
  });

  it("lets one actor write in many statements, and lets a transaction take another actor before its first write", async () => {
    const books = await addBooks(app);
    const before = await historyOf(books.company);
    const voucher = await inTransaction(app, { company: books.company, ...locked }, async () => {
      await switchTo(booker);
      const booked = await writeVoucher(app, books.company, aVoucher(books));
      await app.query("UPDATE ledger.vouchers SET description = 'Ändrad' WHERE id = $1", [booked.id]);
      await writeRow(app, books.company, booked.id, { account: 3001 });
      return booked;
    });
    expect(voucher.created_by).toBe(booker.actor);
    const written = (await historyOf(books.company)).slice(before.length);
    expect(written.length).toBeGreaterThan(0);
    expect(new Set(written.map((row) => row.actor_id))).toEqual(new Set([booker.actor]));
  });

  it("forgets the actor of writes that a savepoint took back", async () => {
    const books = await addBooks(app);
    const before = await historyOf(books.company);
    const other = { actor: randomUUID(), kind: "system" } as const;
    await inTransaction(app, { company: books.company, ...booker }, async () => {
      await app.query("SAVEPOINT first");
      await app.query("UPDATE ledger.accounts SET description = 'Bank' WHERE fiscal_year_id = $1 AND number = 1930", [books.year.id]);
      await app.query("ROLLBACK TO SAVEPOINT first");
      await switchTo(other);
      await app.query("UPDATE ledger.accounts SET description = 'Kassa och bank' WHERE fiscal_year_id = $1 AND number = 1930", [books.year.id]);
    });
    expect((await historyOf(books.company)).slice(before.length)).toEqual([{ table_name: "ledger.accounts", operation: "UPDATE", actor_id: other.actor }]);
  });
});
