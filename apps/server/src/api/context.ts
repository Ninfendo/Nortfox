// SPDX-License-Identifier: AGPL-3.0-only

// The request context: who acts, with which credential, in which company
// with which permissions, and through which channel. An operation that needs
// a permission acts as one person in one company (decision 8). The company
// comes from the request's credential, never from its path or its body. An
// operation that needs only a signed-in person works in the company that its
// company source says: none, the credential's, one its input names where the
// person is an active member, or one it makes (api/operation.ts).
//
// A resolver reads the credential from the request's headers and gives the
// principal: the person, the actor's kind, the credential, and the company
// with the permissions held there when the credential names one. It gives
// nothing when the request names no actor. It never reads the body. The
// surface tells the resolver which surface asks, and adds the channel to the
// principal. The server's resolver (auth/resolver.ts) reads the session
// cookie on /v1, and knows no credential on /mcp yet, so a tool that needs an
// actor answers 401 there. The tests pass their own resolver. No setting
// turns on a fixed actor.
//
// The company in a principal comes only from the one membership function
// (modules/memberships/resolve.ts): a CompanyAccess is made from a membership
// that it gave, and authorize refuses a principal whose company is anything
// else.

import type { ActorKind, Channel } from "../db/database.ts";
import type { CompanyAccess } from "../modules/memberships/resolve.ts";

/** The kinds of actor a credential can name. A session acts as its user (decision 2); the system user is never a request's actor. */
export type PrincipalKind = Exclude<ActorKind, "system">;

/** How a session signed in: the login methods of slice 2c. */
export type SignInMethod = "password-email" | "password-personnummer" | "bankid" | "oidc";

/** The second step of a password sign-in: a TOTP code, or a device the person knows inside its 90 days. */
export type SecondStep = "totp" | "known-device";

/** A browser session, from the session cookie. API tokens and MCP tokens come later in slice 2c. */
export interface SessionCredential {
  readonly kind: "session";
  readonly sessionId: string;
  readonly method: SignInMethod;
  /** The second step of its sign-in, for a sign-in with a password. */
  readonly secondStep?: SecondStep;
  /** When the person identified: the session began once the sign-in's last step passed. */
  readonly identifiedAt: Date;
}

/** What the request's credential is. */
export type Credential = SessionCredential;

/**
 * The company a request works in: the membership, its admin level and the
 * permissions the person holds there. It is made only from a membership that
 * the one membership function gave (modules/memberships/resolve.ts), and
 * authorize refuses any other.
 */
export type { CompanyAccess } from "../modules/memberships/resolve.ts";

/** Who acts, as the request's credential says. */
export interface Principal {
  /** The person: the identity's id, which is the actor's id. */
  readonly personId: string;
  readonly actorKind: PrincipalKind;
  readonly credential: Credential;
  /** The company the credential works in, when it names one. */
  readonly company?: CompanyAccess;
}

/** The principal, and the channel the request came through. */
export interface RequestContext extends Principal {
  readonly channel: Channel;
}

/** The context of an operation that works in the credential's company. */
export interface CompanyContext extends RequestContext {
  readonly company: CompanyAccess;
}

/**
 * Reads the principal from a request's headers, or gives undefined when the
 * request names no actor. `surface` is the surface that asks: rest for /v1,
 * mcp for /mcp, which take different credentials.
 */
export type ContextResolver = (request: Request, surface: Channel) => Promise<Principal | undefined>;

/** A resolver that knows no actor, for the tests of a request with none. */
export const resolveNoActor: ContextResolver = () => Promise.resolve(undefined);
