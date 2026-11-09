// SPDX-License-Identifier: AGPL-3.0-only

// What the API tests share: a resolver that maps a bearer token to a
// principal, the test-only write and list, a database that fails a test when
// it is asked, a pool as the app role, and an app builder that checks the /v1
// routes as startServer does. The test-only operations live here, outside
// src, so no build holds them and openapi.json never shows them.

import { randomUUID } from "node:crypto";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Money, PERMISSIONS, REGISTRY, defineListOperation, defineOperation, moneyToOre, oreToMoney, type AdminLevel, type Operation } from "@nortfox/contract";
import type { Client, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";
import { z } from "zod";
import type { CompanyAccess, ContextResolver, Principal, PrincipalKind } from "../src/api/context.ts";
import { KeysInFlight } from "../src/api/idempotency.ts";
import { handleData, handleList, ok, refused, type Handler, type OutputOf, type RunnerDeps, type Services } from "../src/api/operation.ts";
import { assertV1Routes } from "../src/api/route-guard.ts";
import { createApp, type AppOptions, type ServerApp } from "../src/app.ts";
import { InstallKey } from "../src/auth/install-key.ts";
import { PasswordHasher, type PasswordCost } from "../src/auth/password.ts";
import { connectionConfig } from "../src/db/connect.ts";
import { databaseOver, type Database, type Queryable } from "../src/db/database.ts";
import { serverHandlers } from "../src/handlers.ts";
import { resolveActive, type MembershipRow, type ResolvedMembership } from "../src/modules/memberships/resolve.ts";
import { urlOf } from "./cluster.ts";
import { inTransaction, type TestDatabase } from "./database.ts";
import { expectNoTokens } from "./secrets.ts";

/** The permissions of the test-only operations. */
export const TEST_PERMISSIONS = ["test:read", "test:write"] as const;

/** Every permission an operation of the test app can need. */
export const ALL_PERMISSIONS: readonly string[] = [...Object.keys(PERMISSIONS), ...TEST_PERMISSIONS];

/** The version the test app reports. */
export const TEST_VERSION = "0.0.0-test";

/** A fixed key for the cursors of the test app. */
export const CURSOR_KEY = new Uint8Array(32).fill(7);

/** The test app's install secret: key id 9, and made-up bytes that no install holds. */
export const TEST_INSTALL_KEY = new InstallKey(9, Buffer.from("the made-up install secret of the test app, which no install holds", "utf8"));

/** The key of the test app's request fingerprints, from its install secret. */
export const FINGERPRINT_KEY = TEST_INSTALL_KEY.key("idempotency-fingerprint v1");

/**
 * A small cost of Argon2id, for the tests that only need some password: the
 * least memory of one lane, and one pass. The production cost has its own
 * tests (auth/password.test.ts, modules/auth/login.db.test.ts).
 */
export const TEST_PASSWORD_COST: PasswordCost = { memory: 64, passes: 1, parallelism: 1 };

/** The password wrapper at the small cost of the tests. */
export function testPasswords(options: { readonly concurrency?: number } = {}): PasswordHasher {
  return new PasswordHasher({ cost: TEST_PASSWORD_COST, ...options });
}

/** An account as the test-only list gives it. */
export const TestAccount = z.strictObject({
  id: z.uuid().meta({ description: "The account's id." }),
  number: z.int().meta({ description: "The account's number." }),
  description: z.string().meta({ description: "The account's name." }),
});

/** A list of the company's accounts, ordered by id, only for the tests. */
export const testListAccounts = defineListOperation({
  id: "testListAccounts",
  method: "get",
  path: "/v1/test-accounts",
  tags: ["test"],
  summary: "List the accounts",
  description: "Lists the company's accounts, ordered by id. Only the tests serve it.",
  item: TestAccount,
  permission: "test:read",
  tool: "Lists the accounts of the company you work in. Only the tests serve it.",
});

/**
 * Reads a page of accounts with no company condition of its own: row level
 * security keeps it to the transaction's company (decision 9).
 */
export const testListAccountsHandler = handleList(testListAccounts, async ({ tx, page }) => {
  const after = page.after?.[0] ?? null;
  const found = await tx.query<{ id: string; number: number; description: string }>(
    "SELECT id, number, description FROM ledger.accounts WHERE $1::uuid IS NULL OR id > $1::uuid ORDER BY id LIMIT $2",
    [after, page.limit + 1],
  );
  const counted = await tx.query<{ total: bigint }>("SELECT count(*) AS total FROM ledger.accounts");
  const items = found.rows.slice(0, page.limit);
  const last = items.at(-1);
  const total = Number(counted.rows[0]?.total ?? 0n);
  return ok(found.rows.length > page.limit && last !== undefined ? { items, total, next: [last.id] } : { items, total });
});

/** What the test-only write takes: a description and one amount. */
export const TestVoucherInput = z.strictObject({
  description: z.string().min(1).max(200).meta({ description: "The voucher's description." }),
  amount: Money,
});

/** The voucher the test-only write booked. */
export const TestVoucher = z.strictObject({
  id: z.uuid().meta({ description: "The voucher's id." }),
  number: z.int().meta({ description: "The voucher's number in series A." }),
  amount: Money,
});

/** A write that books one voucher, only for the tests. */
export const testBookVoucher = defineOperation({
  id: "testBookVoucher",
  method: "post",
  path: "/v1/test-vouchers",
  tags: ["test"],
  summary: "Book a voucher",
  description: "Books a voucher of one amount on 2090-03-15, debit 6110 and credit 1930, in series A. Only the tests serve it.",
  body: TestVoucherInput,
  output: TestVoucher,
  status: 201,
  permission: "test:write",
  tool: "Books a voucher of one amount in the company you work in. Only the tests serve it.",
  writes: true,
});

/** The date the test-only write books on: inside the year that addBooks makes. */
export const BOOKING_DATE = "2090-03-15";

/** Holds a booking after it booked, until the test opens it. */
export interface Gate {
  /** Resolves once a booking waits at the gate. */
  readonly reached: Promise<void>;
  /** Lets the waiting booking go on. */
  open(): void;
  /** What the booking calls: it waits here until the gate opens. */
  pass(): Promise<void>;
}

export function gate(): Gate {
  const reached = Promise.withResolvers<undefined>();
  const opened = Promise.withResolvers<undefined>();
  return {
    reached: reached.promise,
    open: () => {
      opened.resolve(undefined);
    },
    pass: () => {
      reached.resolve(undefined);
      return opened.promise;
    },
  };
}

/**
 * What a test makes the next booking do after it booked, each once: throw,
 * wait at a gate, or answer an output that does not fit its schema.
 */
export interface BookingControls {
  failOnce: boolean;
  badOutput: boolean;
  gate: Gate | undefined;
}

export function bookingControls(): BookingControls {
  return { failOnce: false, badOutput: false, gate: undefined };
}

/** Waits until the request `running` waits at `held`, and fails at once when the request ends first. */
export async function untilAtGate(held: Gate, running: Promise<unknown>): Promise<void> {
  await Promise.race([
    held.reached,
    running.then((ended) => {
      const answer = ended instanceof Response ? String(ended.status) : JSON.stringify(ended);
      throw new Error(`The request ended with ${answer} before it reached the gate.`);
    }),
  ]);
}

/**
 * Books a voucher in the request's transaction. Its one rule of its own: an
 * amount of zero or less is refused, at /amount. The database's rules hold
 * the rest, such as the period lock.
 */
export function testBookVoucherHandler(controls: BookingControls = bookingControls()): Handler {
  return handleData(testBookVoucher, async ({ context: { company }, tx }, { body }) => {
    const amount = moneyToOre(body.amount);
    if (amount <= 0n) {
      return refused({
        code: "amount-not-positive",
        detail: "The field /amount must be more than zero.",
        pointer: "/amount",
        data: { amount: oreToMoney(amount, "SEK") },
      });
    }
    const vouchers = await tx.query<{ id: string; number: number }>(
      `INSERT INTO ledger.vouchers (company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
       SELECT $1, id, 'A', $2, $3, 'MANUAL' FROM ledger.fiscal_years WHERE $3::date BETWEEN from_date AND to_date
       RETURNING id, number`,
      [company.companyId, body.description, BOOKING_DATE],
    );
    const [voucher] = vouchers.rows;
    if (voucher === undefined) {
      throw new Error("The company has no fiscal year on the booking date.");
    }
    const debit = await tx.query<{ debit: bigint }>(
      "INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, debit) VALUES ($1, $2, 6110, $3) RETURNING debit",
      [company.companyId, voucher.id, amount],
    );
    await tx.query("INSERT INTO ledger.voucher_rows (company_id, voucher_id, account_number, credit) VALUES ($1, $2, 1930, $3)", [
      company.companyId,
      voucher.id,
      amount,
    ]);
    const waiting = controls.gate;
    controls.gate = undefined;
    await waiting?.pass();
    if (controls.failOnce) {
      controls.failOnce = false;
      throw new Error("The test made the booking fail after it booked.");
    }
    const booked = { id: voucher.id, number: voucher.number, amount: oreToMoney(debit.rows[0]?.debit ?? 0n, "SEK") };
    if (controls.badOutput) {
      controls.badOutput = false;
      return ok({ ...booked, amount: 125 } as unknown as OutputOf<typeof testBookVoucher>);
    }
    return ok(booked);
  });
}

/** The registry of the test app: the real operations and the test-only ones. */
export const TEST_REGISTRY: readonly Operation[] = [...REGISTRY, testBookVoucher, testListAccounts];

/** The handlers of the test app, with the controls of its bookings. */
export function testHandlers(controls: BookingControls = bookingControls(), version = TEST_VERSION): Handler[] {
  return [...serverHandlers(version), testBookVoucherHandler(controls), testListAccountsHandler];
}

/** The services of a handler that a test calls directly: the passwords at the tests' small cost, the test install key, and no mail. */
export function testServices(): Services {
  return { passwords: testPasswords(), installKey: TEST_INSTALL_KEY, mail: undefined };
}

/** The clock of the runner in a test that calls it directly. */
export const TEST_NOW = new Date("2090-03-15T10:00:00.000Z");

/** What the runner needs, for a test that calls it directly: the database, the cursor key, the fingerprint key, a set of keys in flight of its own and a fixed clock. */
export function runnerDeps(database: Database): RunnerDeps {
  return {
    database,
    cursorKey: CURSOR_KEY,
    fingerprintKey: FINGERPRINT_KEY,
    keysInFlight: new KeysInFlight(),
    now: () => TEST_NOW,
    services: testServices(),
  };
}

/** Who a test principal is: its person, its kind and, in a company, its permissions. */
export interface PrincipalOptions {
  readonly personId?: string;
  readonly kind?: PrincipalKind;
  readonly permissions?: readonly string[];
}

/**
 * A signed-in person with no company: a user, unless the options say
 * otherwise. Its credential is a session that only the test knows; the
 * test's resolver hands it out for a bearer token.
 */
export function personOf(options: Omit<PrincipalOptions, "permissions"> = {}): Principal {
  return {
    personId: options.personId ?? randomUUID(),
    actorKind: options.kind ?? "user",
    credential: { kind: "session", sessionId: randomUUID(), method: "password-email", identifiedAt: new Date("2090-03-15T09:00:00.000Z") },
  };
}

/**
 * A membership of `personId` in `companyId`, as resolve.ts makes it from a
 * row of the one membership function. The row is made up, and the
 * transaction that gives it answers every query with it, so a runner test
 * gets a principal in a company without asking PostgreSQL. Such a
 * membership enters no real transaction: tx.enter takes only one that the
 * function gave in that transaction.
 */
export async function testMembership(companyId: string, personId: string, adminLevel: AdminLevel | null = null): Promise<ResolvedMembership> {
  const row: MembershipRow = {
    membership_id: randomUUID(),
    company_id: companyId,
    status: "active",
    admin_level: adminLevel,
    idle_timeout_minutes: 120,
    company_name: "Testbolaget Alfa AB",
    organization_number: "556000-0167",
    database_number: 1,
    person_id: personId,
  };
  const answering: Queryable = { query: <Row extends QueryResultRow>() => Promise.resolve({ rows: [row] } as unknown as QueryResult<Row>) };
  const membership = await resolveActive(answering, companyId);
  if (membership === undefined) {
    throw new Error("resolve.ts made no membership of the row.");
  }
  return membership;
}

/**
 * A principal in `companyId`: an integration with every permission, unless
 * the options say otherwise. Its company access is made from a membership
 * that resolve.ts made (testMembership), as the resolver makes it.
 */
export async function principalOf(companyId: string, options: PrincipalOptions = {}): Promise<Principal & { readonly company: CompanyAccess }> {
  const person = personOf({ kind: options.kind ?? "integration", ...(options.personId === undefined ? {} : { personId: options.personId }) });
  const membership = await testMembership(companyId, person.personId);
  return { ...person, company: membership.access(options.permissions ?? ALL_PERMISSIONS) };
}

/** A resolver that maps `Authorization: Bearer <token>` to the token's principal, and anything else to no actor. */
export function testResolver(tokens: Readonly<Record<string, Principal>>): ContextResolver {
  return (request) => {
    const match = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
    const token = match?.[1];
    return Promise.resolve(token !== undefined && Object.hasOwn(tokens, token) ? tokens[token] : undefined);
  };
}

/** The header that names a token's actor. */
export function bearer(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** A database that fails the test when anything asks it, and records what was asked. */
export interface UntouchedDatabase extends Database {
  readonly asked: readonly string[];
}

export function untouchedDatabase(): UntouchedDatabase {
  const asked: string[] = [];
  const refuse = (what: string): Promise<never> => {
    asked.push(what);
    return Promise.reject(new Error(`The database was asked to ${what}, and this test must not touch it.`));
  };
  return {
    asked,
    read: () => refuse("read"),
    write: () => refuse("write"),
    person: () => refuse("person"),
    lookup: () => refuse("lookup"),
    end: () => refuse("end"),
  };
}

/** A pool of `max` connections as the app role in a test database, the database over it, and the connection errors it was told of. */
export interface AppPool {
  readonly pool: Pool;
  readonly database: Database;
  readonly errors: readonly Error[];
}

export function appPool(db: TestDatabase, max: number): AppPool {
  const pool = new Pool({ ...connectionConfig(urlOf("nortfox_app", db.name)), max });
  const errors: Error[] = [];
  return { pool, database: databaseOver(pool, (error) => errors.push(error)), errors };
}

/**
 * A pool of the app's connections whose first statement that `statement`
 * matches waits at the gate before it is sent, in the middle of its
 * transaction: so a test runs other requests to their commit between two
 * statements of one request.
 */
export function appPoolHolding(db: TestDatabase, max: number, statement: RegExp): AppPool & { readonly gate: Gate } {
  const pool = new Pool({ ...connectionConfig(urlOf("nortfox_app", db.name)), max });
  const held = gate();
  let armed = true;
  pool.on("connect", (client) => {
    const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;
    Object.assign(client, {
      query: async (text: unknown, values?: unknown): Promise<unknown> => {
        if (armed && typeof text === "string" && statement.test(text)) {
          armed = false;
          await held.pass();
        }
        return query(text, values);
      },
    });
  });
  const errors: Error[] = [];
  return { pool, database: databaseOver(pool, (error) => errors.push(error)), errors, gate: held };
}

/** The test app: the test registry and handlers, the passwords at the tests' small cost, and the routes checked as startServer checks them. */
export function buildTestApp(options: Pick<AppOptions, "database" | "resolve"> & Partial<AppOptions>): ServerApp {
  const app = createApp({
    version: TEST_VERSION,
    cursorKey: CURSOR_KEY,
    installKey: TEST_INSTALL_KEY,
    registry: TEST_REGISTRY,
    handlers: testHandlers(),
    permissions: ALL_PERMISSIONS,
    passwordHasher: testPasswords(),
    ...options,
  });
  assertV1Routes(app);
  return app;
}

/** Problem details, as a test reads them from an answer. */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly errors?: readonly { readonly code: string; readonly detail: string; readonly pointer: string; readonly data?: Record<string, unknown> }[];
  readonly permission?: string;
  readonly pointer?: string;
  readonly data?: Record<string, unknown>;
}

/** The problem details of an answer, after checking that it carries them. */
export async function problemIn(response: Response): Promise<ProblemBody> {
  if (response.headers.get("content-type") !== "application/problem+json") {
    throw new Error(`The answer is ${String(response.status)} with ${String(response.headers.get("content-type"))}, not problem details.`);
  }
  return (await response.json()) as ProblemBody;
}

/** A body for the test-only write: a description and the amount as SEK. */
export function voucherBody(amount = "125.00", description = "Kontorsmaterial"): { description: string; amount: { amount: string; currency: string } } {
  return { description, amount: { amount, currency: "SEK" } };
}

/** The headers of a write: the actor's token, JSON, and the idempotency key when one is given. */
export function writeHeaders(token: string, key?: string): Record<string, string> {
  return { ...bearer(token), "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) };
}

/** Posts `body` as JSON to the test-only write. */
export function postVoucher(hono: ServerApp["hono"], token: string, key: string | undefined, body: unknown = voucherBody()): Promise<Response> {
  return Promise.resolve(hono.request("/v1/test-vouchers", { method: "POST", headers: writeHeaders(token, key), body: JSON.stringify(body) }));
}

/** The two eras of MCP a client may speak: the 2025 handshake, and the 2026-07-28 revision. */
export const MCP_ERAS = ["2025", "2026-07-28"] as const;
export type McpEra = (typeof MCP_ERAS)[number];

/** Where the test clients find /mcp. The app answers through app.request, so the host is never looked up. */
const MCP_URL = "http://nortfox.test/mcp";

/**
 * An MCP client of the app, connected through app.request, as the SDK's
 * client connects to a real server. It sends the token's credential, the
 * Origin and a Cookie header when they are given. It speaks the 2026-07-28
 * revision unless the era says 2025.
 */
export async function mcpClient(
  app: ServerApp,
  options: { readonly token?: string; readonly era?: McpEra; readonly origin?: string; readonly cookie?: string } = {},
): Promise<McpClient> {
  const headers: Record<string, string> = {
    ...(options.token === undefined ? {} : bearer(options.token)),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
  };
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => Promise.resolve(app.hono.request(url, init)),
    requestInit: { headers },
  });
  const client = new McpClient(
    { name: "nortfox-tests", version: "0.0.0" },
    options.era === "2025" ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  return client;
}

/** A tool's answer: whether it is a refusal, and its structured content. */
export interface ToolAnswer {
  readonly isError: boolean;
  readonly structured: unknown;
}

/**
 * Calls a tool, and checks that the answer's one text block is its
 * structured content as JSON, as the MCP specification recommends, and that
 * the result holds no token of any kind: no operation that an MCP client can
 * reach answers with a secret.
 */
export async function callTool(client: McpClient, name: string, args: Readonly<Record<string, unknown>> = {}): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: { ...args } });
  expectNoTokens([result]);
  const { content, structuredContent, isError } = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const text = JSON.stringify(structuredContent);
  if (JSON.stringify(content) !== JSON.stringify([{ type: "text", text }])) {
    throw new Error(`The answer of ${name} does not hold its structured content as its one text: ${JSON.stringify(result)}`);
  }
  return { isError: isError === true, structured: structuredContent };
}

/** What a company holds after the test-only writes: its vouchers with their rows' amounts, and its keys. */
export interface Written {
  readonly vouchers: readonly { readonly id: string; readonly number: number; readonly debit: bigint; readonly credit: bigint }[];
  readonly keys: readonly { readonly actor_id: string; readonly idempotency_key: string; readonly response_status: number; readonly response_body: unknown }[];
}

/** The vouchers and the keys of `company`, read as `client` (the app role). */
export async function writtenIn(client: Client, company: string): Promise<Written> {
  return inTransaction(client, { company }, async () => {
    const vouchers = await client.query<Written["vouchers"][number]>(
      `SELECT v.id, v.number, sum(r.debit)::bigint AS debit, sum(r.credit)::bigint AS credit
       FROM ledger.vouchers AS v JOIN ledger.voucher_rows AS r ON r.voucher_id = v.id GROUP BY v.id, v.number ORDER BY v.number`,
    );
    const keys = await client.query<Written["keys"][number]>(
      "SELECT actor_id, idempotency_key, response_status, response_body FROM ledger.idempotency_keys ORDER BY created_at, id",
    );
    return { vouchers: vouchers.rows, keys: keys.rows };
  });
}
