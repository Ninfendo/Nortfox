// SPDX-License-Identifier: AGPL-3.0-only

// Paging, on 250 accounts through the test-only list. With no limit a page
// holds 100 items. A limit outside 1 to 500 gives 100 too, also one past the
// safe integers or too long to read as anything but infinity, as the
// established API does. A limit that is not a whole number gets 400. Every row
// comes once across the pages, the total is right, the last page has no
// nextCursor, and a cursor the server did not make gets 400.

import fc from "fast-check";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_KEY, appPool, bearer, buildTestApp, principalOf, testResolver, type AppPool } from "../../test/api.ts";
import { freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { addCompany, addFiscalYear, someUser } from "../../test/ledger.ts";
import type { ServerApp } from "../app.ts";
import { signCursor } from "./cursor.ts";

const ROWS = 250;

interface Page {
  readonly items: readonly { readonly id: string; readonly number: number; readonly description: string }[];
  readonly total: number;
  readonly nextCursor?: string;
}

describe("paging", () => {
  let db: TestDatabase;
  let app: Client;
  let company: string;
  let all: string[];
  let pool: AppPool;
  let server: ServerApp;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    company = await addCompany(app);
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    all = await inTransaction(app, { company, ...someUser() }, async () => {
      await app.query(
        `INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description)
         SELECT $1, $2, n, 'Konto ' || n FROM pg_catalog.generate_series(1001, 1000 + $3::integer) AS n`,
        [company, year.id, ROWS],
      );
      const found = await app.query<{ id: string }>("SELECT id FROM ledger.accounts ORDER BY id");
      return found.rows.map((row) => row.id);
    });
    pool = appPool(db, 2);
    server = buildTestApp({ database: pool.database, resolve: testResolver({ reader: principalOf(company) }) });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function page(query: string): Promise<{ status: number; body: Page }> {
    const response = await server.hono.request(`/v1/test-accounts${query}`, { headers: bearer("reader") });
    return { status: response.status, body: (await response.json()) as Page };
  }

  /** Every page of the list with `limit`, from the first to the last. */
  async function pagesWith(limit: string): Promise<Page[]> {
    const pages: Page[] = [];
    let cursor: string | undefined;
    do {
      const query = `?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const answer = await page(query);
      expect(answer.status, query).toBe(200);
      pages.push(answer.body);
      cursor = answer.body.nextCursor;
    } while (cursor !== undefined && pages.length <= ROWS);
    return pages;
  }

  function idsOf(pages: readonly Page[]): string[] {
    return pages.flatMap((each) => each.items.map((item) => item.id));
  }

  it("holds 100 items with no limit, with the total and the cursor of the next page", async () => {
    const first = await page("");
    expect(first.status).toBe(200);
    expect(first.body.items.map((item) => item.id)).toEqual(all.slice(0, 100));
    expect(first.body.total).toBe(ROWS);
    expect(first.body.nextCursor).toEqual(expect.any(String));
  });

  it.each(["0", "-1", "501", "99999999999999999999", "1".repeat(400), "-99999999999999999999", "100.0"])(
    "holds 100 items with the limit %s",
    async (limit) => {
      const answer = await page(`?limit=${limit}`);
      expect(answer.status).toBe(200);
      expect(answer.body.items).toHaveLength(100);
      expect(answer.body.total).toBe(ROWS);
    },
  );

  it("holds as many items as a limit from 1 to 500 says", async () => {
    expect((await page("?limit=1")).body.items).toHaveLength(1);
    expect((await page("?limit=500")).body.items).toHaveLength(ROWS);
  });

  it.each([
    ["1.5", "not-an-integer"],
    ["abc", "invalid-type"],
  ])("refuses the limit %s with 400 %s at /limit", async (limit, code) => {
    const answer = await page(`?limit=${limit}`);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "invalid-request", errors: [{ code, pointer: "/limit" }] });
  });

  it("gives every row exactly once across the pages, the total on each, and no nextCursor on the last", async () => {
    const pages = await pagesWith("100");
    expect(pages.map((each) => each.items.length)).toEqual([100, 100, 50]);
    expect(pages.map((each) => each.total)).toEqual([ROWS, ROWS, ROWS]);
    expect(idsOf(pages)).toEqual(all);
    expect(pages.at(-1)?.nextCursor).toBeUndefined();
    expect(pages.slice(0, -1).every((each) => typeof each.nextCursor === "string")).toBe(true);
  });

  it("ends a list whose last page is full without a page after it", async () => {
    const pages = await pagesWith("125");
    expect(pages.map((each) => each.items.length)).toEqual([125, 125]);
    expect(pages.at(-1)?.nextCursor).toBeUndefined();
  });

  it("refuses a cursor the server did not make", async () => {
    const foreign = [
      "garbage",
      signCursor(new Uint8Array(32).fill(9), { operationId: "testListAccounts", companyId: company }, [String(all[0])]),
      signCursor(CURSOR_KEY, { operationId: "listVouchers", companyId: company }, [String(all[0])]),
    ];
    for (const cursor of foreign) {
      const answer = await page(`?cursor=${encodeURIComponent(cursor)}`);
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: "invalid-request", errors: [{ code: "cursor-invalid", pointer: "/cursor" }] });
    }
  });

  it("gives each limit its effective size, past the safe integers too, and every row once", async () => {
    const limits = fc.oneof(
      fc.integer({ min: -600, max: 600 }).map(String),
      fc.bigInt({ min: 2n ** 53n, max: 10n ** 40n }).map(String),
      fc.bigInt({ min: -(10n ** 40n), max: -(2n ** 53n) }).map(String),
    );
    await fc.assert(
      fc.asyncProperty(limits, async (limit) => {
        const number = Number(limit);
        const size = number >= 1 && number <= 500 ? number : 100;
        const pages = await pagesWith(limit);
        expect(pages.map((each) => each.items.length)).toEqual([
          ...Array.from({ length: Math.floor(ROWS / size) }, () => size),
          ...(ROWS % size === 0 ? [] : [ROWS % size]),
        ]);
        expect(idsOf(pages)).toEqual(all);
      }),
      { numRuns: 25 },
    );
  });
});
