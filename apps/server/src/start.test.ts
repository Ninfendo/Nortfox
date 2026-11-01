// SPDX-License-Identifier: AGPL-3.0-only

import { get } from "node:http";
import { describe, expect, it } from "vitest";
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
    const server = await startServer({ port: 0, version: "9.9.9" });
    try {
      const answer = await getText(server.port, "/v1/health");
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({ status: "ok", version: "9.9.9" });
    } finally {
      await server.close();
    }
  });

  it("reports a failed close", async () => {
    const server = await startServer({ port: 0, version: "9.9.9" });
    await server.close();
    await expect(server.close()).rejects.toThrow();
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
