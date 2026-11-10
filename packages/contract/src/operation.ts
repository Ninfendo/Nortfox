// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One operation is one createRoute object from @hono/zod-openapi, and the
 * registry is the list of them (docs/decisions/0003-contract-first-rest-and-mcp.md).
 * The REST route, the generated client's method and the MCP tool all come
 * from it. NortFox's own parts of an entry sit in the OpenAPI extension
 * x-nortfox, so openapi.json shows each operation's permission and scope,
 * its MCP tool text, whether it writes, is a list or is open to the
 * assistant, whether it serves or needs the browser's session, where its
 * company comes from, and which fields of its answer are personal or secret.
 * OpenAPI's own `security` names the credentials that can name its actor.
 */

import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import { personalPointers, secretPointers } from "./fields.ts";
import { IDEMPOTENCY_KEY_DESCRIPTION, IDEMPOTENCY_KEY_HEADER } from "./idempotency-key.ts";
import { Cursor, Limit, pageOf } from "./paging.ts";
import { Problem } from "./problem.ts";
import type { Scope } from "./scopes.ts";
import { CHALLENGES, bearerChallenge, type SecurityScheme } from "./security.ts";

/**
 * The permissions an operation can need, each with what it allows. Which
 * roles and tokens hold them is slice 2c's. An operation that reads no data
 * needs none, and says "public".
 */
export const PERMISSIONS = {
  "company:read": "Read the company: its id, name, organisation number, tenant id, addresses and contact details.",
  "company:update": "Change the company's name, addresses and contact details. Its organisation number never changes.",
  "users:read":
    "Read the company's users: each member's status, admin level, idle logout, work contacts and programs. A program administrator sees only the programs they administer.",
  "users:admin":
    "Run the company's users: invite a person and send a new invitation, activate and deactivate a member, make a member system administrator or no longer one, appoint program administrators, set a member's idle logout and work contacts, disconnect a member's identity, and remove a member.",
  "programs:grant":
    "Grant, narrow, move and remove the members' programs, and set their Rapporter and Register/Övrigt rights. A program administrator does it only for the programs they administer.",
  "tokens:own": "Make API tokens of your own in the company, in a browser session, and list and revoke them.",
  "tokens:all": "List and revoke every API token of the company, beside your own. No operation needs it by itself: it widens what tokens:own gives.",
} as const;

export type Permission = keyof typeof PERMISSIONS;

/** The permission of an operation that reads and writes no data. */
export const PUBLIC = "public";

/**
 * The permission of an operation that runs before there is an actor, such as
 * a sign-in. Anyone may call it. It serves the browser's session, and it
 * takes no idempotency key.
 */
export const NONE = "none";

/** The permission of an operation that needs a signed-in person and no permission in a company. */
export const SIGNED_IN = "signed-in";

/** The permissions that are not a key of PERMISSIONS: no permission in a company is needed. */
export const OPEN_PERMISSIONS = [PUBLIC, NONE, SIGNED_IN] as const;

/**
 * The session mark. "flow" marks an operation that serves the browser's
 * session, such as a sign-in or a logout: its MCP tool refuses every call.
 * /v1 refuses a token's call of one that needs an actor, such as logout,
 * getSession or selectCompany, with session-required, and runs a token's
 * call of one that runs before sign-in, such as loginWithPassword, as a call
 * with no actor. "only" marks an operation that needs a browser session
 * though it does not serve it, such as listRecentCompanies: /v1 and its MCP
 * tool refuse a token's call with session-required. null marks every other
 * operation.
 */
export type SessionMark = "flow" | "only" | null;

/**
 * Where a request's company comes from, by name:
 *
 * - none: nowhere. The request works in no company.
 * - credential: the session or the token. Every operation with a permission.
 * - current: the credential's company when it names one, and none otherwise.
 *   A signed-in operation that reads the person's current company too.
 * - new: the company the request makes. The runner picks its id.
 *
 * A signed-in operation may also take its company from a field of its input,
 * {"input": "<field>"}: the runner asks the one membership function whether
 * the person is an active member there.
 */
export const COMPANY_SOURCES = ["none", "credential", "current", "new"] as const;

/** A company that a field of the input names. */
export interface CompanyInput {
  /** The field of the flat input, a required string, that names the company's id. */
  readonly input: string;
}

export type CompanySource = (typeof COMPANY_SOURCES)[number] | CompanyInput;

/** Whether a company source takes the company from a field of the input. */
export function isCompanyInput(source: CompanySource): source is CompanyInput {
  return typeof source === "object";
}

/** The methods an operation may use. */
export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type Method = (typeof METHODS)[number];

/** NortFox's own parts of a registry entry, in x-nortfox. */
export interface OperationMeta {
  /** The permission the actor needs: "public", "none", "signed-in" or a key of PERMISSIONS. */
  readonly permission: string;
  /**
   * The scope a token needs, one of SCOPES (scopes.ts); null for an operation
   * that no token calls by a scope: a public one, and one that serves or
   * needs a browser session.
   */
  readonly scope: Scope | null;
  /** The MCP tool's description, for the agents that read it. */
  readonly tool: string;
  /** Whether the AI assistant may call it. Closed unless the entry opens it. */
  readonly assistant: boolean;
  /** Whether it writes. A write takes an idempotency key, unless it runs before sign-in. */
  readonly writes: boolean;
  /** Whether it is a list: it takes limit and cursor, and answers a page. */
  readonly list: boolean;
  /** "flow" for an operation that serves the browser's session, "only" for one that needs it; null for any other. */
  readonly session: SessionMark;
  /** Where the request's company comes from. */
  readonly company: CompanySource;
  /**
   * The JSON Pointers of the output's personal fields: a person's contact
   * data, which personal() marks (fields.ts). The registry derives the list
   * from the output schema.
   */
  readonly personalOutput: readonly string[];
  /**
   * The JSON Pointers of the output's secret fields: a value that works as a
   * credential, which secret() marks (fields.ts). The registry derives the
   * list from the output schema. A write's key keeps its answer without them.
   */
  readonly secretOutput: readonly string[];
}

/** An object schema, for the path parameters, a query or a body. */
export type Shape = z.ZodObject;

/** One answer of a route: its description, its headers and its content. */
export type ResponseConfig = Exclude<RouteConfig["responses"][string], { readonly $ref: string }>;

export interface JsonBody<Body extends Shape> {
  readonly required: true;
  readonly content: { readonly "application/json": { readonly schema: Body } };
}

export interface OperationRequest<Query extends Shape | undefined, Body extends Shape | undefined, Params extends Shape | undefined = Shape | undefined> {
  readonly params?: Params;
  readonly query?: Query;
  readonly body?: Body extends Shape ? JsonBody<Body> : never;
  readonly headers?: z.ZodObject;
}

/** A registry entry: a createRoute object with x-nortfox. */
export interface Operation<
  Query extends Shape | undefined = Shape | undefined,
  Body extends Shape | undefined = Shape | undefined,
  Output extends z.ZodType = z.ZodType,
  Params extends Shape | undefined = Shape | undefined,
> {
  readonly operationId: string;
  readonly method: Method;
  /** The path under /v1, with each path parameter as {name}. */
  readonly path: string;
  readonly tags: string[];
  readonly summary: string;
  readonly description: string;
  readonly "x-nortfox": OperationMeta;
  /** OpenAPI's extensions: x-nortfox is the one NortFox writes. */
  readonly [extension: `x-${string}`]: unknown;
  readonly request: OperationRequest<Query, Body, Params>;
  readonly responses: Readonly<Record<string, ResponseConfig>>;
  /** The credentials that can name the actor, for an operation that needs one (securityOf). */
  readonly security?: SecurityRequirement[];
  /** Never set: only the type of the output schema, which the success answer holds. */
  readonly "~output"?: Output;
  /** The path as Hono routes it, with each path parameter as :name. */
  getRoutingPath(): string;
}

/** The success statuses an operation may answer. */
export const SUCCESS_STATUSES = [200, 201, 202, 204, 303] as const;

export type SuccessStatus = (typeof SUCCESS_STATUSES)[number];

/**
 * The output of an answer without a body: 202 and 204. REST answers with no
 * body, and MCP with an empty object.
 */
export const NoBody = z.strictObject({}).meta({ description: "Nothing: REST answers with no body, MCP with an empty object." });

/** The output of a redirect, 303: where the browser goes next. REST sends it in Location too. */
export const Redirect = z
  .strictObject({
    location: z.string().meta({ description: "The URL the browser goes to next. REST sends it in the Location header too." }),
  })
  .meta({ id: "Redirect", description: "Where the browser goes next." });

interface Texts {
  /** The operation id: the client's method and the MCP tool's name, in camelCase. */
  readonly id: string;
  readonly method: Method;
  /** The path under /v1, in lower-case kebab-case, with each path parameter as {name}. */
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description: string;
  readonly permission: string;
  /** The scope a token needs. None by default, for an operation that no token calls by a scope. */
  readonly scope?: Scope;
  readonly tool: string;
  /** Opens the operation to the AI assistant. Closed by default. */
  readonly assistant?: boolean;
  /** Marks an operation that serves the browser's session ("flow"), or that needs one ("only"). */
  readonly session?: "flow" | "only";
  /** Where the request's company comes from. By default the credential for an operation with a permission, and none for any other. */
  readonly company?: CompanySource;
}

export interface OperationDefinition<
  Query extends Shape | undefined,
  Body extends Shape | undefined,
  Output extends z.ZodType,
  Params extends Shape | undefined = undefined,
> extends Texts {
  /** The path parameters: a strict object of strings, each named in the path as {name}. */
  readonly params?: Params;
  readonly query?: Query;
  readonly body?: Body;
  /** The success answer's schema: NoBody for 202 and 204, Redirect for 303. */
  readonly output: Output;
  /** The success status: 200 by default, 201 for a write that makes something, 202 or 204 with no body, 303 for a redirect. */
  readonly status?: SuccessStatus;
  readonly writes: boolean;
}

export interface ListDefinition<Query extends Shape | undefined, Item extends z.ZodType> extends Texts {
  readonly query?: Query;
  readonly item: Item;
}

/** What each refusal means, by status. Every refusal is problem details. */
const REFUSALS = {
  400: "The request does not fit the operation. Each field problem names its field.",
  401: "No actor: the request carries no credential that names one.",
  // The causes follow, by the operation (forbiddenCauses).
  403: "The request may not call the operation",
  409: "A request with the same idempotency key is still running.",
  413: "The body is larger than 1 MiB.",
  415: "The body is not application/json.",
  422: "A rule refused the request, or a write's idempotency key belongs to another request.",
  429: "Too many attempts: wait the seconds that Retry-After gives before the next one.",
  500: "The server failed. The answer holds no detail of the error.",
  503: "The server checks as many passwords as it can at once: send the request again after the seconds that Retry-After gives.",
} as const;

type RefusalStatus = keyof typeof REFUSALS;

/** The causes of a 403, each by its problem code. */
const FORBIDDEN = {
  session: "the credential is a token, and the operation needs a browser session (session-required)",
  scope: "the credential is a token that lacks the operation's scope (scope-missing)",
  permission: "the credential names no company (company-required), or the actor lacks the operation's permission (permission-missing)",
  cookieOrigin: "it carries the session cookie without the install's own Origin, as a page of another site sends it (origin-not-allowed)",
  noneOrigin: "its Origin is another site's, not the install's own (origin-not-allowed)",
} as const;

/** The cause of a 409 of a write whose answer holds a secret, beside the key in use. */
const SHOWN_ONCE = "or the same request came again with its key, and its first answer held a secret, which is shown only once (answer-shown-once)";

/**
 * The texts of the refusals that differ from one operation to another: the
 * causes of its 403 and the challenge a token's 403 carries, the challenge
 * of its 401 and whether a bearer token can name it, and whether its answer
 * holds a secret.
 */
interface RefusalTexts {
  readonly forbidden: readonly string[];
  readonly tokenForbidden: string | undefined;
  readonly challenge: () => string;
  readonly bearer: boolean;
  readonly secret: boolean;
}

/** The description of a refusal, by its status and the operation's texts. */
function refusalText(status: RefusalStatus, texts: RefusalTexts): string {
  if (status === 403) {
    return `${REFUSALS[403]}: ${texts.forbidden.join("; or ")}.`;
  }
  return status === 409 && texts.secret ? `${REFUSALS[409].slice(0, -1)}; ${SHOWN_ONCE}.` : REFUSALS[status];
}

function refusal(status: RefusalStatus, texts: RefusalTexts): ResponseConfig {
  const response: ResponseConfig = {
    description: refusalText(status, texts),
    content: { "application/problem+json": { schema: Problem } },
  };
  if (status === 401) {
    const invalid = texts.bearer ? ` To a request whose bearer token names no actor, the Bearer challenge is ${bearerChallenge("invalid_token")} (RFC 6750, 3.1).` : "";
    response.headers = {
      "WWW-Authenticate": { description: `The challenge, as RFC 9110 asks of every 401: ${texts.challenge()}.${invalid}`, schema: { type: "string" } },
    };
  }
  if (status === 403 && texts.tokenForbidden !== undefined) {
    response.headers = { "WWW-Authenticate": { description: texts.tokenForbidden, schema: { type: "string" } } };
  }
  if (status === 429 || status === 503) {
    response.headers = {
      "Retry-After": { description: "The whole seconds to wait before the next attempt.", schema: { type: "string" } },
    };
  }
  return response;
}

/** One way for a request to name its actor, as OpenAPI writes it: each scheme it needs, with no scopes. */
export type SecurityRequirement = Partial<Record<SecurityScheme, string[]>>;

/**
 * The credentials an operation takes, by its permission and its scope: the
 * browser's session for every operation that needs an actor, and beside it
 * an API token for one that names a scope, which a token may call; none for
 * a public one or one that runs before sign-in. A new list each time, so no
 * entry shares one with another.
 */
export function securityOf(permission: string, scope: string | null): SecurityRequirement[] | undefined {
  if (permission === PUBLIC || permission === NONE) {
    return undefined;
  }
  return scope === null ? [{ sessionCookie: [] }] : [{ sessionCookie: [] }, { bearer: [] }];
}

/**
 * The challenge that a 401 of the operation carries in WWW-Authenticate
 * (RFC 9110, 11.6.1): one for each credential that it takes, so it names a
 * credential that the operation takes. To a request whose bearer token
 * names no actor (`invalidToken`), the Bearer challenge names RFC 6750's
 * invalid_token (3.1). An operation that needs no actor answers no 401, so
 * it has none.
 */
export function challengeOf(operation: Pick<Operation, "x-nortfox">, options: { readonly invalidToken?: boolean } = {}): string {
  const { permission, scope } = operation["x-nortfox"];
  const security = securityOf(permission, scope);
  if (security === undefined) {
    throw new Error("An operation that needs no actor answers no 401, so it has no challenge.");
  }
  const challenge = (scheme: SecurityScheme): string => (scheme === "bearer" && options.invalidToken === true ? bearerChallenge("invalid_token") : CHALLENGES[scheme]);
  return security.flatMap((requirement) => Object.keys(requirement).map((scheme) => challenge(scheme as SecurityScheme))).join(", ");
}

/**
 * What the WWW-Authenticate of a 403 holds, by the operation, when a token
 * is refused (RFC 6750, 3.1): insufficient_scope, with the operation's scope
 * when the token lacks it. A session's 403 carries no challenge. Undefined
 * for an operation that no token reaches with a 403: one that needs no
 * actor.
 */
function tokenForbiddenText(meta: OperationMeta): string | undefined {
  const { permission, scope } = meta;
  if (permission === PUBLIC || permission === NONE) {
    return undefined;
  }
  const refused = bearerChallenge("insufficient_scope");
  if (scope === null) {
    return `To a token, which the operation refuses with session-required: ${refused} (RFC 6750, 3.1). A session's 403 carries none.`;
  }
  const lacked = `${bearerChallenge("insufficient_scope", scope)} when the token lacks the scope (scope-missing)`;
  const permissionText = (OPEN_PERMISSIONS as readonly string[]).includes(permission) ? "" : `, and ${refused} when its person lacks the permission (permission-missing)`;
  return `To a token: ${lacked}${permissionText} (RFC 6750, 3.1). A session's 403 carries none.`;
}

/**
 * The causes of a 403 that /v1 can give an operation, by who may call it,
 * its session mark, its scope and its method, in the order the server checks
 * them. Anyone may call an operation that runs before sign-in, so no token
 * is refused one.
 */
function forbiddenCauses(meta: OperationMeta, method: Method): string[] {
  const { permission, session, scope } = meta;
  const open = (OPEN_PERMISSIONS as readonly string[]).includes(permission);
  const actor = permission !== PUBLIC && permission !== NONE;
  return [
    ...(actor && session !== null ? [FORBIDDEN.session] : []),
    ...(scope === null ? [] : [FORBIDDEN.scope]),
    ...(open ? [] : [FORBIDDEN.permission]),
    ...(permission !== PUBLIC && method !== "get" ? [FORBIDDEN.cookieOrigin] : []),
    ...(permission === NONE ? [FORBIDDEN.noneOrigin] : []),
  ];
}

/** Whether a call of an operation takes an idempotency key: a write does, unless it runs before sign-in. */
export function takesIdempotencyKey(operation: Pick<Operation, "x-nortfox">): boolean {
  const { writes, permission } = operation["x-nortfox"];
  return writes && permission !== NONE;
}

/**
 * The refusals an operation can give. They depend on who may call it, whether
 * it writes and takes a key, whether it takes a body, where its company comes
 * from, and, for a 403, its method (forbiddenCauses). An operation that
 * runs before sign-in can be refused by a rule even when it only reads, such
 * as a link that has ended. It can also be refused for too many attempts, or
 * because the server checks as many passwords as it can at once. An
 * operation whose input names its company is refused by a rule when the
 * person is no active member there, and a read that names a thing in its
 * path, such as a member, when the company holds none.
 */
function refusals(meta: OperationMeta, hasBody: boolean, hasParams: boolean, forbidden: readonly string[]): RefusalStatus[] {
  const { permission, writes } = meta;
  const anyone = permission === PUBLIC || permission === NONE;
  const key = writes && permission !== NONE;
  return [
    400,
    ...(anyone ? [] : ([401] as const)),
    ...(forbidden.length > 0 ? ([403] as const) : []),
    ...(key ? ([409] as const) : []),
    ...(writes || permission === NONE || isCompanyInput(meta.company) || hasParams ? ([422] as const) : []),
    ...(hasBody ? ([413, 415] as const) : []),
    ...(permission === NONE ? ([429] as const) : []),
    500,
    ...(permission === NONE ? ([503] as const) : []),
  ];
}

/** The header of a write's key. The quoted form of the IETF draft is taken too. */
const IdempotencyKeyHeaders = z.object({
  [IDEMPOTENCY_KEY_HEADER]: z.string().meta({
    description: `${IDEMPOTENCY_KEY_DESCRIPTION} The draft's quoted form, "key", is taken too.`,
    pattern: String.raw`^("[\x21\x23-\x5b\x5d-\x7e]{1,255}"|[\x21\x23-\x5b\x5d-\x7e]{1,255})$`,
  }),
});

/** Defines one operation: the createRoute object, with the refusals it can give and x-nortfox. */
export function defineOperation<
  Output extends z.ZodType,
  Query extends Shape | undefined = undefined,
  Body extends Shape | undefined = undefined,
  Params extends Shape | undefined = undefined,
>(definition: OperationDefinition<Query, Body, Output, Params>): Operation<Query, Body, Output, Params> {
  return build(definition, false);
}

/** Whether a status answers with no body. */
function answersNoBody(status: SuccessStatus): status is 202 | 204 {
  return status === 202 || status === 204;
}

/** The success answer of a status, or a throw when the output does not fit the status. */
function successResponse(id: string, status: SuccessStatus, output: z.ZodType): ResponseConfig {
  if (answersNoBody(status)) {
    if (output !== NoBody) {
      throw new Error(`${id} answers ${String(status)}, which has no body, so its output is NoBody.`);
    }
    return {
      description: status === 204 ? "Done. The answer has no body." : "Accepted. The work goes on after the answer, which has no body.",
    };
  }
  if (status === 303) {
    if (output !== Redirect) {
      throw new Error(`${id} answers 303, so its output is Redirect.`);
    }
    return {
      description: "See Other: the browser goes on to the location.",
      headers: { Location: { description: "The URL the browser goes to next.", schema: { type: "string" } } },
      content: { "application/json": { schema: output } },
    };
  }
  if (output === NoBody) {
    throw new Error(`${id} answers ${String(status)} with JSON, so its output is not NoBody.`);
  }
  return { description: output.description ?? "The answer.", content: { "application/json": { schema: output } } };
}

function build<Query extends Shape | undefined, Body extends Shape | undefined, Output extends z.ZodType, Params extends Shape | undefined>(
  definition: OperationDefinition<Query, Body, Output, Params>,
  list: boolean,
): Operation<Query, Body, Output, Params> {
  const { params, query, body, output, writes, permission } = definition;
  const status = definition.status ?? 200;
  const request: NonNullable<RouteConfig["request"]> = {};
  if (params !== undefined) {
    request.params = params;
  }
  if (query !== undefined) {
    request.query = query;
  }
  if (body !== undefined) {
    request.body = { required: true, content: { "application/json": { schema: body } } };
  }
  const meta: OperationMeta = {
    permission,
    scope: definition.scope ?? null,
    tool: definition.tool,
    assistant: definition.assistant ?? false,
    writes,
    list,
    session: definition.session ?? null,
    company: definition.company ?? ((OPEN_PERMISSIONS as readonly string[]).includes(permission) ? "none" : "credential"),
    personalOutput: answersNoBody(status) ? [] : personalPointers(output),
    secretOutput: answersNoBody(status) ? [] : secretPointers(output),
  };
  const keyed = takesIdempotencyKey({ "x-nortfox": meta });
  if (keyed) {
    request.headers = IdempotencyKeyHeaders;
  }
  const responses: Record<string, ResponseConfig> = { [status]: successResponse(definition.id, status, output) };
  const texts: RefusalTexts = {
    forbidden: forbiddenCauses(meta, definition.method),
    tokenForbidden: tokenForbiddenText(meta),
    challenge: () => challengeOf({ "x-nortfox": meta }),
    bearer: meta.scope !== null,
    secret: keyed && meta.secretOutput.length > 0,
  };
  for (const code of refusals(meta, body !== undefined, params !== undefined, texts.forbidden)) {
    responses[code] = refusal(code, texts);
  }
  const security = securityOf(permission, meta.scope);
  const route = createRoute({
    operationId: definition.id,
    method: definition.method,
    path: definition.path,
    tags: [...definition.tags],
    summary: definition.summary,
    description: definition.description,
    "x-nortfox": meta,
    request,
    responses,
    ...(security === undefined ? {} : { security }),
  });
  return route as unknown as Operation<Query, Body, Output, Params>;
}

/** The paging fields of every list. */
const PAGING = { limit: Limit, cursor: Cursor };

type Paging = typeof PAGING;

/** The query of a list: its own fields, then limit and cursor. */
export type ListQuery<Query extends Shape | undefined> = z.ZodObject<
  Query extends z.ZodObject<infer Fields> ? Fields & Paging : Paging,
  z.core.$strict
>;

/** Defines a list: an operation that takes limit and cursor and answers a page of its items. */
export function defineListOperation<Item extends z.ZodType, Query extends Shape | undefined = undefined>(
  definition: ListDefinition<Query, Item>,
): Operation<ListQuery<Query>, undefined, ReturnType<typeof pageOf<Item>>> {
  const { query, item, ...texts } = definition;
  const listQuery = (query === undefined ? z.strictObject(PAGING) : query.extend(PAGING)) as ListQuery<Query>;
  return build({ ...texts, query: listQuery, output: pageOf(item), writes: false }, true);
}

/** The schema of the path parameters, or undefined when the operation takes none. */
export function paramsSchema<Params extends Shape | undefined>(operation: Operation<Shape | undefined, Shape | undefined, z.ZodType, Params>): Params | undefined {
  return operation.request.params;
}

/** The schema of the query, or undefined when the operation takes none. */
export function querySchema<Query extends Shape | undefined>(operation: Operation<Query>): Query | undefined {
  return operation.request.query;
}

/** The schema of the JSON body, or undefined when the operation takes none. */
export function bodySchema<Body extends Shape | undefined>(operation: Operation<Shape | undefined, Body>): Body | undefined {
  return operation.request.body?.content["application/json"].schema as Body | undefined;
}

/** The success status: the one of SUCCESS_STATUSES that the operation answers. */
export function successStatus(operation: Operation): SuccessStatus {
  const found = SUCCESS_STATUSES.find((status) => String(status) in operation.responses);
  if (found === undefined) {
    throw new Error(`${operation.operationId} has no success answer.`);
  }
  return found;
}

/** The schema of the success answer: NoBody for an answer without a body. */
export function outputSchema<Output extends z.ZodType>(operation: Operation<Shape | undefined, Shape | undefined, Output>): Output {
  const status = successStatus(operation);
  if (answersNoBody(status)) {
    return NoBody as unknown as Output;
  }
  const json = operation.responses[status]?.content?.["application/json"];
  return (json as { readonly schema?: unknown } | undefined)?.schema as Output;
}
