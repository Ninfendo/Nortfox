// SPDX-License-Identifier: AGPL-3.0-only

// With no actor, every operation that reads or writes data answers 401 with
// the Bearer challenge, and an actor without the operation's permission gets
// 403. Both come before any part of the request is read, so a bad request
// gets them too, a refused body is never read, and the database is never
// asked. The health check and the API description stay open.

import { PUBLIC, type Operation } from "@nortfox/contract";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_REGISTRY, bearer, buildTestApp, principalOf, problemIn, testResolver, untouchedDatabase, voucherBody } from "../../test/api.ts";
import { resolveNoActor } from "./context.ts";

const COMPANY = randomUUID();
const TOKENS = { nobody: principalOf(COMPANY, { permissions: [] }) };

const DATA_OPERATIONS = TEST_REGISTRY.filter((operation) => operation["x-nortfox"].permission !== PUBLIC);

/** A well-formed query, and each bad one that must get the same answer. */
const QUERIES = ["", "?unknown=1", "?limit=1&limit=2", "?limit=abc", "?Limit=1", "?cursor=garbage"];

/** One more than the largest body /v1 reads. */
const TOO_LARGE = 1024 * 1024 + 1;

/** A request as a test sends it, but for its credential. */
interface Sent {
  readonly path: string;
  readonly init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string };
}

const JSON_TYPE = { "content-type": "application/json" };
const KEY = { "idempotency-key": "8e03978e-40d5-43e8-bc93-6894a57f9324" };

/** The requests to an operation: a well-formed one and each bad one, with a write's bad bodies and its missing key. */
function requestsTo(operation: Operation): [string, Sent][] {
  const method = operation.method.toUpperCase();
  const writes = operation["x-nortfox"].writes;
  const good: Sent["init"] = writes ? { method, headers: { ...JSON_TYPE, ...KEY }, body: JSON.stringify(voucherBody()) } : { method, headers: {} };
  const sent: [string, Sent][] = QUERIES.map((query) => [`${method} ${operation.path}${query}`, { path: `${operation.path}${query}`, init: good }]);
  if (writes) {
    const path = operation.path;
    sent.push(
      [`${method} ${path} with no body`, { path, init: { method, headers: { ...JSON_TYPE, ...KEY } } }],
      [`${method} ${path} with text/plain`, { path, init: { method, headers: { "content-type": "text/plain", ...KEY }, body: "Kontorsmaterial" } }],
      [`${method} ${path} with malformed JSON`, { path, init: { method, headers: { ...JSON_TYPE, ...KEY }, body: '{"description": ' } }],
      [`${method} ${path} with a body over 1 MiB`, { path, init: { method, headers: { ...JSON_TYPE, ...KEY }, body: " ".repeat(TOO_LARGE) } }],
      [`${method} ${path} with no key`, { path, init: { method, headers: JSON_TYPE, body: JSON.stringify(voucherBody()) } }],
    );
  }
  return sent;
}

const CASES = DATA_OPERATIONS.flatMap((operation) => requestsTo(operation).map(([label, sent]) => [label, sent, operation] as const));

function send(database: ReturnType<typeof untouchedDatabase>, sent: Sent, credential: Readonly<Record<string, string>>, resolve = testResolver(TOKENS)) {
  return buildTestApp({ database, resolve }).hono.request(sent.path, { ...sent.init, headers: { ...sent.init.headers, ...credential } });
}

describe("no actor", () => {
  it("covers every operation that reads or writes data, and a write's bad bodies and missing key", () => {
    expect(DATA_OPERATIONS.map((operation) => operation.operationId)).toEqual(["getCompany", "testBookVoucher", "testListAccounts"]);
    expect(CASES.filter(([, , operation]) => operation["x-nortfox"].writes).map(([label]) => label)).toEqual([
      ...QUERIES.map((query) => `POST /v1/test-vouchers${query}`),
      "POST /v1/test-vouchers with no body",
      "POST /v1/test-vouchers with text/plain",
      "POST /v1/test-vouchers with malformed JSON",
      "POST /v1/test-vouchers with a body over 1 MiB",
      "POST /v1/test-vouchers with no key",
    ]);
  });

  it.each(CASES)("%s answers 401 with WWW-Authenticate: Bearer, and asks no database", async (_label, sent) => {
    for (const credential of [{}, bearer("unknown-token"), { authorization: "Basic YTpi" }]) {
      const database = untouchedDatabase();
      const response = await send(database, sent, credential);
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

  it.each(CASES)("%s answers 401 from the server's own resolver, which knows no actor", async (_label, sent) => {
    const database = untouchedDatabase();
    const response = await send(database, sent, bearer("nobody"), resolveNoActor);
    expect(response.status).toBe(401);
    expect(database.asked).toEqual([]);
  });
});

describe("an actor without the permission", () => {
  it.each(CASES)("%s answers 403 permission-missing with the permission, and asks no database", async (_label, sent, operation) => {
    const database = untouchedDatabase();
    const response = await send(database, sent, bearer("nobody"));
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

describe("a refused write's body", () => {
  it.each([
    ["no actor", {}, 401],
    ["an actor without the permission", bearer("nobody"), 403],
  ] as const)("is never read for %s", async (_who, credential, status) => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const database = untouchedDatabase();
    const response = await buildTestApp({ database, resolve: testResolver(TOKENS) }).hono.request("/v1/test-vouchers", {
      method: "POST",
      headers: { ...JSON_TYPE, ...KEY, ...credential },
      body,
      duplex: "half",
    });
    expect(response.status).toBe(status);
    expect(pulls).toBe(0);
    expect(body.locked).toBe(false);
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
