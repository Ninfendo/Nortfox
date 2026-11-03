// SPDX-License-Identifier: AGPL-3.0-only

// With no actor, every operation that reads data answers 401 with the Bearer
// challenge, and an actor without the operation's permission gets 403. Both
// come before any part of the request is read, so a bad request gets them
// too, and the database is never asked. The health check and the API
// description stay open.

import { PUBLIC } from "@nortfox/contract";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_REGISTRY, bearer, buildTestApp, principalOf, problemIn, testResolver, untouchedDatabase } from "../../test/api.ts";
import { resolveNoActor } from "./context.ts";

const COMPANY = randomUUID();
const TOKENS = { nobody: principalOf(COMPANY, { permissions: [] }) };

const DATA_OPERATIONS = TEST_REGISTRY.filter((operation) => operation["x-nortfox"].permission !== PUBLIC);

/** A well-formed request, and each bad one that must get the same answer. */
const QUERIES = ["", "?unknown=1", "?limit=1&limit=2", "?limit=abc", "?Limit=1", "?cursor=garbage"];

const CASES = DATA_OPERATIONS.flatMap((operation) => QUERIES.map((query) => [operation.operationId, `${operation.path}${query}`, operation] as const));

describe("no actor", () => {
  it("covers every operation that reads data", () => {
    expect(DATA_OPERATIONS.map((operation) => operation.operationId)).toEqual(["getCompany", "testListAccounts"]);
  });

  it.each(CASES)("%s: GET %s answers 401 with WWW-Authenticate: Bearer, and asks no database", async (_id, path) => {
    for (const headers of [{}, bearer("unknown-token"), { authorization: "Basic YTpi" }]) {
      const database = untouchedDatabase();
      const response = await buildTestApp({ database, resolve: testResolver(TOKENS) }).hono.request(path, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await problemIn(response)).toEqual({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "The request names no actor. Send a credential in the Authorization header.",
        code: "authentication-required",
      });
      expect(database.asked).toEqual([]);
    }
  });

  it.each(CASES)("%s: GET %s answers 401 from the server's own resolver, which knows no actor", async (_id, path) => {
    const database = untouchedDatabase();
    const response = await buildTestApp({ database, resolve: resolveNoActor }).hono.request(path, { headers: bearer("nobody") });
    expect(response.status).toBe(401);
    expect(database.asked).toEqual([]);
  });
});

describe("an actor without the permission", () => {
  it.each(CASES)("%s: GET %s answers 403 permission-missing with the permission, and asks no database", async (_id, path, operation) => {
    const database = untouchedDatabase();
    const response = await buildTestApp({ database, resolve: testResolver(TOKENS) }).hono.request(path, { headers: bearer("nobody") });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
    const permission = operation["x-nortfox"].permission;
    expect(await problemIn(response)).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: `The actor lacks the permission ${permission}, which this operation needs.`,
      code: "permission-missing",
      permission,
    });
    expect(database.asked).toEqual([]);
  });
});

describe("what stays open", () => {
  it("answers GET /v1/health and /openapi.json with no actor, and asks no database", async () => {
    const database = untouchedDatabase();
    const { hono } = buildTestApp({ database, resolve: resolveNoActor });
    const health = await hono.request("/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", version: "0.0.0-test" });
    const description = await hono.request("/openapi.json");
    expect(description.status).toBe(200);
    expect(await description.json()).toMatchObject({ openapi: "3.1.0" });
    expect(database.asked).toEqual([]);
  });
});
