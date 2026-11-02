// SPDX-License-Identifier: AGPL-3.0-only

// The numbers under load (rules 9 and 14 to 16 of the slice), as a property
// test. Each run makes a company with two fiscal years far in the future, the
// series A (manual), K (not manual) and I (the closing series) in each with
// three vouchers to begin with, and the automatic lock off. It then deals a
// random list of operations to four connections that run at the
// same time: bookings, refused bookings, bookings that roll back, changes of
// date inside the year and into the other year, tries to change a voucher's
// series, number or year, strikes with a new row in place, and deletions of
// the last voucher and of one that is not last. Now and then a fifth
// connection, as the owner, records a void range. Each operation is one
// transaction. A deadlock or a serialization failure counts as a rollback.
//
// After every operation, the connection that ran it reads the books in one
// snapshot and checks: in each series and year, the numbers of the live
// vouchers and of the void ranges are exactly 1 to the counter's number less
// one, each once, so there is no gap outside the void ranges, no number held
// twice and none inside a void range; every voucher is dated inside its own
// year and balances; and the record of deleted vouchers counts each number's
// deletions 1, 2, 3 and so on. Every refusal must be one that its operation
// allows. NORTFOX_PROPERTY_RUNS raises the number of runs.

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { begin, freshDatabase, type Settings, type TestDatabase } from "../../../test/database.ts";
import { addBooksYear, addCompany, bookVoucher, someSystemUser, someUser, writeVoucher, type FiscalYear } from "../../../test/ledger.ts";
import { readRefusal, type RefusalReason } from "../../db/refusals.ts";

const RUNS = Number(process.env["NORTFOX_PROPERTY_RUNS"] ?? "25");

const SERIES = ["A", "K", "I"] as const;
type Code = (typeof SERIES)[number];

type Operation =
  | { readonly kind: "book" | "bookUnbalanced" | "bookRolledBack"; readonly year: 0 | 1; readonly series: Code; readonly day: number; readonly amount: bigint }
  | { readonly kind: "moveDate" | "moveToOtherYear"; readonly year: 0 | 1; readonly series: Code; readonly pick: number; readonly day: number }
  | { readonly kind: "changeKey"; readonly year: 0 | 1; readonly series: Code; readonly pick: number; readonly field: "series_code" | "number" | "fiscal_year_id" }
  | { readonly kind: "strike" | "deleteOther"; readonly year: 0 | 1; readonly series: Code; readonly pick: number }
  | { readonly kind: "deleteLast"; readonly year: 0 | 1; readonly series: Code }
  | { readonly kind: "voidRange"; readonly year: 0 | 1; readonly series: Code; readonly length: number };

/** What each kind of operation may end in, besides being done: the refusals it allows, and whether it may be done with no row changed. */
const ALLOWED: Readonly<Record<Operation["kind"], { readonly refusals: readonly RefusalReason[]; readonly mustBeRefused: boolean }>> = {
  book: { refusals: [], mustBeRefused: false },
  bookUnbalanced: { refusals: ["unbalanced"], mustBeRefused: true },
  bookRolledBack: { refusals: [], mustBeRefused: false },
  moveDate: { refusals: [], mustBeRefused: false },
  moveToOtherYear: { refusals: ["date_outside_fiscal_year"], mustBeRefused: true },
  changeKey: { refusals: ["immutable_field"], mustBeRefused: true },
  strike: { refusals: [], mustBeRefused: false },
  deleteLast: { refusals: ["not_last_in_series"], mustBeRefused: false },
  deleteOther: { refusals: ["not_last_in_series"], mustBeRefused: false },
  voidRange: { refusals: [], mustBeRefused: false },
};

const year = fc.constantFrom<0 | 1>(0, 1);
const series = fc.constantFrom<Code>(...SERIES);
const day = fc.integer({ min: 0, max: 364 });
const pick = fc.nat({ max: 50 });

const operation: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("book" as const), year, series, day, amount: fc.bigInt({ min: 1n, max: 10n ** 15n }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("bookUnbalanced" as const), year, series, day, amount: fc.bigInt({ min: 1n, max: 10n ** 15n }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("bookRolledBack" as const), year, series, day, amount: fc.bigInt({ min: 1n, max: 1000n }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("moveDate" as const), year, series, pick, day }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("moveToOtherYear" as const), year, series, pick, day }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("changeKey" as const), year, series, pick, field: fc.constantFrom("series_code" as const, "number" as const, "fiscal_year_id" as const) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("strike" as const), year, series, pick }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("deleteLast" as const), year, series }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("deleteOther" as const), year, series, pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("voidRange" as const), year, series, length: fc.integer({ min: 1, max: 3 }) }) },
);

/** How one operation ended. */
type Outcome = { readonly kind: "done"; readonly changed: number } | { readonly kind: "refused"; readonly reason: RefusalReason } | { readonly kind: "rolled back" };

/** The SQLSTATEs of a deadlock and of a serialization failure: the transaction rolled back, as any may. */
const ROLLED_BACK = new Set(["40P01", "40001"]);

interface Books {
  readonly company: string;
  readonly years: readonly [FiscalYear, FiscalYear];
}

function dateIn(year: FiscalYear, dayOfYear: number): string {
  const date = new Date(`${year.from_date}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayOfYear);
  return date.toISOString().slice(0, 10);
}

/** The books as one snapshot gives them: the counters, the live vouchers, the void ranges and the record of deleted vouchers. */
interface Snapshot {
  readonly counters: { year: string; code: string; next: number }[];
  readonly vouchers: { year: string; code: string; number: number; inside: boolean; balance: string }[];
  readonly ranges: { year: string; code: string; first: number; last: number }[];
  readonly deleted: { year: string; code: string; number: number; count: number }[];
}

const SNAPSHOT = `
  SELECT
    (SELECT COALESCE(pg_catalog.json_agg(pg_catalog.json_build_object('year', s.fiscal_year_id, 'code', s.code, 'next', c.next_number)), '[]')
     FROM ledger.voucher_series AS s JOIN ledger.voucher_counters AS c ON c.series_id = s.id) AS counters,
    (SELECT COALESCE(pg_catalog.json_agg(pg_catalog.json_build_object(
       'year', v.fiscal_year_id, 'code', v.series_code, 'number', v.number,
       'inside', v.transaction_date BETWEEN y.from_date AND y.to_date,
       'balance', (SELECT COALESCE(sum(r.amount), 0)::text FROM ledger.voucher_rows AS r WHERE r.voucher_id = v.id AND NOT r.removed))), '[]')
     FROM ledger.vouchers AS v JOIN ledger.fiscal_years AS y ON y.id = v.fiscal_year_id) AS vouchers,
    (SELECT COALESCE(pg_catalog.json_agg(pg_catalog.json_build_object('year', r.fiscal_year_id, 'code', r.series_code, 'first', r.first_number, 'last', r.last_number)), '[]')
     FROM ledger.void_ranges AS r) AS ranges,
    (SELECT COALESCE(pg_catalog.json_agg(pg_catalog.json_build_object('year', d.fiscal_year_id, 'code', d.series_code, 'number', d.number, 'count', d.deletion_count)), '[]')
     FROM ledger.deleted_vouchers AS d) AS deleted`;

/** What is wrong with the books, in plain words; empty when nothing is. */
function problems(snapshot: Snapshot): string[] {
  const found: string[] = [];
  for (const counter of snapshot.counters) {
    const key = (row: { year: string; code: string }): boolean => row.year === counter.year && row.code === counter.code;
    const numbers = [
      ...snapshot.vouchers.filter(key).map((voucher) => voucher.number),
      ...snapshot.ranges.filter(key).flatMap((range) => Array.from({ length: range.last - range.first + 1 }, (_, index) => range.first + index)),
    ].sort((a, b) => a - b);
    const wanted = Array.from({ length: counter.next - 1 }, (_, index) => index + 1);
    if (numbers.join() !== wanted.join()) {
      found.push(`Series ${counter.code} of year ${counter.year}: the vouchers and void ranges hold ${numbers.join(" ")}, not 1 to ${String(counter.next - 1)}.`);
    }
    const deletions = new Map<number, number[]>();
    for (const entry of snapshot.deleted.filter(key)) {
      deletions.set(entry.number, [...(deletions.get(entry.number) ?? []), entry.count]);
    }
    for (const [number, counts] of deletions) {
      const sorted = [...counts].sort((a, b) => a - b);
      if (sorted.join() !== sorted.map((_, index) => index + 1).join()) {
        found.push(`Series ${counter.code} of year ${counter.year}: number ${String(number)} has the deletion counts ${sorted.join(" ")}.`);
      }
    }
  }
  for (const voucher of snapshot.vouchers) {
    if (!voucher.inside) {
      found.push(`Voucher ${voucher.code} ${String(voucher.number)} is dated outside its own year.`);
    }
    if (voucher.balance !== "0") {
      found.push(`Voucher ${voucher.code} ${String(voucher.number)} does not balance: ${voucher.balance}.`);
    }
  }
  return found;
}

describe("voucher numbers under parallel bookings, changes, deletions, rollbacks and void ranges", () => {
  let db: TestDatabase;
  let lanes: Client[];
  let owner: Client;
  const who = someUser();
  const restorer = someSystemUser();

  beforeAll(async () => {
    db = await freshDatabase();
    lanes = await Promise.all([0, 1, 2, 3].map(() => db.connect("app")));
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  async function newBooks(): Promise<Books> {
    const [app] = lanes;
    if (app === undefined) {
      throw new Error("No connection.");
    }
    const company = await addCompany(app, who);
    const first = await addBooksYear(app, company, "2081-01-01", "2081-12-31", who);
    const second = await addBooksYear(app, company, "2082-01-01", "2082-12-31", who);
    // Three vouchers in each series and year to begin with, so the changes and deletions have something to act on.
    for (const year of [first, second]) {
      for (const code of SERIES) {
        for (const dayOfYear of [10, 100, 200]) {
          await bookVoucher(
            app,
            company,
            {
              year: year.id,
              series: code,
              referenceType: code === "K" ? "INVOICE" : "MANUAL",
              date: dateIn(year, dayOfYear),
              rows: [
                { account: 1930, amount: 500n },
                { account: 3001, amount: -500n },
              ],
            },
            who,
          );
        }
      }
    }
    return { company, years: [first, second] };
  }

  /** Runs `work` as one transaction, and says how it ended. Any error that is neither a refusal nor a rollback fails the run. */
  async function attempt(client: Client, settings: Settings, work: () => Promise<number>, end: "COMMIT" | "ROLLBACK" = "COMMIT"): Promise<Outcome> {
    try {
      await begin(client, settings);
      const changed = await work();
      await client.query(end);
      return { kind: "done", changed };
    } catch (error) {
      await client.query("ROLLBACK");
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && ROLLED_BACK.has(code)) {
        return { kind: "rolled back" };
      }
      const refusal = readRefusal(error);
      if (refusal === undefined) {
        throw error;
      }
      return { kind: "refused", reason: refusal.reason };
    }
  }

  /** The id of a live voucher of the series, picked by its place among them, or undefined when it has none. */
  async function target(client: Client, books: Books, op: { year: 0 | 1; series: Code; pick: number }, notLast = false): Promise<string | undefined> {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM ledger.vouchers AS v WHERE fiscal_year_id = $1 AND series_code = $2
         AND (NOT $3 OR number < (SELECT max(w.number) FROM ledger.vouchers AS w WHERE w.fiscal_year_id = v.fiscal_year_id AND w.series_code = v.series_code))
       ORDER BY number`,
      [books.years[op.year].id, op.series, notLast],
    );
    return found.rows.length === 0 ? undefined : found.rows[op.pick % found.rows.length]?.id;
  }

  async function run(client: Client, books: Books, op: Operation): Promise<Outcome> {
    const settings = { company: books.company, ...who };
    const year = books.years[op.year];
    const referenceType = op.series === "K" ? "INVOICE" : "MANUAL";
    switch (op.kind) {
      case "book":
      case "bookUnbalanced":
      case "bookRolledBack": {
        const credit = op.kind === "bookUnbalanced" ? 1n - op.amount : -op.amount;
        return attempt(
          client,
          settings,
          async () => {
            await writeVoucher(client, books.company, {
              year: year.id,
              series: op.series,
              referenceType,
              date: dateIn(year, op.day),
              rows: [
                { account: 1930, amount: op.amount },
                { account: 3001, amount: credit },
              ],
            });
            return 1;
          },
          op.kind === "bookRolledBack" ? "ROLLBACK" : "COMMIT",
        );
      }
      case "moveDate":
      case "moveToOtherYear":
        return attempt(client, settings, async () => {
          const id = await target(client, books, op);
          const date = dateIn(op.kind === "moveDate" ? year : books.years[op.year === 0 ? 1 : 0], op.day);
          return id === undefined ? 0 : ((await client.query("UPDATE ledger.vouchers SET transaction_date = $2 WHERE id = $1", [id, date])).rowCount ?? 0);
        });
      case "changeKey":
        return attempt(client, settings, async () => {
          const id = await target(client, books, op);
          const other = books.years[op.year === 0 ? 1 : 0].id;
          const set = {
            series_code: op.series === "A" ? "series_code = 'K'" : "series_code = 'A'",
            number: "number = number + 1000",
            fiscal_year_id: "fiscal_year_id = $2",
          }[op.field];
          return id === undefined
            ? 0
            : ((await client.query(`UPDATE ledger.vouchers SET ${set} WHERE id = $1`, op.field === "fiscal_year_id" ? [id, other] : [id])).rowCount ?? 0);
        });
      case "strike":
        return attempt(client, settings, async () => {
          const id = await target(client, books, op);
          if (id === undefined) {
            return 0;
          }
          const struck = await client.query<{ account_number: number; amount: bigint }>(
            `UPDATE ledger.voucher_rows SET removed = true
             WHERE id = (SELECT r.id FROM ledger.voucher_rows AS r WHERE r.voucher_id = $1 AND NOT r.removed ORDER BY r.position LIMIT 1) AND NOT removed
             RETURNING account_number, amount`,
            [id],
          );
          const [row] = struck.rows;
          if (row === undefined) {
            return 0;
          }
          await client.query("INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, amount) VALUES ($1, $2, $3, $4)", [
            books.company,
            id,
            row.account_number,
            row.amount,
          ]);
          return 1;
        });
      case "deleteLast":
        return attempt(client, settings, async () => {
          const found = await client.query(
            `DELETE FROM ledger.vouchers WHERE id = (
               SELECT id FROM ledger.vouchers WHERE fiscal_year_id = $1 AND series_code = $2 ORDER BY number DESC LIMIT 1)`,
            [year.id, op.series],
          );
          return found.rowCount ?? 0;
        });
      case "deleteOther":
        return attempt(client, settings, async () => {
          const id = await target(client, books, op, true);
          return id === undefined ? 0 : ((await client.query("DELETE FROM ledger.vouchers WHERE id = $1", [id])).rowCount ?? 0);
        });
      case "voidRange":
        return attempt(owner, { company: books.company, ...restorer }, async () => {
          const counter = await owner.query<{ next_number: number }>(
            `SELECT c.next_number FROM ledger.voucher_counters AS c JOIN ledger.voucher_series AS s ON s.id = c.series_id
             WHERE s.fiscal_year_id = $1 AND s.code = $2 FOR UPDATE OF c`,
            [year.id, op.series],
          );
          const next = counter.rows[0]?.next_number ?? 1;
          await owner.query(
            `INSERT INTO ledger.void_ranges (company_id, fiscal_year_id, series_code, first_number, last_number, reason)
             VALUES ($1, $2, $3, $4, $5, 'Återläsning av säkerhetskopia')`,
            [books.company, year.id, op.series, next, next + op.length - 1],
          );
          return 1;
        });
    }
  }

  /** The books' problems, read by `client` in one snapshot. */
  async function check(client: Client, books: Books): Promise<string[]> {
    await begin(client, { company: books.company });
    try {
      const found = await client.query<Snapshot>(SNAPSHOT);
      const [snapshot] = found.rows;
      return snapshot === undefined ? ["The books could not be read."] : problems(snapshot);
    } finally {
      await client.query("COMMIT");
    }
  }

  /** The problems with one operation's outcome, in plain words; empty when it ended as its kind allows. */
  function outcomeProblems(op: Operation, outcome: Outcome): string[] {
    const allowed = ALLOWED[op.kind];
    if (outcome.kind === "refused" && !allowed.refusals.includes(outcome.reason)) {
      return [`${op.kind} was refused with ${outcome.reason}, which it does not allow.`];
    }
    if (outcome.kind === "done" && allowed.mustBeRefused && outcome.changed > 0) {
      return [`${op.kind} was done, but must be refused.`];
    }
    return [];
  }

  it(
    "keeps every series gap-free outside its void ranges, each number once, and every voucher inside its own year",
    async () => {
      /** How often each kind of operation ended in each way, over every run, so the test can show that it did what it says. */
      const seen = new Map<string, number>();
      const tally = (op: Operation, outcome: Outcome): void => {
        const way = outcome.kind === "done" ? (outcome.changed > 0 ? "done" : "nothing to do") : outcome.kind === "refused" ? outcome.reason : outcome.kind;
        seen.set(`${op.kind} ${way}`, (seen.get(`${op.kind} ${way}`) ?? 0) + 1);
      };
      await fc.assert(
        fc.asyncProperty(fc.array(operation, { minLength: 10, maxLength: 60 }), async (operations) => {
          const books = await newBooks();
          const failures: string[] = [];
          // Four lanes as the app, each with every fourth operation, and a fifth as the owner with the void ranges.
          const lane = async (index: number): Promise<void> => {
            const client = index === 4 ? owner : lanes[index];
            if (client === undefined) {
              throw new Error("No connection.");
            }
            for (const [place, op] of operations.entries()) {
              const ownersOperation = op.kind === "voidRange";
              if (ownersOperation ? index !== 4 : place % 4 !== index) {
                continue;
              }
              const outcome = await run(client, books, op);
              tally(op, outcome);
              failures.push(...outcomeProblems(op, outcome), ...(await check(client, books)).map((problem) => `after ${op.kind}: ${problem}`));
            }
          };
          await Promise.all([0, 1, 2, 3, 4].map(lane));
          failures.push(...(await check(owner, books)));
          expect(failures).toEqual([]);
        }),
        { numRuns: RUNS, endOnFailure: true },
      );
      // The runs booked, changed, struck, deleted and recorded void ranges, and were refused as they should be.
      for (const way of [
        "book done",
        "bookUnbalanced unbalanced",
        "bookRolledBack done",
        "moveDate done",
        "moveToOtherYear date_outside_fiscal_year",
        "changeKey immutable_field",
        "strike done",
        "deleteLast done",
        "deleteOther not_last_in_series",
        "voidRange done",
      ]) {
        expect(seen.get(way) ?? 0, `${way}, in ${JSON.stringify(Object.fromEntries(seen))}`).toBeGreaterThan(0);
      }
    },
    180_000,
  );

  it("finds the problems it looks for, so it cannot pass on books that break the rules", () => {
    const year = randomUUID();
    const good: Snapshot = {
      counters: [{ year, code: "A", next: 5 }],
      vouchers: [
        { year, code: "A", number: 1, inside: true, balance: "0" },
        { year, code: "A", number: 4, inside: true, balance: "0" },
      ],
      ranges: [{ year, code: "A", first: 2, last: 3 }],
      deleted: [
        { year, code: "A", number: 5, count: 1 },
        { year, code: "A", number: 5, count: 2 },
      ],
    };
    expect(problems(good)).toEqual([]);
    expect(problems({ ...good, counters: [{ year, code: "A", next: 6 }] })).toHaveLength(1);
    expect(problems({ ...good, ranges: [{ year, code: "A", first: 2, last: 4 }] })).toHaveLength(1);
    expect(problems({ ...good, vouchers: [...good.vouchers, { year, code: "A", number: 1, inside: true, balance: "0" }] })).toHaveLength(1);
    expect(problems({ ...good, vouchers: [{ year, code: "A", number: 1, inside: false, balance: "0" }, ...good.vouchers.slice(1)] })).toHaveLength(1);
    expect(problems({ ...good, vouchers: [{ year, code: "A", number: 1, inside: true, balance: "5" }, ...good.vouchers.slice(1)] })).toHaveLength(1);
    expect(problems({ ...good, deleted: [{ year, code: "A", number: 5, count: 2 }] })).toHaveLength(1);
    expect(outcomeProblems({ kind: "changeKey", year: 0, series: "A", pick: 0, field: "number" }, { kind: "done", changed: 1 })).toHaveLength(1);
    expect(outcomeProblems({ kind: "book", year: 0, series: "A", day: 0, amount: 1n }, { kind: "refused", reason: "unbalanced" })).toHaveLength(1);
    expect(outcomeProblems({ kind: "deleteLast", year: 0, series: "A" }, { kind: "refused", reason: "not_last_in_series" })).toEqual([]);
  });
});
