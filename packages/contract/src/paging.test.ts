// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Cursor, LIMIT, Limit, effectiveLimit, pageOf } from "./paging.ts";
import { fieldIssues, type FieldIssue } from "./problem.ts";

function issuesOf(schema: z.ZodType, input: unknown): FieldIssue[] {
  const result = schema.safeParse(input, { reportInput: true });
  return result.success ? [] : fieldIssues(result.error.issues);
}

describe("LIMIT", () => {
  it("is 1 to 500, with 100 by default, as the established API has it", () => {
    expect(LIMIT).toEqual({ minimum: 1, maximum: 500, default: 100 });
  });
});

describe("effectiveLimit", () => {
  it.each([
    [1, 1],
    [2, 2],
    [100, 100],
    [499, 499],
    [500, 500],
  ])("keeps %j, inside 1 to 500", (value, limit) => {
    expect(effectiveLimit(value)).toBe(limit);
  });

  it.each([
    { value: undefined, what: "no limit" },
    { value: 0, what: "zero" },
    { value: -1, what: "a negative number" },
    { value: -500, what: "a negative number" },
    { value: 501, what: "one past the top" },
    { value: 1e20, what: "a whole number past the safe integers" },
    { value: Number.MAX_SAFE_INTEGER + 2, what: "a whole number past the safe integers" },
    { value: Infinity, what: "a whole number too long to read" },
    { value: -Infinity, what: "a negative whole number too long to read" },
  ])("gives 100 for $value: $what", ({ value }) => {
    expect(effectiveLimit(value)).toBe(100);
  });

  it.each([1.5, -0.5, 500.5, Number.NaN, "abc", "10", null, true, {}])("passes %j on as it is, for the schema to refuse", (value) => {
    expect(effectiveLimit(value)).toBe(value);
  });
});

describe("the limit schema", () => {
  const query = z.strictObject({ limit: Limit });

  it("takes a whole number, also one past the safe integers, and no limit", () => {
    expect(issuesOf(query, { limit: 1 })).toEqual([]);
    expect(issuesOf(query, { limit: 500 })).toEqual([]);
    expect(issuesOf(query, { limit: 1e20 })).toEqual([]);
    expect(issuesOf(query, {})).toEqual([]);
  });

  it("refuses 1.5 with not-an-integer at /limit", () => {
    expect(issuesOf(query, { limit: 1.5 })).toEqual([
      {
        code: "not-an-integer",
        detail: "The field /limit must be a whole number.",
        pointer: "/limit",
        data: { expected: "integer", value: 1.5 },
      },
    ]);
  });

  it.each(["abc", null, true])("refuses %j with invalid-type at /limit", (value) => {
    expect(issuesOf(query, { limit: value })).toEqual([
      {
        code: "invalid-type",
        detail: "The field /limit must be a number.",
        pointer: "/limit",
        data: { expected: "number", value },
      },
    ]);
  });

  it("describes itself as an integer with its default and no safe-integer bounds", () => {
    expect(z.toJSONSchema(Limit, { io: "input" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "integer",
      default: 100,
      description: "How many items a page holds: from 1 to 500. Any other whole number gives 100.",
    });
  });
});

describe("the cursor schema", () => {
  it("takes any text: the list checks that the server made it", () => {
    const query = z.strictObject({ cursor: Cursor });
    expect(issuesOf(query, { cursor: "eyJ2IjoxfQ.c2ln" })).toEqual([]);
    expect(issuesOf(query, {})).toEqual([]);
    expect(issuesOf(query, { cursor: 5 }).map((issue) => issue.code)).toEqual(["invalid-type"]);
  });
});

describe("pageOf", () => {
  const Item = z.strictObject({ id: z.uuid(), number: z.int().min(1) });
  const Page = pageOf(Item);

  it("is the items, nextCursor while more follow, and the total", () => {
    const item = { id: "0a6c8f4e-3b1d-4c2a-9e7f-5d8b6a4c2e1f", number: 1 };
    expect(Page.parse({ items: [item], nextCursor: "abc", total: 250 })).toEqual({ items: [item], nextCursor: "abc", total: 250 });
    expect(Page.parse({ items: [], total: 0 })).toEqual({ items: [], total: 0 });
  });

  it("refuses a page without its total, a negative total and a field it does not know", () => {
    expect(Page.safeParse({ items: [] }).success).toBe(false);
    expect(Page.safeParse({ items: [], total: -1 }).success).toBe(false);
    expect(Page.safeParse({ items: [], total: 0, more: true }).success).toBe(false);
  });
});
