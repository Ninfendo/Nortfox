// SPDX-License-Identifier: AGPL-3.0-only

// Ändra (rules 9, 24 to 26 of the slice). While the voucher's date is not
// locked for the actor, that actor can change its description, its date
// inside its own fiscal year and its row texts, add rows and strike a row.
// Each change sets the altered stamp, and a struck row gets who struck it and
// when. Nothing else changes: not the series, the number, the year, the
// reference, the comments, what it reverses, or a created stamp, and of an
// existing row not its account, amount, position or quantity. A row is never
// removed, and a struck row never loses its mark. The locks come in
// period-lock.db.test.ts.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, expectError, expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  ROW_COLUMNS,
  VOUCHER_COLUMNS,
  addAccount,
  addBooks,
  addBooksYear,
  balanced,
  bookVoucher,
  isAfter,
  rowsOf,
  someUser,
  voucherOf,
  writeRow,
  writeVoucher,
  type Actor,
  type Books,
  type Voucher,
  type VoucherRow,
} from "../../../test/ledger.ts";

describe("Ändra", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  const booker = someUser();
  const changer: Actor = { actor: randomUUID(), kind: "integration" };

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  async function booked(books: Books, series = "A"): Promise<Voucher> {
    return bookVoucher(app, books.company, { year: books.year.id, series, date: "2090-03-15", rows: balanced(2000n) }, booker);
  }

  /** Runs one statement as the app, as `who`, in its own transaction, and gives the rows it returns. */
  async function asApp<T extends object = Record<string, unknown>>(company: string, sql: string, params: readonly unknown[] = [], who: Actor = changer): Promise<T[]> {
    return inTransaction(app, { company, ...who }, async () => (await app.query<T>(sql, [...params])).rows);
  }

  /** What every change leaves: the voucher's altered stamp, by the changer, and its modified time moved with it. */
  async function expectAlteredBy(company: string, before: Voucher, after: Voucher | undefined, who: Actor = changer): Promise<void> {
    expect(after).toMatchObject({ altered_by: who.actor, altered_by_kind: who.kind, modified_at: after?.altered_at });
    expect(await isAfter(app, after?.altered_at ?? "", before.modified_at)).toBe(true);
    expect(after).toMatchObject({
      created_at: before.created_at,
      created_by: before.created_by,
      created_by_kind: before.created_by_kind,
      number: before.number,
      series_code: before.series_code,
    });
    expect(await voucherOf(app, company, before.id)).toEqual(after);
  }

  it("changes the description, and sets the altered stamp", async () => {
    const books = await addBooks(app);
    const voucher = await booked(books);
    const [after] = await asApp<Voucher>(books.company, `UPDATE ledger.vouchers SET description = 'Pennor och papper' WHERE id = $1 RETURNING ${VOUCHER_COLUMNS}`, [
      voucher.id,
    ]);
    expect(after?.description).toBe("Pennor och papper");
    await expectAlteredBy(books.company, voucher, after);
  });

  it("changes the date inside the voucher's own fiscal year, also in the closing series", async () => {
    const books = await addBooks(app);
    for (const series of ["A", "I"]) {
      const voucher = await booked(books, series);
      for (const date of ["2090-12-31", "2090-01-01"]) {
        const [after] = await asApp<Voucher>(books.company, `UPDATE ledger.vouchers SET transaction_date = $2 WHERE id = $1 RETURNING ${VOUCHER_COLUMNS}`, [
          voucher.id,
          date,
        ]);
        expect(after?.transaction_date).toBe(date);
        await expectAlteredBy(books.company, voucher, after);
      }
    }
  });

  it("refuses a date outside every fiscal year, and one in another year, also in the closing series", async () => {
    const books = await addBooks(app);
    await addBooksYear(app, books.company, "2091-01-01", "2091-12-31");
    const year = { year_number: books.year.year_number, from_date: "2090-01-01", to_date: "2090-12-31" };
    for (const series of ["A", "I"]) {
      const voucher = await booked(books, series);
      await expectRefusal(asApp(books.company, "UPDATE ledger.vouchers SET transaction_date = '2089-12-31' WHERE id = $1", [voucher.id]), "no_fiscal_year", {
        date: "2089-12-31",
      });
      await expectRefusal(
        asApp(books.company, "UPDATE ledger.vouchers SET transaction_date = '2091-01-01' WHERE id = $1", [voucher.id]),
        "date_outside_fiscal_year",
        { date: "2091-01-01", year },
      );
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    }
  });

  it("refuses an empty or a too long description, and comments are not changed at all", async () => {
    const books = await addBooks(app);
    const voucher = await booked(books);
    await expectRefusal(asApp(books.company, "UPDATE ledger.vouchers SET description = '' WHERE id = $1", [voucher.id]), "description_missing", {});
    const long = "d".repeat(201);
    await expectRefusal(asApp(books.company, "UPDATE ledger.vouchers SET description = $2 WHERE id = $1", [voucher.id, long]), "value_too_long", {
      field: "description",
      value: long,
    });
    expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
  });

  it("changes a row's text, sets the voucher's altered stamp, and keeps the row's created stamp", async () => {
    const books = await addBooks(app);
    const voucher = await booked(books);
    const [first] = await rowsOf(app, books.company, voucher.id);
    const [after] = await asApp<VoucherRow>(
      books.company,
      `UPDATE ledger.voucher_rows SET transaction_information = 'Pennor' WHERE id = $1 RETURNING ${ROW_COLUMNS}`,
      [first?.id],
    );
    expect(after).toEqual({ ...first, transaction_information: "Pennor" });
    await expectAlteredBy(books.company, voucher, await voucherOf(app, books.company, voucher.id));
    const long = "t".repeat(101);
    await expectRefusal(
      asApp(books.company, "UPDATE ledger.voucher_rows SET transaction_information = $2 WHERE id = $1", [first?.id, long]),
      "value_too_long",
      { field: "transaction_information", value: long },
    );
  });

  it("adds a row at the end, with who added it and when, and sets the altered stamp", async () => {
    const books = await addBooks(app);
    const voucher = await booked(books);
    const added = await inTransaction(app, { company: books.company, ...changer }, async () => {
      const zero = await writeRow(app, books.company, voucher.id, { account: 3001, amount: 0n, text: "Nollrad" });
      const debit = await writeRow(app, books.company, voucher.id, { account: 6110, amount: 500n });
      const credit = await writeRow(app, books.company, voucher.id, { account: 1930, amount: -500n });
      return [zero, debit, credit];
    });
    expect(added.map((row) => [row.position, row.account_number, row.amount, row.created_by, row.created_by_kind])).toEqual([
      [3, 3001, 0n, changer.actor, "integration"],
      [4, 6110, 500n, changer.actor, "integration"],
      [5, 1930, -500n, changer.actor, "integration"],
    ]);
    await expectAlteredBy(books.company, voucher, await voucherOf(app, books.company, voucher.id));
  });

  it("refuses an added row on an account that the year does not have, or that is inactive", async () => {
    const books = await addBooks(app);
    const voucher = await booked(books);
    await addAccount(app, books.company, books.year.id, { number: 1910, description: "Kassa", active: false });
    await expectRefusal(
      inTransaction(app, { company: books.company, ...changer }, () => writeRow(app, books.company, voucher.id, { account: 998, amount: 0n })),
      "account_missing",
      { number: 998 },
    );
    await expectRefusal(
      inTransaction(app, { company: books.company, ...changer }, () => writeRow(app, books.company, voucher.id, { account: 1910, amount: 0n })),
      "account_inactive",
      { number: 1910 },
    );
    expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    expect((await rowsOf(app, books.company, voucher.id)).length).toBe(2);
  });

  it("strikes a row: the row stays, with who struck it and when, and the voucher gets the altered stamp", async () => {
    const books = await addBooks(app);
    const voucher = await booked(books);
    const [first] = await rowsOf(app, books.company, voucher.id);
    const struck = await inTransaction(app, { company: books.company, ...changer }, async () => {
      const found = await app.query<VoucherRow & { started: string }>(
        `UPDATE ledger.voucher_rows SET removed = true WHERE id = $1 RETURNING ${ROW_COLUMNS}, pg_catalog.transaction_timestamp()::text AS started`,
        [first?.id],
      );
      await writeRow(app, books.company, voucher.id, { account: 6110, amount: 2000n });
      return found.rows[0];
    });
    expect(struck).toMatchObject({ ...first, removed: true, removed_at: struck?.removed_at, removed_by: changer.actor, removed_by_kind: "integration" });
    expect(struck?.removed_at).not.toBeNull();
    expect(await isAfter(app, struck?.removed_at ?? "", struck?.started ?? "")).toBe(true);
    const rows = await rowsOf(app, books.company, voucher.id);
    expect(rows.map((row) => [row.position, row.amount, row.removed])).toEqual([
      [1, 2000n, true],
      [2, -2000n, false],
      [3, 2000n, false],
    ]);
    await expectAlteredBy(books.company, voucher, await voucherOf(app, books.company, voucher.id));
  });

  it("sets no altered stamp for a change in the transaction that booked the voucher", async () => {
    const books = await addBooks(app);
    const voucher = await inTransaction(app, { company: books.company, ...booker }, async () => {
      const head = await writeVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced() });
      await app.query("UPDATE ledger.vouchers SET description = 'Ny text', transaction_date = '2090-04-01' WHERE id = $1", [head.id]);
      await app.query("UPDATE ledger.voucher_rows SET transaction_information = 'Rad' WHERE voucher_id = $1", [head.id]);
      await writeRow(app, books.company, head.id, { account: 3001, amount: 0n });
      return head;
    });
    expect(await voucherOf(app, books.company, voucher.id)).toEqual({
      ...voucher,
      description: "Ny text",
      transaction_date: "2090-04-01",
    });
  });

  describe("refuses every other change, each with its reason", () => {
    // A value of "$2" stands for the next fiscal year, and "$3" for another voucher: each statement gets only the one it uses, as $2.
    const VOUCHER_FIELDS: readonly (readonly [string, string])[] = [
      ["id", `'${randomUUID()}'`],
      ["series_code", "'K'"],
      ["number", "number + 1"],
      ["fiscal_year_id", "$2"],
      ["reference_type", "'INVOICE'"],
      ["reference_number", "'F-9'"],
      ["comments", "'En kommentar'"],
      ["reverses_voucher_id", "$3"],
      ["created_at", "created_at - interval '1 day'"],
      ["created_by", `'${randomUUID()}'`],
      ["created_by_kind", "'system'"],
      ["created_xact", "'1'"],
    ];

    it.each(VOUCHER_FIELDS)("a voucher's %s", async (field, value) => {
      const books = await addBooks(app);
      const next = await addBooksYear(app, books.company, "2091-01-01", "2091-12-31");
      const other = await booked(books);
      const voucher = await booked(books);
      const params = value === "$2" ? [voucher.id, next.id] : value === "$3" ? [voucher.id, other.id] : [voucher.id];
      const set = value === "$3" ? "$2" : value;
      await expectRefusal(asApp(books.company, `UPDATE ledger.vouchers SET ${field} = ${set} WHERE id = $1`, params), "immutable_field", {
        field,
        operation: "update",
      });
      // Together with an allowed change too.
      await expectRefusal(
        asApp(books.company, `UPDATE ledger.vouchers SET description = 'Ny text', ${field} = ${set} WHERE id = $1`, params),
        "immutable_field",
        { field, operation: "update" },
      );
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    });

    it.each(["modified_at", "altered_at", "altered_by", "altered_by_kind"])("a voucher's %s written by the caller: only the database writes it", async (field) => {
      const books = await addBooks(app);
      const voucher = await booked(books);
      const value = field.endsWith("_at") ? "pg_catalog.clock_timestamp()" : field.endsWith("_kind") ? "'user'" : `'${randomUUID()}'`;
      await expectRefusal(asApp(books.company, `UPDATE ledger.vouchers SET ${field} = ${value} WHERE id = $1`, [voucher.id]), "internal_only", {
        table: "ledger.vouchers",
        field,
      });
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    });

    // A value of "$2" stands for another voucher, and "$3" for the next fiscal year: each statement gets only the one it uses, as $2.
    const ROW_FIELDS: readonly (readonly [string, string])[] = [
      ["id", `'${randomUUID()}'`],
      ["account_number", "3001"],
      ["amount", "amount + 1"],
      ["position", "position + 10"],
      ["quantity", "1"],
      ["voucher_id", "$2"],
      ["fiscal_year_id", "$3"],
      ["created_at", "created_at - interval '1 day'"],
      ["created_by", `'${randomUUID()}'`],
      ["created_by_kind", "'system'"],
    ];

    it.each(ROW_FIELDS)("an existing row's %s", async (field, value) => {
      const books = await addBooks(app);
      const next = await addBooksYear(app, books.company, "2091-01-01", "2091-12-31");
      const other = await booked(books);
      const voucher = await booked(books);
      const [first] = await rowsOf(app, books.company, voucher.id);
      const params = value === "$2" ? [first?.id, other.id] : value === "$3" ? [first?.id, next.id] : [first?.id];
      const set = value === "$3" ? "$2" : value;
      await expectRefusal(asApp(books.company, `UPDATE ledger.voucher_rows SET ${field} = ${set} WHERE id = $1`, params), "immutable_field", {
        field,
        operation: "update",
      });
      expect((await rowsOf(app, books.company, voucher.id))[0]).toEqual(first);
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    });

    it("taking the mark off a struck row, and changing who struck it or when", async () => {
      const books = await addBooks(app);
      const voucher = await booked(books);
      const [first] = await rowsOf(app, books.company, voucher.id);
      await inTransaction(app, { company: books.company, ...changer }, async () => {
        await app.query("UPDATE ledger.voucher_rows SET removed = true WHERE id = $1", [first?.id]);
        await writeRow(app, books.company, voucher.id, { account: 6110, amount: 2000n });
      });
      const [struck] = await rowsOf(app, books.company, voucher.id);
      for (const [set, field] of [
        ["removed = false", "removed"],
        ["removed_at = pg_catalog.clock_timestamp()", "removed_at"],
        [`removed_by = '${randomUUID()}'`, "removed_by"],
        ["removed_by_kind = 'user'", "removed_by_kind"],
        ["removed = false, removed_at = NULL, removed_by = NULL, removed_by_kind = NULL", "removed"],
      ] as const) {
        await expectRefusal(asApp(books.company, `UPDATE ledger.voucher_rows SET ${set} WHERE id = $1`, [first?.id]), "immutable_field", {
          field,
          operation: "update",
        });
      }
      // Striking it again changes nothing: its who and when stay.
      await asApp(books.company, "UPDATE ledger.voucher_rows SET removed = true WHERE id = $1", [first?.id], someUser());
      expect((await rowsOf(app, books.company, voucher.id))[0]).toEqual(struck);
      // Setting who struck a row that is not struck is refused too.
      const [, second] = await rowsOf(app, books.company, voucher.id);
      await expectRefusal(
        asApp(books.company, "UPDATE ledger.voucher_rows SET removed_at = pg_catalog.clock_timestamp() WHERE id = $1", [second?.id]),
        "immutable_field",
        { field: "removed_at", operation: "update" },
      );
    });

    it("removing a row from a voucher that stays: the app has no privilege, and the owner is refused", async () => {
      const books = await addBooks(app);
      const voucher = await booked(books);
      const [first] = await rowsOf(app, books.company, voucher.id);
      await expectError(asApp(books.company, "DELETE FROM ledger.voucher_rows WHERE id = $1", [first?.id]), INSUFFICIENT_PRIVILEGE, /permission denied/);
      await expectRefusal(
        inTransaction(owner, { company: books.company, ...changer }, () => owner.query("DELETE FROM ledger.voucher_rows WHERE id = $1", [first?.id])),
        "row_removal",
        { voucher: voucher.id },
      );
      expect((await rowsOf(app, books.company, voucher.id)).length).toBe(2);
    });

    it("a row added with no actor, and a change with no actor", async () => {
      const books = await addBooks(app);
      const voucher = await booked(books);
      await expectRefusal(
        inTransaction(app, { company: books.company }, () => writeRow(app, books.company, voucher.id, { account: 3001, amount: 0n })),
        "actor_missing",
        { setting: "nortfox.actor_id" },
      );
      await expectRefusal(
        inTransaction(app, { company: books.company, actor: changer.actor }, () =>
          app.query("UPDATE ledger.vouchers SET description = 'Ny text' WHERE id = $1", [voucher.id]),
        ),
        "actor_missing",
        { setting: "nortfox.actor_kind" },
      );
      expect(await voucherOf(app, books.company, voucher.id)).toEqual(voucher);
    });
  });
});
