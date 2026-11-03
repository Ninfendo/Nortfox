// SPDX-License-Identifier: AGPL-3.0-only

// REST and MCP give the same problem details for the same request, because
// the runner decides every refusal and each field problem points into the
// operation's flat input, the tool's arguments: /idempotencyKey is the header
// on REST and the argument on MCP. This file compares whole bodies for an
// unknown field, a wrong type, a JSON number for an amount, a missing key, all
// of them at once, a rule's refusal, a reused key and a missing permission.

import type { Client as McpClient } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  buildTestApp,
  callTool,
  mcpClient,
  postVoucher,
  principalOf,
  problemIn,
  testResolver,
  voucherBody,
  type AppPool,
} from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { addBooks } from "../../test/ledger.ts";
import type { ServerApp } from "../app.ts";

const INVALID = {
  type: "about:blank",
  title: "Bad Request",
  status: 400,
  detail: "The request does not fit the operation. Each field problem names its field.",
  code: "invalid-request",
};

const UNKNOWN_FIELD = { code: "unknown-field", detail: "The field /note is not part of this operation.", pointer: "/note" };
const WRONG_TYPE = { code: "invalid-type", detail: "The field /description must be a string.", pointer: "/description", data: { expected: "string" } };
const MISSING_KEY = {
  code: "idempotency-key-missing",
  detail: "The field /idempotencyKey is missing. A write takes an idempotency key.",
  pointer: "/idempotencyKey",
  data: { expected: "string" },
};

describe("the same problem details by REST and by MCP", () => {
  let db: TestDatabase;
  let app: Client;
  let pool: AppPool;
  let server: ServerApp;
  let writer: McpClient;
  let outsider: McpClient;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    const books = await addBooks(app);
    pool = appPool(db, 2);
    server = buildTestApp({
      database: pool.database,
      resolve: testResolver({
        writer: principalOf(books.company),
        outsider: principalOf(books.company, { permissions: ["company:read"] }),
      }),
    });
    writer = await mcpClient(server, { token: "writer" });
    outsider = await mcpClient(server, { token: "outsider" });
  });

  afterAll(async () => {
    await writer.close();
    await outsider.close();
    await pool.pool.end();
    await db.close();
  });

  /** The problem details of one write by REST and by MCP, as the token's actor. */
  async function bothWays(body: Readonly<Record<string, unknown>>, key: string | undefined, token = "writer"): Promise<{ rest: unknown; mcp: unknown }> {
    const response = await postVoucher(server.hono, token, key, body);
    const rest = await problemIn(response);
    expect(rest.status).toBe(response.status);
    const answer = await callTool(token === "writer" ? writer : outsider, "testBookVoucher", { ...body, ...(key === undefined ? {} : { idempotencyKey: key }) });
    expect(answer.isError).toBe(true);
    return { rest, mcp: answer.structured };
  }

  it.each([
    ["an unknown field", { ...voucherBody(), note: "Kvitto saknas" }, true, [UNKNOWN_FIELD]],
    ["a wrong type", { ...voucherBody(), description: 5 }, true, [WRONG_TYPE]],
    ["a missing key", voucherBody(), false, [MISSING_KEY]],
    ["all three at once", { ...voucherBody(), description: 5, note: "Kvitto saknas" }, false, [WRONG_TYPE, UNKNOWN_FIELD, MISSING_KEY]],
  ] as const)("gives equal bodies for %s", async (_label, body, withKey, errors) => {
    const { rest, mcp } = await bothWays(body, withKey ? randomUUID() : undefined);
    expect(rest).toEqual({ ...INVALID, errors });
    expect(mcp).toEqual(rest);
  });

  it("gives equal bodies for a JSON number in place of an amount, at the amount's pointer", async () => {
    const { rest, mcp } = await bothWays({ description: "Kontorsmaterial", amount: { amount: 125, currency: "SEK" } }, randomUUID());
    expect(rest).toEqual({
      ...INVALID,
      errors: [{ code: "invalid-type", detail: "The field /amount/amount must be a string.", pointer: "/amount/amount", data: { expected: "string" } }],
    });
    expect(mcp).toEqual(rest);
  });

  it("gives equal bodies for a rule's refusal of a field: 422 with its pointer and its facts", async () => {
    const { rest, mcp } = await bothWays(voucherBody("0.00"), randomUUID());
    expect(rest).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "The field /amount must be more than zero.",
      code: "amount-not-positive",
      pointer: "/amount",
      data: { amount: { amount: "0.00", currency: "SEK" } },
    });
    expect(mcp).toEqual(rest);
  });

  it("gives equal bodies for a key that another request used", async () => {
    const key = randomUUID();
    expect((await postVoucher(server.hono, "writer", key)).status).toBe(201);
    const { rest, mcp } = await bothWays(voucherBody("1.00"), key);
    expect(rest).toMatchObject({ status: 422, code: "idempotency-key-reused" });
    expect(mcp).toEqual(rest);
  });

  it("gives equal bodies for an actor without the permission", async () => {
    const { rest, mcp } = await bothWays(voucherBody(), randomUUID(), "outsider");
    expect(rest).toMatchObject({ status: 403, code: "permission-missing", permission: "test:write" });
    expect(mcp).toEqual(rest);
  });
});
