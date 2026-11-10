// SPDX-License-Identifier: AGPL-3.0-only

// How a request names its actor, as openapi.json says it
// (docs/decisions/0008-authentication.md). Each operation that needs an
// actor names, in OpenAPI's `security`, the credentials that can name one:
// the browser's session, in its cookie, which the browser sends by itself;
// and, for an operation that a token may call, an API token in the
// Authorization header, as a bearer token (RFC 6750). An operation that
// serves or needs a browser session takes the cookie alone. A 401 names the
// operation's credentials in its challenge. x-nortfox's permission and
// scope stay what the server checks, and the registry guard holds the three
// together.

/** The cookie that holds a browser's session. It is HttpOnly, so no script reads it. */
export const SESSION_COOKIE = "__Host-nortfox-session";

/** The credentials an operation can take, as openapi.json's components.securitySchemes holds them. */
export const SECURITY_SCHEMES = {
  sessionCookie: {
    type: "apiKey",
    in: "cookie",
    name: SESSION_COOKIE,
    description: "The browser's session, which a sign-in sets: verifyTotp, or loginWithPassword on a known device. The browser sends it by itself.",
  },
  bearer: {
    type: "http",
    scheme: "bearer",
    description:
      "An API token, which createApiToken makes, sent as Authorization: Bearer <token>. It works in its one company, within its scopes, on /v1 only. A request with a bearer token ignores the session cookie.",
  },
} as const;

export type SecurityScheme = keyof typeof SECURITY_SCHEMES;

/**
 * The challenge of each credential, which a 401 sends in WWW-Authenticate
 * (RFC 9110, 11.6.1). HTTP has no registered scheme for a cookie, so the
 * session's challenge is NortFox's own: the scheme Cookie, with the
 * install's realm and the cookie's name. A client that knows no such scheme
 * ignores it, as RFC 9110 says it may. A bearer token's is RFC 6750's, with
 * the same realm.
 */
export const CHALLENGES: Readonly<Record<SecurityScheme, string>> = {
  sessionCookie: `Cookie realm="NortFox", cookie-name="${SESSION_COOKIE}"`,
  bearer: `Bearer realm="NortFox"`,
};
