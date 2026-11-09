// SPDX-License-Identifier: AGPL-3.0-only

// CI fails when packages/client/openapi.json is not what the registry gives:
// this test, and the build job's `pnpm openapi` with `git diff --exit-code`.
// The client's own test does the same for src/generated.ts.

import { IDEMPOTENCY_KEY_ARGUMENT, REGISTRY, getHealth, toolInputSchema } from "@nortfox/contract";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testListAccounts } from "../test/api.ts";
import { SHAPE_OPERATIONS } from "../test/shapes.ts";
import { openApiDocument, renderOpenApi } from "./openapi.ts";
import { OPENAPI_FILE, openApiDrift } from "./openapi-file.ts";
import { readServerVersion } from "./version.ts";

const DRIFT = "packages/client/openapi.json is out of date. Run `pnpm openapi` and commit the result.";

describe("packages/client/openapi.json", () => {
  const committed = readFileSync(OPENAPI_FILE, "utf8");

  it("matches the registry", () => {
    const drift = openApiDrift(committed, renderOpenApi(REGISTRY, readServerVersion()));
    expect(drift, drift).toBeUndefined();
  });

  it("shows a changed registry as drift", () => {
    expect(openApiDrift(committed, renderOpenApi([...REGISTRY, testListAccounts], readServerVersion()))).toBe(DRIFT);
    expect(openApiDrift(committed, renderOpenApi([getHealth], readServerVersion()))).toBe(DRIFT);
    expect(openApiDrift(committed, renderOpenApi(REGISTRY, "0.0.0-other"))).toBe(DRIFT);
  });
});

describe("the shapes of slice 2c in the API description", () => {
  interface Described {
    readonly paths: Record<string, Record<string, { readonly parameters?: unknown[]; readonly responses: Record<string, unknown>; readonly "x-nortfox": unknown }>>;
  }
  const document = openApiDocument(SHAPE_OPERATIONS, "0.0.0") as Described;
  const pathOf = (path: string, method: string) => document.paths[path]?.[method];

  it("writes each path parameter as a required parameter in the path, beside the query's", () => {
    expect(pathOf("/v1/test-things/{thingId}", "get")?.parameters).toEqual([
      { schema: { type: "string", format: "uuid", description: "The thing's id." }, required: true, description: "The thing's id.", name: "thingId", in: "path" },
      { schema: { type: "string", enum: ["short", "long"], description: "How much to show." }, required: false, description: "How much to show.", name: "view", in: "query" },
    ]);
  });

  it("writes 204 and 202 with no content, and a write's key as a required header", () => {
    const removing = pathOf("/v1/test-things/{thingId}", "delete");
    expect(removing?.responses["204"]).toEqual({ description: "Done. The answer has no body." });
    expect(removing?.parameters).toContainEqual(expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }));
    expect(pathOf("/v1/test-letters", "post")?.responses["202"]).toEqual({ description: "Accepted. The work goes on after the answer, which has no body." });
  });

  it("writes 303 with its Location header and the location as JSON", () => {
    expect(pathOf("/v1/test-redirects", "get")?.responses["303"]).toEqual({
      description: "See Other: the browser goes on to the location.",
      headers: { Location: { description: "The URL the browser goes to next.", schema: { type: "string" } } },
      content: { "application/json": { schema: { $ref: "#/components/schemas/Redirect" } } },
    });
  });

  it("writes the session mark and the company source, and no key on a write that runs before sign-in", () => {
    const signIn = pathOf("/v1/test-sign-ins", "post");
    expect(signIn?.["x-nortfox"]).toEqual({
      permission: "none",
      tool: "Signs in. Only the tests serve it.",
      assistant: false,
      writes: true,
      list: false,
      session: "flow",
      company: "none",
      personalOutput: [],
    });
    expect(signIn?.parameters).toBeUndefined();
    expect(pathOf("/v1/test-person", "get")?.["x-nortfox"]).toMatchObject({ permission: "signed-in", session: null, company: "none" });
  });
});

describe("the credentials in the API description", () => {
  interface Described {
    readonly components: { readonly securitySchemes?: Record<string, unknown> };
    readonly paths: Record<string, Record<string, { readonly operationId: string; readonly security?: unknown }>>;
  }
  const document = openApiDocument(REGISTRY, "0.0.0") as Described;
  const security = Object.fromEntries(
    Object.values(document.paths).flatMap((item) => Object.values(item).map((operation) => [operation.operationId, operation.security])),
  );

  it("names the session cookie as the scheme sessionCookie", () => {
    expect(document.components.securitySchemes).toEqual({
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-nortfox-session",
        description: "The browser's session, which a sign-in sets: verifyTotp, or loginWithPassword on a known device. The browser sends it by itself.",
      },
    });
  });

  it("names it on each operation that needs an actor, and on no other", () => {
    expect(security).toEqual({
      getHealth: undefined,
      getCompany: [{ sessionCookie: [] }],
      completeSetup: undefined,
      loginWithPassword: undefined,
      verifyTotp: undefined,
      logout: [{ sessionCookie: [] }],
      getSession: [{ sessionCookie: [] }],
      getMe: [{ sessionCookie: [] }],
      createCompany: [{ sessionCookie: [] }],
      listCompanies: [{ sessionCookie: [] }],
      listRecentCompanies: [{ sessionCookie: [] }],
      selectCompany: [{ sessionCookie: [] }],
      updateMyMembership: [{ sessionCookie: [] }],
      updateCompany: [{ sessionCookie: [] }],
      listPermissions: [{ sessionCookie: [] }],
      listUsers: [{ sessionCookie: [] }],
      getUser: [{ sessionCookie: [] }],
      updateUser: [{ sessionCookie: [] }],
      removeUser: [{ sessionCookie: [] }],
      assignProgram: [{ sessionCookie: [] }],
      removeProgram: [{ sessionCookie: [] }],
      moveProgram: [{ sessionCookie: [] }],
      updateUserRights: [{ sessionCookie: [] }],
      inviteUser: [{ sessionCookie: [] }],
      resendInvitation: [{ sessionCookie: [] }],
      disconnectUserIdentity: [{ sessionCookie: [] }],
      getInvitation: undefined,
      acceptInvitation: undefined,
      leaveCompany: [{ sessionCookie: [] }],
    });
  });

  it("names no credential for the whole description, so an operation without one needs none", () => {
    expect("security" in document).toBe(false);
  });
});

describe("the inputs in the API description and in the tools' schemas", () => {
  type Schema = Readonly<Record<string, unknown>>;
  interface Described {
    readonly components: { readonly schemas?: Record<string, Schema> };
    readonly paths: Record<
      string,
      Record<
        string,
        {
          readonly operationId: string;
          readonly parameters?: readonly { readonly name: string; readonly schema: Schema }[];
          readonly requestBody?: { readonly content: { readonly "application/json": { readonly schema: Schema } } };
        }
      >
    >;
  }
  const document = openApiDocument(REGISTRY, "0.0.0") as Described;

  /** The schema itself, or the component that it names. */
  function resolved(schema: Schema): Schema {
    const ref = schema["$ref"];
    return typeof ref === "string" ? (document.components.schemas?.[ref.replace("#/components/schemas/", "")] ?? {}) : schema;
  }

  /** The schemas that a value may meet: each branch of anyOf or oneOf, or the schema. */
  function branches(schema: Schema): Schema[] {
    const own = resolved(schema);
    const union = own["anyOf"] ?? own["oneOf"];
    return Array.isArray(union) ? (union as Schema[]).flatMap(branches) : [own];
  }

  /** Whether the schema takes null: a branch whose enum holds it, whose const is it, or whose type names it with no enum. */
  function takesNull(schema: Schema): boolean {
    return branches(schema).some((branch) => {
      const { enum: values, type } = branch;
      if (Array.isArray(values)) {
        return values.includes(null);
      }
      return branch["const"] === null || type === "null" || (Array.isArray(type) && type.includes("null"));
    });
  }

  /** The values that the schema takes when they are few: each enum, const and null; undefined when it takes others too. */
  function valuesOf(schema: Schema): unknown[] | undefined {
    const values: unknown[] = [];
    for (const branch of branches(schema)) {
      if (Array.isArray(branch["enum"])) {
        values.push(...(branch["enum"] as unknown[]));
      } else if ("const" in branch) {
        values.push(branch["const"]);
      } else if (branch["type"] === "null") {
        values.push(null);
      } else {
        return undefined;
      }
    }
    return values.sort((one, other) => JSON.stringify(one).localeCompare(JSON.stringify(other)));
  }

  /** The fields of the object branch of a schema, and the items of its array branch. */
  function partsOf(schema: Schema): { properties: Record<string, Schema>; items: Schema | undefined } {
    const object = branches(schema).find((branch) => typeof branch["properties"] === "object");
    const array = branches(schema).find((branch) => typeof branch["items"] === "object");
    return { properties: (object?.["properties"] ?? {}) as Record<string, Schema>, items: array?.["items"] as Schema | undefined };
  }

  /** Where the tool's schema and the description differ in null or in the values they take, by the field's pointer, down every field and item. */
  function differences(tool: Schema, described: Schema, pointer: string): string[] {
    const own = [
      ...(takesNull(tool) === takesNull(described) ? [] : [`${pointer}: null ${takesNull(tool) ? "taken by the tool, refused by" : "refused by the tool, taken by"} the description`]),
      ...(JSON.stringify(valuesOf(tool)) === JSON.stringify(valuesOf(described)) ? [] : [`${pointer}: the values ${JSON.stringify(valuesOf(tool))} and ${JSON.stringify(valuesOf(described))}`]),
    ];
    const toolParts = partsOf(tool);
    const describedParts = partsOf(described);
    const fields = Object.entries(toolParts.properties).flatMap(([name, field]) => {
      const other = describedParts.properties[name];
      return other === undefined ? [`${pointer}/${name}: not in the description`] : differences(field, other, `${pointer}/${name}`);
    });
    const items = toolParts.items !== undefined && describedParts.items !== undefined ? differences(toolParts.items, describedParts.items, `${pointer}/*`) : [];
    return [...own, ...fields, ...items];
  }

  /** Every input field of the operation as the description gives it: the path's and the query's parameters, and the body's fields. */
  function describedInput(operationId: string): Record<string, Schema> {
    const operation = Object.values(document.paths)
      .flatMap((item) => Object.values(item))
      .find((each) => each.operationId === operationId);
    const parameters = Object.fromEntries((operation?.parameters ?? []).map((parameter) => [parameter.name, parameter.schema]));
    const body = operation?.requestBody?.content["application/json"].schema;
    return { ...parameters, ...(body === undefined ? {} : partsOf(body).properties) };
  }

  it.each(REGISTRY.map((operation) => [operation.operationId, operation] as const))("%s takes null and the same few values in both, in every field", (operationId, operation) => {
    const described = describedInput(operationId);
    const tool = toolInputSchema(operation);
    const problems = Object.entries(partsOf(tool).properties)
      .filter(([name]) => name !== IDEMPOTENCY_KEY_ARGUMENT)
      .flatMap(([name, field]) => {
        const other = described[name];
        return other === undefined ? [`/${name}: not in the description`] : differences(field, other, `/${name}`);
      });
    expect(problems).toEqual([]);
  });

  it("sees a nullable field of a few values whose null the description leaves out", () => {
    const tool = { anyOf: [{ type: "string", const: "admin" }, { type: "null" }] };
    expect(differences(tool, { type: ["string", "null"], enum: ["admin"] }, "/adminLevel")).toEqual([
      "/adminLevel: null taken by the tool, refused by the description",
      '/adminLevel: the values ["admin",null] and ["admin"]',
    ]);
    expect(differences(tool, { type: ["string", "null"], enum: ["admin", null] }, "/adminLevel")).toEqual([]);
    expect(differences({ type: "object", properties: { level: tool } }, { type: "object", properties: { level: { type: "string", enum: ["admin"] } } }, "")).toEqual([
      "/level: null taken by the tool, refused by the description",
      '/level: the values ["admin",null] and ["admin"]',
    ]);
  });
});

describe("openApiDrift", () => {
  it("passes the same text, also with Windows line ends", () => {
    expect(openApiDrift('{\n  "a": 1\n}\n', '{\n  "a": 1\n}\n')).toBeUndefined();
    expect(openApiDrift('{\r\n  "a": 1\r\n}\r\n', '{\n  "a": 1\n}\n')).toBeUndefined();
  });

  it("fails on a changed file and names the command that fixes it", () => {
    expect(openApiDrift('{"a":1}\n', '{"a":2}\n')).toBe(DRIFT);
  });
});
