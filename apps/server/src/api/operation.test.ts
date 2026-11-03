// SPDX-License-Identifier: AGPL-3.0-only

// The runner's steps, in their order, with a database that records what it
// was asked (operation.db.test.ts runs them on PostgreSQL). A public entry
// reads no data; a call with no actor gets 401 and one without the
// permission 403 before any of its input is read; a bad input gets 400 with
// every field problem before the database is asked; then one transaction,
// the handler, and the output's check inside it.

import { defineOperation, getCompany, getHealth, type FieldIssue } from "@nortfox/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CURSOR_KEY, principalOf, testListAccounts, testListAccountsHandler } from "../../test/api.ts";
import type { Ending, Queryable, TransactionSettings, Work } from "../db/database.ts";
import { getCompanyHandler } from "../modules/companies/get-company.ts";
import { healthHandler } from "../modules/status/health.ts";
import type { RequestContext } from "./context.ts";
import { readCursor, signCursor } from "./cursor.ts";
import {
  authorize,
  handleData,
  handleList,
  handlePublic,
  ok,
  refused,
  runOperation,
  type Handler,
  type ListCall,
  type OperationCall,
  type PageResult,
} from "./operation.ts";

const COMPANY = "5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a";
const CONTEXT: RequestContext = { ...principalOf(COMPANY, { kind: "user" }), channel: "mcp" };
const COMPANY_ROW = { id: COMPANY, name: "Testbolaget Alfa AB", organizationNumber: "556000-0167", databaseNumber: 7 };

/** A database that runs the work on a transaction that answers nothing, and records each transaction. */
function recordingDatabase() {
  const transactions: { mode: "read" | "write"; settings: TransactionSettings; ended?: "commit" | "rollback" | "throw" }[] = [];
  const tx: Queryable = { query: () => Promise.reject(new Error("The fake transaction runs no query.")) };
  const run =
    (mode: "read" | "write") =>
    async <T>(settings: TransactionSettings, work: Work<T>): Promise<T> => {
      const transaction: (typeof transactions)[number] = { mode, settings };
      transactions.push(transaction);
      let ending: Ending<T>;
      try {
        ending = await work(tx);
      } catch (error) {
        transaction.ended = "throw";
        throw error;
      }
      transaction.ended = ending.commit ? "commit" : "rollback";
      return ending.value;
    };
  return { transactions, database: { read: run("read"), write: run("write"), end: () => Promise.resolve() } };
}

function call(context: RequestContext | undefined, query: Record<string, unknown> = {}, problems?: readonly FieldIssue[]): OperationCall {
  return { context, input: problems === undefined ? { query, body: undefined } : { query, body: undefined, problems }, idempotency: "none" };
}

/** A list handler that records the page it was asked for, and answers one fixed page. */
function listRecording(result: PageResult<{ id: string; number: number; description: string }>) {
  const pages: ListCall["page"][] = [];
  const handler = handleList(testListAccounts, (listCall) => {
    pages.push(listCall.page);
    return Promise.resolve(ok(result));
  });
  return { pages, handler };
}

const UNKNOWN: FieldIssue = { code: "unknown-parameter", detail: "The field /x is not part of this operation.", pointer: "/x", data: { value: "1" } };

describe("authorize", () => {
  it("lets anyone call a public operation", () => {
    expect(authorize(getHealth, undefined)).toBeUndefined();
  });

  it("refuses no actor, then an actor without the permission", () => {
    expect(authorize(getCompany, undefined)).toEqual({ kind: "authentication-required" });
    expect(authorize(getCompany, principalOf(COMPANY, { permissions: ["test:read"] }))).toEqual({
      kind: "permission-missing",
      permission: "company:read",
    });
    expect(authorize(getCompany, principalOf(COMPANY, { permissions: ["company:read"] }))).toBeUndefined();
  });
});

describe("the handlers' kinds", () => {
  it("refuses a handler whose kind does not fit its operation", () => {
    const answer = () => Promise.resolve(refused({ code: "x", detail: "x" }));
    expect(() => handlePublic(getCompany, answer)).toThrow("getCompany needs a permission, so it takes a data handler.");
    expect(() => handleData(getHealth, answer)).toThrow("getHealth is public, so it takes a public handler.");
    expect(() => handleData(testListAccounts, answer)).toThrow("testListAccounts is a list, so it takes a list handler.");
    expect(() => handleList(getCompany, answer)).toThrow("getCompany is not a list, so it takes a data handler.");
    expect(() => handleList(getHealth, answer)).toThrow("getHealth is public, so it takes a public handler.");
  });
});

describe("runOperation", () => {
  it("runs a public entry with no context and no database, and checks its output", async () => {
    const { database, transactions } = recordingDatabase();
    const outcome = await runOperation(healthHandler("1.0.0"), call(undefined), { database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({ ok: true, status: 200, output: { status: "ok", version: "1.0.0" } });
    expect(transactions).toEqual([]);
  });

  it("refuses a public entry's bad input with every problem", async () => {
    const { database } = recordingDatabase();
    const outcome = await runOperation(healthHandler("1.0.0"), call(undefined, { y: 1 }, [UNKNOWN]), { database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        kind: "invalid",
        problems: [UNKNOWN, { code: "unknown-field", detail: "The field /y is not part of this operation.", pointer: "/y", data: {} }],
      },
    });
  });

  it("gives a public handler's refusal as a rule's refusal, and throws on its bad output", async () => {
    const { database } = recordingDatabase();
    const refusing = handlePublic(getHealth, () => Promise.resolve(refused({ code: "down", detail: "Down." })));
    expect(await runOperation(refusing, call(undefined), { database, cursorKey: CURSOR_KEY })).toEqual({
      ok: false,
      refusal: { kind: "rule", refusal: { code: "down", detail: "Down." } },
    });
    const bad = handlePublic(getHealth, () => Promise.resolve(ok({ status: "ok", version: 1 } as unknown as { status: "ok"; version: string })));
    await expect(runOperation(bad, call(undefined), { database, cursorKey: CURSOR_KEY })).rejects.toThrow(
      "The output of getHealth does not fit its schema",
    );
  });

  it("refuses no actor with 401 before it reads any input, and asks no database", async () => {
    const { database, transactions } = recordingDatabase();
    const outcome = await runOperation(getCompanyHandler, call(undefined, { limit: "abc" }, [UNKNOWN]), { database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({ ok: false, refusal: { kind: "authentication-required" } });
    expect(transactions).toEqual([]);
  });

  it("refuses an actor without the permission with 403 before it reads any input, and asks no database", async () => {
    const { database, transactions } = recordingDatabase();
    const context = { ...CONTEXT, permissions: new Set(["test:read"]) };
    const outcome = await runOperation(getCompanyHandler, call(context, { limit: "abc" }, [UNKNOWN]), { database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({ ok: false, refusal: { kind: "permission-missing", permission: "company:read" } });
    expect(transactions).toEqual([]);
  });

  it("refuses a bad input with the reader's problems and then the schema's, and asks no database", async () => {
    const { database, transactions } = recordingDatabase();
    const outcome = await runOperation(testListAccountsHandler, call(CONTEXT, { limit: "abc", cursor: 5 }, [UNKNOWN]), {
      database,
      cursorKey: CURSOR_KEY,
    });
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        kind: "invalid",
        problems: [
          UNKNOWN,
          { code: "invalid-type", detail: "The field /limit must be a number.", pointer: "/limit", data: { expected: "number", value: "abc" } },
          { code: "invalid-type", detail: "The field /cursor must be a string.", pointer: "/cursor", data: { expected: "string", value: 5 } },
        ],
      },
    });
    expect(transactions).toEqual([]);
  });

  it("refuses a limit that is not a whole number with not-an-integer", async () => {
    const { database } = recordingDatabase();
    const outcome = await runOperation(testListAccountsHandler, call(CONTEXT, { limit: 1.5 }), { database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        kind: "invalid",
        problems: [{ code: "not-an-integer", detail: "The field /limit must be a whole number.", pointer: "/limit", data: { expected: "integer", value: 1.5 } }],
      },
    });
  });

  it.each([
    [undefined, 100],
    [1, 1],
    [500, 500],
    [0, 100],
    [-1, 100],
    [501, 100],
    [1e20, 100],
    [Infinity, 100],
  ])("gives a list's handler the limit %s as %s", async (limit, expected) => {
    const { database } = recordingDatabase();
    const { pages, handler } = listRecording({ items: [], total: 0 });
    const outcome = await runOperation(handler, call(CONTEXT, limit === undefined ? {} : { limit }), { database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({ ok: true, status: 200, output: { items: [], total: 0 } });
    expect(pages).toEqual([{ limit: expected }]);
  });

  it("refuses a cursor it did not make with cursor-invalid at /cursor, and asks no database", async () => {
    const { database, transactions } = recordingDatabase();
    const foreign = signCursor(CURSOR_KEY, { operationId: "testListAccounts", companyId: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d" }, ["a"]);
    const outcome = await runOperation(testListAccountsHandler, call(CONTEXT, { cursor: foreign }), { database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        kind: "invalid",
        problems: [
          {
            code: "cursor-invalid",
            detail: "The field /cursor is not a cursor that this server made for this list. Start the list again without it.",
            pointer: "/cursor",
            data: { value: foreign },
          },
        ],
      },
    });
    expect(transactions).toEqual([]);
  });

  it("gives a list's handler the sort key in its cursor, and signs the next page's", async () => {
    const { database } = recordingDatabase();
    const item = { id: "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b", number: 1930, description: "Företagskonto" };
    const { pages, handler } = listRecording({ items: [item], total: 3, next: ["k"] });
    const cursor = signCursor(CURSOR_KEY, { operationId: "testListAccounts", companyId: COMPANY }, ["j"]);
    const outcome = await runOperation(handler, call(CONTEXT, { limit: 1, cursor }), { database, cursorKey: CURSOR_KEY });
    expect(pages).toEqual([{ limit: 1, after: ["j"] }]);
    const output = (outcome as { output: { nextCursor: string } }).output;
    expect(outcome).toEqual({ ok: true, status: 200, output: { items: [item], total: 3, nextCursor: output.nextCursor } });
    expect(readCursor(CURSOR_KEY, { operationId: "testListAccounts", companyId: COMPANY }, output.nextCursor)).toEqual(["k"]);
  });

  it("runs a data handler in one read transaction with the context's company, actor, kind and channel, and commits", async () => {
    const { database, transactions } = recordingDatabase();
    const seen: unknown[] = [];
    const handler = handleData(getCompany, (dataCall, input) => {
      seen.push(dataCall.context, input);
      return Promise.resolve(ok(COMPANY_ROW));
    });
    const outcome = await runOperation(handler, call(CONTEXT), { database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({ ok: true, status: 200, output: COMPANY_ROW });
    expect(seen).toEqual([CONTEXT, { query: {}, body: undefined }]);
    expect(transactions).toEqual([
      {
        mode: "read",
        settings: { companyId: COMPANY, actorId: CONTEXT.actorId, actorKind: "user", channel: "mcp" },
        ended: "commit",
      },
    ]);
  });

  it("rolls back a handler's refusal and gives it as a rule's refusal", async () => {
    const { database, transactions } = recordingDatabase();
    const refusal = { code: "company-closed", detail: "The company is closed.", pointer: "/name", data: { name: "x" } };
    const handler = handleData(getCompany, () => Promise.resolve(refused(refusal)));
    expect(await runOperation(handler, call(CONTEXT), { database, cursorKey: CURSOR_KEY })).toEqual({ ok: false, refusal: { kind: "rule", refusal } });
    expect(transactions.map((transaction) => transaction.ended)).toEqual(["rollback"]);
  });

  it("checks the output inside the transaction, and throws on one that does not fit, so nothing commits", async () => {
    const { database, transactions } = recordingDatabase();
    const handler = handleData(getCompany, () => Promise.resolve(ok({ ...COMPANY_ROW, organizationNumber: "saknas" })));
    await expect(runOperation(handler, call(CONTEXT), { database, cursorKey: CURSOR_KEY })).rejects.toThrow(
      "The output of getCompany does not fit its schema: /organizationNumber",
    );
    expect(transactions.map((transaction) => transaction.ended)).toEqual(["throw"]);
  });

  it("throws a handler's error inside the transaction", async () => {
    const { database, transactions } = recordingDatabase();
    const handler = handleData(getCompany, () => Promise.reject(new Error("The handler failed.")));
    await expect(runOperation(handler, call(CONTEXT), { database, cursorKey: CURSOR_KEY })).rejects.toThrow("The handler failed.");
    expect(transactions.map((transaction) => transaction.ended)).toEqual(["throw"]);
  });

  it("rolls back a list handler's refusal and gives it as a rule's refusal", async () => {
    const { database, transactions } = recordingDatabase();
    const refusal = { code: "list-closed", detail: "The list is closed." };
    const handler = handleList(testListAccounts, () => Promise.resolve(refused(refusal)));
    expect(await runOperation(handler, call(CONTEXT), { database, cursorKey: CURSOR_KEY })).toEqual({ ok: false, refusal: { kind: "rule", refusal } });
    expect(transactions.map((transaction) => transaction.ended)).toEqual(["rollback"]);
  });

  describe("an operation with a body", () => {
    const write = defineOperation({
      id: "testWrite",
      method: "post",
      path: "/v1/test-writes",
      tags: ["test"],
      summary: "Write",
      description: "Writes.",
      body: z.strictObject({ name: z.string() }),
      output: z.strictObject({ name: z.string() }),
      permission: "test:write",
      tool: "Writes.",
      writes: true,
    });
    const handler: Handler = handleData(write, (_call, input) => Promise.resolve(ok({ name: input.body.name })));

    function writing(body: unknown, query: Record<string, unknown> = {}): OperationCall {
      return { context: CONTEXT, input: { query, body, problems: [] }, idempotency: { key: "k-1" } };
    }

    it("refuses a bad body with the query's problems and then the body's", async () => {
      const { database, transactions } = recordingDatabase();
      expect(await runOperation(handler, writing({ name: 5, other: true }, { x: 1 }), { database, cursorKey: CURSOR_KEY })).toEqual({
        ok: false,
        refusal: {
          kind: "invalid",
          problems: [
            { code: "unknown-field", detail: "The field /x is not part of this operation.", pointer: "/x", data: {} },
            { code: "invalid-type", detail: "The field /name must be a string.", pointer: "/name", data: { expected: "string", value: 5 } },
            { code: "unknown-field", detail: "The field /other is not part of this operation.", pointer: "/other", data: {} },
          ],
        },
      });
      expect(transactions).toEqual([]);
    });

    it("runs no write yet: the write path comes with the idempotency keys", async () => {
      const { database, transactions } = recordingDatabase();
      await expect(runOperation(handler, writing({ name: "Kassa" }), { database, cursorKey: CURSOR_KEY })).rejects.toThrow(
        "testWrite writes, and the runner runs no write yet.",
      );
      expect(transactions).toEqual([]);
    });
  });
});
