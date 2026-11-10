// SPDX-License-Identifier: AGPL-3.0-only

// authorize with a token (plan 2.3 and 2.11; issue 12, "API tokens"). A
// token is refused an operation that serves the browser's session, or that
// needs a browser session, with 403 session-required, and an operation whose
// scope it lacks with 403 scope-missing, also when its person holds the
// permission. Both come before the company and the permission, and before
// anything of the input is read. A session is not limited by scopes. A
// token's request that names a company in its input must name the token's
// own: any other gets the answer of a company that does not exist, before
// the database is asked. An operation that runs before sign-in passes, as it
// does for anyone, and its handler never sees a token's principal.

import { REGISTRY, SCOPES, getCompany, getSession, leaveCompany, listRecentCompanies, updateMyMembership, type Operation } from "@nortfox/contract";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TEST_VERSION,
  bearer,
  buildTestApp,
  callTool,
  mcpClient,
  principalOf,
  problemIn,
  runnerDeps,
  testResolver,
  tokenPrincipalOf,
  untouchedDatabase,
} from "../../test/api.ts";
import { shapeHandlers, shapeLog, testSignIn } from "../../test/shapes.ts";
import { serverHandlers } from "../handlers.ts";
import { sessionOf, tokenCompanyOf, type Principal, type RequestContext } from "./context.ts";
import { authorize, companyNotAvailable, runOperation, type Handler, type OperationCall } from "./operation.ts";

const COMPANY = "6a2f9c1e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
const OTHER_COMPANY = "7b3a0d2f-4c5e-4f6a-9b8c-0d1e2f3a4b5c";

const TOKEN = await tokenPrincipalOf(COMPANY);

/** The operations a token may call by a scope, those it may not call at all, and those that anyone may call. */
const byScope = REGISTRY.filter((operation) => operation["x-nortfox"].scope !== null);
const sessionOnly = REGISTRY.filter((operation) => {
  const { permission, scope } = operation["x-nortfox"];
  return scope === null && permission !== "public" && permission !== "none";
});
const anyone = REGISTRY.filter((operation) => ["public", "none"].includes(operation["x-nortfox"].permission));

function cases(operations: readonly Operation[]): (readonly [string, Operation])[] {
  return operations.map((operation) => [operation.operationId, operation] as const);
}

/** A token of COMPANY with every scope but `scope`, and every permission. */
function withoutScope(scope: string): Promise<Principal> {
  return tokenPrincipalOf(COMPANY, { scopes: SCOPES.filter((each) => each !== scope) });
}

describe("authorize with a token", () => {
  it("sorts every operation of the registry into one of the three kinds", () => {
    expect(byScope.length + sessionOnly.length + anyone.length).toBe(REGISTRY.length);
    expect(sessionOnly.map((operation) => operation.operationId)).toEqual(["logout", "getSession", "listRecentCompanies", "selectCompany", "createApiToken"]);
  });

  it.each(cases(sessionOnly))("refuses %s, which serves or needs a browser session, with session-required, also with every scope and permission", (_id, operation) => {
    expect(authorize(operation, TOKEN)).toEqual({ kind: "session-required" });
  });

  it.each(cases(byScope))("refuses %s to a token that lacks its scope with scope-missing, which names the scope, also when its person holds the permission", async (_id, operation) => {
    const { scope } = operation["x-nortfox"];
    expect(authorize(operation, await withoutScope(String(scope)))).toEqual({ kind: "scope-missing", scope });
  });

  it.each(cases(byScope))("lets %s through to a token that holds its scope and its person the permission", (_id, operation) => {
    expect(authorize(operation, TOKEN)).toBeUndefined();
  });

  it.each(cases(anyone))("lets a token call %s, as anyone may", (_id, operation) => {
    expect(authorize(operation, TOKEN)).toBeUndefined();
  });

  it("checks the scope before the company and the permission: a token with neither the scope nor the permission is refused for its scope", async () => {
    const bare = await tokenPrincipalOf(COMPANY, { scopes: [], permissions: [] });
    expect(authorize(getCompany, bare)).toEqual({ kind: "scope-missing", scope: "companyinformation" });
    expect(authorize(listRecentCompanies, bare)).toEqual({ kind: "session-required" });
  });

  it("refuses a token that holds the scope but whose person lacks the permission with permission-missing", async () => {
    const scoped = await tokenPrincipalOf(COMPANY, { scopes: ["companyinformation"], permissions: [] });
    expect(authorize(getCompany, scoped)).toEqual({ kind: "permission-missing", permission: "company:read" });
  });

  it("does not limit a session by scopes: a session with every permission is refused nothing that a token's scope or the session mark refuses", async () => {
    const session = await principalOf(COMPANY, { kind: "user" });
    for (const operation of REGISTRY) {
      expect(authorize(operation, session), operation.operationId).toBeUndefined();
    }
  });
});

describe("sessionOf", () => {
  it("gives a session's credential, and throws for a token's, which authorize refuses an operation that serves the browser's session", async () => {
    const session = await principalOf(COMPANY, { kind: "user" });
    expect(sessionOf("logout", session.credential)).toBe(session.credential);
    expect(() => sessionOf("logout", TOKEN.credential)).toThrow("logout serves the browser's session, and the call came with a token, which authorize refuses.");
  });
});

describe("tokenCompanyOf", () => {
  it("gives a token's company, nothing for a session's call, and throws for a token with no company, which the resolver never gives", async () => {
    expect(tokenCompanyOf(TOKEN)).toBe(COMPANY);
    expect(tokenCompanyOf(await principalOf(COMPANY, { kind: "user" }))).toBeUndefined();
    const nowhere: Principal = { personId: TOKEN.personId, actorKind: TOKEN.actorKind, credential: TOKEN.credential };
    expect(() => tokenCompanyOf(nowhere)).toThrow("A token works in its one company, and its principal names none.");
  });
});

/** The handler of a registry operation, as the server serves it. */
function handlerOf(operation: Operation): Handler {
  const handler = serverHandlers(TEST_VERSION).find((each) => each.operation === operation);
  if (handler === undefined) {
    throw new Error(`The server has no handler of ${operation.operationId}.`);
  }
  return handler;
}

/** A call of a signed-in operation whose input names its company, with a key. */
function naming(context: RequestContext, companyId: string, body: unknown): OperationCall {
  return { context, input: { params: { companyId }, query: {}, body }, idempotency: { key: "k-1" }, later: () => undefined };
}

describe("the runner and a company that a token's input names", () => {
  const context: RequestContext = { ...TOKEN, channel: "rest" };

  it.each([
    ["updateMyMembership", updateMyMembership, { idleTimeout: 60 }],
    ["leaveCompany", leaveCompany, undefined],
  ] as const)("refuses %s for another company of the person with the answer of a company that does not exist, and asks no database", async (_id, operation, body) => {
    const database = untouchedDatabase();
    for (const companyId of [OTHER_COMPANY, randomUUID()]) {
      expect(await runOperation(handlerOf(operation), naming(context, companyId, body), runnerDeps(database))).toEqual(companyNotAvailable(operation));
    }
    expect(database.asked).toEqual([]);
  });

  it("refuses a token that names no company of its own any company of the input, as a fault would leave it", async () => {
    const database = untouchedDatabase();
    const companyless: RequestContext = { personId: context.personId, actorKind: context.actorKind, credential: context.credential, channel: "rest" };
    expect(await runOperation(handlerOf(updateMyMembership), naming(companyless, COMPANY, { idleTimeout: 60 }), runnerDeps(database))).toEqual(
      companyNotAvailable(updateMyMembership),
    );
    expect(database.asked).toEqual([]);
  });

  it("lets a token's input name its own company, in any letter case, through to the person's transaction", async () => {
    const database = untouchedDatabase();
    await expect(runOperation(handlerOf(updateMyMembership), naming(context, COMPANY.toUpperCase(), { idleTimeout: 60 }), runnerDeps(database))).rejects.toThrow(
      "The database was asked to person",
    );
    expect(database.asked).toEqual(["person"]);
  });

  it("asks the database for a session's company of its input, which the one membership function answers", async () => {
    const database = untouchedDatabase();
    const session: RequestContext = { ...(await principalOf(COMPANY, { kind: "user" })), channel: "rest" };
    await expect(runOperation(handlerOf(updateMyMembership), naming(session, OTHER_COMPANY, { idleTimeout: 60 }), runnerDeps(database))).rejects.toThrow(
      "The database was asked to person",
    );
    expect(database.asked).toEqual(["person"]);
  });
});

describe("the runner and an operation that runs before sign-in", () => {
  function signingIn(context: RequestContext | undefined): OperationCall {
    return { context, input: { query: {}, body: { email: "signe.ek@example.com" } }, idempotency: "none", later: () => undefined };
  }

  it("gives its handler no principal for a token, as for a request with none, and a session's principal", async () => {
    const log = shapeLog();
    const handler = shapeHandlers(log).find((each) => each.operation === testSignIn);
    if (handler === undefined) {
      throw new Error("The shapes have no handler of testSignIn.");
    }
    const session: RequestContext = { ...(await principalOf(COMPANY, { kind: "user" })), channel: "rest" };
    const answers = [];
    for (const context of [{ ...TOKEN, channel: "rest" } as const, undefined, session]) {
      answers.push(await runOperation(handler, signingIn(context), runnerDeps(untouchedDatabase())));
    }
    expect(answers.map((answer) => (answer.ok ? answer.output : answer))).toEqual([
      { email: "signe.ek@example.com", signedIn: false },
      { email: "signe.ek@example.com", signedIn: false },
      { email: "signe.ek@example.com", signedIn: true },
    ]);
    expect(log.calls.map((logged) => logged.principal)).toEqual([undefined, undefined, session]);
  });
});

/** A token of COMPANY with every scope but companyinformation. */
const SCOPELESS = await tokenPrincipalOf(COMPANY, { scopes: SCOPES.filter((scope) => scope !== "companyinformation") });

describe("/v1 and /mcp with a token", () => {
  const tokens = { "token-of-alfa": TOKEN, "token-without-companyinformation": SCOPELESS };

  function app() {
    const database = untouchedDatabase();
    return { database, app: buildTestApp({ database, resolve: testResolver(tokens) }) };
  }

  const SESSION_REQUIRED = {
    type: "about:blank",
    title: "Forbidden",
    status: 403,
    detail: "The operation needs a browser session, and the request came with a token. Sign in with a browser to call it.",
    code: "session-required",
  };

  const SCOPE_MISSING = {
    type: "about:blank",
    title: "Forbidden",
    status: 403,
    detail: "The token lacks the scope companyinformation, which this operation needs.",
    code: "scope-missing",
    scope: "companyinformation",
  };

  it("answers 403 session-required on /v1 for an operation that needs or serves a browser session, before the database is asked", async () => {
    const { database, app: server } = app();
    for (const path of ["/v1/me/companies/recent", "/v1/session"]) {
      const response = await server.hono.request(path, { headers: bearer("token-of-alfa") });
      expect(response.status, path).toBe(403);
      expect(await problemIn(response)).toEqual(SESSION_REQUIRED);
    }
    expect(database.asked).toEqual([]);
  });

  it("answers 403 scope-missing on /v1 with the scope, before the database is asked", async () => {
    const { database, app: server } = app();
    const response = await server.hono.request("/v1/company", { headers: bearer("token-without-companyinformation") });
    expect(response.status).toBe(403);
    expect(await problemIn(response)).toEqual(SCOPE_MISSING);
    expect(database.asked).toEqual([]);
  });

  it("gives the same problems through the MCP tools, and browser-only for an operation that serves the browser's session", async () => {
    const { database, app: server } = app();
    const client = await mcpClient(server, { token: "token-of-alfa" });
    expect(await callTool(client, listRecentCompanies.operationId)).toEqual({ isError: true, structured: SESSION_REQUIRED });
    expect((await callTool(client, getSession.operationId)).structured).toMatchObject({ status: 403, code: "browser-only" });
    await client.close();
    const scopeless = await mcpClient(server, { token: "token-without-companyinformation" });
    expect(await callTool(scopeless, getCompany.operationId)).toEqual({ isError: true, structured: SCOPE_MISSING });
    await scopeless.close();
    expect(database.asked).toEqual([]);
  });
});
