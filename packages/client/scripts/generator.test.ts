// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERATED_TS, OPENAPI_JSON } from "./files.ts";
import { GeneratorError, generateClient } from "./generator.ts";

function documentWith(schemas: Record<string, unknown>, paths: Record<string, unknown> = {}): unknown {
  return { openapi: "3.1.0", components: { schemas }, paths };
}

function getOperation(schema: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    get: {
      operationId: "getThing",
      responses: { "200": { content: { "application/json": { schema } } } },
      ...extra,
    },
  };
}

function refusal(input: unknown): string {
  try {
    generateClient(input);
  } catch (error) {
    if (error instanceof GeneratorError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected a GeneratorError");
}

describe("src/generated.ts", () => {
  it("is what the generator writes from openapi.json", () => {
    const document: unknown = JSON.parse(readFileSync(OPENAPI_JSON, "utf8"));
    const committed = readFileSync(GENERATED_TS, "utf8").replaceAll("\r\n", "\n");
    expect(
      committed === generateClient(document),
      "packages/client/src/generated.ts is out of date. Run `pnpm openapi` and commit the result.",
    ).toBe(true);
  });
});

describe("generateClient", () => {
  it("writes each kind of schema it supports", () => {
    const source = generateClient(
      documentWith({
        Kind: { enum: ["a", "b"] },
        Flag: { const: true },
        Thing: {
          type: "object",
          additionalProperties: false,
          required: ["name", "tags", "kind", "odd-name"],
          properties: {
            name: { type: "string", description: "Its name. Never */ closes the comment." },
            count: { type: "integer" },
            ratio: { type: "number" },
            done: { type: "boolean" },
            note: { type: ["string", "null"] },
            tags: { type: "array", items: { type: "string" } },
            either: { type: "array", items: { enum: ["x", "y"] } },
            kind: { $ref: "#/components/schemas/Kind" },
            nested: { type: "object", properties: { inner: { type: "string" } } },
            empty: { type: "object" },
            "odd-name": { const: "fixed" },
          },
        },
      }),
    );
    expect(source).toContain('export type Kind = "a" | "b";');
    expect(source).toContain("export type Flag = true;");
    expect(source).toContain("export interface Thing {");
    expect(source).toContain("Never *\\/ closes the comment.");
    expect(source).toContain("  readonly name: string;");
    expect(source).toContain("  readonly count?: number;");
    expect(source).toContain("  readonly ratio?: number;");
    expect(source).toContain("  readonly done?: boolean;");
    expect(source).toContain("  readonly note?: string | null;");
    expect(source).toContain("  readonly tags: readonly string[];");
    expect(source).toContain('  readonly either?: ReadonlyArray<"x" | "y">;');
    expect(source).toContain("  readonly kind: Kind;");
    expect(source).toContain("  readonly nested?: {\n    readonly inner?: string;\n  };");
    expect(source).toContain("  readonly empty?: Record<string, never>;");
    expect(source).toContain('  readonly "odd-name": "fixed";');
  });

  it("writes one method per GET operation, in path order", () => {
    const source = generateClient(
      documentWith(
        {},
        {
          "/v1/b": getOperation({ type: "string" }),
          "/v1/a": {
            get: {
              operationId: "getA",
              summary: "Get A",
              parameters: [],
              responses: { "201": { content: { "application/json": { schema: { type: "boolean" } } } } },
            },
          },
        },
      ),
    );
    expect(source.indexOf("getA(")).toBeLessThan(source.indexOf("getThing("));
    expect(source).toContain("  getA(options?: CallOptions): Promise<boolean>;");
    expect(source).toContain('getThing: async (options) => (await send({ method: "GET", path: "/v1/b" }, options)) as string,');
  });

  it("accepts a document without components", () => {
    expect(generateClient({ openapi: "3.1.1", paths: {} })).toContain("export interface Operations {");
  });

  it.each([
    [null, "The API description must be an object."],
    [{ openapi: "3.0.3", paths: {} }, "openapi must be 3.1.x, not 3.0.3."],
    [{ openapi: 3.1, paths: {} }, "openapi must be a string."],
    [documentWith({ Bad: { oneOf: [] } }), 'components.schemas.Bad uses "oneOf", which the generator does not support yet.'],
    [
      documentWith({ Bad: { type: "object", additionalProperties: true } }),
      'components.schemas.Bad uses "additionalProperties", which the generator does not support yet.',
    ],
    [documentWith({ Bad: { $ref: "#/definitions/X" } }), "components.schemas.Bad.$ref must point into #/components/schemas/."],
    [documentWith({ Bad: { $ref: "#/components/schemas/no-good" } }), 'components.schemas.Bad.$ref "no-good" is not a TypeScript identifier.'],
    [documentWith({ Bad: { const: 1 } }), "components.schemas.Bad.const may only hold strings or booleans."],
    [documentWith({ Bad: { enum: [] } }), "components.schemas.Bad.enum must be a list with at least one value."],
    [documentWith({ Bad: { enum: "a" } }), "components.schemas.Bad.enum must be a list with at least one value."],
    [documentWith({ Bad: {} }), "components.schemas.Bad needs a type, a $ref, a const or an enum."],
    [documentWith({ Bad: { type: "object", required: "a" } }), "components.schemas.Bad.required must be a list."],
    [documentWith({ Bad: { type: "object", properties: { a: 1 } } }), "components.schemas.Bad.properties.a must be an object."],
    [documentWith({ Bad: { type: "object", properties: { a: { type: "string", description: 1 } } } }), "components.schemas.Bad.properties.a.description must be a string."],
    [documentWith({ "1Bad": { type: "string" } }), 'components.schemas.1Bad "1Bad" is not a TypeScript identifier.'],
    [documentWith({}, { "/v1/x": { post: {} } }), 'paths["/v1/x"].post: only GET operations are supported yet.'],
    [documentWith({}, { "/v1/x/{id}": getOperation({ type: "string" }) }), 'paths["/v1/x/{id}"].get: parameters are not supported yet.'],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "q", in: "query" }] }) }),
      'paths["/v1/x"].get: parameters are not supported yet.',
    ],
    [documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: {} }) }), 'paths["/v1/x"].get: a request body is not supported yet.'],
    [documentWith({}, { "/v1/x": getOperation({ type: "string" }, { operationId: 7 }) }), 'paths["/v1/x"].get.operationId must be a string.'],
    [
      documentWith({}, { "/v1/x": { get: { operationId: "getX", responses: { "404": {} } } } }),
      'paths["/v1/x"].get.responses needs a 200 or 201 response with JSON.',
    ],
    [
      documentWith({}, { "/v1/x": { get: { operationId: "getX", responses: { "200": { content: {} } } } } }),
      'paths["/v1/x"].get.responses.200.content["application/json"] must be an object.',
    ],
  ])("refuses %j", (input, message) => {
    expect(refusal(input)).toBe(message);
  });

  it("names its error", () => {
    expect(new GeneratorError("x").name).toBe("GeneratorError");
  });
});
