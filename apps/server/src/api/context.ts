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
// A token, an API token or later an MCP client's, is an integration in its
// one company, within its scopes (api/operation.ts, authorize). A session is
// its user, and no scope limits it.
//
// The company in a principal comes only from the one membership function
// (modules/memberships/resolve.ts): a CompanyAccess is made from a membership
// that it gave, and authorize refuses a principal whose company is anything
// else.

import type { Scope } from "@nortfox/contract";
import type { ActorKind, Channel, Via } from "../db/database.ts";
import type { CompanyAccess } from "../modules/memberships/resolve.ts";

/** The kinds of actor a credential can name. A session acts as its user (decision 2); the system user is never a request's actor. */
export type PrincipalKind = Exclude<ActorKind, "system">;

/** How a session signed in: the login methods of slice 2c. */
export type SignInMethod = "password-email" | "password-personnummer" | "bankid" | "oidc";

/** The second step of a password sign-in: a TOTP code, or a device the person knows inside its 90 days. */
export type SecondStep = "totp" | "known-device";

/** A browser session, from the session cookie. */
export interface SessionCredential {
  readonly kind: "session";
  readonly sessionId: string;
  readonly method: SignInMethod;
  /** The second step of its sign-in, for a sign-in with a password. */
  readonly secondStep?: SecondStep;
  /** When the person identified: the session began once the sign-in's last step passed. */
  readonly identifiedAt: Date;
}

/**
 * An API token, from the Authorization header. It acts as its person, an
 * integration, in its one company, within its scopes. The resolver that reads
 * it comes later in this part of slice 2c, and the MCP clients' tokens in a
 * later part.
 */
export interface ApiTokenCredential {
  readonly kind: "api-token";
  readonly tokenId: string;
  readonly scopes: ReadonlySet<Scope>;
}

/** What the request's credential is. */
export type Credential = SessionCredential | ApiTokenCredential;

/** A credential that is not a browser session: a token, which its scopes limit. */
export type TokenCredential = Exclude<Credential, SessionCredential>;

/** Whether the credential is a token, not a browser session. */
export function isToken(credential: Credential): credential is TokenCredential {
  return credential.kind !== "session";
}

/**
 * The browser session of a call of an operation that serves the browser's
 * session, such as logout. authorize refuses a token's call of one with
 * session-required, so a token here is a fault of the server.
 */
export function sessionOf(operationId: string, credential: Credential): SessionCredential {
  if (isToken(credential)) {
    throw new Error(`${operationId} serves the browser's session, and the call came with a token, which authorize refuses.`);
  }
  return credential;
}

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
  /**
   * The API token or the MCP client an integration acts through, which the
   * behandlingshistorik records with the person (decision 2). An
   * integration has one, and a user none: the database layer refuses a
   * transaction otherwise.
   */
  readonly via?: Via;
  readonly credential: Credential;
  /** The company the credential works in, when it names one. */
  readonly company?: CompanyAccess;
}

/** The actor that a principal's transaction sets: the person, its kind, and an integration's via. */
export interface PrincipalActor {
  readonly actorId: string;
  readonly actorKind: PrincipalKind;
  readonly via?: Via;
}

/** The actor that `principal`'s transaction sets. */
export function actorOf(principal: Principal): PrincipalActor {
  return { actorId: principal.personId, actorKind: principal.actorKind, ...(principal.via === undefined ? {} : { via: principal.via }) };
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
