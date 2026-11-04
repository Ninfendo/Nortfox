// SPDX-License-Identifier: AGPL-3.0-only

// The app: /v1 from the registry, /mcp with a tool for each of its
// operations, the API description at /openapi.json, and problem details for
// an unknown path and for an error the server did not expect. createApp
// checks what it is given: the registry guard runs on the registry, each
// operation must have exactly one handler, and each allowed origin must be
// an origin as a browser sends it. It never listens; startServer does that,
// after it checks the app's /v1 routes.
//
// /v1 and /mcp share the runner's dependencies, above all the idempotency
// keys in flight, so a key that a REST request holds gives 409 to an MCP
// call, and the other way round. They share the allowed origins too: /v1's
// cross-site check and /mcp's Origin check take the same list. The install
// secret gives the key of each write's request fingerprint, and the sign-in
// seals each TOTP secret with it. The one password wrapper hashes and checks
// every password, at most as many at once as the host has cores.
//
// An error that the server did not expect goes to the reporter. The default
// one logs only what api/report.ts lets through: never a database error's
// detail, a token, a personnummer or an e-mail address.

import { PERMISSIONS, REGISTRY, registryProblems, type Operation } from "@nortfox/contract";
import { Hono } from "hono";
import { AfterAnswerQueue } from "./api/after-answer.ts";
import type { ContextResolver } from "./api/context.ts";
import { KeysInFlight } from "./api/idempotency.ts";
import type { Handler } from "./api/operation.ts";
import { mountMcp } from "./api/mcp.ts";
import { internalError, notFound } from "./api/problem.ts";
import { reportSafely } from "./api/report.ts";
import { mountV1, problemResponse, type V1Env } from "./api/v1.ts";
import type { InstallKey } from "./auth/install-key.ts";
import { allowedOrigins } from "./auth/origin.ts";
import { PasswordHasher } from "./auth/password.ts";
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
  /** The install secret (auth/install-key.ts). */
  readonly installKey: InstallKey;
  /** The operations to serve. By default the registry. */
  readonly registry?: readonly Operation[];
  /** One handler per operation. By default the server's own. */
  readonly handlers?: readonly Handler[];
  /** The permissions an operation may need besides "public". By default the contract's. */
  readonly permissions?: readonly string[];
  /** Told of every error that answers 500, and of work after an answer that fails. By default the safe report on console.error (api/report.ts). */
  readonly report?: (error: unknown) => void;
  /** The server's clock. By default the system's. */
  readonly now?: () => Date;
  /**
   * The one wrapper of passwords. By default one at the production cost
   * (auth/password.ts). The tests that only need some password pass a small
   * cost; the production cost has its own test.
   */
  readonly passwordHasher?: PasswordHasher;
  /**
   * The browser origins of the install, such as https://nortfox.example: the
   * origins that may call /mcp, and that /v1's writes with the session
   * cookie, and its sign-ins, must come from. By default none: such a
   * request with an Origin header gets 403, and one without, from a program
   * that is not a browser, is served.
   */
  readonly allowedOrigins?: readonly string[];
}

/** The app as the server serves it: the Hono app, the registry it serves under /v1, and the work it runs after its answers. */
export interface ServerApp {
  readonly hono: Hono<V1Env>;
  readonly registry: readonly Operation[];
  /** The work after the answers. A served request holds a batch while it runs; a stop and the tests wait in idle(). */
  readonly afterAnswer: Pick<AfterAnswerQueue, "batch" | "idle">;
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

function systemClock(): Date {
  return new Date();
}

/** Builds the app with every route. */
export function createApp(options: AppOptions): ServerApp {
  const registry = options.registry ?? REGISTRY;
  const report = options.report ?? reportSafely;
  const problems = registryProblems(registry, options.permissions ?? Object.keys(PERMISSIONS));
  if (problems.length > 0) {
    throw new Error(listed("The registry has problems:", problems));
  }
  const handlers = handlersOf(registry, options.handlers ?? serverHandlers(options.version));
  if (options.cursorKey.length < CURSOR_KEY_BYTES) {
    throw new Error(`The cursor key must be at least ${String(CURSOR_KEY_BYTES)} bytes long.`);
  }

  const hono = new Hono<V1Env>();
  const afterAnswer = new AfterAnswerQueue(report);
  const deps = {
    resolve: options.resolve,
    database: options.database,
    cursorKey: options.cursorKey,
    fingerprintKey: options.installKey.key("idempotency-fingerprint v1"),
    keysInFlight: new KeysInFlight(),
    now: options.now ?? systemClock,
    services: { passwords: options.passwordHasher ?? new PasswordHasher(), installKey: options.installKey },
    report,
    afterAnswer,
    allowedOrigins: allowedOrigins(options.allowedOrigins ?? []),
  };
  mountV1(hono, handlers, deps);
  mountMcp(hono, handlers, { ...deps, version: options.version });
  // The description is rendered once, at start.
  const description = JSON.stringify(openApiDocument(registry, options.version));
  hono.get("/openapi.json", () => new Response(description, { headers: { "Content-Type": "application/json" } }));
  hono.notFound(() => problemResponse(notFound()));
  hono.onError((error) => {
    report(error);
    return problemResponse(internalError());
  });
  return { hono, registry, afterAnswer };
}
