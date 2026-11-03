// SPDX-License-Identifier: AGPL-3.0-only

// The runner's read path on PostgreSQL, as the app role: one transaction at
// REPEATABLE READ READ ONLY with the request's company, actor, kind and
// channel; a handler that cannot write; the output checked inside the
// transaction, so a bad output is a fault of the server (500); and no
// connection taken for a call that is refused before its transaction.

import { defineOperation } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CURSOR_KEY, appPool, bearer, buildTestApp, principalOf, problemIn, testResolver, type AppPool } from "../../test/api.ts";
import { failureOf, freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { addCompany } from "../../test/ledger.ts";
import type { Database } from "../db/database.ts";
import { getCompanyHandler } from "../modules/companies/get-company.ts";
import type { RequestContext } from "./context.ts";
import { handleData, ok, runOperation, type OperationCall } from "./operation.ts";

/** PostgreSQL's SQLSTATE for a write in a READ ONLY transaction. */
const READ_ONLY_SQL_TRANSACTION = "25006";

const Settings = z.strictObject({
  level: z.string(),
  readOnly: z.string(),
  company: z.string(),
  actor: z.string(),
  kind: z.string(),
  channel: z.string(),
});

const testReadSettings = defineOperation({
  id: "testReadSettings",
  method: "get",
  path: "/v1/test-settings",
  tags: ["test"],
  summary: "Read the transaction's settings",
  description: "Gives the transaction's isolation level and settings. Only the tests run it.",
  output: Settings,
  permission: "test:read",
  tool: "Gives the transaction's settings. Only the tests run it.",
  writes: false,
});

const readSettings = handleData(testReadSettings, async ({ tx }) => {
  const found = await tx.query<z.infer<typeof Settings>>(
    `SELECT pg_catalog.current_setting('transaction_isolation') AS level, pg_catalog.current_setting('transaction_read_only') AS "readOnly",
       pg_catalog.current_setting('nortfox.company_id') AS company, pg_catalog.current_setting('nortfox.actor_id') AS actor,
       pg_catalog.current_setting('nortfox.actor_kind') AS kind, pg_catalog.current_setting('nortfox.channel') AS channel`,
  );
  return ok(found.rows[0] ?? { level: "", readOnly: "", company: "", actor: "", kind: "", channel: "" });
});

const writeInRead = handleData(testReadSettings, async ({ tx }) => {
  await tx.query("INSERT INTO ledger.companies (company_id, name, organization_number) VALUES (gen_random_uuid(), 'Testbolaget Beta AB', '599999-0129')");
  return ok({ level: "", readOnly: "", company: "", actor: "", kind: "", channel: "" });
});

function call(context: RequestContext | undefined, query: Record<string, unknown> = {}): OperationCall {
  return { context, input: { query, body: undefined }, idempotency: "none" };
}

describe("the runner's read path", () => {
  let db: TestDatabase;
  let app: Client;
  let company: string;
  let broken: string;
  let pool: AppPool;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    company = await addCompany(app);
    broken = await addCompany(app);
    // A row whose organisation number has a form the output's schema refuses.
    await inTransaction(app, { company: broken, actor: principalOf(broken).actorId, kind: "user" }, () =>
      app.query("UPDATE ledger.companies SET organization_number = 'saknas'"),
    );
    pool = appPool(db, 1);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  function contextIn(companyId: string, permissions?: readonly string[]): RequestContext {
    return { ...principalOf(companyId, { kind: "user", ...(permissions === undefined ? {} : { permissions }) }), channel: "rest" };
  }

  it("runs a read in one transaction at REPEATABLE READ READ ONLY, with the request's company, actor, kind and channel", async () => {
    const context = contextIn(company);
    const outcome = await runOperation(readSettings, call(context), { database: pool.database, cursorKey: CURSOR_KEY });
    expect(outcome).toEqual({
      ok: true,
      status: 200,
      output: { level: "repeatable read", readOnly: "on", company, actor: context.actorId, kind: "user", channel: "rest" },
    });
  });

  it("lets a read handler write nothing", async () => {
    const error = await failureOf(runOperation(writeInRead, call(contextIn(company)), { database: pool.database, cursorKey: CURSOR_KEY }));
    expect(error).toMatchObject({ code: READ_ONLY_SQL_TRANSACTION });
  });

  it("checks a read's output inside its transaction, and throws on one that does not fit", async () => {
    const inside: unknown[] = [];
    const watching: Database = {
      read: (settings, work) =>
        pool.database.read(settings, async (tx) => {
          try {
            return await work(tx);
          } catch (error) {
            inside.push(error);
            throw error;
          }
        }),
      write: () => Promise.reject(new Error("A read never writes.")),
      end: () => Promise.resolve(),
    };
    const error = await failureOf(runOperation(getCompanyHandler, call(contextIn(broken)), { database: watching, cursorKey: CURSOR_KEY }));
    expect(String(error)).toContain("The output of getCompany does not fit its schema: /organizationNumber");
    expect(inside).toEqual([error]);
  });

  it("answers a read handler's bad output with 500, and reports it", async () => {
    const reported: unknown[] = [];
    const { hono } = buildTestApp({
      database: pool.database,
      resolve: testResolver({ broken: principalOf(broken) }),
      report: (error) => reported.push(error),
    });
    const response = await hono.request("/v1/company", { headers: bearer("broken") });
    expect(response.status).toBe(500);
    expect(await problemIn(response)).toMatchObject({ code: "internal-error" });
    expect(String(reported[0])).toContain("The output of getCompany does not fit its schema");
  });

  it("takes no connection for a call that is refused before its transaction", async () => {
    // The pool's one connection is busy, so a call that asked for one would wait.
    const held = await pool.pool.connect();
    try {
      const deps = { database: pool.database, cursorKey: CURSOR_KEY };
      expect(await runOperation(readSettings, call(undefined), deps)).toEqual({ ok: false, refusal: { kind: "authentication-required" } });
      expect(await runOperation(readSettings, call(contextIn(company, [])), deps)).toEqual({
        ok: false,
        refusal: { kind: "permission-missing", permission: "test:read" },
      });
      expect(await runOperation(readSettings, call(contextIn(company), { x: 1 }), deps)).toMatchObject({ ok: false, refusal: { kind: "invalid" } });
    } finally {
      held.release();
    }
  });
});
