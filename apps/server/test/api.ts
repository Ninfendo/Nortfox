// SPDX-License-Identifier: AGPL-3.0-only

// What the API tests share: a resolver that maps a bearer token to a
// principal, the test-only list, a database that fails a test when it is
// asked, a pool as the app role, and an app builder that checks the /v1
// routes as startServer does. The test-only operations live here, outside
// src, so no build holds them and openapi.json never shows them.

import { randomUUID } from "node:crypto";
import { PERMISSIONS, REGISTRY, defineListOperation, type Operation } from "@nortfox/contract";
import { Pool } from "pg";
import { z } from "zod";
import type { ContextResolver, Principal } from "../src/api/context.ts";
import { handleList, ok, type Handler } from "../src/api/operation.ts";
import { assertV1Routes } from "../src/api/route-guard.ts";
import { createApp, type AppOptions, type ServerApp } from "../src/app.ts";
import { connectionConfig } from "../src/db/connect.ts";
import { databaseOver, type ActorKind, type Database } from "../src/db/database.ts";
import { serverHandlers } from "../src/handlers.ts";
import { urlOf } from "./cluster.ts";
import type { TestDatabase } from "./database.ts";

/** The permissions of the test-only operations. */
export const TEST_PERMISSIONS = ["test:read", "test:write"] as const;

/** Every permission an operation of the test app can need. */
export const ALL_PERMISSIONS: readonly string[] = [...Object.keys(PERMISSIONS), ...TEST_PERMISSIONS];

/** The version the test app reports. */
export const TEST_VERSION = "0.0.0-test";

/** A fixed key for the cursors of the test app. */
export const CURSOR_KEY = new Uint8Array(32).fill(7);

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

/** The registry of the test app: the real operations and the test-only ones. */
export const TEST_REGISTRY: readonly Operation[] = [...REGISTRY, testListAccounts];

/** The handlers of the test app. */
export function testHandlers(version = TEST_VERSION): Handler[] {
  return [...serverHandlers(version), testListAccountsHandler];
}

/** A principal in `companyId`: an integration with every permission, unless the options say otherwise. */
export function principalOf(
  companyId: string,
  options: { readonly actorId?: string; readonly kind?: ActorKind; readonly permissions?: readonly string[] } = {},
): Principal {
  return {
    companyId,
    actorId: options.actorId ?? randomUUID(),
    actorKind: options.kind ?? "integration",
    permissions: new Set(options.permissions ?? ALL_PERMISSIONS),
  };
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

/** The test app: the test registry and handlers, and the routes checked as startServer checks them. */
export function buildTestApp(options: Pick<AppOptions, "database" | "resolve"> & Partial<AppOptions>): ServerApp {
  const app = createApp({
    version: TEST_VERSION,
    cursorKey: CURSOR_KEY,
    registry: TEST_REGISTRY,
    handlers: testHandlers(),
    permissions: ALL_PERMISSIONS,
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
