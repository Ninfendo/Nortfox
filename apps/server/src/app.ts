// SPDX-License-Identifier: AGPL-3.0-only

// The app: /v1 from the registry, the API description at /openapi.json, and
// problem details for an unknown path and for an error the server did not
// expect. createApp checks what it is given: the registry guard runs on the
// registry, and each operation must have exactly one handler. It never
// listens; startServer does that, after it checks the app's /v1 routes.

import { PERMISSIONS, REGISTRY, registryProblems, type Operation } from "@nortfox/contract";
import { Hono } from "hono";
import type { ContextResolver } from "./api/context.ts";
import type { Handler } from "./api/operation.ts";
import { internalError, notFound } from "./api/problem.ts";
import { mountV1, problemResponse, type V1Env } from "./api/v1.ts";
import type { Database } from "./db/database.ts";
import { serverHandlers } from "./handlers.ts";
import { openApiDocument } from "./openapi.ts";

export interface AppOptions {
  /** The version the server reports, from its package.json. */
  readonly version: string;
  /** Reads who acts from a request's headers. */
  readonly resolve: ContextResolver;
  readonly database: Database;
  /** The key that signs each list's cursors: at least 32 bytes. */
  readonly cursorKey: Uint8Array;
  /** The operations to serve. By default the registry. */
  readonly registry?: readonly Operation[];
  /** One handler per operation. By default the server's own. */
  readonly handlers?: readonly Handler[];
  /** The permissions an operation may need besides "public". By default the contract's. */
  readonly permissions?: readonly string[];
  /** Told of every error that answers 500. By default console.error. */
  readonly report?: (error: unknown) => void;
}

/** The app as the server serves it: the Hono app, and the registry it serves under /v1. */
export interface ServerApp {
  readonly hono: Hono<V1Env>;
  readonly registry: readonly Operation[];
}

/** The shortest key that signs the cursors. */
const CURSOR_KEY_BYTES = 32;

function listed(heading: string, problems: readonly string[]): string {
  return `${heading}\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
}

/** Each operation's one handler, in the registry's order. Throws on an operation with none or more, and on a handler of no operation. */
function handlersOf(registry: readonly Operation[], handlers: readonly Handler[]): Handler[] {
  const problems: string[] = [];
  const served: Handler[] = [];
  for (const operation of registry) {
    const [first, ...more] = handlers.filter((handler) => handler.operation === operation);
    if (first === undefined) {
      problems.push(`${operation.operationId} has no handler.`);
    } else if (more.length > 0) {
      problems.push(`${operation.operationId} has more than one handler.`);
    } else {
      served.push(first);
    }
  }
  for (const handler of handlers.filter((each) => !registry.includes(each.operation))) {
    problems.push(`The handler of ${handler.operation.operationId} serves an operation that is not in the registry.`);
  }
  if (problems.length > 0) {
    throw new Error(listed("The app cannot serve its registry:", problems));
  }
  return served;
}

function logError(error: unknown): void {
  console.error("The server failed:", error);
}

/** Builds the app with every route. */
export function createApp(options: AppOptions): ServerApp {
  const registry = options.registry ?? REGISTRY;
  const report = options.report ?? logError;
  const problems = registryProblems(registry, options.permissions ?? Object.keys(PERMISSIONS));
  if (problems.length > 0) {
    throw new Error(listed("The registry has problems:", problems));
  }
  const handlers = handlersOf(registry, options.handlers ?? serverHandlers(options.version));
  if (options.cursorKey.length < CURSOR_KEY_BYTES) {
    throw new Error(`The cursor key must be at least ${String(CURSOR_KEY_BYTES)} bytes long.`);
  }

  const hono = new Hono<V1Env>();
  mountV1(hono, handlers, { resolve: options.resolve, database: options.database, cursorKey: options.cursorKey, report });
  // The description is rendered once, at start.
  const description = JSON.stringify(openApiDocument(registry, options.version));
  hono.get("/openapi.json", () => new Response(description, { headers: { "Content-Type": "application/json" } }));
  hono.notFound(() => problemResponse(notFound()));
  hono.onError((error) => {
    report(error);
    return problemResponse(internalError());
  });
  return { hono, registry };
}
