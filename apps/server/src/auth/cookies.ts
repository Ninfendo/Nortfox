// SPDX-License-Identifier: AGPL-3.0-only

// The cookies of a browser's sign-in (docs/decisions/0008-authentication.md).
// A handler of an operation that serves the browser's session gives its
// cookies as effects beside its output; the runner passes them on, and only
// /v1 writes them as Set-Cookie headers. No answer body ever holds what a
// cookie holds.
//
// - __Host-nortfox-session holds the session's token. It has no Max-Age, so
//   it ends with the browser too.
// - __Host-nortfox-device holds the known device's token, for 400 days, the
//   most a browser keeps a cookie.
// - __Host-nortfox-login binds a sign-in that leaves the site and comes back,
//   for 10 minutes. It is SameSite=Lax, since an identity provider brings the
//   browser back with a top-level GET, which a Strict cookie does not follow.
//
// Each is HttpOnly and Secure with Path=/ and no Domain: the __Host- prefix
// makes a browser refuse it otherwise.
//
// The cross-site check of /v1 and the resolver read them from a request's
// Cookie header. The session cookie's name comes from the contract, which
// names it in openapi.json as the credential sessionCookie.

import { SESSION_COOKIE } from "@nortfox/contract";

export { SESSION_COOKIE };

/** What a handler asks of the browser's cookies. */
export type CookieEffect =
  | { readonly kind: "set-session"; readonly token: string }
  | { readonly kind: "clear-session" }
  | { readonly kind: "set-device"; readonly token: string }
  | { readonly kind: "set-login"; readonly token: string }
  | { readonly kind: "clear-login" };

export const DEVICE_COOKIE = "__Host-nortfox-device";
export const LOGIN_COOKIE = "__Host-nortfox-login";

/** 400 days in seconds: the longest a browser keeps a cookie. */
const DEVICE_MAX_AGE = 400 * 24 * 60 * 60;

/** 10 minutes in seconds: as long as a sign-in may take away from the site. */
const LOGIN_MAX_AGE = 10 * 60;

/** A value a cookie carries as it is: the base64url of NortFox's tokens and their prefix. */
const VALUE = /^[A-Za-z0-9_-]{1,512}$/;

function cookie(name: string, value: string, maxAge: number | undefined, sameSite: "Strict" | "Lax"): string {
  if (value !== "" && !VALUE.test(value)) {
    throw new Error("A cookie's value is 1 to 512 characters of letters, digits, - and _.");
  }
  const age = maxAge === undefined ? "" : `; Max-Age=${String(maxAge)}`;
  return `${name}=${value}; Path=/${age}; Secure; HttpOnly; SameSite=${sameSite}`;
}

/** A value that a cookie may hold: never empty. Clearing a cookie is an effect of its own. */
function value(token: string): string {
  if (token === "") {
    throw new Error("A cookie's value is 1 to 512 characters of letters, digits, - and _.");
  }
  return token;
}

/** The Set-Cookie header of an effect. */
export function setCookieHeader(effect: CookieEffect): string {
  switch (effect.kind) {
    case "set-session":
      return cookie(SESSION_COOKIE, value(effect.token), undefined, "Strict");
    case "clear-session":
      return cookie(SESSION_COOKIE, "", 0, "Strict");
    case "set-device":
      return cookie(DEVICE_COOKIE, value(effect.token), DEVICE_MAX_AGE, "Strict");
    case "set-login":
      return cookie(LOGIN_COOKIE, value(effect.token), LOGIN_MAX_AGE, "Lax");
    case "clear-login":
      return cookie(LOGIN_COOKIE, "", 0, "Lax");
  }
}

/**
 * The values that a request's Cookie header gives the cookie `name`, in its
 * order. A browser writes the header as name=value pairs joined by "; " (RFC
 * 6265, section 5.4). A part without "=" names no cookie. Names are compared
 * exactly, case and all.
 */
export function cookieValues(headers: Headers, name: string): string[] {
  const values: string[] = [];
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const equals = part.indexOf("=");
    if (equals !== -1 && part.slice(0, equals).trim() === name) {
      values.push(part.slice(equals + 1).trim());
    }
  }
  return values;
}

/** Whether a request carries the cookie `name`, with any value, once or more. */
export function carriesCookie(headers: Headers, name: string): boolean {
  return cookieValues(headers, name).length > 0;
}

/**
 * The value of the cookie `name`, when the request carries it once and in the
 * form that NortFox writes; otherwise undefined. A browser keeps one cookie
 * of a __Host- name for this host, so two are not NortFox's.
 */
export function readCookie(headers: Headers, name: string): string | undefined {
  const values = cookieValues(headers, name);
  const [value] = values;
  return values.length === 1 && value !== undefined && VALUE.test(value) ? value : undefined;
}
