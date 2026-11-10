// SPDX-License-Identifier: AGPL-3.0-only

// The API tokens as the database tests make them (db/README.md, the schema
// access). The app adds a token in the transaction's company, for the
// membership of the person who makes it, as createApiToken will. The
// database stamps the person and the time, and writes the token's entry in
// the behandlingshistorik. The names and the hashes are made up.

import type { Client } from "pg";
import { inTransaction } from "./database.ts";
import { tokenHash } from "./identities.ts";
import type { Actor } from "./ledger.ts";

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
