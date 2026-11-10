// SPDX-License-Identifier: AGPL-3.0-only

// A token stays in its company (issue 12, "Who acts" 4; "Done when", Tokens
// and MCP clients; plan 2.3), generated from the registry. This is the API
// token's half: for every operation that names a scope, a person's API token
// of company Alfa is used where the same person is an active member, and a
// system administrator, of company Beta too. Each call, made with arguments
// that succeed (test/operation-arguments.ts):
//
// - writes no row in Beta: Beta's behandlingshistorik and the install-wide
//   rows that name Beta are as they were;
// - writes its company rows in Alfa alone, but createCompany, the one
//   exception, which writes them in the new company it makes;
// - answers with no id, name, tenant id or member of Beta.
//
// An operation that names its company in its input is refused for Beta with
// 422 company-not-available, the same answer as for a company that does not
// exist, and changes nothing. listCompanies gives the token only Alfa. Each
// operation gets its own person and companies, so no call's success changes
// another's. Part 5 adds the MCP token's half. The people and the companies
// are made up.

import { REGISTRY, SCOPES, isCompanyInput, type Operation } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { someEmail } from "../../test/identities.ts";
import { OPERATION_ARGUMENTS, type ArgumentsFixture } from "../../test/operation-arguments.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, jsonOf, signInApp, testClock, type SignInApp } from "../../test/sign-in.ts";
import { callWithToken, makeApiToken } from "../../test/tokens.ts";
import { apiCompany, calls, invite, joinWith, newMember, type ApiCompany } from "../../test/users.ts";

/** Every operation that a token may call: those that name a scope. */
const SCOPED: readonly Operation[] = REGISTRY.filter((operation) => operation["x-nortfox"].scope !== null);

/** A company id that no company has. */
const NOWHERE = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";

/** One operation's scene: a person, the company of their token, the other company where they are a system administrator, and the token. */
interface Scene {
  readonly alfa: ApiCompany;
  readonly beta: ApiCompany;
  /** The person's membership in Beta. */
  readonly inBeta: string;
  readonly token: string;
  /** What names Beta or its members, which no answer of the token's may hold. */
  readonly betaFacts: readonly string[];
}

describe("a token stays in its company", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  /** Reads every row past row level security, for the checks. */
  let superuser: Client;
  let pool: AppPool;
  let server: SignInApp;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    superuser = await db.admin();
    pool = appPool(db, 4);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()) });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** A person who owns Alfa and is a system administrator of Beta, which another person made, and the person's token of Alfa with every scope. */
  async function scene(): Promise<Scene> {
    const alfa = await apiCompany(server, { app, owner }, "Testbolaget Alfa AB");
    const beta = await apiCompany(server, { app, owner }, "Testbolaget Beta AB");
    const inBeta = await joinWith(server, alfa.creator, (await invite(server, beta.session, alfa.creator.email, "Alva Berg")).token);
    await jsonOf(await calls.updateUser(server, beta.session, inBeta, { adminLevel: "admin" }));
    const { token } = await makeApiToken(server, alfa.session, { scopes: [...SCOPES] });
    const betaFacts = [beta.id, beta.row.name, `"databaseNumber":${String(beta.row.database_number)}`, inBeta, beta.membership, beta.creator.id, beta.creator.email];
    return { alfa, beta, inBeta, token, betaFacts };
  }

  /** The fixture of a scene: every member, invitation and token in Alfa, as the person's own session makes them. */
  function fixtureOf(scene: Scene): ArgumentsFixture {
    const clients = { app, owner };
    return {
      setupToken: () => Promise.reject(new Error("No operation with a scope takes a setup link.")),
      person: () => Promise.reject(new Error("No operation with a scope takes a new person.")),
      challenge: () => Promise.reject(new Error("No operation with a scope takes a login challenge.")),
      companyOf: () => Promise.resolve(scene.alfa.id),
      memberOf: async (_person, program) => {
        const member = await newMember(server, clients, scene.alfa);
        if (program !== undefined) {
          await jsonOf(await calls.assignProgram(server, scene.alfa.session, member.id, program, { full: true }));
        }
        return member.id;
      },
      invitedOf: async () => (await invite(server, scene.alfa.session, someEmail(), "Tove Ny")).id,
      invitationToken: () => Promise.reject(new Error("No operation with a scope takes an invitation's link.")),
      // The person leaves Alfa beside another system administrator, so the leave succeeds.
      joinedCompanyOf: async () => {
        const other = await newMember(server, clients, scene.alfa);
        await jsonOf(await calls.updateUser(server, scene.alfa.session, other.id, { adminLevel: "admin" }));
        return scene.alfa.id;
      },
      tokenOf: async () => (await makeApiToken(server, scene.alfa.session, { name: "Att återkalla", scopes: ["companyinformation"] })).id,
    };
  }

  /** What the install holds that names `company`: its behandlingshistorik, and the install-wide rows that name it. */
  async function rowsOf(company: string): Promise<string> {
    const found = await superuser.query<{ rows: string }>(
      `SELECT pg_catalog.jsonb_build_array(
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM audit.history AS t WHERE t.company_id = $1),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.api_tokens AS t WHERE t.token_company_id = $1),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.idempotency_keys AS t WHERE t.key_company_id = $1),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.chosen_at) FROM access.recent_companies AS t WHERE t.chosen_company_id = $1),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.membership_id) FROM access.membership_contacts AS t WHERE t.contact_company_id = $1),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.invitation_links AS t WHERE t.invited_company_id = $1),
         (SELECT pg_catalog.jsonb_agg(t ORDER BY t.id) FROM access.sessions AS t WHERE t.current_company_id = $1)
       )::text AS rows`,
      [company],
    );
    return found.rows[0]?.rows ?? "";
  }

  /** The last row of the behandlingshistorik, so a call's own rows are those after it. */
  async function historyMark(): Promise<string> {
    return (await superuser.query<{ last: string }>("SELECT COALESCE(pg_catalog.max(id), 0)::text AS last FROM audit.history")).rows[0]?.last ?? "0";
  }

  /** The companies whose behandlingshistorik got rows after `mark`. */
  async function companiesWrittenAfter(mark: string): Promise<string[]> {
    const found = await superuser.query<{ company_id: string }>("SELECT DISTINCT company_id FROM audit.history WHERE id > $1::bigint ORDER BY company_id", [mark]);
    return found.rows.map((row) => row.company_id);
  }

  it("covers every operation that names a scope, and each has its arguments", () => {
    expect(SCOPED.length).toBeGreaterThan(0);
    for (const operation of SCOPED) {
      expect(OPERATION_ARGUMENTS[operation.operationId], operation.operationId).toBeDefined();
    }
    expect(SCOPED.filter((operation) => isCompanyInput(operation["x-nortfox"].company)).map((operation) => operation.operationId)).toEqual([
      "updateMyMembership",
      "leaveCompany",
    ]);
  });

  it.each(SCOPED.map((operation) => [operation.operationId, operation] as const))(
    "%s writes no row in and tells no fact about another company of the person, but createCompany writes in the company it makes",
    async (id, operation) => {
      const at = await scene();
      const argumentsOf = OPERATION_ARGUMENTS[id];
      if (argumentsOf === undefined) {
        throw new Error(`${id} has no arguments in test/operation-arguments.ts.`);
      }
      const args = await argumentsOf(fixtureOf(at), at.alfa.creator);
      const beta = await rowsOf(at.beta.id);
      const source = operation["x-nortfox"].company;
      if (isCompanyInput(source)) {
        // Naming Beta gets the answer of a company that does not exist.
        const toBeta = await callWithToken(server, at.token, operation, { ...args, [source.input]: at.beta.id, idempotencyKey: `${id}-to-beta` });
        const toNowhere = await callWithToken(server, at.token, operation, { ...args, [source.input]: NOWHERE, idempotencyKey: `${id}-to-nowhere` });
        const refused = await jsonOf(toBeta, 422);
        expect(refused).toMatchObject({ code: "company-not-available", pointer: `/${source.input}` });
        expect(await jsonOf(toNowhere, 422)).toEqual(refused);
        expect(await rowsOf(at.beta.id), `${id} naming Beta`).toBe(beta);
      }
      const mark = await historyMark();
      const answer = await callWithToken(server, at.token, operation, args);
      const text = await answer.text();
      expect(answer.status, `${id}: ${text}`).toBeLessThan(300);
      expect(await rowsOf(at.beta.id), `${id} wrote in Beta`).toBe(beta);
      for (const fact of at.betaFacts) {
        expect(text, `${id}'s answer`).not.toContain(fact);
      }
      const written = await companiesWrittenAfter(mark);
      if (id === "createCompany") {
        expect(written).toEqual([(JSON.parse(text) as { id: string }).id]);
      } else {
        expect(written.filter((company) => company !== at.alfa.id), `${id} wrote outside Alfa`).toEqual([]);
      }
      if (id === "listCompanies") {
        expect((JSON.parse(text) as { items: { company: { id: string } }[] }).items.map((item) => item.company.id)).toEqual([at.alfa.id]);
      }
    },
  );

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
