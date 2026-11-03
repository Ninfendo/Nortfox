// SPDX-License-Identifier: AGPL-3.0-only

// The runner: the one place that runs an operation, for every surface. REST
// and MCP call it, and from slice 2e the compatible surface too, so each rule
// holds once. A handler is a plain function of the request context and its
// typed input. It never sees Hono, a Request or a Response. It gives its
// output, or a refusal with a stable code and its facts, which each surface
// turns into its own answer: /v1 into problem details, 2e into its own
// status, envelope and message.
//
// The runner's steps, in this order:
//
// 1. A public operation reads no data: its input is checked, its handler
//    runs with no context and no database, and its output is checked.
// 2. No actor: 401. Nothing of the input is read, and the database is not
//    asked.
// 3. An actor without the operation's permission: 403, the same way.
// 4. The input: a list's limit by the paging rule, then the query and the
//    body by the operation's schemas, with the problems the surface's reader
//    found, and a write's idempotency key when the surface passes a key
//    policy (idempotency.ts). Any problem is one 400 with every field
//    problem. Then a list's cursor, which must be one this server made for
//    this list and company.
// 5. A write with a key: the key in flight. A running request of the actor
//    that holds the key gives 409, before the pool is asked for a connection.
// 6. One transaction with the request's company, actor, kind and channel
//    (db/database.ts): a read at REPEATABLE READ READ ONLY, a write at READ
//    COMMITTED. A write with a key looks the key up first: the same request's
//    key replays its first answer, another request's gives 422, and both
//    roll back. Then the handler runs. A read handler adds no company
//    condition of its own: row level security keeps it to the transaction's
//    company (decision 9).
// 7. Still inside the transaction: a list's next cursor is signed, and the
//    output is checked against the operation's schema. An output that does
//    not fit is a fault of the server: it throws, and nothing commits.
// 8. A write with a key stores the key with the checked answer, and then the
//    transaction commits. So nothing commits, and no answer is stored, before
//    the output passed its check. When another process stored the key first,
//    the write rolls back, and the stored key is read in a new transaction.
// 9. A handler's refusal rolls back and is a rule's refusal (422). A refusal
//    of the ledger that is a rule a request can break, from a statement or
//    from the commit, is one too, with its facts (ledger-refusals.ts). Any
//    other throw rolls back and is thrown again, and the surface answers 500.
//    A refused or failed write stores no key, so a retry with it runs again.
//
// The key policy is the surface's. /v1 and MCP pass the key they read for
// every write, so a write without one is 400 there. The compatible surface
// (slice 2e) will pass "none": its write runs on every call and stores no key.

import {
  PUBLIC,
  bodySchema,
  effectiveLimit,
  fieldIssues,
  jsonPointer,
  outputSchema,
  querySchema,
  successStatus,
  type FieldIssue,
  type JsonValue,
  type Operation,
  type Shape,
} from "@nortfox/contract";
import { z } from "zod";
import { commit, rollBack, type Database, type Ending, type Queryable, type TransactionSettings, type Work } from "../db/database.ts";
import type { Principal, RequestContext } from "./context.ts";
import { readCursor, signCursor, type CursorScope } from "./cursor.ts";
import { checkKey, findKey, requestHash, storeKey, type KeyCheck, type KeysInFlight, type StoredAnswer } from "./idempotency.ts";
import { ledgerRule } from "./ledger-refusals.ts";

/** A handler's refusal by a rule: a stable code, a sentence, and the field and facts when it has them. */
export interface RuleRefusal {
  readonly code: string;
  readonly detail: string;
  /** The field the refusal is about, as a JSON Pointer into the operation's input, so a screen can show it there. */
  readonly pointer?: string;
  /** The facts behind it: the value, the limit, the lock. */
  readonly data?: Readonly<Record<string, JsonValue>>;
}

/** What a handler gives: its output, or its refusal. */
export type Answer<Output> = { readonly ok: true; readonly output: Output } | { readonly ok: false; readonly refusal: RuleRefusal };

/** A handler's output. */
export function ok<Output>(output: Output): Answer<Output> {
  return { ok: true, output };
}

/** A handler's refusal by a rule. */
export function refused(refusal: RuleRefusal): Answer<never> {
  return { ok: false, refusal };
}

type QueryOf<Op> =
  Op extends Operation<infer Query> ? (Query extends Shape ? z.output<Query> : Readonly<Record<string, never>>) : never;
type BodyOf<Op> = Op extends Operation<Shape | undefined, infer Body> ? (Body extends Shape ? z.output<Body> : undefined) : never;

/** The output an operation answers. */
export type OutputOf<Op> = Op extends Operation<Shape | undefined, Shape | undefined, infer Output> ? z.output<Output> : never;

/** The item of a list's page. */
export type ItemOf<Op> = OutputOf<Op> extends { readonly items: readonly (infer Item)[] } ? Item : never;

/** A handler's input: its query and its body, as the operation's schemas parsed them. */
export interface Input<Query, Body> {
  readonly query: Query;
  readonly body: Body;
}

export type InputOf<Op> = Input<QueryOf<Op>, BodyOf<Op>>;

/** What a handler of an operation that reads data gets besides its input. */
export interface DataCall {
  readonly context: RequestContext;
  /** The request's transaction. */
  readonly tx: Queryable;
}

/** The page a list's handler reads: at most `limit` items, after the item whose sort key is `after`. */
export interface PageRequest {
  readonly limit: number;
  readonly after?: readonly string[];
}

export interface ListCall extends DataCall {
  readonly page: PageRequest;
}

/**
 * A list's page as its handler gives it: the items, the total, and the sort
 * key of the last item while more follow. A handler reads one row more than
 * the limit to know whether more follow, and counts the total in the same
 * transaction, so the page and its total come from one snapshot.
 */
export interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly total: number;
  readonly next?: readonly string[];
}

type AnyInput = Input<Readonly<Record<string, unknown>>, unknown>;

/** The handler of a public operation: it gets its input, and no context and no database. */
export interface PublicHandler {
  readonly kind: "public";
  readonly operation: Operation;
  readonly run: (input: AnyInput) => Promise<Answer<unknown>>;
}

/** The handler of an operation that reads or writes data, in the request's transaction. */
export interface DataHandler {
  readonly kind: "data";
  readonly operation: Operation;
  readonly run: (call: DataCall, input: AnyInput) => Promise<Answer<unknown>>;
}

/** The handler of a list: it reads one page in the request's transaction. */
export interface ListHandler {
  readonly kind: "list";
  readonly operation: Operation;
  readonly run: (call: ListCall, input: AnyInput) => Promise<Answer<PageResult<unknown>>>;
}

/** An operation's handler, with the operation it serves. */
export type Handler = PublicHandler | DataHandler | ListHandler;

function isPublic(operation: Operation): boolean {
  return operation["x-nortfox"].permission === PUBLIC;
}

// The runner gives a handler only the input that its operation's schemas
// parsed, so each helper keeps the handler's own types at its definition.

/** The handler of a public operation. */
export function handlePublic<Op extends Operation>(operation: Op, run: (input: InputOf<Op>) => Promise<Answer<OutputOf<Op>>>): PublicHandler {
  if (!isPublic(operation)) {
    throw new Error(`${operation.operationId} needs a permission, so it takes a data handler.`);
  }
  return { kind: "public", operation, run: run as unknown as PublicHandler["run"] };
}

/** The handler of an operation that needs a permission and is not a list. */
export function handleData<Op extends Operation>(
  operation: Op,
  run: (call: DataCall, input: InputOf<Op>) => Promise<Answer<OutputOf<Op>>>,
): DataHandler {
  if (isPublic(operation)) {
    throw new Error(`${operation.operationId} is public, so it takes a public handler.`);
  }
  if (operation["x-nortfox"].list) {
    throw new Error(`${operation.operationId} is a list, so it takes a list handler.`);
  }
  return { kind: "data", operation, run: run as unknown as DataHandler["run"] };
}

/** The handler of a list. */
export function handleList<Op extends Operation>(
  operation: Op,
  run: (call: ListCall, input: InputOf<Op>) => Promise<Answer<PageResult<ItemOf<Op>>>>,
): ListHandler {
  if (isPublic(operation)) {
    throw new Error(`${operation.operationId} is public, so it takes a public handler.`);
  }
  if (!operation["x-nortfox"].list) {
    throw new Error(`${operation.operationId} is not a list, so it takes a data handler.`);
  }
  return { kind: "list", operation, run: run as unknown as ListHandler["run"] };
}

/** Why the runner refused a call. Each surface turns it into its own answer. */
export type Refusal =
  | { readonly kind: "authentication-required" }
  | { readonly kind: "permission-missing"; readonly permission: string }
  | { readonly kind: "invalid"; readonly problems: readonly FieldIssue[] }
  | { readonly kind: "rule"; readonly refusal: RuleRefusal }
  /** A running request of the actor holds the idempotency key. */
  | { readonly kind: "idempotency-key-in-use" }
  /** The actor's idempotency key belongs to another request. */
  | { readonly kind: "idempotency-key-reused" };

/** The answer to a call: its success status and output, or its refusal. A replay gives the stored status and output. */
export type Outcome = { readonly ok: true; readonly status: number; readonly output: unknown } | { readonly ok: false; readonly refusal: Refusal };

/** One call of an operation, as a surface read it. */
export interface OperationCall {
  /** Who acts, or undefined when the request names no actor. */
  readonly context: RequestContext | undefined;
  readonly input: {
    /** The query parameters, by name. */
    readonly query: Readonly<Record<string, unknown>>;
    /** The body, as JSON gives it, or undefined. */
    readonly body: unknown;
    /** What the surface's reader found wrong with the request. */
    readonly problems?: readonly FieldIssue[];
  };
  /**
   * The key policy: the idempotency key the surface read for a write, which
   * is undefined when the request carried none, or "none" for a write that
   * runs on every call and stores no key. A read ignores it.
   */
  readonly idempotency: { readonly key: unknown } | "none";
}

export interface RunnerDeps {
  readonly database: Database;
  /** The key that signs each list's cursors. */
  readonly cursorKey: Uint8Array;
  /** The idempotency keys of the writes that run now in this process. */
  readonly keysInFlight: KeysInFlight;
}

/**
 * The refusal for a principal that may not call the operation, or undefined
 * when it may. The surfaces call it before they read any part of a request.
 */
export function authorize(operation: Operation, principal: Principal | undefined): Refusal | undefined {
  const { permission } = operation["x-nortfox"];
  if (permission === PUBLIC) {
    return undefined;
  }
  if (principal === undefined) {
    return { kind: "authentication-required" };
  }
  return principal.permissions.has(permission) ? undefined : { kind: "permission-missing", permission };
}

function refuse(refusal: Refusal): Outcome {
  return { ok: false, refusal };
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly FieldIssue[] };

/** An operation that takes no query refuses every parameter. */
const NO_QUERY = z.strictObject({});

function parse(schema: z.ZodType, value: unknown): Checked<unknown> {
  const result = schema.safeParse(value, { reportInput: true });
  return result.success ? { ok: true, value: result.data } : { ok: false, problems: fieldIssues(result.error.issues) };
}

/** A call's input after its checks: the query and the body as the operation's schemas parsed them, and a write's key when it takes one. */
interface ReadCall {
  readonly input: AnyInput;
  readonly key: string | undefined;
}

/**
 * The input as the operation's schemas parse it, with a list's limit by the
 * paging rule, and a write's idempotency key when the surface passed a key
 * policy. The problems come in the order: the reader's, the query's, the
 * body's, the key's.
 */
function readCall(operation: Operation, call: OperationCall): Checked<ReadCall> {
  const { input, idempotency } = call;
  const raw = operation["x-nortfox"].list ? { ...input.query, limit: effectiveLimit(input.query["limit"]) } : input.query;
  const query = parse(querySchema(operation) ?? NO_QUERY, raw);
  const bodyShape = bodySchema(operation);
  const body = bodyShape === undefined ? ({ ok: true, value: undefined } as const) : parse(bodyShape, input.body);
  const key: KeyCheck | undefined = operation["x-nortfox"].writes && idempotency !== "none" ? checkKey(idempotency.key) : undefined;
  const problems = [
    ...(input.problems ?? []),
    ...(query.ok ? [] : query.problems),
    ...(body.ok ? [] : body.problems),
    ...(key?.ok === false ? key.problems : []),
  ];
  if (!query.ok || !body.ok || key?.ok === false || problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, value: { input: { query: query.value as AnyInput["query"], body: body.value }, key: key?.value } };
}

/** The page a list's handler reads, from its parsed query, or the cursor's problem. */
function pageRequest(query: AnyInput["query"], scope: CursorScope, key: Uint8Array): Checked<PageRequest> {
  // The paging rule and the schema leave a whole number from 1 to 500, and a string or nothing.
  const { limit, cursor } = query as { readonly limit: number; readonly cursor?: string };
  if (cursor === undefined) {
    return { ok: true, value: { limit } };
  }
  const after = readCursor(key, scope, cursor);
  if (after === undefined) {
    return {
      ok: false,
      problems: [
        {
          code: "cursor-invalid",
          detail: "The field /cursor is not a cursor that this server made for this list. Start the list again without it.",
          pointer: "/cursor",
          data: { value: cursor },
        },
      ],
    };
  }
  return { ok: true, value: { limit, after } };
}

/** The output, after its check against the operation's schema. One that does not fit is a fault of the server. */
function checkedOutput(operation: Operation, output: unknown): unknown {
  const result = outputSchema(operation).safeParse(output);
  if (!result.success) {
    const where = result.error.issues.map((issue) => `${jsonPointer(issue.path)} ${issue.message}`).join("; ");
    throw new Error(`The output of ${operation.operationId} does not fit its schema: ${where}`);
  }
  return result.data;
}

/** A handler's refusal as the runner's. */
function ruleOf(refusal: RuleRefusal): Outcome {
  return refuse({ kind: "rule", refusal });
}

/** How a handler's answer ends its transaction: a refusal rolls back; an output is checked, then commits. */
function ending(operation: Operation, answer: Answer<unknown>): Ending<Outcome> {
  if (!answer.ok) {
    return rollBack(ruleOf(answer.refusal));
  }
  return commit({ ok: true, status: successStatus(operation), output: checkedOutput(operation, answer.output) });
}

/** A handler's page as the wire holds it: the next page's sort key becomes a signed cursor. */
function wirePage(page: PageResult<unknown>, scope: CursorScope, key: Uint8Array): unknown {
  const { items, total, next } = page;
  return next === undefined ? { items, total } : { items, total, nextCursor: signCursor(key, scope, next) };
}

/**
 * Runs a transaction, and gives a refusal of the ledger that is a rule a
 * request can break as the rule's refusal. Every other error is thrown again.
 */
async function answered<T>(transaction: () => Promise<T>): Promise<T | Outcome> {
  try {
    return await transaction();
  } catch (error) {
    const rule = ledgerRule(error);
    if (rule === undefined) {
      throw error;
    }
    return ruleOf(rule);
  }
}

/** The stored answer of a key: the first answer again for the same request, 422 for another. */
function replay(stored: StoredAnswer, hash: string): Outcome {
  return stored.hash === hash ? { ok: true, status: stored.status, output: stored.body } : refuse({ kind: "idempotency-key-reused" });
}

/** Marks a write whose key another process stored first, while this write ran. */
const STORED_FIRST_ELSEWHERE = Symbol("stored first elsewhere");

/** What a keyed write needs besides its handler. */
interface KeyedWrite {
  readonly context: RequestContext;
  readonly settings: TransactionSettings;
  readonly input: AnyInput;
  readonly key: string;
}

/**
 * A write with an idempotency key (idempotency.ts): the key in flight, then
 * one write transaction that looks the key up, runs the handler, checks the
 * output and stores the key with the answer before it commits.
 */
async function runKeyedWrite(handler: DataHandler, write: KeyedWrite, deps: RunnerDeps): Promise<Outcome> {
  const { operation } = handler;
  const { context, settings, input, key } = write;
  const release = deps.keysInFlight.claim(context.companyId, context.actorId, key);
  if (release === undefined) {
    return refuse({ kind: "idempotency-key-in-use" });
  }
  try {
    const hash = requestHash(operation.operationId, input.query, input.body);
    const first = await answered(() =>
      deps.database.write(settings, async (tx): Promise<Ending<Outcome | typeof STORED_FIRST_ELSEWHERE>> => {
        const stored = await findKey(tx, context.actorId, key);
        if (stored !== undefined) {
          return rollBack(replay(stored, hash));
        }
        const answer = await handler.run({ context, tx }, input);
        if (!answer.ok) {
          return rollBack(ruleOf(answer.refusal));
        }
        const status = successStatus(operation);
        const output = checkedOutput(operation, answer.output);
        const kept = await storeKey(tx, { companyId: context.companyId, key, operationId: operation.operationId, hash, status, body: output });
        return kept ? commit({ ok: true, status, output }) : rollBack(STORED_FIRST_ELSEWHERE);
      }),
    );
    if (first !== STORED_FIRST_ELSEWHERE) {
      return first;
    }
    return await deps.database.read(settings, async (tx) => {
      const stored = await findKey(tx, context.actorId, key);
      if (stored === undefined) {
        throw new Error(`Another transaction stored the idempotency key ${key} first, and it is not there.`);
      }
      return commit(replay(stored, hash));
    });
  } finally {
    release();
  }
}

/**
 * Runs one call of an operation, for any surface. It gives the output or a
 * refusal, and throws on anything the server did not expect, which the
 * surface answers with 500. A surface passes its key policy for a write: /v1
 * and MCP the key they read, the compatible surface (slice 2e) "none".
 */
export async function runOperation(handler: Handler, call: OperationCall, deps: RunnerDeps): Promise<Outcome> {
  const { operation } = handler;
  if (handler.kind === "public") {
    const read = readCall(operation, call);
    return read.ok ? ending(operation, await handler.run(read.value.input)).value : refuse({ kind: "invalid", problems: read.problems });
  }
  const { context } = call;
  if (context === undefined) {
    return refuse({ kind: "authentication-required" });
  }
  const denied = authorize(operation, context);
  if (denied !== undefined) {
    return refuse(denied);
  }
  const read = readCall(operation, call);
  if (!read.ok) {
    return refuse({ kind: "invalid", problems: read.problems });
  }
  const { input, key } = read.value;
  const settings: TransactionSettings = {
    companyId: context.companyId,
    actorId: context.actorId,
    actorKind: context.actorKind,
    channel: context.channel,
  };
  if (handler.kind === "list") {
    const scope: CursorScope = { operationId: operation.operationId, companyId: context.companyId };
    const page = pageRequest(input.query, scope, deps.cursorKey);
    if (!page.ok) {
      return refuse({ kind: "invalid", problems: page.problems });
    }
    return answered(() =>
      deps.database.read(settings, async (tx) => {
        const answer = await handler.run({ context, tx, page: page.value }, input);
        return ending(operation, answer.ok ? ok(wirePage(answer.output, scope, deps.cursorKey)) : answer);
      }),
    );
  }
  if (key !== undefined) {
    return runKeyedWrite(handler, { context, settings, input, key }, deps);
  }
  const work: Work<Outcome> = async (tx) => ending(operation, await handler.run({ context, tx }, input));
  return answered(() => (operation["x-nortfox"].writes ? deps.database.write(settings, work) : deps.database.read(settings, work)));
}
