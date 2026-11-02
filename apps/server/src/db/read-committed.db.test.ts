// SPDX-License-Identifier: AGPL-3.0-only

// The ledger is written at READ COMMITTED only. Its rules check other rows
// under row locks: a fiscal year's row, a counter, the company's lock
// settings. At REPEATABLE READ and SERIALIZABLE a statement reads the
// transaction's first snapshot, and a lock that another transaction held and
// gave back at its commit raises no serialization failure. So a transaction
// at such a level could shorten a fiscal year past a voucher booked just
// before, or change a voucher in a period that was locked just before. Every
// write at those levels is refused (read_committed_only), by every role; a
// read at any level is not. Each race below runs on two app connections, as
// the server's would.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ISOLATION_LEVELS, begin, expectRefusal, freshDatabase, inTransaction, type IsolationLevel, type TestDatabase } from "../../test/database.ts";
import { APP_WRITES, fillEveryTable, type Scenario } from "../../test/every-table.ts";
import {
  FISCAL_YEAR_COLUMNS,
  INSERT_VOID_RANGE,
  addBooks,
  addPeriod,
  balanced,
  bookVoucher,
  rowsOf,
  setLock,
  someSystemUser,
  someUser,
  voucherOf,
  type Books,
  type FiscalYear,
} from "../../test/ledger.ts";

const SNAPSHOT_LEVELS = ["repeatable read", "serializable"] as const satisfies readonly IsolationLevel[];

describe("the isolation level of a write", () => {
  let db: TestDatabase;
  let app: Client;
  let other: Client;
  let owner: Client;
  let scenario: Scenario;
  const who = someUser();

  beforeAll(async () => {
    db = await freshDatabase();
    scenario = await fillEveryTable(db);
    app = await db.connect("app");
    other = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs `sql` as `client` in a transaction at `isolation` that is rolled back, and gives the rows it changed. */
  async function rolledBack(client: Client, isolation: IsolationLevel, company: string, sql: string, params: readonly unknown[]): Promise<number | null> {
    await begin(client, { company, ...who, isolation });
    try {
      return (await client.query(sql, [...params])).rowCount;
    } finally {
      await client.query("ROLLBACK");
    }
  }

  it("refuses each write the app may make, on every table, at REPEATABLE READ and SERIALIZABLE, with the level", async () => {
    const writable = await app.query<{ relation: string; privilege: string }>(`
      SELECT n.nspname || '.' || c.relname AS relation, p.privilege
      FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE')) AS p (privilege)
      WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('ledger', 'audit', 'meta')
        AND pg_catalog.has_table_privilege('nortfox_app', c.oid, p.privilege)
      ORDER BY 1, 2`);
    expect(writable.rows.length).toBeGreaterThan(0);
    for (const { relation, privilege } of writable.rows) {
      const build = APP_WRITES[relation]?.[privilege as "INSERT" | "UPDATE" | "DELETE"];
      expect(build, `test/every-table.ts has an app write for ${privilege} on ${relation}`).toBeDefined();
      for (const isolation of SNAPSHOT_LEVELS) {
        const write = build?.(scenario);
        await expectRefusal(rolledBack(app, isolation, write?.company ?? "", write?.sql ?? "", write?.params ?? []), "read_committed_only", { isolation });
      }
      // The same write at READ COMMITTED, and at READ UNCOMMITTED, which is READ COMMITTED in PostgreSQL, changes its row.
      for (const isolation of ["read committed", "read uncommitted"] as const) {
        const write = build?.(scenario);
        expect(await rolledBack(app, isolation, write?.company ?? "", write?.sql ?? "", write?.params ?? []), `${privilege} on ${relation}`).toBe(1);
      }
    }
  });

  it("refuses the owner's write at those levels too", async () => {
    const books = await addBooks(app, who);
    const settings = { company: books.company, ...someSystemUser() };
    const range = [books.company, books.year.id, "A", 1, 3, "Återläsning av säkerhetskopia"];
    for (const isolation of SNAPSHOT_LEVELS) {
      await expectRefusal(inTransaction(owner, { ...settings, isolation }, () => owner.query(INSERT_VOID_RANGE, range)), "read_committed_only", { isolation });
    }
    expect((await inTransaction(owner, settings, () => owner.query(INSERT_VOID_RANGE, range))).rowCount).toBe(1);
  });

  it("lets a transaction at any level read", async () => {
    const books = await addBooks(app, who);
    for (const isolation of ISOLATION_LEVELS) {
      const found = await inTransaction(app, { company: books.company, isolation }, () => app.query("SELECT id FROM ledger.fiscal_years"));
      expect(found.rows, isolation).toEqual([{ id: books.year.id }]);
    }
  });

  describe("closes the races that a snapshot would open", () => {
    async function yearOf(company: string, id: string): Promise<FiscalYear | undefined> {
      return inTransaction(app, { company }, async () => (await app.query<FiscalYear>(`SELECT ${FISCAL_YEAR_COLUMNS} FROM ledger.fiscal_years WHERE id = $1`, [id])).rows[0]);
    }

    /**
     * Opens a transaction on `app` at `isolation` and takes its snapshot, then
     * runs `meanwhile` on the other connection, committed, and then `write` in
     * the open transaction.
     */
    async function afterSnapshot(books: Books, isolation: IsolationLevel, meanwhile: () => Promise<unknown>, write: () => Promise<unknown>): Promise<unknown> {
      await begin(app, { company: books.company, ...who, isolation });
      try {
        await app.query("SELECT count(*) FROM ledger.vouchers");
        await meanwhile();
        return await write();
      } finally {
        await app.query("ROLLBACK");
      }
    }

    const shorten = (books: Books) => () => app.query("UPDATE ledger.fiscal_years SET to_date = '2090-11-30' WHERE id = $1", [books.year.id]);

    it.each(SNAPSHOT_LEVELS)("a fiscal year shortened at %s past a voucher booked after its snapshot", async (isolation) => {
      const books = await addBooks(app, who);
      const booked = afterSnapshot(
        books,
        isolation,
        () => bookVoucher(other, books.company, { year: books.year.id, series: "A", date: "2090-12-15", rows: balanced() }, who),
        shorten(books),
      );
      await expectRefusal(booked, "read_committed_only", { isolation });
      expect((await yearOf(books.company, books.year.id))?.to_date).toBe("2090-12-31");
    });

    it.each(SNAPSHOT_LEVELS)("a fiscal year shortened at %s past a voucher's date changed after its snapshot", async (isolation) => {
      const books = await addBooks(app, who);
      const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-06-15", rows: balanced() }, who);
      const moved = afterSnapshot(
        books,
        isolation,
        () =>
          inTransaction(other, { company: books.company, ...who }, () =>
            other.query("UPDATE ledger.vouchers SET transaction_date = '2090-12-15' WHERE id = $1", [voucher.id]),
          ),
        shorten(books),
      );
      await expectRefusal(moved, "read_committed_only", { isolation });
      expect((await yearOf(books.company, books.year.id))?.to_date).toBe("2090-12-31");
      expect((await voucherOf(app, books.company, voucher.id))?.transaction_date).toBe("2090-12-15");
    });

    it.each(SNAPSHOT_LEVELS)("a fiscal year shortened at %s past a period added after its snapshot", async (isolation) => {
      const books = await addBooks(app, who);
      const added = afterSnapshot(books, isolation, () => addPeriod(other, books.company, books.year.id, "2090-12-01", "2090-12-31", who), shorten(books));
      await expectRefusal(added, "read_committed_only", { isolation });
      expect((await yearOf(books.company, books.year.id))?.to_date).toBe("2090-12-31");
    });

    it.each(SNAPSHOT_LEVELS)("a voucher changed at %s in a period locked after its snapshot", async (isolation) => {
      const books = await addBooks(app, who);
      const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-06-10", rows: balanced() }, who);
      const rows = await rowsOf(app, books.company, voucher.id);
      for (const change of [
        () => app.query("UPDATE ledger.vouchers SET description = 'Ändrad efter låsningen' WHERE id = $1", [voucher.id]),
        () => app.query("UPDATE ledger.voucher_rows SET removed = true WHERE id = $1", [rows[0]?.id]),
        () => app.query("DELETE FROM ledger.vouchers WHERE id = $1", [voucher.id]),
      ]) {
        await setLock(other, books.company, "all", null);
        const changed = afterSnapshot(books, isolation, () => setLock(other, books.company, "all", "2090-06-30"), change);
        await expectRefusal(changed, "read_committed_only", { isolation });
      }
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
      expect(await rowsOf(app, books.company, voucher.id)).toEqual(rows);
    });
  });
});
