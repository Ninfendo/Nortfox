// SPDX-License-Identifier: AGPL-3.0-only

// The /v1 surface: the REST routes of the registry, with NortFox's own
// reader and writer. Each operation's route is a chain that checks the
// caller before it reads anything:
//
// 1. the cross-site check (auth/origin.ts), from the headers alone: a write
//    with the session cookie and no bearer token needs the install's own
//    Origin, and an operation that runs before sign-in refuses any other
//    Origin. A refusal is 403 origin-not-allowed, before the resolver reads
//    the cookie.
// 2. authorize: the resolver reads the credential from the request's headers,
//    and the runner's authorize answers 401 (with the operation's challenge) or
//    403 at once. No query parameter and no byte of the body is read first.
//    A refusal of a request with a bearer token names RFC 6750's error code
//    in its Bearer challenge (refusalAnswer).
// 3. the body limit, for an operation that takes a body: a body over 1 MiB
//    gets 413. A Content-Length over the limit is refused before a byte is
//    read; a body without one is counted as it comes, and refused once it
//    passes the limit.
// 4. serve: the body reader, the path parameters, the query reader and the
//    idempotency key, then the runner, then the writer.
//
// A route's path holds each path parameter as :name, as Hono reads it; the
// registry writes it {name}, as OpenAPI does. Hono gives each parameter
// decoded, and the runner checks it by the operation's schema, so a bad one
// is a field problem at /<name>.
//
// The writer answers 200 and 201 with plain JSON, 202 and 204 with no body,
// and 303 with Location and the same location as JSON. It writes each cookie
// effect of the handler as a Set-Cookie header. Every /v1 answer, a problem
// too, carries Cache-Control: no-store, since it may hold the request's own
// data. Work that the handler queued for after the answer is released once
// the answer is built (after-answer.ts).
//
// The body reader takes application/json only, with any parameters (415
// otherwise), and JSON in UTF-8 (400 malformed-json otherwise). It gives the
// runner the parsed value, so a body that is not an object is a field
// problem at the root pointer. Slice 2e's compatible surface brings a reader
// of its own, which takes each amount from its own text.
//
// The query reader takes only the parameters the operation declares, by
// their exact names: an unknown name is unknown-parameter and a name given
// twice is repeated-parameter, each at the pointer /<name> in the
// operation's flat input. A declared number parameter whose text is a
// decimal number is read as JSON would read it, so limit=501 reaches the
// paging rule and limit=1.5 is not-an-integer; any other text stays a string
// for the schema to refuse. A known path with another method gets 405 with
// Allow.
//
// A write's idempotency key is the Idempotency-Key header, in the draft's
// quoted form or bare. The surface passes it to the runner for every write,
// so a write without one is 400 (idempotency.ts).

import { isIPv4 } from "node:net";
import {
  IDEMPOTENCY_KEY_HEADER,
  PUBLIC,
  bearerChallenge,
  bodySchema,
  challengeOf,
  jsonPointer,
  jsonSchemaOf,
  paramsSchema,
  querySchema,
  type FieldIssue,
  type Operation,
} from "@nortfox/contract";
import type { Context, Hono, Handler as RouteHandler, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { DEVICE_COOKIE, readCookie, setCookieHeader } from "../auth/cookies.ts";
import { carriesBearer, crossSiteRefused } from "../auth/origin.ts";
import type { AfterAnswerQueue } from "./after-answer.ts";
import { isToken, type ContextResolver, type Principal, type RequestContext } from "./context.ts";
import { readKeyHeader } from "./idempotency.ts";
import { authorize, runOperation, type Handler, type OperationCall, type Outcome, type Refusal, type RequestFacts, type RunnerDeps } from "./operation.ts";
import {
  NO_STORE,
  crossSiteRequest,
  internalError,
  malformedJson,
  methodNotAllowed,
  payloadTooLarge,
  problemOf,
  unsupportedMediaType,
  type ProblemAnswer,
} from "./problem.ts";

/** What a /v1 request carries from one step of its chain to the next. */
export interface V1Env {
  Variables: { principal: Principal | undefined };
}

export interface V1Deps extends RunnerDeps {
  readonly resolve: ContextResolver;
  /** The browser origins of the install, each as a browser serialises it: /v1's cross-site check and /mcp's Origin check. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** Told of every error that answers 500, and of work after an answer that fails. */
  readonly report: (error: unknown) => void;
  /** Where each call's work for after its answer goes. */
  readonly afterAnswer: AfterAnswerQueue;
}

/** The kind of each query parameter an operation declares: a number is read from its text. */
export type QueryFields = ReadonlyMap<string, "number" | "text">;

/** The parameters an operation's query declares, each with its kind. */
export function queryFields(operation: Operation): QueryFields {
  const shape: Readonly<Record<string, unknown>> = querySchema(operation)?.shape ?? {};
  return new Map(
    Object.entries(shape).map(([name, field]) => {
      const { type } = jsonSchemaOf(field as z.ZodType, "input");
      return [name, type === "integer" || type === "number" ? "number" : "text"] as const;
    }),
  );
}

/** A query as /v1 reads it: the declared parameters, and what is wrong with the others. */
export interface QueryRead {
  readonly values: Readonly<Record<string, unknown>>;
  readonly problems: readonly FieldIssue[];
}

/** A decimal number, as JSON writes one but for leading zeros. */
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

/** Reads the query of a request URL against the parameters an operation declares. */
export function readQuery(url: string, fields: QueryFields): QueryRead {
  const given = new Map<string, string[]>();
  for (const [name, text] of new URL(url).searchParams) {
    given.set(name, [...(given.get(name) ?? []), text]);
  }
  const values: Record<string, unknown> = {};
  const problems: FieldIssue[] = [];
  for (const [name, texts] of given) {
    const pointer = jsonPointer([name]);
    const [text] = texts as [string, ...string[]];
    const kind = fields.get(name);
    if (kind === undefined) {
      problems.push({ code: "unknown-parameter", detail: `The field ${pointer} is not part of this operation.`, pointer, data: { value: text } });
      continue;
    }
    if (texts.length > 1) {
      problems.push({ code: "repeated-parameter", detail: `The field ${pointer} is given more than once.`, pointer, data: { value: text } });
    }
    values[name] = kind === "number" && DECIMAL.test(text) ? Number(text) : text;
  }
  return { values, problems };
}

/** The largest body /v1 reads: 1 MiB. */
export const BODY_LIMIT = 1024 * 1024;

/** A body as /v1 reads it: the parsed JSON, or the answer that refuses it. */
export type BodyRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly answer: ProblemAnswer };

/** application/json, with any parameters, in any case (RFC 9110: the type and subtype are case-insensitive). */
const JSON_MEDIA_TYPE = /^application\/json[ \t]*(;|$)/i;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Reads a request's body as JSON: application/json in UTF-8, and nothing else. */
export async function readBody(request: Request): Promise<BodyRead> {
  if (!JSON_MEDIA_TYPE.test(request.headers.get("content-type") ?? "")) {
    return { ok: false, answer: unsupportedMediaType() };
  }
  const bytes = await request.arrayBuffer();
  try {
    return { ok: true, value: JSON.parse(UTF8.decode(bytes)) as unknown };
  } catch {
    return { ok: false, answer: malformedJson() };
  }
}

/** Problem details as an HTTP answer. */
export function problemResponse(answer: ProblemAnswer): Response {
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
}

/**
 * A success as /v1 answers it: plain UTF-8 JSON, no body for 202 and 204,
 * and Location with the JSON for 303. Each cookie effect is a Set-Cookie
 * header.
 */
function successResponse(outcome: Extract<Outcome, { readonly ok: true }>): Response {
  const { status, output } = outcome;
  const headers = new Headers(NO_STORE);
  for (const effect of outcome.effects ?? []) {
    headers.append("Set-Cookie", setCookieHeader(effect));
  }
  if (status === 202 || status === 204) {
    return new Response(null, { status, headers });
  }
  if (status === 303) {
    // The output passed the Redirect schema: the location is a string.
    headers.set("Location", (output as { readonly location: string }).location);
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(output), { status, headers });
}

/** The prefix of an IPv4 address in the IPv4-mapped IPv6 form (RFC 4291, 2.5.5.2), in any letter case. */
const IPV4_MAPPED = /^::ffff:/i;

/**
 * The address a request came from, when the server runs on Node; none
 * through app.request, as in most tests. The server listens on IPv6 and
 * IPv4 at once, so the socket gives an IPv4 client's address in the
 * IPv4-mapped form, ::ffff:a.b.c.d. That address is given as IPv4, a.b.c.d,
 * as the client has it. Any other address is given as the socket gives it.
 */
function ipAddressOf(env: unknown): string | undefined {
  const bindings = env as { readonly incoming?: { readonly socket: { readonly remoteAddress?: string } } } | undefined;
  const address = bindings?.incoming?.socket.remoteAddress;
  const mapped = address?.replace(IPV4_MAPPED, "");
  return mapped !== undefined && mapped !== address && isIPv4(mapped) ? mapped : address;
}

/** What /v1 knows of a request besides its input: its Origin, its address and its device cookie. */
function factsOf(c: Context<V1Env>): RequestFacts {
  const { headers } = c.req.raw;
  const origin = headers.get("origin");
  const ipAddress = ipAddressOf(c.env);
  const device = readCookie(headers, DEVICE_COOKIE);
  return {
    ...(origin === null ? {} : { origin }),
    ...(ipAddress === undefined ? {} : { ipAddress }),
    ...(device === undefined ? {} : { device }),
  };
}

/** The refusals of authorize that a token gets when it may not call the operation. */
const TOKEN_FORBIDDEN: ReadonlySet<Refusal["kind"]> = new Set(["session-required", "scope-missing", "company-required", "permission-missing"]);

/**
 * A refusal as /v1 answers it. A request with a bearer token gets RFC
 * 6750's error code (3.1) in its Bearer challenge. A 401 to one, whose token
 * names no actor, is invalid_token, with the same text whatever the token
 * was: unknown, revoked, of another kind, not in the bearer form, or of a
 * membership that is not active. A 403 that authorize gives a token is
 * insufficient_scope, with the scope it lacks for scope-missing. A request
 * without a bearer token gets the operation's plain challenge on a 401 and
 * none on a 403.
 */
export function refusalAnswer(operation: Operation, refusal: Refusal, headers: Headers, principal: Principal | undefined): ProblemAnswer {
  if (refusal.kind === "authentication-required" && carriesBearer(headers)) {
    return problemOf({ ...refusal, challenge: challengeOf(operation, { invalidToken: true }) });
  }
  const answer = problemOf(refusal);
  if (principal === undefined || !isToken(principal.credential) || !TOKEN_FORBIDDEN.has(refusal.kind)) {
    return answer;
  }
  const challenge = bearerChallenge("insufficient_scope", refusal.kind === "scope-missing" ? refusal.scope : undefined);
  return { ...answer, headers: { ...answer.headers, "WWW-Authenticate": challenge } };
}

/**
 * The chain's first step: whether another site may have started the request,
 * then who acts, and whether they may call the operation. Nothing of the
 * request but its headers is read. A public operation reads nothing of
 * anyone's, so neither check touches it.
 */
function authorizeRequest(operation: Operation, deps: V1Deps): MiddlewareHandler<V1Env> {
  const isPublic = operation["x-nortfox"].permission === PUBLIC;
  return async (c, next) => {
    if (!isPublic && crossSiteRefused(operation, c.req.raw, deps.allowedOrigins)) {
      return problemResponse(crossSiteRequest());
    }
    const principal = isPublic ? undefined : await deps.resolve(c.req.raw, "rest");
    const refusal = authorize(operation, principal);
    if (refusal !== undefined) {
      return problemResponse(refusalAnswer(operation, refusal, c.req.raw.headers, principal));
    }
    c.set("principal", principal);
    await next();
    return undefined;
  };
}

/** The chain's last step: the body, the path parameters, the query and the key, the runner and the answer. */
function serve(handler: Handler, fields: QueryFields, deps: V1Deps): RouteHandler<V1Env> {
  const { operation } = handler;
  const takesBody = bodySchema(operation) !== undefined;
  const takesParams = paramsSchema(operation) !== undefined;
  const writes = operation["x-nortfox"].writes;
  return async (c) => {
    let body: unknown;
    if (takesBody) {
      const read = await readBody(c.req.raw);
      if (!read.ok) {
        return problemResponse(read.answer);
      }
      body = read.value;
    }
    const params: Readonly<Record<string, string>> = takesParams ? c.req.param() : {};
    const query = readQuery(c.req.url, fields);
    const idempotency: OperationCall["idempotency"] = writes ? { key: readKeyHeader(c.req.raw.headers.get(IDEMPOTENCY_KEY_HEADER)) } : "none";
    const principal = c.get("principal");
    const context: RequestContext | undefined = principal === undefined ? undefined : { ...principal, channel: "rest" };
    const batch = deps.afterAnswer.batch();
    try {
      let outcome: Outcome;
      try {
        const input = { params, query: query.values, body, problems: query.problems };
        outcome = await runOperation(handler, { context, input, idempotency, request: factsOf(c), later: batch.later }, deps);
      } catch (error) {
        deps.report(error);
        return problemResponse(internalError());
      }
      return outcome.ok ? successResponse(outcome) : problemResponse(refusalAnswer(operation, outcome.refusal, c.req.raw.headers, principal));
    } finally {
      batch.release();
    }
  };
}

/** The methods in the order Allow names them. Hono answers HEAD from a GET route. */
const METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/** The chain's step between authorize and serve for an operation that takes a body: 413 for a body over the limit. */
const limitBody = bodyLimit({ maxSize: BODY_LIMIT, onError: () => problemResponse(payloadTooLarge()) });

/**
 * A path's place among the paths: each segment a 0 when it is fixed and a 1
 * when it is a parameter. At the first segment where two paths that could
 * match one request differ, the fixed one sorts first, so it answers that
 * request, as OpenAPI matches a concrete path before a templated one.
 */
function pathOrder(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "1" : "0"))
    .join("");
}

/**
 * Mounts the handlers path by path, the most concrete first: at each path
 * its operations' methods, then its 405 answer. Hono answers a request with
 * the first route that matches it, so a method that a concrete path does not
 * take gets that path's 405, never an operation of a path with a parameter
 * in its place: PATCH /v1/me/companies/recent is not updateMyMembership.
 */
export function mountV1(app: Hono<V1Env>, handlers: readonly Handler[], deps: V1Deps): void {
  const byPath = new Map<string, Handler[]>();
  for (const handler of handlers) {
    const path = handler.operation.getRoutingPath();
    byPath.set(path, [...(byPath.get(path) ?? []), handler]);
  }
  const paths = [...byPath].sort(([a], [b]) => {
    const [first, second] = [pathOrder(a), pathOrder(b)];
    return first < second ? -1 : first > second ? 1 : 0;
  });
  for (const [path, served] of paths) {
    const methods = new Set<string>();
    for (const handler of served) {
      const { operation } = handler;
      const method = operation.method.toUpperCase();
      const first = authorizeRequest(operation, deps);
      const last = serve(handler, queryFields(operation), deps);
      if (bodySchema(operation) === undefined) {
        app.on(method, path, first, last);
      } else {
        app.on(method, path, first, limitBody, last);
      }
      methods.add(method);
      if (method === "GET") {
        methods.add("HEAD");
      }
    }
    const allow = METHOD_ORDER.filter((method) => methods.has(method));
    app.all(path, () => problemResponse(methodNotAllowed(allow)));
  }
}
