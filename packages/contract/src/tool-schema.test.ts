// SPDX-License-Identifier: AGPL-3.0-only

// The MCP tool schemas, each written out here as the literal a client sees,
// so a change to them shows in this file's diff. Nothing here is computed by
// the functions under test.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IDEMPOTENCY_KEY_ARGUMENT, IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key.ts";
import { Money } from "./money.ts";
import { defineListOperation, defineOperation } from "./operation.ts";
import { getCompany } from "./operations/companies.ts";
import { getHealth } from "./operations/status.ts";
import { jsonSchemaOf, toolInputSchema, toolOutputSchema } from "./tool-schema.ts";

const UUID = {
  type: "string",
  format: "uuid",
  pattern:
    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
};

const MONEY = {
  type: "object",
  description: "An amount: a decimal string and its ISO 4217 currency code. Never a JSON number.",
  properties: {
    amount: {
      type: "string",
      pattern: "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$",
      description: 'The amount as a decimal string, such as "1234.50" or "-0.05", with no more decimals than its currency has.',
      examples: ["1234.50"],
    },
    currency: {
      type: "string",
      enum: ["SEK"],
      description: "The currency's ISO 4217 code. This install knows SEK.",
    },
  },
  required: ["amount", "currency"],
  additionalProperties: false,
};

const KEY = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  pattern: "^[\\x21\\x23-\\x5b\\x5d-\\x7e]+$",
  description:
    'A key you choose for this write, 1 to 255 characters of visible ASCII without " and \\. Send the same key with the same input again, and you get the first answer back instead of a second write.',
};

const bookSample = defineOperation({
  id: "bookSample",
  method: "post",
  path: "/v1/samples",
  tags: ["samples"],
  summary: "Book a sample",
  description: "Books a sample.",
  body: z.strictObject({
    description: z.string().min(1).max(200).meta({ description: "What the sample is for." }),
    amount: Money,
  }),
  output: z.strictObject({ id: z.uuid(), amount: Money }),
  status: 201,
  permission: "test:write",
  tool: "Books a sample.",
  writes: true,
});

const listSamples = defineListOperation({
  id: "listSamples",
  method: "get",
  path: "/v1/samples",
  tags: ["samples"],
  summary: "List the samples",
  description: "Lists the samples.",
  item: z.strictObject({ id: z.uuid(), number: z.int().min(1) }),
  permission: "test:read",
  tool: "Lists the samples.",
});

describe("toolInputSchema", () => {
  it("is an empty strict object for an operation without input", () => {
    const empty = { type: "object", properties: {}, additionalProperties: false };
    expect(toolInputSchema(getCompany)).toEqual(empty);
    expect(toolInputSchema(getHealth)).toEqual(empty);
  });

  it("is the body's fields and the idempotency key for a write, Money nested and strict", () => {
    expect(toolInputSchema(bookSample)).toEqual({
      type: "object",
      properties: {
        description: { type: "string", minLength: 1, maxLength: 200, description: "What the sample is for." },
        amount: MONEY,
        idempotencyKey: KEY,
      },
      required: ["description", "amount", "idempotencyKey"],
      additionalProperties: false,
    });
  });

  it("is limit and cursor for a list: limit an integer with its default and no safe-integer bounds", () => {
    expect(toolInputSchema(listSamples)).toEqual({
      type: "object",
      properties: {
        limit: {
          type: "integer",
          default: 100,
          description: "How many items a page holds: from 1 to 500. Any other whole number gives 100.",
        },
        cursor: {
          type: "string",
          description: "Where the page starts: the nextCursor of the page before. Leave it out for the first page.",
        },
      },
      additionalProperties: false,
    });
  });

  it("names the key argument and its alphabet", () => {
    expect(IDEMPOTENCY_KEY_ARGUMENT).toBe("idempotencyKey");
    expect(IDEMPOTENCY_KEY_PATTERN).toBe("^[\\x21\\x23-\\x5b\\x5d-\\x7e]+$");
  });
});

describe("toolOutputSchema", () => {
  it("is the company for getCompany", () => {
    expect(toolOutputSchema(getCompany)).toEqual({
      type: "object",
      description: "The company the request works in. Every data request works in exactly one company.",
      properties: {
        id: { ...UUID, description: "The company's id." },
        name: { type: "string", description: "The company's name." },
        organizationNumber: {
          type: "string",
          pattern: "^[0-9]{6}-[0-9]{4}$",
          description:
            "The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.",
        },
        databaseNumber: {
          type: "integer",
          minimum: 1,
          maximum: 2147483647,
          description: "The company's number for programs, its tenant id. It never changes.",
        },
      },
      required: ["id", "name", "organizationNumber", "databaseNumber"],
      additionalProperties: false,
    });
  });

  it("is the health for getHealth", () => {
    expect(toolOutputSchema(getHealth)).toEqual({
      type: "object",
      description: "Whether the server is up.",
      properties: {
        status: { type: "string", const: "ok", description: 'Always "ok" when the server answers.' },
        version: { type: "string", description: "The version of the server that answered.", examples: ["0.0.0"] },
      },
      required: ["status", "version"],
      additionalProperties: false,
    });
  });

  it("is the output for a write, Money inlined, so a client needs no $defs", () => {
    expect(toolOutputSchema(bookSample)).toEqual({
      type: "object",
      properties: { id: UUID, amount: MONEY },
      required: ["id", "amount"],
      additionalProperties: false,
    });
  });

  it("is a page for a list", () => {
    expect(toolOutputSchema(listSamples)).toEqual({
      type: "object",
      description: "A page of the list.",
      properties: {
        items: {
          type: "array",
          description: "The items of this page, in the list's order.",
          items: {
            type: "object",
            properties: {
              id: UUID,
              number: { type: "integer", minimum: 1, maximum: 9007199254740991 },
            },
            required: ["id", "number"],
            additionalProperties: false,
          },
        },
        nextCursor: {
          type: "string",
          description: "Where the next page starts. It is absent on the last page.",
        },
        total: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description: "How many items the whole list holds.",
        },
      },
      required: ["items", "total"],
      additionalProperties: false,
    });
  });
});

describe("jsonSchemaOf", () => {
  it("inlines every reference, also one inside another", () => {
    const Inner = z.strictObject({ n: z.string() }).meta({ id: "SampleInner" });
    const Outer = z.strictObject({ inner: Inner, list: z.array(Inner) }).meta({ id: "SampleOuter" });
    const inner = { type: "object", properties: { n: { type: "string" } }, required: ["n"], additionalProperties: false };
    expect(jsonSchemaOf(z.strictObject({ outer: Outer }), "output")).toEqual({
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { inner, list: { type: "array", items: inner } },
          required: ["inner", "list"],
          additionalProperties: false,
        },
      },
      required: ["outer"],
      additionalProperties: false,
    });
  });

  it("refuses a schema that holds itself, which no inlining can write", () => {
    interface Node {
      readonly next?: Node | undefined;
    }
    const Node: z.ZodType<Node> = z.strictObject({ next: z.lazy(() => Node).optional() });
    expect(() => jsonSchemaOf(Node, "input")).toThrow("A tool schema cannot hold itself");
  });

  it("refuses a reference that points outside the schema", () => {
    const Odd = z.string().meta({ $ref: "https://schemas.example.com/odd" });
    expect(() => jsonSchemaOf(Odd, "input")).toThrow('A tool schema refers to "https://schemas.example.com/odd"');
  });
});
