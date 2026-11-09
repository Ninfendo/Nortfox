// SPDX-License-Identifier: AGPL-3.0-only

// With no actor, every operation that needs one answers 401 with the Bearer
// challenge: every operation with a permission, and every signed-in one. An
// actor without the operation's permission gets 403. Both come before any
// part of the request is read, so a bad request gets them too, a refused
// body is never read, and the database is never asked. The health check and
// the API description stay open. The operations that run before sign-in
// need no actor (modules/auth), and by MCP the tools of the browser's
// session refuse every call with browser-only first (mcp-session-tools).

import { NONE, OPEN_PERMISSIONS, PUBLIC, type Operation } from "@nortfox/contract";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MCP_ERAS,
  TEST_REGISTRY,
  bearer,
  buildTestApp,
  callTool,
  mcpClient,
  principalOf,
  problemIn,
  testResolver,
  untouchedDatabase,
  voucherBody,
} from "../../test/api.ts";
import { resolveNoActor, type ContextResolver } from "./context.ts";

const COMPANY = randomUUID();
const TOKENS = { nobody: await principalOf(COMPANY, { permissions: [] }) };

/** The operations that need an actor: every one but the public ones and those that run before sign-in. */
const DATA_OPERATIONS = TEST_REGISTRY.filter((operation) => ![PUBLIC, NONE].includes(operation["x-nortfox"].permission));

/** The operations that need a permission in the credential's company. */
const PERMISSION_OPERATIONS = DATA_OPERATIONS.filter((operation) => !(OPEN_PERMISSIONS as readonly string[]).includes(operation["x-nortfox"].permission));

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

const PERMISSION_CASES = CASES.filter(([, , operation]) => PERMISSION_OPERATIONS.includes(operation));

function send(database: ReturnType<typeof untouchedDatabase>, sent: Sent, credential: Readonly<Record<string, string>>, resolve = testResolver(TOKENS)) {
  return buildTestApp({ database, resolve }).hono.request(sent.path, { ...sent.init, headers: { ...sent.init.headers, ...credential } });
}

describe("no actor", () => {
  it("covers every operation that needs an actor, and a write's bad bodies and missing key", () => {
    expect(DATA_OPERATIONS.map((operation) => operation.operationId)).toEqual([
      "getCompany",
      "logout",
      "getSession",
      "getMe",
      "createCompany",
      "listCompanies",
      "listRecentCompanies",
      "selectCompany",
      "updateMyMembership",
      "updateCompany",
      "listPermissions",
      "listUsers",
      "getUser",
      "updateUser",
      "removeUser",
      "assignProgram",
      "removeProgram",
      "moveProgram",
      "updateUserRights",
      "testBookVoucher",
      "testListAccounts",
    ]);
    expect(PERMISSION_OPERATIONS.map((operation) => operation.operationId)).toEqual([
      "getCompany",
      "updateCompany",
      "listUsers",
      "getUser",
      "updateUser",
      "removeUser",
      "assignProgram",
      "removeProgram",
      "moveProgram",
      "updateUserRights",
      "testBookVoucher",
      "testListAccounts",
    ]);
    const writeLabels = (path: string, method = "POST"): string[] => [
      ...QUERIES.map((query) => `${method} ${path}${query}`),
      `${method} ${path} with no body`,
      `${method} ${path} with text/plain`,
      `${method} ${path} with malformed JSON`,
      `${method} ${path} with a body over 1 MiB`,
      `${method} ${path} with no key`,
    ];
    expect(CASES.filter(([, , operation]) => operation["x-nortfox"].writes).map(([label]) => label)).toEqual([
      ...writeLabels("/v1/auth/logout"),
      ...writeLabels("/v1/companies"),
      ...writeLabels("/v1/session/company"),
      ...writeLabels("/v1/me/companies/{companyId}", "PATCH"),
      ...writeLabels("/v1/company", "PATCH"),
      ...writeLabels("/v1/users/{memberId}", "PATCH"),
      ...writeLabels("/v1/users/{memberId}", "DELETE"),
      ...writeLabels("/v1/users/{memberId}/programs/{program}", "PUT"),
      ...writeLabels("/v1/users/{memberId}/programs/{program}", "DELETE"),
      ...writeLabels("/v1/users/{memberId}/programs/{program}/move"),
      ...writeLabels("/v1/users/{memberId}/rights", "PUT"),
      ...writeLabels("/v1/test-vouchers"),
    ]);
  });

  it.each(CASES)("%s answers 401 with the challenge of the session cookie, which it takes, and asks no database", async (_label, sent) => {
    for (const credential of [{}, bearer("unknown-token"), { authorization: "Basic YTpi" }]) {
      const database = untouchedDatabase();
      const response = await send(database, sent, credential);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(`Cookie realm="NortFox", cookie-name="__Host-nortfox-session"`);
      expect(await problemIn(response)).toEqual({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "The request names no actor. Sign in first: a browser sends its session cookie, and a program its token in the Authorization header.",
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
  it.each(PERMISSION_CASES)("%s answers 403 permission-missing with the permission, and asks no database", async (_label, sent, operation) => {
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

/** A tool's arguments: none, a well-formed write, an unknown one, and every field with the wrong type. */
const ARGUMENTS: readonly [string, Readonly<Record<string, unknown>>][] = [
  ["no arguments", {}],
  ["a well-formed write", { ...voucherBody(), idempotencyKey: KEY["idempotency-key"] }],
  ["an unknown argument", { unknown: 1 }],
  ["badly typed arguments", { limit: "abc", cursor: 5, description: 5, amount: 125, idempotencyKey: 7 }],
];

/** The tools that need an actor and read their call: by MCP, a tool of the browser's session refuses every call before that. */
const TOOL_OPERATIONS = DATA_OPERATIONS.filter((operation) => operation["x-nortfox"].session !== "flow");

const TOOL_CASES = MCP_ERAS.flatMap((era) =>
  TOOL_OPERATIONS.flatMap((operation) => ARGUMENTS.map(([label, args]) => [`${operation.operationId} with ${label} (${era})`, operation, args, era] as const)),
);

const PERMISSION_TOOL_CASES = TOOL_CASES.filter(([, operation]) => PERMISSION_OPERATIONS.includes(operation));

/** Calls a tool as the token's actor, or as no actor, on an app over `database`. */
async function callAs(database: ReturnType<typeof untouchedDatabase>, token: string | undefined, operation: Operation, args: Readonly<Record<string, unknown>>, era: (typeof MCP_ERAS)[number], resolve: ContextResolver = testResolver(TOKENS)) {
  const client = await mcpClient(buildTestApp({ database, resolve }), { era, ...(token === undefined ? {} : { token }) });
  try {
    return await callTool(client, operation.operationId, args);
  } finally {
    await client.close();
  }
}

describe("no actor by MCP", () => {
  it("covers every operation that needs an actor but those of the browser's session, by both eras", () => {
    expect(TOOL_OPERATIONS.map((operation) => operation.operationId)).toEqual([
      "getCompany",
      "getMe",
      "createCompany",
      "listCompanies",
      "listRecentCompanies",
      "updateMyMembership",
      "updateCompany",
      "listPermissions",
      "listUsers",
      "getUser",
      "updateUser",
      "removeUser",
      "assignProgram",
      "removeProgram",
      "moveProgram",
      "updateUserRights",
      "testBookVoucher",
      "testListAccounts",
    ]);
    expect(TOOL_CASES).toHaveLength(MCP_ERAS.length * TOOL_OPERATIONS.length * ARGUMENTS.length);
  });

  it.each(TOOL_CASES)("%s answers isError with 401 authentication-required before it reads an argument, and asks no database", async (_label, operation, args, era) => {
    for (const token of [undefined, "unknown-token"]) {
      const database = untouchedDatabase();
      expect(await callAs(database, token, operation, args, era)).toEqual({
        isError: true,
        structured: {
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          detail: "The request names no actor. Sign in first: a browser sends its session cookie, and a program its token in the Authorization header.",
          code: "authentication-required",
        },
      });
      expect(database.asked).toEqual([]);
    }
  });

  it.each(TOOL_CASES)("%s answers 401 from the server's own resolver, which knows no actor", async (_label, operation, args, era) => {
    const database = untouchedDatabase();
    const answer = await callAs(database, "nobody", operation, args, era, resolveNoActor);
    expect(answer).toMatchObject({ isError: true, structured: { status: 401, code: "authentication-required" } });
    expect(database.asked).toEqual([]);
  });
});

describe("an actor without the permission by MCP", () => {
  it.each(PERMISSION_TOOL_CASES)("%s answers isError with 403 permission-missing before it reads an argument, and asks no database", async (_label, operation, args, era) => {
    const database = untouchedDatabase();
    const permission = operation["x-nortfox"].permission;
    expect(await callAs(database, "nobody", operation, args, era)).toEqual({
      isError: true,
      structured: {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: `The actor lacks the permission ${permission}, which this operation needs.`,
        code: "permission-missing",
        permission,
      },
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

  it("lists the tools and answers getHealth by MCP with no actor, and asks no database", async () => {
    const database = untouchedDatabase();
    const client = await mcpClient(buildTestApp({ database, resolve: resolveNoActor }));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TEST_REGISTRY.map((operation) => operation.operationId));
    expect(await callTool(client, "getHealth")).toEqual({ isError: false, structured: { status: "ok", version: "0.0.0-test" } });
    expect(database.asked).toEqual([]);
    await client.close();
  });
});
