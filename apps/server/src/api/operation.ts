// SPDX-License-Identifier: AGPL-3.0-only

// The runner: the one place that runs an operation, for every surface. REST
// and MCP call it, and from slice 2e the compatible surface too, so each rule
// holds once. A handler is a plain function of the request context and its
// typed input. It never sees Hono, a Request or a Response. It gives its
// output, or a refusal with a stable code and its facts, which each surface
// turns into its own answer: /v1 into problem details, 2e into its own
// status, envelope and message.
//
// Each kind of operation has its kind of handler:
//
// - public: reads no data. Its handler gets its input, and no context and no
//   database.
// - none: runs before there is an actor, such as a sign-in. Anyone may call
//   it. Its handler gets the database and opens its own transactions, the
//   services (the password wrapper, the install secret and the mail), the request's
//   facts, the clock, the queue for work after the answer, and the principal
//   when the request has one. It takes no idempotency key.
// - person: a signed-in person's operation. One transaction as the person,
//   in the company that its company source says: none; the credential's
//   when it names one (current); the one that a field of its input names,
//   where the one membership function gives the person's active membership,
//   in the same transaction (input); or the one it makes, whose id the
//   database layer picks (new).
// - person-list: a signed-in person's list, in no company. Its cursors are
//   the person's own.
// - data and list: an operation with a permission, in the credential's
//   company. One transaction in that company, with the clock and the
//   services, such as the install's mail.
//
// The runner's steps, in this order:
//
// 1. A public operation reads no data: its input is checked, its handler
//    runs with no context and no database, and its output is checked.
// 2. authorize: an operation that runs before sign-in passes. No actor gets
//    401. A token gets 403 session-required for an operation that serves or
//    needs a browser session, and 403 scope-missing for one whose scope it
//    lacks, whatever its person's permissions. A credential that names no
//    company gets 403 company-required for an operation in the credential's
//    company, and an actor without the operation's permission 403
//    permission-missing. Nothing of the input is read, and the database is
//    not asked. A principal whose company access the one membership function
//    did not give is a fault of the server.
// 3. The input: a list's limit by the paging rule, then the path parameters,
//    the query and the body by the operation's schemas, with the problems the
//    surface's reader found, and a write's idempotency key when the
//    operation takes one and the surface passes a key policy
//    (idempotency.ts). Any problem is one 400 with every field problem. Then
//    a list's cursor, which must be one this server made for this list and
//    company.
// 4. An operation that runs before sign-in: its handler runs, with no
//    transaction of the runner's, and its output is checked. It sees the
//    principal of a session, and none of a token's call: a token is no
//    browser's sign-in.
// 5. A write with a key: the key in flight. A running request of the actor
//    that holds the key gives 409, before the pool is asked for a connection.
//    Then a write whose handler takes a turn of its company, such as
//    inviteUser, waits for it in this process (turns.ts), still before the
//    pool is asked, and holds it until its transaction has ended.
// 6. One transaction (db/database.ts): in the credential's company for an
//    operation with a permission, as the person in the company of its source
//    for a person's operation, with the actor, its kind and the channel. A
//    company that the input names comes first. A token stays in its company:
//    a token's input that names another gets 422 company-not-available,
//    before the key is claimed and the database is asked. Where the person
//    has no active membership, also one that does not exist, the call gets
//    422 company-not-available and rolls back; but a write whose answer is
//    empty, such as leaveCompany, which its own success makes the person no
//    member of, gives the answer of its key there first, from the person's
//    keys. A read runs at REPEATABLE READ
//    READ ONLY, a write at READ COMMITTED. A write with a key looks the key
//    up first: in the company's keys; in the person's, for a write in no
//    company or in a new one; or in the person's in the company, for a write
//    whose answer holds a person's contact data, and for one that names its
//    company and answers with no body (keysFor). A write in a company reads
//    both of the company's tables of keys, so a key that another write of
//    the company used gives 422 whichever table keeps it. The same
//    request's key replays its first answer, another request's gives 422,
//    and both roll back. Then the handler runs. A read handler adds no
//    company condition of its own: row level security keeps it to the
//    transaction's company (decision 9).
// 7. Still inside the transaction: a list's next cursor is signed, and the
//    output is checked against the operation's schema. An output that does
//    not fit is a fault of the server: it throws, and nothing commits. So is
//    a cookie effect from an operation that does not serve the browser's
//    session.
// 8. A write with a key stores the key with the checked answer, and then the
//    transaction commits. So nothing commits, and no answer is stored, before
//    the output passed its check. When another process stored the key first,
//    the write rolls back, and the stored key is read in a new transaction.
//    A replay gives the stored answer and no cookie effects. A write whose
//    answer holds a secret (secretOutput) stores the answer without each
//    secret field, so no secret is stored, and its replay is 409
//    answer-shown-once with the stored answer: a secret is shown once.
// 9. A handler's refusal rolls back: a rule's refusal (422), fields that the
//    handler's own check refused (400, such as a new password that is too
//    short), too many attempts (429, with the seconds to wait), or a
//    credential that stopped naming an actor while the call ran, such as a
//    session that a logout ended at once (401 with the operation's
//    challenge, as for no actor). A refusal
//    of the ledger that is a rule a request can break, from a statement or
//    from the commit, is a rule's refusal too, with its facts
//    (ledger-refusals.ts). A password wrapper whose queue is full gives 503
//    server-busy. Any other throw rolls back and is thrown again, and the
//    surface answers 500. A refused or failed write stores no key, so a retry
//    with it runs again.
//
// The key policy is the surface's. /v1 and MCP pass the key they read for
// every write, so a write without one is 400 there. The compatible surface
// (slice 2e) will pass "none": its write runs on every call and stores no key.
//
// A handler of an operation that serves the browser's session may give
// cookie effects beside its output. The runner passes them on, and only /v1
// turns them into Set-Cookie headers. Work that a handler queues runs after
// the answer: the surface gives each call its queue (after-answer.ts).

import {
  NONE,
  PUBLIC,
  SIGNED_IN,
  bodySchema,
  challengeOf,
  effectiveLimit,
  fieldIssues,
  isCompanyInput,
  jsonPointer,
  outputSchema,
  paramsSchema,
  querySchema,
  successStatus,
  takesIdempotencyKey,
  type FieldIssue,
  type JsonValue,
  type Operation,
  type Shape,
} from "@nortfox/contract";
import { z } from "zod";
import type { CookieEffect } from "../auth/cookies.ts";
import type { InstallKey } from "../auth/install-key.ts";
import { ServerBusy, type PasswordHasher } from "../auth/password.ts";
import { commit, rollBack, type Channel, type CompanySettings, type Database, type Ending, type PersonSettings, type Queryable, type TransactionSettings, type Via } from "../db/database.ts";
import { CompanyAccess, resolveActive, type ResolvedMembership } from "../modules/memberships/resolve.ts";
import type { AfterAnswerTask } from "./after-answer.ts";
import { actorOf, isToken, type CompanyContext, type Principal, type RequestContext } from "./context.ts";
import { readCursor, signCursor, type CursorScope } from "./cursor.ts";
import {
  checkKey,
  companyKeys,
  personCompanyKeys,
  personKeys,
  requestHash,
  withoutSecrets,
  type KeyCheck,
  type KeyStore,
  type KeysInFlight,
  type StoredAnswer,
} from "./idempotency.ts";
import { ledgerRule } from "./ledger-refusals.ts";
import type { CompanyTurns, Turn } from "./turns.ts";
import type { InstallMail } from "../mail/mailer.ts";

/** A handler's refusal by a rule: a stable code, a sentence, and the field and facts when it has them. */
export interface RuleRefusal {
  readonly code: string;
  readonly detail: string;
  /** The field the refusal is about, as a JSON Pointer into the operation's input, so a screen can show it there. */
  readonly pointer?: string;
  /** The facts behind it: the value, the limit, the lock. */
  readonly data?: Readonly<Record<string, JsonValue>>;
}

/**
 * How a handler refuses: by a rule (422); for a field that its own check
 * refused, such as a new password that is too short (400); for too many
 * attempts, with the whole seconds to wait (429); or for a credential that
 * stopped naming an actor while the call ran, such as a session that a
 * logout ended at once, which the runner answers as a call with no actor
 * (401, with the operation's challenge).
 */
export type HandlerRefusal =
  | { readonly kind: "rule"; readonly refusal: RuleRefusal }
  | { readonly kind: "invalid"; readonly problems: readonly FieldIssue[] }
  | { readonly kind: "too-many-attempts"; readonly retryAfterSeconds: number }
  | { readonly kind: "credential-ended" };

/** What a handler gives: its output and, for an operation that serves the browser's session, its cookie effects; or its refusal. */
export type Answer<Output> =
  | { readonly ok: true; readonly output: Output; readonly effects?: readonly CookieEffect[] }
  | { readonly ok: false; readonly refusal: HandlerRefusal };

/** A handler's output, with the cookie effects of an operation that serves the browser's session. */
export function ok<Output>(output: Output, effects?: readonly CookieEffect[]): Answer<Output> {
  return effects === undefined ? { ok: true, output } : { ok: true, output, effects };
}

/** A handler's refusal by a rule. */
export function refused(refusal: RuleRefusal): Answer<never> {
  return { ok: false, refusal: { kind: "rule", refusal } };
}

/** A handler's refusal of fields that its own check found wrong. Each problem names its field, and none holds the value. */
export function invalidInput(problems: readonly FieldIssue[]): Answer<never> {
  return { ok: false, refusal: { kind: "invalid", problems } };
}

/** A handler's refusal of an attempt that comes too soon: the caller waits `retryAfterSeconds`, a whole number of at least 1. */
export function tooManyAttempts(retryAfterSeconds: number): Answer<never> {
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error("The seconds to wait are a whole number of at least 1.");
  }
  return { ok: false, refusal: { kind: "too-many-attempts", retryAfterSeconds } };
}

/**
 * A handler's refusal of a call whose credential stopped naming an actor
 * while it ran, such as a session that ended after the resolver read it. It
 * is no fault of the server: the runner answers it as a call with no actor.
 */
export function credentialEnded(): Answer<never> {
  return { ok: false, refusal: { kind: "credential-ended" } };
}

type ParamsOf<Op> =
  Op extends Operation<Shape | undefined, Shape | undefined, z.ZodType, infer Params>
    ? Params extends Shape
      ? z.output<Params>
      : Readonly<Record<string, never>>
    : never;
type QueryOf<Op> =
  Op extends Operation<infer Query> ? (Query extends Shape ? z.output<Query> : Readonly<Record<string, never>>) : never;
type BodyOf<Op> = Op extends Operation<Shape | undefined, infer Body> ? (Body extends Shape ? z.output<Body> : undefined) : never;

/** The output an operation answers. */
export type OutputOf<Op> = Op extends Operation<Shape | undefined, Shape | undefined, infer Output> ? z.output<Output> : never;

/** The item of a list's page. */
export type ItemOf<Op> = OutputOf<Op> extends { readonly items: readonly (infer Item)[] } ? Item : never;

/** A handler's input: its path parameters, its query and its body, as the operation's schemas parsed them. */
export interface Input<Params, Query, Body> {
  readonly params: Params;
  readonly query: Query;
  readonly body: Body;
}

export type InputOf<Op> = Input<ParamsOf<Op>, QueryOf<Op>, BodyOf<Op>>;

/** Queues work for after the answer (after-answer.ts). */
export type Later = (task: AfterAnswerTask) => void;

/**
 * What the surface knows of a request besides its input: the Origin it came
 * with, the address it came from, and the known device's token from its
 * device cookie. Only an operation that runs before sign-in reads them.
 */
export interface RequestFacts {
  readonly origin?: string;
  readonly ipAddress?: string;
  /** The value of the device cookie, when the request carries it once and in the form NortFox writes. */
  readonly device?: string;
}

/** What the server's own handlers use besides the database: the password wrapper, the install secret and the install's mail. */
export interface Services {
  /** The one wrapper of passwords (auth/password.ts). */
  readonly passwords: PasswordHasher;
  /** The install secret, which seals the TOTP secrets and keys the HMACs (auth/install-key.ts). */
  readonly installKey: InstallKey;
  /** The install's mail, or undefined when the install has none set up (mail/mailer.ts). */
  readonly mail: InstallMail | undefined;
}

/** What a handler of an operation that runs before sign-in gets besides its input. It opens its own transactions. */
export interface NoneCall {
  /** The principal, when the request carries a credential. */
  readonly principal: Principal | undefined;
  readonly database: Database;
  readonly services: Services;
  /**
   * The channel of the transactions it opens. Such an operation serves the
   * browser's session, and its MCP tool refuses every call, so only /v1 runs
   * it.
   */
  readonly channel: Channel;
  readonly request: RequestFacts;
  /** The server's clock. */
  readonly now: () => Date;
  readonly later: Later;
}

/**
 * The company a signed-in person's operation works in, by its company
 * source: none; the credential's company (current); the company that the
 * input names, where the one membership function gave the person's active
 * membership (input); or the company that the call makes (new).
 */
export type PersonCompany =
  | { readonly kind: "none" }
  | { readonly kind: "current"; readonly access: CompanyAccess }
  | { readonly kind: "input"; readonly membership: ResolvedMembership }
  | { readonly kind: "new"; readonly companyId: string };

/** The membership of a call whose input names its company, as the runner resolved it. Any other company is a fault of the server. */
export function inputMembership(company: PersonCompany): ResolvedMembership {
  if (company.kind !== "input") {
    throw new Error(`The operation takes its company from its input, and the runner gave the company ${company.kind}.`);
  }
  return company.membership;
}

/** The id of the company that a call of the company source new makes. Any other company is a fault of the server. */
export function newCompanyId(company: PersonCompany): string {
  if (company.kind !== "new") {
    throw new Error(`The operation makes its company, and the runner gave the company ${company.kind}.`);
  }
  return company.companyId;
}

/** What a handler of a signed-in person's operation gets besides its input. */
export interface PersonCall {
  readonly context: RequestContext;
  /** The request's transaction, as the person, in the company that `company` names, or in none. */
  readonly tx: Queryable;
  /** The company the call works in. */
  readonly company: PersonCompany;
  /** What the surface knows of the request: its Origin, its address and its device cookie. */
  readonly request: RequestFacts;
  /** The server's clock. */
  readonly now: () => Date;
  readonly later: Later;
}

/** What a handler of a signed-in person's list gets besides its input: the page, in the person's transaction in no company. */
export interface PersonListCall {
  readonly context: RequestContext;
  readonly tx: Queryable;
  readonly page: PageRequest;
}

/** What a handler of an operation in the credential's company gets besides its input. */
export interface DataCall {
  readonly context: CompanyContext;
  /** The request's transaction, in the company. */
  readonly tx: Queryable;
  /** The server's clock. */
  readonly now: () => Date;
  /** What the server's own handlers use besides the database, such as the install's mail. */
  readonly services: Services;
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

type AnyInput = Input<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>, unknown>;

/** The handler of a public operation: it gets its input, and no context and no database. */
export interface PublicHandler {
  readonly kind: "public";
  readonly operation: Operation;
  readonly run: (input: AnyInput) => Promise<Answer<unknown>>;
}

/** The handler of an operation that runs before sign-in. */
export interface NoneHandler {
  readonly kind: "none";
  readonly operation: Operation;
  readonly run: (call: NoneCall, input: AnyInput) => Promise<Answer<unknown>>;
}

/**
 * What a handler of a write in a company may say besides its run: the turn
 * of the company that its input makes it take (turns.ts), when it takes one
 * of the database's turns, so it waits for it before it asks the pool for a
 * connection.
 */
export interface WriteOptions<In> {
  readonly turn?: (input: In) => Turn | undefined;
}

/** The handler of a signed-in person's operation, in the person's transaction. */
export interface PersonHandler {
  readonly kind: "person";
  readonly operation: Operation;
  readonly run: (call: PersonCall, input: AnyInput) => Promise<Answer<unknown>>;
  /** The turn of the company that its input names, or of the credential's, that the call takes. */
  readonly turn?: ((input: AnyInput) => Turn | undefined) | undefined;
}

/** The handler of an operation that reads or writes data, in the request's transaction. */
export interface DataHandler {
  readonly kind: "data";
  readonly operation: Operation;
  readonly run: (call: DataCall, input: AnyInput) => Promise<Answer<unknown>>;
  /** The turn of the credential's company that the call takes. */
  readonly turn?: ((input: AnyInput) => Turn | undefined) | undefined;
}

/** The handler of a list: it reads one page in the request's transaction. */
export interface ListHandler {
  readonly kind: "list";
  readonly operation: Operation;
  readonly run: (call: ListCall, input: AnyInput) => Promise<Answer<PageResult<unknown>>>;
}

/** The handler of a signed-in person's list: it reads one page in the person's transaction, in no company. */
export interface PersonListHandler {
  readonly kind: "person-list";
  readonly operation: Operation;
  readonly run: (call: PersonListCall, input: AnyInput) => Promise<Answer<PageResult<unknown>>>;
}

/** An operation's handler, with the operation it serves. */
export type Handler = PublicHandler | NoneHandler | PersonHandler | DataHandler | ListHandler | PersonListHandler;

/** The kind of handler an operation takes, and why. */
function kindOf(operation: Operation): { readonly kind: Handler["kind"]; readonly why: string } {
  const { permission, list } = operation["x-nortfox"];
  const id = operation.operationId;
  if (permission === PUBLIC) {
    return { kind: "public", why: `${id} is public, so it takes a public handler.` };
  }
  if (permission === NONE) {
    return { kind: "none", why: `${id} runs before sign-in, so it takes a none handler.` };
  }
  if (permission === SIGNED_IN) {
    if (list && operation["x-nortfox"].company !== "none") {
      throw new Error(`${id} is a list of a signed-in person, which works in no company: its company source is "none".`);
    }
    return list
      ? { kind: "person-list", why: `${id} is a list of a signed-in person, so it takes a person-list handler.` }
      : { kind: "person", why: `${id} needs a signed-in person, so it takes a person handler.` };
  }
  return list ? { kind: "list", why: `${id} is a list, so it takes a list handler.` } : { kind: "data", why: `${id} needs a permission, so it takes a data handler.` };
}

/** Throws unless the operation takes a handler of `kind`. */
function expectKind(operation: Operation, kind: Handler["kind"]): void {
  const expected = kindOf(operation);
  if (expected.kind !== kind) {
    throw new Error(expected.why);
  }
}

// The runner gives a handler only the input that its operation's schemas
// parsed, so each helper keeps the handler's own types at its definition.

/** The handler of a public operation. */
export function handlePublic<Op extends Operation>(operation: Op, run: (input: InputOf<Op>) => Promise<Answer<OutputOf<Op>>>): PublicHandler {
  expectKind(operation, "public");
  return { kind: "public", operation, run: run as unknown as PublicHandler["run"] };
}

/** The handler of an operation that runs before sign-in. */
export function handleNone<Op extends Operation>(operation: Op, run: (call: NoneCall, input: InputOf<Op>) => Promise<Answer<OutputOf<Op>>>): NoneHandler {
  expectKind(operation, "none");
  return { kind: "none", operation, run: run as unknown as NoneHandler["run"] };
}

/** The handler of a signed-in person's operation that is not a list. */
export function handlePerson<Op extends Operation>(
  operation: Op,
  run: (call: PersonCall, input: InputOf<Op>) => Promise<Answer<OutputOf<Op>>>,
  options: WriteOptions<InputOf<Op>> = {},
): PersonHandler {
  expectKind(operation, "person");
  return { kind: "person", operation, run: run as unknown as PersonHandler["run"], turn: options.turn as PersonHandler["turn"] };
}

/** The handler of a signed-in person's list. */
export function handlePersonList<Op extends Operation>(
  operation: Op,
  run: (call: PersonListCall, input: InputOf<Op>) => Promise<Answer<PageResult<ItemOf<Op>>>>,
): PersonListHandler {
  expectKind(operation, "person-list");
  return { kind: "person-list", operation, run: run as unknown as PersonListHandler["run"] };
}

/** The handler of an operation that needs a permission and is not a list. */
export function handleData<Op extends Operation>(
  operation: Op,
  run: (call: DataCall, input: InputOf<Op>) => Promise<Answer<OutputOf<Op>>>,
  options: WriteOptions<InputOf<Op>> = {},
): DataHandler {
  expectKind(operation, "data");
  return { kind: "data", operation, run: run as unknown as DataHandler["run"], turn: options.turn as DataHandler["turn"] };
}

/** The handler of a list. */
export function handleList<Op extends Operation>(
  operation: Op,
  run: (call: ListCall, input: InputOf<Op>) => Promise<Answer<PageResult<ItemOf<Op>>>>,
): ListHandler {
  expectKind(operation, "list");
  return { kind: "list", operation, run: run as unknown as ListHandler["run"] };
}

/** Why the runner refused a call. Each surface turns it into its own answer. */
export type Refusal =
  /** No actor. The challenge names the credentials that the operation takes (RFC 9110, 11.6.1). */
  | { readonly kind: "authentication-required"; readonly challenge: string }
  /** A token's call of an operation that serves or needs a browser session. */
  | { readonly kind: "session-required" }
  /** A token whose scopes lack the operation's scope. */
  | { readonly kind: "scope-missing"; readonly scope: string }
  /** The operation works in the credential's company, and the credential names none. */
  | { readonly kind: "company-required" }
  | { readonly kind: "permission-missing"; readonly permission: string }
  | { readonly kind: "invalid"; readonly problems: readonly FieldIssue[] }
  | { readonly kind: "rule"; readonly refusal: RuleRefusal }
  /** A running request of the actor holds the idempotency key. */
  | { readonly kind: "idempotency-key-in-use" }
  /** The actor's idempotency key belongs to another request. */
  | { readonly kind: "idempotency-key-reused" }
  /** The same request came again with its key, and its first answer held a secret: `answer` is that answer without it. */
  | { readonly kind: "answer-shown-once"; readonly answer: Readonly<Record<string, unknown>> }
  /** An attempt that comes too soon after failed ones: the caller waits `retryAfterSeconds`. */
  | { readonly kind: "too-many-attempts"; readonly retryAfterSeconds: number }
  /** The server checks as many passwords as it can at once, and its queue is full. */
  | { readonly kind: "server-busy"; readonly retryAfterSeconds: number };

/**
 * The answer to a call: its success status and output, with the cookie
 * effects when the handler gave any; or its refusal. A replay gives the
 * stored status and output, and no effects.
 */
export type Outcome =
  | { readonly ok: true; readonly status: number; readonly output: unknown; readonly effects?: readonly CookieEffect[] }
  | { readonly ok: false; readonly refusal: Refusal };

/** One call of an operation, as a surface read it. */
export interface OperationCall {
  /** Who acts, or undefined when the request names no actor. */
  readonly context: RequestContext | undefined;
  readonly input: {
    /** The path parameters, by name. */
    readonly params?: Readonly<Record<string, unknown>>;
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
   * runs on every call and stores no key. A read, and a write that runs
   * before sign-in, ignore it.
   */
  readonly idempotency: { readonly key: unknown } | "none";
  /** What the surface knows of the request: none when it gives nothing. */
  readonly request?: RequestFacts;
  /** The call's queue for work after the answer. A surface that releases the work after its answer passes it. */
  readonly later?: Later;
}

export interface RunnerDeps {
  readonly database: Database;
  /** The key that signs each list's cursors. */
  readonly cursorKey: Uint8Array;
  /** The key of a write's request fingerprint, from the install secret (idempotency.ts). */
  readonly fingerprintKey: Uint8Array;
  /** The idempotency keys of the writes that run now in this process. */
  readonly keysInFlight: KeysInFlight;
  /** The turns of the companies' writes in this process (turns.ts). */
  readonly turns: CompanyTurns;
  /** The server's clock. */
  readonly now: () => Date;
  /** What the handlers of the operations that run before sign-in use. */
  readonly services: Services;
}

const MADE_ELSEWHERE = "The principal's company access was not made from the one membership function's answer (modules/memberships/resolve.ts).";

/**
 * The refusal for a principal that may not call the operation, or undefined
 * when it may. The surfaces call it before they read any part of a request.
 * An operation with a permission works in the credential's company (the
 * registry guard holds that), so a credential that names no company is
 * refused before its permissions are read.
 *
 * A token is refused, before its company and its permissions are read, an
 * operation that names no scope, which is one that serves or needs a browser
 * session (the registry guard holds that), with session-required, and an
 * operation whose scope it lacks with scope-missing. A session is not
 * limited by scopes. Anyone may call an operation that runs before sign-in,
 * so it passes for a token too, and its handler sees no token (runNone).
 *
 * A principal's company access is made only from a membership that the one
 * membership function gave (modules/memberships/resolve.ts). Any other, such
 * as a plain object, is a fault of the server: authorize throws, for every
 * operation, and the surface answers 500.
 */
export function authorize(operation: Operation, principal: Principal | undefined): Refusal | undefined {
  if (principal?.company !== undefined && !(principal.company instanceof CompanyAccess)) {
    throw new Error(MADE_ELSEWHERE);
  }
  const { permission, scope } = operation["x-nortfox"];
  if (permission === PUBLIC || permission === NONE) {
    return undefined;
  }
  if (principal === undefined) {
    return { kind: "authentication-required", challenge: challengeOf(operation) };
  }
  const { credential } = principal;
  if (isToken(credential)) {
    if (scope === null) {
      return { kind: "session-required" };
    }
    if (!credential.scopes.has(scope)) {
      return { kind: "scope-missing", scope };
    }
  }
  if (permission === SIGNED_IN) {
    return undefined;
  }
  const { company } = principal;
  if (company === undefined) {
    return { kind: "company-required" };
  }
  return company.permissions.includes(permission) ? undefined : { kind: "permission-missing", permission };
}

function refuse(refusal: Refusal): Outcome {
  return { ok: false, refusal };
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly FieldIssue[] };

/** An operation that takes no path parameters or no query refuses every one. */
const NOTHING = z.strictObject({});

function parse(schema: z.ZodType, value: unknown): Checked<unknown> {
  const result = schema.safeParse(value, { reportInput: true });
  return result.success ? { ok: true, value: result.data } : { ok: false, problems: fieldIssues(result.error.issues) };
}

/** A call's input after its checks: the input as the operation's schemas parsed it, and a write's key when it takes one. */
interface ReadCall {
  readonly input: AnyInput;
  readonly key: string | undefined;
}

/**
 * The input as the operation's schemas parse it, with a list's limit by the
 * paging rule, and a write's idempotency key when the operation takes one
 * and the surface passed a key policy. The problems come in the order of the
 * flat input: the reader's, the path's, the query's, the body's, the key's.
 */
function readCall(operation: Operation, call: OperationCall): Checked<ReadCall> {
  const { input, idempotency } = call;
  const params = parse(paramsSchema(operation) ?? NOTHING, input.params ?? {});
  const raw = operation["x-nortfox"].list ? { ...input.query, limit: effectiveLimit(input.query["limit"]) } : input.query;
  const query = parse(querySchema(operation) ?? NOTHING, raw);
  const bodyShape = bodySchema(operation);
  const body = bodyShape === undefined ? ({ ok: true, value: undefined } as const) : parse(bodyShape, input.body);
  const key: KeyCheck | undefined = takesIdempotencyKey(operation) && idempotency !== "none" ? checkKey(idempotency.key) : undefined;
  const problems = [
    ...(input.problems ?? []),
    ...(params.ok ? [] : params.problems),
    ...(query.ok ? [] : query.problems),
    ...(body.ok ? [] : body.problems),
    ...(key?.ok === false ? key.problems : []),
  ];
  if (!params.ok || !query.ok || !body.ok || key?.ok === false || problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    value: { input: { params: params.value as AnyInput["params"], query: query.value as AnyInput["query"], body: body.value }, key: key?.value },
  };
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

/** A handler's output as the runner answers it: the success status, the checked output, and the cookie effects of an operation that serves the browser's session. */
function success(operation: Operation, answer: { readonly output: unknown; readonly effects?: readonly CookieEffect[] }): Outcome {
  const { effects } = answer;
  if (effects !== undefined && operation["x-nortfox"].session !== "flow") {
    throw new Error(`${operation.operationId} gave cookie effects, which only an operation that serves the browser's session may give.`);
  }
  const output = checkedOutput(operation, answer.output);
  const status = successStatus(operation);
  return effects === undefined ? { ok: true, status, output } : { ok: true, status, output, effects };
}

/** A rule's refusal as the runner's. */
function ruleOf(refusal: RuleRefusal): Outcome {
  return refuse({ kind: "rule", refusal });
}

/** A handler's refusal as the runner's: a credential that ended is a call with no actor, with the operation's challenge. */
function refusedBy(operation: Operation, refusal: HandlerRefusal): Outcome {
  return refuse(refusal.kind === "credential-ended" ? { kind: "authentication-required", challenge: challengeOf(operation) } : refusal);
}

/** How a handler's answer ends its transaction: a refusal rolls back; an output is checked, then commits. */
function ending(operation: Operation, answer: Answer<unknown>): Ending<Outcome> {
  return answer.ok ? commit(success(operation, answer)) : rollBack(refusedBy(operation, answer.refusal));
}

/** A handler's page as the wire holds it: the next page's sort key becomes a signed cursor. */
function wirePage(page: PageResult<unknown>, scope: CursorScope, key: Uint8Array): unknown {
  const { items, total, next } = page;
  return next === undefined ? { items, total } : { items, total, nextCursor: signCursor(key, scope, next) };
}

/** The names of an operation's flat input: its path parameters, its query's fields and its body's. */
function inputFields(operation: Operation): string[] {
  return [paramsSchema(operation), querySchema(operation), bodySchema(operation)].flatMap((schema) => (schema === undefined ? [] : Object.keys(schema.shape)));
}

/**
 * Runs a transaction of `operation`, and gives a refusal of the ledger that
 * is a rule a request can break as the rule's refusal, with the field's
 * pointer for a unique violation of a field that the input names. A password
 * wrapper whose queue is full gives server-busy. Every other error is thrown
 * again.
 */
async function answered<T>(operation: Operation, transaction: () => Promise<T>): Promise<T | Outcome> {
  try {
    return await transaction();
  } catch (error) {
    if (error instanceof ServerBusy) {
      return refuse({ kind: "server-busy", retryAfterSeconds: error.retryAfterSeconds });
    }
    const rule = ledgerRule(error, inputFields(operation));
    if (rule === undefined) {
      throw error;
    }
    return ruleOf(rule);
  }
}

/**
 * The stored answer of a key: the first answer again for the same request,
 * or 409 answer-shown-once with the stored answer when the first held a
 * secret, which was stored without it; 422 for another request.
 */
function replay(operation: Operation, stored: StoredAnswer, hash: string): Outcome {
  if (stored.hash !== hash) {
    return refuse({ kind: "idempotency-key-reused" });
  }
  if (operation["x-nortfox"].secretOutput.length > 0) {
    return refuse({ kind: "answer-shown-once", answer: stored.body as Readonly<Record<string, unknown>> });
  }
  return { ok: true, status: stored.status, output: stored.body };
}

/** Marks a write whose key another process stored first, while this write ran. */
const STORED_FIRST_ELSEWHERE = Symbol("stored first elsewhere");

/** A read, or a write. */
type Mode = "read" | "write";

/** The handler's run in a call's transaction, once the transaction works in the call's company. */
type Run = () => Promise<Answer<unknown>>;

/**
 * How a call's transactions open: each sets the call's company, the
 * credential's, the one the input names or a new one, and then runs `work`
 * with the transaction and the handler's run in it. When the company cannot
 * be set, as for a company the input names where the person is no active
 * member, the transaction rolls back and gives that refusal instead, or what
 * `unavailable` gives in that transaction, before any company is set: a
 * keyed write's stored answer (runKeyedWrite).
 */
type Frame = <T>(mode: Mode, work: (tx: Queryable, run: Run) => Promise<Ending<T>>, unavailable?: (tx: Queryable) => Promise<Outcome | undefined>) => Promise<T | Outcome>;

/** The frame of transactions whose settings name their company, or none. */
function settingsFrame(settings: TransactionSettings, run: (tx: Queryable) => Promise<Answer<unknown>>, deps: RunnerDeps): Frame {
  return (mode, work) => (mode === "write" ? deps.database.write(settings, (tx) => work(tx, () => run(tx))) : deps.database.read(settings, (tx) => work(tx, () => run(tx))));
}

/**
 * The frame of a call whose handler takes a turn of `companyId` for its
 * input (turns.ts): each transaction waits for the turn in this process
 * before it asks the pool for a connection, and lets it go when it has
 * ended. A call that takes no turn keeps its frame.
 */
function inTurn(turn: Turn | undefined, companyId: string, frame: Frame, deps: RunnerDeps): Frame {
  if (turn === undefined) {
    return frame;
  }
  return async <T>(mode: Mode, work: (tx: Queryable, run: Run) => Promise<Ending<T>>, unavailable?: (tx: Queryable) => Promise<Outcome | undefined>) => {
    const release = await deps.turns.take(companyId, turn);
    try {
      return await frame(mode, work, unavailable);
    } finally {
      release();
    }
  };
}

/** What a keyed write needs besides its work. */
interface KeyedWrite {
  readonly operation: Operation;
  readonly actorId: string;
  readonly input: AnyInput;
  readonly key: string;
  /** Where the write keeps its key. */
  readonly store: KeyStore;
  /** The company's other table of keys, for a write in a company: its lookup there reads it too, so one key never serves two writes of the company. */
  readonly other?: KeyStore | undefined;
  /** The token or client of a person's own write that came through one: its fingerprint holds it, so no other credential of the person replays its answer. */
  readonly via?: Via | undefined;
  /** Opens the write's transactions. */
  readonly frame: Frame;
}

/**
 * Whether a keyed write gives its stored answer also where the person no
 * longer reaches the company that its input names: a write whose answer is
 * empty, such as leaveCompany's, which its own success makes the person no
 * member of. Its answer tells nothing of the company, and its key is kept
 * with the person (keysFor). A write whose answer holds the company's data
 * is refused there, as any call that names the company is.
 */
function replaysWhereUnavailable(operation: Operation): boolean {
  return isCompanyInput(operation["x-nortfox"].company) && [202, 204].includes(successStatus(operation));
}

/**
 * A write with an idempotency key (idempotency.ts): the key in flight, then
 * one write transaction that sets the call's company, looks the key up, runs
 * the handler, checks the output and stores the key with the answer before
 * it commits.
 */
async function runKeyedWrite(write: KeyedWrite, deps: RunnerDeps): Promise<Outcome> {
  const { operation, actorId, input, key, store, other, via, frame } = write;
  const release = deps.keysInFlight.claim(store.scope, actorId, key);
  if (release === undefined) {
    return refuse({ kind: "idempotency-key-in-use" });
  }
  try {
    const params = paramsSchema(operation) === undefined ? undefined : input.params;
    const hash = requestHash(deps.fingerprintKey, operation.operationId, input.query, input.body, params, via);
    // The write's own table; in a company, the other table too. Where the person no longer reaches the company, the own table alone.
    const storedAnswer = async (tx: Queryable, everywhere = true): Promise<Outcome | undefined> => {
      const stored = (await store.find(tx, actorId, key)) ?? (everywhere && other !== undefined ? await other.find(tx, actorId, key) : undefined);
      return stored === undefined ? undefined : replay(operation, stored, hash);
    };
    const first = await answered(operation, () =>
      frame(
        "write",
        async (tx, run): Promise<Ending<Outcome | typeof STORED_FIRST_ELSEWHERE>> => {
          const stored = await storedAnswer(tx);
          if (stored !== undefined) {
            return rollBack(stored);
          }
          const answer = await run();
          if (!answer.ok) {
            return rollBack(refusedBy(operation, answer.refusal));
          }
          const outcome = success(operation, answer) as Extract<Outcome, { readonly ok: true }>;
          // The answer is kept without its secrets: the first call alone gives them.
          const body = withoutSecrets(outcome.output, operation["x-nortfox"].secretOutput);
          const kept = await store.store(tx, { key, operationId: operation.operationId, hash, status: outcome.status, body });
          return kept ? commit(outcome) : rollBack(STORED_FIRST_ELSEWHERE);
        },
        replaysWhereUnavailable(operation) ? (tx) => storedAnswer(tx, false) : undefined,
      ),
    );
    if (first !== STORED_FIRST_ELSEWHERE) {
      return first;
    }
    return await frame("read", async (tx) => {
      const stored = await store.find(tx, actorId, key);
      if (stored === undefined) {
        throw new Error(`Another transaction stored the idempotency key ${key} first, and it is not there.`);
      }
      return commit(replay(operation, stored, hash));
    });
  } finally {
    release();
  }
}

/** Where a keyed write keeps its key, and the company's other table of keys, which its lookup reads too. */
interface KeyStores {
  readonly store: KeyStore;
  readonly other?: KeyStore;
}

/**
 * Where a write in a company keeps its key: in the company's keys, unless
 * its answer holds a person's contact data (personalOutput), whose key is
 * kept outside every company table, so the answer never reaches the
 * company's history; or unless it gives its answer again where the person
 * no longer reaches the company (replaysWhereUnavailable), whose key the
 * person reads without entering the company. Those two keep it with the
 * person, in the company. Either way the other table is the write's other,
 * so a key is one write's in the company, whichever table keeps it. A write
 * in no company, or in a company it makes, keeps its key per person
 * (personKeys).
 */
function keysFor(operation: Operation, companyId: string): KeyStores {
  const company = companyKeys(companyId);
  const person = personCompanyKeys(companyId);
  return operation["x-nortfox"].personalOutput.length > 0 || replaysWhereUnavailable(operation) ? { store: person, other: company } : { store: company, other: person };
}

/** Runs a call in its frame: a keyed write, or one transaction, a write for an operation that writes and a read for any other. */
function runFramed(operation: Operation, frame: Frame, keyed: Omit<KeyedWrite, "operation" | "frame"> | undefined, deps: RunnerDeps): Promise<Outcome> {
  if (keyed !== undefined) {
    return runKeyedWrite({ ...keyed, operation, frame }, deps);
  }
  return answered(operation, () => frame(operation["x-nortfox"].writes ? "write" : "read", async (_tx, run) => ending(operation, await run())));
}

/** The queue of a call whose surface gave none: work after the answer is then a fault of the server. */
function noQueue(): never {
  throw new Error("The surface gave this call no queue for work after its answer.");
}

/** The context of a signed-in person's operation. authorize has refused a call without one. */
function personContext(operation: Operation, context: RequestContext | undefined): RequestContext {
  if (context === undefined) {
    throw new Error(`${operation.operationId} needs a signed-in person, and the call names none.`);
  }
  return context;
}

/** The context of an operation in the credential's company. authorize has refused a call without one. */
function companyContext(operation: Operation, context: RequestContext | undefined): CompanyContext {
  const company = context?.company;
  if (context === undefined || company === undefined) {
    throw new Error(`${operation.operationId} works in the credential's company, and the call names none.`);
  }
  return { ...context, company };
}

/**
 * Runs an operation that runs before sign-in: its handler opens its own
 * transactions. It gets the principal of a session, and none of a token's
 * call, which is no browser's: so a token links nothing to an invitation.
 */
async function runNone(handler: NoneHandler, call: OperationCall, input: AnyInput, later: Later, deps: RunnerDeps): Promise<Outcome> {
  const { context } = call;
  const noneCall: NoneCall = {
    principal: context === undefined || isToken(context.credential) ? undefined : context,
    database: deps.database,
    services: deps.services,
    channel: "rest",
    request: call.request ?? {},
    now: deps.now,
    later,
  };
  return answered(handler.operation, async () => {
    const answer = await handler.run(noneCall, input);
    return answer.ok ? success(handler.operation, answer) : refusedBy(handler.operation, answer.refusal);
  });
}

/** A company id in the form the database takes: a uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value of the input's field that names the company: a path parameter, a query field or a field of the body. */
function inputValue(input: AnyInput, field: string): unknown {
  const body = typeof input.body === "object" && input.body !== null ? (input.body as Readonly<Record<string, unknown>>) : {};
  return input.params[field] ?? input.query[field] ?? body[field];
}

/** The refusal of a company that the input's `field` names, where the person is no active member: the same for one that does not exist. */
function notAvailable(field: string): RuleRefusal {
  return {
    code: "company-not-available",
    detail: `The person is no active member of the company that ${field} names, or it does not exist.`,
    pointer: jsonPointer([field]),
  };
}

/**
 * The runner's refusal of a company that the input names, as a handler of
 * the operation gives it: for a membership that stopped being active while
 * the call ran, such as one removed by a change that committed first. An
 * operation whose input names no company is a fault of the server.
 */
export function companyNotAvailable(operation: Operation): Answer<never> {
  const source = operation["x-nortfox"].company;
  if (!isCompanyInput(source)) {
    throw new Error(`${operation.operationId} takes no company from its input.`);
  }
  return refused(notAvailable(source.input));
}

/**
 * The frame of a call whose input names its company: a person's
 * transaction, in which the one membership function gives the person's
 * active membership there, and the transaction enters its company. A company
 * where the person has none, also one that does not exist, gives the same
 * refusal, before the company's key is looked up and before the handler
 * runs; but a write that replays there gives the answer that the person's
 * key holds (replaysWhereUnavailable), read before any company is set.
 */
function inputFrame(settings: PersonSettings, field: string, companyId: unknown, run: (tx: Queryable, membership: ResolvedMembership) => Promise<Answer<unknown>>, deps: RunnerDeps): Frame {
  return <T>(mode: Mode, work: (tx: Queryable, run: Run) => Promise<Ending<T>>, unavailable?: (tx: Queryable) => Promise<Outcome | undefined>) =>
    deps.database.person(mode, settings, async (tx): Promise<Ending<T | Outcome>> => {
      const named = typeof companyId === "string" && UUID.test(companyId);
      const membership = named ? await resolveActive(tx, companyId) : undefined;
      if (membership === undefined) {
        const kept = named && unavailable !== undefined ? await unavailable(tx) : undefined;
        return rollBack(kept ?? ruleOf(notAvailable(field)));
      }
      await tx.enter(membership);
      return work(tx, () => run(tx, membership));
    });
}

/**
 * Whether a call may name `companyId` in its input: any company for a
 * session, which the one membership function then answers, and only the
 * token's own company for a token, in any letter case. A token stays in its
 * company: another of its person's gets the answer of a company that does
 * not exist, before the database is asked (plan 2.3).
 */
function inTokenCompany(context: RequestContext, companyId: unknown): boolean {
  return !isToken(context.credential) || String(companyId).toLowerCase() === context.company?.companyId.toLowerCase();
}

/** The frame of a call that makes its company: a person's transaction, in which the handler runs in the new company, whose id the database layer picks. */
function newCompanyFrame(settings: PersonSettings, run: (tx: Queryable, companyId: string) => Promise<Answer<unknown>>, deps: RunnerDeps): Frame {
  return (mode, work) => deps.database.person(mode, settings, (tx) => work(tx, () => tx.inNewCompany((companyId) => run(tx, companyId))));
}

/**
 * Runs a signed-in person's operation in one transaction as the person, in
 * the company that its company source says: none; the credential's
 * (current); the one its input names (input); or the one it makes (new).
 * A write's key is kept per person in no company and in a new company, and
 * in a company as keysFor says. A person's own key of a call through a token
 * names the token in the fingerprint: such a key belongs to no company, so
 * the token's company does not keep it apart from the person's other
 * credentials, and a token never replays what they stored.
 */
function runPerson(handler: PersonHandler, context: RequestContext, read: ReadCall, later: Later, request: RequestFacts, deps: RunnerDeps): Promise<Outcome> {
  const { operation } = handler;
  const { input, key } = read;
  const source = operation["x-nortfox"].company;
  const person: PersonSettings = { ...actorOf(context), channel: context.channel };
  const runIn = (tx: Queryable, company: PersonCompany): Promise<Answer<unknown>> => handler.run({ context, tx, company, request, now: deps.now, later }, input);
  const keyed = (stores: KeyStores, via?: Via): Omit<KeyedWrite, "operation" | "frame"> | undefined =>
    key === undefined ? undefined : { actorId: context.personId, input, key, ...stores, via };
  // A person's own keys, which belong to no company: the call's token is in the fingerprint.
  const ownKeys = (): Omit<KeyedWrite, "operation" | "frame"> | undefined => keyed({ store: personKeys }, context.via);
  if (isCompanyInput(source)) {
    const companyId = inputValue(input, source.input);
    if (!inTokenCompany(context, companyId)) {
      return Promise.resolve(ruleOf(notAvailable(source.input)));
    }
    const frame = inputFrame(person, source.input, companyId, (tx, membership) => runIn(tx, { kind: "input", membership }), deps);
    // The company's id in lower case, as a credential's is, so one company has one turn. The turn comes before the membership's check, which ends a call where the person has none at once, so such a call holds it only that long.
    return runFramed(operation, inTurn(handler.turn?.(input), String(companyId).toLowerCase(), frame, deps), keyed(keysFor(operation, String(companyId))), deps);
  }
  if (source === "new") {
    return runFramed(operation, newCompanyFrame(person, (tx, companyId) => runIn(tx, { kind: "new", companyId }), deps), ownKeys(), deps);
  }
  const access = source === "current" ? context.company : undefined;
  if (access !== undefined) {
    const settings: CompanySettings = { ...person, company: access };
    const frame = inTurn(handler.turn?.(input), access.companyId, settingsFrame(settings, (tx) => runIn(tx, { kind: "current", access }), deps), deps);
    return runFramed(operation, frame, keyed(keysFor(operation, access.companyId)), deps);
  }
  return runFramed(operation, settingsFrame(person, (tx) => runIn(tx, { kind: "none" }), deps), ownKeys(), deps);
}

/**
 * Runs a signed-in person's list: one page, in a read as the person in no
 * company. Its cursor belongs to the person, so another person's is refused.
 */
function runPersonList(handler: PersonListHandler, context: RequestContext, input: AnyInput, deps: RunnerDeps): Promise<Outcome> {
  const { operation } = handler;
  const scope: CursorScope = { operationId: operation.operationId, companyId: "", personId: context.personId };
  const page = pageRequest(input.query, scope, deps.cursorKey);
  if (!page.ok) {
    return Promise.resolve(refuse({ kind: "invalid", problems: page.problems }));
  }
  const settings: PersonSettings = { ...actorOf(context), channel: context.channel };
  const listed = async (tx: Queryable): Promise<Answer<unknown>> => {
    const answer = await handler.run({ context, tx, page: page.value }, input);
    return answer.ok ? ok(wirePage(answer.output, scope, deps.cursorKey)) : answer;
  };
  return runFramed(operation, settingsFrame(settings, listed, deps), undefined, deps);
}

/** Runs an operation in the credential's company, in one transaction there. */
function runData(handler: DataHandler | ListHandler, context: CompanyContext, read: ReadCall, deps: RunnerDeps): Promise<Outcome> {
  const { operation } = handler;
  const { input, key } = read;
  const settings: TransactionSettings = { company: context.company, ...actorOf(context), channel: context.channel };
  if (handler.kind === "list") {
    const scope: CursorScope = { operationId: operation.operationId, companyId: context.company.companyId };
    const page = pageRequest(input.query, scope, deps.cursorKey);
    if (!page.ok) {
      return Promise.resolve(refuse({ kind: "invalid", problems: page.problems }));
    }
    const listed = async (tx: Queryable): Promise<Answer<unknown>> => {
      const answer = await handler.run({ context, tx, now: deps.now, services: deps.services, page: page.value }, input);
      return answer.ok ? ok(wirePage(answer.output, scope, deps.cursorKey)) : answer;
    };
    return runFramed(operation, settingsFrame(settings, listed, deps), undefined, deps);
  }
  const frame = inTurn(handler.turn?.(input), context.company.companyId, settingsFrame(settings, (tx) => handler.run({ context, tx, now: deps.now, services: deps.services }, input), deps), deps);
  const keyed = key === undefined ? undefined : { actorId: context.personId, input, key, ...keysFor(operation, context.company.companyId) };
  return runFramed(operation, frame, keyed, deps);
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
  const denied = authorize(operation, context);
  if (denied !== undefined) {
    return refuse(denied);
  }
  const read = readCall(operation, call);
  if (!read.ok) {
    return refuse({ kind: "invalid", problems: read.problems });
  }
  const later = call.later ?? noQueue;
  switch (handler.kind) {
    case "none":
      return runNone(handler, call, read.value.input, later, deps);
    case "person":
      return runPerson(handler, personContext(operation, context), read.value, later, call.request ?? {}, deps);
    case "person-list":
      return runPersonList(handler, personContext(operation, context), read.value.input, deps);
    case "data":
    case "list":
      return runData(handler, companyContext(operation, context), read.value, deps);
  }
}
