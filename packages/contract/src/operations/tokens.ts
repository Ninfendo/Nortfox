// SPDX-License-Identifier: AGPL-3.0-only

// The API tokens (issue 12, "API tokens"). A member makes a token for the
// company the session works in, with a name and scopes, in a browser
// session: a token never makes a token. The answer shows the token once,
// and the server keeps only its hash. The token acts as the person who made
// it, an integration, in that one company, on /v1 only. What it may do is
// its scopes and its person's permissions there, read on every request. It
// works until it is revoked, or until its person's membership stops: a
// deactivation stops it while it lasts, and a removal, a leave or a
// disconnect for good. A member sees and revokes their own tokens; a system
// administrator sees and revokes every token of the company.

import { z } from "zod";
import { secret } from "../fields.ts";
import { NoBody, defineListOperation, defineOperation } from "../operation.ts";
import { SCOPES } from "../scopes.ts";
import { noNul, singleLine, wellFormed } from "../text.ts";

/** A scope, by its name. The name ScopeKey keeps the type Scope free. */
export const ScopeKey = z.enum(SCOPES).meta({
  id: "Scope",
  description:
    "A scope: what a token may be used for. Each operation that a token may call names one. companyinformation and profile are the established API's, as are the scopes that no operation names yet; companies, users and tokens are NortFox's own. A name is case-sensitive.",
});

/** An API token as the lists give it: never the token itself. */
export const ApiToken = z
  .strictObject({
    id: z.uuid().meta({ description: "The token's id, which revokeApiToken takes." }),
    name: z.string().meta({ description: "The token's name, which its maker gave it." }),
    scopes: z.array(ScopeKey).meta({ description: "The token's scopes, each once, in the order of the list of scopes." }),
    userId: z.uuid().meta({ description: "The person the token acts as: the one who made it." }),
    createdAt: z.iso.datetime().meta({ description: "When the token was made." }),
  })
  .meta({
    id: "ApiToken",
    description: "An API token of the company, without the token itself, which only the answer of createApiToken gives.",
  });

export type ApiToken = z.infer<typeof ApiToken>;

/** A new API token: its facts, and the token, shown once. */
export const NewApiToken = ApiToken.extend({
  token: secret(
    z.string().meta({
      description: "The token, nft_ and 43 characters: send it as Authorization: Bearer <token>. It is shown once, in this answer, and the server keeps only its hash.",
    }),
  ),
}).meta({ id: "NewApiToken", description: "A new API token: its facts, and the token itself, which no other answer gives." });

export type NewApiToken = z.infer<typeof NewApiToken>;

export const createApiToken = defineOperation({
  id: "createApiToken",
  method: "post",
  path: "/v1/api-tokens",
  tags: ["tokens"],
  summary: "Create an API token",
  description:
    "Makes an API token for the company the session works in, with a name and scopes. The token acts as the signed-in person, in that company, on /v1: " +
    "it may do what its scopes and the person's permissions there both allow, and it works until it is revoked or the person's membership stops. " +
    "The answer shows the token once; the server keeps only its hash. It needs a browser session, so a token never makes a token: a token is refused it with 403 session-required.",
  body: z.strictObject({
    name: z.string().min(1).max(100).check(noNul(), wellFormed(), singleLine()).meta({ description: "The token's name, on one line, so its maker knows it again." }),
    scopes: z
      .array(ScopeKey)
      .min(1)
      .max(SCOPES.length)
      .meta({ description: "The token's scopes, one or more, each by its exact name. Each is kept once, in the order of the list of scopes." }),
  }),
  output: NewApiToken,
  status: 201,
  permission: "tokens:own",
  session: "only",
  tool: "Makes an API token. It needs a browser session, so this tool refuses a call that comes with a token.",
  writes: true,
});

export const listApiTokens = defineListOperation({
  id: "listApiTokens",
  method: "get",
  path: "/v1/api-tokens",
  tags: ["tokens"],
  summary: "List the API tokens",
  description:
    "Lists the live API tokens of the company, in the order they were made, without the tokens themselves: the actor's own, or every one of the company for a system administrator. A revoked token is not listed.",
  item: ApiToken,
  permission: "tokens:own",
  scope: "tokens",
  tool: "Lists the live API tokens of the company you work in: your own, or every one for a system administrator.",
});

export const revokeApiToken = defineOperation({
  id: "revokeApiToken",
  method: "delete",
  path: "/v1/api-tokens/{tokenId}",
  tags: ["tokens"],
  summary: "Revoke an API token",
  description:
    "Revokes a live API token of the company: the actor's own, or any of the company's for a system administrator. It is refused from the next request on. " +
    "Any other id, also one of a revoked token or of another's for a member, gets 422 api-token-not-found.",
  params: z.strictObject({ tokenId: z.uuid().meta({ description: "The token's id." }) }),
  output: NoBody,
  status: 204,
  permission: "tokens:own",
  scope: "tokens",
  tool: "Revokes an API token of the company you work in: your own, or any for a system administrator.",
  writes: true,
});
