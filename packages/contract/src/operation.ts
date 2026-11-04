// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One operation is one createRoute object from @hono/zod-openapi, and the
 * registry is the list of them (docs/decisions/0003-contract-first-rest-and-mcp.md).
 * The REST route, the generated client's method and the MCP tool all come
 * from it. NortFox's own parts of an entry sit in the OpenAPI extension
 * x-nortfox, so openapi.json shows each operation's permission, its MCP tool
 * text, whether it writes, is a list or is open to the assistant, whether it
 * serves the browser's session, and where its company comes from. OpenAPI's
 * own `security` names the credentials that can name its actor.
 */

import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import { IDEMPOTENCY_KEY_DESCRIPTION, IDEMPOTENCY_KEY_HEADER } from "./idempotency-key.ts";
import { Cursor, Limit, pageOf } from "./paging.ts";
import { Problem } from "./problem.ts";
import { CHALLENGES, type SecurityScheme } from "./security.ts";

/**
 * The permissions an operation can need, each with what it allows. Which
 * roles and tokens hold them is slice 2c's. An operation that reads no data
 * needs none, and says "public".
 */
export const PERMISSIONS = {
  "company:read": "Read the company: its id, name, organisation number and tenant id.",
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
 * null marks every other operation.
 */
export type SessionMark = "flow" | null;

/** Where a request's company comes from: nowhere, or the request's credential. */
export const COMPANY_SOURCES = ["none", "credential"] as const;

export type CompanySource = (typeof COMPANY_SOURCES)[number];

/** The methods an operation may use. */
export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type Method = (typeof METHODS)[number];

/** NortFox's own parts of a registry entry, in x-nortfox. */
export interface OperationMeta {
  /** The permission the actor needs: "public", "none", "signed-in" or a key of PERMISSIONS. */
  readonly permission: string;
  /** The MCP tool's description, for the agents that read it. */
  readonly tool: string;
  /** Whether the AI assistant may call it. Closed unless the entry opens it. */
  readonly assistant: boolean;
  /** Whether it writes. A write takes an idempotency key, unless it runs before sign-in. */
  readonly writes: boolean;
  /** Whether it is a list: it takes limit and cursor, and answers a page. */
  readonly list: boolean;
  /** "flow" for an operation that serves the browser's session; null for any other. */
  readonly session: SessionMark;
  /** Where the request's company comes from. */
  readonly company: CompanySource;
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
  readonly tool: string;
  /** Opens the operation to the AI assistant. Closed by default. */
  readonly assistant?: boolean;
  /** Marks an operation that serves the browser's session. */
  readonly session?: "flow";
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
  permission: "the credential names no company (company-required), or the actor lacks the operation's permission (permission-missing)",
  cookieOrigin: "it carries the session cookie without the install's own Origin, as a page of another site sends it (origin-not-allowed)",
  noneOrigin: "its Origin is another site's, not the install's own (origin-not-allowed)",
} as const;

/** The texts of the refusals that differ from one operation to another: the causes of its 403, and the challenge of its 401. */
interface RefusalTexts {
  readonly forbidden: readonly string[];
  readonly challenge: () => string;
}

function refusal(status: RefusalStatus, texts: RefusalTexts): ResponseConfig {
  const response: ResponseConfig = {
    description: status === 403 ? `${REFUSALS[403]}: ${texts.forbidden.join("; or ")}.` : REFUSALS[status],
    content: { "application/problem+json": { schema: Problem } },
  };
  if (status === 401) {
    response.headers = {
      "WWW-Authenticate": { description: `The challenge, as RFC 9110 asks of every 401: ${texts.challenge()}.`, schema: { type: "string" } },
    };
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
 * The credentials an operation takes, by its permission: the browser's
 * session for every operation that needs an actor, and none for a public one
 * or one that runs before sign-in. A new list each time, so no entry shares
 * one with another.
 */
export function securityOf(permission: string): SecurityRequirement[] | undefined {
  return permission === PUBLIC || permission === NONE ? undefined : [{ sessionCookie: [] }];
}

/**
 * The challenge that a 401 of the operation carries in WWW-Authenticate
 * (RFC 9110, 11.6.1): one for each credential that it takes, so it names a
 * credential that the operation takes. An operation that needs no actor
 * answers no 401, so it has none.
 */
export function challengeOf(operation: Pick<Operation, "x-nortfox">): string {
  const security = securityOf(operation["x-nortfox"].permission);
  if (security === undefined) {
    throw new Error("An operation that needs no actor answers no 401, so it has no challenge.");
  }
  return security.flatMap((requirement) => Object.keys(requirement).map((scheme) => CHALLENGES[scheme as SecurityScheme])).join(", ");
}

/** The causes of a 403 that /v1 can give an operation, by who may call it and its method. */
function forbiddenCauses(permission: string, method: Method): string[] {
  const open = (OPEN_PERMISSIONS as readonly string[]).includes(permission);
  return [
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
 * it writes and takes a key, whether it takes a body, and, for a 403, its
 * method (forbiddenCauses). An operation that
 * runs before sign-in can be refused by a rule even when it only reads, such
 * as a link that has ended. It can also be refused for too many attempts, or
 * because the server checks as many passwords as it can at once.
 */
function refusals(permission: string, writes: boolean, hasBody: boolean, forbidden: readonly string[]): RefusalStatus[] {
  const anyone = permission === PUBLIC || permission === NONE;
  const key = writes && permission !== NONE;
  return [
    400,
    ...(anyone ? [] : ([401] as const)),
    ...(forbidden.length > 0 ? ([403] as const) : []),
    ...(key ? ([409] as const) : []),
    ...(writes || permission === NONE ? ([422] as const) : []),
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
    tool: definition.tool,
    assistant: definition.assistant ?? false,
    writes,
    list,
    session: definition.session ?? null,
    company: definition.company ?? ((OPEN_PERMISSIONS as readonly string[]).includes(permission) ? "none" : "credential"),
  };
  if (takesIdempotencyKey({ "x-nortfox": meta })) {
    request.headers = IdempotencyKeyHeaders;
  }
  const responses: Record<string, ResponseConfig> = { [status]: successResponse(definition.id, status, output) };
  const texts: RefusalTexts = { forbidden: forbiddenCauses(permission, definition.method), challenge: () => challengeOf({ "x-nortfox": meta }) };
  for (const code of refusals(permission, writes, body !== undefined, texts.forbidden)) {
    responses[code] = refusal(code, texts);
  }
  const security = securityOf(permission);
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
