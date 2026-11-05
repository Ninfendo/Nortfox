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
// session's, the session ends with the reason membership. The database
// already ends it when the membership stops being active, so a deactivated,
// removed or departed member's session stays ended. The idle time is the
// membership's, "Utloggning efter inaktivitet", and 120 minutes while the
// session works in no company. The session holds the idle time it was last
// seen under, and the lower of that and the idle time in force now counts.
// The database lowers it with the membership's, so a lower one holds at
// once; a higher one holds from the session's next request. So a session
// past its idle time never comes back when the idle time is raised. Past it
// the session ends with the reason idle. An ended session gives nothing from
// then on. The permissions are the session's snapshot of when it chose the
// company, less a permission whose grant has ended. A request moves the
// session's last sight on when it is a minute old or more, so a session is
// not written on every request, and also when the idle time in force is not
// the one the session was last seen under, so a raise made elsewhere holds
// from the session's next request.
//
// The lookup reads the session without a lock. When it would write, to end
// the session or to note the request, it locks the session's row and reads
// it again (access.lock_session), asks the one function again, and decides
// again from those. So the requests of one session that write take turns,
// and each writes from what the one before it wrote: of a burst past the
// idle time, one ends the session and every other finds it ended and gives
// nothing; a request that another request moved on, or moved to another
// company, is judged as it is now. A session runs as its user (decision 2).

import type { ContextResolver, Principal, SecondStep, SignInMethod } from "../api/context.ts";
import { commit, type Database, type LookupQueryable, type Queryable } from "../db/database.ts";
import { resolveActive, type CompanyAccess } from "../modules/memberships/resolve.ts";
import { SESSION_COOKIE, readCookie } from "./cookies.ts";
import { carriesBearer } from "./origin.ts";
import { tokenHash, tokenKind } from "./tokens.ts";

/** A session ends this long after it began (ASVS 4.0.3 3.3.2; choice 12). */
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** A session with no company ends after this many minutes without a request (choice 2). */
export const NO_COMPANY_IDLE_MINUTES = 120;

const MINUTE_MS = 60 * 1000;

/** A request moves the session's last sight on once it is this old. */
export const TOUCH_AFTER_MS = 60 * 1000;

export interface SessionResolverOptions {
  readonly database: Database;
  /** The server's clock. */
  readonly now: () => Date;
}

/** The session's snapshot of the permissions it chose the company with: each permission, and the end of the grant that gives it, or null. */
export type PermissionSnapshot = Readonly<Record<string, string | null>>;

/** A live session as access.session_by_token and access.lock_session give it: its company, membership and permissions all three, or none (sessions_company_whole). */
type SessionRow = {
  readonly session_id: string;
  readonly identity_id: string;
  readonly status: string;
  readonly method: SignInMethod;
  readonly second_step: SecondStep | null;
  readonly started_at: Date;
  readonly last_seen_at: Date;
  /** The idle time the session was last seen under. */
  readonly idle_timeout_minutes: number;
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

/**
 * Notes a request of the session at `at`, under the idle time in force,
 * `idleMinutes`, while the session works with `membershipId`, or in no
 * company when it is null: its last sight moves on, never back, and a
 * session that has chosen another company meanwhile keeps its own. A
 * request of the session that changes the idle time of the membership the
 * session works with notes itself again, so the new idle time holds from its
 * next request.
 */
export async function seeSession(tx: Queryable, sessionId: string, at: Date, idleMinutes: number, membershipId: string | null): Promise<void> {
  await tx.query("SELECT access.touch_session($1, $2, $3, $4)", [sessionId, at, idleMinutes, membershipId]);
}

/** The columns of a session, from either lookup function. */
const SESSION_COLUMNS =
  "session_id, identity_id, status, method, second_step, started_at, last_seen_at, idle_timeout_minutes, current_company_id, current_membership_id, permissions";

/** A session read as it is, and one locked until the lookup ends. */
const READ_SESSION = {
  "as-is": `SELECT ${SESSION_COLUMNS} FROM access.session_by_token($1)`,
  locked: `SELECT ${SESSION_COLUMNS} FROM access.lock_session($1)`,
} as const;

/** The live session of the token's hash, read as it is or locked; nothing when it has ended or its identity is not active. */
async function liveSession(tx: Queryable, hash: Buffer, read: keyof typeof READ_SESSION): Promise<SessionRow | undefined> {
  const found = await tx.query<SessionRow>(READ_SESSION[read], [hash]);
  const [session] = found.rows;
  return session?.status === "active" ? session : undefined;
}

/** What the company of a session gives: the company access and the idle time in force, or the end of the session. */
type SessionCompany = { readonly company: CompanyAccess | undefined; readonly idleMinutes: number } | { readonly end: "membership" };

/**
 * The company the session works in, from the one membership function in
 * the lookup, as the session's person; none while it chose none. `actAs`
 * sets the lookup's person, once.
 */
async function sessionCompany(tx: LookupQueryable, session: SessionRow, at: Date, actAs: (personId: string) => Promise<void>): Promise<SessionCompany> {
  if (session.current_company_id === null) {
    return { company: undefined, idleMinutes: NO_COMPANY_IDLE_MINUTES };
  }
  // The function reads the person from the lookup's actor: it gives only the session's person's membership.
  await actAs(session.identity_id);
  const membership = await resolveActive(tx, session.current_company_id);
  if (membership?.membershipId !== session.current_membership_id) {
    return { end: "membership" };
  }
  return { company: membership.access(livePermissions(session.permissions, at)), idleMinutes: membership.idleTimeoutMinutes };
}

/** What a request makes of its session: the session's end with its reason, or its company and the idle time in force, and whether the request is noted. */
type Verdict = { readonly end: "absolute" | "membership" | "idle" } | { readonly company: CompanyAccess | undefined; readonly idleMinutes: number; readonly note: boolean };

/** What a request at `at` makes of the session as `session` holds it. */
async function judge(tx: LookupQueryable, session: SessionRow, at: Date, actAs: (personId: string) => Promise<void>): Promise<Verdict> {
  if (at.getTime() >= session.started_at.getTime() + SESSION_LIFETIME_MS) {
    return { end: "absolute" };
  }
  const chosen = await sessionCompany(tx, session, at, actAs);
  if ("end" in chosen) {
    return chosen;
  }
  // The lower of the idle time the session was last seen under and the one in force now.
  if (at.getTime() >= session.last_seen_at.getTime() + Math.min(session.idle_timeout_minutes, chosen.idleMinutes) * MINUTE_MS) {
    return { end: "idle" };
  }
  // Noted once a minute, and at once when the idle time in force is not the one the session was last seen under, so a raise holds from now.
  const note = at.getTime() - session.last_seen_at.getTime() >= TOUCH_AFTER_MS || chosen.idleMinutes !== session.idle_timeout_minutes;
  return { ...chosen, note };
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
    const hash = tokenHash(token);
    return database.lookup("rest", async (tx) => {
      let acting = false;
      const actAs = async (personId: string): Promise<void> => {
        if (!acting) {
          acting = true;
          await tx.actAs(personId, "user");
        }
      };
      let session = await liveSession(tx, hash, "as-is");
      if (session === undefined) {
        return commit(undefined);
      }
      let verdict = await judge(tx, session, at, actAs);
      if ("end" in verdict || verdict.note) {
        // A write: on the session's row, locked and read again, and judged again, so another request's write that came first counts.
        session = await liveSession(tx, hash, "locked");
        if (session === undefined) {
          return commit(undefined);
        }
        verdict = await judge(tx, session, at, actAs);
        if ("end" in verdict) {
          await tx.query("SELECT access.end_session($1, $2, $3)", [session.session_id, verdict.end, at]);
          return commit(undefined);
        }
        if (verdict.note) {
          await seeSession(tx, session.session_id, at, verdict.idleMinutes, verdict.company?.membershipId ?? null);
        }
      }
      const principal: Principal = {
        personId: session.identity_id,
        actorKind: "user",
        credential: {
          kind: "session",
          sessionId: session.session_id,
          method: session.method,
          ...(session.second_step === null ? {} : { secondStep: session.second_step }),
          identifiedAt: session.started_at,
        },
        ...(verdict.company === undefined ? {} : { company: verdict.company }),
      };
      return commit(principal);
    });
  };
}
