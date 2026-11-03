// SPDX-License-Identifier: AGPL-3.0-only

// The request context: who acts, in which company, with which permissions,
// and through which channel. Every operation that is not public acts as one
// actor in one company (decision 8). The company comes from the request's
// credential, never from its path or its body.
//
// A resolver reads the credential from the request's headers and gives the
// principal: the company, the actor, its kind and the permissions it holds,
// or nothing when the request names no actor. It never reads the body. The
// surface adds the channel, since it knows whether the request came by REST
// or by MCP. Login comes in slice 2c. Until then the server's resolver knows
// no actor, so every data operation answers 401, and the tests pass their
// own resolver. No setting turns on a fixed actor.

import type { ActorKind, Channel } from "../db/database.ts";

/** Who acts, as the request's credential says. */
export interface Principal {
  readonly companyId: string;
  readonly actorId: string;
  readonly actorKind: ActorKind;
  /** The permissions the actor holds in the company. */
  readonly permissions: ReadonlySet<string>;
}

/** The principal, and the channel the request came through. */
export interface RequestContext extends Principal {
  readonly channel: Channel;
}

/** Reads the principal from a request's headers, or gives undefined when the request names no actor. */
export type ContextResolver = (request: Request) => Promise<Principal | undefined>;

/** The server's resolver until slice 2c brings login: it knows no actor. */
export const resolveNoActor: ContextResolver = () => Promise.resolve(undefined);
