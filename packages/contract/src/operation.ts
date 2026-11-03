// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One operation is one createRoute object from @hono/zod-openapi, and the
 * registry is the list of them (docs/decisions/0003-contract-first-rest-and-mcp.md).
 * The REST route, the generated client's method and the MCP tool all come
 * from it. NortFox's own parts of an entry sit in the OpenAPI extension
 * x-nortfox, so openapi.json shows each operation's permission, its MCP tool
 * text, and whether it writes, is a list or is open to the assistant.
 */

import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import { IDEMPOTENCY_KEY_DESCRIPTION, IDEMPOTENCY_KEY_HEADER } from "./idempotency-key.ts";
import { Cursor, Limit, pageOf } from "./paging.ts";
import { Problem } from "./problem.ts";

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

/** The methods an operation may use. */
export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type Method = (typeof METHODS)[number];

/** NortFox's own parts of a registry entry, in x-nortfox. */
export interface OperationMeta {
  /** The permission the actor needs, or "public" for an operation that reads no data. */
  readonly permission: string;
  /** The MCP tool's description, for the agents that read it. */
  readonly tool: string;
  /** Whether the AI assistant may call it. Closed unless the entry opens it. */
  readonly assistant: boolean;
  /** Whether it writes, and so takes an idempotency key. */
  readonly writes: boolean;
  /** Whether it is a list: it takes limit and cursor, and answers a page. */
  readonly list: boolean;
}

/** An object schema, for a query or a body. */
export type Shape = z.ZodObject;

/** One answer of a route: its description, its headers and its content. */
export type ResponseConfig = Exclude<RouteConfig["responses"][string], { readonly $ref: string }>;

export interface JsonBody<Body extends Shape> {
  readonly required: true;
  readonly content: { readonly "application/json": { readonly schema: Body } };
}

export interface OperationRequest<Query extends Shape | undefined, Body extends Shape | undefined> {
  readonly query?: Query;
  readonly body?: Body extends Shape ? JsonBody<Body> : never;
  readonly headers?: z.ZodObject;
}

/** A registry entry: a createRoute object with x-nortfox. */
export interface Operation<
  Query extends Shape | undefined = Shape | undefined,
  Body extends Shape | undefined = Shape | undefined,
  Output extends z.ZodType = z.ZodType,
> {
  readonly operationId: string;
  readonly method: Method;
  readonly path: string;
  readonly tags: string[];
  readonly summary: string;
  readonly description: string;
  readonly "x-nortfox": OperationMeta;
  /** OpenAPI's extensions: x-nortfox is the one NortFox writes. */
  readonly [extension: `x-${string}`]: unknown;
  readonly request: OperationRequest<Query, Body>;
  readonly responses: Readonly<Record<string, ResponseConfig>>;
  /** Never set: only the type of the output schema, which the success answer holds. */
  readonly "~output"?: Output;
  getRoutingPath(): string;
}

interface Texts {
  /** The operation id: the client's method and the MCP tool's name, in camelCase. */
  readonly id: string;
  readonly method: Method;
  /** The path under /v1, in lower-case kebab-case. */
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description: string;
  readonly permission: string;
  readonly tool: string;
  /** Opens the operation to the AI assistant. Closed by default. */
  readonly assistant?: boolean;
}

export interface OperationDefinition<Query extends Shape | undefined, Body extends Shape | undefined, Output extends z.ZodType>
  extends Texts {
  readonly query?: Query;
  readonly body?: Body;
  readonly output: Output;
  /** The success status: 200 by default, 201 for a write that makes something. */
  readonly status?: 200 | 201;
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
  403: "The actor lacks the permission the operation needs.",
  409: "A request with the same idempotency key is still running.",
  413: "The body is larger than 1 MiB.",
  415: "The body is not application/json.",
  422: "A rule refused the request, or the idempotency key belongs to another request.",
  500: "The server failed. The answer holds no detail of the error.",
} as const;

type RefusalStatus = keyof typeof REFUSALS;

function refusal(status: RefusalStatus): ResponseConfig {
  const response: ResponseConfig = {
    description: REFUSALS[status],
    content: { "application/problem+json": { schema: Problem } },
  };
  if (status === 401) {
    response.headers = {
      "WWW-Authenticate": { description: "The challenge, as RFC 9110 asks of every 401: Bearer.", schema: { type: "string" } },
    };
  }
  return response;
}

/** The refusals an operation can give: they depend on whether it is public, writes and takes a body. */
function refusals(isPublic: boolean, writes: boolean, hasBody: boolean): RefusalStatus[] {
  return [
    400,
    ...(isPublic ? [] : ([401, 403] as const)),
    ...(writes ? ([409, 422] as const) : []),
    ...(hasBody ? ([413, 415] as const) : []),
    500,
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
>(definition: OperationDefinition<Query, Body, Output>): Operation<Query, Body, Output> {
  return build(definition, false);
}

function build<Query extends Shape | undefined, Body extends Shape | undefined, Output extends z.ZodType>(
  definition: OperationDefinition<Query, Body, Output>,
  list: boolean,
): Operation<Query, Body, Output> {
  const { query, body, output, writes } = definition;
  const status = definition.status ?? 200;
  const request: NonNullable<RouteConfig["request"]> = {};
  if (query !== undefined) {
    request.query = query;
  }
  if (body !== undefined) {
    request.body = { required: true, content: { "application/json": { schema: body } } };
  }
  if (writes) {
    request.headers = IdempotencyKeyHeaders;
  }
  const responses: Record<string, ResponseConfig> = {
    [status]: { description: output.description ?? "The answer.", content: { "application/json": { schema: output } } },
  };
  for (const code of refusals(definition.permission === PUBLIC, writes, body !== undefined)) {
    responses[code] = refusal(code);
  }
  const route = createRoute({
    operationId: definition.id,
    method: definition.method,
    path: definition.path,
    tags: [...definition.tags],
    summary: definition.summary,
    description: definition.description,
    "x-nortfox": {
      permission: definition.permission,
      tool: definition.tool,
      assistant: definition.assistant ?? false,
      writes,
      list,
    } satisfies OperationMeta,
    request,
    responses,
  });
  return route as unknown as Operation<Query, Body, Output>;
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

/** The schema of the query, or undefined when the operation takes none. */
export function querySchema<Query extends Shape | undefined>(operation: Operation<Query>): Query | undefined {
  return operation.request.query;
}

/** The schema of the JSON body, or undefined when the operation takes none. */
export function bodySchema<Body extends Shape | undefined>(operation: Operation<Shape | undefined, Body>): Body | undefined {
  return operation.request.body?.content["application/json"].schema as Body | undefined;
}

/** The success status: 201 when the operation answers it, else 200. */
export function successStatus(operation: Operation): 200 | 201 {
  return "201" in operation.responses ? 201 : 200;
}

/** The schema of the success answer. */
export function outputSchema<Output extends z.ZodType>(operation: Operation<Shape | undefined, Shape | undefined, Output>): Output {
  const json = operation.responses[successStatus(operation)]?.content?.["application/json"];
  return (json as { readonly schema?: unknown } | undefined)?.schema as Output;
}
