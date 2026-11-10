// SPDX-License-Identifier: AGPL-3.0-only

// T2 (issue 12, "API tokens" 3 and 4). This is the API token's half: a
// member sees and revokes only their own tokens (tokens:own); a system
// administrator sees and revokes every token of the company (tokens:all),
// and none of another company. A revoked token is refused on the next
// request, the list holds it no more, and a second revoke finds nothing.
// The same holds through a token with the scope tokens, which acts as its
// person. Part 5 completes this file with the consents. The people and the
// companies are made up.

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, type AppPool, type ProblemBody } from "../../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../../test/database.ts";
import { expectNoSecretsAtRestFromSignInApps, expectNoTokensFromSignInApps, getAs, jsonOf, signInApp, testClock, writeAs, type SignInApp } from "../../../test/sign-in.ts";
import { asToken, makeApiToken, type MadeApiToken } from "../../../test/tokens.ts";
import { apiCompany, newMember, sessionIn, type ApiCompany } from "../../../test/users.ts";

/** A token as listApiTokens gives it. */
interface Listed {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly userId: string;
  readonly createdAt: string;
}

/** A made token as the list gives it: without the token. */
function listedOf(made: MadeApiToken): Listed {
  return { id: made.id, name: made.name, scopes: made.scopes, userId: made.userId, createdAt: made.createdAt };
}

describe("own and all API tokens", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;
  let pool: AppPool;
  let server: SignInApp;
  let company: ApiCompany;
  let other: ApiCompany;
  let first: { readonly session: string; readonly id: string };
  let second: { readonly session: string; readonly id: string };

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
    pool = appPool(db, 4);
    // The database stamps an invitation's time with its own clock, so the server's starts at the same time.
    server = signInApp(pool.database, { clock: testClock(new Date()) });
    company = await apiCompany(server, { app, owner }, "Testbolaget Alfa AB");
    other = await apiCompany(server, { app, owner }, "Testbolaget Beta AB");
    const one = await newMember(server, { app, owner }, company);
    const two = await newMember(server, { app, owner }, company);
    first = { session: await sessionIn(server, one.person, company.id), id: one.person.id };
    second = { session: await sessionIn(server, two.person, company.id), id: two.person.id };
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function listed(session: string): Promise<Listed[]> {
    const page = await jsonOf<{ items: Listed[]; total: number }>(await getAs(server, session, "/v1/api-tokens"));
    expect(page.total).toBe(page.items.length);
    return page.items;
  }

  function revoke(session: string, id: string): Promise<Response> {
    return writeAs(server, session, "DELETE", `/v1/api-tokens/${id}`, undefined);
  }

  it("a member sees and revokes only their own", async () => {
    const mine = await makeApiToken(server, first.session, { name: "Min export", scopes: ["companyinformation", "tokens"] });
    const theirs = await makeApiToken(server, second.session, { name: "Deras export", scopes: ["companyinformation"] });
    expect(await listed(first.session)).toEqual([listedOf(mine)]);
    expect(await listed(second.session)).toEqual([listedOf(theirs)]);
    // Another's token is not found, the same as one that does not exist, and stays live.
    const refused = await jsonOf<ProblemBody>(await revoke(first.session, theirs.id), 422);
    expect(refused).toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "The company has no live API token with the id that tokenId names that the actor may revoke.",
      code: "api-token-not-found",
      pointer: "/tokenId",
    });
    expect(await jsonOf<ProblemBody>(await revoke(first.session, "0b1c2d3e-4f50-4617-8899-aabbccddeeff"), 422)).toEqual(refused);
    expect((await asToken(server, theirs.token, "GET", "/v1/company")).status).toBe(200);
    // Through a token, as its person: only the person's own.
    const page = await jsonOf<{ items: Listed[] }>(await asToken(server, mine.token, "GET", "/v1/api-tokens"));
    expect(page.items).toEqual([listedOf(mine)]);
    expect(await jsonOf<ProblemBody>(await asToken(server, mine.token, "DELETE", `/v1/api-tokens/${theirs.id}`), 422)).toEqual(refused);
  });

  it("a system administrator sees and revokes all of the company's, and none of another company", async () => {
    const own = await makeApiToken(server, company.session, { name: "Ägarens export", scopes: ["tokens"] });
    const members = await makeApiToken(server, first.session, { name: "Medlemmens export", scopes: ["companyinformation"] });
    const elsewhere = await makeApiToken(server, other.session, { name: "Annat bolag", scopes: ["companyinformation"] });
    const all = await listed(company.session);
    expect(all).toEqual(expect.arrayContaining([listedOf(own), listedOf(members)]));
    expect(all.map((token) => token.id)).not.toContain(elsewhere.id);
    expect(new Set(all.map((token) => token.userId))).toEqual(new Set([company.creator.id, first.id, second.id]));
    // The list is in the order the tokens were made.
    expect(all.map((token) => token.createdAt)).toEqual(all.map((token) => token.createdAt).sort());
    expect((await revoke(company.session, members.id)).status).toBe(204);
    expect((await asToken(server, members.token, "GET", "/v1/company")).status).toBe(401);
    expect(await jsonOf<ProblemBody>(await revoke(company.session, elsewhere.id), 422)).toMatchObject({ code: "api-token-not-found" });
    expect((await asToken(server, elsewhere.token, "GET", "/v1/company")).status).toBe(200);
    // Through the owner's token too.
    const through = await makeApiToken(server, first.session, { name: "Att återkalla", scopes: ["companyinformation"] });
    expect((await jsonOf<{ items: Listed[] }>(await asToken(server, own.token, "GET", "/v1/api-tokens"))).items).toContainEqual(listedOf(through));
    expect((await asToken(server, own.token, "DELETE", `/v1/api-tokens/${through.id}`)).status).toBe(204);
    expect((await asToken(server, through.token, "GET", "/v1/company")).status).toBe(401);
  });

  it("a revoked token is refused on the next request, the list holds it no more, and a second revoke finds nothing", async () => {
    const made = await makeApiToken(server, second.session, { name: "Kortlivad", scopes: ["companyinformation"] });
    expect((await asToken(server, made.token, "GET", "/v1/company")).status).toBe(200);
    expect((await revoke(second.session, made.id)).status).toBe(204);
    expect(await jsonOf<ProblemBody>(await asToken(server, made.token, "GET", "/v1/company"), 401)).toMatchObject({ code: "authentication-required" });
    expect((await listed(second.session)).map((token) => token.id)).not.toContain(made.id);
    expect(await jsonOf<ProblemBody>(await revoke(second.session, made.id), 422)).toMatchObject({ code: "api-token-not-found" });
    // A repeat with the revoke's key gives its first answer.
    const again = await makeApiToken(server, second.session, { name: "Med nyckel", scopes: ["companyinformation"] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await writeAs(server, second.session, "DELETE", `/v1/api-tokens/${again.id}`, undefined, { key: "revoke-once" })).status).toBe(204);
    }
  });

  it("pages the list in the order the tokens were made, with limit and cursor", async () => {
    for (const name of ["Första", "Andra", "Tredje"]) {
      await makeApiToken(server, company.session, { name, scopes: ["companyinformation"] });
    }
    const all = await listed(company.session);
    expect(all.length).toBeGreaterThan(3);
    const paged: Listed[] = [];
    let cursor: string | undefined;
    do {
      const page = await jsonOf<{ items: Listed[]; total: number; nextCursor?: string }>(
        await getAs(server, company.session, `/v1/api-tokens?limit=2${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`),
      );
      expect(page.total).toBe(all.length);
      expect(page.items.length).toBeLessThanOrEqual(2);
      paged.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(paged).toEqual(all);
  });

  it("leaves no token in an answer and no secret at rest", async () => {
    expectNoTokensFromSignInApps();
    await expectNoSecretsAtRestFromSignInApps(db);
  });
});
