// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, type FetchFunction } from "./index.ts";

function answering(status: number, body: unknown): { fetch: FetchFunction; calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  const fetch: FetchFunction = (input, init) => {
    calls.push([input, init]);
    return Promise.resolve(Response.json(body, { status }));
  };
  return { fetch, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createClient", () => {
  it("calls GET /v1/health and gives back the health", async () => {
    const server = answering(200, { status: "ok", version: "1.0.0" });
    const client = createClient({ baseUrl: "https://books.example.com/", fetch: server.fetch });

    await expect(client.getHealth()).resolves.toEqual({ status: "ok", version: "1.0.0" });
    expect(server.calls).toEqual([
      [
        "https://books.example.com/v1/health",
        { method: "GET", headers: { accept: "application/json" } },
      ],
    ]);
  });

  it("passes the signal on", async () => {
    const server = answering(200, { status: "ok", version: "1.0.0" });
    const client = createClient({ baseUrl: "", fetch: server.fetch });
    const controller = new AbortController();

    await client.getHealth({ signal: controller.signal });
    expect(server.calls[0]?.[0]).toBe("/v1/health");
    expect(server.calls[0]?.[1].signal).toBe(controller.signal);
  });

  it("throws an ApiError with the status when the server refuses", async () => {
    const client = createClient({ baseUrl: "", fetch: answering(503, {}).fetch });
    const call = client.getHealth();

    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "GET /v1/health answered 503.",
    });
  });

  it("uses the global fetch when none is given", async () => {
    const server = answering(200, { status: "ok", version: "2.0.0" });
    vi.stubGlobal("fetch", server.fetch);
    const client = createClient({ baseUrl: "http://localhost:4100" });

    await expect(client.getHealth()).resolves.toEqual({ status: "ok", version: "2.0.0" });
    expect(server.calls[0]?.[0]).toBe("http://localhost:4100/v1/health");
  });
});
