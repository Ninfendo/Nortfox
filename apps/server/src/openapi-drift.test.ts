// SPDX-License-Identifier: AGPL-3.0-only

// CI fails when packages/client/openapi.json is not what the registry gives:
// this test, and the build job's `pnpm openapi` with `git diff --exit-code`.
// The client's own test does the same for src/generated.ts.

import { REGISTRY, getHealth } from "@nortfox/contract";
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
    });
  });

  it("names no credential for the whole description, so an operation without one needs none", () => {
    expect("security" in document).toBe(false);
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
