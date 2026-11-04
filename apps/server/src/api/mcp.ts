// SPDX-License-Identifier: AGPL-3.0-only

// /mcp: every registry entry as an MCP tool, through the official SDK's
// server (createMcpHandler). It serves the 2026-07-28 revision and, as a
// stateless fallback, clients of the 2025 era. Every JSON-RPC message is its
// own HTTP request, and nothing is kept between them. The SDK answers a
// 2026-07-28 request with one JSON body, since no handler here sends a
// message before its result, and a 2025 request with an event stream that
// holds its one answer. GET and DELETE, the 2025 session operations, get 405
// from the SDK.
//
// The order on each request:
//
// 1. The Origin check, before anything else, as the MCP specification asks of
//    its HTTP transport against DNS rebinding. A request whose Origin is not
//    on the allowed list gets 403 origin-not-allowed as problem details, and
//    nothing runs for it. A request with no Origin is not refused for that,
//    since programs other than browsers send none. The list holds whole
//    origins, compared as a browser serialises them.
// 2. The resolver reads the credential from the request's headers. The
//    principal rides to the SDK's server factory in authInfo, which the SDK
//    passes on as it is and never reads from a header itself.
// 3. The SDK reads the JSON-RPC message. tools/list lists exactly the
//    registry: the tool name is the operation id, the title its summary, the
//    description its tool text, and the input and output schemas the
//    contract's (tool-schema.ts). tools/call of an unknown name is a protocol
//    error. A tool of an operation that serves the browser's session, such
//    as a sign-in, refuses every call with 403 browser-only before any
//    argument is read: an MCP client signs in through OAuth. For any other
//    tool, the actor and the permission are checked before any argument is
//    read, as on /v1.
// 4. The arguments are the operation's flat input: a path parameter goes to
//    the path parameters, a query field to the query, idempotencyKey to a
//    write's key, and every other argument to the body, or to the query of an
//    operation without a body, where the operation's strict schema names it
//    as an unknown field. Then the runner runs the call with the channel mcp
//    and, for a write, the key as the caller sent it.
//
// A tool call answers the same JSON as the REST call, as structured content
// and as text, and an empty object for an operation that answers with no
// body. A refusal, and an error the server did not expect, answer the same
// problem details as /v1, in a result marked isError. Every structured
// content is an object, which both eras carry as it is. Work that a handler
// queued for after its answer is released once the result is built.
//
// The SDK's low-level server is used, not McpServer's registerTool, because
// registerTool checks the arguments itself and answers a bad one with its
// own text, while a field problem here must be the same as on /v1. The SDK
// reaches the low-level server through McpServer's server property, as its
// documentation says for custom request handlers.

import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  createMcpHandler,
  type AuthInfo,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import {
  IDEMPOTENCY_KEY_ARGUMENT,
  bodySchema,
  paramsSchema,
  querySchema,
  takesIdempotencyKey,
  toolInputSchema,
  toolOutputSchema,
} from "@nortfox/contract";
import type { Hono } from "hono";
import type { Principal, RequestContext } from "./context.ts";
import { authorize, runOperation, type Handler, type Outcome } from "./operation.ts";
import { browserOnly, internalError, originNotAllowed, problemOf } from "./problem.ts";
import { BODY_LIMIT, problemResponse, type V1Deps, type V1Env } from "./v1.ts";

/** Where the app serves MCP. */
export const MCP_PATH = "/mcp";

export interface McpDeps extends V1Deps {
  /** The version the server reports to an MCP client. */
  readonly version: string;
}

/**
 * The caller of one /mcp request, as the surface hands it to the SDK. The
 * SDK passes it on to the server factory as it is. The token, the client id
 * and the scopes are empty until slice 2c brings OAuth for MCP clients.
 */
class Caller implements AuthInfo {
  readonly token = "";
  readonly clientId = "";
  readonly scopes: string[] = [];
  readonly principal: Principal | undefined;

  constructor(principal: Principal | undefined) {
    this.principal = principal;
  }
}

/** The principal of the request the SDK serves, from the caller that /mcp passed with it. */
export function callerPrincipal(authInfo: AuthInfo | undefined): Principal | undefined {
  if (!(authInfo instanceof Caller)) {
    throw new Error("The MCP server got no caller. /mcp passes one with every request.");
  }
  return authInfo.principal;
}

/** One tool: its operation's handler, its listing, and the names of its path parameters and its query's fields. */
interface ServedTool {
  readonly handler: Handler;
  readonly tool: Tool;
  readonly paramFields: ReadonlySet<string>;
  readonly queryFields: ReadonlySet<string>;
  readonly takesBody: boolean;
  readonly writes: boolean;
  /** Whether its operation serves the browser's session, so its tool refuses every call. */
  readonly browserOnly: boolean;
}

function servedTool(handler: Handler): ServedTool {
  const { operation } = handler;
  const meta = operation["x-nortfox"];
  return {
    handler,
    tool: {
      name: operation.operationId,
      title: operation.summary,
      description: meta.tool,
      inputSchema: { ...toolInputSchema(operation), type: "object" },
      outputSchema: { ...toolOutputSchema(operation), type: "object" },
      annotations: { readOnlyHint: !meta.writes },
    },
    paramFields: new Set(Object.keys(paramsSchema(operation)?.shape ?? {})),
    queryFields: new Set(Object.keys(querySchema(operation)?.shape ?? {})),
    takesBody: bodySchema(operation) !== undefined,
    writes: takesIdempotencyKey(operation),
    browserOnly: meta.session === "flow",
  };
}

/** A call's arguments as the runner takes them: the path parameters, the query, the body and a write's key. */
interface SplitArguments {
  readonly params: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
  readonly key: unknown;
}

/**
 * Splits a tool's arguments by the names its operation declares. The objects
 * are built with Object.fromEntries, so an argument named __proto__ stays a
 * field of its own, which the schema then names as unknown.
 */
function splitArguments(served: ServedTool, args: Readonly<Record<string, unknown>>): SplitArguments {
  const params: [string, unknown][] = [];
  const query: [string, unknown][] = [];
  const body: [string, unknown][] = [];
  let key: unknown;
  for (const [name, value] of Object.entries(args)) {
    if (served.paramFields.has(name)) {
      params.push([name, value]);
    } else if (served.queryFields.has(name)) {
      query.push([name, value]);
    } else if (served.writes && name === IDEMPOTENCY_KEY_ARGUMENT) {
      key = value;
    } else if (served.takesBody) {
      body.push([name, value]);
    } else {
      query.push([name, value]);
    }
  }
  return {
    params: Object.fromEntries(params),
    query: Object.fromEntries(query),
    body: served.takesBody ? Object.fromEntries(body) : undefined,
    key,
  };
}

/** A tool's answer: the JSON as structured content, and as text. */
function toolAnswer(structured: object, isError: boolean): CallToolResult {
  const answer = { content: [{ type: "text" as const, text: JSON.stringify(structured) }], structuredContent: structured as Record<string, unknown> };
  return isError ? { ...answer, isError: true } : answer;
}

/**
 * Runs one tool call for the principal: the refusal of an operation that
 * serves the browser's session, then authorize, both before any argument is
 * read, then the runner.
 */
async function callTool(served: ServedTool, principal: Principal | undefined, args: Readonly<Record<string, unknown>>, deps: McpDeps): Promise<CallToolResult> {
  const { handler } = served;
  if (served.browserOnly) {
    return toolAnswer(browserOnly().body, true);
  }
  const denied = authorize(handler.operation, principal);
  if (denied !== undefined) {
    return toolAnswer(problemOf(denied).body, true);
  }
  const { params, query, body, key } = splitArguments(served, args);
  const context: RequestContext | undefined = principal === undefined ? undefined : { ...principal, channel: "mcp" };
  const batch = deps.afterAnswer.batch();
  try {
    let outcome: Outcome;
    try {
      const idempotency = served.writes ? { key } : "none";
      outcome = await runOperation(handler, { context, input: { params, query, body }, idempotency, later: batch.later }, deps);
    } catch (error) {
      deps.report(error);
      return toolAnswer(internalError().body, true);
    }
    return outcome.ok ? toolAnswer(outcome.output as object, false) : toolAnswer(problemOf(outcome.refusal).body, true);
  } finally {
    batch.release();
  }
}

/** The MCP server for one request of the principal: tools/list and tools/call over the served tools. */
function serverFor(principal: Principal | undefined, tools: readonly ServedTool[], deps: McpDeps): McpServer["server"] {
  const byName = new Map(tools.map((served) => [served.tool.name, served]));
  const listed = tools.map((served) => served.tool);
  const { server } = new McpServer({ name: "nortfox", version: deps.version });
  server.registerCapabilities({ tools: {} });
  server.setRequestHandler("tools/list", () => ({ tools: listed }));
  server.setRequestHandler("tools/call", (request) => {
    const { name, arguments: args = {} } = request.params;
    const served = byName.get(name);
    if (served === undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `There is no tool named ${JSON.stringify(name)}.`);
    }
    return callTool(served, principal, args, deps);
  });
  return server;
}

/** Mounts /mcp, with a tool for each handler's operation. */
export function mountMcp(app: Hono<V1Env>, handlers: readonly Handler[], deps: McpDeps): void {
  const tools = handlers.map(servedTool);
  const mcp = createMcpHandler((context) => serverFor(callerPrincipal(context.authInfo), tools, deps), {
    legacy: "stateless",
    maxRequestBodySize: BODY_LIMIT,
  });
  app.all(MCP_PATH, async (c) => {
    const origin = c.req.raw.headers.get("origin");
    if (origin !== null && !deps.allowedOrigins.has(origin)) {
      return problemResponse(originNotAllowed());
    }
    const principal = await deps.resolve(c.req.raw);
    return mcp.fetch(c.req.raw, { authInfo: new Caller(principal) });
  });
}
