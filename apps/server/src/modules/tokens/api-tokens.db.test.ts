// SPDX-License-Identifier: AGPL-3.0-only

// T1 (issue 12, "API tokens" 1, 2, 5 and 6; "Done when", Tokens and MCP
// clients). A member makes an API token for one company with createApiToken,
// in a browser session, with a name and scopes. The answer shows the token
// once, and the database keeps only its hash. The token acts as its person,
// an integration, in its one company: an operation that names another
// company of the person in its input gets the answer of a company that does
// not exist, and an invitation sent with the token links nothing. It works
// on /v1 only, never on /mcp (open point 7). It may do what its scopes and
// its person's permissions in its company both allow, and nothing that
// serves or needs a browser session: so a token never makes a token.
// createApiToken takes the scopes of SCOPES by their exact names, and
// getMe through a token holds no personnummer and no mobile number. The
// people and the companies are made up.

import { REGISTRY, SCOPES, type Operation } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, callTool, mcpClient, untilAtGate, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { PERSONAL_IDENTITY_NUMBERS, deleteIdentity } from "../../../test/identities.ts";
import { OPERATION_ARGUMENTS, type ArgumentsFixture } from "../../../test/operation-arguments.ts";
import {
  TEST_ORIGIN,
  addSignInIdentity,
  cookieHeader,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  getAs,
  holdingWrites,
  jsonOf,
  signInApp,
  testClock,
  writeAs,
  type SignInApp,
} from "../../../test/sign-in.ts";
import { apiTokenBody, asToken, callWithToken, makeApiToken } from "../../../test/tokens.ts";
import { apiCompany, calls, invite, joinWith, newMember, sessionIn, type ApiCompany } from "../../../test/users.ts";
import { newToken, tokenHash } from "../../auth/tokens.ts";

/** The operations a token may never call: those that serve or need a browser session, but the ones that run before sign-in, which anyone may call. */
const SESSION_OPERATIONS: readonly Operation[] = REGISTRY.filter((operation) => operation["x-nortfox"].session !== null && operation["x-nortfox"].permission !== "none");

const SESSION_REQUIRED: ProblemBody = {
  type: "about:blank",
  title: "Forbidden",
  status: 403,
  detail: "The operation needs a browser session, and the request came with a token. Sign in with a browser to call it.",
  code: "session-required",
};

/** An object without the fields that `keys` name. */
function withoutKeys(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

const NO_ACTOR = {
  type: "about:blank",
  title: "Unauthorized",
  status: 401,
  detail: "The request names no actor. Sign in first: a browser sends its session cookie, and a program its token in the Authorization header.",
  code: "authentication-required",
};

describe("an API token", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads every row past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  /** The company the tokens work in, which its creator made. */
  let alfa: ApiCompany;
  /** Another company, where alfa's creator is an active member. */
  let beta: ApiCompany;
  /** The creator's membership in beta. */
  let inBeta: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    const creator = await addSignInIdentity(owner, { personalIdentityNumber: PERSONAL_IDENTITY_NUMBERS[0] });
    await owner.query("UPDATE access.identities SET mobile = '070-174 06 07' WHERE id = $1", [creator.id]);
    alfa = await apiCompany(server, { app, owner }, "Testbolaget Alfa AB", creator);
    beta = await apiCompany(server, { app, owner }, "Testbolaget Beta AB");
    inBeta = await joinWith(server, creator, (await invite(server, beta.session, creator.email, "Alva Berg")).token);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function storedToken(id: string): Promise<Record<string, unknown> | undefined> {
    const found = await superuser.query<Record<string, unknown>>(
      "SELECT token_hash, token_company_id, membership_id, identity_id, name, scopes, revoked_at FROM access.api_tokens WHERE id = $1",
      [id],
    );
    return found.rows[0];
  }

  it("is shown once and stored as its hash", async () => {
    const made = await makeApiToken(server, alfa.session, { name: "Bokföringsexport", scopes: ["companyinformation", "profile"] });
    expect(made).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      name: "Bokföringsexport",
      scopes: ["companyinformation", "profile"],
      userId: alfa.creator.id,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
      token: expect.stringMatching(/^nft_[A-Za-z0-9_-]{43}$/) as unknown,
    });
    expect(await storedToken(made.id)).toEqual({
      token_hash: tokenHash(made.token),
      token_company_id: alfa.id,
      membership_id: alfa.membership,
      identity_id: alfa.creator.id,
      name: "Bokföringsexport",
      scopes: ["companyinformation", "profile"],
      revoked_at: null,
    });
    // The list shows the token without it, and the token works.
    const { token } = made;
    const shown = withoutKeys(made, ["token"]);
    const listed = await jsonOf<{ items: unknown[] }>(await getAs(server, alfa.session, "/v1/api-tokens"));
    expect(listed.items).toContainEqual(shown);
    expect(JSON.stringify(listed)).not.toContain("nft_");
    expect(await jsonOf<{ id: string }>(await asToken(server, token, "GET", "/v1/company"))).toMatchObject({ id: alfa.id });
  });

  it("a repeat of its key gets answer-shown-once, with the token's id and no token", async () => {
    const made = await makeApiToken(server, alfa.session, { name: "Bankimport", scopes: ["bookkeeping"], key: "make-the-import" });
    const again = await writeAs(server, alfa.session, "POST", "/v1/api-tokens", apiTokenBody({ name: "Bankimport", scopes: ["bookkeeping"] }), { key: "make-the-import" });
    const kept = withoutKeys(made, ["token"]);
    expect(await jsonOf(again, 409)).toMatchObject({ code: "answer-shown-once", answer: kept });
    const named = await superuser.query<{ id: string }>("SELECT id FROM access.api_tokens WHERE name = 'Bankimport'");
    expect(named.rows).toEqual([{ id: made.id }]);
  });

  it("works only in its company, also for operations that name a company in their input", async () => {
    const { token } = await makeApiToken(server, alfa.session);
    expect(await jsonOf<{ id: string }>(await asToken(server, token, "GET", "/v1/company"))).toMatchObject({ id: alfa.id, name: "Testbolaget Alfa AB" });
    const companies = await jsonOf<{ items: { company: { id: string } }[]; total: number }>(await asToken(server, token, "GET", "/v1/companies"));
    expect(companies.items.map((item) => item.company.id)).toEqual([alfa.id]);
    expect(companies.total).toBe(1);
    // An operation that names beta gets the answer of a company that does not exist.
    const nowhere = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
    for (const [method, suffix, body] of [
      ["PATCH", "", { idleTimeout: 30 }],
      ["POST", "/leave", undefined],
    ] as const) {
      const toBeta = await jsonOf<ProblemBody>(await asToken(server, token, method, `/v1/me/companies/${beta.id}${suffix}`, { ...(body === undefined ? {} : { body }) }), 422);
      const toNowhere = await jsonOf<ProblemBody>(await asToken(server, token, method, `/v1/me/companies/${nowhere}${suffix}`, { ...(body === undefined ? {} : { body }) }), 422);
      expect(toBeta).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        detail: "The person is no active member of the company that companyId names, or it does not exist.",
        code: "company-not-available",
        pointer: "/companyId",
      });
      expect(toNowhere).toEqual(toBeta);
    }
    const kept = await superuser.query("SELECT status, idle_timeout_minutes FROM access.memberships WHERE id = $1", [inBeta]);
    expect(kept.rows).toEqual([{ status: "active", idle_timeout_minutes: 120 }]);
    // An invitation sent with the token links nothing: the token is no browser's sign-in.
    const gamma = await apiCompany(server, { app, owner }, "Testbolaget Gamma AB");
    const invited = await invite(server, gamma.session, alfa.creator.email, "Alva Berg");
    const accepted = await server.send(`/v1/invitations/${invited.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(await jsonOf<ProblemBody>(accepted, 422)).toMatchObject({ code: "sign-in-required" });
    const stillInvited = await superuser.query("SELECT status, user_id FROM access.memberships WHERE id = $1", [invited.id]);
    expect(stillInvited.rows).toEqual([{ status: "invited", user_id: null }]);
  });

  it("works only on /v1", async () => {
    const { token } = await makeApiToken(server, alfa.session);
    expect((await asToken(server, token, "GET", "/v1/company")).status).toBe(200);
    for (const era of ["2025", "2026-07-28"] as const) {
      const client = await mcpClient(server.app, { token, era });
      expect(await callTool(client, "getCompany")).toEqual({ isError: true, structured: NO_ACTOR });
      expect(await callTool(client, "getMe")).toEqual({ isError: true, structured: NO_ACTOR });
      await client.close();
    }
  });

  it("does only what its scopes and its person's permissions both allow", async () => {
    // The owner holds the users' permissions: a token with the scope users lists them, and one without it is refused, naming the scope.
    const withUsers = await makeApiToken(server, alfa.session, { scopes: ["users"] });
    expect((await asToken(server, withUsers.token, "GET", "/v1/users")).status).toBe(200);
    expect(await jsonOf<ProblemBody>(await asToken(server, withUsers.token, "GET", "/v1/company"), 403)).toMatchObject({ code: "scope-missing", scope: "companyinformation" });
    // A plain member lacks them: a token with every scope is refused, naming the permission.
    const member = await newMember(server, { app, owner }, alfa);
    const memberToken = await makeApiToken(server, await sessionIn(server, member.person, alfa.id));
    expect((await asToken(server, memberToken.token, "GET", "/v1/company")).status).toBe(200);
    expect(await jsonOf<ProblemBody>(await asToken(server, memberToken.token, "GET", "/v1/users"), 403)).toMatchObject({ code: "permission-missing", permission: "users:read" });
    expect(await jsonOf<ProblemBody>(await asToken(server, memberToken.token, "PATCH", "/v1/company", { body: { city: "Lund" } }), 403)).toMatchObject({
      code: "permission-missing",
      permission: "company:update",
    });
  });

  describe("cannot make a token, and is refused every operation that serves or needs a browser session", () => {
    const fixture: ArgumentsFixture = {
      setupToken: () => Promise.reject(new Error("No such operation takes a setup link.")),
      person: () => Promise.reject(new Error("No such operation takes a new person.")),
      challenge: () => Promise.reject(new Error("No such operation takes a login challenge.")),
      companyOf: () => Promise.resolve(alfa.id),
      memberOf: () => Promise.reject(new Error("No such operation takes a member.")),
      invitedOf: () => Promise.reject(new Error("No such operation takes an invited member.")),
      invitationToken: () => Promise.reject(new Error("No such operation takes an invitation's link.")),
      joinedCompanyOf: () => Promise.resolve(alfa.id),
      tokenOf: () => Promise.reject(new Error("No such operation takes a token.")),
    };

    it("covers every operation that serves or needs a browser session", () => {
      expect(SESSION_OPERATIONS.map((operation) => operation.operationId)).toEqual(["logout", "getSession", "listRecentCompanies", "selectCompany", "createApiToken"]);
    });

    it.each(SESSION_OPERATIONS.map((operation) => [operation.operationId, operation] as const))("%s refuses a token with session-required", async (_id, operation) => {
      const { token } = await makeApiToken(server, alfa.session);
      const argumentsOf = OPERATION_ARGUMENTS[operation.operationId];
      if (argumentsOf === undefined) {
        throw new Error(`${operation.operationId} has no arguments in test/operation-arguments.ts.`);
      }
      const before = await superuser.query("SELECT count(*) AS tokens FROM access.api_tokens");
      const answer = await callWithToken(server, token, operation, await argumentsOf(fixture, alfa.creator));
      expect(await jsonOf(answer, 403)).toEqual(SESSION_REQUIRED);
      expect((await superuser.query("SELECT count(*) AS tokens FROM access.api_tokens")).rows).toEqual(before.rows);
      // The token still works where its scopes and its person allow.
      expect((await asToken(server, token, "GET", "/v1/me")).status).toBe(200);
    });
  });

  it("createApiToken takes each scope of SCOPES and refuses any other name, also one that differs only in letter case", async () => {
    const every = await makeApiToken(server, alfa.session, { scopes: [...SCOPES] });
    expect(every.scopes).toEqual([...SCOPES]);
    for (const scope of SCOPES) {
      expect((await makeApiToken(server, alfa.session, { name: `Endast ${scope}`, scopes: [scope] })).scopes).toEqual([scope]);
    }
    // Each scope once, in the list's order, however the request gives them.
    expect((await makeApiToken(server, alfa.session, { scopes: ["users", "profile", "users"] })).scopes).toEqual(["profile", "users"]);
    const before = await superuser.query("SELECT count(*) AS tokens FROM access.api_tokens");
    for (const wrong of ["Profile", "PROFILE", "bookKeeping", "profiles", "users:read", "", "company information"]) {
      const answer = await writeAs(server, alfa.session, "POST", "/v1/api-tokens", { name: "Fel", scopes: ["profile", wrong] });
      const problem = await jsonOf<ProblemBody>(answer, 400);
      expect(problem.code).toBe("invalid-request");
      expect(problem.errors).toEqual([expect.objectContaining({ code: "invalid-value", pointer: "/scopes/1" })]);
    }
    expect((await jsonOf<ProblemBody>(await writeAs(server, alfa.session, "POST", "/v1/api-tokens", { name: "Inga", scopes: [] }), 400)).errors).toEqual([
      expect.objectContaining({ code: "too-short", pointer: "/scopes" }),
    ]);
    expect((await superuser.query("SELECT count(*) AS tokens FROM access.api_tokens")).rows).toEqual(before.rows);
  });

  it("getMe through it holds no personnummer and no mobile number", async () => {
    const bySession = await jsonOf(await getAs(server, alfa.session, "/v1/me"));
    expect(bySession).toMatchObject({ personalIdentityNumber: PERSONAL_IDENTITY_NUMBERS[0], mobile: "070-174 06 07" });
    const { token } = await makeApiToken(server, alfa.session, { scopes: ["profile"] });
    const byToken = await jsonOf(await asToken(server, token, "GET", "/v1/me"));
    expect(byToken).not.toHaveProperty("personalIdentityNumber");
    expect(byToken).not.toHaveProperty("mobile");
    expect(JSON.stringify(byToken)).not.toContain(PERSONAL_IDENTITY_NUMBERS[0]);
    expect(byToken).toEqual(withoutKeys(bySession, ["personalIdentityNumber", "mobile"]));
    expect(byToken).toMatchObject({ company: { id: alfa.id }, membership: { id: alfa.membership } });
  });

  it("names no actor when it is unknown, or its identity is deleted", async () => {
    expect(await jsonOf<ProblemBody>(await asToken(server, newToken("apiToken"), "GET", "/v1/company"), 401)).toMatchObject({ code: "authentication-required" });
    const member = await newMember(server, { app, owner }, alfa);
    const { token } = await makeApiToken(server, await sessionIn(server, member.person, alfa.id));
    expect((await asToken(server, token, "GET", "/v1/company")).status).toBe(200);
    await deleteIdentity(app, member.person.id);
    expect(await jsonOf<ProblemBody>(await asToken(server, token, "GET", "/v1/company"), 401)).toMatchObject({ code: "authentication-required" });
  });

  it("is not made for a membership that stops being active while the call runs", async () => {
    const member = await newMember(server, { app, owner }, alfa);
    const session = await sessionIn(server, member.person, alfa.id);
    // The member's next write in the company waits at its start, after the resolver read the session.
    const held = holdingWrites(pool.database, (settings) => settings.company !== undefined && settings.actorId === member.person.id, "start");
    const racing = signInApp(held.database, { clock: server.clock });
    const making = Promise.resolve(racing.app.hono.request("/v1/api-tokens", {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json", "idempotency-key": "make-while-deactivated", ...cookieHeader({ session }) },
      body: JSON.stringify(apiTokenBody({ name: "Under avaktivering" })),
      }),
    );
    await untilAtGate(held.gate, making);
    expect((await calls.updateUser(server, alfa.session, member.id, { active: false })).status).toBe(200);
    held.gate.open();
    expect(await jsonOf<ProblemBody>(await making, 401)).toMatchObject({ code: "authentication-required" });
    const made = await superuser.query("SELECT id FROM access.api_tokens WHERE identity_id = $1", [member.person.id]);
    expect(made.rows).toEqual([]);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
