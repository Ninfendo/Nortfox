// SPDX-License-Identifier: AGPL-3.0-only

// The /v1 surface: the REST routes of the registry, with NortFox's own
// reader and writer. Each operation's route is a chain that checks the
// caller before it reads anything:
//
// 1. authorize: the resolver reads the credential from the request's headers,
//    and the runner's authorize answers 401 (with the Bearer challenge) or
//    403 at once. No query parameter and no byte of the body is read first.
// 2. the body limit, for an operation that takes a body: a body over 1 MiB
//    gets 413. A Content-Length over the limit is refused before a byte is
//    read; a body without one is counted as it comes, and refused once it
//    passes the limit.
// 3. serve: the body reader, the query reader and the idempotency key, then
//    the runner, then the JSON writer.
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

import { IDEMPOTENCY_KEY_HEADER, PUBLIC, bodySchema, jsonPointer, jsonSchemaOf, querySchema, type FieldIssue, type Operation } from "@nortfox/contract";
import type { Hono, Handler as RouteHandler, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { ContextResolver, Principal, RequestContext } from "./context.ts";
import { readKeyHeader } from "./idempotency.ts";
import { authorize, runOperation, type Handler, type OperationCall, type Outcome, type RunnerDeps } from "./operation.ts";
import { internalError, malformedJson, methodNotAllowed, payloadTooLarge, problemOf, unsupportedMediaType, type ProblemAnswer } from "./problem.ts";

/** What a /v1 request carries from one step of its chain to the next. */
export interface V1Env {
  Variables: { principal: Principal | undefined };
}

export interface V1Deps extends RunnerDeps {
  readonly resolve: ContextResolver;
  /** Told of every error that answers 500. */
  readonly report: (error: unknown) => void;
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

/** Plain UTF-8 JSON, as every /v1 success answers. */
function jsonResponse(output: unknown, status: number): Response {
  return new Response(JSON.stringify(output), { status, headers: { "Content-Type": "application/json" } });
}

/** The chain's first step: who acts, and whether they may call the operation. Nothing of the request but its headers is read. */
function authorizeRequest(operation: Operation, deps: V1Deps): MiddlewareHandler<V1Env> {
  const isPublic = operation["x-nortfox"].permission === PUBLIC;
  return async (c, next) => {
    const principal = isPublic ? undefined : await deps.resolve(c.req.raw);
    const refusal = authorize(operation, principal);
    if (refusal !== undefined) {
      return problemResponse(problemOf(refusal));
    }
    c.set("principal", principal);
    await next();
    return undefined;
  };
}

/** The chain's last step: the body, the query and the key, the runner and the answer. */
function serve(handler: Handler, fields: QueryFields, deps: V1Deps): RouteHandler<V1Env> {
  const { operation } = handler;
  const takesBody = bodySchema(operation) !== undefined;
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
    const query = readQuery(c.req.url, fields);
    const idempotency: OperationCall["idempotency"] = writes ? { key: readKeyHeader(c.req.raw.headers.get(IDEMPOTENCY_KEY_HEADER)) } : "none";
    const principal = c.get("principal");
    const context: RequestContext | undefined = principal === undefined ? undefined : { ...principal, channel: "rest" };
    let outcome: Outcome;
    try {
      outcome = await runOperation(handler, { context, input: { query: query.values, body, problems: query.problems }, idempotency }, deps);
    } catch (error) {
      deps.report(error);
      return problemResponse(internalError());
    }
    return outcome.ok ? jsonResponse(outcome.output, outcome.status) : problemResponse(problemOf(outcome.refusal));
  };
}

/** The methods in the order Allow names them. Hono answers HEAD from a GET route. */
const METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/** The chain's step between authorize and serve for an operation that takes a body: 413 for a body over the limit. */
const limitBody = bodyLimit({ maxSize: BODY_LIMIT, onError: () => problemResponse(payloadTooLarge()) });

/** Mounts each handler's operation at its method and path, then the 405 answer at each of their paths. */
export function mountV1(app: Hono<V1Env>, handlers: readonly Handler[], deps: V1Deps): void {
  const allowed = new Map<string, Set<string>>();
  for (const handler of handlers) {
    const { operation } = handler;
    const method = operation.method.toUpperCase();
    const first = authorizeRequest(operation, deps);
    const last = serve(handler, queryFields(operation), deps);
    if (bodySchema(operation) === undefined) {
      app.on(method, operation.path, first, last);
    } else {
      app.on(method, operation.path, first, limitBody, last);
    }
    const methods = allowed.get(operation.path) ?? new Set<string>();
    methods.add(method);
    if (method === "GET") {
      methods.add("HEAD");
    }
    allowed.set(operation.path, methods);
  }
  for (const [path, methods] of allowed) {
    const allow = METHOD_ORDER.filter((method) => methods.has(method));
    app.all(path, () => problemResponse(methodNotAllowed(allow)));
  }
}
