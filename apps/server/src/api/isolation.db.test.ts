// SPDX-License-Identifier: AGPL-3.0-only

// Two companies in one database, through the app role: a request in one
// company never returns the other's row, and a query with no company set
// returns nothing. The read handlers have no company condition of their own:
// row level security, by the transaction's company, alone decides (decision
// 9). So a handler run with a context for one company in a transaction set
// to the other reads the other's rows.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  bearer,
  buildTestApp,
  principalOf,
  testListAccountsHandler,
  testResolver,
  type AppPool,
} from "../../test/api.ts";
import { freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { addCompany, addFiscalYear, someUser } from "../../test/ledger.ts";
import { commit, type TransactionSettings } from "../db/database.ts";
import { getCompanyHandler } from "../modules/companies/get-company.ts";
import type { RequestContext } from "./context.ts";
import type { ServerApp } from "../app.ts";

const PER_COMPANY = 30;

interface Page {
  readonly items: readonly { readonly id: string; readonly number: number; readonly description: string }[];
  readonly total: number;
  readonly nextCursor?: string;
}

describe("two companies through the API", () => {
  let db: TestDatabase;
  let app: Client;
  let companyA: string;
  let companyB: string;
  const ids: Record<string, string[]> = {};
  let pool: AppPool;
  let server: ServerApp;

  /** Adds accounts with the given ids to a new fiscal year of `company`. */
  async function addAccounts(company: string, accountIds: readonly string[]): Promise<void> {
    const year = await addFiscalYear(app, company, { from: "2090-01-01", to: "2090-12-31" });
    await inTransaction(app, { company, ...someUser() }, () =>
      app.query(
        `INSERT INTO ledger.accounts (id, company_id, fiscal_year_id, number, description)
         SELECT t.id, $2, $3, (1000 + t.ord)::integer, 'Konto ' || t.ord FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ord)`,
        [accountIds, company, year.id],
      ),
    );
  }

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    companyA = await addCompany(app);
    companyB = await addCompany(app);
    // Ids that interleave in the list's order: A, B, A, B ...
    const sorted = Array.from({ length: 2 * PER_COMPANY }, () => randomUUID()).sort();
    const idsA = sorted.filter((_id, index) => index % 2 === 0);
    const idsB = sorted.filter((_id, index) => index % 2 === 1);
    ids[companyA] = idsA;
    ids[companyB] = idsB;
    await addAccounts(companyA, idsA);
    await addAccounts(companyB, idsB);
    pool = appPool(db, 1);
    server = buildTestApp({
      database: pool.database,
      resolve: testResolver({ a: principalOf(companyA, { kind: "user" }), b: principalOf(companyB, { kind: "integration" }) }),
    });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("gives each actor its own company", async () => {
    for (const [token, company] of [
      ["a", companyA],
      ["b", companyB],
    ] as const) {
      const response = await server.hono.request("/v1/company", { headers: bearer(token) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: company });
    }
  });

  it("holds only the request's company's rows in a list, paged to the end", async () => {
    for (const [token, company] of [
      ["a", companyA],
      ["b", companyB],
    ] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const query = cursor === undefined ? "?limit=7" : `?limit=7&cursor=${encodeURIComponent(cursor)}`;
        const response = await server.hono.request(`/v1/test-accounts${query}`, { headers: bearer(token) });
        expect(response.status).toBe(200);
        const page = (await response.json()) as Page;
        expect(page.total).toBe(PER_COMPANY);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(Math.ceil(PER_COMPANY / 7));
      expect(seen).toEqual(ids[company]);
    }
  });

  it("refuses a cursor that the other company's list made", async () => {
    const response = await server.hono.request("/v1/test-accounts?limit=1", { headers: bearer("b") });
    const { nextCursor } = (await response.json()) as Page;
    const replayed = await server.hono.request(`/v1/test-accounts?cursor=${encodeURIComponent(String(nextCursor))}`, { headers: bearer("a") });
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ code: "invalid-request", errors: [{ code: "cursor-invalid", pointer: "/cursor" }] });
  });

  it("adds no company condition in the read handlers: the transaction's company alone decides", async () => {
    const contextA: RequestContext = { ...principalOf(companyA, { kind: "user" }), channel: "rest" };
    const inB: TransactionSettings = { companyId: companyB, actorId: contextA.actorId, actorKind: "user", channel: "rest" };
    const company = await pool.database.read(inB, async (tx) =>
      commit(await getCompanyHandler.run({ context: contextA, tx }, { query: {}, body: undefined })),
    );
    expect(company).toMatchObject({ ok: true, output: { id: companyB } });
    const page = await pool.database.read(inB, async (tx) =>
      commit(await testListAccountsHandler.run({ context: contextA, tx, page: { limit: 500 } }, { query: {}, body: undefined })),
    );
    expect(page).toEqual({
      ok: true,
      output: { items: expect.any(Array) as unknown, total: PER_COMPANY },
    });
    expect((page as { output: Page }).output.items.map((item) => item.id)).toEqual(ids[companyB]);
  });

  it("returns nothing on the pooled connection when no company is set", async () => {
    expect((await server.hono.request("/v1/company", { headers: bearer("a") })).status).toBe(200);
    const connection = await pool.pool.connect();
    try {
      for (const table of ["ledger.companies", "ledger.accounts", "ledger.fiscal_years", "audit.history"]) {
        const found = await connection.query<{ count: bigint }>(`SELECT count(*) AS count FROM ${table}`);
        expect(found.rows[0]?.count, table).toBe(0n);
      }
    } finally {
      connection.release();
    }
  });
});
