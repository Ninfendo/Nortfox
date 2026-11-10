// SPDX-License-Identifier: AGPL-3.0-only

// The bearer path of the server's resolver, before the database: the token
// in Authorization, in RFC 6750's form, and only an API token's form reaches
// the lookup. A bearer token that is not one names no actor, and the cookie
// beside it is never read. On /mcp the resolver reads no bearer token: an
// API token works on /v1 only. api-tokens.db.test.ts and the other token
// tests run the lookup on PostgreSQL.

import { describe, expect, it } from "vitest";
import { untouchedDatabase } from "../../test/api.ts";
import { bearerToken } from "./api-token.ts";
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
