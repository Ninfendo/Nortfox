// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "./idempotency-key.ts";
import { Money } from "./money.ts";
import {
  NoBody,
  Redirect,
  bodySchema,
  defineListOperation,
  defineOperation,
  outputSchema,
  paramsSchema,
  querySchema,
  securityOf,
  successStatus,
  takesIdempotencyKey,
  type Shape,
} from "./operation.ts";
import { Limit, Cursor } from "./paging.ts";
import { Problem } from "./problem.ts";
import { SECURITY_SCHEMES, SESSION_COOKIE } from "./security.ts";

const Item = z.strictObject({ id: z.uuid() });

const publicRead = defineOperation({
  id: "getPing",
  method: "get",
  path: "/v1/ping",
  tags: ["status"],
  summary: "Ping",
  description: "Answers a ping.",
  output: z.strictObject({ ok: z.boolean() }),
  permission: "public",
  tool: "Answers a ping.",
  writes: false,
});

const read = defineOperation({
  id: "getItem",
  method: "get",
  path: "/v1/item",
  tags: ["items"],
  summary: "Read the item",
  description: "Reads the item.",
  query: z.strictObject({ name: z.string().optional() }),
  output: Item,
  permission: "test:read",
  tool: "Reads the item.",
  assistant: true,
  writes: false,
});

const Body = z.strictObject({ amount: Money });

const write = defineOperation({
  id: "bookItem",
  method: "post",
  path: "/v1/items",
  tags: ["items"],
  summary: "Book an item",
  description: "Books an item.",
  body: Body,
  output: Item,
  status: 201,
  permission: "test:write",
  tool: "Books an item.",
  writes: true,
});

const list = defineListOperation({
  id: "listItems",
  method: "get",
  path: "/v1/items",
  tags: ["items"],
  summary: "List the items",
  description: "Lists the items.",
  query: z.strictObject({ name: z.string().optional() }),
  item: Item,
  permission: "test:read",
  tool: "Lists the items.",
});

/** The statuses of an entry's answers, sorted. */
function statuses(entry: { readonly responses: object }): string[] {
  return Object.keys(entry.responses).sort();
}

describe("defineOperation", () => {
  it("builds a createRoute object with the id, the method, the /v1 path and the texts", () => {
    expect(read).toMatchObject({
      operationId: "getItem",
      method: "get",
      path: "/v1/item",
      tags: ["items"],
      summary: "Read the item",
      description: "Reads the item.",
    });
    expect(read.getRoutingPath()).toBe("/v1/item");
  });

  it("carries NortFox's own parts in x-nortfox, closed to the assistant unless it says so", () => {
    expect(read["x-nortfox"]).toEqual({
      permission: "test:read",
      tool: "Reads the item.",
      assistant: true,
      writes: false,
      list: false,
      session: null,
      company: "credential",
    });
    expect(write["x-nortfox"]).toEqual({
      permission: "test:write",
      tool: "Books an item.",
      assistant: false,
      writes: true,
      list: false,
      session: null,
      company: "credential",
    });
  });

  it("takes the company from the credential for an operation with a permission, and from nowhere for one without", () => {
    expect(publicRead["x-nortfox"]).toMatchObject({ session: null, company: "none" });
    expect(read["x-nortfox"].company).toBe("credential");
  });

  it("answers a public read with its output, 400 and 500", () => {
    expect(statuses(publicRead)).toEqual(["200", "400", "500"]);
    expect(publicRead.request).toEqual({});
  });

  it("describes the success answer by its output, or plainly when the output says nothing", () => {
    expect(list.responses[200]?.description).toBe("A page of the list.");
    expect(publicRead.responses[200]?.description).toBe("The answer.");
  });

  it("answers a read of data with its output, 400, 401, 403 and 500", () => {
    expect(statuses(read)).toEqual(["200", "400", "401", "403", "500"]);
  });

  it("answers a write with a body with its output, and 409, 413, 415 and 422 too", () => {
    expect(statuses(write)).toEqual(["201", "400", "401", "403", "409", "413", "415", "422", "500"]);
  });

  it("gives every refusal as problem details", () => {
    for (const [status, response] of Object.entries(write.responses)) {
      if (status === "201") {
        continue;
      }
      expect(response.description).not.toBe("");
      expect(response.content).toEqual({ "application/problem+json": { schema: Problem } });
    }
  });

  it("documents the challenge of a 401", () => {
    expect(read.responses[401]).toMatchObject({
      headers: { "WWW-Authenticate": { description: expect.stringContaining("Bearer") as unknown, schema: { type: "string" } } },
    });
  });

  it("takes the body as JSON and a required Idempotency-Key on a write", () => {
    expect(write.request.body).toEqual({ required: true, content: { "application/json": { schema: Body } } });
    const headers = write.request.headers;
    expect(headers?.shape[IDEMPOTENCY_KEY_HEADER]).toBeDefined();
    expect(headers?.safeParse({}).success).toBe(false);
    expect(headers?.safeParse({ [IDEMPOTENCY_KEY_HEADER]: "8e03978e", "content-type": "application/json" }).success).toBe(true);
    expect(read.request.headers).toBeUndefined();
  });

  it("reads its parts back", () => {
    expect(querySchema(read)).toBe(read.request.query);
    expect(querySchema<Shape | undefined>(write)).toBeUndefined();
    expect(bodySchema(write)).toBe(Body);
    expect(bodySchema<Shape | undefined>(read)).toBeUndefined();
    expect(paramsSchema<Shape | undefined>(read)).toBeUndefined();
    expect(outputSchema(read)).toBe(Item);
    expect(outputSchema(write)).toBe(Item);
    expect(successStatus(read)).toBe(200);
    expect(successStatus(write)).toBe(201);
    expect(takesIdempotencyKey(write)).toBe(true);
    expect(takesIdempotencyKey(read)).toBe(false);
  });

  it("throws for an entry with no success answer, which the registry guard refuses", () => {
    expect(() => successStatus({ ...read, responses: { 400: { description: "Refused." } } })).toThrow("getItem has no success answer.");
  });
});

describe("path parameters", () => {
  const Params = z.strictObject({ itemId: z.uuid().meta({ description: "The item's id." }) });
  const getOne = defineOperation({
    id: "getOneItem",
    method: "get",
    path: "/v1/items/{itemId}",
    tags: ["items"],
    summary: "Read one item",
    description: "Reads one item.",
    params: Params,
    output: Item,
    permission: "test:read",
    tool: "Reads one item.",
    writes: false,
  });

  it("takes them as the request's params, and routes them as Hono names them", () => {
    expect(getOne.request).toEqual({ params: Params });
    expect(paramsSchema(getOne)).toBe(Params);
    expect(getOne.path).toBe("/v1/items/{itemId}");
    expect(getOne.getRoutingPath()).toBe("/v1/items/:itemId");
  });
});

describe("the answers without a body, and the redirect", () => {
  const texts = { tags: ["items"], summary: "S", description: "D.", tool: "T." } as const;

  const ended = defineOperation({
    ...texts,
    id: "endItem",
    method: "delete",
    path: "/v1/items",
    output: NoBody,
    status: 204,
    permission: "test:write",
    writes: true,
  });

  const accepted = defineOperation({
    ...texts,
    id: "sendItem",
    method: "post",
    path: "/v1/item-letters",
    body: Body,
    output: NoBody,
    status: 202,
    permission: "none",
    session: "flow",
    writes: true,
  });

  const redirect = defineOperation({
    ...texts,
    id: "startItem",
    method: "get",
    path: "/v1/item-starts",
    output: Redirect,
    status: 303,
    permission: "none",
    session: "flow",
    writes: true,
  });

  it("answers 204 with no body: its output is the empty object", () => {
    expect(ended.responses[204]).toEqual({ description: "Done. The answer has no body." });
    expect(successStatus(ended)).toBe(204);
    expect(outputSchema(ended)).toBe(NoBody);
    expect(NoBody.parse({})).toEqual({});
    expect(NoBody.safeParse({ x: 1 }).success).toBe(false);
  });

  it("answers 202 with no body: the work goes on after the answer", () => {
    expect(accepted.responses[202]).toEqual({ description: "Accepted. The work goes on after the answer, which has no body." });
    expect(successStatus(accepted)).toBe(202);
    expect(outputSchema(accepted)).toBe(NoBody);
  });

  it("answers 303 with the Location header and the same location as JSON", () => {
    expect(redirect.responses[303]).toEqual({
      description: "See Other: the browser goes on to the location.",
      headers: { Location: { description: "The URL the browser goes to next.", schema: { type: "string" } } },
      content: { "application/json": { schema: Redirect } },
    });
    expect(successStatus(redirect)).toBe(303);
    expect(outputSchema(redirect)).toBe(Redirect);
    expect(Redirect.parse({ location: "https://idp.example.com/authorize" })).toEqual({ location: "https://idp.example.com/authorize" });
  });

  it("refuses another output for an answer without a body, and for a redirect", () => {
    expect(() => defineOperation({ ...texts, id: "badEnd", method: "delete", path: "/v1/items", output: Item, status: 204, permission: "test:write", writes: true })).toThrow(
      "badEnd answers 204, which has no body, so its output is NoBody.",
    );
    expect(() => defineOperation({ ...texts, id: "badSend", method: "post", path: "/v1/items", output: z.strictObject({}), status: 202, permission: "none", writes: true })).toThrow(
      "badSend answers 202, which has no body, so its output is NoBody.",
    );
    expect(() => defineOperation({ ...texts, id: "badStart", method: "get", path: "/v1/items", output: Item, status: 303, permission: "none", writes: true })).toThrow(
      "badStart answers 303, so its output is Redirect.",
    );
    expect(() => defineOperation({ ...texts, id: "badRead", method: "get", path: "/v1/items", output: NoBody, permission: "test:read", writes: false })).toThrow(
      "badRead answers 200 with JSON, so its output is not NoBody.",
    );
  });
});

describe("an operation that runs before sign-in", () => {
  const signIn = defineOperation({
    id: "signInItem",
    method: "post",
    path: "/v1/item-sign-ins",
    tags: ["items"],
    summary: "Sign in",
    description: "Signs in.",
    body: Body,
    output: Item,
    permission: "none",
    session: "flow",
    tool: "Signs in.",
    writes: true,
  });

  it("takes no idempotency key, has no company, and is refused only by its input, its rules and its limits", () => {
    expect(signIn.request.headers).toBeUndefined();
    expect(takesIdempotencyKey(signIn)).toBe(false);
    expect(signIn["x-nortfox"]).toMatchObject({ permission: "none", session: "flow", company: "none", writes: true });
    expect(statuses(signIn)).toEqual(["200", "400", "413", "415", "422", "429", "500", "503"]);
  });

  it("names Retry-After on its 429 and its 503, and on no other answer", () => {
    for (const status of ["429", "503"]) {
      expect(signIn.responses[status]?.headers).toEqual({
        "Retry-After": { description: "The whole seconds to wait before the next attempt.", schema: { type: "string" } },
      });
    }
    for (const status of ["200", "400", "422", "500"]) {
      expect(signIn.responses[status]?.headers).toBeUndefined();
    }
  });

  it("is refused by a rule also when it only reads, such as a link that has ended", () => {
    const readLink = defineOperation({
      id: "getItemLink",
      method: "get",
      path: "/v1/item-links",
      tags: ["items"],
      summary: "Read a link",
      description: "Reads a link.",
      output: Item,
      permission: "none",
      session: "flow",
      tool: "Reads a link.",
      writes: false,
    });
    expect(statuses(readLink)).toEqual(["200", "400", "422", "429", "500", "503"]);
  });
});

describe("a signed-in operation", () => {
  const endSession = defineOperation({
    id: "endItemSession",
    method: "post",
    path: "/v1/item-session-ends",
    tags: ["items"],
    summary: "End",
    description: "Ends.",
    output: NoBody,
    status: 204,
    permission: "signed-in",
    session: "flow",
    tool: "Ends.",
    writes: true,
  });

  it("takes an idempotency key when it writes, works in no company, and can be refused for its actor", () => {
    expect(takesIdempotencyKey(endSession)).toBe(true);
    expect(endSession.request.headers?.shape[IDEMPOTENCY_KEY_HEADER]).toBeDefined();
    expect(endSession["x-nortfox"]).toMatchObject({ permission: "signed-in", session: "flow", company: "none" });
    expect(statuses(endSession)).toEqual(["204", "400", "401", "403", "409", "422", "500"]);
  });

  it("takes a company source of its own", () => {
    const inCompany = defineOperation({
      id: "readItemCompany",
      method: "get",
      path: "/v1/item-companies",
      tags: ["items"],
      summary: "Read",
      description: "Reads.",
      output: Item,
      permission: "test:read",
      company: "none",
      tool: "Reads.",
      writes: false,
    });
    expect(inCompany["x-nortfox"].company).toBe("none");
  });
});

describe("the credential an operation takes", () => {
  it("is the browser's session cookie, which openapi.json names as the scheme sessionCookie", () => {
    expect(SESSION_COOKIE).toBe("__Host-nortfox-session");
    expect(SECURITY_SCHEMES).toEqual({
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-nortfox-session",
        description: "The browser's session, which a sign-in sets: verifyTotp, or loginWithPassword on a known device. The browser sends it by itself.",
      },
    });
  });

  it("is named on every operation that needs an actor: a read, a write and a list with a permission, and a signed-in one", () => {
    const signedIn = defineOperation({
      id: "getItemPerson",
      method: "get",
      path: "/v1/item-people",
      tags: ["items"],
      summary: "Read",
      description: "Reads.",
      output: Item,
      permission: "signed-in",
      tool: "Reads.",
      writes: false,
    });
    for (const entry of [read, write, list, signedIn]) {
      expect(entry.security, entry.operationId).toEqual([{ sessionCookie: [] }]);
    }
  });

  it("is named on no operation that needs no actor: a public one, and one that runs before sign-in", () => {
    const signIn = defineOperation({
      id: "signInItem",
      method: "post",
      path: "/v1/item-sign-ins",
      tags: ["items"],
      summary: "Sign in",
      description: "Signs in.",
      body: Body,
      output: Item,
      permission: "none",
      session: "flow",
      tool: "Signs in.",
      writes: true,
    });
    for (const entry of [publicRead, signIn]) {
      expect("security" in entry, entry.operationId).toBe(false);
    }
  });

  it("comes from the permission, a new list each time", () => {
    expect(securityOf("public")).toBeUndefined();
    expect(securityOf("none")).toBeUndefined();
    expect(securityOf("signed-in")).toEqual([{ sessionCookie: [] }]);
    expect(securityOf("company:read")).toEqual([{ sessionCookie: [] }]);
    expect(securityOf("signed-in")).not.toBe(securityOf("signed-in"));
  });
});

describe("defineListOperation", () => {
  it("is a list: limit and cursor beside its own query, and a page of its items", () => {
    expect(list["x-nortfox"]).toEqual({
      permission: "test:read",
      tool: "Lists the items.",
      assistant: false,
      writes: false,
      list: true,
      session: null,
      company: "credential",
    });
    const query = querySchema(list);
    expect(Object.keys(query?.shape ?? {})).toEqual(["name", "limit", "cursor"]);
    expect(query?.shape.limit).toBe(Limit);
    expect(query?.shape.cursor).toBe(Cursor);
    const page = { items: [{ id: "0a6c8f4e-3b1d-4c2a-9e7f-5d8b6a4c2e1f" }], nextCursor: "abc", total: 3 };
    expect(outputSchema(list).parse(page)).toEqual(page);
    expect(statuses(list)).toEqual(["200", "400", "401", "403", "500"]);
  });

  it("takes limit and cursor alone when it has no query of its own", () => {
    const bare = defineListOperation({
      id: "listBare",
      method: "get",
      path: "/v1/bare",
      tags: ["items"],
      summary: "List",
      description: "Lists.",
      item: Item,
      permission: "test:read",
      tool: "Lists.",
      assistant: true,
    });
    expect(Object.keys(querySchema(bare)?.shape ?? {})).toEqual(["limit", "cursor"]);
    expect(bare["x-nortfox"].assistant).toBe(true);
  });
});
