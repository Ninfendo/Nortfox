// SPDX-License-Identifier: AGPL-3.0-only

// The bearer path of the server's resolver on /v1: an API token
// (docs/decisions/0008-authentication.md; issue 12, "API tokens"). A
// request with Authorization: Bearer is a program's, and the cookie is not
// read. The token must be one in NortFox's form for an API token, nft_; any
// other value names no actor. It is looked up on every request, by its
// hash, in one lookup transaction before the request's own
// (Database.lookup):
//
// 1. access.api_token_by_token gives the token, if it is not revoked, with
//    its person, the identity's status, its company, its membership and its
//    scopes. A token whose identity is not active names no actor.
// 2. The lookup acts as the token's person, an integration through the
//    token (decision 2), and asks the one membership function for the
//    person's active membership in the token's company. A token is bound to
//    its membership: when the function gives none, or another one, it names
//    no actor, and its row stays. So a deactivated member's token works again
//    once the member is active again (choice 11), and a removed, a left or a
//    disconnected member's never does: a new invitation makes another
//    membership, and a disconnect revokes the tokens of the one it invites
//    again (modules/memberships/members.ts).
// 3. The lookup enters the company from that membership (tx.enter), and
//    reads the member's program grants and administered programs there. The
//    token's permissions are its person's there now, read on every request:
//    a token has no snapshot, so a permission that its person loses is
//    refused from the token's next request, and a Revisor grant's end holds
//    at once.
//
// The principal is the person, the kind integration, the token as the via,
// the token's scopes, and the company with those permissions. A token works
// on /v1 only (open point 7): /mcp never reads it.

import { SCOPES, effectivePermissions, type Scope } from "@nortfox/contract";
import type { Principal } from "../api/context.ts";
import { commit, type Database, type Via } from "../db/database.ts";
import { memberAccess, readPrograms } from "../modules/memberships/programs.ts";
import { resolveActive } from "../modules/memberships/resolve.ts";
import { tokenHash, tokenKind } from "./tokens.ts";

/** A bearer token in Authorization (RFC 6750, 2.1): the scheme in any letter case, one or more spaces, and the token. */
const BEARER = /^bearer +(\S+)$/i;

/** The bearer token that a request's Authorization holds, or undefined when it holds none in that form. */
export function bearerToken(headers: Headers): string | undefined {
  return BEARER.exec(headers.get("authorization") ?? "")?.[1];
}

/** A live API token as access.api_token_by_token gives it. */
interface TokenRow {
  readonly token_id: string;
  readonly identity_id: string;
  readonly status: string;
  readonly token_company_id: string;
  readonly membership_id: string;
  readonly scopes: readonly string[];
}

/**
 * The principal of an API token at `at`, or undefined when `token` names no
 * actor: a value that is not an API token's, an unknown or a revoked token, a
 * token whose identity is not active, or one whose membership is not its
 * person's active one in its company.
 */
export async function apiTokenPrincipal(database: Database, token: string, at: Date): Promise<Principal | undefined> {
  if (tokenKind(token) !== "apiToken") {
    return undefined;
  }
  const hash = tokenHash(token);
  return database.lookup("rest", async (tx) => {
    const found = await tx.query<TokenRow>("SELECT token_id, identity_id, status, token_company_id, membership_id, scopes FROM access.api_token_by_token($1)", [hash]);
    const [row] = found.rows;
    if (row?.status !== "active") {
      return commit(undefined);
    }
    const via: Via = { kind: "api-token", id: row.token_id };
    await tx.actAs(row.identity_id, "integration", via);
    // The function reads the person from the lookup's actor: it gives only the token's person's membership.
    const membership = await resolveActive(tx, row.token_company_id);
    if (membership?.membershipId !== row.membership_id) {
      return commit(undefined);
    }
    await tx.enter(membership);
    const programs = await readPrograms(tx, membership.membershipId);
    const permissions = effectivePermissions(memberAccess(membership.adminLevel, programs), at);
    // The database holds only names in the form of a scope; a name that SCOPES no longer holds gives nothing.
    const scopes: ReadonlySet<Scope> = new Set(SCOPES.filter((scope) => row.scopes.includes(scope)));
    const principal: Principal = {
      personId: row.identity_id,
      actorKind: "integration",
      via,
      credential: { kind: "api-token", tokenId: row.token_id, scopes },
      company: membership.access(permissions.keys(), programs.administered),
    };
    return commit(principal);
  });
}
