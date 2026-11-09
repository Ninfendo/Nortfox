// SPDX-License-Identifier: AGPL-3.0-only

// The MCP tool schemas, each written out here as the literal a client sees,
// so a change to them shows in this file's diff. Nothing here is computed by
// the functions under test.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IDEMPOTENCY_KEY_ARGUMENT, IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key.ts";
import { Money } from "./money.ts";
import { NoBody, Redirect, defineListOperation, defineOperation } from "./operation.ts";
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

  it("is the path parameters, the query's fields, the body's fields and the key, in that order, for a write with all four", () => {
    const renameSample = defineOperation({
      id: "renameSample",
      method: "patch",
      path: "/v1/samples/{sampleId}",
      tags: ["samples"],
      summary: "Rename a sample",
      description: "Renames a sample.",
      params: z.strictObject({ sampleId: z.uuid().meta({ description: "The sample's id." }) }),
      query: z.strictObject({ dryRun: z.enum(["yes", "no"]).optional() }),
      body: z.strictObject({ name: z.string().min(1) }),
      output: NoBody,
      status: 204,
      permission: "test:write",
      tool: "Renames a sample.",
      writes: true,
    });
    expect(toolInputSchema(renameSample)).toEqual({
      type: "object",
      properties: {
        sampleId: { ...UUID, description: "The sample's id." },
        dryRun: { type: "string", enum: ["yes", "no"] },
        name: { type: "string", minLength: 1 },
        idempotencyKey: KEY,
      },
      required: ["sampleId", "name", "idempotencyKey"],
      additionalProperties: false,
    });
  });

  it("takes no key for a write that runs before sign-in", () => {
    const signIn = defineOperation({
      id: "signInSample",
      method: "post",
      path: "/v1/sample-sign-ins",
      tags: ["samples"],
      summary: "Sign in",
      description: "Signs in.",
      body: z.strictObject({ email: z.string() }),
      output: z.strictObject({ step: z.string() }),
      permission: "none",
      session: "flow",
      tool: "Signs in.",
      writes: true,
    });
    expect(toolInputSchema(signIn)).toEqual({
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
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
    const text = (description: string): { readonly type: "string"; readonly description: string } => ({ type: "string", description: `${description} Absent when it is not set.` });
    const country = (description: string): { readonly type: "string"; readonly pattern: string; readonly description: string } => ({
      ...text(description),
      pattern: "^[A-Z]{2}$",
    });
    expect(toolOutputSchema(getCompany)).toEqual({
      type: "object",
      description: "A company: its id, name, organisation number and tenant id, and its postal and visiting addresses and contact details when they are set.",
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
        address: text("Adress: the postal address's street or box line."),
        zipCode: text("Postnummer: the postal address's postal code."),
        city: text("Ort: the postal address's town."),
        countryCode: country("Land: the postal address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE."),
        visitAddress: text("Besöksadress: the visiting address's street."),
        visitZipCode: text("The visiting address's postal code."),
        visitCity: text("The visiting address's town."),
        visitCountryCode: country("The visiting address's country, as its code in ISO 3166-1 alpha-2, two capital letters such as SE."),
        phone: text("Telefon: the company's phone number."),
        email: text("E-post: the company's e-mail address."),
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

  it("is the empty object for an answer without a body, and the location for a redirect", () => {
    const end = defineOperation({
      id: "endSample",
      method: "delete",
      path: "/v1/samples",
      tags: ["samples"],
      summary: "End",
      description: "Ends.",
      output: NoBody,
      status: 204,
      permission: "test:write",
      tool: "Ends.",
      writes: true,
    });
    expect(toolOutputSchema(end)).toEqual({
      type: "object",
      description: "Nothing: REST answers with no body, MCP with an empty object.",
      properties: {},
      additionalProperties: false,
    });
    const start = defineOperation({
      id: "startSample",
      method: "get",
      path: "/v1/sample-starts",
      tags: ["samples"],
      summary: "Start",
      description: "Starts.",
      output: Redirect,
      status: 303,
      permission: "none",
      session: "flow",
      tool: "Starts.",
      writes: true,
    });
    expect(toolOutputSchema(start)).toEqual({
      type: "object",
      description: "Where the browser goes next.",
      properties: { location: { type: "string", description: "The URL the browser goes to next. REST sends it in the Location header too." } },
      required: ["location"],
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
