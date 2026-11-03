// SPDX-License-Identifier: AGPL-3.0-only

// /mcp checks the Origin header before anything else, as the MCP
// specification asks of its HTTP transport against DNS rebinding. A request
// whose Origin is not on the allowed list gets 403 origin-not-allowed as
// problem details, and nothing runs for it: not the resolver, not the SDK,
// not the database. A request with no Origin, as programs other than
// browsers send, is not refused for that. The list holds whole origins:
// scheme, host and port.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTestApp, callTool, mcpClient, principalOf, problemIn, testResolver, untouchedDatabase } from "../../test/api.ts";
import type { ContextResolver } from "./context.ts";

const ALLOWED = "https://nortfox.example";

const TOKENS = { writer: principalOf(randomUUID()) };

/** A resolver that counts the requests it reads. */
function countingResolver(): { readonly resolve: ContextResolver; readonly calls: () => number } {
  let calls = 0;
  const inner = testResolver(TOKENS);
  return {
    resolve: (request) => {
      calls += 1;
      return inner(request);
    },
    calls: () => calls,
  };
}

const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

const REFUSED = {
  type: "about:blank",
  title: "Forbidden",
  status: 403,
  detail: "The Origin header names a site that may not call /mcp. A program that is not a browser sends no Origin.",
  code: "origin-not-allowed",
};

describe("the Origin check on /mcp", () => {
  it.each([
    "https://elsewhere.example",
    "http://nortfox.example",
    "https://nortfox.example:8443",
    "https://app.nortfox.example",
    "https://nortfox.example.elsewhere.example",
    "null",
    "https://nortfox.example/",
    "HTTPS://NORTFOX.EXAMPLE",
    "",
  ])("refuses the Origin %j with 403 origin-not-allowed, and neither the resolver, the SDK nor the database runs", async (origin) => {
    const database = untouchedDatabase();
    const resolver = countingResolver();
    const { hono } = buildTestApp({ database, resolve: resolver.resolve, allowedOrigins: [ALLOWED] });
    const requests = [
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: TOOLS_LIST },
      { method: "POST", headers: { "content-type": "text/plain" }, body: "not even JSON" },
      { method: "GET", headers: {} },
      { method: "DELETE", headers: {} },
    ];
    for (const { method, headers, body } of requests) {
      const response = await hono.request("/mcp", { method, headers: { ...headers, authorization: "Bearer writer", origin }, ...(body === undefined ? {} : { body }) });
      expect(response.status, method).toBe(403);
      expect(await problemIn(response)).toEqual(REFUSED);
    }
    expect(resolver.calls()).toBe(0);
    expect(database.asked).toEqual([]);
  });

  it("refuses every Origin when the list is empty, as the shipped server has it until login comes", async () => {
    const resolver = countingResolver();
    const { hono } = buildTestApp({ database: untouchedDatabase(), resolve: resolver.resolve });
    const response = await hono.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: ALLOWED },
      body: TOOLS_LIST,
    });
    expect(response.status).toBe(403);
    expect(await problemIn(response)).toEqual(REFUSED);
    expect(resolver.calls()).toBe(0);
  });

  it("lets a request from an allowed origin through", async () => {
    const resolver = countingResolver();
    const client = await mcpClient(buildTestApp({ database: untouchedDatabase(), resolve: resolver.resolve, allowedOrigins: ["https://other.example", ALLOWED] }), {
      origin: ALLOWED,
    });
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect((await callTool(client, "getHealth")).isError).toBe(false);
    expect(resolver.calls()).toBeGreaterThan(0);
    await client.close();
  });

  it("lets a request with no Origin through", async () => {
    const client = await mcpClient(buildTestApp({ database: untouchedDatabase(), resolve: testResolver(TOKENS), allowedOrigins: [ALLOWED] }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect((await callTool(client, "getHealth")).isError).toBe(false);
    await client.close();
  });

  it("checks only /mcp: /v1 answers a request from any origin", async () => {
    const { hono } = buildTestApp({ database: untouchedDatabase(), resolve: testResolver(TOKENS) });
    const response = await hono.request("/v1/health", { headers: { origin: "https://elsewhere.example" } });
    expect(response.status).toBe(200);
  });
});
