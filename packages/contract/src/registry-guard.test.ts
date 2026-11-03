// SPDX-License-Identifier: AGPL-3.0-only

// The registry guard reads each createRoute object as data. Each bad entry
// here is a good one with one part broken, so each test shows that one check
// fails, and the good ones show that it passes what it should.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Money } from "./money.ts";
import { defineListOperation, defineOperation, type Operation } from "./operation.ts";
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

const GOOD = [readThing, bookThing, listThings, health];

/** A copy of an entry with some parts replaced. */
function changed(entry: object, parts: Record<string, unknown>): object {
  return { ...entry, ...parts };
}

/** A copy of an entry without one of its parts. */
function without(entry: object, part: string): object {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== part));
}

/** A copy of an entry with some of its x-nortfox replaced. */
function withMeta(entry: Operation, meta: Record<string, unknown>): object {
  return changed(entry, { "x-nortfox": { ...entry["x-nortfox"], ...meta } });
}

/** A copy of an entry with some of its request replaced. */
function withRequest(entry: Operation, request: Record<string, unknown>): unknown {
  return changed(entry, { request: { ...entry.request, ...request } });
}

function jsonBody(schema: z.ZodType): unknown {
  return { required: true, content: { "application/json": { schema } } };
}

function problemsOf(...entries: unknown[]): string[] {
  return registryProblems(entries, PERMISSIONS);
}

describe("registryProblems", () => {
  it("passes good entries: a read, a write with its key, a list and a public read", () => {
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
      "getThing declares no x-nortfox: its permission, MCP tool text, assistant flag, writes flag and list flag.",
    ]);
    expect(problemsOf(changed(readThing, { "x-nortfox": "company:read" }))).toEqual([
      "getThing declares no x-nortfox: its permission, MCP tool text, assistant flag, writes flag and list flag.",
    ]);
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
    expect(problemsOf(withMeta(bookThing, { permission: "public" }))).toEqual([
      "bookThing is public and writes. A public operation reads and writes no data.",
    ]);
  });

  it.each(["/v2/things", "/things", "/v1/Things", "/v1/things/", "/v1/things/{id}", "/v1", "/v1/", "/v1//things", "/v1/things_all", "/v1/-things"])(
    "fails the path %j",
    (path) => {
      expect(problemsOf(changed(readThing, { path }))).toEqual([
        `getThing has the path ${JSON.stringify(path)}. A path is /v1/ and then lower-case kebab-case words, with no trailing slash and no {parameter} yet.`,
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
      [{ 200: { description: "Nothing." } }],
      [{ 200: { description: "Text.", content: { "text/plain": { schema: z.string() } } } }],
      [{ 204: { description: "No content." } }],
    ])("fails an entry without a 200 or 201 answer in JSON: %#", (responses) => {
      expect(problemsOf(changed(readThing, { responses }))).toEqual([
        "getThing has no 200 or 201 answer with an application/json schema.",
      ]);
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
      'bookThing has the path "/v1/Things". A path is /v1/ and then lower-case kebab-case words, with no trailing slash and no {parameter} yet.',
      'Two operations have the id "getThing".',
      "Two operations have the route GET /v1/things.",
    ]);
  });

  it("fails an entry that is not an object at all", () => {
    expect(problemsOf(null, "getThing")).toEqual(["entry 0 is not a route object.", "entry 1 is not a route object."]);
  });
});
