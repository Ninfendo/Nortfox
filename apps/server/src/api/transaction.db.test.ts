// SPDX-License-Identifier: AGPL-3.0-only

// Each request runs in one transaction that sets the company, the actor, its
// kind and the channel with set_config(name, value, true), so a pooled
// connection never carries them to the next request. With a pool of one
// connection, the settings are empty on it after a request, and after one
// that failed. (The writes' cases come with the writes.)

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, bearer, buildTestApp, principalOf, problemIn, testResolver, type AppPool } from "../../test/api.ts";
import { freshDatabase, type TestDatabase } from "../../test/database.ts";
import { addCompany } from "../../test/ledger.ts";
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
  let pool: AppPool;
  let server: ServerApp;
  const reported: unknown[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    company = await addCompany(app);
    pool = appPool(db, 1);
    server = buildTestApp({
      database: pool.database,
      resolve: testResolver({
        reader: principalOf(company, { kind: "integration" }),
        // A company the database does not hold: its read finds no row, and fails.
        stranger: principalOf(randomUUID(), { kind: "user" }),
      }),
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

  it("leaves no company, actor, kind or channel on the connection after a request, and after one that failed", async () => {
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
});
