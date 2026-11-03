// SPDX-License-Identifier: AGPL-3.0-only

// getCompany gives the request's company from 2a's company table: the same
// by REST, by the generated client and through its handler with no HTTP
// request. An actor without company:read gets the same refusal on each, with
// the stable code permission-missing. (MCP comes with /mcp.)

import { ApiError, createClient, type FetchFunction } from "@nortfox/client";
import type { Company } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_KEY, appPool, bearer, buildTestApp, principalOf, problemIn, testResolver, type AppPool } from "../../../test/api.ts";
import { failureOf, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addCompany } from "../../../test/ledger.ts";
import type { RequestContext } from "../../api/context.ts";
import { runOperation } from "../../api/operation.ts";
import type { ServerApp } from "../../app.ts";
import { getCompanyHandler } from "./get-company.ts";

/** A fetch for the generated client that calls the app, with the token's credential. */
function fetchFrom(app: ServerApp, token: string): FetchFunction {
  return (input, init) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", bearer(token).authorization);
    return Promise.resolve(app.hono.request(input, { ...init, headers }));
  };
}

describe("getCompany", () => {
  let db: TestDatabase;
  let app: Client;
  let company: string;
  let expected: Company;
  let pool: AppPool;
  let server: ServerApp;
  const reader = { kind: "user" as const };

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    company = await addCompany(app);
    const found = await inTransaction(app, { company }, () =>
      app.query<{ database_number: number }>("SELECT database_number FROM ledger.companies WHERE company_id = $1", [company]),
    );
    expected = {
      id: company,
      name: "Testbolaget Alfa AB",
      organizationNumber: "556000-0167",
      databaseNumber: found.rows[0]?.database_number ?? 0,
    };
    pool = appPool(db, 2);
    server = buildTestApp({
      database: pool.database,
      resolve: testResolver({
        reader: principalOf(company, { ...reader, permissions: ["company:read"] }),
        outsider: principalOf(company, { ...reader, permissions: ["test:read"] }),
      }),
    });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  it("reads a company the database numbered", () => {
    expect(expected.databaseNumber).toBeGreaterThan(0);
  });

  it("gives the same company by REST, by the generated client and through its handler with no HTTP request", async () => {
    const response = await server.hono.request("/v1/company", { headers: bearer("reader") });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);

    const client = createClient({ baseUrl: "http://nortfox.test", fetch: fetchFrom(server, "reader") });
    expect(await client.getCompany()).toEqual(expected);

    const context: RequestContext = { ...principalOf(company, { ...reader, permissions: ["company:read"] }), channel: "rest" };
    const outcome = await runOperation(
      getCompanyHandler,
      { context, input: { query: {}, body: undefined }, idempotency: "none" },
      { database: pool.database, cursorKey: CURSOR_KEY },
    );
    expect(outcome).toEqual({ ok: true, status: 200, output: expected });
  });

  it("refuses its handler for an actor without the permission, with the stable code permission-missing and the permission", async () => {
    const context: RequestContext = { ...principalOf(company, { ...reader, permissions: ["test:read"] }), channel: "rest" };
    const outcome = await runOperation(
      getCompanyHandler,
      { context, input: { query: {}, body: undefined }, idempotency: "none" },
      { database: pool.database, cursorKey: CURSOR_KEY },
    );
    expect(outcome).toEqual({ ok: false, refusal: { kind: "permission-missing", permission: "company:read" } });
  });

  it("refuses an actor without company:read with the same problem details by REST and by the generated client", async () => {
    const response = await server.hono.request("/v1/company", { headers: bearer("outsider") });
    expect(response.status).toBe(403);
    const problem = await problemIn(response);
    expect(problem).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: "The actor lacks the permission company:read, which this operation needs.",
      code: "permission-missing",
      permission: "company:read",
    });

    const client = createClient({ baseUrl: "http://nortfox.test", fetch: fetchFrom(server, "outsider") });
    const error = await failureOf(client.getCompany());
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, problem });
  });
});
