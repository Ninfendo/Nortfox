// SPDX-License-Identifier: AGPL-3.0-only

// The runner on PostgreSQL, as the app role. A read: one transaction at
// REPEATABLE READ READ ONLY with the request's company, actor, kind and
// channel; a handler that cannot write; the output checked inside the
// transaction, so a bad output is a fault of the server (500); and no
// connection taken for a call that is refused before its transaction. A
// write: one transaction at READ COMMITTED with the same settings, and with
// the key policy none, as the compatible surface will pass it, a write on
// every call and no key stored.

import { CHALLENGES, defineOperation } from "@nortfox/contract";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  appPool,
  bearer,
  buildTestApp,
  principalOf,
  problemIn,
  runnerDeps,
  testBookVoucherHandler,
  testResolver,
  voucherBody,
  writtenIn,
  type AppPool,
} from "../../test/api.ts";
import { failureOf, freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { addBooks, addCompany, type Books } from "../../test/ledger.ts";
import type { Database } from "../db/database.ts";
import { getCompanyHandler } from "../modules/companies/get-company.ts";
import type { PrincipalKind, RequestContext } from "./context.ts";
import { handleData, ok, runOperation, type OperationCall } from "./operation.ts";

/** The challenge of the session cookie, the one credential in this part. */
const SESSION_CHALLENGE = CHALLENGES.sessionCookie;

/** PostgreSQL's SQLSTATE for a write in a READ ONLY transaction. */
const READ_ONLY_SQL_TRANSACTION = "25006";

const Settings = z.strictObject({
  level: z.string(),
  readOnly: z.string(),
  company: z.string(),
  actor: z.string(),
  kind: z.string(),
  channel: z.string(),
  viaKind: z.string(),
  viaId: z.string(),
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
       pg_catalog.current_setting('nortfox.actor_kind') AS kind, pg_catalog.current_setting('nortfox.channel') AS channel,
       pg_catalog.current_setting('nortfox.via_kind') AS "viaKind", pg_catalog.current_setting('nortfox.via_id') AS "viaId"`,
  );
  return ok(found.rows[0] ?? { level: "", readOnly: "", company: "", actor: "", kind: "", channel: "", viaKind: "", viaId: "" });
});

const writeInRead = handleData(testReadSettings, async ({ tx }) => {
  await tx.query("UPDATE ledger.companies SET name = 'Testbolaget Beta AB'");
  return ok({ level: "", readOnly: "", company: "", actor: "", kind: "", channel: "", viaKind: "", viaId: "" });
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
    // A company whose organisation number has a form the output's schema refuses.
    // The number never changes, so the company is made with it.
    broken = await addCompany(app, undefined, { organizationNumber: "saknas" });
    pool = appPool(db, 1);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  async function contextIn(companyId: string, permissions?: readonly string[]): Promise<RequestContext> {
    return { ...(await principalOf(companyId, { kind: "user", ...(permissions === undefined ? {} : { permissions }) })), channel: "rest" };
  }

  it("runs a read in one transaction at REPEATABLE READ READ ONLY, with the request's company, actor, kind, no via for a user, and channel", async () => {
    const context = await contextIn(company);
    const outcome = await runOperation(readSettings, call(context), runnerDeps(pool.database));
    expect(outcome).toEqual({
      ok: true,
      status: 200,
      output: { level: "repeatable read", readOnly: "on", company, actor: context.personId, kind: "user", channel: "rest", viaKind: "", viaId: "" },
    });
  });

  it("lets a read handler write nothing", async () => {
    const error = await failureOf(runOperation(writeInRead, call(await contextIn(company)), runnerDeps(pool.database)));
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
      person: () => Promise.reject(new Error("A read in the credential's company is no person's transaction.")),
      lookup: () => Promise.reject(new Error("A read looks nothing up.")),
      end: () => Promise.resolve(),
    };
    const error = await failureOf(runOperation(getCompanyHandler, call(await contextIn(broken)), runnerDeps(watching)));
    expect(String(error)).toContain("The output of getCompany does not fit its schema: /organizationNumber");
    expect(inside).toEqual([error]);
  });

  it("answers a read handler's bad output with 500, and reports it", async () => {
    const reported: unknown[] = [];
    const { hono } = buildTestApp({
      database: pool.database,
      resolve: testResolver({ broken: await principalOf(broken) }),
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
      const deps = runnerDeps(pool.database);
      expect(await runOperation(readSettings, call(undefined), deps)).toEqual({ ok: false, refusal: { kind: "authentication-required", challenge: SESSION_CHALLENGE } });
      expect(await runOperation(readSettings, call(await contextIn(company, [])), deps)).toEqual({
        ok: false,
        refusal: { kind: "permission-missing", permission: "test:read" },
      });
      expect(await runOperation(readSettings, call(await contextIn(company), { x: 1 }), deps)).toMatchObject({ ok: false, refusal: { kind: "invalid" } });
      const write = await runOperation(testBookVoucherHandler(), { context: await contextIn(company), input: { query: {}, body: voucherBody() }, idempotency: { key: undefined } }, deps);
      expect(write).toMatchObject({ ok: false, refusal: { kind: "invalid", problems: [{ code: "idempotency-key-missing" }] } });
    } finally {
      held.release();
    }
  });
});

describe("the runner's write path", () => {
  let db: TestDatabase;
  let app: Client;
  let books: Books;
  let pool: AppPool;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    books = await addBooks(app);
    pool = appPool(db, 1);
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  const testWriteSettings = defineOperation({
    id: "testWriteSettings",
    method: "post",
    path: "/v1/test-settings",
    tags: ["test"],
    summary: "Read a write's settings",
    description: "Gives the isolation level and the settings of a write's transaction. Only the tests run it.",
    output: Settings,
    permission: "test:write",
    tool: "Gives a write's settings. Only the tests run it.",
    writes: true,
  });

  const writeSettings = handleData(testWriteSettings, async ({ tx }) => {
    const found = await tx.query<z.infer<typeof Settings>>(
      `SELECT pg_catalog.current_setting('transaction_isolation') AS level, pg_catalog.current_setting('transaction_read_only') AS "readOnly",
         pg_catalog.current_setting('nortfox.company_id') AS company, pg_catalog.current_setting('nortfox.actor_id') AS actor,
         pg_catalog.current_setting('nortfox.actor_kind') AS kind, pg_catalog.current_setting('nortfox.channel') AS channel,
         pg_catalog.current_setting('nortfox.via_kind') AS "viaKind", pg_catalog.current_setting('nortfox.via_id') AS "viaId"`,
    );
    return ok(found.rows[0] ?? { level: "", readOnly: "", company: "", actor: "", kind: "", channel: "", viaKind: "", viaId: "" });
  });

  async function contextOf(kind: PrincipalKind): Promise<RequestContext> {
    return { ...(await principalOf(books.company, { kind })), channel: "rest" };
  }

  it("runs a write in one transaction at READ COMMITTED, with the request's company, actor, kind, via and channel", async () => {
    const context = await contextOf("integration");
    const outcome = await runOperation(writeSettings, { context, input: { query: {}, body: undefined }, idempotency: "none" }, runnerDeps(pool.database));
    expect(outcome).toEqual({
      ok: true,
      status: 200,
      output: { level: "read committed", readOnly: "off", company: books.company, actor: context.personId, kind: "integration", channel: "rest", viaKind: "api-token", viaId: context.via?.id },
    });
  });

  it("with the key policy none runs a write on every call, and stores no key and no history row of one", async () => {
    const before = await writtenIn(app, books.company);
    const none: OperationCall = { context: await contextOf("user"), input: { query: {}, body: voucherBody() }, idempotency: "none" };
    const deps = runnerDeps(pool.database);
    const first = await runOperation(testBookVoucherHandler(), none, deps);
    const second = await runOperation(testBookVoucherHandler(), none, deps);
    expect(first).toMatchObject({ ok: true, status: 201, output: { amount: { amount: "125.00", currency: "SEK" } } });
    expect(second).toMatchObject({ ok: true, status: 201, output: { amount: { amount: "125.00", currency: "SEK" } } });
    const after = await writtenIn(app, books.company);
    expect(after.vouchers.slice(before.vouchers.length).map((voucher) => voucher.id)).toEqual([
      (first as { output: { id: string } }).output.id,
      (second as { output: { id: string } }).output.id,
    ]);
    expect(after.keys).toEqual(before.keys);
    const keyHistory = await inTransaction(app, { company: books.company }, () =>
      app.query("SELECT 1 FROM audit.history WHERE table_name = 'ledger.idempotency_keys'"),
    );
    expect(keyHistory.rows).toEqual([]);
  });
});
