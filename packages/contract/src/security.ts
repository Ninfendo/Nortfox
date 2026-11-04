// SPDX-License-Identifier: AGPL-3.0-only

// How a request names its actor, as openapi.json says it
// (docs/decisions/0008-authentication.md). Each operation that needs an
// actor names, in OpenAPI's `security`, the credentials that can name one.
// In this part of slice 2c that is the browser's session alone: its cookie,
// which the browser sends by itself. API tokens come in a later part.
// x-nortfox's permission stays what the server checks, and the registry
// guard holds the two together.

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
} as const;

export type SecurityScheme = keyof typeof SECURITY_SCHEMES;
