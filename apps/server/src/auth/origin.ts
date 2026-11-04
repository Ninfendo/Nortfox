// SPDX-License-Identifier: AGPL-3.0-only

// Origins, and the rule of /v1 against requests that another site starts
// (docs/api.md, Cross-site requests). The install allows one origin, its
// public origin (config.ts), which /v1 and /mcp share.
//
// A write with the session cookie is guarded in four layers: the cookie is
// SameSite=Strict, so a browser never sends it with another site's request;
// /v1 checks the Origin, here, before the resolver reads the cookie; a body
// is application/json only, which a form on another site cannot send
// without a preflight that /v1 never answers; and a GET never changes
// anything for a session. The check:
//
// - A request whose method is not GET or HEAD, that carries the session
//   cookie and no bearer token, must carry an Origin on the allowed list. A
//   browser sends an Origin with every such request, so one without, or
//   with another, is refused.
// - An operation that runs before sign-in refuses an Origin that is not on
//   the list, so another site cannot sign a browser in, start a sign-in or
//   send mail through it. Each such operation serves the browser's sign-in.
//   One with no Origin, from a program that is not a browser, runs.
// - A request with a bearer token is a program's: it ignores the cookie, so
//   the first rule does not touch it. A browser on another site cannot send
//   one without a preflight either.

import { NONE, type Operation } from "@nortfox/contract";
import { SESSION_COOKIE, carriesCookie } from "./cookies.ts";

/** Whether `text` is an origin as a browser sends it in an Origin header: a scheme, a host and a port that is not the scheme's own. */
export function isOrigin(text: string): boolean {
  return URL.canParse(text) && new URL(text).origin === text;
}

/** The allowed origins, each checked. Throws on one that a browser would send in another form, or not at all. */
export function allowedOrigins(list: readonly string[]): ReadonlySet<string> {
  for (const origin of list) {
    if (!isOrigin(origin)) {
      throw new Error(`The allowed origin "${origin}" is not an origin as a browser sends it, such as https://nortfox.example or http://localhost:5173.`);
    }
  }
  return new Set(list);
}

/** The methods that never change anything. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Whether a request carries a bearer token (RFC 6750): the scheme in any case, then a space and the token. */
function carriesBearer(headers: Headers): boolean {
  return /^bearer +\S/i.test(headers.get("authorization") ?? "");
}

/** Whether /v1 refuses `request` to `operation` as one that another site may have started. */
export function crossSiteRefused(operation: Operation, request: Request, allowed: ReadonlySet<string>): boolean {
  const { headers } = request;
  const origin = headers.get("origin");
  const ownSite = origin !== null && allowed.has(origin);
  if (!SAFE_METHODS.has(request.method) && carriesCookie(headers, SESSION_COOKIE) && !carriesBearer(headers)) {
    return !ownSite;
  }
  return operation["x-nortfox"].permission === NONE && origin !== null && !ownSite;
}
