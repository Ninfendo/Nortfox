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

  it("calls GET /v1/company and gives back the company", async () => {
    const company = {
      id: "5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a",
      name: "Testbolaget Alfa AB",
      organizationNumber: "556000-0167",
      databaseNumber: 7,
    };
    const server = answering(200, company);
    const client = createClient({ baseUrl: "https://books.example.com", fetch: server.fetch });

    await expect(client.getCompany()).resolves.toEqual(company);
    expect(server.calls[0]?.[0]).toBe("https://books.example.com/v1/company");
  });

  it("gives the problem details of a refusal on the ApiError", async () => {
    const problem = {
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: "The actor lacks the permission company:read, which this operation needs.",
      code: "permission-missing",
      permission: "company:read",
    };
    for (const contentType of ["application/problem+json", "application/problem+json; charset=utf-8", "Application/Problem+JSON"]) {
      const fetch: FetchFunction = () =>
        Promise.resolve(new Response(JSON.stringify(problem), { status: 403, headers: { "content-type": contentType } }));
      const call = createClient({ baseUrl: "", fetch }).getCompany();

      await expect(call).rejects.toBeInstanceOf(ApiError);
      await expect(call).rejects.toMatchObject({
        status: 403,
        problem,
        message: "GET /v1/company answered 403 permission-missing.",
      });
    }
  });

  it("gives no problem details for an answer that holds none", async () => {
    const answers: [string, string][] = [
      ["application/json", JSON.stringify({ code: "x", status: 500 })],
      ["application/problem+json", "not json"],
      ["application/problem+json", "[]"],
      ["application/problem+json", "null"],
      ["application/problem+json", JSON.stringify({ status: 500 })],
      ["application/problem+jsonx", JSON.stringify({ code: "x", status: 500 })],
      ["", JSON.stringify({ code: "x", status: 500 })],
    ];
    for (const [contentType, body] of answers) {
      const headers: Record<string, string> = contentType === "" ? {} : { "content-type": contentType };
      const fetch: FetchFunction = () => Promise.resolve(new Response(new TextEncoder().encode(body), { status: 500, headers }));
      const call = createClient({ baseUrl: "", fetch }).getCompany();

      await expect(call, `${contentType} ${body}`).rejects.toMatchObject({ status: 500, problem: undefined, message: "GET /v1/company answered 500." });
    }
  });

  it("uses the global fetch when none is given", async () => {
    const server = answering(200, { status: "ok", version: "2.0.0" });
    vi.stubGlobal("fetch", server.fetch);
    const client = createClient({ baseUrl: "http://localhost:4100" });

    await expect(client.getHealth()).resolves.toEqual({ status: "ok", version: "2.0.0" });
    expect(server.calls[0]?.[0]).toBe("http://localhost:4100/v1/health");
  });
});
