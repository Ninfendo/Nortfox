// SPDX-License-Identifier: AGPL-3.0-only

// The channel in the behandlingshistorik: through which client a change came,
// as the plan's audit module asks. The server sets nortfox.channel for each
// transaction, with the company, the actor and its kind. A transaction keeps
// one channel, as it keeps one actor: its first write keeps it, and a write
// under another channel is refused, in a later statement or later in the
// same statement. A write that sets no channel, such as one of the owner's
// tools, records NULL. A write through the API records its request's actor,
// kind and channel.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, buildTestApp, callTool, mcpClient, postVoucher, principalOf, testResolver, voucherBody } from "../../../test/api.ts";
import { CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE, expectError, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { CHANNELS } from "../../../test/every-table.ts";
import { addBooks, balanced, bookVoucher, someUser, writeVoucher, type Actor, type Books, type NewVoucher } from "../../../test/ledger.ts";

const ANOTHER_CHANNEL = /A transaction keeps one channel/;

/** One history row, as the tests here read it. */
interface HistoryRow {
  readonly table_name: string;
  readonly operation: string;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly channel: string | null;
}

describe("the channel in the behandlingshistorik", () => {
  let db: TestDatabase;
  let app: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  function aVoucher(books: Books): NewVoucher {
    return { year: books.year.id, series: "A", date: "2090-08-12", rows: balanced(900n, 1930, 3001) };
  }

  /** The history rows of `company`, in the order they were written, as the app reads them. */
  async function historyOf(company: string): Promise<HistoryRow[]> {
    return inTransaction(app, { company }, async () => {
      const found = await app.query<HistoryRow>("SELECT table_name, operation, actor_id, actor_kind, channel FROM audit.history ORDER BY id");
      return found.rows;
    });
  }

  /** What `work` added to the history of `company`. */
  async function added(company: string, work: () => Promise<unknown>): Promise<HistoryRow[]> {
    const before = await historyOf(company);
    await work();
    return (await historyOf(company)).slice(before.length);
  }

  const RENAME = "UPDATE ledger.accounts SET description = $2 WHERE fiscal_year_id = $1 AND number = 1930";

  /** The statement that sets the channel for the rest of the transaction, as the server does. */
  const SWITCH = "SELECT pg_catalog.set_config('nortfox.channel', $1, true)";

  it.each(CHANNELS)("records the channel %s that the transaction sets, with its actor and kind, on every history row of the transaction", async (channel) => {
    const books = await addBooks(app);
    for (const who of [someUser(), { actor: someUser().actor, kind: "integration" } as const]) {
      const written = await added(books.company, () =>
        inTransaction(app, { company: books.company, ...who, channel }, async () => {
          await writeVoucher(app, books.company, aVoucher(books));
          await app.query(RENAME, [books.year.id, "Bank"]);
        }),
      );
      // The voucher, its two rows, the counter's move and the account.
      expect(written.map((row) => `${row.operation} ${row.table_name}`).sort()).toEqual([
        "INSERT ledger.voucher_rows",
        "INSERT ledger.voucher_rows",
        "INSERT ledger.vouchers",
        "UPDATE ledger.accounts",
        "UPDATE ledger.voucher_counters",
      ]);
      expect(new Set(written.map((row) => JSON.stringify([row.actor_id, row.actor_kind, row.channel])))).toEqual(
        new Set([JSON.stringify([who.actor, who.kind, channel])]),
      );
    }
  });

  it("records no channel when the transaction sets none, or an empty one", async () => {
    const books = await addBooks(app);
    const who = someUser();
    for (const settings of [{}, { channel: "" }]) {
      const written = await added(books.company, () =>
        inTransaction(app, { company: books.company, ...who, ...settings }, () => app.query(RENAME, [books.year.id, "Bank"])),
      );
      expect(written).toEqual([{ table_name: "ledger.accounts", operation: "UPDATE", actor_id: who.actor, actor_kind: "user", channel: null }]);
    }
  });

  it("refuses an unknown channel, and writes nothing", async () => {
    const books = await addBooks(app);
    const before = await historyOf(books.company);
    for (const channel of ["web", "REST", "Mcp", " rest", "rest ", "sie", "rest,mcp"]) {
      await expectError(
        inTransaction(app, { company: books.company, ...someUser(), channel }, () => app.query(RENAME, [books.year.id, channel])),
        CHECK_VIOLATION,
        /history_channel_known/,
      );
    }
    expect(await historyOf(books.company)).toEqual(before);
  });

  /** Expects a write under the channel `then` to be refused after a write under `first`, in one transaction of `who`. */
  async function expectSwitchRefused(books: Books, who: Actor, first: string, then: string): Promise<void> {
    await expectError(
      inTransaction(app, { company: books.company, ...who, channel: first }, async () => {
        await app.query(RENAME, [books.year.id, "Bank"]);
        await app.query(SWITCH, [then]);
        await app.query(RENAME, [books.year.id, "Kassa"]);
      }),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_CHANNEL,
    );
  }

  it("refuses a write under another channel than the transaction's first write had, and under none after one", async () => {
    const books = await addBooks(app);
    const before = await historyOf(books.company);
    const who = someUser();
    await expectSwitchRefused(books, who, "rest", "mcp");
    await expectSwitchRefused(books, who, "mcp", "rest");
    await expectSwitchRefused(books, who, "rest", "");
    await expectSwitchRefused(books, who, "", "mcp");
    expect(await historyOf(books.company)).toEqual(before);
  });

  it("refuses a change whose statement switches the channel after the change was checked, before its history is written", async () => {
    const books = await addBooks(app);
    const voucher = await bookVoucher(app, books.company, aVoucher(books));
    const before = await historyOf(books.company);
    await expectError(
      inTransaction(app, { company: books.company, ...someUser(), channel: "rest" }, () =>
        app.query(
          `WITH changed AS (UPDATE ledger.vouchers SET description = 'Genom en annan kanal' WHERE id = $1 RETURNING id)
           SELECT pg_catalog.set_config('nortfox.channel', 'mcp', true) FROM changed`,
          [voucher.id],
        ),
      ),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_CHANNEL,
    );
    expect(await historyOf(books.company)).toEqual(before);
  });

  it("records a write through REST by an integration: its actor, the kind integration and the channel rest on every history row of the request", async () => {
    const books = await addBooks(app);
    const actor = randomUUID();
    const pool = appPool(db, 1);
    try {
      const { hono } = buildTestApp({
        database: pool.database,
        resolve: testResolver({ integration: principalOf(books.company, { personId: actor, kind: "integration" }) }),
      });
      let voucher = "";
      const written = await added(books.company, async () => {
        const response = await postVoucher(hono, "integration", randomUUID());
        expect(response.status).toBe(201);
        voucher = ((await response.json()) as { id: string }).id;
      });
      // The voucher, its two rows, the counter's move and the key.
      expect(written.map((row) => `${row.operation} ${row.table_name}`).sort()).toEqual([
        "INSERT ledger.idempotency_keys",
        "INSERT ledger.voucher_rows",
        "INSERT ledger.voucher_rows",
        "INSERT ledger.vouchers",
        "UPDATE ledger.voucher_counters",
      ]);
      expect(new Set(written.map((row) => JSON.stringify([row.actor_id, row.actor_kind, row.channel])))).toEqual(
        new Set([JSON.stringify([actor, "integration", "rest"])]),
      );
      const ofVoucher = await inTransaction(app, { company: books.company }, () =>
        app.query<{ table_name: string }>(
          `SELECT table_name FROM audit.history
           WHERE row_id = $1::uuid OR row_id IN (SELECT id FROM ledger.voucher_rows WHERE voucher_id = $1::uuid) ORDER BY id`,
          [voucher],
        ),
      );
      expect(ofVoucher.rows.map((row) => row.table_name)).toEqual(["ledger.vouchers", "ledger.voucher_rows", "ledger.voucher_rows"]);
    } finally {
      await pool.pool.end();
    }
  });

  it("records a write through MCP by a user: its actor, the kind user and the channel mcp on every history row of the request", async () => {
    const books = await addBooks(app);
    const actor = randomUUID();
    const pool = appPool(db, 1);
    try {
      const server = buildTestApp({
        database: pool.database,
        resolve: testResolver({ user: principalOf(books.company, { personId: actor, kind: "user" }) }),
      });
      const client = await mcpClient(server, { token: "user" });
      let voucher = "";
      const written = await added(books.company, async () => {
        const answer = await callTool(client, "testBookVoucher", { ...voucherBody(), idempotencyKey: randomUUID() });
        expect(answer.isError).toBe(false);
        voucher = (answer.structured as { id: string }).id;
      });
      await client.close();
      // The voucher, its two rows, the counter's move and the key.
      expect(written.map((row) => `${row.operation} ${row.table_name}`).sort()).toEqual([
        "INSERT ledger.idempotency_keys",
        "INSERT ledger.voucher_rows",
        "INSERT ledger.voucher_rows",
        "INSERT ledger.vouchers",
        "UPDATE ledger.voucher_counters",
      ]);
      expect(new Set(written.map((row) => JSON.stringify([row.actor_id, row.actor_kind, row.channel])))).toEqual(
        new Set([JSON.stringify([actor, "user", "mcp"])]),
      );
      const ofVoucher = await inTransaction(app, { company: books.company }, () =>
        app.query<{ table_name: string }>(
          `SELECT table_name FROM audit.history
           WHERE row_id = $1::uuid OR row_id IN (SELECT id FROM ledger.voucher_rows WHERE voucher_id = $1::uuid) ORDER BY id`,
          [voucher],
        ),
      );
      expect(ofVoucher.rows.map((row) => row.table_name)).toEqual(["ledger.vouchers", "ledger.voucher_rows", "ledger.voucher_rows"]);
    } finally {
      await pool.pool.end();
    }
  });

  it("lets a transaction take another channel before its first write, and forgets the channel of writes that a savepoint took back", async () => {
    const books = await addBooks(app);
    const who = someUser();
    const written = await added(books.company, () =>
      inTransaction(app, { company: books.company, ...who, channel: "rest" }, async () => {
        await app.query(SWITCH, ["mcp"]);
        await app.query("SAVEPOINT first");
        await app.query(RENAME, [books.year.id, "Bank"]);
        await app.query("ROLLBACK TO SAVEPOINT first");
        await app.query(SWITCH, ["rest"]);
        await app.query(RENAME, [books.year.id, "Kassa och bank"]);
      }),
    );
    expect(written).toEqual([{ table_name: "ledger.accounts", operation: "UPDATE", actor_id: who.actor, actor_kind: "user", channel: "rest" }]);
  });
});
