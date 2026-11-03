// SPDX-License-Identifier: AGPL-3.0-only

// The /v1 surface without a database: what it refuses before an operation
// reads data. Each field problem points into the operation's flat input, so a
// query parameter is at /<name>. Names are case-sensitive, and so are paths.

import { defineOperation } from "@nortfox/contract";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TEST_REGISTRY, bearer, buildTestApp, principalOf, problemIn, testHandlers, testResolver, untouchedDatabase } from "../../test/api.ts";
import type { Database } from "../db/database.ts";
import { handleData, ok } from "./operation.ts";

const COMPANY = randomUUID();
const TOKENS = { reader: principalOf(COMPANY) };

afterEach(() => {
  vi.restoreAllMocks();
});

function app(database: Database = untouchedDatabase(), report: (error: unknown) => void = () => undefined) {
  return buildTestApp({ database, resolve: testResolver(TOKENS), report }).hono;
}

/** The field problems of a 400 answer, after checking its frame. */
async function fieldProblems(response: Response): Promise<unknown> {
  expect(response.status).toBe(400);
  const problem = await problemIn(response);
  expect(problem).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400, code: "invalid-request" });
  return problem.errors;
}

describe("the query", () => {
  it("refuses an unknown parameter and names it: names are case-sensitive", async () => {
    const database = untouchedDatabase();
    const response = await app(database).request("/v1/test-accounts?Limit=5", { headers: bearer("reader") });
    expect(await fieldProblems(response)).toEqual([
      { code: "unknown-parameter", detail: "The field /Limit is not part of this operation.", pointer: "/Limit" },
    ]);
    expect(database.asked).toEqual([]);
  });

  it("refuses every parameter of an operation that takes none", async () => {
    const response = await app().request("/v1/company?limit=5", { headers: bearer("reader") });
    expect(await fieldProblems(response)).toEqual([
      { code: "unknown-parameter", detail: "The field /limit is not part of this operation.", pointer: "/limit" },
    ]);
  });

  it("refuses a parameter given twice", async () => {
    const response = await app().request("/v1/test-accounts?limit=5&limit=6", { headers: bearer("reader") });
    expect(await fieldProblems(response)).toEqual([
      { code: "repeated-parameter", detail: "The field /limit is given more than once.", pointer: "/limit" },
    ]);
  });

  it("points a limit that is not a number to /limit, with invalid-type and the type it takes", async () => {
    for (const limit of ["abc", "1e3", "", "0x10", "1,5", " 1"]) {
      const response = await app().request(`/v1/test-accounts?limit=${encodeURIComponent(limit)}`, { headers: bearer("reader") });
      expect(await fieldProblems(response), limit).toEqual([
        { code: "invalid-type", detail: "The field /limit must be a number.", pointer: "/limit", data: { expected: "number" } },
      ]);
    }
  });

  it("points a limit that is not a whole number to /limit, with not-an-integer", async () => {
    for (const limit of ["1.5", "-0.5", "100.01"]) {
      const response = await app().request(`/v1/test-accounts?limit=${limit}`, { headers: bearer("reader") });
      expect(await fieldProblems(response), limit).toEqual([
        { code: "not-an-integer", detail: "The field /limit must be a whole number.", pointer: "/limit", data: { expected: "integer" } },
      ]);
    }
  });

  it("refuses a cursor it did not make, at /cursor", async () => {
    const response = await app().request("/v1/test-accounts?cursor=abc.def", { headers: bearer("reader") });
    expect(await fieldProblems(response)).toEqual([
      {
        code: "cursor-invalid",
        detail: "The field /cursor is not a cursor that this server made for this list. Start the list again without it.",
        pointer: "/cursor",
      },
    ]);
  });

  it("gives every problem in one answer: the reader's in the query's order, then the schema's", async () => {
    const response = await app().request("/v1/test-accounts?Limit=1&limit=abc&x=1&x=2", { headers: bearer("reader") });
    expect(await fieldProblems(response)).toEqual([
      { code: "unknown-parameter", detail: "The field /Limit is not part of this operation.", pointer: "/Limit" },
      { code: "unknown-parameter", detail: "The field /x is not part of this operation.", pointer: "/x" },
      { code: "invalid-type", detail: "The field /limit must be a number.", pointer: "/limit", data: { expected: "number" } },
    ]);
  });

  it("decodes a parameter's name, and escapes ~ and / in its pointer", async () => {
    const response = await app().request("/v1/test-accounts?%4Cimit=1&a~b%2Fc=1", { headers: bearer("reader") });
    expect(await fieldProblems(response)).toEqual([
      { code: "unknown-parameter", detail: "The field /Limit is not part of this operation.", pointer: "/Limit" },
      { code: "unknown-parameter", detail: "The field /a~0b~1c is not part of this operation.", pointer: "/a~0b~1c" },
    ]);
  });
});

describe("the paths and the methods", () => {
  it.each(["/v1/Company", "/v1/company/", "/V1/company", "/v1/companies", "/v1", "/"])("answers %s with 404 not-found", async (path) => {
    const response = await app().request(path, { headers: bearer("reader") });
    expect(response.status).toBe(404);
    expect(await problemIn(response)).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "No operation has this path. Paths are case-sensitive and have no trailing slash.",
      code: "not-found",
    });
  });

  it.each([
    ["POST", "/v1/company", "GET, HEAD"],
    ["PUT", "/v1/health", "GET, HEAD"],
    ["DELETE", "/v1/test-accounts", "GET, HEAD"],
    ["OPTIONS", "/v1/company", "GET, HEAD"],
  ])("answers %s %s with 405 method-not-allowed and Allow: %s", async (method, path, allow) => {
    const database = untouchedDatabase();
    const response = await app(database).request(path, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow);
    expect(await problemIn(response)).toEqual({
      type: "about:blank",
      title: "Method Not Allowed",
      status: 405,
      detail: `The path takes only ${allow}.`,
      code: "method-not-allowed",
    });
    expect(database.asked).toEqual([]);
  });

  it("names every method of a path in Allow", async () => {
    const write = defineOperation({
      id: "testAddAccount",
      method: "post",
      path: "/v1/test-accounts",
      tags: ["test"],
      summary: "Add an account",
      description: "Adds an account. Only the tests serve it.",
      body: z.strictObject({ number: z.int() }),
      output: z.strictObject({ number: z.int() }),
      permission: "test:write",
      tool: "Adds an account. Only the tests serve it.",
      writes: true,
    });
    const handler = handleData(write, (_call, input) => Promise.resolve(ok({ number: input.body.number })));
    const { hono } = buildTestApp({
      database: untouchedDatabase(),
      resolve: testResolver(TOKENS),
      registry: [...TEST_REGISTRY, write],
      handlers: [...testHandlers(), handler],
    });
    const response = await hono.request("/v1/test-accounts", { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
  });

  it("answers HEAD as GET, with no body", async () => {
    const response = await app().request("/v1/health", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("answers a success with plain JSON", async () => {
    const response = await app().request("/v1/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ status: "ok", version: "0.0.0-test" });
  });
});

describe("an error the server did not expect", () => {
  const SECRET = "the secret detail of the failure";

  function failing(error: Error): Database {
    return { read: () => Promise.reject(error), write: () => Promise.reject(error), end: () => Promise.resolve() };
  }

  const INTERNAL = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    detail: "The server failed. The answer holds no detail of the error, and the server has logged it.",
    code: "internal-error",
  };

  it.each([new Error(SECRET), Object.assign(new Error(SECRET), { code: "XX000", detail: SECRET, where: SECRET })])(
    "answers 500 with no detail of the error %#, and reports it",
    async (thrown) => {
      const reported: unknown[] = [];
      const response = await app(failing(thrown), (error) => reported.push(error)).request("/v1/company", { headers: bearer("reader") });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("secret");
      expect(text).not.toContain("XX000");
      expect(JSON.parse(text)).toEqual(INTERNAL);
      expect(reported).toEqual([thrown]);
    },
  );

  it("answers 500 when the resolver fails", async () => {
    const reported: unknown[] = [];
    const resolve = () => Promise.reject(new Error(SECRET));
    const hono = buildTestApp({ database: untouchedDatabase(), resolve, report: (error) => reported.push(error) }).hono;
    const response = await hono.request("/v1/company", { headers: bearer("reader") });
    expect(response.status).toBe(500);
    expect(await problemIn(response)).toEqual(INTERNAL);
    expect(reported).toEqual([new Error(SECRET)]);
  });

  it("answers 500 for an error outside /v1 too", async () => {
    const reported: unknown[] = [];
    const hono = buildTestApp({ database: untouchedDatabase(), resolve: testResolver(TOKENS), report: (error) => reported.push(error) }).hono;
    hono.get("/broken", () => {
      throw new Error(SECRET);
    });
    const response = await hono.request("/broken");
    expect(response.status).toBe(500);
    expect(await problemIn(response)).toEqual(INTERNAL);
    expect(reported).toEqual([new Error(SECRET)]);
  });

  it("reports to console.error unless told otherwise", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hono = buildTestApp({ database: failing(new Error(SECRET)), resolve: testResolver(TOKENS) }).hono;
    const response = await hono.request("/v1/company", { headers: bearer("reader") });
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalledWith("The server failed:", new Error(SECRET));
  });
});
