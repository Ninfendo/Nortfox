// SPDX-License-Identifier: AGPL-3.0-only

// The runner's steps, in their order, with a database that records what it
// was asked (operation.db.test.ts runs them on PostgreSQL). A public entry
// reads no data; a call with no actor gets 401 and one without the
// permission 403 before any of its input is read; a bad input gets 400 with
// every field problem before the database is asked; then one transaction,
// the handler, and the output's check inside it. A write with a key holds
// the key while it runs, looks it up, and stores it with the checked answer
// before it commits; a refusal of the ledger is a rule's refusal or a fault.

import { defineOperation, getCompany, getHealth, type FieldIssue } from "@nortfox/contract";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CURSOR_KEY, principalOf, runnerDeps, testListAccounts, testListAccountsHandler } from "../../test/api.ts";
import type { Ending, Queryable, TransactionSettings, Work } from "../db/database.ts";
import { codeOf } from "../db/refusals.ts";
import { getCompanyHandler } from "../modules/companies/get-company.ts";
import { healthHandler } from "../modules/status/health.ts";
import type { RequestContext } from "./context.ts";
import { readCursor, signCursor } from "./cursor.ts";
import { requestHash } from "./idempotency.ts";
import {
  authorize,
  handleData,
  handleList,
  handlePublic,
  ok,
  refused,
  runOperation,
  type Answer,
  type Handler,
  type ListCall,
  type OperationCall,
  type PageResult,
} from "./operation.ts";

const COMPANY = "5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a";
const CONTEXT: RequestContext = { ...principalOf(COMPANY, { kind: "user" }), channel: "mcp" };
const COMPANY_ROW = { id: COMPANY, name: "Testbolaget Alfa AB", organizationNumber: "556000-0167", databaseNumber: 7 };

/** How the fake transaction answers a query: with rows, or by refusing it. */
type Answering = (text: string, values: readonly unknown[]) => readonly QueryResultRow[];

function answersNothing(): never {
  throw new Error("The fake transaction runs no query.");
}

/**
 * A database that runs the work on a fake transaction, and records each
 * transaction and each query. The transaction answers each query as
 * `answering` says; by default it refuses every one.
 */
function recordingDatabase(answering: Answering = answersNothing) {
  const transactions: { mode: "read" | "write"; settings: TransactionSettings; ended?: "commit" | "rollback" | "throw" }[] = [];
  const queries: { transaction: number; text: string; values: readonly unknown[] }[] = [];
  const run =
    (mode: "read" | "write") =>
    async <T>(settings: TransactionSettings, work: Work<T>): Promise<T> => {
      const transaction: (typeof transactions)[number] = { mode, settings };
      const index = transactions.push(transaction) - 1;
      const tx: Queryable = {
        query: <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
          queries.push({ transaction: index, text, values });
          // A throw of `answering` rejects the query, as a refused statement does.
          return Promise.resolve().then(() => ({ rows: answering(text, values) }) as QueryResult<Row>);
        },
      };
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
  return { transactions, queries, database: { read: run("read"), write: run("write"), end: () => Promise.resolve() } };
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
    const outcome = await runOperation(healthHandler("1.0.0"), call(undefined), runnerDeps(database));
    expect(outcome).toEqual({ ok: true, status: 200, output: { status: "ok", version: "1.0.0" } });
    expect(transactions).toEqual([]);
  });

  it("refuses a public entry's bad input with every problem", async () => {
    const { database } = recordingDatabase();
    const outcome = await runOperation(healthHandler("1.0.0"), call(undefined, { y: 1 }, [UNKNOWN]), runnerDeps(database));
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
    expect(await runOperation(refusing, call(undefined), runnerDeps(database))).toEqual({
      ok: false,
      refusal: { kind: "rule", refusal: { code: "down", detail: "Down." } },
    });
    const bad = handlePublic(getHealth, () => Promise.resolve(ok({ status: "ok", version: 1 } as unknown as { status: "ok"; version: string })));
    await expect(runOperation(bad, call(undefined), runnerDeps(database))).rejects.toThrow(
      "The output of getHealth does not fit its schema",
    );
  });

  it("refuses no actor with 401 before it reads any input, and asks no database", async () => {
    const { database, transactions } = recordingDatabase();
    const outcome = await runOperation(getCompanyHandler, call(undefined, { limit: "abc" }, [UNKNOWN]), runnerDeps(database));
    expect(outcome).toEqual({ ok: false, refusal: { kind: "authentication-required" } });
    expect(transactions).toEqual([]);
  });

  it("refuses an actor without the permission with 403 before it reads any input, and asks no database", async () => {
    const { database, transactions } = recordingDatabase();
    const context = { ...CONTEXT, permissions: new Set(["test:read"]) };
    const outcome = await runOperation(getCompanyHandler, call(context, { limit: "abc" }, [UNKNOWN]), runnerDeps(database));
    expect(outcome).toEqual({ ok: false, refusal: { kind: "permission-missing", permission: "company:read" } });
    expect(transactions).toEqual([]);
  });

  it("refuses a bad input with the reader's problems and then the schema's, and asks no database", async () => {
    const { database, transactions } = recordingDatabase();
    const outcome = await runOperation(testListAccountsHandler, call(CONTEXT, { limit: "abc", cursor: 5 }, [UNKNOWN]), runnerDeps(database));
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
    const outcome = await runOperation(testListAccountsHandler, call(CONTEXT, { limit: 1.5 }), runnerDeps(database));
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
    const outcome = await runOperation(handler, call(CONTEXT, limit === undefined ? {} : { limit }), runnerDeps(database));
    expect(outcome).toEqual({ ok: true, status: 200, output: { items: [], total: 0 } });
    expect(pages).toEqual([{ limit: expected }]);
  });

  it("refuses a cursor it did not make with cursor-invalid at /cursor, and asks no database", async () => {
    const { database, transactions } = recordingDatabase();
    const foreign = signCursor(CURSOR_KEY, { operationId: "testListAccounts", companyId: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d" }, ["a"]);
    const outcome = await runOperation(testListAccountsHandler, call(CONTEXT, { cursor: foreign }), runnerDeps(database));
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
    const outcome = await runOperation(handler, call(CONTEXT, { limit: 1, cursor }), runnerDeps(database));
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
    const outcome = await runOperation(handler, call(CONTEXT), runnerDeps(database));
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
    expect(await runOperation(handler, call(CONTEXT), runnerDeps(database))).toEqual({ ok: false, refusal: { kind: "rule", refusal } });
    expect(transactions.map((transaction) => transaction.ended)).toEqual(["rollback"]);
  });

  it("checks the output inside the transaction, and throws on one that does not fit, so nothing commits", async () => {
    const { database, transactions } = recordingDatabase();
    const handler = handleData(getCompany, () => Promise.resolve(ok({ ...COMPANY_ROW, organizationNumber: "saknas" })));
    await expect(runOperation(handler, call(CONTEXT), runnerDeps(database))).rejects.toThrow(
      "The output of getCompany does not fit its schema: /organizationNumber",
    );
    expect(transactions.map((transaction) => transaction.ended)).toEqual(["throw"]);
  });

  it("throws a handler's error inside the transaction", async () => {
    const { database, transactions } = recordingDatabase();
    const handler = handleData(getCompany, () => Promise.reject(new Error("The handler failed.")));
    await expect(runOperation(handler, call(CONTEXT), runnerDeps(database))).rejects.toThrow("The handler failed.");
    expect(transactions.map((transaction) => transaction.ended)).toEqual(["throw"]);
  });

  it("rolls back a list handler's refusal and gives it as a rule's refusal", async () => {
    const { database, transactions } = recordingDatabase();
    const refusal = { code: "list-closed", detail: "The list is closed." };
    const handler = handleList(testListAccounts, () => Promise.resolve(refused(refusal)));
    expect(await runOperation(handler, call(CONTEXT), runnerDeps(database))).toEqual({ ok: false, refusal: { kind: "rule", refusal } });
    expect(transactions.map((transaction) => transaction.ended)).toEqual(["rollback"]);
  });

  describe("a write", () => {
    const write = defineOperation({
      id: "testWrite",
      method: "post",
      path: "/v1/test-writes",
      tags: ["test"],
      summary: "Write",
      description: "Writes.",
      body: z.strictObject({ name: z.string() }),
      output: z.strictObject({ name: z.string() }),
      status: 201,
      permission: "test:write",
      tool: "Writes.",
      writes: true,
    });

    /** A handler that records the name of each call, and answers as `answer` says. */
    function writer(answer: (name: string) => Promise<Answer<{ name: string }>> = (name) => Promise.resolve(ok({ name }))) {
      const calls: string[] = [];
      const handler: Handler = handleData(write, (_call, input) => {
        calls.push(input.body.name);
        return answer(input.body.name);
      });
      return { calls, handler };
    }

    function writing(body: unknown, idempotency: OperationCall["idempotency"] = { key: "k-1" }, query: Record<string, unknown> = {}): OperationCall {
      return { context: CONTEXT, input: { query, body, problems: [] }, idempotency };
    }

    const SETTINGS: TransactionSettings = { companyId: COMPANY, actorId: CONTEXT.actorId, actorKind: "user", channel: "mcp" };
    const HASH = requestHash("testWrite", {}, { name: "Kassa" });
    const OTHER_HASH = requestHash("testWrite", {}, { name: "Bank" });
    const KEY_ID = "f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f";

    function stored(hash: string): QueryResultRow {
      return { request_hash: hash, response_status: 201, response_body: { name: "Kassa" } };
    }

    /** Answers each lookup of a key with the next of `lookups`, and the key's insert with a row, or with none when another stored it first. */
    function keyAnswers(lookups: readonly (readonly QueryResultRow[])[], inserted = true): Answering {
      let lookup = 0;
      return (text) => {
        if (/^SELECT\b[\s\S]*\bFROM ledger\.idempotency_keys\b/.test(text)) {
          lookup += 1;
          return lookups[lookup - 1] ?? [];
        }
        if (text.startsWith("INSERT INTO ledger.idempotency_keys")) {
          return inserted ? [{ id: KEY_ID }] : [];
        }
        throw new Error(`The fake transaction does not know the query ${text}`);
      };
    }

    function isLookup(query: { readonly text: string }): boolean {
      return query.text.startsWith("SELECT");
    }

    function isInsert(query: { readonly text: string }): boolean {
      return query.text.startsWith("INSERT INTO ledger.idempotency_keys");
    }

    /** An error as PostgreSQL gives a refusal of the ledger. */
    function ledgerError(reason: "period_locked_manual" | "actor_missing", facts: Record<string, unknown>): Error {
      return Object.assign(new Error(reason), { code: codeOf(reason), detail: JSON.stringify(facts) });
    }

    const MISSING_KEY: FieldIssue = {
      code: "idempotency-key-missing",
      detail: "The field /idempotencyKey is missing. A write takes an idempotency key.",
      pointer: "/idempotencyKey",
      data: { expected: "string" },
    };

    it("refuses a bad body and a missing key at once: the query's problems, the body's, then the key's", async () => {
      const { database, transactions } = recordingDatabase();
      const { handler, calls } = writer();
      expect(await runOperation(handler, writing({ name: 5, other: true }, { key: undefined }, { x: 1 }), runnerDeps(database))).toEqual({
        ok: false,
        refusal: {
          kind: "invalid",
          problems: [
            { code: "unknown-field", detail: "The field /x is not part of this operation.", pointer: "/x", data: {} },
            { code: "invalid-type", detail: "The field /name must be a string.", pointer: "/name", data: { expected: "string", value: 5 } },
            { code: "unknown-field", detail: "The field /other is not part of this operation.", pointer: "/other", data: {} },
            MISSING_KEY,
          ],
        },
      });
      expect(transactions).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("refuses a write with no key and one with a broken key, with the key's own problem", async () => {
      const { database, transactions } = recordingDatabase();
      const { handler } = writer();
      expect(await runOperation(handler, writing({ name: "Kassa" }, { key: undefined }), runnerDeps(database))).toEqual({
        ok: false,
        refusal: { kind: "invalid", problems: [MISSING_KEY] },
      });
      expect(await runOperation(handler, writing({ name: "Kassa" }, { key: "two words" }), runnerDeps(database))).toEqual({
        ok: false,
        refusal: {
          kind: "invalid",
          problems: [
            {
              code: "idempotency-key-invalid",
              detail: 'The field /idempotencyKey must be 1 to 255 characters of visible ASCII without " and \\.',
              pointer: "/idempotencyKey",
              data: { expected: "string", value: "two words" },
            },
          ],
        },
      });
      expect(transactions).toEqual([]);
    });

    it("with the key policy none, runs the handler in one write transaction on every call, and neither needs nor stores a key", async () => {
      const { database, transactions, queries } = recordingDatabase();
      const { handler, calls } = writer();
      const none: OperationCall = { context: CONTEXT, input: { query: {}, body: { name: "Kassa" } }, idempotency: "none" };
      const deps = runnerDeps(database);
      expect(await runOperation(handler, none, deps)).toEqual({ ok: true, status: 201, output: { name: "Kassa" } });
      expect(await runOperation(handler, none, deps)).toEqual({ ok: true, status: 201, output: { name: "Kassa" } });
      expect(calls).toEqual(["Kassa", "Kassa"]);
      expect(transactions).toEqual([
        { mode: "write", settings: SETTINGS, ended: "commit" },
        { mode: "write", settings: SETTINGS, ended: "commit" },
      ]);
      expect(queries).toEqual([]);
    });

    it("ignores the key policy of a read", async () => {
      const { database, transactions } = recordingDatabase();
      const handler = handleData(getCompany, () => Promise.resolve(ok(COMPANY_ROW)));
      const outcome = await runOperation(handler, { ...call(CONTEXT), idempotency: { key: undefined } }, runnerDeps(database));
      expect(outcome).toEqual({ ok: true, status: 200, output: COMPANY_ROW });
      expect(transactions.map((transaction) => transaction.mode)).toEqual(["read"]);
    });

    it("looks up the key, runs the handler, then stores the key with the request's fingerprint and the checked answer, and commits", async () => {
      const { database, transactions, queries } = recordingDatabase(keyAnswers([[]]));
      const { handler, calls } = writer();
      expect(await runOperation(handler, writing({ name: "Kassa" }), runnerDeps(database))).toEqual({ ok: true, status: 201, output: { name: "Kassa" } });
      expect(calls).toEqual(["Kassa"]);
      expect(transactions).toEqual([{ mode: "write", settings: SETTINGS, ended: "commit" }]);
      expect(queries.map((query) => [isLookup(query), isInsert(query), query.transaction])).toEqual([
        [true, false, 0],
        [false, true, 0],
      ]);
      expect(queries[0]?.values).toEqual([CONTEXT.actorId, "k-1"]);
      expect(queries[1]?.values).toEqual([COMPANY, "k-1", "testWrite", HASH, 201, '{"name":"Kassa"}']);
    });

    it("replays the stored answer of the same request, and rolls back without running the handler", async () => {
      const { database, transactions, queries } = recordingDatabase(keyAnswers([[stored(HASH)]]));
      const { handler, calls } = writer();
      expect(await runOperation(handler, writing({ name: "Kassa" }), runnerDeps(database))).toEqual({ ok: true, status: 201, output: { name: "Kassa" } });
      expect(calls).toEqual([]);
      expect(transactions).toEqual([{ mode: "write", settings: SETTINGS, ended: "rollback" }]);
      expect(queries.filter(isInsert)).toEqual([]);
    });

    it("refuses a key whose stored request is another with idempotency-key-reused, and rolls back without running the handler", async () => {
      const { database, transactions } = recordingDatabase(keyAnswers([[stored(OTHER_HASH)]]));
      const { handler, calls } = writer();
      expect(await runOperation(handler, writing({ name: "Kassa" }), runnerDeps(database))).toEqual({
        ok: false,
        refusal: { kind: "idempotency-key-reused" },
      });
      expect(calls).toEqual([]);
      expect(transactions.map((transaction) => transaction.ended)).toEqual(["rollback"]);
    });

    it("stores no key for a handler's refusal, and rolls back", async () => {
      const { database, transactions, queries } = recordingDatabase(keyAnswers([[]]));
      const refusal = { code: "name-taken", detail: "The name is taken.", pointer: "/name" };
      const { handler } = writer(() => Promise.resolve(refused(refusal)));
      expect(await runOperation(handler, writing({ name: "Kassa" }), runnerDeps(database))).toEqual({ ok: false, refusal: { kind: "rule", refusal } });
      expect(transactions.map((transaction) => transaction.ended)).toEqual(["rollback"]);
      expect(queries.filter(isInsert)).toEqual([]);
    });

    it("checks the output before it stores the key: one that does not fit throws, and nothing is stored or committed", async () => {
      const { database, transactions, queries } = recordingDatabase(keyAnswers([[]]));
      const { handler } = writer(() => Promise.resolve(ok({ name: 5 } as unknown as { name: string })));
      await expect(runOperation(handler, writing({ name: "Kassa" }), runnerDeps(database))).rejects.toThrow("The output of testWrite does not fit its schema: /name");
      expect(transactions.map((transaction) => transaction.ended)).toEqual(["throw"]);
      expect(queries.filter(isInsert)).toEqual([]);
    });

    it("answers a ledger rule that the write meets with 422 and its facts in camelCase, with a key and without", async () => {
      const facts = {
        end_date: "2090-06-30",
        source: "all",
        user_id: null,
        set_by: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
        set_by_kind: "user",
        set_at: "2090-01-02T10:11:12.123456+00:00",
      };
      const rule = {
        kind: "rule",
        refusal: {
          code: "period-locked-manual",
          detail: "The date is in a locked period.",
          data: {
            endDate: "2090-06-30",
            source: "all",
            userId: null,
            setBy: "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
            setByKind: "user",
            setAt: "2090-01-02T10:11:12.123456+00:00",
          },
        },
      };
      const { database, transactions, queries } = recordingDatabase(keyAnswers([[]]));
      const { handler } = writer(() => Promise.reject(ledgerError("period_locked_manual", facts)));
      expect(await runOperation(handler, writing({ name: "Kassa" }), runnerDeps(database))).toEqual({ ok: false, refusal: rule });
      const none: OperationCall = { context: CONTEXT, input: { query: {}, body: { name: "Kassa" } }, idempotency: "none" };
      expect(await runOperation(handler, none, runnerDeps(database))).toEqual({ ok: false, refusal: rule });
      expect(transactions.map((transaction) => transaction.ended)).toEqual(["throw", "throw"]);
      expect(queries.filter(isInsert)).toEqual([]);
    });

    it("throws a ledger reason that is a fault of the server, and any other error", async () => {
      const fault = ledgerError("actor_missing", { setting: "nortfox.actor_id" });
      const { database } = recordingDatabase(keyAnswers([[]]));
      await expect(runOperation(writer(() => Promise.reject(fault)).handler, writing({ name: "Kassa" }), runnerDeps(database))).rejects.toBe(fault);
      const other = Object.assign(new Error("duplicate key value"), { code: "23505" });
      await expect(runOperation(writer(() => Promise.reject(other)).handler, writing({ name: "Kassa" }), runnerDeps(database))).rejects.toBe(other);
    });

    it("refuses a call whose key a running call of the actor holds with 409, before it asks the database", async () => {
      const { database, transactions } = recordingDatabase(keyAnswers([[]]));
      const { handler, calls } = writer();
      const deps = runnerDeps(database);
      const release = deps.keysInFlight.claim(COMPANY, CONTEXT.actorId, "k-1");
      expect(await runOperation(handler, writing({ name: "Kassa" }), deps)).toEqual({ ok: false, refusal: { kind: "idempotency-key-in-use" } });
      expect(transactions).toEqual([]);
      expect(calls).toEqual([]);
      release?.();
      expect(await runOperation(handler, writing({ name: "Kassa" }), deps)).toEqual({ ok: true, status: 201, output: { name: "Kassa" } });
    });

    it("lets the key go when the call ends: after its answer, its refusal and its throw", async () => {
      const { database } = recordingDatabase(keyAnswers([]));
      const deps = runnerDeps(database);
      const answers = [
        () => Promise.resolve(ok({ name: "Kassa" })),
        () => Promise.resolve(refused({ code: "name-taken", detail: "The name is taken." })),
        () => Promise.reject(new Error("The handler failed.")),
      ];
      for (const answer of answers) {
        await runOperation(writer(answer).handler, writing({ name: "Kassa" }), deps).catch(() => undefined);
        const held = deps.keysInFlight.claim(COMPANY, CONTEXT.actorId, "k-1");
        expect(held).toBeTypeOf("function");
        held?.();
      }
    });

    it("rolls back its own write when another process stored the key first, and replays that key in a new transaction", async () => {
      const { database, transactions, queries } = recordingDatabase(keyAnswers([[], [stored(HASH)]], false));
      const { handler, calls } = writer();
      expect(await runOperation(handler, writing({ name: "Kassa" }), runnerDeps(database))).toEqual({ ok: true, status: 201, output: { name: "Kassa" } });
      expect(calls).toEqual(["Kassa"]);
      expect(transactions).toEqual([
        { mode: "write", settings: SETTINGS, ended: "rollback" },
        { mode: "read", settings: SETTINGS, ended: "commit" },
      ]);
      expect(queries.map((query) => [isLookup(query), query.transaction])).toEqual([
        [true, 0],
        [false, 0],
        [true, 1],
      ]);
    });

    it("refuses with idempotency-key-reused when the key that another process stored first is for another request", async () => {
      const { database } = recordingDatabase(keyAnswers([[], [stored(OTHER_HASH)]], false));
      expect(await runOperation(writer().handler, writing({ name: "Kassa" }), runnerDeps(database))).toEqual({
        ok: false,
        refusal: { kind: "idempotency-key-reused" },
      });
    });

    it("throws when the key it could not store is not there either", async () => {
      const { database } = recordingDatabase(keyAnswers([[], []], false));
      await expect(runOperation(writer().handler, writing({ name: "Kassa" }), runnerDeps(database))).rejects.toThrow(
        "Another transaction stored the idempotency key k-1 first, and it is not there.",
      );
    });
  });
});
