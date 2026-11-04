// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every /v1 error is problem details (RFC 9457): application/problem+json
 * with `type`, `title`, `status`, `detail` and a stable `code`. Clients rely
 * on the code; the texts are English until packages/i18n comes (slice 2d).
 *
 * A request that does not fit its operation gets one problem with a field
 * problem per field. Each field problem has a JSON Pointer (RFC 6901) into
 * the operation's flat input: the one object an MCP tool takes, with the
 * path parameters, the query parameters, the body's fields and, for a write,
 * `idempotencyKey`. So a field problem is the same by REST and by MCP.
 */

import { z } from "zod";

/** A value JSON can hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * What is wrong with one field of a request. `data` holds the facts that a
 * second surface needs for its own message: `expected` (the JSON type the
 * field takes), `minimum`, `maximum`, `allowed`, and `value`, the value
 * received when it is a JSON scalar. The /v1 and MCP answers leave `value`
 * out, so an answer never echoes its input.
 */
export interface FieldIssue {
  readonly code: string;
  readonly detail: string;
  readonly pointer: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

const Facts = z.record(z.string(), z.unknown());

export const FieldProblem = z
  .strictObject({
    code: z.string().meta({ description: "What is wrong with the field, as a stable kebab-case code." }),
    detail: z.string().meta({ description: "The same in an English sentence." }),
    pointer: z.string().meta({
      description:
        "A JSON Pointer to the field in the operation's input: the path parameters, the query parameters, the body's fields and, for a write, idempotencyKey. An empty pointer is the whole input.",
      examples: ["/amount/amount"],
    }),
    data: Facts.optional().meta({
      description: "The facts behind the code, such as expected, minimum, maximum or allowed. Absent when there are none.",
    }),
  })
  .meta({ id: "FieldProblem", description: "What is wrong with one field of a request." });

export type FieldProblem = z.infer<typeof FieldProblem>;

export const Problem = z
  .strictObject({
    type: z.string().meta({ description: "A URI for the kind of problem. NortFox sends about:blank, and the code says what went wrong." }),
    title: z.string().meta({ description: "The status in words, such as Bad Request." }),
    status: z.int().meta({ description: "The HTTP status." }),
    detail: z.string().meta({ description: "What went wrong, in an English sentence." }),
    code: z.string().meta({ description: "What went wrong, as a stable kebab-case code. Clients rely on this." }),
    errors: z.array(FieldProblem).optional().meta({ description: "For invalid-request: what is wrong with each field." }),
    permission: z.string().optional().meta({ description: "For permission-missing: the permission the operation needs." }),
    pointer: z.string().optional().meta({ description: "For a rule's refusal that concerns one field: that field's JSON Pointer." }),
    data: Facts.optional().meta({ description: "For a rule's refusal: the facts behind it." }),
  })
  .meta({ id: "Problem", description: "Problem details (RFC 9457) with a stable code." });

export type Problem = z.infer<typeof Problem>;

/** The ledger's rules a request can break: each a refusal by the database, answered with 422. */
const LEDGER_RULES = [
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
  "install-not-empty",
  "last-system-administrator",
  "period-outside-fiscal-year",
  "fiscal-year-strands-rows",
] as const;

/** Every code a problem can have, with its status. */
export const PROBLEM_CODES = {
  "invalid-request": 400,
  "malformed-json": 400,
  "authentication-required": 401,
  "permission-missing": 403,
  "company-required": 403,
  "origin-not-allowed": 403,
  "browser-only": 403,
  "not-found": 404,
  "method-not-allowed": 405,
  "idempotency-key-in-use": 409,
  "payload-too-large": 413,
  "unsupported-media-type": 415,
  "idempotency-key-reused": 422,
  "sign-in-failed": 422,
  "setup-link-invalid": 422,
  "too-many-attempts": 429,
  "internal-error": 500,
  "server-busy": 503,
  ...(Object.fromEntries(LEDGER_RULES.map((code) => [code, 422])) as Record<(typeof LEDGER_RULES)[number], 422>),
} as const;

export type ProblemCode = keyof typeof PROBLEM_CODES;

/** Every code a field problem can have. */
export const FIELD_PROBLEM_CODES = [
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
] as const;

export type FieldProblemCode = (typeof FIELD_PROBLEM_CODES)[number];

/** A path as a JSON Pointer in RFC 6901's string form: "/rows/0/debit". The root is "". */
export function jsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => {
      const name = typeof segment === "symbol" ? (segment.description ?? "") : String(segment);
      return `/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    })
    .join("");
}

/** A value as JSON holds it, or undefined when JSON cannot. A bigint becomes its digits. */
function jsonScalar(value: unknown): JsonValue | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "bigint":
      return value.toString();
    case "object":
      return value === null ? null : undefined;
    case "undefined":
    case "symbol":
    case "function":
      return undefined;
  }
}

/** A limit as JSON holds it: a bigint becomes its digits. */
function limitOf(value: number | bigint): JsonValue {
  return typeof value === "bigint" ? value.toString() : value;
}

/** The JSON types, by zod's name for what a schema expects. */
const JSON_TYPES: Readonly<Record<string, string>> = {
  string: "string",
  number: "number",
  int: "integer",
  boolean: "boolean",
  null: "null",
  object: "object",
  record: "object",
  array: "array",
  tuple: "array",
};

const ARTICLES: Readonly<Record<string, string>> = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  null: "null",
  object: "an object",
  array: "an array",
};

/** The start of every detail: the field, or the whole input at the root. */
function subject(pointer: string): string {
  return pointer === "" ? "The input" : `The field ${pointer}`;
}

/** "1 character", "200 characters". */
function count(value: number | bigint, unit: string): string {
  return `${String(value)} ${unit}${value === 1 ? "" : "s"}`;
}

interface Mapped {
  readonly code: string;
  readonly detail: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

/** What a length or a size counts, for a bound's detail. */
const UNITS: Readonly<Record<string, string>> = { string: "character", array: "item", set: "item" };

function bound(
  side: "minimum" | "maximum",
  issue: { readonly origin: string; readonly inclusive?: boolean },
  limit: number | bigint,
  field: string,
): Mapped {
  const unit = UNITS[issue.origin];
  const low = side === "minimum";
  if (unit !== undefined) {
    const text = unit === "character" ? `must be ${low ? "at least" : "at most"} ${count(limit, unit)} long` : `must hold ${low ? "at least" : "at most"} ${count(limit, unit)}`;
    return { code: low ? "too-short" : "too-long", detail: `${field} ${text}.`, data: { [side]: limitOf(limit) } };
  }
  if (issue.inclusive === false) {
    return {
      code: "out-of-range",
      detail: `${field} must be ${low ? "more" : "less"} than ${String(limit)}.`,
      data: { [low ? "exclusiveMinimum" : "exclusiveMaximum"]: limitOf(limit) },
    };
  }
  return {
    code: "out-of-range",
    detail: `${field} must be ${low ? "at least" : "at most"} ${String(limit)}.`,
    data: { [side]: limitOf(limit) },
  };
}

function isFacts(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One zod issue, but unrecognized_keys, as a code, a detail and its data. */
function mapIssue(issue: Exclude<z.core.$ZodIssue, z.core.$ZodIssueUnrecognizedKeys>, field: string): Mapped {
  switch (issue.code) {
    case "invalid_type": {
      const expected = JSON_TYPES[issue.expected];
      const data = expected === undefined ? {} : { expected };
      if (issue.input === undefined) {
        return { code: "missing-field", detail: `${field} is missing.`, data };
      }
      const detail = expected === undefined ? `${field} has the wrong type.` : `${field} must be ${String(ARTICLES[expected])}.`;
      return { code: "invalid-type", detail, data };
    }
    case "too_small":
      return bound("minimum", issue, issue.minimum, field);
    case "too_big":
      return bound("maximum", issue, issue.maximum, field);
    case "invalid_value": {
      const allowed = issue.values.map(jsonScalar).filter((value) => value !== undefined);
      return {
        code: "invalid-value",
        detail: `${field} must be one of: ${allowed.map((value) => JSON.stringify(value)).join(", ")}.`,
        data: { allowed },
      };
    }
    case "invalid_format":
      return { code: "bad-format", detail: `${field} does not have the format ${issue.format}.`, data: { format: issue.format } };
    case "not_multiple_of":
      return {
        code: "invalid-value",
        detail: `${field} must be a multiple of ${String(issue.divisor)}.`,
        data: { multipleOf: limitOf(issue.divisor) },
      };
    case "invalid_union":
      return { code: "invalid-value", detail: `${field} fits none of the forms it may take.`, data: {} };
    case "invalid_key":
      return { code: "invalid-value", detail: `${field} is not a name this object allows.`, data: {} };
    case "invalid_element":
      return { code: "invalid-value", detail: `${field} holds a value that is not allowed.`, data: {} };
    case "custom": {
      // A check of NortFox's own gives its code and facts in params, and a
      // message that goes on from "The field /x".
      const params: Readonly<Record<string, unknown>> = issue.params ?? {};
      const code = params["code"];
      if (typeof code !== "string") {
        return { code: "invalid-value", detail: `${field} is not valid.`, data: {} };
      }
      const facts = params["data"];
      return { code, detail: `${field} ${issue.message}`, data: isFacts(facts) ? facts : {} };
    }
  }
}

/**
 * The field issues of a failed parse, one per field, in zod's order. Parse
 * with `reportInput: true`: a field issue then holds the value received, and
 * a missing field is told from one of the wrong type. Each detail names the
 * field by its pointer and no surface, so the same input gives the same text
 * by REST and by MCP.
 */
export function fieldIssues(issues: readonly z.core.$ZodIssue[]): FieldIssue[] {
  return issues.flatMap((issue): FieldIssue[] => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => {
        const pointer = jsonPointer([...issue.path, key]);
        return { code: "unknown-field", detail: `${subject(pointer)} is not part of this operation.`, pointer, data: {} };
      });
    }
    const pointer = jsonPointer(issue.path);
    const { code, detail, data } = mapIssue(issue, subject(pointer));
    const value = jsonScalar(issue.input);
    return [{ code, detail, pointer, data: value === undefined ? data : { ...data, value } }];
  });
}
