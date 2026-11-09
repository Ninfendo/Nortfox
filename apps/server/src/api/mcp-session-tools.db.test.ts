// SPDX-License-Identifier: AGPL-3.0-only

// T10's halves for slice 2c's first three parts, generated from the
// registry: through /mcp, every operation that serves the browser's session
// (session "flow"), selectCompany, getInvitation and acceptInvitation among
// them, keeps its tool, which refuses every call with 403 browser-only
// before it reads an argument (open point 18). Each tool is called with arguments that
// succeed by REST, from test/operation-arguments.ts, and with the browser's
// session cookie too: the call changes nothing, and the same arguments then
// succeed by REST. No tool result holds a token of any kind. The test fails
// when a registry operation has no arguments, so each later part's session
// operations are checked here too.

import { REGISTRY, fullPermissions, type Operation, type Program } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, callTool, mcpClient, type AppPool } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { addGrant } from "../../test/grants.ts";
import { addCompanyWithOwner } from "../../test/ledger.ts";
import { addMembership, type Company } from "../../test/memberships.ts";
import { OPERATION_ARGUMENTS, restRequestOf, type ArgumentsFixture } from "../../test/operation-arguments.ts";
import { invitationTokenIn } from "../../test/mail.ts";
import { someEmail } from "../../test/identities.ts";
import { expectNoTokens } from "../../test/secrets.ts";
import {
  MINUTE,
  TEST_ORIGIN,
  addSignInIdentity,
  challengeOf,
  chooseCompany,
  codeOf,
  cookieHeader,
  expectNoSecretsAtRestFromSignInApps,
  expectNoTokensFromSignInApps,
  jsonOf,
  passwordStep,
  signIn,
  signInApp,
  testClock,
  writeAs,
  type SignInApp,
  type TestIdentity,
} from "../../test/sign-in.ts";
import { createSetupLink } from "../setup.ts";

const SESSION_OPERATIONS: readonly Operation[] = REGISTRY.filter((operation) => operation["x-nortfox"].session === "flow");

const BROWSER_ONLY = {
  type: "about:blank",
  title: "Forbidden",
  status: 403,
  detail: "This operation serves the browser's sign-in. An MCP client signs in through OAuth.",
  code: "browser-only",
};

/** What the database holds of sign-ins and company choices: a call that changes nothing leaves it as it was. */
async function signInRows(owner: Client): Promise<string> {
  const found = await owner.query<{ rows: string }>(
    `SELECT pg_catalog.jsonb_build_array(
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.identities AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.setup_tokens AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.login_challenges AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.sessions AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.subject, t.kind) FROM access.attempt_counters AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.account_events AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.idempotency_keys AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.identity_id, t.chosen_company_id) FROM access.recent_companies AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.events AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.memberships AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.contact_company_id, t.membership_id) FROM access.membership_contacts AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.invitations AS t),
       (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.invitation_links AS t)
     )::text AS rows`,
  );
  return found.rows[0]?.rows ?? "";
}

describe("the session operations on /mcp", () => {
  let db: TestDatabase;
  let owner: Client;
  let app: Client;
  /** Reads every row past row level security, the company tables' too, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;
  const results: unknown[] = [];
  const people: TestIdentity[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    owner = await db.connect("owner");
    app = await db.connect("app");
    superuser = await db.admin();
    pool = appPool(db, 4);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()) });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** The company that companyOf made last for each person. */
  const companies = new Map<string, Company>();

  const fixture: ArgumentsFixture = {
    setupToken: async () => {
      const link = await createSetupLink(pool.database, TEST_ORIGIN, server.clock.now());
      return new URL(link.url).pathname.split("/").at(-1) ?? "";
    },
    person: async () => {
      const person = await addSignInIdentity(owner, { twoStep: "every_login" });
      people.push(person);
      return person;
    },
    challenge: async () => {
      const person = await fixture.person();
      const challenge = await challengeOf(await passwordStep(server, person.email, person.password));
      return { challenge, code: codeOf(person, server.clock.now()) };
    },
    companyOf: async (person) => {
      const made = await addCompanyWithOwner(app, { actor: person.id, kind: "user" }, { name: "Testbolaget My AB" });
      companies.set(person.id, { ...made, id: made.row.company_id, asOwner: { actor: person.id, kind: "user" } });
      return made.row.company_id;
    },
    memberOf: async (person, program) => {
      const company = companies.get(person.id);
      if (company === undefined) {
        throw new Error("The fixture made no company for the person.");
      }
      const member = await addMembership(app, owner, company);
      if (program !== undefined) {
        await addGrant(app, company, member, program, fullPermissions(program as Program));
      }
      return member;
    },
    invitedOf: async (person) => {
      const company = companies.get(person.id);
      if (company === undefined) {
        throw new Error("The fixture made no company for the person.");
      }
      server.clock.advance(MINUTE);
      const { session } = await signIn(server, person);
      expect((await chooseCompany(server, session, company.id)).status).toBe(200);
      const invited = await jsonOf<{ id: string }>(await writeAs(server, session, "POST", "/v1/users", { name: "Tove Ny", email: someEmail() }), 201);
      return invited.id;
    },
    invitationToken: async () => {
      const inviter = await fixture.person();
      await fixture.companyOf(inviter);
      await fixture.invitedOf(inviter);
      const sent = server.mail.messages.at(-1);
      if (sent === undefined) {
        throw new Error("The invitation sent no mail.");
      }
      return invitationTokenIn(sent);
    },
    joinedCompanyOf: async (person) => {
      const other = await fixture.person();
      const made = await addCompanyWithOwner(app, { actor: other.id, kind: "user" }, { name: "Testbolaget Ny AB" });
      await addMembership(app, owner, { ...made, id: made.row.company_id, asOwner: { actor: other.id, kind: "user" } }, { user: person.id });
      return made.row.company_id;
    },
  };

  it("covers every session operation, and every operation of the registry has its arguments", () => {
    expect(SESSION_OPERATIONS.map((operation) => operation.operationId)).toEqual([
      "completeSetup",
      "loginWithPassword",
      "verifyTotp",
      "logout",
      "getSession",
      "selectCompany",
      "getInvitation",
      "acceptInvitation",
    ]);
    expect(Object.keys(OPERATION_ARGUMENTS).sort()).toEqual(REGISTRY.map((operation) => operation.operationId).sort());
  });

  it.each(SESSION_OPERATIONS.map((operation) => [operation.operationId, operation] as const))(
    "%s's tool refuses every call with browser-only, with arguments that succeed by REST, and changes nothing",
    async (_id, operation) => {
      const argumentsOf = OPERATION_ARGUMENTS[operation.operationId];
      if (argumentsOf === undefined) {
        throw new Error(`${operation.operationId} has no arguments in test/operation-arguments.ts.`);
      }
      // The browser's session rides along in the cookie: /mcp never reads it.
      const actor = operation["x-nortfox"].permission === "signed-in" ? await fixture.person() : undefined;
      const signedIn = actor === undefined ? undefined : await signIn(server, actor);
      const args = await argumentsOf(fixture, actor);
      const cookie = signedIn === undefined ? {} : cookieHeader({ session: signedIn.session });
      const before = await signInRows(superuser);
      for (const era of ["2025", "2026-07-28"] as const) {
        const client = await mcpClient(server.app, { era, ...(cookie["cookie"] === undefined ? {} : { cookie: cookie["cookie"] }) });
        const answer = await callTool(client, operation.operationId, args);
        results.push(answer);
        expect(answer).toEqual({ isError: true, structured: BROWSER_ONLY });
        await client.close();
      }
      expect(await signInRows(superuser)).toBe(before);
      // The same arguments succeed by REST.
      const { path, init } = restRequestOf(operation, args);
      const response = await server.send(path, { ...init, headers: { ...(init.headers as Record<string, string>), ...cookie, origin: TEST_ORIGIN } });
      expect(response.status, await response.clone().text()).toBeLessThan(300);
    },
  );

  it("gives no tool result that holds a token, and leaves no secret in clear", async () => {
    expect(results).toHaveLength(2 * SESSION_OPERATIONS.length);
    expectNoTokens(results);
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db, { passwords: [...people.map((person) => person.password), "signes-första-lösenord", "sixtens-lösenord"] });
  });
});
