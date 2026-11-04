// SPDX-License-Identifier: AGPL-3.0-only

// /v1 against requests that another site starts (docs/api.md, Cross-site
// requests). The session cookie is SameSite=Strict, so a browser never sends
// it with another site's request; /v1 checks the Origin as well, before the
// resolver reads the cookie:
//
// - A request whose method is not GET or HEAD, that carries the session
//   cookie and no bearer token, must carry an Origin on the install's list.
//   Without one, or with another, it gets 403 origin-not-allowed.
// - An operation that runs before sign-in, such as a sign-in, refuses an
//   Origin that is not on the list, so another site cannot sign a browser in.
// - A request with no Origin and no session cookie, from a program, runs. A
//   request with a bearer token is a program's: the cookie is ignored, and so
//   is the Origin.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, TEST_INSTALL_KEY, CURSOR_KEY, TEST_VERSION, principalOf, problemIn } from "../../test/api.ts";
import { SHAPES_REGISTRY, fakeDatabase, shapeLog, shapesHandlers } from "../../test/shapes.ts";
import { createApp } from "../app.ts";
import type { ContextResolver, Principal } from "./context.ts";

const SITE = "https://nortfox.example";
const OTHER_SITE = "https://other.example";
const COMPANY = randomUUID();
const BROWSER: Principal = principalOf(COMPANY, { kind: "user" });
const PROGRAM: Principal = principalOf(COMPANY);
const SESSION = "__Host-nortfox-session=nfs_test-session";

/** A resolver that knows a session cookie and a bearer token, and records each request it is asked about. */
function resolver(asked: string[]): ContextResolver {
  return (request) => {
    asked.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.headers.get("authorization") === "Bearer test-program") {
      return Promise.resolve(PROGRAM);
    }
    return Promise.resolve((request.headers.get("cookie") ?? "").includes(SESSION) ? BROWSER : undefined);
  };
}

function testApp(): { readonly request: (path: string, init: RequestInit) => Promise<Response>; readonly asked: string[] } {
  const asked: string[] = [];
  const { hono } = createApp({
    version: TEST_VERSION,
    resolve: resolver(asked),
    database: fakeDatabase(),
    cursorKey: CURSOR_KEY,
    installKey: TEST_INSTALL_KEY,
    registry: SHAPES_REGISTRY,
    handlers: shapesHandlers(shapeLog()),
    permissions: ALL_PERMISSIONS,
    allowedOrigins: [SITE],
  });
  return { request: (path, init) => Promise.resolve(hono.request(path, init)), asked };
}

/** The headers of a request: its cookie, its Origin and its bearer token, when each is given. */
function headersOf(options: { readonly cookie?: string; readonly origin?: string; readonly bearer?: string; readonly key?: boolean; readonly json?: boolean }): Record<string, string> {
  return {
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
    ...(options.key === true ? { "idempotency-key": randomUUID() } : {}),
    ...(options.json === true ? { "content-type": "application/json" } : {}),
  };
}

/** Ends the session: a signed-in write with a key, which answers 204. */
function endSession(options: { readonly cookie?: string; readonly origin?: string; readonly bearer?: string }): RequestInit {
  return { method: "POST", headers: headersOf({ ...options, key: true }) };
}

/** Signs in: a write that runs before sign-in, and sets the session cookie. */
function signIn(options: { readonly cookie?: string; readonly origin?: string }): RequestInit {
  return { method: "POST", headers: headersOf({ ...options, json: true }), body: JSON.stringify({ email: "anna.lind@example.com" }) };
}

async function expectRefused(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  const problem = await problemIn(response);
  expect(problem.code).toBe("origin-not-allowed");
  expect(problem.detail).toBe(
    "The request's Origin is not the install's own site. A browser's write with the session cookie, and a sign-in, come only from there.",
  );
}

describe("a write with the session cookie", () => {
  it("runs with the install's own Origin", async () => {
    const app = testApp();
    expect((await app.request("/v1/test-session-ends", endSession({ cookie: SESSION, origin: SITE }))).status).toBe(204);
    expect((await app.request(`/v1/test-things/${randomUUID()}`, { method: "DELETE", headers: headersOf({ cookie: SESSION, origin: SITE, key: true }) })).status).toBe(204);
  });

  it.each([
    ["another site's Origin", OTHER_SITE],
    ["the Origin null, as a sandboxed frame sends it", "null"],
    ["the install's host over http", "http://nortfox.example"],
    ["the install's host on another port", "https://nortfox.example:8443"],
    ["the install's site with a path, which no browser sends", `${SITE}/`],
  ])("is refused with %s, before the resolver reads the cookie", async (_case, origin) => {
    const app = testApp();
    await expectRefused(await app.request("/v1/test-session-ends", endSession({ cookie: SESSION, origin })));
    await expectRefused(await app.request(`/v1/test-things/${randomUUID()}`, { method: "DELETE", headers: headersOf({ cookie: SESSION, origin, key: true }) }));
    expect(app.asked).toEqual([]);
  });

  it("is refused without an Origin, since a browser always sends one with a write", async () => {
    const app = testApp();
    await expectRefused(await app.request("/v1/test-session-ends", endSession({ cookie: SESSION })));
    expect(app.asked).toEqual([]);
  });

  it("is refused when the session cookie stands among other cookies", async () => {
    const app = testApp();
    await expectRefused(await app.request("/v1/test-session-ends", endSession({ cookie: `theme=dark; ${SESSION}; lang=sv`, origin: OTHER_SITE })));
  });
});

describe("a request the Origin rule leaves alone", () => {
  it("a GET with the session cookie, from any Origin or none", async () => {
    const app = testApp();
    for (const origin of [OTHER_SITE, SITE, undefined]) {
      const response = await app.request("/v1/test-person", { headers: headersOf({ cookie: SESSION, ...(origin === undefined ? {} : { origin }) }) });
      expect(response.status).toBe(200);
    }
    expect(app.asked).toHaveLength(3);
  });

  it("a write with a bearer token, which ignores the cookie: a program meets no Origin rule", async () => {
    const app = testApp();
    for (const origin of [OTHER_SITE, undefined]) {
      expect((await app.request("/v1/test-session-ends", endSession({ cookie: SESSION, bearer: "test-program", ...(origin === undefined ? {} : { origin }) }))).status).toBe(204);
    }
  });

  it("a write with no cookie and no Origin, from a program", async () => {
    const app = testApp();
    expect((await app.request("/v1/test-session-ends", endSession({ bearer: "test-program" }))).status).toBe(204);
  });

  it("a write whose cookie only looks like the session cookie gets the usual 401, not the Origin rule", async () => {
    const app = testApp();
    const response = await app.request("/v1/test-session-ends", endSession({ cookie: "__Host-nortfox-sessions=nfs_test-session", origin: OTHER_SITE }));
    expect(response.status).toBe(401);
  });
});

describe("an operation that runs before sign-in", () => {
  it("runs with the install's own Origin, and with none, from a program", async () => {
    const app = testApp();
    expect((await app.request("/v1/test-sign-ins", signIn({ origin: SITE }))).status).toBe(200);
    expect((await app.request("/v1/test-sign-ins", signIn({}))).status).toBe(200);
    expect((await app.request("/v1/test-redirects?provider=alfa", { headers: headersOf({}) })).status).toBe(303);
  });

  it.each([OTHER_SITE, "null"])("refuses the Origin %s, so another site cannot sign a browser in, also by a GET", async (origin) => {
    const app = testApp();
    await expectRefused(await app.request("/v1/test-sign-ins", signIn({ origin })));
    await expectRefused(await app.request("/v1/test-letters", { method: "POST", headers: headersOf({ origin, json: true }), body: JSON.stringify({ email: "anna.lind@example.com" }) }));
    await expectRefused(await app.request("/v1/test-redirects?provider=alfa", { headers: headersOf({ origin }) }));
    expect(app.asked).toEqual([]);
  });

  it("with the session cookie, needs the install's own Origin, as every write with the cookie does", async () => {
    const app = testApp();
    await expectRefused(await app.request("/v1/test-sign-ins", signIn({ cookie: SESSION })));
    expect((await app.request("/v1/test-sign-ins", signIn({ cookie: SESSION, origin: SITE }))).status).toBe(200);
  });
});

describe("a public operation", () => {
  it("answers any Origin: it reads nothing of anyone's", async () => {
    const app = testApp();
    expect((await app.request("/v1/health", { headers: headersOf({ origin: OTHER_SITE, cookie: SESSION }) })).status).toBe(200);
  });
});
