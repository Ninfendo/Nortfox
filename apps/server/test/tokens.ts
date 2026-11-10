// SPDX-License-Identifier: AGPL-3.0-only

// The API tokens as the tests make and use them (db/README.md, the schema
// access; docs/api.md, Who acts). A database test adds a token as the app
// does, in the transaction's company, for the membership of the person who
// makes it: the database stamps the person and the time, and writes the
// token's entry in the behandlingshistorik. An API test makes one with
// createApiToken, by a browser session, and sends requests with it as a
// program does: in Authorization, with no Origin and no cookie. The names
// and the hashes are made up.

import { randomUUID } from "node:crypto";
import { SCOPES, type Operation, type Scope } from "@nortfox/contract";
import type { Client } from "pg";
import { inTransaction } from "./database.ts";
import { tokenHash } from "./identities.ts";
import type { Actor } from "./ledger.ts";
import { restRequestOf } from "./operation-arguments.ts";
import { TEST_ORIGIN, cookieHeader, type SignInApp } from "./sign-in.ts";

/** An API token as the database holds it, with its times as text and without its hash. */
export interface ApiTokenRow {
  readonly id: string;
  readonly token_company_id: string;
  readonly membership_id: string;
  readonly identity_id: string;
  readonly name: string;
  readonly scopes: string[];
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
}

/** The columns of an API token but its hash, with its times as text. */
export const API_TOKEN_COLUMNS = "id, token_company_id, membership_id, identity_id, name, scopes, created_at::text AS created_at, revoked_at::text AS revoked_at, revoked_by";

/** What a test may give a new token. Each value left out takes a made-up one. */
export interface NewApiToken {
  readonly hash?: Buffer;
  readonly name?: string;
  readonly scopes?: readonly string[];
}

/** The statement that adds a token, as the app runs it. */
export const INSERT_API_TOKEN = `INSERT INTO access.api_tokens (token_hash, token_company_id, membership_id, name, scopes)
  VALUES ($1, $2, $3, $4, $5) RETURNING ${API_TOKEN_COLUMNS}`;

/**
 * Adds a token as `client` in a transaction of its own in `company`, for
 * `membership`, as `who`, through REST, and gives its row and its hash.
 */
export async function addApiToken(
  client: Client,
  company: string,
  membership: string,
  who: Actor,
  token: NewApiToken = {},
): Promise<{ readonly row: ApiTokenRow; readonly hash: Buffer }> {
  const hash = token.hash ?? tokenHash();
  const row = await inTransaction(client, { company, ...who, channel: "rest" }, async () => {
    const found = await client.query<ApiTokenRow>(INSERT_API_TOKEN, [hash, company, membership, token.name ?? "Bokföringsexport", token.scopes ?? ["bookkeeping"]]);
    return found.rows[0];
  });
  if (row === undefined) {
    throw new Error("The token was not added.");
  }
  return { row, hash };
}

/** What createApiToken answers: the token's facts, and the token, which only this answer gives. */
export interface MadeApiToken {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly userId: string;
  readonly createdAt: string;
  readonly token: string;
}

/** What a test may give createApiToken. Each value left out takes a made-up one: every scope by default. */
export interface WantedApiToken {
  readonly name?: string;
  readonly scopes?: readonly Scope[];
  readonly key?: string;
}

/** The body of createApiToken, as the web app sends it. */
export function apiTokenBody(wanted: WantedApiToken = {}): { readonly name: string; readonly scopes: readonly string[] } {
  return { name: wanted.name ?? "Bokföringsexport", scopes: wanted.scopes ?? [...SCOPES] };
}

/**
 * Makes an API token with createApiToken, by `session`, as the web app does.
 * The request goes past the sign-in app's record of answers: its answer
 * holds the token, as it must, so the scan of the other answers stays
 * strict.
 */
export async function makeApiToken(server: SignInApp, session: string, wanted: WantedApiToken = {}): Promise<MadeApiToken> {
  const response = await server.app.hono.request("/v1/api-tokens", {
    method: "POST",
    headers: { origin: TEST_ORIGIN, "content-type": "application/json", "idempotency-key": wanted.key ?? randomUUID(), ...cookieHeader({ session }) },
    body: JSON.stringify(apiTokenBody(wanted)),
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`createApiToken answered ${String(response.status)}: ${text}`);
  }
  return JSON.parse(text) as MadeApiToken;
}

/** The methods a request with a token takes. */
export type TokenMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Sends a request with `token` as its bearer token, as a program does: no
 * Origin and no cookie. A write gets an idempotency key, a new one unless
 * the test gives one, and a body goes as JSON.
 */
export function asToken(server: SignInApp, token: string, method: TokenMethod, path: string, options: { readonly body?: unknown; readonly key?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(method === "GET" ? {} : { "idempotency-key": options.key ?? randomUUID() }),
  };
  return server.send(path, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
}

/** Calls `operation` by REST with its flat input `args`, and `token` as the bearer token, as a program does. */
export function callWithToken(server: SignInApp, token: string, operation: Operation, args: Readonly<Record<string, unknown>>): Promise<Response> {
  const { path, init } = restRequestOf(operation, args);
  return server.send(path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
}
