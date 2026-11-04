// SPDX-License-Identifier: AGPL-3.0-only

import { get, request } from "node:http";
import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { CURSOR_KEY, TEST_INSTALL_KEY, buildTestApp, gate, testHandlers, testResolver, untouchedDatabase } from "../test/api.ts";
import { SHAPES_REGISTRY, fakeDatabase, shapeHandlers, shapeLog, testSendLetter } from "../test/shapes.ts";
import { handleNone, ok } from "./api/operation.ts";
import { createApp, type ServerApp } from "./app.ts";
import { DEFAULT_PORT, parsePort, startServer } from "./start.ts";
import { parseVersion, readServerVersion } from "./version.ts";

function getText(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    }).on("error", reject);
  });
}

function app() {
  return createApp({ version: "9.9.9", resolve: testResolver({}), database: untouchedDatabase(), cursorKey: CURSOR_KEY, installKey: TEST_INSTALL_KEY });
}

/**
 * Sends a request, as a client that leaves before its answer: once `leave`
 * resolves, it destroys its socket. Resolves once the socket has closed.
 */
function sendAndLeave(port: number, method: string, path: string, body: string | undefined, leave: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const sent = request({ host: "127.0.0.1", port, path, method, headers: body === undefined ? {} : { "content-type": "application/json" } });
    sent.on("error", () => undefined);
    sent.on("close", () => {
      resolve();
    });
    sent.end(body);
    void leave.then(() => sent.destroy());
  });
}

/** A while, in which a close that does not wait for a running call would resolve. */
function aWhile(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

/** Listens on `port`, or on a free one for 0, and gives the listener. */
function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, () => {
      resolve(server);
    });
  });
}

function closeListener(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe("parsePort", () => {
  it("defaults to 4100", () => {
    expect(DEFAULT_PORT).toBe(4100);
    expect(parsePort(undefined)).toBe(4100);
    expect(parsePort("")).toBe(4100);
  });

  it("reads a port", () => {
    expect(parsePort("0")).toBe(0);
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("65535")).toBe(65535);
  });

  it.each(["65536", "-1", "80.5", "http", " 80", "123456"])("refuses %j", (value) => {
    expect(() => parsePort(value)).toThrow("PORT must be a whole number from 0 to 65535");
  });
});

describe("startServer", () => {
  it("listens, answers /v1/health, and closes", async () => {
    const server = await startServer({ app: app(), port: 0 });
    try {
      const answer = await getText(server.port, "/v1/health");
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({ status: "ok", version: "9.9.9" });
      const refused = await getText(server.port, "/v1/company");
      expect(refused.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("closes only once the work queued for after the answers has run, so a stop loses no entry before the pool ends", async () => {
    const built = app();
    let release: () => void = () => undefined;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const waiting: ServerApp = {
      ...built,
      afterAnswer: {
        batch: () => built.afterAnswer.batch(),
        idle: async () => {
          await queued;
          order.push("queue idle");
        },
      },
    };
    const server = await startServer({ app: waiting, port: 0 });
    const closing = server.close().then(() => order.push("closed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    release();
    await closing;
    expect(order).toEqual(["queue idle", "closed"]);
  });

  it("closes only once a call whose client has left has ended, and its work after the answer has run", async () => {
    const order: string[] = [];
    const held = gate();
    const log = shapeLog();
    // The letter's handler waits at the gate, as a sign-in waits for its hash, and then queues its work for after the answer.
    const handlers = [
      ...testHandlers(),
      ...shapeHandlers(log).filter((handler) => handler.operation !== testSendLetter),
      handleNone(testSendLetter, async ({ later }) => {
        await held.pass();
        order.push("handler ends");
        later(() => Promise.resolve(void order.push("work after the answer")));
        return ok({});
      }),
    ];
    const built = buildTestApp({ database: fakeDatabase(), resolve: testResolver({}), registry: SHAPES_REGISTRY, handlers });
    const server = await startServer({ app: built, port: 0 });
    // The client leaves while the handler runs, as a closed tab or a proxy's timeout does.
    await sendAndLeave(server.port, "POST", "/v1/test-letters", JSON.stringify({ email: "anna@example.com" }), held.reached);
    const closing = server.close().then(() => order.push("closed"));
    await aWhile();
    expect(order).toEqual([]);
    held.open();
    await closing;
    expect(order).toEqual(["handler ends", "work after the answer", "closed"]);
  });

  it("closes only once a request whose client has left has its session looked up", async () => {
    const order: string[] = [];
    const held = gate();
    const built = createApp({
      version: "9.9.9",
      resolve: async () => {
        await held.pass();
        order.push("looked up");
        return undefined;
      },
      database: untouchedDatabase(),
      cursorKey: CURSOR_KEY,
      installKey: TEST_INSTALL_KEY,
    });
    const server = await startServer({ app: built, port: 0 });
    await sendAndLeave(server.port, "GET", "/v1/company", undefined, held.reached);
    const closing = server.close().then(() => order.push("closed"));
    await aWhile();
    expect(order).toEqual([]);
    held.open();
    await closing;
    expect(order).toEqual(["looked up", "closed"]);
  });

  it("reports a failed close", async () => {
    const server = await startServer({ app: app(), port: 0 });
    await server.close();
    await expect(server.close()).rejects.toThrow();
  });

  it("refuses an app with a /v1 route added after createApp, and listens on nothing", async () => {
    const free = await listenOn(0);
    const address = free.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await closeListener(free);

    const stray = app();
    stray.hono.post("/v1/company-stray", (c) => c.text("stray"));
    await expect(startServer({ app: stray, port })).rejects.toThrow(
      "The app serves routes under /v1 that are not in the registry:\n- POST /v1/company-stray is a route under /v1 that no operation of the registry declares.",
    );
    // Nothing listens on the port: it is free to take.
    await closeListener(await listenOn(port));
  });
});

describe("readServerVersion", () => {
  it("reads the version from apps/server/package.json", () => {
    expect(readServerVersion()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });
});

describe("parseVersion", () => {
  it("refuses a package.json without a version", () => {
    expect(() => parseVersion("{}")).toThrow("The package.json has no version.");
    expect(() => parseVersion('{"version":1}')).toThrow("The package.json has no version.");
    expect(() => parseVersion("null")).toThrow("The package.json has no version.");
    expect(parseVersion('{"version":"1.0.0"}')).toBe("1.0.0");
  });
});
