// SPDX-License-Identifier: AGPL-3.0-only

// The server's resolver (docs/decisions/0008-authentication.md): it reads the
// request's credential from its headers, never its body, and gives the
// principal, or nothing when the request names no actor.
//
// - On /v1, a request with a bearer token is a program's, and it ignores the
//   cookie. API tokens come in a later part of slice 2c, so until then a
//   bearer token names no actor. Without one, the session cookie: exactly one
//   __Host-nortfox-session in the form NortFox writes, holding a session's
//   token.
// - On /mcp, never the cookie: an MCP client signs in through OAuth, in a
//   later part. Until then /mcp knows no actor.
//
// The session is looked up on every request, by its token's hash, in one
// lookup transaction before the request's own (Database.lookup). An ended
// session, or one whose identity is not active, gives nothing. A session
// ends 12 hours after it began, and, while it has no company, after 120
// minutes without a request: the resolver ends it with that reason, and it
// gives nothing from then on. A request moves the session's last sight on
// when it is a minute old or more, so a session is not written on every
// request. A session runs as its user (decision 2).

import type { ContextResolver, Principal, SignInMethod } from "../api/context.ts";
import { commit, type Database } from "../db/database.ts";
import { SESSION_COOKIE, readCookie } from "./cookies.ts";
import { carriesBearer } from "./origin.ts";
import { tokenHash, tokenKind } from "./tokens.ts";

/** A session ends this long after it began (ASVS 4.0.3 3.3.2; choice 12). */
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** A session with no company ends after this long without a request (choice 2). */
export const NO_COMPANY_IDLE_MS = 120 * 60 * 1000;

/** A request moves the session's last sight on once it is this old. */
export const TOUCH_AFTER_MS = 60 * 1000;

export interface SessionResolverOptions {
  readonly database: Database;
  /** The server's clock. */
  readonly now: () => Date;
}

interface SessionRow {
  readonly session_id: string;
  readonly identity_id: string;
  readonly status: string;
  readonly method: SignInMethod;
  readonly started_at: Date;
  readonly last_seen_at: Date;
}

/** Why a live session ends at `at`, or undefined while it lasts. */
function endOf(session: SessionRow, at: Date): "absolute" | "idle" | undefined {
  if (at.getTime() >= session.started_at.getTime() + SESSION_LIFETIME_MS) {
    return "absolute";
  }
  return at.getTime() >= session.last_seen_at.getTime() + NO_COMPANY_IDLE_MS ? "idle" : undefined;
}

/** The session's token in the request's cookie, or undefined when the request names none. */
function sessionToken(request: Request): string | undefined {
  if (carriesBearer(request.headers)) {
    return undefined;
  }
  const token = readCookie(request.headers, SESSION_COOKIE);
  return token !== undefined && tokenKind(token) === "session" ? token : undefined;
}

/** The resolver of the browser's sessions on /v1. */
export function sessionResolver(options: SessionResolverOptions): ContextResolver {
  const { database, now } = options;
  return async (request, surface) => {
    const token = surface === "rest" ? sessionToken(request) : undefined;
    if (token === undefined) {
      return undefined;
    }
    const at = now();
    return database.lookup("rest", async (tx) => {
      const found = await tx.query<SessionRow>(
        "SELECT session_id, identity_id, status, method, started_at, last_seen_at FROM access.session_by_token($1)",
        [tokenHash(token)],
      );
      const [session] = found.rows;
      if (session?.status !== "active") {
        return commit(undefined);
      }
      const end = endOf(session, at);
      if (end !== undefined) {
        await tx.query("SELECT access.end_session($1, $2, $3)", [session.session_id, end, at]);
        return commit(undefined);
      }
      if (at.getTime() - session.last_seen_at.getTime() >= TOUCH_AFTER_MS) {
        await tx.query("SELECT access.touch_session($1, $2)", [session.session_id, at]);
      }
      const principal: Principal = {
        personId: session.identity_id,
        actorKind: "user",
        credential: { kind: "session", sessionId: session.session_id, method: session.method },
      };
      return commit(principal);
    });
  };
}
