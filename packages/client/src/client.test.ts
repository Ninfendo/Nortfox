// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, type FetchFunction } from "./index.ts";
import { createSend, type OperationCall } from "./runtime.ts";

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

  it("sends each operation of the browser's sign-in and of the person as its operation takes it", async () => {
    const user = { id: "8a9b0c1d-2e3f-4a5b-8c7d-6e5f4a3b2c1d", name: "Alva Berg", email: "alva.berg@example.com", language: "sv" };
    const answers: Response[] = [
      Response.json({ user, totpEnrolment: { otpauthUri: "otpauth://totp/NortFox:alva.berg%40example.com?secret=AAAA" } }, { status: 201 }),
      Response.json({ outcome: "totp-required", challenge: "the-challenge" }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      Response.json({ user }),
      Response.json({ user, twoStep: "new_device_90_days" }),
    ];
    const calls: [string, RequestInit][] = [];
    const client = createClient({
      baseUrl: "https://nortfox.example",
      fetch: (input, init) => {
        calls.push([input, init]);
        return Promise.resolve(answers.shift() ?? Response.json({}));
      },
    });
    await expect(client.completeSetup({ token: "the-setup-token", name: "Alva Berg", email: "alva.berg@example.com", password: "tolv-tecken!" })).resolves.toMatchObject({ user });
    await expect(client.loginWithPassword({ identifier: "alva.berg@example.com", password: "tolv-tecken!" })).resolves.toEqual({ outcome: "totp-required", challenge: "the-challenge" });
    await expect(client.verifyTotp({ challenge: "the-challenge", code: "123456" })).resolves.toBeUndefined();
    await expect(client.logout({ idempotencyKey: "logout-1" })).resolves.toBeUndefined();
    await expect(client.getSession()).resolves.toEqual({ user });
    await expect(client.getMe()).resolves.toEqual({ user, twoStep: "new_device_90_days" });
    const json = { accept: "application/json", "content-type": "application/json" };
    expect(calls).toEqual([
      ["https://nortfox.example/v1/setup/the-setup-token", { method: "POST", headers: json, body: '{"name":"Alva Berg","email":"alva.berg@example.com","password":"tolv-tecken!"}' }],
      ["https://nortfox.example/v1/auth/password", { method: "POST", headers: json, body: '{"identifier":"alva.berg@example.com","password":"tolv-tecken!"}' }],
      ["https://nortfox.example/v1/auth/totp", { method: "POST", headers: json, body: '{"challenge":"the-challenge","code":"123456"}' }],
      ["https://nortfox.example/v1/auth/logout", { method: "POST", headers: { accept: "application/json", "idempotency-key": "logout-1" } }],
      ["https://nortfox.example/v1/session", { method: "GET", headers: { accept: "application/json" } }],
      ["https://nortfox.example/v1/me", { method: "GET", headers: { accept: "application/json" } }],
    ]);
  });

  it("sends each operation of the companies and the person's own memberships as its operation takes it", async () => {
    const company = { id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", name: "Testbolaget Alfa AB", organizationNumber: "556000-0167", databaseNumber: 7 };
    const user = { id: "8a9b0c1d-2e3f-4a5b-8c7d-6e5f4a3b2c1d", name: "Alva Berg", email: "alva.berg@example.com", language: "sv" };
    const membership = { companyId: company.id, userId: user.id, status: "active", adminLevel: "owner", idleTimeout: 30 };
    const answers: Response[] = [
      Response.json(company, { status: 201 }),
      Response.json({ items: [{ company, adminLevel: "owner" }], total: 1 }),
      Response.json({ companies: [{ company }] }),
      Response.json({ user, company }),
      Response.json(membership),
    ];
    const calls: [string, RequestInit][] = [];
    const client = createClient({
      baseUrl: "https://nortfox.example",
      fetch: (input, init) => {
        calls.push([input, init]);
        return Promise.resolve(answers.shift() ?? Response.json({}));
      },
    });
    await expect(client.createCompany({ name: company.name, organizationNumber: company.organizationNumber }, { idempotencyKey: "make-1" })).resolves.toEqual(company);
    await expect(client.listCompanies({ query: "alfa", limit: 10 })).resolves.toEqual({ items: [{ company, adminLevel: "owner" }], total: 1 });
    await expect(client.listRecentCompanies()).resolves.toEqual({ companies: [{ company }] });
    await expect(client.selectCompany({ companyId: company.id }, { idempotencyKey: "choose-1" })).resolves.toEqual({ user, company });
    await expect(client.updateMyMembership({ companyId: company.id, workEmail: null, idleTimeout: 30 }, { idempotencyKey: "change-1" })).resolves.toEqual(membership);
    const json = { accept: "application/json", "content-type": "application/json" };
    expect(calls).toEqual([
      ["https://nortfox.example/v1/companies", { method: "POST", headers: { ...json, "idempotency-key": "make-1" }, body: '{"name":"Testbolaget Alfa AB","organizationNumber":"556000-0167"}' }],
      ["https://nortfox.example/v1/companies?query=alfa&limit=10", { method: "GET", headers: { accept: "application/json" } }],
      ["https://nortfox.example/v1/me/companies/recent", { method: "GET", headers: { accept: "application/json" } }],
      ["https://nortfox.example/v1/session/company", { method: "POST", headers: { ...json, "idempotency-key": "choose-1" }, body: `{"companyId":"${company.id}"}` }],
      [`https://nortfox.example/v1/me/companies/${company.id}`, { method: "PATCH", headers: { ...json, "idempotency-key": "change-1" }, body: '{"workEmail":null,"idleTimeout":30}' }],
    ]);
  });

  it("uses the global fetch when none is given", async () => {
    const server = answering(200, { status: "ok", version: "2.0.0" });
    vi.stubGlobal("fetch", server.fetch);
    const client = createClient({ baseUrl: "http://localhost:4100" });

    await expect(client.getHealth()).resolves.toEqual({ status: "ok", version: "2.0.0" });
    expect(server.calls[0]?.[0]).toBe("http://localhost:4100/v1/health");
  });
});

describe("a call of each shape", () => {
  /** A fetch that answers each call with `answer`, and records what it was asked. */
  function recording(answer: () => Response): { fetch: FetchFunction; calls: [string, RequestInit][] } {
    const calls: [string, RequestInit][] = [];
    return {
      calls,
      fetch: (input, init) => {
        calls.push([input, init]);
        return Promise.resolve(answer());
      },
    };
  }

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("sends %s", async (method) => {
    const server = recording(() => Response.json({ done: true }));
    const send = createSend({ baseUrl: "https://books.example.com", fetch: server.fetch });
    await expect(send({ method, path: "/v1/things" }, undefined, undefined)).resolves.toEqual({ done: true });
    expect(server.calls).toEqual([["https://books.example.com/v1/things", { method, headers: { accept: "application/json" } }]]);
  });

  it("puts the path parameters in the path, encoded, the query in the URL, the rest of the input in a JSON body, and the key in its header", async () => {
    const server = recording(() => Response.json({ id: "x" }, { status: 201 }));
    const send = createSend({ baseUrl: "https://books.example.com", fetch: server.fetch });
    const call: OperationCall = { method: "PATCH", path: "/v1/things/{thingId}/parts/{partId}", params: ["thingId", "partId"], query: ["view", "limit", "from"], body: true, key: true };
    const input = { thingId: "a/b c", partId: "ö", view: "long", limit: 5, from: undefined, name: "Kassa", note: undefined };
    await expect(send(call, input, { idempotencyKey: "k-1" })).resolves.toEqual({ id: "x" });
    expect(server.calls).toEqual([
      [
        "https://books.example.com/v1/things/a%2Fb%20c/parts/%C3%B6?view=long&limit=5",
        { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": "k-1" }, body: '{"name":"Kassa"}' },
      ],
    ]);
  });

  it("sends an empty body for a write whose input holds only its parameters, and no key when the call takes none", async () => {
    const server = recording(() => Response.json({}));
    const send = createSend({ baseUrl: "", fetch: server.fetch });
    await send({ method: "POST", path: "/v1/sign-ins", body: true }, {}, { idempotencyKey: "ignored" });
    expect(server.calls[0]?.[1]).toEqual({ method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" });
  });

  it("leaves out the query when none of its fields is given, and sends no body for a call that takes none", async () => {
    const server = recording(() => Response.json({}));
    const send = createSend({ baseUrl: "", fetch: server.fetch });
    await send({ method: "GET", path: "/v1/things", query: ["view"] }, { view: undefined }, undefined);
    expect(server.calls[0]).toEqual(["/v1/things", { method: "GET", headers: { accept: "application/json" } }]);
  });

  it("gives nothing for an answer without a body, 202 or 204, and reads no body", async () => {
    for (const status of [202, 204]) {
      const server = recording(() => new Response(null, { status }));
      const send = createSend({ baseUrl: "", fetch: server.fetch });
      await expect(send({ method: "POST", path: "/v1/letters", answer: "none" }, undefined, undefined)).resolves.toBeUndefined();
    }
  });

  it("asks fetch not to follow a 303, and gives its location", async () => {
    const server = recording(() => new Response(JSON.stringify({ location: "https://idp.example.com/authorize" }), { status: 303, headers: { location: "https://idp.example.com/authorize", "content-type": "application/json" } }));
    const send = createSend({ baseUrl: "", fetch: server.fetch });
    await expect(send({ method: "GET", path: "/v1/starts", answer: "redirect" }, undefined, undefined)).resolves.toEqual({ location: "https://idp.example.com/authorize" });
    expect(server.calls[0]?.[1]).toEqual({ method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
  });

  it("throws an ApiError for a redirect that answers anything but 303, with its problem details when it has them", async () => {
    const problem = { type: "about:blank", title: "Bad Request", status: 400, detail: "x", code: "invalid-request" };
    const answers = [
      () => Response.json({ location: "x" }),
      () => new Response(JSON.stringify(problem), { status: 400, headers: { "content-type": "application/problem+json" } }),
    ];
    for (const answer of answers) {
      const send = createSend({ baseUrl: "", fetch: recording(answer).fetch });
      await expect(send({ method: "GET", path: "/v1/starts", answer: "redirect" }, undefined, undefined)).rejects.toBeInstanceOf(ApiError);
    }
    const send = createSend({ baseUrl: "", fetch: recording(answers[0] ?? (() => Response.json({}))).fetch });
    await expect(send({ method: "GET", path: "/v1/starts", answer: "redirect" }, undefined, undefined)).rejects.toMatchObject({ status: 200, message: "GET /v1/starts answered 200." });
  });
});
