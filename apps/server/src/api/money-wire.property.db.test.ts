// SPDX-License-Identifier: AGPL-3.0-only

// Money on the wire, as a property, through the test-only write on
// PostgreSQL. Amounts are drawn up to the bounds of PostgreSQL's bigint of
// öre and past them, each sent as a decimal string with all its decimals or
// with as few as it needs. From 1 öre to the largest bigint the write books
// the same öre in the database and answers them with two decimals. Past the
// bounds it is 400 out-of-range at /amount/amount, never a 500. Zero or less
// is the write's own rule, 422.

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { ORE_MAX, ORE_MIN, oreToMoney } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, buildTestApp, postVoucher, principalOf, problemIn, testResolver, voucherBody, type AppPool } from "../../test/api.ts";
import { freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { addBooks, type Books } from "../../test/ledger.ts";
import type { ServerApp } from "../app.ts";

/** An amount of öre in its wire form with two decimals, or with as few as it needs: "125.50" or "125.5", "125.00" or "125". */
function wireForm(ore: bigint, short: boolean): string {
  const full = oreToMoney(ore, "SEK").amount;
  return short ? full.replace(/0+$/, "").replace(/\.$/, "") : full;
}

describe("money on the wire", () => {
  let db: TestDatabase;
  let app: Client;
  let books: Books;
  let pool: AppPool;
  let server: ServerApp;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    books = await addBooks(app);
    pool = appPool(db, 2);
    server = buildTestApp({ database: pool.database, resolve: testResolver({ writer: await principalOf(books.company) }) });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The debit and the credit that the voucher `id` holds, read as the app. */
  async function bookedOf(id: string): Promise<{ debit: bigint; credit: bigint } | undefined> {
    return inTransaction(app, { company: books.company }, async () => {
      const found = await app.query<{ debit: bigint; credit: bigint }>(
        "SELECT sum(debit)::bigint AS debit, sum(credit)::bigint AS credit FROM ledger.voucher_rows WHERE voucher_id = $1",
        [id],
      );
      return found.rows[0];
    });
  }

  const amounts = fc.oneof(
    fc.constantFrom(1n, 99n, 100n, ORE_MAX, ORE_MAX + 1n, ORE_MIN - 1n, 0n, -1n, ORE_MIN),
    fc.bigInt({ min: 1n, max: ORE_MAX }),
    fc.bigInt({ min: 1n, max: 10n ** 8n }),
    fc.bigInt({ min: ORE_MAX + 1n, max: ORE_MAX * 1000n }),
    fc.bigInt({ min: ORE_MIN * 1000n, max: ORE_MIN - 1n }),
    fc.bigInt({ min: ORE_MIN, max: 0n }),
  );

  it("books and answers every amount from 1 öre to the largest bigint exactly, refuses one past the bounds with 400 and one of zero or less with 422", async () => {
    await fc.assert(
      fc.asyncProperty(amounts, fc.boolean(), async (ore, short) => {
        const sent = wireForm(ore, short);
        const response = await postVoucher(server.hono, "writer", randomUUID(), voucherBody(sent));
        if (ore > ORE_MAX || ore < ORE_MIN) {
          expect(response.status, sent).toBe(400);
          expect((await problemIn(response)).errors).toEqual([
            {
              code: "out-of-range",
              detail: "The field /amount/amount is outside the range of an amount, -92233720368547758.08 to 92233720368547758.07.",
              pointer: "/amount/amount",
              data: { minimum: "-92233720368547758.08", maximum: "92233720368547758.07" },
            },
          ]);
        } else if (ore <= 0n) {
          expect(response.status, sent).toBe(422);
          expect(await problemIn(response)).toMatchObject({ code: "amount-not-positive", pointer: "/amount", data: { amount: oreToMoney(ore, "SEK") } });
        } else {
          expect(response.status, sent).toBe(201);
          const answer = (await response.json()) as { id: string; amount: unknown };
          expect(answer.amount).toEqual({ amount: oreToMoney(ore, "SEK").amount, currency: "SEK" });
          expect(await bookedOf(answer.id)).toEqual({ debit: ore, credit: ore });
        }
      }),
      { numRuns: 120 },
    );
  });
});
