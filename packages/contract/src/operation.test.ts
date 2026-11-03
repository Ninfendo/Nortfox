// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IDEMPOTENCY_KEY_HEADER } from "./idempotency-key.ts";
import { Money } from "./money.ts";
import {
  bodySchema,
  defineListOperation,
  defineOperation,
  outputSchema,
  querySchema,
  successStatus,
  type Shape,
} from "./operation.ts";
import { Limit, Cursor } from "./paging.ts";
import { Problem } from "./problem.ts";

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
    });
    expect(write["x-nortfox"]).toEqual({
      permission: "test:write",
      tool: "Books an item.",
      assistant: false,
      writes: true,
      list: false,
    });
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
    expect(outputSchema(read)).toBe(Item);
    expect(outputSchema(write)).toBe(Item);
    expect(successStatus(read)).toBe(200);
    expect(successStatus(write)).toBe(201);
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
