// SPDX-License-Identifier: AGPL-3.0-only

// Each request runs in one transaction that sets the company, the actor, its
// kind and the channel with set_config(name, value, true), so a pooled
// connection never carries them to the next request. With a pool of one
// connection, the settings are empty on it after a request, and after one
// that failed: a read, a write, a write that throws, one its rule refuses and
// one the ledger refuses. Every history row of one request has one
// transaction id.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPool,
  bearer,
  bookingControls,
  buildTestApp,
  postVoucher,
  principalOf,
  problemIn,
  testHandlers,
  testResolver,
  voucherBody,
  type AppPool,
  type BookingControls,
} from "../../test/api.ts";
import { freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { addBooks, addCompany, setLock, type Books } from "../../test/ledger.ts";
import type { ServerApp } from "../app.ts";

interface Seen {
  readonly company: string;
  readonly actor: string;
  readonly kind: string;
  readonly channel: string;
  readonly pid: number;
}

const SEEN = `SELECT COALESCE(pg_catalog.current_setting('nortfox.company_id', true), '') AS company,
  COALESCE(pg_catalog.current_setting('nortfox.actor_id', true), '') AS actor,
  COALESCE(pg_catalog.current_setting('nortfox.actor_kind', true), '') AS kind,
  COALESCE(pg_catalog.current_setting('nortfox.channel', true), '') AS channel,
  pg_catalog.pg_backend_pid() AS pid`;

describe("one transaction per request, on a pool of one connection", () => {
  let db: TestDatabase;
  let app: Client;
  let company: string;
  let books: Books;
  let locked: Books;
  let pool: AppPool;
  let controls: BookingControls;
  let server: ServerApp;
  const reported: unknown[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    company = await addCompany(app);
    books = await addBooks(app);
    locked = await addBooks(app);
    await setLock(app, locked.company, "integration", "2090-12-31");
    pool = appPool(db, 1);
    controls = bookingControls();
    server = buildTestApp({
      database: pool.database,
      resolve: testResolver({
        reader: principalOf(company, { kind: "integration" }),
        // A company the database does not hold: its read finds no row, and fails.
        stranger: principalOf(randomUUID(), { kind: "user" }),
        writer: principalOf(books.company, { kind: "user" }),
        // An integration in a company whose period is locked for integrations.
        lockedOut: principalOf(locked.company, { kind: "integration" }),
      }),
      handlers: testHandlers(controls),
      report: (error) => reported.push(error),
    });
  });

  afterAll(async () => {
    await pool.pool.end();
    await db.close();
  });

  /** What the pool's one connection holds now. */
  async function seen(): Promise<Seen> {
    const connection = await pool.pool.connect();
    try {
      const found = await connection.query<Seen>(SEEN);
      const [row] = found.rows;
      if (row === undefined) {
        throw new Error("The connection gave no settings.");
      }
      return row;
    } finally {
      connection.release();
    }
  }

  it("leaves no company, actor, kind or channel on the connection after a read, and after one that failed", async () => {
    const before = await seen();
    expect(before).toEqual({ company: "", actor: "", kind: "", channel: "", pid: before.pid });

    const read = await server.hono.request("/v1/company", { headers: bearer("reader") });
    expect(read.status).toBe(200);
    expect(await seen()).toEqual(before);

    const failed = await server.hono.request("/v1/company", { headers: bearer("stranger") });
    expect(failed.status).toBe(500);
    expect(await problemIn(failed)).toMatchObject({ code: "internal-error" });
    expect(String(reported.at(-1))).toContain("company");
    expect(await seen()).toEqual(before);

    const list = await server.hono.request("/v1/test-accounts", { headers: bearer("reader") });
    expect(list.status).toBe(200);
    expect(await seen()).toEqual(before);
    expect(pool.pool.totalCount).toBe(1);
    expect(pool.errors).toEqual([]);
  });

  it("leaves none after a write, a write that throws, one its rule refuses and one the ledger refuses", async () => {
    const before = await seen();

    const written = await postVoucher(server.hono, "writer", randomUUID());
    expect(written.status).toBe(201);
    expect(await seen()).toEqual(before);

    controls.failOnce = true;
    const thrown = await postVoucher(server.hono, "writer", randomUUID());
    expect(thrown.status).toBe(500);
    expect(String(reported.at(-1))).toContain("The test made the booking fail after it booked.");
    expect(await seen()).toEqual(before);

    const ruled = await postVoucher(server.hono, "writer", randomUUID(), voucherBody("0.00"));
    expect(ruled.status).toBe(422);
    expect(await problemIn(ruled)).toMatchObject({ code: "amount-not-positive" });
    expect(await seen()).toEqual(before);

    const lockedOut = await postVoucher(server.hono, "lockedOut", randomUUID());
    expect(lockedOut.status).toBe(422);
    expect(await problemIn(lockedOut)).toMatchObject({ code: "period-locked-manual" });
    expect(await seen()).toEqual(before);

    expect(pool.pool.totalCount).toBe(1);
    expect(pool.errors).toEqual([]);
  });

  it("gives every history row of one request one transaction id", async () => {
    const history = async (): Promise<{ table_name: string; operation: string; transaction_id: string }[]> =>
      inTransaction(app, { company: books.company }, async () => {
        const found = await app.query<{ table_name: string; operation: string; transaction_id: string }>(
          "SELECT table_name, operation, transaction_id::text AS transaction_id FROM audit.history ORDER BY id",
        );
        return found.rows;
      });
    const before = await history();
    expect((await postVoucher(server.hono, "writer", randomUUID())).status).toBe(201);
    const rows = (await history()).slice(before.length);
    expect(rows.map((row) => `${row.operation} ${row.table_name}`).sort()).toEqual([
      "INSERT ledger.idempotency_keys",
      "INSERT ledger.voucher_rows",
      "INSERT ledger.voucher_rows",
      "INSERT ledger.vouchers",
      "UPDATE ledger.voucher_counters",
    ]);
    expect(new Set(rows.map((row) => row.transaction_id)).size).toBe(1);
  });
});
