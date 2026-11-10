// SPDX-License-Identifier: AGPL-3.0-only

// R10 (issue 12, "Roles, admin levels, programs and permissions"; "API
// tokens" 2), generated from the registry: a token without the scope that
// an operation names is refused that operation with 403 scope-missing,
// which names the scope, also when its person holds the permission. Each
// operation that names a scope is called by REST with a token of a person
// who holds its permission: the company's owner, who holds every permission
// of the platform, and for the test-only read that needs vouchers.view, a
// member who holds the program Bokföring. The token holds every other
// scope. The call changes nothing. The same person's token with every scope
// passes the scope check, so the scope alone refused it.

import { REGISTRY, SCOPES, type Operation, type Scope } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { OPERATION_ARGUMENTS, type ArgumentsFixture } from "../../../test/operation-arguments.ts";
import { rightCheck, withRightChecks } from "../../../test/rights.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, signInApp, testClock, type SignInApp, type TestIdentity } from "../../../test/sign-in.ts";
import { callWithToken, makeApiToken } from "../../../test/tokens.ts";
import { apiCompany, calls, invite, newMember, sessionIn, type ApiCompany, type TestMember } from "../../../test/users.ts";

/** The test-only read that needs vouchers.view, which the scope bookkeeping covers. */
const VOUCHERS_VIEW: Operation = rightCheck("vouchers.view").operation;

/** Every operation of the registry that names a scope. */
const SCOPED: readonly Operation[] = REGISTRY.filter((operation) => operation["x-nortfox"].scope !== null);

describe("a token without the operation's scope", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads every row past row level security, for the check that nothing changed. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;
  let bookkeeper: TestMember;
  let bookkeeperSession: string;
  let member: TestMember;
  let invited: string;
  let ownersToken: string;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()), options: withRightChecks(["vouchers.view"]) });
    company = await apiCompany(server, { app, owner });
    bookkeeper = await newMember(server, { app, owner }, company);
    await calls.assignProgram(server, company.session, bookkeeper.id, "bookkeeping", { full: true });
    bookkeeperSession = await sessionIn(server, bookkeeper.person, company.id);
    member = await newMember(server, { app, owner }, company);
    invited = (await invite(server, company.session, "tove.ny@example.com", "Tove Ny")).id;
    ownersToken = (await makeApiToken(server, company.session, { name: "Att återkalla", scopes: ["tokens"] })).id;
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The arguments' fixture: the members above, in the one company. */
  const fixture: ArgumentsFixture = {
    setupToken: () => Promise.reject(new Error("No operation with a scope takes a setup link.")),
    person: () => Promise.reject(new Error("No operation with a scope takes a new person.")),
    challenge: () => Promise.reject(new Error("No operation with a scope takes a login challenge.")),
    companyOf: () => Promise.resolve(company.id),
    memberOf: () => Promise.resolve(member.id),
    invitedOf: () => Promise.resolve(invited),
    invitationToken: () => Promise.reject(new Error("No operation with a scope takes an invitation's link.")),
    joinedCompanyOf: () => Promise.resolve(company.id),
    tokenOf: () => Promise.resolve(ownersToken),
  };

  /** What the company holds that an operation writes: a refused call leaves it as it was. */
  async function rows(): Promise<string> {
    const found = await superuser.query<{ rows: string }>(
      `SELECT pg_catalog.jsonb_build_array(
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.company_id) FROM ledger.companies AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.memberships AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.contact_company_id, t.membership_id) FROM access.membership_contacts AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.program_grants AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.invitations AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.api_tokens AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.idempotency_keys AS t),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM ledger.idempotency_keys AS t),
         (SELECT pg_catalog.count(*) FROM audit.history)
       )::text AS rows`,
    );
    return found.rows[0]?.rows ?? "";
  }

  it("covers every operation that names a scope", () => {
    expect(SCOPED.map((operation) => [operation.operationId, operation["x-nortfox"].scope])).toEqual([
      ["getCompany", "companyinformation"],
      ["getMe", "profile"],
      ["createCompany", "companies"],
      ["listCompanies", "companies"],
      ["updateMyMembership", "companies"],
      ["updateCompany", "companies"],
      ["listPermissions", "users"],
      ["listUsers", "users"],
      ["getUser", "users"],
      ["updateUser", "users"],
      ["removeUser", "users"],
      ["assignProgram", "users"],
      ["removeProgram", "users"],
      ["moveProgram", "users"],
      ["updateUserRights", "users"],
      ["inviteUser", "users"],
      ["resendInvitation", "users"],
      ["disconnectUserIdentity", "users"],
      ["leaveCompany", "companies"],
      ["listApiTokens", "tokens"],
      ["revokeApiToken", "tokens"],
    ]);
  });

  /** Calls `operation` as `person`, whose session is `session`, with a token of every scope but `lacking`, and checks the refusal and that nothing changed. */
  async function refusedWithout(operation: Operation, person: TestIdentity, session: string, lacking: Scope): Promise<void> {
    const scopes = SCOPES.filter((scope) => scope !== lacking);
    const { token } = await makeApiToken(server, session, { name: `Utan ${lacking}`, scopes });
    const argumentsOf = OPERATION_ARGUMENTS[operation.operationId];
    const args = argumentsOf === undefined ? {} : await argumentsOf(fixture, person);
    const before = await rows();
    const answer = await callWithToken(server, token, operation, args);
    expect(answer.status, `${operation.operationId}: ${await answer.clone().text()}`).toBe(403);
    expect(await answer.json()).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: `The token lacks the scope ${lacking}, which this operation needs.`,
      code: "scope-missing",
      scope: lacking,
    } satisfies ProblemBody & { readonly scope: string });
    expect(await rows(), `${operation.operationId} changed nothing`).toBe(before);
  }

  it.each(SCOPED.map((operation) => [operation.operationId, operation] as const))(
    "%s refuses a token without its scope, though the token's person, the owner, holds its permission",
    async (_id, operation) => {
      const scope = operation["x-nortfox"].scope;
      if (scope === null) {
        throw new Error(`${operation.operationId} names no scope.`);
      }
      await refusedWithout(operation, company.creator, company.session, scope);
    },
  );

  it("refuses the read that needs vouchers.view to a token without bookkeeping, though its person holds Bokföring, and lets the scope through", async () => {
    await refusedWithout(VOUCHERS_VIEW, bookkeeper.person, bookkeeperSession, "bookkeeping");
    const { token } = await makeApiToken(server, bookkeeperSession, { name: "Bokföring", scopes: ["bookkeeping"] });
    const answer = await callWithToken(server, token, VOUCHERS_VIEW, {});
    expect(await answer.json()).toEqual({ permission: "vouchers.view" });
  });

  it("lets a token with the scope through to the permission and the input, which the scope alone refused", async () => {
    const { token } = await makeApiToken(server, company.session, { name: "Alla", scopes: [...SCOPES] });
    const answer = await callWithToken(server, token, REGISTRY.find((operation) => operation.operationId === "getCompany") as Operation, {});
    expect(answer.status).toBe(200);
    // The bookkeeper's token with every scope still lacks the users' permission.
    const theirs = await makeApiToken(server, bookkeeperSession, { name: "Alla", scopes: [...SCOPES] });
    const users = await callWithToken(server, theirs.token, REGISTRY.find((operation) => operation.operationId === "listUsers") as Operation, {});
    expect(await users.json()).toMatchObject({ code: "permission-missing", permission: "users:read" });
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
