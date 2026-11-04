// SPDX-License-Identifier: AGPL-3.0-only

// Browser sessions (docs/decisions/0008-authentication.md). A session comes
// in the cookie __Host-nortfox-session, which is HttpOnly, Secure,
// SameSite=Strict, for the path / and with no Max-Age, and the known device
// in __Host-nortfox-device for 400 days. The server looks the session up on
// every request, by its token's hash. logout ends the session, and its
// cookie is refused from the next request (M11's last half). With no company
// chosen, a session ends after 120 minutes without a request, and every
// session ends 12 hours after it began. The server's clock is moved forwards.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, bearer, buildTestApp, callTool, mcpClient, personOf, problemIn, testResolver, type AppPool } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { PERSONAL_IDENTITY_NUMBERS, deleteIdentity } from "../../../test/identities.ts";
import {
  HOUR,
  MINUTE,
  SECOND,
  addSignInIdentity,
  challengeOf,
  codeOf,
  cookieHeader,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  passwordStep,
  sendAsBrowser,
  setCookiesOf,
  signIn,
  signInApp,
  testClock,
  totpStep,
  type SignInApp,
  type SignedIn,
  type TestIdentity,
} from "../../../test/sign-in.ts";
import { tokenHash } from "../../auth/tokens.ts";

interface StoredSession {
  readonly started_at: Date;
  readonly last_seen_at: Date;
  readonly ended_at: Date | null;
  readonly end_reason: string | null;
}

const UNAUTHORIZED = {
  type: "about:blank",
  title: "Unauthorized",
  status: 401,
  detail: "The request names no actor. Sign in first: a browser sends its session cookie, and a program its token in the Authorization header.",
  code: "authentication-required",
};

describe("a browser session", () => {
  let db: TestDatabase;
  let owner: Client;
  let app: Client;
  let pool: AppPool;
  let server: SignInApp;
  const people: TestIdentity[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    app = await db.connect("app");
    pool = appPool(db, 4);
    server = signInApp(pool.database, { clock: testClock() });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function signedInPerson(wanted: Parameters<typeof addSignInIdentity>[1] = {}): Promise<{ person: TestIdentity; browser: SignedIn }> {
    const person = await addSignInIdentity(owner, wanted);
    people.push(person);
    return { person, browser: await signIn(server, person) };
  }

  async function stored(session: string): Promise<StoredSession | undefined> {
    const found = await owner.query<StoredSession>("SELECT started_at, last_seen_at, ended_at, end_reason FROM access.sessions WHERE token_hash = $1", [tokenHash(session)]);
    return found.rows[0];
  }

  function getSession(session: string, headers: Record<string, string> = {}): Promise<Response> {
    return sendAsBrowser(server, "GET", "/v1/session", { cookies: { session } }, headers);
  }

  function logout(session: string, key = randomUUID()): Promise<Response> {
    return sendAsBrowser(server, "POST", "/v1/auth/logout", { cookies: { session } }, { "idempotency-key": key });
  }

  it("comes in cookies that are HttpOnly, Secure, SameSite=Strict and for the whole host, the session's with no Max-Age", async () => {
    const person = await addSignInIdentity(owner);
    people.push(person);
    const challenge = await challengeOf(await passwordStep(server, person.email, person.password));
    const set = setCookiesOf(await totpStep(server, challenge, codeOf(person, server.clock.now())));
    expect(set).toEqual({
      "__Host-nortfox-session": { value: expect.stringMatching(/^nfs_[A-Za-z0-9_-]{43}$/) as unknown, attributes: ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"] },
      "__Host-nortfox-device": {
        value: expect.stringMatching(/^nfd_[A-Za-z0-9_-]{43}$/) as unknown,
        attributes: ["Path=/", `Max-Age=${String(400 * 24 * 60 * 60)}`, "Secure", "HttpOnly", "SameSite=Strict"],
      },
    });
    const session = set["__Host-nortfox-session"]?.value ?? "";
    const device = set["__Host-nortfox-device"]?.value ?? "";
    // logout clears the session's cookie at once.
    expect(setCookiesOf(await logout(session))).toEqual({
      "__Host-nortfox-session": { value: "", attributes: ["Path=/", "Max-Age=0", "Secure", "HttpOnly", "SameSite=Strict"] },
    });
    // A password login on the known device sets the session's cookie the same way, and no device cookie.
    server.clock.advance(MINUTE);
    const known = setCookiesOf(await passwordStep(server, person.email, person.password, { cookies: { device } }));
    expect(known).toEqual({
      "__Host-nortfox-session": { value: expect.stringMatching(/^nfs_[A-Za-z0-9_-]{43}$/) as unknown, attributes: ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"] },
    });
  });

  it("is the person in getSession and getMe, looked up on every request", async () => {
    const { person, browser } = await signedInPerson({ personalIdentityNumber: PERSONAL_IDENTITY_NUMBERS[0] });
    const session = await getSession(browser.session);
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ user: { id: person.id, name: "Alva Berg", email: person.email, language: "sv" } });
    const me = await sendAsBrowser(server, "GET", "/v1/me", { cookies: { session: browser.session } });
    expect(await me.json()).toEqual({
      user: { id: person.id, name: "Alva Berg", email: person.email, language: "sv" },
      personalIdentityNumber: PERSONAL_IDENTITY_NUMBERS[0],
      twoStep: "new_device_90_days",
    });
    await owner.query("UPDATE access.identities SET mobile = '070-174 06 07', language = 'en', two_step = 'every_login' WHERE id = $1", [person.id]);
    const changed = await sendAsBrowser(server, "GET", "/v1/me", { cookies: { session: browser.session } });
    expect(await changed.json()).toMatchObject({ user: { language: "en" }, mobile: "070-174 06 07", twoStep: "every_login" });
  });

  it("logout ends the session, clears its cookie, and its cookie is refused from the next request", async () => {
    const { person, browser } = await signedInPerson();
    const response = await logout(browser.session);
    expect(response.status).toBe(204);
    expect(setCookiesOf(response)["__Host-nortfox-session"]?.value).toBe("");
    expect(await stored(browser.session)).toMatchObject({ ended_at: server.clock.now(), end_reason: "logout" });
    for (const next of [await getSession(browser.session), await logout(browser.session)]) {
      expect(next.status).toBe(401);
      expect(await problemIn(next)).toEqual(UNAUTHORIZED);
    }
    const events = await owner.query<{ kind: string }>("SELECT kind FROM access.account_events WHERE identity_id = $1 ORDER BY at", [person.id]);
    expect(events.rows.map((row) => row.kind)).toEqual(["sign-in", "logout"]);
    // A logout from another site is refused before the session is read.
    const { browser: other } = await signedInPerson();
    const crossSite = await server.send("/v1/auth/logout", { method: "POST", headers: { ...cookieHeader({ session: other.session }), origin: "https://other.example", "idempotency-key": "k" } });
    expect(crossSite.status).toBe(403);
    expect((await getSession(other.session)).status).toBe(200);
  });

  it("ends after 120 minutes without a request while it has no company, and every request moves that on", async () => {
    const { browser } = await signedInPerson();
    const started = server.clock.now();
    server.clock.advance(119 * MINUTE);
    expect((await getSession(browser.session)).status).toBe(200);
    expect(await stored(browser.session)).toMatchObject({ last_seen_at: server.clock.now(), ended_at: null });
    // A request within a minute of the last sight moves nothing.
    server.clock.advance(30 * SECOND);
    expect((await getSession(browser.session)).status).toBe(200);
    expect((await stored(browser.session))?.last_seen_at).toEqual(new Date(started.getTime() + 119 * MINUTE));
    server.clock.advance(120 * MINUTE - 30 * SECOND);
    const late = await getSession(browser.session);
    expect(late.status).toBe(401);
    expect(await stored(browser.session)).toMatchObject({ ended_at: server.clock.now(), end_reason: "idle" });
    // An ended session stays ended.
    expect((await getSession(browser.session)).status).toBe(401);
  });

  it("ends 12 hours after it began, however often it is used", async () => {
    const { browser } = await signedInPerson();
    for (let hour = 1; hour < 12; hour += 1) {
      server.clock.advance(HOUR);
      expect((await getSession(browser.session)).status).toBe(200);
    }
    server.clock.advance(HOUR - SECOND);
    expect((await getSession(browser.session)).status).toBe(200);
    server.clock.advance(SECOND);
    expect((await getSession(browser.session)).status).toBe(401);
    expect(await stored(browser.session)).toMatchObject({ end_reason: "absolute" });
  });

  it("is no session for a deleted identity, for a cookie that is not a session's token, with a bearer token, or on /mcp", async () => {
    const { person, browser } = await signedInPerson();
    const { browser: kept } = await signedInPerson();
    for (const cookie of [`nfd_${"A".repeat(43)}`, `nfs_${"A".repeat(43)}`, "not-a-token"]) {
      expect((await getSession(cookie)).status).toBe(401);
    }
    // Two session cookies are not NortFox's: a browser keeps one for the host.
    const doubled = await server.send("/v1/session", { headers: { cookie: `__Host-nortfox-session=${kept.session}; __Host-nortfox-session=${browser.session}` } });
    expect(doubled.status).toBe(401);
    // A request with a bearer token ignores the cookie.
    expect((await getSession(kept.session, { authorization: "Bearer some-token" })).status).toBe(401);
    // /mcp never reads the cookie: a tool that needs an actor answers 401.
    const client = await mcpClient(server.app, { cookie: `__Host-nortfox-session=${kept.session}` });
    expect(await callTool(client, "getMe")).toMatchObject({ isError: true, structured: { status: 401 } });
    await client.close();
    await deleteIdentity(app, person.id);
    expect((await getSession(browser.session)).status).toBe(401);
    expect((await getSession(kept.session)).status).toBe(200);
  });

  it("answers 500 for a principal whose identity the database does not hold, as a fault of the server", async () => {
    const reported: unknown[] = [];
    const ghost = buildTestApp({ database: pool.database, resolve: testResolver({ ghost: personOf() }), report: (error) => reported.push(error) });
    for (const path of ["/v1/me", "/v1/session"]) {
      const response = await ghost.hono.request(path, { headers: bearer("ghost") });
      expect(response.status).toBe(500);
    }
    expect(reported.map((error) => (error as Error).message)).toEqual([
      "The signed-in person's identity is not in access.identities.",
      "The signed-in person's identity is not in access.identities.",
    ]);
  });

  it("leaves no token in an answer or a report, and no secret in clear in the database", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db, { passwords: people.map((person) => person.password), totpSecrets: people.flatMap((person) => (person.totpSecret === undefined ? [] : [person.totpSecret])) });
  });
});
