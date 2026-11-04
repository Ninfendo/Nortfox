// SPDX-License-Identifier: AGPL-3.0-only

// The server mounts /v1 from the registry and nothing else
// (docs/decisions/0003-contract-first-rest-and-mcp.md). The guard reads the
// finished app's routes and names each one that could serve a /v1 path but
// is neither a registry entry's method and path nor the 405 answer at a
// registry path. It runs where the app is served: startServer runs it before
// it listens, and the test app builders run it, so a route added after
// createApp, anywhere, stops the server.

import type { Operation } from "@nortfox/contract";

/** A route as Hono lists it. */
export interface Route {
  readonly method: string;
  readonly path: string;
}

/** An app as it is served: its routes, and the registry it serves under /v1. */
export interface RoutedApp {
  readonly hono: { readonly routes: readonly Route[] };
  readonly registry: readonly Operation[];
}

/**
 * Whether a route could serve a path under /v1: its first segment is v1, or
 * a parameter or a wildcard that could match v1.
 */
function servesV1(path: string): boolean {
  const first = path.replace(/^\//, "").replace(/\/.*$/s, "");
  return first === "v1" || first.startsWith(":") || first.includes("*");
}

/**
 * Each route that could serve a /v1 path and that the registry does not
 * declare. A route's path holds a path parameter as :name, as Hono routes
 * the registry's {name}.
 */
export function v1RouteProblems(routes: readonly Route[], operations: readonly Operation[]): string[] {
  const declared = new Set(operations.map((operation) => `${operation.method.toUpperCase()} ${operation.getRoutingPath()}`));
  const paths = new Set(operations.map((operation) => operation.getRoutingPath()));
  return routes
    .filter((route) => servesV1(route.path))
    .filter((route) => !declared.has(`${route.method} ${route.path}`) && !(route.method === "ALL" && paths.has(route.path)))
    .map((route) => `${route.method} ${route.path} is a route under /v1 that no operation of the registry declares.`);
}

/** Throws when the app serves a route under /v1 that is not in its registry. */
export function assertV1Routes(app: RoutedApp): void {
  const problems = v1RouteProblems(app.hono.routes, app.registry);
  if (problems.length > 0) {
    throw new Error(`The app serves routes under /v1 that are not in the registry:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}
