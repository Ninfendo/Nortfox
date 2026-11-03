// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { createApp, openApiDocument } from "./app.ts";

const app = createApp({ version: "1.2.3" });

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
    expect(await response.json()).toEqual(openApiDocument({ version: "1.2.3" }));
  });

  it("describes the health operation as the registry's entry: its x-nortfox and its problem answers", () => {
    const document = openApiDocument({ version: "1.2.3" }) as {
      paths: Record<string, { get?: { "x-nortfox"?: unknown; responses?: Record<string, { content?: object }> } }>;
      components: { schemas: Record<string, unknown> };
    };
    const health = document.paths["/v1/health"]?.get;
    expect(health?.["x-nortfox"]).toEqual({
      permission: "public",
      tool: "Checks that the NortFox server is up, and gives its version. It reads no data.",
      assistant: false,
      writes: false,
      list: false,
    });
    expect(Object.keys(health?.responses ?? {})).toEqual(["200", "400", "500"]);
    expect(health?.responses?.["400"]?.content).toEqual({
      "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
    });
    expect(Object.keys(document.components.schemas).sort()).toEqual(["FieldProblem", "Health", "Problem"]);
  });

  it("describes the health operation under /v1, under the MIT licence", () => {
    expect(openApiDocument({ version: "1.2.3" })).toMatchObject({
      openapi: "3.1.0",
      info: { title: "NortFox API", version: "1.2.3", license: { identifier: "MIT" } },
      paths: { "/v1/health": { get: { operationId: "getHealth" } } },
    });
  });
});
