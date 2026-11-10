// SPDX-License-Identifier: AGPL-3.0-only

// The bearer path of the server's resolver, before the database: the token
// in Authorization, in RFC 6750's form, and only an API token's form reaches
// the lookup. A bearer token that is not one names no actor, and the cookie
// beside it is never read. On /mcp the resolver reads no bearer token: an
// API token works on /v1 only. api-tokens.db.test.ts and the other token
// tests run the lookup on PostgreSQL.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { untouchedDatabase } from "../../test/api.ts";
import type { Channel, Database, LookupQueryable, LookupWork } from "../db/database.ts";
import { apiTokenPrincipal, bearerToken } from "./api-token.ts";
import { credentialResolver } from "./resolver.ts";
import { newToken } from "./tokens.ts";

const NOW = new Date("2090-03-15T10:00:00.000Z");

/** A request to /v1 or /mcp with these headers. */
function requestWith(headers: Readonly<Record<string, string>>, path = "/v1/company"): Request {
  return new Request(`https://nortfox.example${path}`, { headers });
}

describe("bearerToken", () => {
  it.each([
    ["Bearer nft_abc", "nft_abc"],
    ["bearer nft_abc", "nft_abc"],
    ["BEARER   nft_abc", "nft_abc"],
  ])("reads the token of %j", (header, token) => {
    expect(bearerToken(new Headers({ authorization: header }))).toBe(token);
  });

  it.each([["Bearer"], ["Bearer "], ["Bearer nft_a nft_b"], ["Basic YTpi"], ["Bearernft_abc"], ["nft_abc"]])("reads no token of %j", (header) => {
    expect(bearerToken(new Headers({ authorization: header }))).toBeUndefined();
  });

  it("reads no token of a request without Authorization", () => {
    expect(bearerToken(new Headers())).toBeUndefined();
  });
});

describe("the resolver with a bearer token", () => {
  it.each([
    ["a bearer header that holds no token in RFC 6750's form", "Bearer nft_a nft_b"],
    ["a session's token", `Bearer ${newToken("session")}`],
    ["an MCP access token, which works on /mcp alone", `Bearer ${newToken("mcpAccess")}`],
    ["a text that is no token of NortFox's", "Bearer not-a-token"],
  ])("names no actor on /v1 for %s, reads no cookie, and asks no database", async (_what, authorization) => {
    const database = untouchedDatabase();
    const resolve = credentialResolver({ database, now: () => NOW });
    const session = newToken("session");
    expect(await resolve(requestWith({ authorization, cookie: `__Host-nortfox-session=${session}` }), "rest")).toBeUndefined();
    expect(database.asked).toEqual([]);
  });

  it("looks an API token up on /v1, and never on /mcp", async () => {
    const database = untouchedDatabase();
    const resolve = credentialResolver({ database, now: () => NOW });
    const authorization = `Bearer ${newToken("apiToken")}`;
    expect(await resolve(requestWith({ authorization }, "/mcp"), "mcp")).toBeUndefined();
    expect(database.asked).toEqual([]);
    await expect(resolve(requestWith({ authorization }), "rest")).rejects.toThrow("The database was asked to lookup");
    expect(database.asked).toEqual(["lookup"]);
  });
});

describe("apiTokenPrincipal", () => {
  // The one membership function also needs an active identity, so only a lookup that gives the status by itself shows the token's own check.
  // "locked" stands for any status that is not active, such as one a later release adds.
  it.each([["deleted"], ["locked"]])("names no actor when the token's identity is %s, and goes no further than the lookup", async (status) => {
    const asked: string[] = [];
    const row = { token_id: randomUUID(), identity_id: randomUUID(), status, token_company_id: randomUUID(), membership_id: randomUUID(), scopes: ["profile"] };
    const tx = {
      query: (text: string) => {
        asked.push(text);
        return Promise.resolve({ rows: [row] });
      },
      actAs: () => {
        asked.push("actAs");
        return Promise.resolve();
      },
      enter: () => {
        asked.push("enter");
        return Promise.resolve();
      },
    } as unknown as LookupQueryable;
    const database: Database = {
      ...untouchedDatabase(),
      lookup: async <T>(_channel: Channel, work: LookupWork<T>): Promise<T> => (await work(tx)).value,
    };
    expect(await apiTokenPrincipal(database, newToken("apiToken"), NOW)).toBeUndefined();
    expect(asked).toEqual(["SELECT token_id, identity_id, status, token_company_id, membership_id, scopes FROM access.api_token_by_token($1)"]);
  });
});
