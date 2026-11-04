// SPDX-License-Identifier: AGPL-3.0-only

// The registry guard reads each createRoute object as data. Each bad entry
// here is a good one with one part broken, so each test shows that one check
// fails, and the good ones show that it passes what it should.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Money } from "./money.ts";
import { NoBody, Redirect, defineListOperation, defineOperation, type Operation } from "./operation.ts";
import { registryProblems } from "./registry-guard.ts";

const PERMISSIONS = ["company:read", "test:read", "test:write"];

const readThing = defineOperation({
  id: "getThing",
  method: "get",
  path: "/v1/things",
  tags: ["things"],
  summary: "Read the thing",
  description: "Reads the thing.",
  query: z.strictObject({ name: z.string().optional() }),
  output: z.strictObject({ name: z.string() }),
  permission: "test:read",
  tool: "Reads the thing.",
  writes: false,
});

const bookThing = defineOperation({
  id: "bookThing",
  method: "post",
  path: "/v1/things",
  tags: ["things"],
  summary: "Book a thing",
  description: "Books a thing.",
  body: z.strictObject({ description: z.string(), amount: Money, rows: z.array(z.strictObject({ amount: Money })) }),
  output: z.strictObject({ id: z.uuid() }),
  status: 201,
  permission: "test:write",
  tool: "Books a thing.",
  writes: true,
});

const listThings = defineListOperation({
  id: "listThings",
  method: "get",
  path: "/v1/thing-lists",
  tags: ["things"],
  summary: "List the things",
  description: "Lists the things.",
  item: z.strictObject({ id: z.uuid() }),
  permission: "test:read",
  tool: "Lists the things.",
});

const health = defineOperation({
  id: "getStatus",
  method: "get",
  path: "/v1/status",
  tags: ["status"],
  summary: "Status",
  description: "The status.",
  output: z.strictObject({ ok: z.boolean() }),
  permission: "public",
  tool: "Says whether the server is up.",
  writes: false,
});

const readOne = defineOperation({
  id: "getOneThing",
  method: "get",
  path: "/v1/things/{thingId}/parts/{partId}",
  tags: ["things"],
  summary: "Read one part",
  description: "Reads one part of a thing.",
  params: z.strictObject({ thingId: z.uuid(), partId: z.string().min(1) }),
  query: z.strictObject({ view: z.enum(["short", "long"]).optional() }),
  output: z.strictObject({ name: z.string() }),
  permission: "test:read",
  tool: "Reads one part of a thing.",
  writes: false,
});

const removeOne = defineOperation({
  id: "removeOneThing",
  method: "delete",
  path: "/v1/things/{thingId}",
  tags: ["things"],
  summary: "Remove a thing",
  description: "Removes a thing.",
  params: z.strictObject({ thingId: z.uuid() }),
  output: NoBody,
  status: 204,
  permission: "test:write",
  tool: "Removes a thing.",
  writes: true,
});

const signIn = defineOperation({
  id: "signIn",
  method: "post",
  path: "/v1/sign-ins",
  tags: ["sign-in"],
  summary: "Sign in",
  description: "Signs in.",
  body: z.strictObject({ email: z.string() }),
  output: z.strictObject({ step: z.string() }),
  permission: "none",
  session: "flow",
  tool: "Signs in.",
  writes: true,
});

const sendLetter = defineOperation({
  id: "sendLetter",
  method: "post",
  path: "/v1/letters",
  tags: ["sign-in"],
  summary: "Send a letter",
  description: "Sends a letter after the answer.",
  body: z.strictObject({ email: z.string() }),
  output: NoBody,
  status: 202,
  permission: "none",
  session: "flow",
  tool: "Sends a letter.",
  writes: true,
});

const startRedirect = defineOperation({
  id: "startRedirect",
  method: "get",
  path: "/v1/redirects",
  tags: ["sign-in"],
  summary: "Start a redirect",
  description: "Sends the browser on.",
  query: z.strictObject({ provider: z.string() }),
  output: Redirect,
  status: 303,
  permission: "none",
  session: "flow",
  tool: "Sends the browser on.",
  writes: true,
});

const getPerson = defineOperation({
  id: "getPerson",
  method: "get",
  path: "/v1/person",
  tags: ["person"],
  summary: "Read the person",
  description: "Reads the signed-in person.",
  output: z.strictObject({ name: z.string() }),
  permission: "signed-in",
  tool: "Reads the signed-in person.",
  writes: false,
});

const endSession = defineOperation({
  id: "endSession",
  method: "post",
  path: "/v1/session-ends",
  tags: ["person"],
  summary: "End the session",
  description: "Ends the session.",
  output: NoBody,
  status: 204,
  permission: "signed-in",
  session: "flow",
  tool: "Ends the session.",
  writes: true,
});

const GOOD = [readThing, bookThing, listThings, health, readOne, removeOne, signIn, sendLetter, startRedirect, getPerson, endSession];

/** A copy of an entry with some parts replaced. */
function changed(entry: object, parts: Record<string, unknown>): object {
  return { ...entry, ...parts };
}

/** A copy of an entry without one of its parts. */
function without(entry: object, part: string): object {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== part));
}

/** A copy of an entry with some of its x-nortfox replaced. */
function withMeta(entry: object, meta: Record<string, unknown>): object {
  return changed(entry, { "x-nortfox": { ...(entry as Operation)["x-nortfox"], ...meta } });
}

/** A copy of an entry with some of its request replaced. */
function withRequest(entry: Operation, request: Record<string, unknown>): object {
  return changed(entry, { request: { ...entry.request, ...request } });
}

function jsonBody(schema: z.ZodType): unknown {
  return { required: true, content: { "application/json": { schema } } };
}

function problemsOf(...entries: unknown[]): string[] {
  return registryProblems(entries, PERMISSIONS);
}

describe("registryProblems", () => {
  it("passes good entries: a read, a write with its key, a list, a public read, path parameters, a 204, and the session's operations", () => {
    expect(problemsOf(...GOOD)).toEqual([]);
  });

  it("passes an empty registry", () => {
    expect(problemsOf()).toEqual([]);
  });

  describe("the done-when cases", () => {
    it.each([undefined, "", "   "])("fails an entry with no permission: %j", (permission) => {
      expect(problemsOf(withMeta(readThing, { permission }))).toEqual([
        'getThing has no permission. An operation that reads no data says "public".',
      ]);
    });

    it.each([undefined, "", "  \n "])("fails an entry with no MCP tool text: %j", (tool) => {
      expect(problemsOf(withMeta(readThing, { tool }))).toEqual(["getThing has no MCP tool text."]);
    });

    it("fails a write that takes no Idempotency-Key header", () => {
      const request = without(bookThing.request, "headers");
      expect(problemsOf(changed(bookThing, { request }))).toEqual([
        "bookThing writes, but takes no required Idempotency-Key header.",
      ]);
    });

    it("fails a write whose Idempotency-Key header is optional", () => {
      expect(problemsOf(withRequest(bookThing, { headers: z.object({ "Idempotency-Key": z.string().optional() }) }))).toEqual([
        "bookThing writes, but takes no required Idempotency-Key header.",
      ]);
    });

    it("fails a write whose headers are not one object schema", () => {
      expect(problemsOf(withRequest(bookThing, { headers: [z.string()] }))).toEqual([
        "bookThing writes, but takes no required Idempotency-Key header.",
      ]);
    });
  });

  it("fails an entry that declares nothing", () => {
    const bare = without(readThing, "x-nortfox");
    expect(problemsOf(bare)).toEqual([
      "getThing declares no x-nortfox: its permission, MCP tool text, assistant flag, writes flag, list flag, session mark and company source.",
    ]);
    expect(problemsOf(changed(readThing, { "x-nortfox": "company:read" }))).toEqual([
      "getThing declares no x-nortfox: its permission, MCP tool text, assistant flag, writes flag, list flag, session mark and company source.",
    ]);
  });

  describe("the marks of part 1", () => {
    it.each(["scope", "personalOutput", "Session", ""])("fails a mark the registry does not know: %j", (mark) => {
      expect(problemsOf(withMeta(readThing, { [mark]: null }))).toEqual([
        `getThing has the mark ${JSON.stringify(mark)} in x-nortfox, which the registry does not know.`,
      ]);
    });

    it.each(["only", "Flow", "", undefined, false])("fails the session mark %j", (session) => {
      expect(problemsOf(withMeta(readThing, { session }))).toEqual([
        `getThing has the session mark ${session === undefined ? "undefined" : JSON.stringify(session)}. It is "flow" or null.`,
      ]);
    });

    it.each(["current", "new", { input: "companyId" }, "", undefined])("fails the company source %j", (company) => {
      expect(problemsOf(withMeta(readThing, { company }))).toEqual([
        `getThing has the company source ${company === undefined ? "undefined" : JSON.stringify(company)}. It is "none" or "credential".`,
      ]);
    });

    it("fails a write that runs before sign-in and takes a key, required or not", () => {
      for (const headers of [bookThing.request.headers, z.object({ "Idempotency-Key": z.string().optional() })]) {
        expect(problemsOf(withRequest(signIn, { headers }))).toEqual([
          "signIn runs before sign-in, so it takes no idempotency key, but it declares the Idempotency-Key header.",
        ]);
      }
    });

    it("fails a signed-in write without a key, as a write with a permission", () => {
      expect(problemsOf(changed(endSession, { request: {} }))).toEqual(["endSession writes, but takes no required Idempotency-Key header."]);
    });

    it("fails an operation that runs before sign-in and does not serve the browser's session", () => {
      expect(problemsOf(withMeta(signIn, { session: null }))).toEqual([
        'signIn runs before sign-in, so it serves the browser\'s session: its session mark must be "flow".',
      ]);
    });

    it.each(["test:read", "public"])("fails an operation of the browser's session whose permission is %j", (permission) => {
      const entry = withMeta(readThing, { session: "flow", permission, company: permission === "public" ? "none" : "credential" });
      expect(problemsOf(entry)).toEqual([
        `getThing serves the browser's session, so its permission is "none" or "signed-in", not ${JSON.stringify(permission)}.`,
      ]);
    });

    it.each(["public", "none", "signed-in"])("fails the company source credential on an operation whose permission is %j", (permission) => {
      const entry = withMeta(permission === "public" ? health : permission === "none" ? signIn : getPerson, { company: "credential" });
      const name = permission === "public" ? "getStatus" : permission === "none" ? "signIn" : "getPerson";
      expect(problemsOf(entry)).toEqual([
        `${name} takes its company from the credential, which only an operation that needs a permission does.`,
      ]);
    });

    it("fails the company source none on an operation that needs a permission", () => {
      expect(problemsOf(withMeta(readThing, { company: "none" }))).toEqual([
        'getThing needs the permission "test:read", so it takes its company from the credential, not "none".',
      ]);
    });
  });

  describe("the credential in security", () => {
    const SESSION = '[{"sessionCookie":[]}]';

    it.each([
      ["none", undefined],
      ["an empty list", []],
      ["another scheme", [{ bearer: [] }]],
      ["the session with a scope", [{ sessionCookie: ["read"] }]],
      ["the session twice", [{ sessionCookie: [] }, { sessionCookie: [] }]],
      ["the session and another scheme at once", [{ sessionCookie: [], bearer: [] }]],
      ["the session as an object, not a list", { sessionCookie: [] }],
    ])("fails an operation that needs an actor and names %s", (_what, security) => {
      for (const [entry, name] of [
        [readThing, "getThing"],
        [bookThing, "bookThing"],
        [getPerson, "getPerson"],
        [endSession, "endSession"],
      ] as const) {
        const bad = security === undefined ? without(entry, "security") : changed(entry, { security });
        expect(problemsOf(bad)).toEqual([`${name} needs an actor, so its security is ${SESSION}, not ${security === undefined ? "undefined" : JSON.stringify(security)}.`]);
      }
    });

    it.each([
      ["the session", [{ sessionCookie: [] }]],
      ["an empty list", []],
      ["another scheme", [{ bearer: [] }]],
    ])("fails an operation that needs no actor and names %s", (_what, security) => {
      for (const [entry, name] of [
        [health, "getStatus"],
        [signIn, "signIn"],
        [startRedirect, "startRedirect"],
      ] as const) {
        expect(problemsOf(changed(entry, { security }))).toEqual([`${name} needs no actor, so it has no security, not ${JSON.stringify(security)}.`]);
      }
    });

    it("reads the credential only once the marks are right, so a wrong mark gives one problem", () => {
      expect(problemsOf(withMeta(readThing, { permission: "company:delete" }))).toEqual([
        'getThing needs the permission "company:delete", which is not on the list.',
      ]);
      expect(problemsOf(withMeta(bookThing, { permission: "public", company: "none" }))).toEqual([
        "bookThing is public and writes. A public operation reads and writes no data.",
      ]);
    });
  });

  describe("path parameters", () => {
    it("fails a {name} in the path without its parameter, and a parameter that the path does not name", () => {
      expect(problemsOf(changed(removeOne, { path: "/v1/things/{otherId}" }))).toEqual([
        "removeOneThing's path names {otherId}, but it takes no parameter otherId.",
        "removeOneThing takes the parameter thingId, which its path does not name.",
      ]);
      expect(problemsOf(changed(readThing, { path: "/v1/things/{id}" }))).toEqual(["getThing's path names {id}, but it takes no parameter id."]);
      expect(problemsOf(changed(removeOne, { path: "/v1/things" }))).toEqual(["removeOneThing takes the parameter thingId, which its path does not name."]);
    });

    it("fails a path that names a parameter twice", () => {
      const params = z.strictObject({ thingId: z.uuid() });
      expect(problemsOf(changed(withRequest(readThing, { params }), { path: "/v1/things/{thingId}/parts/{thingId}" }))).toEqual([
        "getThing's path names {thingId} twice.",
      ]);
    });

    it("fails a parameter name that the query, the body or the key also has", () => {
      expect(problemsOf(withRequest(readOne, { query: z.strictObject({ thingId: z.string().optional() }) }))).toEqual([
        'getOneThing: the path and the query both have a field "thingId".',
      ]);
      expect(problemsOf(withRequest(removeOne, { body: jsonBody(z.strictObject({ thingId: z.string() })) }))).toEqual([
        'removeOneThing: the path and the body both have a field "thingId".',
      ]);
      const keyed = changed(withRequest(removeOne, { params: z.strictObject({ idempotencyKey: z.string() }) }), { path: "/v1/things/{idempotencyKey}" });
      expect(problemsOf(keyed)).toEqual(['removeOneThing has a field "idempotencyKey", the name of a write\'s key on MCP.']);
    });

    it.each([
      ["a loose object", z.object({ thingId: z.string() })],
      ["a number", z.strictObject({ thingId: z.int() })],
      ["an optional string", z.strictObject({ thingId: z.string().optional() })],
      ["a string or nothing", z.strictObject({ thingId: z.string().nullable() })],
      ["not an object", z.string()],
    ])("fails path parameters that are %s, not a strict object of required strings", (_what, params) => {
      expect(problemsOf(withRequest(removeOne, { params }))).toEqual([
        "removeOneThing: its path parameters must be a strict object of required strings.",
      ]);
    });

    it.each([
      "/v1/{thingId}",
      "/v1/things/{ThingId}",
      "/v1/things/{}",
      "/v1/things/{thing-id}",
      "/v1/things/{thingId}{partId}",
      "/v1/things/x{thingId}",
      "/v1/things/{thingId}/",
      "/v1/things/:thingId",
    ])("fails the path %j", (path) => {
      expect(problemsOf(changed(removeOne, { path }))[0]).toBe(
        `removeOneThing has the path ${JSON.stringify(path)}. A path is /v1/ and a lower-case kebab-case word, then more such words or {parameter} segments, with no trailing slash.`,
      );
    });

    it("fails two operations of one method whose paths can match the same path", () => {
      const latest = changed(readThing, { operationId: "getLatestThing", path: "/v1/things/latest/parts/first" });
      expect(problemsOf(readOne, latest)).toEqual([
        "Two operations can answer the same path: GET /v1/things/{thingId}/parts/{partId} and GET /v1/things/latest/parts/first.",
      ]);
      const renamed = changed(withRequest(readOne, { params: z.strictObject({ id: z.uuid(), partId: z.string() }) }), {
        operationId: "getOtherPart",
        path: "/v1/things/{id}/parts/{partId}",
      });
      expect(problemsOf(readOne, renamed)).toEqual([
        "Two operations can answer the same path: GET /v1/things/{thingId}/parts/{partId} and GET /v1/things/{id}/parts/{partId}.",
      ]);
      // Another method, another length or another word is another route.
      expect(problemsOf(readOne, removeOne, changed(readThing, { operationId: "getAll", path: "/v1/things/latest" }))).toEqual([]);
      expect(problemsOf(readOne, changed(readThing, { operationId: "getOtherPart", path: "/v1/things/latest/pieces/first" }))).toEqual([]);
    });
  });

  describe("the answers", () => {
    it("fails a 204 or a 202 that declares a body", () => {
      const json = { "application/json": { schema: z.strictObject({}) } };
      expect(problemsOf(changed(endSession, { responses: { 204: { description: "Done.", content: json } } }))).toEqual([
        "endSession answers 204, which has no body, but it declares one.",
      ]);
      expect(problemsOf(changed(sendLetter, { responses: { 202: { description: "Accepted.", content: json } } }))).toEqual([
        "sendLetter answers 202, which has no body, but it declares one.",
      ]);
    });

    it("fails a 303 on anything but a GET that runs before sign-in", () => {
      expect(problemsOf(changed(startRedirect, { method: "post" }))).toEqual([
        "startRedirect answers 303, which only a GET operation that runs before sign-in may do.",
      ]);
      const signedIn = changed(startRedirect, { request: { ...startRedirect.request, headers: bookThing.request.headers }, security: getPerson.security });
      expect(problemsOf(withMeta(signedIn, { permission: "signed-in" }))).toEqual([
        "startRedirect answers 303, which only a GET operation that runs before sign-in may do.",
      ]);
    });

    it("fails a 303 whose output is not the location alone, and one without a Location header", () => {
      const redirect = startRedirect.responses[303] ?? {};
      const extra = { ...redirect, content: { "application/json": { schema: z.strictObject({ location: z.string(), state: z.string() }) } } };
      expect(problemsOf(changed(startRedirect, { responses: { 303: extra } }))).toEqual([
        "startRedirect answers 303, so its output is the location alone, a string.",
      ]);
      const numbered = { ...redirect, content: { "application/json": { schema: z.strictObject({ location: z.int() }) } } };
      expect(problemsOf(changed(startRedirect, { responses: { 303: numbered } }))).toEqual([
        "startRedirect answers 303, so its output is the location alone, a string.",
      ]);
      expect(problemsOf(changed(startRedirect, { responses: { 303: without(redirect, "headers") } }))).toEqual([
        "startRedirect answers 303 without a Location header.",
      ]);
    });

    it("fails a GET that writes without answering 303", () => {
      const responses = { 200: { description: "Started.", content: { "application/json": { schema: z.strictObject({ step: z.string() }) } } } };
      expect(problemsOf(changed(startRedirect, { responses }))).toEqual([
        "startRedirect is a GET that writes. Only a GET that runs before sign-in and answers 303 may write.",
      ]);
      expect(problemsOf(withMeta(readThing, { writes: true }))).toEqual([
        "getThing writes, but takes no required Idempotency-Key header.",
        "getThing is a GET that writes. Only a GET that runs before sign-in and answers 303 may write.",
      ]);
    });

    it("fails an entry with two success answers, and one with a success that the registry does not know", () => {
      const json = { "application/json": { schema: z.strictObject({ name: z.string() }) } };
      expect(problemsOf(changed(readThing, { responses: { 200: { description: "A.", content: json }, 201: { description: "B.", content: json } } }))).toEqual([
        "getThing has more than one success answer: 200, 201.",
      ]);
      for (const status of ["206", "302", "304", "299"]) {
        expect(problemsOf(changed(readThing, { responses: { [status]: { description: "A.", content: json } } }))).toEqual([
          `getThing answers ${status}. A success is 200 or 201 with JSON, 202 or 204 with no body, or 303.`,
        ]);
      }
    });
  });

  it.each([
    [{ writes: undefined }],
    [{ assistant: "no" }],
    [{ list: 1 }],
  ])("fails an entry whose flags are not true or false: %j", (meta) => {
    expect(problemsOf(withMeta(readThing, meta))).toEqual([
      "getThing must say whether it writes, whether it is a list and whether the assistant may call it, each true or false.",
    ]);
  });

  it("fails a permission that is not on the list", () => {
    expect(problemsOf(withMeta(readThing, { permission: "company:delete" }))).toEqual([
      'getThing needs the permission "company:delete", which is not on the list.',
    ]);
    expect(problemsOf(withMeta(readThing, { permission: 7 }))).toEqual([
      'getThing has no permission. An operation that reads no data says "public".',
    ]);
  });

  it("fails a public operation that writes", () => {
    expect(problemsOf(withMeta(bookThing, { permission: "public", company: "none" }))).toEqual([
      "bookThing is public and writes. A public operation reads and writes no data.",
    ]);
  });

  it.each(["/v2/things", "/things", "/v1/Things", "/v1/things/", "/v1", "/v1/", "/v1//things", "/v1/things_all", "/v1/-things", undefined])(
    "fails the path %j",
    (path) => {
      expect(problemsOf(changed(readThing, { path }))).toEqual([
        `getThing has the path ${path === undefined ? "undefined" : JSON.stringify(path)}. A path is /v1/ and a lower-case kebab-case word, then more such words or {parameter} segments, with no trailing slash.`,
      ]);
    },
  );

  it("takes a path of several kebab-case words", () => {
    expect(problemsOf(changed(readThing, { path: "/v1/voucher-series/open-years" }))).toEqual([]);
  });

  it.each(["head", "options", "GET", "trace", undefined])("fails the method %j", (method) => {
    expect(problemsOf(changed(readThing, { method }))).toEqual([
      `getThing has the method ${JSON.stringify(method)}. An operation uses get, post, put, patch or delete.`,
    ]);
  });

  it.each(["GetThing", "get_thing", "get-thing", "", "1get", `g${"x".repeat(64)}`])("fails the id %j", (operationId) => {
    expect(problemsOf(changed(readThing, { operationId }))).toEqual([
      `The operation id ${JSON.stringify(operationId)} is not a camelCase tool name of at most 64 letters and digits.`,
    ]);
  });

  it("names an entry without an id by its place", () => {
    const anonymous = without(withMeta(readThing, { tool: "" }), "operationId");
    expect(problemsOf(health, anonymous)).toEqual([
      "The operation id undefined is not a camelCase tool name of at most 64 letters and digits.",
      "entry 1 has no MCP tool text.",
    ]);
  });

  it("fails two entries with one id, and two with one method and path", () => {
    expect(problemsOf(readThing, changed(readThing, { path: "/v1/other-things" }))).toEqual([
      'Two operations have the id "getThing".',
    ]);
    expect(problemsOf(readThing, changed(readThing, { operationId: "getOtherThing" }))).toEqual([
      "Two operations have the route GET /v1/things.",
    ]);
  });

  describe("strictness", () => {
    it("fails a query that lets unknown fields through", () => {
      expect(problemsOf(withRequest(readThing, { query: z.object({ name: z.string() }) }))).toEqual([
        "getThing: its query must be a strict object, and so must every object in it.",
      ]);
      expect(problemsOf(withRequest(readThing, { query: z.looseObject({ name: z.string() }) }))).toEqual([
        "getThing: its query must be a strict object, and so must every object in it.",
      ]);
      expect(problemsOf(withRequest(readThing, { query: z.string() }))).toEqual([
        "getThing: its query must be a strict object, and so must every object in it.",
      ]);
    });

    it.each([
      ["a nested object", z.strictObject({ inner: z.object({ a: z.string() }) })],
      ["an object in a list", z.strictObject({ rows: z.array(z.object({ a: z.string() })) })],
      ["an object in a union", z.strictObject({ either: z.union([z.string(), z.object({ a: z.string() })]) })],
      ["a map of any keys", z.strictObject({ facts: z.record(z.string(), z.string()) })],
      ["an object in a tuple", z.strictObject({ pair: z.tuple([z.string(), z.object({ a: z.string() })]) })],
      ["the whole body", z.object({ a: z.string() })],
      ["a field named like a keyword", z.strictObject({ default: z.object({ a: z.string() }) })],
    ])("fails a body with %s that lets unknown fields through", (_what, schema) => {
      expect(problemsOf(withRequest(bookThing, { body: jsonBody(schema) }))).toEqual([
        "bookThing: its body must be a strict object, and so must every object in it.",
      ]);
    });

    it("does not read a default or an example as a schema", () => {
      const body = z.strictObject({
        note: z.string().meta({ examples: [{ type: "object" }] }),
        shape: z.string().default("x").meta({ default: { type: "object" } }),
      });
      expect(problemsOf(withRequest(bookThing, { body: jsonBody(body) }))).toEqual([]);
    });

    it("fails a body that is not application/json", () => {
      const body = { required: true, content: { "text/plain": { schema: z.string() } } };
      expect(problemsOf(withRequest(bookThing, { body }))).toEqual([
        "bookThing: its body must be a strict object, and so must every object in it.",
      ]);
    });

    it("fails an output that lets unknown fields through", () => {
      const responses = { 201: { description: "Booked.", content: { "application/json": { schema: z.object({ id: z.string() }) } } } };
      expect(problemsOf(changed(bookThing, { responses }))).toEqual([
        "bookThing: its output must be a strict object, and so must every object in it.",
      ]);
    });

    it("fails an output that is not an object, which MCP's structured content must be", () => {
      const responses = { 200: { description: "The name.", content: { "application/json": { schema: z.string() } } } };
      expect(problemsOf(changed(readThing, { responses }))).toEqual([
        "getThing: its output must be a strict object, and so must every object in it.",
      ]);
    });

    it.each([
      [{}],
      [{ 400: { description: "Refused." } }],
    ])("fails an entry without a success answer: %#", (responses) => {
      expect(problemsOf(changed(readThing, { responses }))).toEqual([
        "getThing has no success answer: 200 or 201 with JSON, 202 or 204 with no body, or 303.",
      ]);
    });

    it("fails an entry with no answers at all", () => {
      expect(problemsOf(without(readThing, "responses"))).toEqual([
        "getThing has no success answer: 200 or 201 with JSON, 202 or 204 with no body, or 303.",
      ]);
    });

    it.each([
      [{ 200: { description: "Nothing." } }],
      [{ 201: { description: "Text.", content: { "text/plain": { schema: z.string() } } } }],
      [{ 303: { description: "See.", headers: { Location: { schema: { type: "string" } } } } }],
    ])("fails a 200, 201 or 303 without an application/json schema: %#", (responses) => {
      const status = Object.keys(responses)[0] ?? "";
      const entry = status === "303" ? changed(startRedirect, { responses }) : changed(readThing, { responses });
      const name = status === "303" ? "startRedirect" : "getThing";
      expect(problemsOf(entry)).toEqual([`${name} answers ${status} with no application/json schema.`]);
    });

    it("passes a read that answers 204", () => {
      expect(problemsOf(changed(readThing, { responses: { 204: { description: "No content." } } }))).toEqual([]);
    });
  });

  describe("the flat input of an MCP tool", () => {
    it("fails a query and a body that share a name", () => {
      expect(problemsOf(withRequest(bookThing, { query: z.strictObject({ description: z.string().optional() }) }))).toEqual([
        'bookThing: the query and the body both have a field "description".',
      ]);
    });

    it("fails a field named idempotencyKey, in the query or in the body", () => {
      expect(problemsOf(withRequest(readThing, { query: z.strictObject({ idempotencyKey: z.string() }) }))).toEqual([
        'getThing has a field "idempotencyKey", the name of a write\'s key on MCP.',
      ]);
      expect(
        problemsOf(withRequest(bookThing, { body: jsonBody(z.strictObject({ idempotencyKey: z.string() })) })),
      ).toEqual(['bookThing has a field "idempotencyKey", the name of a write\'s key on MCP.']);
    });
  });

  describe("lists", () => {
    it("fails a list without limit or cursor", () => {
      expect(problemsOf(withRequest(listThings, { query: z.strictObject({ cursor: z.string().optional() }) }))).toEqual([
        "listThings is a list, but lacks limit, cursor or a page of items, nextCursor and total.",
      ]);
      expect(problemsOf(withRequest(listThings, { query: undefined }))).toEqual([
        "listThings is a list, but lacks limit, cursor or a page of items, nextCursor and total.",
      ]);
    });

    it("fails a list whose output is not a page", () => {
      const responses = { 200: { description: "The things.", content: { "application/json": { schema: z.strictObject({ items: z.array(z.string()) }) } } } };
      expect(problemsOf(changed(listThings, { responses }))).toEqual([
        "listThings is a list, but lacks limit, cursor or a page of items, nextCursor and total.",
      ]);
    });
  });

  it("names every problem of every entry", () => {
    const bad = changed(withMeta(bookThing, { permission: "", tool: "" }), { path: "/v1/Things" });
    expect(problemsOf(readThing, bad, readThing)).toEqual([
      'bookThing has no permission. An operation that reads no data says "public".',
      "bookThing has no MCP tool text.",
      'bookThing has the path "/v1/Things". A path is /v1/ and a lower-case kebab-case word, then more such words or {parameter} segments, with no trailing slash.',
      'Two operations have the id "getThing".',
      "Two operations have the route GET /v1/things.",
    ]);
  });

  it("fails an entry that is not an object at all", () => {
    expect(problemsOf(null, "getThing")).toEqual(["entry 0 is not a route object.", "entry 1 is not a route object."]);
  });
});
