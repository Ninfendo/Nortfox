// SPDX-License-Identifier: AGPL-3.0-only

// /mcp serves every registry entry as an MCP tool. tools/list lists exactly
// the registry, each tool with its input schema (the idempotency key on a
// write) and its output schema, written out here as the literals a client
// sees. A client of either era lists and calls the tools. A tool call
// answers the same JSON as the REST call, as structured content and as text;
// a refusal and an error the server did not expect answer the same problem
// details as /v1, in a result marked isError. An unknown tool is a protocol
// error. The tests here need no database: getHealth reads none, and every
// other case is refused or fails before one would be read.

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CURSOR_KEY,
  TEST_INSTALL_KEY,
  MCP_ERAS,
  TEST_VERSION,
  bearer,
  buildTestApp,
  callTool,
  mcpClient,
  personOf,
  principalOf,
  testResolver,
  untouchedDatabase,
  voucherBody,
} from "../../test/api.ts";
import { SHAPES_REGISTRY, SHAPE_OPERATIONS, fakeDatabase, shapeLog, shapesHandlers } from "../../test/shapes.ts";
import { createApp } from "../app.ts";
import type { Database } from "../db/database.ts";
import { startServer } from "../start.ts";
import { callerPrincipal } from "./mcp.ts";

const COMPANY = randomUUID();
const TOKENS = {
  reader: principalOf(COMPANY, { permissions: ["company:read"] }),
  writer: principalOf(COMPANY),
};

const UUID = {
  type: "string",
  format: "uuid",
  pattern:
    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
};

const MONEY = {
  type: "object",
  description: "An amount: a decimal string and its ISO 4217 currency code. Never a JSON number.",
  properties: {
    amount: {
      type: "string",
      pattern: "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$",
      description: 'The amount as a decimal string, such as "1234.50" or "-0.05", with no more decimals than its currency has.',
      examples: ["1234.50"],
    },
    currency: { type: "string", enum: ["SEK"], description: "The currency's ISO 4217 code. This install knows SEK." },
  },
  required: ["amount", "currency"],
  additionalProperties: false,
};

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };

/** The tools of the test app, as tools/list gives them: the registry's two, then the test-only write and list. */
const TOOLS = [
  {
    name: "getHealth",
    title: "Check that the server is up",
    description: "Checks that the NortFox server is up, and gives its version. It reads no data.",
    inputSchema: NO_INPUT,
    outputSchema: {
      type: "object",
      description: "Whether the server is up.",
      properties: {
        status: { type: "string", const: "ok", description: 'Always "ok" when the server answers.' },
        version: { type: "string", description: "The version of the server that answered.", examples: ["0.0.0"] },
      },
      required: ["status", "version"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "getCompany",
    title: "Read the company",
    description:
      "Gives the company you work in: its id, name, organisation number and database number. Every other tool works in this company too.",
    inputSchema: NO_INPUT,
    outputSchema: {
      type: "object",
      description: "The company the request works in. Every data request works in exactly one company.",
      properties: {
        id: { ...UUID, description: "The company's id." },
        name: { type: "string", description: "The company's name." },
        organizationNumber: {
          type: "string",
          pattern: "^[0-9]{6}-[0-9]{4}$",
          description:
            "The organisation number: ten digits with a hyphen after the sixth. For a sole trader it is the owner's personal identity number.",
        },
        databaseNumber: {
          type: "integer",
          minimum: 1,
          maximum: 2147483647,
          description: "The company's number for programs, its tenant id. It never changes.",
        },
      },
      required: ["id", "name", "organizationNumber", "databaseNumber"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "testBookVoucher",
    title: "Book a voucher",
    description: "Books a voucher of one amount in the company you work in. Only the tests serve it.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", minLength: 1, maxLength: 200, description: "The voucher's description." },
        amount: MONEY,
        idempotencyKey: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern: "^[\\x21\\x23-\\x5b\\x5d-\\x7e]+$",
          description:
            'A key you choose for this write, 1 to 255 characters of visible ASCII without " and \\. Send the same key with the same input again, and you get the first answer back instead of a second write.',
        },
      },
      required: ["description", "amount", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { ...UUID, description: "The voucher's id." },
        number: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991, description: "The voucher's number in series A." },
        amount: MONEY,
      },
      required: ["id", "number", "amount"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "testListAccounts",
    title: "List the accounts",
    description: "Lists the accounts of the company you work in. Only the tests serve it.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 100, description: "How many items a page holds: from 1 to 500. Any other whole number gives 100." },
        cursor: {
          type: "string",
          description: "Where the page starts: the nextCursor of the page before. Leave it out for the first page.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      description: "A page of the list.",
      properties: {
        items: {
          type: "array",
          description: "The items of this page, in the list's order.",
          items: {
            type: "object",
            properties: {
              id: { ...UUID, description: "The account's id." },
              number: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991, description: "The account's number." },
              description: { type: "string", description: "The account's name." },
            },
            required: ["id", "number", "description"],
            additionalProperties: false,
          },
        },
        nextCursor: { type: "string", description: "Where the next page starts. It is absent on the last page." },
        total: { type: "integer", minimum: 0, maximum: 9007199254740991, description: "How many items the whole list holds." },
      },
      required: ["items", "total"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const HEALTH = { status: "ok", version: TEST_VERSION };

function testApp(database = untouchedDatabase(), report: (error: unknown) => void = () => undefined) {
  return buildTestApp({ database, resolve: testResolver(TOKENS), report });
}

describe("tools/list", () => {
  it.each(MCP_ERAS)("lists exactly the registry's operations, in its order, each with the schemas written here, to a client of the %s era", async (era) => {
    const client = await mcpClient(testApp(), { era });
    const listed = await client.listTools();
    expect(listed.tools).toEqual(TOOLS);
    expect(listed.nextCursor).toBeUndefined();
    await client.close();
  });

  it("lists the same tools with and without an actor", async () => {
    const app = testApp();
    const anonymous = await mcpClient(app);
    const writer = await mcpClient(app, { token: "writer" });
    expect((await anonymous.listTools()).tools).toEqual((await writer.listTools()).tools);
    await anonymous.close();
    await writer.close();
  });

  it("asks a write for its idempotency key, and no read", async () => {
    const client = await mcpClient(testApp());
    const { tools } = await client.listTools();
    const inputOf = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
    expect(inputOf("testBookVoucher")?.required).toContain("idempotencyKey");
    expect(inputOf("testBookVoucher")?.properties).toHaveProperty("idempotencyKey");
    for (const read of ["getHealth", "getCompany", "testListAccounts"]) {
      expect(inputOf(read)?.properties).not.toHaveProperty("idempotencyKey");
      expect(inputOf(read)?.required ?? []).not.toContain("idempotencyKey");
    }
    await client.close();
  });
});

describe("tools/call", () => {
  it.each(MCP_ERAS)("answers getHealth with no actor as REST does: the same JSON as structured content and as text (%s)", async (era) => {
    const app = testApp();
    const rest = await app.hono.request("/v1/health");
    expect(await rest.json()).toEqual(HEALTH);
    const client = await mcpClient(app, { era });
    expect(await callTool(client, "getHealth")).toEqual({ isError: false, structured: HEALTH });
    // A call may leave out its arguments when the tool takes none.
    expect(await client.callTool({ name: "getHealth" })).toMatchObject({ structuredContent: HEALTH });
    await client.close();
  });

  it("answers an unknown tool with a protocol error, and runs nothing", async () => {
    const database = untouchedDatabase();
    const client = await mcpClient(testApp(database), { token: "writer" });
    for (const name of ["noSuchTool", "GetCompany", "getcompany", "toString", "__proto__", ""]) {
      const error = await client.callTool({ name, arguments: {} }).then(
        () => undefined,
        (refused: unknown) => refused,
      );
      expect(error).toMatchObject({ code: -32602 });
      expect(String(error)).toContain(`There is no tool named ${JSON.stringify(name)}.`);
    }
    expect(database.asked).toEqual([]);
    await client.close();
  });

  it("answers a call that fails with isError and 500 internal-error, with nothing of the error, and reports the error", async () => {
    const reported: unknown[] = [];
    const database = untouchedDatabase();
    const client = await mcpClient(testApp(database, (error) => reported.push(error)), { token: "reader" });
    expect(await callTool(client, "getCompany")).toEqual({
      isError: true,
      structured: {
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        detail: "The server failed. The answer holds no detail of the error, and the server has logged it.",
        code: "internal-error",
      },
    });
    expect(database.asked).toEqual(["read"]);
    expect(reported.map(String)).toEqual(["Error: The database was asked to read, and this test must not touch it."]);
    await client.close();
  });

  it("takes an argument the operation does not declare as an unknown field at its pointer, with the text /v1 gives", async () => {
    const database = untouchedDatabase();
    const client = await mcpClient(testApp(database), { token: "writer" });
    const unknown = (pointer: string) => ({ code: "unknown-field", detail: `The field ${pointer} is not part of this operation.`, pointer });
    const invalid = (...errors: unknown[]) => ({
      isError: true,
      structured: {
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "The request does not fit the operation. Each field problem names its field.",
        code: "invalid-request",
        errors,
      },
    });
    expect(await callTool(client, "getCompany", { cursor: "x", idempotencyKey: "k-1" })).toEqual(invalid(unknown("/cursor"), unknown("/idempotencyKey")));
    expect(await callTool(client, "testListAccounts", { limit: 5, Limit: 5, amount: "1.00" })).toEqual(invalid(unknown("/Limit"), unknown("/amount")));
    expect(await callTool(client, "testBookVoucher", { ...voucherBody(), idempotencyKey: "k-1", limit: 5, "a/b~c": 1 })).toEqual(
      invalid(unknown("/limit"), unknown("/a~1b~0c")),
    );
    expect(await callTool(client, "getHealth", { constructor: 2, toString: 3 })).toEqual(invalid(unknown("/constructor"), unknown("/toString")));
    // The SDK's own check of the request drops an argument named __proto__ before any tool sees it.
    const odd = JSON.parse('{"__proto__": {"limit": 1}, "hasOwnProperty": 4}') as Record<string, unknown>;
    expect(await callTool(client, "testListAccounts", odd)).toEqual(invalid(unknown("/hasOwnProperty")));
    expect(database.asked).toEqual([]);
    await client.close();
  });

  it("answers GET and DELETE on /mcp, the 2025 session operations, with 405, and asks no database", async () => {
    const database = untouchedDatabase();
    const app = testApp(database);
    for (const method of ["GET", "DELETE"]) {
      const response = await app.hono.request("/mcp", { method, headers: { ...bearer("writer"), accept: "application/json, text/event-stream" } });
      expect(response.status).toBe(405);
    }
    expect(database.asked).toEqual([]);
  });
});

describe("the shapes of slice 2c by MCP", () => {
  const THING = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";
  const PERSON = personOf();
  const SHAPE_TOKENS = { ...TOKENS, person: PERSON };

  function shapeApp(database: Database = untouchedDatabase()) {
    const log = shapeLog();
    return { log, app: buildTestApp({ database, resolve: testResolver(SHAPE_TOKENS), registry: SHAPES_REGISTRY, handlers: shapesHandlers(log), report: () => undefined }) };
  }

  /** Arguments with which each operation that serves the browser's session would succeed by REST. */
  const FLOW_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    testSignIn: { email: "anna@example.com" },
    testSendLetter: { email: "anna@example.com" },
    testStartRedirect: { provider: "alfa" },
    testEndSession: { idempotencyKey: "k-1" },
  };

  const FLOW = SHAPE_OPERATIONS.filter((operation) => operation["x-nortfox"].session === "flow");

  it("covers every test-only operation that serves the browser's session", () => {
    expect(FLOW.map((operation) => operation.operationId)).toEqual(Object.keys(FLOW_ARGUMENTS));
  });

  it.each(FLOW.flatMap((operation) => MCP_ERAS.flatMap((era) => [undefined, "person", "writer"].map((token) => [operation.operationId, era, token] as const))))(
    "refuses %s with 403 browser-only, before any argument is read, and runs no handler and asks no database (%s, %s)",
    async (name, era, token) => {
      const database = untouchedDatabase();
      const { app, log } = shapeApp(database);
      const client = await mcpClient(app, { era, ...(token === undefined ? {} : { token }) });
      for (const args of [FLOW_ARGUMENTS[name] ?? {}, { unknown: 1 }]) {
        expect(await callTool(client, name, args)).toEqual({
          isError: true,
          structured: {
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            detail: "This operation serves the browser's sign-in. An MCP client signs in through OAuth.",
            code: "browser-only",
          },
        });
      }
      expect(log.calls).toEqual([]);
      expect(database.asked).toEqual([]);
      await client.close();
    },
  );

  it("lists each operation of the browser's session with its schemas, as any tool", async () => {
    const client = await mcpClient(shapeApp().app);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(SHAPES_REGISTRY.map((operation) => operation.operationId));
    expect(tools.find((tool) => tool.name === "testSignIn")?.inputSchema).toEqual({
      type: "object",
      properties: { email: { type: "string", minLength: 1, description: "The e-mail address." } },
      required: ["email"],
      additionalProperties: false,
    });
    await client.close();
  });

  it("takes a path parameter as an argument, and names a bad one at its pointer", async () => {
    const { app } = shapeApp(fakeDatabase());
    const client = await mcpClient(app, { token: "writer" });
    expect(await callTool(client, "testGetThing", { thingId: THING, view: "long" })).toEqual({
      isError: false,
      structured: { id: THING, view: "long", companyId: COMPANY },
    });
    expect(await callTool(client, "testGetThing", { view: "long" })).toMatchObject({
      isError: true,
      structured: { status: 400, errors: [{ code: "missing-field", pointer: "/thingId" }] },
    });
    await client.close();
  });

  it("answers an operation that answers 204 with an empty object", async () => {
    const { app } = shapeApp(fakeDatabase());
    const client = await mcpClient(app, { token: "writer" });
    expect(await callTool(client, "testRemoveThing", { thingId: THING, idempotencyKey: "k-1" })).toEqual({ isError: false, structured: {} });
    await client.close();
  });

  it("answers a signed-in person's operation that does not serve the browser's session", async () => {
    const database = fakeDatabase();
    const { app } = shapeApp(database);
    const client = await mcpClient(app, { token: "person" });
    expect(await callTool(client, "testGetPerson")).toEqual({ isError: false, structured: { personId: PERSON.personId } });
    expect(database.transactions).toEqual([{ mode: "read", settings: { actorId: PERSON.personId, actorKind: "user", channel: "mcp" }, ended: "commit" }]);
    await client.close();
  });
});

describe("the caller of an MCP request", () => {
  it("is the principal that /mcp passes with each request, and nothing else", () => {
    expect(() => callerPrincipal(undefined)).toThrow("The MCP server got no caller");
    expect(() => callerPrincipal({ token: "", clientId: "", scopes: [] })).toThrow("The MCP server got no caller");
  });
});

describe("/mcp on the real server", () => {
  it.each(MCP_ERAS)("serves a client of the %s era over HTTP, as through app.request", async (era) => {
    const app = createApp({ version: TEST_VERSION, resolve: testResolver(TOKENS), database: untouchedDatabase(), cursorKey: CURSOR_KEY, installKey: TEST_INSTALL_KEY });
    const server = await startServer({ app, port: 0 });
    try {
      const client = new Client(
        { name: "nortfox-tests", version: "0.0.0" },
        era === "2025" ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(server.port)}/mcp`)));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["getHealth", "getCompany"]);
      expect(await callTool(client, "getHealth")).toEqual({ isError: false, structured: { status: "ok", version: TEST_VERSION } });
      await client.close();
    } finally {
      await server.close();
    }
  });

  it("answers a 2026-07-28 call with one JSON body, never a stream", async () => {
    const app = testApp();
    const response = await app.hono.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "getHealth",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "getHealth",
          arguments: {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "nortfox-tests", version: "0.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { structuredContent: HEALTH } });
  });

  it("answers a 2025 call with an event stream that holds its one answer, as the stateless fallback does", async () => {
    const app = testApp();
    const response = await app.hono.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "getHealth", arguments: {} } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: "));
    expect(events.map((line) => JSON.parse(line.slice("data: ".length)) as unknown)).toEqual([
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(HEALTH) }], structuredContent: HEALTH } },
    ]);
  });
});
