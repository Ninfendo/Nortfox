// SPDX-License-Identifier: AGPL-3.0-only

// The API tokens (issue 12, "API tokens"; db/README.md, the API tokens).
// access.api_tokens is an install-wide table of the company class: the app
// reads, adds and revokes only the tokens of the transaction's company. The
// database stamps a token's person, from the transaction's actor, and the
// time it was made, and writes its entries in the company's
// behandlingshistorik. A handler never reads a token's hash.
//
// - createApiToken, in a browser session (the session-only mark): a new
//   random token, nft_, stored as its SHA-256 for the session's company and
//   membership, with its name and its scopes, each once, in the order of
//   SCOPES. The membership is held until the commit, so a deactivation, a
//   removal, a leave or a disconnect that committed first makes no token,
//   and one that comes later waits, and then finds the token. The answer
//   holds the token, which the runner never keeps with the write's key: a
//   repeat with the key gets answer-shown-once.
// - listApiTokens: the company's live tokens, by when they were made: the
//   actor's own, or every one with tokens:all, which a system administrator
//   holds.
// - revokeApiToken: a live token of the company, the actor's own, or any with
//   tokens:all, by the server's clock. Any other id, also one of a revoked
//   token, gets api-token-not-found, so a member learns nothing of another's
//   tokens. The database stamps who revoked it.

import { SCOPES, createApiToken, listApiTokens, revokeApiToken, type ApiToken } from "@nortfox/contract";
import type { CompanyContext } from "../../api/context.ts";
import { credentialEnded, handleData, handleList, ok, refused } from "../../api/operation.ts";
import { newToken, tokenHash } from "../../auth/tokens.ts";
import { holdActive } from "../memberships/membership.ts";

/** A token as the app reads it: never its hash. */
interface TokenRow {
  readonly id: string;
  readonly name: string;
  readonly scopes: ApiToken["scopes"];
  readonly identity_id: string;
  readonly created_at: Date;
}

/** The columns of a token that the API gives. */
const TOKEN_COLUMNS = "id, name, scopes, identity_id, created_at";

/** A token as the API gives it. */
function apiTokenOf(row: TokenRow): ApiToken {
  return { id: row.id, name: row.name, scopes: row.scopes, userId: row.identity_id, createdAt: row.created_at.toISOString() };
}

/** The person whose tokens the actor reaches: their own, or null for every one of the company with tokens:all. */
function ownerOf(context: CompanyContext): string | null {
  return context.company.permissions.includes("tokens:all") ? null : context.personId;
}

export const createApiTokenHandler = handleData(createApiToken, async ({ context, tx }, { body }) => {
  const { company } = context;
  // The membership stays the person's active one until the commit, or the session that chose it has ended.
  if ((await holdActive(tx, company.membershipId, context.personId)) === undefined) {
    return credentialEnded();
  }
  const token = newToken("apiToken");
  const scopes = SCOPES.filter((scope) => body.scopes.includes(scope));
  const made = await tx.query<TokenRow>(
    `INSERT INTO access.api_tokens (token_hash, token_company_id, membership_id, name, scopes) VALUES ($1, $2, $3, $4, $5) RETURNING ${TOKEN_COLUMNS}`,
    [tokenHash(token), company.companyId, company.membershipId, body.name, scopes],
  );
  // An insert with RETURNING gives its one row.
  const [row] = made.rows as [TokenRow];
  return ok({ ...apiTokenOf(row), token });
});

export const listApiTokensHandler = handleList(listApiTokens, async ({ context, tx, page }) => {
  const owner = ownerOf(context);
  const [afterAt, afterId] = page.after ?? [];
  const found = await tx.query<TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM access.api_tokens
     WHERE revoked_at IS NULL AND ($1::uuid IS NULL OR identity_id = $1) AND ($2::timestamptz IS NULL OR (created_at, id) > ($2, $3::uuid))
     ORDER BY created_at, id LIMIT $4`,
    [owner, afterAt ?? null, afterId ?? null, page.limit + 1],
  );
  const counted = await tx.query<{ total: string }>("SELECT count(*) AS total FROM access.api_tokens WHERE revoked_at IS NULL AND ($1::uuid IS NULL OR identity_id = $1)", [owner]);
  const items = found.rows.slice(0, page.limit).map(apiTokenOf);
  // A count gives one row.
  const total = Number((counted.rows as [{ readonly total: string }])[0].total);
  const last = found.rows.length > page.limit ? found.rows[page.limit - 1] : undefined;
  return ok(last === undefined ? { items, total } : { items, total, next: [last.created_at.toISOString(), last.id] });
});

export const revokeApiTokenHandler = handleData(revokeApiToken, async ({ context, tx, now }, { params }) => {
  const revoked = await tx.query(
    "UPDATE access.api_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR identity_id = $3) RETURNING id",
    [params.tokenId, now(), ownerOf(context)],
  );
  if (revoked.rows.length === 0) {
    return refused({
      code: "api-token-not-found",
      detail: "The company has no live API token with the id that tokenId names that the actor may revoke.",
      pointer: "/tokenId",
    });
  }
  return ok({});
});
