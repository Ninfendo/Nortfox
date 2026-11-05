// SPDX-License-Identifier: AGPL-3.0-only

// /mcp on PostgreSQL as the app role. Each tool's answer passes the SDK
// client's own check of structured content against the tool's output
// schema, by both eras. A list pages by MCP as by REST: a limit outside 1 to
// 500 gives 100, also a whole number far past the safe integers such as
// 1e20, a limit that is not a whole number gets 400 at /limit, and every row
// comes once across the pages.

import type { Client as McpClient } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_ERAS, TEST_REGISTRY, TEST_VERSION, appPool, buildTestApp, callTool, mcpClient, principalOf, testResolver, voucherBody, type AppPool } from "../../test/api.ts";
import { freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { addBooks, someUser } from "../../test/ledger.ts";
import type { ServerApp } from "../app.ts";

const ROWS = 250;

interface Page {
  readonly items: readonly { readonly id: string }[];
  readonly total: number;
  readonly nextCursor?: string;
}

describe("/mcp on the database", () => {
  let db: TestDatabase;
  let app: Client;
  let pool: AppPool;
  let server: ServerApp;
  let all: string[];

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    const books = await addBooks(app);
    all = await inTransaction(app, { company: books.company, ...someUser() }, async () => {
      await app.query(
        `INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description)
         SELECT $1, $2, n, 'Konto ' || n FROM pg_catalog.generate_series(2001, 2000 + $3::integer) AS n`,
        [books.company, books.year.id, ROWS],
      );
      const found = await app.query<{ id: string }>("SELECT id FROM ledger.accounts ORDER BY id");
      return found.rows.map((row) => row.id);
    });
    pool = appPool(db, 2);
    server = buildTestApp({ database: pool.database, resolve: testResolver({ writer: await principalOf(books.company) }) });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("holds more accounts than one page: the book's own and the 250 added", () => {
    expect(all.length).toBeGreaterThan(ROWS);
  });

  describe.each(MCP_ERAS)("by a client of the %s era", (era) => {
    let client: McpClient;

    beforeAll(async () => {
      client = await mcpClient(server, { token: "writer", era });
      // The client keeps each tool's output schema from the list, and checks every answer against it.
      expect((await client.listTools()).tools).toHaveLength(TEST_REGISTRY.length);
    });

    afterAll(async () => {
      await client.close();
    });

    it("answers each tool with structured content that passes the client's check against its output schema", async () => {
      const answers = [
        await callTool(client, "getHealth"),
        await callTool(client, "getCompany"),
        await callTool(client, "testBookVoucher", { ...voucherBody(), idempotencyKey: randomUUID() }),
        await callTool(client, "testListAccounts", { limit: 2 }),
      ];
      expect(answers.map((answer) => answer.isError)).toEqual([false, false, false, false]);
      expect(answers[0]?.structured).toEqual({ status: "ok", version: TEST_VERSION });
      expect(answers[2]?.structured).toMatchObject({ amount: { amount: "125.00", currency: "SEK" } });
      expect((answers[3]?.structured as Page).items).toHaveLength(2);
    });

    it("has a client that does check: an answer that does not fit a stricter schema is refused by it", async () => {
      const strict = {
        name: "getHealth",
        inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
        outputSchema: { type: "object" as const, properties: { status: { const: "down" } }, required: ["status"] },
      };
      await expect(client.callTool({ name: "getHealth", arguments: {} }, { toolDefinition: strict })).rejects.toThrow(
        "Structured content does not match the tool's output schema",
      );
    });

    async function page(args: Readonly<Record<string, unknown>>): Promise<Page> {
      const answer = await callTool(client, "testListAccounts", args);
      expect(answer.isError, JSON.stringify(answer.structured)).toBe(false);
      return answer.structured as Page;
    }

    it.each([1e20, 0, -1, 501, 2 ** 70, -1e20, Number.MAX_SAFE_INTEGER + 2, Number.MAX_VALUE])("holds 100 items with the limit %d, as REST does", async (limit) => {
      const first = await page({ limit });
      expect(first.items).toHaveLength(100);
      expect(first.total).toBe(all.length);
    });

    it("holds 100 items with no limit", async () => {
      expect((await page({})).items).toHaveLength(100);
    });

    it.each([
      [1.5, "not-an-integer"],
      ["100", "invalid-type"],
      [null, "invalid-type"],
    ])("refuses the limit %j with 400 %s at /limit", async (limit, code) => {
      const answer = await callTool(client, "testListAccounts", { limit });
      expect(answer).toMatchObject({ isError: true, structured: { status: 400, code: "invalid-request", errors: [{ code, pointer: "/limit" }] } });
    });

    it("gives every row exactly once across the pages, and no nextCursor on the last", async () => {
      const pages: Page[] = [];
      let cursor: string | undefined;
      do {
        const next = await page({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
        pages.push(next);
        cursor = next.nextCursor;
      } while (cursor !== undefined && pages.length <= all.length);
      expect(pages.flatMap((each) => each.items.map((item) => item.id))).toEqual(all);
      expect(pages.at(-1)?.nextCursor).toBeUndefined();
    });

    it("refuses a cursor the server did not make with 400 cursor-invalid at /cursor", async () => {
      const answer = await callTool(client, "testListAccounts", { cursor: "eyJ2IjoxfQ.c2lnbmF0dXJl" });
      expect(answer).toMatchObject({ isError: true, structured: { status: 400, errors: [{ code: "cursor-invalid", pointer: "/cursor" }] } });
    });
  });
});
