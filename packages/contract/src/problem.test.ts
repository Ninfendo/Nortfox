// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FIELD_PROBLEM_CODES,
  FieldProblem,
  PROBLEM_CODES,
  Problem,
  fieldIssues,
  jsonPointer,
  type FieldIssue,
} from "./problem.ts";

/** The field issues a schema finds in an input, parsed as the runner parses. */
function issuesOf(schema: z.ZodType, input: unknown): FieldIssue[] {
  const result = schema.safeParse(input, { reportInput: true });
  return result.success ? [] : fieldIssues(result.error.issues);
}

function onlyIssue(schema: z.ZodType, input: unknown): FieldIssue {
  const [issue, ...others] = issuesOf(schema, input);
  expect(others).toEqual([]);
  if (issue === undefined) {
    throw new Error("expected a field issue");
  }
  return issue;
}

describe("jsonPointer", () => {
  it.each([
    [[], ""],
    [["amount"], "/amount"],
    [["rows", 0, "debit"], "/rows/0/debit"],
    [["a/b"], "/a~1b"],
    [["m~n"], "/m~0n"],
    [["~/"], "/~0~1"],
    [["~1"], "/~01"],
    [[""], "/"],
    [["", ""], "//"],
  ] as const)("writes %j as %j", (path, pointer) => {
    expect(jsonPointer(path)).toBe(pointer);
  });

  it("writes a symbol by its description, and one without as an empty name", () => {
    expect(jsonPointer([Symbol("key"), Symbol()])).toBe("/key/");
  });
});

describe("fieldIssues", () => {
  it("names a field that is missing, with the type it takes", () => {
    expect(onlyIssue(z.strictObject({ name: z.string() }), {})).toEqual({
      code: "missing-field",
      detail: "The field /name is missing.",
      pointer: "/name",
      data: { expected: "string" },
    });
  });

  it.each([
    [z.string(), 5, "string", "a string"],
    [z.number(), "5", "number", "a number"],
    [z.int(), 1.5, "integer", "an integer"],
    [z.boolean(), "yes", "boolean", "a boolean"],
    [z.strictObject({}), "x", "object", "an object"],
    [z.record(z.string(), z.string()), 1, "object", "an object"],
    [z.array(z.string()), "x", "array", "an array"],
    [z.tuple([z.string()]), "x", "array", "an array"],
    [z.null(), false, "null", "null"],
  ] as const)("gives invalid-type with the JSON type the field takes: %#", (schema, value, expected, phrase) => {
    expect(onlyIssue(z.strictObject({ x: schema }), { x: value })).toEqual({
      code: "invalid-type",
      detail: `The field /x must be ${phrase}.`,
      pointer: "/x",
      data: { expected, value },
    });
  });

  it("leaves out the expected type when it is not a JSON type", () => {
    expect(onlyIssue(z.strictObject({ x: z.date() }), { x: "2026-11-03" })).toEqual({
      code: "invalid-type",
      detail: "The field /x has the wrong type.",
      pointer: "/x",
      data: { value: "2026-11-03" },
    });
  });

  it("points to the root for an input that is not an object", () => {
    expect(onlyIssue(z.strictObject({}), [1])).toEqual({
      code: "invalid-type",
      detail: "The input must be an object.",
      pointer: "",
      data: { expected: "object" },
    });
  });

  it("names each unknown field at its own pointer, nested too", () => {
    const schema = z.strictObject({ amount: z.strictObject({ amount: z.string() }) });
    expect(issuesOf(schema, { amount: { amount: "1", "a/b": 1 }, zz: true, "m~n": null })).toEqual([
      {
        code: "unknown-field",
        detail: "The field /amount/a~1b is not part of this operation.",
        pointer: "/amount/a~1b",
        data: {},
      },
      { code: "unknown-field", detail: "The field /zz is not part of this operation.", pointer: "/zz", data: {} },
      { code: "unknown-field", detail: "The field /m~0n is not part of this operation.", pointer: "/m~0n", data: {} },
    ]);
  });

  it.each([
    [z.string().min(1), "", "too-short", "The field /x must be at least 1 character long.", { minimum: 1 }],
    [z.string().min(3), "ab", "too-short", "The field /x must be at least 3 characters long.", { minimum: 3 }],
    [z.string().max(1), "ab", "too-long", "The field /x must be at most 1 character long.", { maximum: 1 }],
    [z.string().max(200), "a".repeat(201), "too-long", "The field /x must be at most 200 characters long.", { maximum: 200 }],
    [z.array(z.string()).min(1), [], "too-short", "The field /x must hold at least 1 item.", { minimum: 1 }],
    [z.array(z.string()).max(2), ["a", "b", "c"], "too-long", "The field /x must hold at most 2 items.", { maximum: 2 }],
    [z.number().min(1), 0, "out-of-range", "The field /x must be at least 1.", { minimum: 1 }],
    [z.number().max(500), 501, "out-of-range", "The field /x must be at most 500.", { maximum: 500 }],
    [z.number().gt(0), 0, "out-of-range", "The field /x must be more than 0.", { exclusiveMinimum: 0 }],
    [z.number().lt(10), 10, "out-of-range", "The field /x must be less than 10.", { exclusiveMaximum: 10 }],
  ] as const)("gives a bound and its limit: %#", (schema, value, code, detail, data) => {
    const input = { x: value };
    const issue = onlyIssue(z.strictObject({ x: schema }), input);
    expect(issue).toEqual({
      code,
      detail,
      pointer: "/x",
      data: typeof value === "object" ? data : { ...data, value },
    });
  });

  it("writes a bigint limit as a string, since JSON has no bigint", () => {
    expect(onlyIssue(z.bigint().min(5n), 1n).data).toEqual({ minimum: "5", value: "1" });
    expect(onlyIssue(z.bigint().max(5n), 9n).data).toEqual({ maximum: "5", value: "9" });
  });

  it("gives invalid-value with the allowed values", () => {
    expect(onlyIssue(z.strictObject({ k: z.enum(["a", "b"]) }), { k: "c" })).toEqual({
      code: "invalid-value",
      detail: 'The field /k must be one of: "a", "b".',
      pointer: "/k",
      data: { allowed: ["a", "b"], value: "c" },
    });
    expect(onlyIssue(z.strictObject({ k: z.literal(7) }), { k: 8 })).toEqual({
      code: "invalid-value",
      detail: "The field /k must be one of: 7.",
      pointer: "/k",
      data: { allowed: [7], value: 8 },
    });
  });

  it("keeps only the allowed values that JSON can hold, a bigint as a string", () => {
    expect(onlyIssue(z.literal([1n, undefined, null, true]), "x").data).toEqual({ allowed: ["1", null, true], value: "x" });
  });

  it("gives bad-format with the format", () => {
    expect(onlyIssue(z.strictObject({ id: z.uuid() }), { id: "x" })).toEqual({
      code: "bad-format",
      detail: "The field /id does not have the format uuid.",
      pointer: "/id",
      data: { format: "uuid", value: "x" },
    });
    expect(onlyIssue(z.string().regex(/^[0-9]{6}-[0-9]{4}$/), "5560000167").data).toEqual({ format: "regex", value: "5560000167" });
  });

  it("gives invalid-value for a number that is not a multiple, a union no branch takes, and a bad key or element", () => {
    expect(onlyIssue(z.number().multipleOf(5), 7)).toEqual({
      code: "invalid-value",
      detail: "The input must be a multiple of 5.",
      pointer: "",
      data: { multipleOf: 5, value: 7 },
    });
    expect(onlyIssue(z.bigint().multipleOf(5n), 7n).data).toEqual({ multipleOf: "5", value: "7" });
    expect(onlyIssue(z.strictObject({ u: z.union([z.string(), z.number()]) }), { u: true })).toEqual({
      code: "invalid-value",
      detail: "The field /u fits none of the forms it may take.",
      pointer: "/u",
      data: { value: true },
    });
    expect(onlyIssue(z.record(z.string().max(1), z.string()), { bb: "x" })).toEqual({
      code: "invalid-value",
      detail: "The field /bb is not a name this object allows.",
      pointer: "/bb",
      data: { value: "bb" },
    });
    expect(onlyIssue(z.map(z.strictObject({}), z.number()), new Map([[{}, "x"]]))).toEqual({
      code: "invalid-value",
      detail: "The input holds a value that is not allowed.",
      pointer: "",
      data: {},
    });
  });

  it("gives a check's own code, detail and data", () => {
    const schema = z.strictObject({
      amount: z.string().superRefine((value, context) => {
        context.addIssue({
          code: "custom",
          message: "is not positive.",
          input: value,
          params: { code: "amount-not-positive", data: { minimum: "0.01" } },
        });
      }),
    });
    expect(onlyIssue(schema, { amount: "0.00" })).toEqual({
      code: "amount-not-positive",
      detail: "The field /amount is not positive.",
      pointer: "/amount",
      data: { minimum: "0.01", value: "0.00" },
    });
  });

  it("gives invalid-value for a check without a code of its own", () => {
    expect(onlyIssue(z.strictObject({ x: z.string().refine(() => false) }), { x: "a" })).toEqual({
      code: "invalid-value",
      detail: "The field /x is not valid.",
      pointer: "/x",
      data: { value: "a" },
    });
    const withoutData = z.string().superRefine((_value, context) => {
      context.addIssue({ code: "custom", message: "is odd.", params: { code: "odd", data: "not an object" } });
    });
    expect(onlyIssue(withoutData, "a")).toEqual({ code: "odd", detail: "The input is odd.", pointer: "", data: { value: "a" } });
  });

  it("keeps the received value only when it is a JSON scalar", () => {
    expect(onlyIssue(z.strictObject({ x: z.string() }), { x: null }).data).toEqual({ expected: "string", value: null });
    expect(onlyIssue(z.strictObject({ x: z.string() }), { x: { y: 1 } }).data).toEqual({ expected: "string" });
    expect(onlyIssue(z.strictObject({ x: z.string() }), { x: [1] }).data).toEqual({ expected: "string" });
    expect(onlyIssue(z.string(), Number.NaN).data).toEqual({ expected: "string" });
    expect(onlyIssue(z.string(), Symbol("s")).data).toEqual({ expected: "string" });
  });

  it("writes texts that name no surface, so REST and MCP give the same problem", () => {
    const schema = z.strictObject({
      a: z.string().min(2),
      b: z.int(),
      c: z.enum(["x"]),
      d: z.uuid(),
      e: z.array(z.string()).max(0),
    });
    const found = issuesOf(schema, { a: "", b: "1", c: "y", d: "z", e: ["f"], g: 1 });
    expect(found.map((issue) => issue.code)).toEqual([
      "too-short",
      "invalid-type",
      "invalid-value",
      "bad-format",
      "too-long",
      "unknown-field",
    ]);
    for (const issue of found) {
      expect(issue.detail).toMatch(/^The (field \/[a-z]+|input) /);
      expect(issue.detail).not.toMatch(/query|header|body|parameter|argument|tool|rest\b|mcp|http/i);
    }
  });
});

describe("the problem codes", () => {
  it("are stable kebab-case, each with its status", () => {
    for (const [code, status] of Object.entries(PROBLEM_CODES)) {
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect([400, 401, 403, 404, 405, 409, 413, 415, 422, 500]).toContain(status);
    }
    for (const code of FIELD_PROBLEM_CODES) {
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it("list the answers of the /v1 surface", () => {
    expect(PROBLEM_CODES).toMatchObject({
      "invalid-request": 400,
      "malformed-json": 400,
      "authentication-required": 401,
      "permission-missing": 403,
      "origin-not-allowed": 403,
      "not-found": 404,
      "method-not-allowed": 405,
      "idempotency-key-in-use": 409,
      "payload-too-large": 413,
      "unsupported-media-type": 415,
      "idempotency-key-reused": 422,
      "internal-error": 500,
    });
  });

  it("list each ledger rule a request can break, at 422, in the engine's style", () => {
    const rules = [
      "unbalanced",
      "too-few-rows",
      "account-missing",
      "account-inactive",
      "series-missing",
      "series-not-manual",
      "no-fiscal-year",
      "date-outside-fiscal-year",
      "description-missing",
      "value-too-long",
      "period-locked-manual",
      "period-locked-automatic",
      "not-last-in-series",
      "reversing-voucher-exists",
      "reversing-other-module",
      "account-has-rows",
      "series-code-invalid",
      "series-code-duplicate",
      "series-code-changed",
      "immutable-field",
      "period-outside-fiscal-year",
      "fiscal-year-strands-rows",
    ];
    expect(Object.entries(PROBLEM_CODES).filter(([, status]) => status === 422).map(([code]) => code).sort()).toEqual(
      [...rules, "idempotency-key-reused"].sort(),
    );
  });

  it("list every code a field problem can have", () => {
    expect([...FIELD_PROBLEM_CODES].sort()).toEqual(
      [
        "unknown-parameter",
        "repeated-parameter",
        "unknown-field",
        "missing-field",
        "invalid-type",
        "invalid-value",
        "too-short",
        "too-long",
        "not-an-integer",
        "bad-format",
        "fraction-of-ore",
        "unknown-currency",
        "out-of-range",
        "cursor-invalid",
        "idempotency-key-missing",
        "idempotency-key-invalid",
      ].sort(),
    );
  });
});

describe("Problem and FieldProblem", () => {
  const forbidden = {
    type: "about:blank",
    title: "Forbidden",
    status: 403,
    detail: "The actor lacks the permission company:read.",
    code: "permission-missing",
    permission: "company:read",
  };

  it("take the problem details of RFC 9457 with a stable code", () => {
    expect(Problem.parse(forbidden)).toEqual(forbidden);
    const invalid = {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "The request does not fit the operation.",
      code: "invalid-request",
      errors: [
        { code: "unknown-field", detail: "The field /zz is not part of this operation.", pointer: "/zz" },
        { code: "out-of-range", detail: "x", pointer: "/amount/amount", data: { minimum: "-1.00", maximum: "1.00" } },
      ],
    };
    expect(Problem.parse(invalid)).toEqual(invalid);
    const rule = { ...forbidden, status: 422, code: "period-locked-manual", pointer: "/date", data: { endDate: "2026-01-31" } };
    expect(Problem.parse(rule)).toEqual(rule);
  });

  it("refuse a field they do not know, and a problem without its code", () => {
    expect(Problem.safeParse({ ...forbidden, extra: 1 }).success).toBe(false);
    const withoutCode = Object.fromEntries(Object.entries(forbidden).filter(([key]) => key !== "code"));
    expect(Problem.safeParse(withoutCode).success).toBe(false);
    expect(FieldProblem.safeParse({ code: "x", detail: "y", pointer: "/z", value: 1 }).success).toBe(false);
  });
});
