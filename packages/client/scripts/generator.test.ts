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

/** The scheme of a browser's session: a cookie, which the browser sends by itself. */
const SESSION_SCHEME: Record<string, unknown> = {
  sessionCookie: { type: "apiKey", in: "cookie", name: "__Host-x", description: "The session." },
};

/** A description with these security schemes and one path, /v1/x. */
function withSchemes(securitySchemes: unknown, item: unknown): unknown {
  return { openapi: "3.1.0", components: { securitySchemes }, paths: { "/v1/x": item } };
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

  it("has every interface it declares exported by the package, so a program can name each input and answer", () => {
    const declared = [...readFileSync(GENERATED_TS, "utf8").matchAll(/^export interface (\w+)/gm)].map((match) => match[1]);
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const exported = /^export type \{([^}]*)\} from "\.\/generated\.ts";$/m.exec(index)?.[1]?.split(",").map((name) => name.trim()) ?? [];
    expect(declared.length).toBeGreaterThan(5);
    expect(exported).toEqual(declared);
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
    expect(source).toContain('  readonly either?: readonly ("x" | "y")[];');
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
    expect(source).toContain('getThing: async (options) => (await send({ method: "GET", path: "/v1/b" }, undefined, options)) as string,');
    expect(source).toContain('import type { CallOptions, Send } from "./runtime.ts";');
  });

  it("accepts a document without components", () => {
    expect(generateClient({ openapi: "3.1.1", paths: {} })).toContain("export interface Operations {");
  });

  it("passes over the keys that only document", () => {
    const source = generateClient({
      openapi: "3.1.0",
      info: { title: "Zorbex API", version: "1.0.0" },
      tags: [{ name: "kilvant" }],
      externalDocs: { url: "https://docs.example.com" },
      webhooks: {},
      paths: {
        "/v1/x": {
          summary: "The x",
          description: "All about x.",
          get: {
            operationId: "getX",
            tags: ["kilvant"],
            externalDocs: { url: "https://docs.example.com/x" },
            responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
          },
        },
      },
    });
    expect(source).toContain("  getX(options?: CallOptions): Promise<string>;");
  });

  it("writes the permission from x-nortfox into the method's doc comment", () => {
    const source = generateClient(
      documentWith(
        {},
        {
          "/v1/company": getOperation(
            { type: "string" },
            {
              operationId: "getCompany",
              summary: "Read the company",
              "x-nortfox": { permission: "company:read", tool: "Gives the company.", assistant: true, writes: false, list: false },
            },
          ),
          "/v1/health": getOperation({ type: "string" }, { operationId: "getHealth", "x-nortfox": { permission: "public" } }),
        },
      ),
    );
    expect(source).toContain(
      "  /**\n   * Read the company\n   *\n   * `GET /v1/company`\n   *\n   * Needs the permission `company:read`.\n   */\n  getCompany(",
    );
    expect(source).toContain("   * `GET /v1/health`\n   *\n   * Needs no permission: it reads no data.\n   */\n  getHealth(");
  });

  it("writes the session mark, the company source and the permissions of the sign-in into the doc comment", () => {
    const meta = (extra: Record<string, unknown>) => ({ permission: "company:read", tool: "T.", assistant: false, writes: false, list: false, session: null, company: "credential", ...extra });
    const source = generateClient(
      documentWith(
        {},
        {
          "/v1/a": getOperation({ type: "string" }, { operationId: "getA", "x-nortfox": meta({}) }),
          "/v1/b": getOperation({ type: "string" }, { operationId: "getB", "x-nortfox": meta({ permission: "none", session: "flow", company: "none" }) }),
          "/v1/c": getOperation({ type: "string" }, { operationId: "getC", "x-nortfox": meta({ permission: "signed-in", company: "none" }) }),
        },
      ),
    );
    expect(source).toContain("   * `GET /v1/a`\n   *\n   * Needs the permission `company:read`, in the company that the credential names.\n   */\n  getA(");
    expect(source).toContain(
      "   * `GET /v1/b`\n   *\n   * Needs no actor: anyone may call it, before signing in.\n   *\n   * Serves the browser's session: its MCP tool refuses every call.\n   */\n  getB(",
    );
    expect(source).toContain("   * `GET /v1/c`\n   *\n   * Needs a signed-in person, and works in no company.\n   */\n  getC(");
  });

  it("writes a method for each method of a path, in path order and then method order", () => {
    const answer = { responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } } };
    const source = generateClient(
      documentWith(
        {},
        {
          "/v1/x": {
            delete: { operationId: "removeX", ...answer },
            patch: { operationId: "changeX", ...answer },
            post: { operationId: "makeX", ...answer },
            put: { operationId: "putX", ...answer },
            get: { operationId: "getX", ...answer },
          },
        },
      ),
    );
    const order = ["getX(", "putX(", "makeX(", "removeX(", "changeX("].map((name) => source.indexOf(`  ${name}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(source).toContain('makeX: async (options) => (await send({ method: "POST", path: "/v1/x" }, undefined, options)) as string,');
    expect(source).toContain('putX: async (options) => (await send({ method: "PUT", path: "/v1/x" }, undefined, options)) as string,');
    expect(source).toContain('changeX: async (options) => (await send({ method: "PATCH", path: "/v1/x" }, undefined, options)) as string,');
    expect(source).toContain('removeX: async (options) => (await send({ method: "DELETE", path: "/v1/x" }, undefined, options)) as string,');
    expect(source).toContain("   * `DELETE /v1/x`\n");
  });

  it("takes the path parameters and the query as the input's fields, and names them in the call", () => {
    const source = generateClient(
      documentWith(
        { Thing: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        {
          "/v1/things/{thingId}": {
            get: {
              operationId: "getThing",
              parameters: [
                { schema: { type: "string", format: "uuid" }, required: true, description: "The thing's id.", name: "thingId", in: "path" },
                { schema: { type: "string", enum: ["short", "long"] }, required: false, name: "view", in: "query" },
                { schema: { type: "integer" }, name: "limit", in: "query" },
              ],
              responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } } } },
            },
          },
        },
      ),
    );
    expect(source).toContain(
      [
        "  getThing(",
        "    input: {",
        "      /**",
        "       * The thing's id.",
        "       */",
        "      readonly thingId: string;",
        '      readonly view?: "short" | "long";',
        "      readonly limit?: number;",
        "    },",
        "    options?: CallOptions,",
        "  ): Promise<Thing>;",
      ].join("\n"),
    );
    expect(source).toContain(
      '    getThing: async (input, options) => (await send({ method: "GET", path: "/v1/things/{thingId}", params: ["thingId"], query: ["view", "limit"] }, input, options)) as Thing,',
    );
  });

  it("takes a JSON body into the input beside the parameters, and requires the key option of a write that takes one", () => {
    const key = { schema: { type: "string", pattern: "^x$" }, required: true, name: "Idempotency-Key", in: "header" };
    const source = generateClient(
      documentWith(
        { Change: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        {
          "/v1/things/{thingId}": {
            patch: {
              operationId: "changeThing",
              parameters: [{ schema: { type: "string" }, required: true, name: "thingId", in: "path" }, key],
              requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Change" } } } },
              responses: { "204": { description: "Done." } },
            },
          },
          "/v1/things": {
            post: {
              operationId: "makeThing",
              parameters: [key],
              requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } },
              responses: { "201": { content: { "application/json": { schema: { type: "string" } } } } },
            },
          },
          "/v1/sessions": {
            delete: { operationId: "endSession", parameters: [key], responses: { "204": { description: "Done." } } },
          },
        },
      ),
    );
    expect(source).toContain("  changeThing(\n    input: {\n      readonly thingId: string;\n    } & Change,\n    options: WriteOptions,\n  ): Promise<void>;");
    expect(source).toContain(
      '    changeThing: async (input, options) => { await send({ method: "PATCH", path: "/v1/things/{thingId}", params: ["thingId"], body: true, key: true, answer: "none" }, input, options); },',
    );
    expect(source).toContain("  makeThing(\n    input: {\n      readonly name?: string;\n    },\n    options: WriteOptions,\n  ): Promise<string>;");
    expect(source).toContain('    makeThing: async (input, options) => (await send({ method: "POST", path: "/v1/things", body: true, key: true }, input, options)) as string,');
    expect(source).toContain("  endSession(options: WriteOptions): Promise<void>;");
    expect(source).toContain('    endSession: async (options) => { await send({ method: "DELETE", path: "/v1/sessions", key: true, answer: "none" }, undefined, options); },');
    // Every method here takes a key, so CallOptions alone would be an unused import.
    expect(source).toContain('import type { Send, WriteOptions } from "./runtime.ts";');
  });

  it("lets a call leave out an input whose fields are all optional, such as a list's, and quotes a name that is no identifier", () => {
    const source = generateClient(
      documentWith(
        {},
        {
          "/v1/things": {
            get: {
              operationId: "listThings",
              parameters: [
                { schema: { type: "integer" }, required: false, name: "limit", in: "query" },
                { schema: { type: "string" }, required: false, name: "sort-by", in: "query" },
              ],
              responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
            },
          },
        },
      ),
    );
    expect(source).toContain('  listThings(\n    input?: {\n      readonly limit?: number;\n      readonly "sort-by"?: string;\n    },\n    options?: CallOptions,\n  ): Promise<string>;');
    expect(source).toContain('query: ["limit", "sort-by"]');
  });

  it("gives nothing for 202, and the location of a 303, which it asks fetch not to follow", () => {
    const source = generateClient(
      documentWith(
        { Redirect: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } },
        {
          "/v1/letters": { post: { operationId: "sendLetter", responses: { "202": { description: "Accepted." } } } },
          "/v1/starts": {
            get: {
              operationId: "start",
              responses: {
                "303": {
                  headers: { Location: { schema: { type: "string" } } },
                  content: { "application/json": { schema: { $ref: "#/components/schemas/Redirect" } } },
                },
              },
            },
          },
        },
      ),
    );
    expect(source).toContain("  sendLetter(options?: CallOptions): Promise<void>;");
    expect(source).toContain('    sendLetter: async (options) => { await send({ method: "POST", path: "/v1/letters", answer: "none" }, undefined, options); },');
    expect(source).toContain("  start(options?: CallOptions): Promise<Redirect>;");
    expect(source).toContain('    start: async (options) => (await send({ method: "GET", path: "/v1/starts", answer: "redirect" }, undefined, options)) as Redirect,');
  });

  it("passes over the problem answers beside the success", () => {
    const source = generateClient(
      documentWith(
        { Problem: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
        {
          "/v1/x": getOperation(
            { type: "boolean" },
            {
              responses: {
                "200": { content: { "application/json": { schema: { type: "boolean" } } } },
                "400": { content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
                "401": {
                  headers: { "WWW-Authenticate": { schema: { type: "string" } } },
                  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
                },
              },
            },
          ),
        },
      ),
    );
    expect(source).toContain("  getThing(options?: CallOptions): Promise<boolean>;");
    expect(source).toContain("export interface Problem {\n  readonly code: string;\n}");
  });

  it("writes an object of any facts as a record", () => {
    const source = generateClient(
      documentWith({
        Facts: {
          type: "object",
          properties: { data: { type: "object", additionalProperties: {}, description: "The facts." } },
        },
      }),
    );
    expect(source).toContain("  readonly data?: Readonly<Record<string, unknown>>;");
  });

  it("writes nothing for a path item without an operation", () => {
    expect(generateClient(documentWith({}, { "/v1/x": { summary: "Not yet" } }))).toContain(
      "export interface Operations {\n}",
    );
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
    [
      documentWith({ Bad: { type: "object", additionalProperties: { type: "string" } } }),
      'components.schemas.Bad uses "additionalProperties", which the generator does not support yet.',
    ],
    [
      documentWith({ Bad: { type: "object", additionalProperties: {}, properties: { a: { type: "string" } } } }),
      'components.schemas.Bad uses "additionalProperties", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { "x-nortfox": "company:read" }) }),
      'paths["/v1/x"].get.x-nortfox must be an object.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { "x-nortfox": { tool: "Reads x." } }) }),
      'paths["/v1/x"].get.x-nortfox.permission must be a string.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { "x-nortfox": { permission: "public", zorbex: true } }) }),
      'paths["/v1/x"].get.x-nortfox uses "zorbex", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { "x-kilvant": true }) }),
      'paths["/v1/x"].get uses "x-kilvant", which the generator does not support yet.',
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
    [documentWith({}, { "/v1/x": { post: {} } }), 'paths["/v1/x"].post.operationId must be a string.'],
    [documentWith({}, { "/v1/x": { put: 1 } }), 'paths["/v1/x"].put must be an object.'],
    [
      documentWith({}, { "/v1/x": { ...(getOperation({ type: "string" }) as object), head: {} } }),
      'paths["/v1/x"].head: only GET, PUT, POST, DELETE and PATCH operations are supported yet.',
    ],
    [documentWith({}, { "/v1/x": { options: {} } }), 'paths["/v1/x"].options: only GET, PUT, POST, DELETE and PATCH operations are supported yet.'],
    [documentWith({}, { "/v1/x": { trace: {} } }), 'paths["/v1/x"].trace: only GET, PUT, POST, DELETE and PATCH operations are supported yet.'],
    [documentWith({}, { "/v1/x": { query: {} } }), 'paths["/v1/x"].query: only GET, PUT, POST, DELETE and PATCH operations are supported yet.'],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { "x-nortfox": { permission: "public", session: "only" } }) }),
      'paths["/v1/x"].get.x-nortfox.session is "only", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { "x-nortfox": { permission: "public", company: "current" } }) }),
      'paths["/v1/x"].get.x-nortfox.company is "current", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { "x-nortfox": { permission: "public", company: { input: "companyId" } } }) }),
      'paths["/v1/x"].get.x-nortfox.company is {"input":"companyId"}, which the generator does not support yet.',
    ],
    [
      documentWith({}, {
        "/v1/x": { ...(getOperation({ type: "string" }) as object), parameters: [{ name: "q", in: "query", required: true }] },
      }),
      'paths["/v1/x"] uses "parameters", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": { $ref: "#/components/pathItems/X" } }),
      'paths["/v1/x"] uses "$ref", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": { ...(getOperation({ type: "string" }) as object), servers: [{ url: "https://x.example" }] } }),
      'paths["/v1/x"] uses "servers", which the generator does not support yet.',
    ],
    [documentWith({}, { "/v1/x": { GET: {} } }), 'paths["/v1/x"] uses "GET", which the generator does not support yet.'],
    [documentWith({}, { "/v1/x": { "x-zorbex": true } }), 'paths["/v1/x"] uses "x-zorbex", which the generator does not support yet.'],
    [documentWith({}, { "/v1/x/{id}": getOperation({ type: "string" }) }), 'paths["/v1/x/{id}"].get: the path names {id}, and no path parameter has that name.'],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] }) }),
      'paths["/v1/x"].get.parameters[0]: the path parameter id is not in the path.',
    ],
    [
      documentWith({}, { "/v1/x/{id}": getOperation({ type: "string" }, { parameters: [{ name: "id", in: "path", schema: { type: "string" } }] }) }),
      'paths["/v1/x/{id}"].get.parameters[0]: a path parameter must be required.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "q", in: "query" }] }) }),
      'paths["/v1/x"].get.parameters[0].schema must be an object.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "q", in: "cookie", schema: { type: "string" } }] }) }),
      'paths["/v1/x"].get.parameters[0] is in "cookie", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "all", in: "query", schema: { type: "boolean" } }] }) }),
      'paths["/v1/x"].get.parameters[0]: the query field all has the type "boolean". A query field is a string, an integer or a number.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } }] }) }),
      'paths["/v1/x"].get.parameters[0]: the query field tags has the type "array". A query field is a string, an integer or a number.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "note", in: "query", schema: { anyOf: [{ type: "string" }, { type: "null" }] } }] }) }),
      'paths["/v1/x"].get.parameters[0]: the query field note has no type. A query field is a string, an integer or a number.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "X-Other", in: "header", schema: { type: "string" } }] }) }),
      'paths["/v1/x"].get.parameters[0] is the header "X-Other", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" } }] }) }),
      'paths["/v1/x"].get.parameters[0]: the Idempotency-Key header must be required.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "q", in: "query", schema: { type: "string" }, style: "form" }] }) }),
      'paths["/v1/x"].get.parameters[0] uses "style", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "q", in: "query", schema: { type: "string" }, required: "yes" }] }) }),
      'paths["/v1/x"].get.parameters[0].required must be true or false.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: 1, in: "query", schema: { type: "string" } }] }) }),
      'paths["/v1/x"].get.parameters[0].name must be a string.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [{ name: "q", in: "query", schema: { type: "string" } }, { name: "q", in: "query", schema: { type: "string" } }] }) }),
      'paths["/v1/x"].get.parameters[1]: the name q is given twice.',
    ],
    [documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: [1] }) }), 'paths["/v1/x"].get.parameters[0] must be an object.'],
    [documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: { q: 1 } }) }), 'paths["/v1/x"].get.parameters must be a list.'],
    [documentWith({}, { "/v1/x": getOperation({ type: "string" }, { parameters: null }) }), 'paths["/v1/x"].get.parameters must be a list.'],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { security: [{ bearer: [] }] }) }),
      'paths["/v1/x"].get.security[0] names the security scheme "bearer", which components.securitySchemes does not hold.',
    ],
    [
      withSchemes(SESSION_SCHEME, getOperation({ type: "string" }, { security: { sessionCookie: [] } })),
      'paths["/v1/x"].get.security must be a list.',
    ],
    [withSchemes(SESSION_SCHEME, getOperation({ type: "string" }, { security: [1] })), 'paths["/v1/x"].get.security[0] must be an object.'],
    [withSchemes(SESSION_SCHEME, getOperation({ type: "string" }, { security: [{}] })), 'paths["/v1/x"].get.security[0] must name one security scheme.'],
    [
      withSchemes({ ...SESSION_SCHEME, other: SESSION_SCHEME["sessionCookie"] }, getOperation({ type: "string" }, { security: [{ sessionCookie: [], other: [] }] })),
      'paths["/v1/x"].get.security[0] must name one security scheme.',
    ],
    [
      withSchemes(SESSION_SCHEME, getOperation({ type: "string" }, { security: [{ sessionCookie: ["read"] }] })),
      'paths["/v1/x"].get.security[0].sessionCookie must be an empty list: a cookie takes no scopes.',
    ],
    [
      withSchemes(SESSION_SCHEME, getOperation({ type: "string" }, { security: [{ sessionCookie: {} }] })),
      'paths["/v1/x"].get.security[0].sessionCookie must be an empty list: a cookie takes no scopes.',
    ],
    [
      withSchemes({ bearer: { type: "http", scheme: "bearer" } }, getOperation({ type: "string" })),
      "components.securitySchemes.bearer is not an apiKey in a cookie, the one kind of scheme the generator supports yet.",
    ],
    [
      withSchemes({ key: { type: "apiKey", in: "header", name: "X-Key" } }, getOperation({ type: "string" })),
      "components.securitySchemes.key is not an apiKey in a cookie, the one kind of scheme the generator supports yet.",
    ],
    [
      withSchemes({ sessionCookie: { type: "apiKey", in: "cookie", name: "__Host-x", scheme: "x" } }, getOperation({ type: "string" })),
      'components.securitySchemes.sessionCookie uses "scheme", which the generator does not support yet.',
    ],
    [
      withSchemes({ sessionCookie: { type: "apiKey", in: "cookie", name: 7 } }, getOperation({ type: "string" })),
      "components.securitySchemes.sessionCookie.name must be a string.",
    ],
    [withSchemes({ sessionCookie: "cookie" }, getOperation({ type: "string" })), "components.securitySchemes.sessionCookie must be an object."],
    [withSchemes([], getOperation({ type: "string" })), "components.securitySchemes must be an object."],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { servers: [{ url: "https://x.example" }] }) }),
      'paths["/v1/x"].get uses "servers", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { callbacks: {} }) }),
      'paths["/v1/x"].get uses "callbacks", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { deprecated: true }) }),
      'paths["/v1/x"].get uses "deprecated", which the generator does not support yet.',
    ],
    [
      { openapi: "3.1.0", paths: {}, servers: [{ url: "https://x.example/api" }] },
      'The API description uses "servers", which the generator does not support yet.',
    ],
    [
      { openapi: "3.1.0", paths: {}, security: [{ bearer: [] }] },
      'The API description uses "security", which the generator does not support yet.',
    ],
    [
      { openapi: "3.1.0", paths: {}, jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema" },
      'The API description uses "jsonSchemaDialect", which the generator does not support yet.',
    ],
    [
      { openapi: "3.1.0", paths: {}, webhooks: { kilvant: { post: {} } } },
      'The API description uses "webhooks", which the generator does not support yet.',
    ],
    [{ openapi: "3.1.0", paths: {}, webhooks: [] }, "webhooks must be an object."],
    [documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: {} }) }), 'paths["/v1/x"].get.requestBody must be required, with an application/json schema.'],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: { required: false, content: { "application/json": { schema: { type: "object" } } } } }) }),
      'paths["/v1/x"].get.requestBody must be required, with an application/json schema.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: { required: true, content: {} } }) }),
      'paths["/v1/x"].get.requestBody must be required, with an application/json schema.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: { required: true, content: { "application/json": {} } } }) }),
      'paths["/v1/x"].get.requestBody must be required, with an application/json schema.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } } }) }),
      'paths["/v1/x"].get.requestBody: a GET takes no body, which fetch cannot send.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: { required: true, content: { "text/plain": { schema: { type: "string" } } } } }) }),
      'paths["/v1/x"].get.requestBody uses "text/plain", which the generator does not support yet.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: { required: true, content: { "application/json": { schema: { type: "string" } } } } }) }),
      'paths["/v1/x"].get.requestBody\'s schema must be an object or a $ref to one.',
    ],
    [
      documentWith({}, { "/v1/x": getOperation({ type: "string" }, { requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } } }) }),
      'paths["/v1/x"].get.requestBody\'s schema must be an object or a $ref to one.',
    ],
    [
      documentWith(
        {},
        { "/v1/x": { get: { operationId: "getX", responses: { "200": { content: { "application/json": { schema: { type: "string" } } } }, "204": { description: "None." } } } } },
      ),
      'paths["/v1/x"].get.responses has more than one success answer: 200, 204.',
    ],
    [
      documentWith({}, { "/v1/x": { get: { operationId: "getX", responses: { "204": { content: { "application/json": { schema: { type: "string" } } } } } } } }),
      'paths["/v1/x"].get.responses.204 has content, but 204 answers with no body.',
    ],
    [
      documentWith({}, { "/v1/x": { get: { operationId: "getX", responses: { "302": { description: "Found." } } } } }),
      'paths["/v1/x"].get.responses answers 302, which the generator does not support yet.',
    ],
    [documentWith({}, { "/v1/x": getOperation({ type: "string" }, { operationId: 7 }) }), 'paths["/v1/x"].get.operationId must be a string.'],
    [
      documentWith({}, { "/v1/x": { get: { operationId: "getX", responses: { "404": {} } } } }),
      'paths["/v1/x"].get.responses needs a success answer: 200 or 201 with JSON, 202 or 204, or 303 with JSON.',
    ],
    [
      documentWith({}, { "/v1/x": { get: { operationId: "getX", responses: { "200": { content: {} } } } } }),
      'paths["/v1/x"].get.responses.200.content["application/json"] must be an object.',
    ],
  ])("refuses %j", (input, message) => {
    expect(refusal(input)).toBe(message);
  });

  it("writes an operation's credential, a cookie, into its doc comment, and none for an operation that names none", () => {
    const source = generateClient({
      openapi: "3.1.0",
      components: { securitySchemes: SESSION_SCHEME },
      paths: {
        "/v1/x": getOperation({ type: "string" }, { security: [{ sessionCookie: [] }] }),
        "/v1/y": { get: { operationId: "getY", responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } }, security: [] } },
        "/v1/z": { get: { operationId: "getZ", responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } } } },
      },
    });
    expect(source).toContain(["   * `GET /v1/x`", "   *", "   * Credential: the cookie `__Host-x`.", "   */", "  getThing("].join("\n"));
    expect(source).toContain(["   * `GET /v1/y`", "   */", "  getY("].join("\n"));
    expect(source).toContain(["   * `GET /v1/z`", "   */", "  getZ("].join("\n"));
    expect(source.match(/Credential:/g)).toHaveLength(1);
  });

  it("names its error", () => {
    expect(new GeneratorError("x").name).toBe("GeneratorError");
  });
});
