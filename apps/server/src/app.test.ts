// SPDX-License-Identifier: AGPL-3.0-only

import { REGISTRY, defineOperation, getCompany, getHealth } from "@nortfox/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALL_PERMISSIONS,
  CURSOR_KEY,
  TEST_INSTALL_KEY,
  TEST_REGISTRY,
  bearer,
  bookingControls,
  principalOf,
  testHandlers,
  testListAccounts,
  testResolver,
  untouchedDatabase,
} from "../test/api.ts";
import { SHAPES_REGISTRY, shapeLog, shapesHandlers } from "../test/shapes.ts";
import { handleData, ok } from "./api/operation.ts";
import { createApp, type AppOptions } from "./app.ts";
import { getCompanyHandler } from "./modules/companies/get-company.ts";
import { healthHandler } from "./modules/status/health.ts";
import { openApiDocument } from "./openapi.ts";

/** The app as main.ts builds it, with the defaults, and a database the test may not touch. */
function defaults(overrides: Partial<AppOptions> = {}): AppOptions {
  return { version: "1.2.3", resolve: testResolver({}), database: untouchedDatabase(), cursorKey: CURSOR_KEY, installKey: TEST_INSTALL_KEY, ...overrides };
}

const app = createApp(defaults()).hono;

describe("GET /v1/health", () => {
  it("says the server is up, with its version", async () => {
    const response = await app.request("/v1/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ status: "ok", version: "1.2.3" });
  });

  it("answers only under /v1", async () => {
    expect((await app.request("/health")).status).toBe(404);
  });
});

describe("GET /openapi.json", () => {
  it("serves the same description the repository commits", async () => {
    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(openApiDocument(REGISTRY, "1.2.3"));
  });

  it("describes the operations the app serves", async () => {
    const { hono } = createApp(
      defaults({ registry: TEST_REGISTRY, handlers: testHandlers(bookingControls(), "1.2.3"), permissions: ALL_PERMISSIONS }),
    );
    expect(await (await hono.request("/openapi.json")).json()).toEqual(openApiDocument(TEST_REGISTRY, "1.2.3"));
  });

  it("describes the health operation as the registry's entry: its x-nortfox and its problem answers", () => {
    const document = openApiDocument(REGISTRY, "1.2.3") as {
      paths: Record<string, { get?: { "x-nortfox"?: unknown; responses?: Record<string, { content?: object; headers?: object }> } }>;
      components: { schemas: Record<string, unknown> };
    };
    const health = document.paths["/v1/health"]?.get;
    expect(health?.["x-nortfox"]).toEqual({
      permission: "public",
      tool: "Checks that the NortFox server is up, and gives its version. It reads no data.",
      assistant: false,
      writes: false,
      list: false,
      session: null,
      company: "none",
      personalOutput: [],
    });
    expect(Object.keys(health?.responses ?? {})).toEqual(["200", "400", "500"]);
    expect(health?.responses?.["400"]?.content).toEqual({
      "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
    });
    const company = document.paths["/v1/company"]?.get;
    expect(company?.["x-nortfox"]).toEqual({
      permission: "company:read",
      tool: getCompany["x-nortfox"].tool,
      assistant: true,
      writes: false,
      list: false,
      session: null,
      company: "credential",
      personalOutput: [],
    });
    expect(Object.keys(company?.responses ?? {})).toEqual(["200", "400", "401", "403", "500"]);
    expect(company?.responses?.["401"]?.headers).toEqual({
      "WWW-Authenticate": { description: `The challenge, as RFC 9110 asks of every 401: Cookie realm="NortFox", cookie-name="__Host-nortfox-session".`, schema: { type: "string" } },
    });
    expect(Object.keys(document.components.schemas).sort()).toEqual([
      "Company",
      "CompanyChoice",
      "FieldProblem",
      "Health",
      "Me",
      "Membership",
      "PasswordSignIn",
      "Problem",
      "RecentCompanies",
      "Session",
      "SetupResult",
      "SysAdmin",
      "TotpEnrolment",
      "User",
    ]);
  });

  it("describes the operations under /v1, under the MIT licence", () => {
    expect(openApiDocument(REGISTRY, "1.2.3")).toMatchObject({
      openapi: "3.1.0",
      info: { title: "NortFox API", version: "1.2.3", license: { identifier: "MIT" } },
      paths: { "/v1/health": { get: { operationId: "getHealth" } }, "/v1/company": { get: { operationId: "getCompany" } } },
    });
  });
});

describe("createApp", () => {
  it("serves the registry by default, and no test-only operation", async () => {
    const { hono, registry } = createApp(defaults({ resolve: testResolver({ t: await principalOf("6f5e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f") }) }));
    expect(registry).toBe(REGISTRY);
    expect((await hono.request("/v1/company")).status).toBe(401);
    expect((await hono.request("/v1/test-accounts", { headers: bearer("t") })).status).toBe(404);
  });

  it("refuses a registry entry with no handler", () => {
    expect(() => createApp(defaults({ handlers: [healthHandler("1.2.3")] }))).toThrow(
      "The app cannot serve its registry:\n- getCompany has no handler.",
    );
  });

  it("refuses a handler whose operation is not in the registry, and two handlers for one operation", () => {
    expect(() => createApp(defaults({ handlers: [...testHandlers(bookingControls(), "1.2.3")] }))).toThrow(
      "The app cannot serve its registry:\n- The handler of testBookVoucher serves an operation that is not in the registry.\n- The handler of testListAccounts serves an operation that is not in the registry.",
    );
    expect(() => createApp(defaults({ handlers: [healthHandler("1.2.3"), getCompanyHandler, getCompanyHandler] }))).toThrow(
      "The app cannot serve its registry:\n- getCompany has more than one handler.",
    );
  });

  it("refuses a handler of another operation with the same id", () => {
    const lookalike = defineOperation({
      id: "getCompany",
      method: "get",
      path: "/v1/company",
      tags: [],
      summary: "Read the company",
      description: "Another entry with the same id.",
      output: z.strictObject({}),
      permission: "company:read",
      tool: "Gives nothing.",
      writes: false,
    });
    const handler = handleData(lookalike, () => Promise.resolve(ok({})));
    expect(() => createApp(defaults({ registry: [getHealth, getCompany], handlers: [healthHandler("1.2.3"), handler] }))).toThrow(
      "The app cannot serve its registry:\n- getCompany has no handler.\n- The handler of getCompany serves an operation that is not in the registry.",
    );
  });

  it("refuses a registry that the registry guard refuses", () => {
    const silent = defineOperation({
      id: "getSilent",
      method: "get",
      path: "/v1/silent",
      tags: [],
      summary: "Say nothing",
      description: "An entry with no MCP tool text.",
      output: z.strictObject({}),
      permission: "company:read",
      tool: " ",
      writes: false,
    });
    expect(() => createApp(defaults({ registry: [getHealth, silent] }))).toThrow("The registry has problems:\n- getSilent has no MCP tool text.");
  });

  it("refuses a test permission unless it is on the list it is given", () => {
    expect(() => createApp(defaults({ registry: [...REGISTRY, testListAccounts], handlers: testHandlers(bookingControls(), "1.2.3") }))).toThrow(
      'testListAccounts needs the permission "test:read", which is not on the list.',
    );
  });

  it("takes the server's clock, which a handler of an operation that runs before sign-in reads", async () => {
    const log = shapeLog();
    const at = new Date("2090-01-02T03:04:05.000Z");
    const { hono } = createApp(defaults({ registry: SHAPES_REGISTRY, handlers: shapesHandlers(log), permissions: ALL_PERMISSIONS, now: () => at }));
    const response = await hono.request("/v1/test-sign-ins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "anna@example.com" }) });
    expect(response.status).toBe(200);
    expect(log.calls[0]?.now).toEqual(at);
  });

  it("refuses a cursor key shorter than 32 bytes", () => {
    expect(() => createApp(defaults({ cursorKey: new Uint8Array(31) }))).toThrow("The cursor key must be at least 32 bytes long.");
  });

  it.each(["https://nortfox.example/", "https://nortfox.example/mcp", "https://NortFox.example", "https://nortfox.example:443", "nortfox.example", "null", "*", ""])(
    "refuses the allowed origin %j: each is an origin as a browser sends it",
    (origin) => {
      expect(() => createApp(defaults({ allowedOrigins: ["https://other.example", origin] }))).toThrow(
        `The allowed origin "${origin}" is not an origin as a browser sends it, such as https://nortfox.example or http://localhost:5173.`,
      );
    },
  );

  it("takes allowed origins with a scheme, a host and a port that is not the scheme's own", () => {
    expect(() => createApp(defaults({ allowedOrigins: ["https://nortfox.example", "http://localhost:5173", "http://[::1]:8080"] }))).not.toThrow();
  });
});

describe("/mcp", () => {
  it("is served at its exact path, beside /v1: a path in another case or with a trailing slash is 404", async () => {
    const response = await app.request("/mcp", { method: "GET" });
    expect(response.status).toBe(405);
    expect((await app.request("/mcp/")).status).toBe(404);
    expect((await app.request("/MCP")).status).toBe(404);
  });
});
