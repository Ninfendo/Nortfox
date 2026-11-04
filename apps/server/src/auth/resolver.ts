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
// ends 12 hours after it began. A session that chose a company works in it
// with the membership it chose it with: the lookup acts as the person and
// asks the one membership function (modules/memberships/resolve.ts). When
// the function gives no active membership there, or another one than the
// session's, the session ends with the reason membership, so a deactivated,
// removed or departed member's session is refused on its next request. The
// idle time is the membership's, "Utloggning efter inaktivitet", and 120
// minutes while the session works in no company: past it the session ends
// with the reason idle. An ended session gives nothing from then on. The
// permissions are the session's snapshot of when it chose the company, less
// a permission whose grant has ended. A request moves the session's last
// sight on when it is a minute old or more, so a session is not written on
// every request. A session runs as its user (decision 2).

import type { ContextResolver, Principal, SecondStep, SignInMethod } from "../api/context.ts";
import { commit, type Database, type Ending, type LookupQueryable } from "../db/database.ts";
import { resolveActive, type CompanyAccess } from "../modules/memberships/resolve.ts";
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

/** The session's snapshot of the permissions it chose the company with: each permission, and the end of the grant that gives it, or null. */
export type PermissionSnapshot = Readonly<Record<string, string | null>>;

/** A live session as access.session_by_token gives it: its company, membership and permissions all three, or none (sessions_company_whole). */
type SessionRow = {
  readonly session_id: string;
  readonly identity_id: string;
  readonly status: string;
  readonly method: SignInMethod;
  readonly second_step: SecondStep | null;
  readonly started_at: Date;
  readonly last_seen_at: Date;
} & (
  | { readonly current_company_id: null; readonly current_membership_id: null; readonly permissions: null }
  | { readonly current_company_id: string; readonly current_membership_id: string; readonly permissions: PermissionSnapshot }
);

/** The session's token in the request's cookie, or undefined when the request names none. */
function sessionToken(request: Request): string | undefined {
  if (carriesBearer(request.headers)) {
    return undefined;
  }
  const token = readCookie(request.headers, SESSION_COOKIE);
  return token !== undefined && tokenKind(token) === "session" ? token : undefined;
}

/** The permissions of a snapshot that still hold at `at`: each one with no end, or an end after `at`. */
export function livePermissions(snapshot: PermissionSnapshot, at: Date): string[] {
  return Object.entries(snapshot)
    .filter(([, end]) => end === null || at.getTime() < Date.parse(end))
    .map(([permission]) => permission);
}

/** What the company of a session gives: the company access and its idle time, or the end of the session. */
type SessionCompany = { readonly company: CompanyAccess | undefined; readonly idleMs: number } | { readonly end: "membership" };

/**
 * The company the session works in, from the one membership function in
 * the lookup, as the session's person; none while it chose none.
 */
async function sessionCompany(tx: LookupQueryable, session: SessionRow, at: Date): Promise<SessionCompany> {
  if (session.current_company_id === null) {
    return { company: undefined, idleMs: NO_COMPANY_IDLE_MS };
  }
  // The function reads the person from the lookup's actor: it gives only the session's person's membership.
  await tx.actAs(session.identity_id, "user");
  const membership = await resolveActive(tx, session.current_company_id);
  if (membership?.membershipId !== session.current_membership_id) {
    return { end: "membership" };
  }
  return { company: membership.access(livePermissions(session.permissions, at)), idleMs: membership.idleTimeoutMinutes * 60 * 1000 };
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
        `SELECT session_id, identity_id, status, method, second_step, started_at, last_seen_at, current_company_id, current_membership_id, permissions
         FROM access.session_by_token($1)`,
        [tokenHash(token)],
      );
      const [session] = found.rows;
      if (session?.status !== "active") {
        return commit(undefined);
      }
      // Ends the session with its reason: it names no actor from now on.
      const ended = async (reason: "absolute" | "idle" | "membership"): Promise<Ending<undefined>> => {
        await tx.query("SELECT access.end_session($1, $2, $3)", [session.session_id, reason, at]);
        return commit(undefined);
      };
      if (at.getTime() >= session.started_at.getTime() + SESSION_LIFETIME_MS) {
        return ended("absolute");
      }
      const chosen = await sessionCompany(tx, session, at);
      if ("end" in chosen) {
        return ended(chosen.end);
      }
      if (at.getTime() >= session.last_seen_at.getTime() + chosen.idleMs) {
        return ended("idle");
      }
      if (at.getTime() - session.last_seen_at.getTime() >= TOUCH_AFTER_MS) {
        await tx.query("SELECT access.touch_session($1, $2)", [session.session_id, at]);
      }
      const principal: Principal = {
        personId: session.identity_id,
        actorKind: "user",
        credential: {
          kind: "session",
          sessionId: session.session_id,
          method: session.method,
          ...(session.second_step === null ? {} : { secondStep: session.second_step }),
        },
        ...(chosen.company === undefined ? {} : { company: chosen.company }),
      };
      return commit(principal);
    });
  };
}
