// SPDX-License-Identifier: AGPL-3.0-only

// The refusals of rule 44 of the slice: each reason is raised by a real write,
// as the app role, with the facts that the rule names for it. A last test
// checks that the cases cover the whole list, NF001 to NF020, each once.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectRefusal, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import {
  addAccount,
  addBooks,
  addBooksYear,
  balanced,
  bookVoucher,
  setAutomaticLock,
  setLock,
  someUser,
  writeRow,
  type Actor,
  type Books,
  type NewVoucher,
} from "../../../test/ledger.ts";
import { REFUSALS, type RefusalReason } from "../../db/refusals.ts";

/** The reasons of rule 44, NF001 to NF020, which later slices answer with the established system's messages. */
const RULE_44: readonly RefusalReason[] = REFUSALS.filter(({ code }) => Number(code.slice(2)) <= 20).map(({ reason }) => reason);

/** What a case writes in: a company with the fiscal years 2090 and 2091 to book in. */
interface Ledger {
  readonly books: Books;
  readonly next: string;
  readonly app: Client;
  readonly who: Actor;
}

/** The write that the database refuses, and the facts the refusal must carry. */
interface Refused {
  readonly write: () => Promise<unknown>;
  readonly facts: Record<string, unknown>;
}

interface Case {
  readonly reason: RefusalReason;
  /** The write that the database refuses, after any setup it needs. Gives the facts the refusal must carry. */
  readonly refused: (ledger: Ledger) => Refused | Promise<Refused>;
}

function aVoucher(ledger: Ledger, changes: Partial<NewVoucher> = {}): NewVoucher {
  return { year: ledger.books.year.id, series: "A", date: "2090-03-15", rows: balanced(2000n), ...changes };
}

function book(ledger: Ledger, changes: Partial<NewVoucher> = {}): Promise<unknown> {
  return bookVoucher(ledger.app, ledger.books.company, aVoucher(ledger, changes), ledger.who);
}

function asApp(ledger: Ledger, sql: string, params: readonly unknown[] = []): Promise<unknown> {
  return inTransaction(ledger.app, { company: ledger.books.company, ...ledger.who }, () => ledger.app.query(sql, [...params]));
}

async function setAtAsJson(ledger: Ledger, id: string): Promise<string> {
  return inTransaction(ledger.app, { company: ledger.books.company }, async () => {
    const found = await ledger.app.query<{ at: string }>("SELECT pg_catalog.to_jsonb(set_at) #>> '{}' AS at FROM ledger.period_locks WHERE id = $1", [id]);
    return found.rows[0]?.at ?? "";
  });
}

const CASES: readonly Case[] = [
  {
    reason: "unbalanced",
    refused: (ledger) => ({
      write: () => book(ledger, { rows: [{ account: 6110, amount: 2000n }, { account: 1930, amount: -1999n }] }),
      facts: { debit: "2000", credit: "1999" },
    }),
  },
  {
    reason: "too_few_rows",
    refused: (ledger) => ({ write: () => book(ledger, { rows: [{ account: 6110, amount: 0n }] }), facts: { count: 1 } }),
  },
  {
    reason: "account_missing",
    refused: (ledger) => ({ write: () => book(ledger, { rows: balanced(2000n, 998, 1930) }), facts: { number: 998 } }),
  },
  {
    reason: "account_inactive",
    refused: async (ledger) => {
      await addAccount(ledger.app, ledger.books.company, ledger.books.year.id, { number: 1910, description: "Kassa", active: false }, ledger.who);
      return { write: () => book(ledger, { rows: balanced(2000n, 1910, 1930) }), facts: { number: 1910 } };
    },
  },
  {
    reason: "series_missing",
    refused: (ledger) => ({ write: () => book(ledger, { series: "TZ" }), facts: { code: "TZ" } }),
  },
  {
    reason: "series_not_manual",
    refused: (ledger) => ({ write: () => book(ledger, { series: "K" }), facts: { code: "K" } }),
  },
  {
    reason: "no_fiscal_year",
    refused: (ledger) => ({ write: () => book(ledger, { date: "2089-12-31" }), facts: { date: "2089-12-31" } }),
  },
  {
    reason: "date_outside_fiscal_year",
    refused: (ledger) => ({
      write: () => book(ledger, { date: "2091-01-01" }),
      facts: { date: "2091-01-01", year: { year_number: ledger.books.year.year_number, from_date: "2090-01-01", to_date: "2090-12-31" } },
    }),
  },
  {
    reason: "description_missing",
    refused: (ledger) => ({ write: () => book(ledger, { description: "" }), facts: {} }),
  },
  {
    reason: "value_too_long",
    refused: (ledger) => ({ write: () => book(ledger, { description: "N".repeat(201) }), facts: { field: "description", value: "N".repeat(201) } }),
  },
  {
    reason: "period_locked_manual",
    refused: async (ledger) => {
      const setter = someUser();
      const lock = await setLock(ledger.app, ledger.books.company, "all", "2090-03-31", { who: setter });
      return {
        write: () => book(ledger),
        facts: { end_date: "2090-03-31", source: "all", user_id: null, set_by: setter.actor, set_by_kind: "user", set_at: await setAtAsJson(ledger, lock.id) },
      };
    },
  },
  {
    reason: "period_locked_automatic",
    refused: async (ledger) => {
      const old = await addBooksYear(ledger.app, ledger.books.company, "2020-01-01", "2020-12-31", ledger.who);
      await setAutomaticLock(ledger.app, ledger.books.company, "month_end_50", ledger.who);
      const through = await inTransaction(ledger.app, { company: ledger.books.company }, async () => {
        const found = await ledger.app.query<{ through: string }>("SELECT ledger.automatic_lock_end_date($1, ledger.today_in_sweden())::text AS through", [
          ledger.books.company,
        ]);
        return found.rows[0]?.through;
      });
      return { write: () => book(ledger, { year: old.id, date: "2020-05-15" }), facts: { end_date: through, interval: "month_end_50" } };
    },
  },
  {
    reason: "not_last_in_series",
    refused: async (ledger) => {
      const first = await bookVoucher(ledger.app, ledger.books.company, aVoucher(ledger), ledger.who);
      await book(ledger);
      return { write: () => asApp(ledger, "DELETE FROM ledger.vouchers WHERE id = $1", [first.id]), facts: { series: "A", number: 1 } };
    },
  },
  {
    reason: "reversing_voucher_exists",
    refused: async (ledger) => {
      const old = await bookVoucher(ledger.app, ledger.books.company, aVoucher(ledger), ledger.who);
      await book(ledger, { series: "I", reverses: old.id, rows: balanced(2000n, 1930, 6110) });
      return { write: () => book(ledger, { reverses: old.id, rows: balanced(2000n, 1930, 6110) }), facts: { series: "I", number: 1 } };
    },
  },
  {
    reason: "reversing_other_module",
    refused: async (ledger) => {
      const invoice = await bookVoucher(ledger.app, ledger.books.company, aVoucher(ledger, { series: "K", referenceType: "INVOICE" }), ledger.who);
      return { write: () => book(ledger, { reverses: invoice.id }), facts: { reversed_type: "INVOICE", reversing_type: "MANUAL" } };
    },
  },
  {
    reason: "account_has_rows",
    refused: async (ledger) => {
      await book(ledger);
      return {
        write: () => asApp(ledger, "DELETE FROM ledger.accounts WHERE fiscal_year_id = $1 AND number = 6110", [ledger.books.year.id]),
        facts: { number: 6110, count: 1 },
      };
    },
  },
  {
    reason: "series_code_invalid",
    refused: (ledger) => ({
      write: () =>
        asApp(ledger, "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'a', '', true)", [
          ledger.books.company,
          ledger.books.year.id,
        ]),
      facts: { code: "a" },
    }),
  },
  {
    reason: "series_code_duplicate",
    refused: (ledger) => ({
      write: () =>
        asApp(ledger, "INSERT INTO ledger.voucher_series (company_id, fiscal_year_id, code, description, manual) VALUES ($1, $2, 'A', '', true)", [
          ledger.books.company,
          ledger.books.year.id,
        ]),
      facts: { code: "A" },
    }),
  },
  {
    reason: "series_code_changed",
    refused: (ledger) => ({
      write: () => asApp(ledger, "UPDATE ledger.voucher_series SET code = 'B' WHERE fiscal_year_id = $1 AND code = 'A'", [ledger.books.year.id]),
      facts: { code: "A" },
    }),
  },
  {
    reason: "immutable_field",
    refused: async (ledger) => {
      const voucher = await bookVoucher(ledger.app, ledger.books.company, aVoucher(ledger), ledger.who);
      return { write: () => asApp(ledger, "UPDATE ledger.vouchers SET number = 2 WHERE id = $1", [voucher.id]), facts: { field: "number", operation: "update" } };
    },
  },
];

describe("the refusals of rule 44", () => {
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

  it.each(CASES.map((refusal) => [refusal.reason, refusal] as const))("raises %s with its facts", async (_reason, refusal) => {
    const books = await addBooks(app, who);
    const next = await addBooksYear(app, books.company, "2091-01-01", "2091-12-31", who);
    const { write, facts } = await refusal.refused({ books, next: next.id, app, who });
    await expectRefusal(write(), refusal.reason, facts);
  });

  it("raises every reason of rule 44, each in one case", () => {
    const reasons = CASES.map((refusal) => refusal.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect([...reasons].sort()).toEqual([...RULE_44].sort());
    expect(RULE_44.length).toBe(20);
  });

  it("would fail with one case less or one more", () => {
    const covers = (reasons: readonly RefusalReason[]): boolean =>
      new Set(reasons).size === reasons.length && [...reasons].sort().join() === [...RULE_44].sort().join();
    const reasons = CASES.map((refusal) => refusal.reason);
    expect(covers(reasons)).toBe(true);
    expect(covers(reasons.slice(1))).toBe(false);
    expect(covers([...reasons, "unbalanced"])).toBe(false);
    expect(covers([...reasons.slice(1), "actor_missing"])).toBe(false);
  });

  it("adds a row with a refusal too: an added row on an account the year does not have", async () => {
    const books = await addBooks(app, who);
    const voucher = await bookVoucher(app, books.company, { year: books.year.id, series: "A", date: "2090-03-15", rows: balanced() }, who);
    await expectRefusal(
      inTransaction(app, { company: books.company, ...who }, () => writeRow(app, books.company, voucher.id, { account: 998, amount: 0n })),
      "account_missing",
      { number: 998 },
    );
  });
});
