// SPDX-License-Identifier: AGPL-3.0-only

// The /v1 surface without a database: what it refuses before an operation
// reads data. Each field problem points into the operation's flat input, so a
// query parameter is at /<name>. Names are case-sensitive, and so are paths.

import { defineOperation } from "@nortfox/contract";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FINGERPRINT_KEY, TEST_REGISTRY, bearer, buildTestApp, gate, personOf, principalOf, problemIn, testHandlers, testResolver, untouchedDatabase } from "../../test/api.ts";
import { FAILING_LETTER, SHAPES_REGISTRY, fakeDatabase, shapeLog, shapesHandlers, type FakeDatabase, type ShapeLog } from "../../test/shapes.ts";
import type { Database } from "../db/database.ts";
import { startServer } from "../start.ts";
import { requestHash } from "./idempotency.ts";
import { errorReport } from "./report.ts";
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
    return { read: () => Promise.reject(error), write: () => Promise.reject(error), lookup: () => Promise.reject(error), end: () => Promise.resolve() };
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

  it("reports to console.error unless told otherwise, as the safe report", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error(SECRET);
    const hono = buildTestApp({ database: failing(error), resolve: testResolver(TOKENS) }).hono;
    const response = await hono.request("/v1/company", { headers: bearer("reader") });
    expect(response.status).toBe(500);
    expect(logged.mock.calls).toEqual([[`The server failed: ${errorReport(error)}`]]);
  });
});

describe("the shapes of slice 2c on /v1", () => {
  const THING = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";
  const PERSON = personOf();
  const SHAPE_TOKENS = { reader: principalOf(COMPANY), person: PERSON };

  interface ShapeApp {
    readonly app: ReturnType<typeof buildTestApp>;
    readonly log: ShapeLog;
    readonly database: FakeDatabase;
    readonly reported: unknown[];
  }

  function shapeApp(database: FakeDatabase = fakeDatabase()): ShapeApp {
    const log = shapeLog();
    const reported: unknown[] = [];
    const app = buildTestApp({
      database,
      resolve: testResolver(SHAPE_TOKENS),
      registry: SHAPES_REGISTRY,
      handlers: shapesHandlers(log),
      report: (error) => reported.push(error),
      allowedOrigins: ["https://nortfox.example"],
    });
    return { app, log, database, reported };
  }

  function postJson(app: ShapeApp, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return Promise.resolve(app.app.hono.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  }

  describe("path parameters", () => {
    it("reads a path parameter, and gives it to the handler with the query", async () => {
      const shapes = shapeApp();
      const response = await shapes.app.hono.request(`/v1/test-things/${THING}?view=long`, { headers: bearer("reader") });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: THING, view: "long", companyId: COMPANY });
    });

    it("names a bad path parameter at its pointer in the flat input, after the reader's problems and before the query's, and asks no database", async () => {
      const shapes = shapeApp();
      const response = await shapes.app.hono.request("/v1/test-things/abc?view=wide&x=1", { headers: bearer("reader") });
      expect(await fieldProblems(response)).toEqual([
        { code: "unknown-parameter", detail: "The field /x is not part of this operation.", pointer: "/x" },
        { code: "bad-format", detail: "The field /thingId does not have the format uuid.", pointer: "/thingId", data: { format: "uuid" } },
        { code: "invalid-value", detail: 'The field /view must be one of: "short", "long".', pointer: "/view", data: { allowed: ["short", "long"] } },
      ]);
      expect(shapes.database.transactions).toEqual([]);
    });

    it("names every method of a path with a parameter in Allow", async () => {
      const response = await shapeApp().app.hono.request(`/v1/test-things/${THING}`, { method: "POST" });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD, DELETE");
    });
  });

  describe("the answers", () => {
    it("answers 204 with no body and no Content-Type, and keeps the key of a write with its path in the fingerprint", async () => {
      const shapes = shapeApp();
      const response = await shapes.app.hono.request(`/v1/test-things/${THING}`, { method: "DELETE", headers: { ...bearer("reader"), "idempotency-key": "k-1" } });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("content-type")).toBeNull();
      expect(shapes.database.queries.map((query) => query.values)).toEqual([
        [SHAPE_TOKENS.reader.personId, "k-1"],
        [COMPANY, "k-1", "testRemoveThing", requestHash(FINGERPRINT_KEY, "testRemoveThing", {}, undefined, { thingId: THING }), 204, "{}"],
      ]);
    });

    it("answers 202 with no body before its work after the answer runs, and then runs it", async () => {
      const shapes = shapeApp();
      const held = gate();
      shapes.log.gate = held;
      const response = await postJson(shapes, "/v1/test-letters", { email: "anna@example.com" });
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
      expect(response.headers.get("content-type")).toBeNull();
      expect(shapes.log.letters).toEqual([]);
      await held.reached;
      held.open();
      await shapes.app.afterAnswer.idle();
      expect(shapes.log.letters).toEqual(["anna@example.com"]);
    });

    it("reports work after the answer that fails, when the answer has gone already", async () => {
      const shapes = shapeApp();
      const response = await postJson(shapes, "/v1/test-letters", { email: FAILING_LETTER });
      expect(response.status).toBe(202);
      await shapes.app.afterAnswer.idle();
      expect(shapes.reported).toEqual([new Error("The test made the letter fail after the answer.")]);
    });

    it("answers 303 with the Location header, the same location as JSON, and the login cookie", async () => {
      const shapes = shapeApp();
      const response = await shapes.app.hono.request("/v1/test-redirects?provider=alfa");
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://alfa.example.com/authorize?state=test-state");
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ location: "https://alfa.example.com/authorize?state=test-state" });
      expect(response.headers.getSetCookie()).toEqual(["__Host-nortfox-login=test-login-binding; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax"]);
    });
  });

  describe("an operation that runs before sign-in", () => {
    it("sets the cookies its handler gives, and keeps them out of the body", async () => {
      const shapes = shapeApp();
      const response = await postJson(shapes, "/v1/test-sign-ins", { email: "anna@example.com" }, { origin: "https://nortfox.example" });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ email: "anna@example.com", signedIn: false });
      expect(text).not.toContain("test-session-token");
      expect(response.headers.getSetCookie()).toEqual([
        "__Host-nortfox-session=test-session-token; Path=/; Secure; HttpOnly; SameSite=Strict",
        "__Host-nortfox-device=test-device-token; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Strict",
      ]);
      expect(shapes.log.calls).toEqual([{ operationId: "testSignIn", principal: undefined, request: { origin: "https://nortfox.example" }, now: expect.any(Date) as unknown }]);
    });

    it("gives its handler the principal when the request has a credential", async () => {
      const shapes = shapeApp();
      const response = await postJson(shapes, "/v1/test-sign-ins", { email: "anna@example.com" }, bearer("person"));
      expect(await response.json()).toEqual({ email: "anna@example.com", signedIn: true });
      expect(shapes.log.calls[0]?.principal).toEqual({ ...PERSON, channel: "rest" });
    });

    it("takes no idempotency key: a write without one, and one with a key that is not one, run", async () => {
      const shapes = shapeApp();
      expect((await postJson(shapes, "/v1/test-sign-ins", { email: "anna@example.com" })).status).toBe(200);
      expect((await postJson(shapes, "/v1/test-sign-ins", { email: "anna@example.com" }, { "idempotency-key": "two words" })).status).toBe(200);
      expect(shapes.database.transactions).toEqual([]);
    });

    it("answers its handler's refusal with 422 and sets no cookie", async () => {
      const response = await postJson(shapeApp(), "/v1/test-sign-ins", { email: "nobody@example.com" });
      expect(response.status).toBe(422);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await problemIn(response)).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "The test refused the sign-in.",
        code: "test-sign-in-refused",
        pointer: "/email",
      });
    });

    it("gives its handler the address the request came from, on the real server", async () => {
      const shapes = shapeApp();
      const server = await startServer({ app: shapes.app, port: 0 });
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const sent = httpRequest({ host: "127.0.0.1", port: server.port, path: "/v1/test-sign-ins", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
            response.resume();
            response.on("end", () => {
              resolve(response.statusCode ?? 0);
            });
          });
          sent.on("error", reject);
          sent.end(JSON.stringify({ email: "anna@example.com" }));
        });
        expect(status).toBe(200);
        expect(shapes.log.calls[0]?.request).toEqual({ ipAddress: expect.stringMatching(/^(::ffff:)?127\.0\.0\.1$/) as unknown });
      } finally {
        await server.close();
      }
    });
  });

  describe("a signed-in person's operation", () => {
    it("runs in no company, keeps a write's key per person, and clears the session cookie it ends", async () => {
      const shapes = shapeApp();
      const response = await shapes.app.hono.request("/v1/test-session-ends", { method: "POST", headers: { ...bearer("person"), "idempotency-key": "k-1" } });
      expect(response.status).toBe(204);
      expect(response.headers.getSetCookie()).toEqual(["__Host-nortfox-session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict"]);
      expect(shapes.database.transactions).toEqual([{ mode: "write", settings: { actorId: PERSON.personId, actorKind: "user", channel: "rest" }, ended: "commit" }]);
      expect(shapes.database.queries.map((query) => /(\w+)\.idempotency_keys/.exec(query.text)?.[1])).toEqual(["access", "access"]);
    });

    it("refuses no actor with 401, and a person with no company an operation in a company with 403 company-required", async () => {
      const shapes = shapeApp();
      expect((await shapes.app.hono.request("/v1/test-person")).status).toBe(401);
      expect((await shapes.app.hono.request("/v1/test-person", { headers: bearer("person") })).status).toBe(200);
      const refused = await shapes.app.hono.request("/v1/company", { headers: bearer("person") });
      expect(refused.status).toBe(403);
      expect(await problemIn(refused)).toEqual({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "The operation works in a company, and the request's credential names none. Choose a company first.",
        code: "company-required",
      });
      expect(shapes.database.transactions).toHaveLength(1);
    });
  });

  it("answers every answer with Cache-Control: no-store", async () => {
    const shapes = shapeApp();
    const hono = shapes.app.hono;
    const failing = buildTestApp({ database: {
        read: () => Promise.reject(new Error("down")),
        write: () => Promise.reject(new Error("down")),
        lookup: () => Promise.reject(new Error("down")),
        end: () => Promise.resolve(),
      }, resolve: testResolver(TOKENS), report: () => undefined }).hono;
    const answers: Response[] = [
      await hono.request("/v1/health"),
      await hono.request(`/v1/test-things/${THING}`, { headers: bearer("reader") }),
      await hono.request("/v1/test-things/abc", { headers: bearer("reader") }),
      await hono.request("/v1/nothing-here"),
      await hono.request("/v1/health", { method: "POST" }),
      await hono.request("/v1/company"),
      await hono.request("/v1/company", { headers: bearer("person") }),
      await hono.request(`/v1/test-things/${THING}`, { method: "DELETE", headers: { ...bearer("reader"), "idempotency-key": "k-2" } }),
      await postJson(shapes, "/v1/test-letters", { email: "anna@example.com" }),
      await hono.request("/v1/test-redirects?provider=beta"),
      await postJson(shapes, "/v1/test-sign-ins", { email: "anna@example.com" }),
      await postJson(shapes, "/v1/test-sign-ins", { email: "nobody@example.com" }),
      await failing.request("/v1/company", { headers: bearer("reader") }),
    ];
    expect(answers.map((response) => response.status)).toEqual([200, 200, 400, 404, 405, 401, 403, 204, 202, 303, 200, 422, 500]);
    for (const response of answers) {
      expect(response.headers.get("cache-control"), String(response.status)).toBe("no-store");
    }
    await shapes.app.afterAnswer.idle();
  });
});
