// SPDX-License-Identifier: AGPL-3.0-only

// The fourth guard of the registry: the server serves /v1 from the registry
// only. The guard reads the finished app's routes, so a route added anywhere
// after createApp is found. startServer runs it before it listens
// (start.test.ts), and so do the test app builders.

import { REGISTRY } from "@nortfox/contract";
import { describe, expect, it } from "vitest";
import { buildTestApp, untouchedDatabase, testResolver } from "../../test/api.ts";
import { assertV1Routes, v1RouteProblems, type Route } from "./route-guard.ts";

const SERVED: Route[] = [
  { method: "GET", path: "/v1/health" },
  { method: "GET", path: "/v1/company" },
  { method: "GET", path: "/v1/company" },
  { method: "ALL", path: "/v1/health" },
  { method: "ALL", path: "/v1/company" },
  { method: "GET", path: "/openapi.json" },
];

describe("v1RouteProblems", () => {
  it("accepts the registry's routes, each with its chain, and their 405 answers", () => {
    expect(v1RouteProblems(SERVED, REGISTRY)).toEqual([]);
  });

  it("names a /v1 route that is not in the registry", () => {
    expect(v1RouteProblems([...SERVED, { method: "GET", path: "/v1/stray" }], REGISTRY)).toEqual([
      "GET /v1/stray is a route under /v1 that no operation of the registry declares.",
    ]);
  });

  it.each([
    ["POST", "/v1/company"],
    ["ALL", "/v1/stray"],
    ["ALL", "/v1/*"],
    ["GET", "/v1"],
    ["GET", "/v1/"],
    ["ALL", "*"],
    ["ALL", "/*"],
    ["GET", "/:version/company"],
    ["GET", "/:version{v1}/company"],
    ["GET", "/v*/company"],
  ])("names %s %s", (method, path) => {
    expect(v1RouteProblems([{ method, path }], REGISTRY)).toEqual([
      `${method} ${path} is a route under /v1 that no operation of the registry declares.`,
    ]);
  });

  it.each([
    ["GET", "/openapi.json"],
    ["ALL", "/mcp"],
    ["GET", "/v10/company"],
    ["GET", "/V1/company"],
    ["GET", "/health"],
  ])("lets %s %s through: it serves no /v1 path", (method, path) => {
    expect(v1RouteProblems([{ method, path }], REGISTRY)).toEqual([]);
  });
});

describe("assertV1Routes", () => {
  function app() {
    return buildTestApp({ database: untouchedDatabase(), resolve: testResolver({}) });
  }

  it("passes the app as createApp builds it", () => {
    expect(() => {
      assertV1Routes(app());
    }).not.toThrow();
  });

  it("throws on an app with a /v1 route added after createApp, and names it", () => {
    const built = app();
    built.hono.get("/v1/stray", (c) => c.text("stray"));
    built.hono.use("/v1/*", async (_c, next) => {
      await next();
    });
    expect(() => {
      assertV1Routes(built);
    }).toThrow(
      "The app serves routes under /v1 that are not in the registry:\n" +
        "- GET /v1/stray is a route under /v1 that no operation of the registry declares.\n" +
        "- ALL /v1/* is a route under /v1 that no operation of the registry declares.",
    );
  });
});
