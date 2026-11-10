// SPDX-License-Identifier: AGPL-3.0-only

// The via in the behandlingshistorik (issue 12, Actors 2; plan 2.11): a
// write through an API token or from an MCP client records the person, the
// kind integration, and the token or the client it came through. The server
// sets nortfox.via_kind (api-token or mcp-client) and nortfox.via_id (the
// token's id, or the client's) with the actor. An integration always names
// one, and a user and the internal system user never do: the database
// refuses a write otherwise (actor_missing, naming the setting). A
// transaction keeps one via, as it keeps one actor: its first write keeps
// it, and a write under another is refused. A check on audit.history holds
// the same for every row, also one that no trigger wrote.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  expectError,
  expectRefusal,
  freshDatabase,
  inTransaction,
  type Settings,
  type TestDatabase,
} from "../../../test/database.ts";
import { addBooks, balanced, bookVoucher, someIntegration, someUser, writeVoucher, type Actor, type Books, type NewVoucher } from "../../../test/ledger.ts";

const ANOTHER_VIA = /A transaction keeps the token or the client it acts through/;

/** One history row, as the tests here read it. */
interface HistoryRow {
  readonly table_name: string;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly via_kind: string | null;
  readonly via_id: string | null;
  readonly channel: string | null;
}

describe("the via in the behandlingshistorik", () => {
  let db: TestDatabase;
  let app: Client;
  let books: Books;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    books = await addBooks(app);
  });

  afterAll(async () => {
    await db.close();
  });

  function aVoucher(): NewVoucher {
    return { year: books.year.id, series: "A", date: "2090-08-12", rows: balanced(900n, 1930, 3001) };
  }

  /** The history rows of the company, in the order they were written, as the app reads them. */
  async function history(): Promise<HistoryRow[]> {
    return inTransaction(app, { company: books.company }, async () => {
      const found = await app.query<HistoryRow>("SELECT table_name, actor_id, actor_kind, via_kind, via_id::text AS via_id, channel FROM audit.history ORDER BY id");
      return found.rows;
    });
  }

  /** What `work` added to the history. */
  async function added(work: () => Promise<unknown>): Promise<HistoryRow[]> {
    const before = await history();
    await work();
    return (await history()).slice(before.length);
  }

  const RENAME = "UPDATE ledger.accounts SET description = $2 WHERE fiscal_year_id = $1 AND number = 1930";

  /** A write of one history row, in a transaction of its own with `settings` in the company. */
  function rename(settings: Settings, description = "Bank"): Promise<unknown> {
    return inTransaction(app, { company: books.company, ...settings }, () => app.query(RENAME, [books.year.id, description]));
  }

  /** The statement that sets the via for the rest of the transaction. */
  const SWITCH = "SELECT pg_catalog.set_config('nortfox.via_kind', $1, true), pg_catalog.set_config('nortfox.via_id', $2, true)";

  it.each(["api-token", "mcp-client"] as const)("records the via %s of an integration, its kind and its id, on every history row of the transaction", async (viaKind) => {
    const who = someIntegration(randomUUID(), viaKind);
    const written = await added(() =>
      inTransaction(app, { company: books.company, ...who, channel: "rest" }, async () => {
        await writeVoucher(app, books.company, aVoucher());
        await app.query(RENAME, [books.year.id, "Bank"]);
      }),
    );
    // The voucher, its two rows, the counter's move and the account.
    expect(written).toHaveLength(5);
    expect(new Set(written.map((row) => JSON.stringify([row.actor_id, row.actor_kind, row.via_kind, row.via_id, row.channel])))).toEqual(
      new Set([JSON.stringify([who.actor, "integration", viaKind, who.viaId, "rest"])]),
    );
  });

  it("records no via for a user and for the internal system user", async () => {
    for (const who of [someUser(), { actor: randomUUID(), kind: "system" } as const]) {
      const written = await added(() => rename(who));
      expect(written).toEqual([{ table_name: "ledger.accounts", actor_id: who.actor, actor_kind: who.kind, via_kind: null, via_id: null, channel: null }]);
    }
  });

  it("refuses a write by an integration that names no via, with actor_missing, and writes nothing", async () => {
    const before = await history();
    const person = randomUUID();
    for (const settings of [{}, { viaKind: "" }, { viaKind: "", viaId: "" }, { viaId: "" }]) {
      await expectRefusal(rename({ actor: person, kind: "integration", ...settings }), "actor_missing", { setting: "nortfox.via_kind" });
    }
    // A whole booking too.
    await expectRefusal(
      inTransaction(app, { company: books.company, actor: person, kind: "integration", channel: "mcp" }, () => writeVoucher(app, books.company, aVoucher())),
      "actor_missing",
      { setting: "nortfox.via_kind" },
    );
    expect(await history()).toEqual(before);
  });

  it("takes both settings of a via or neither: a kind without an id, and an id without a kind, are refused", async () => {
    const before = await history();
    const person = randomUUID();
    await expectRefusal(rename({ actor: person, kind: "integration", viaKind: "api-token" }), "actor_missing", { setting: "nortfox.via_id" });
    await expectRefusal(rename({ actor: person, kind: "integration", viaKind: "mcp-client", viaId: "" }), "actor_missing", { setting: "nortfox.via_id" });
    await expectRefusal(rename({ actor: person, kind: "integration", viaId: randomUUID() }), "actor_missing", { setting: "nortfox.via_kind" });
    expect(await history()).toEqual(before);
  });

  it("takes a via only with the kind integration: a user and the system user that name one, or half of one, are refused", async () => {
    const before = await history();
    for (const kind of ["user", "system"]) {
      const actor = randomUUID();
      await expectRefusal(rename({ actor, kind, viaKind: "api-token", viaId: randomUUID() }), "actor_missing", { setting: "nortfox.via_kind" });
      await expectRefusal(rename({ actor, kind, viaKind: "mcp-client" }), "actor_missing", { setting: "nortfox.via_kind" });
      await expectRefusal(rename({ actor, kind, viaId: randomUUID() }), "actor_missing", { setting: "nortfox.via_id" });
    }
    expect(await history()).toEqual(before);
  });

  it("refuses a via kind it does not know, in any letter case or with a space", async () => {
    const before = await history();
    for (const viaKind of ["API-token", "Api-Token", "api_token", "token", "mcp", "client", " api-token", "api-token ", "service-account", "session"]) {
      await expectRefusal(rename({ actor: randomUUID(), kind: "integration", viaKind, viaId: randomUUID() }), "actor_missing", { setting: "nortfox.via_kind" });
    }
    expect(await history()).toEqual(before);
  });

  it("refuses a via id that is not a uuid", async () => {
    await expectError(rename({ actor: randomUUID(), kind: "integration", viaKind: "api-token", viaId: "nft_token" }), "22P02", /invalid input syntax for type uuid/);
  });

  /** Expects a write under the via `then` to be refused after a write under the via of `who`, in one transaction. */
  async function expectSwitchRefused(who: Actor, then: readonly [string, string]): Promise<void> {
    await expectError(
      inTransaction(app, { company: books.company, ...who }, async () => {
        await app.query(RENAME, [books.year.id, "Bank"]);
        await app.query(SWITCH, [...then]);
        await app.query(RENAME, [books.year.id, "Kassa"]);
      }),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_VIA,
    );
  }

  it("keeps the via of the transaction's first write, and refuses a write under another token or client, or another kind of via", async () => {
    const before = await history();
    const token = someIntegration();
    await expectSwitchRefused(token, ["api-token", randomUUID()]);
    await expectSwitchRefused(token, ["mcp-client", token.viaId ?? ""]);
    const client = someIntegration(randomUUID(), "mcp-client");
    await expectSwitchRefused(client, ["mcp-client", randomUUID()]);
    await expectSwitchRefused(client, ["api-token", client.viaId ?? ""]);
    // The same via again is the same actor.
    const kept = await added(() =>
      inTransaction(app, { company: books.company, ...token }, async () => {
        await app.query(RENAME, [books.year.id, "Bank"]);
        await app.query(SWITCH, [token.viaKind, token.viaId]);
        await app.query(RENAME, [books.year.id, "Kassa"]);
      }),
    );
    expect(kept.map((row) => [row.via_kind, row.via_id])).toEqual([
      ["api-token", token.viaId],
      ["api-token", token.viaId],
    ]);
    expect((await history()).slice(before.length)).toEqual(kept);
  });

  it("refuses a write that drops the via after the transaction's first write, as an integration without one", async () => {
    const token = someIntegration();
    await expectRefusal(
      inTransaction(app, { company: books.company, ...token }, async () => {
        await app.query(RENAME, [books.year.id, "Bank"]);
        await app.query(SWITCH, ["", ""]);
        await app.query(RENAME, [books.year.id, "Kassa"]);
      }),
      "actor_missing",
      { setting: "nortfox.via_kind" },
    );
  });

  it("refuses a change whose statement switches the via after the change was checked, before its history is written", async () => {
    const voucher = await bookVoucher(app, books.company, aVoucher());
    const before = await history();
    await expectError(
      inTransaction(app, { company: books.company, ...someIntegration() }, () =>
        app.query(
          `WITH changed AS (UPDATE ledger.vouchers SET description = 'Genom en annan token' WHERE id = $1 RETURNING id)
           SELECT pg_catalog.set_config('nortfox.via_id', $2, true) FROM changed`,
          [voucher.id, randomUUID()],
        ),
      ),
      INSUFFICIENT_PRIVILEGE,
      ANOTHER_VIA,
    );
    expect(await history()).toEqual(before);
  });

  it("lets a transaction take another via before its first write, and forgets the via of writes that a savepoint took back", async () => {
    const first = someIntegration();
    const then = someIntegration(first.actor, "mcp-client");
    const written = await added(() =>
      inTransaction(app, { company: books.company, ...first }, async () => {
        await app.query("SAVEPOINT first");
        await app.query(RENAME, [books.year.id, "Bank"]);
        await app.query("ROLLBACK TO SAVEPOINT first");
        await app.query(SWITCH, [then.viaKind, then.viaId]);
        await app.query(RENAME, [books.year.id, "Kassa och bank"]);
      }),
    );
    expect(written).toEqual([{ table_name: "ledger.accounts", actor_id: first.actor, actor_kind: "integration", via_kind: "mcp-client", via_id: then.viaId, channel: null }]);
  });

  describe("the check on audit.history", () => {
    let admin: Client;

    beforeAll(async () => {
      admin = await db.admin();
    });

    /**
     * Inserts a history row of the company straight into audit.history as
     * the superuser, past the history's own trigger, as no role of the
     * server can: so only the table's checks hold it.
     */
    async function insertPastTrigger(kind: string, viaKind: string | null, viaId: string | null): Promise<unknown> {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        return await admin.query(
          `INSERT INTO audit.history (company_id, table_name, row_id, operation, old_values, new_values, actor_id, actor_kind, via_kind, via_id, transaction_id, at)
           VALUES ($1, 'ledger.accounts', $2, 'INSERT', NULL, '{}', $3, $4, $5, $6, pg_catalog.pg_current_xact_id(), pg_catalog.clock_timestamp())`,
          [books.company, randomUUID(), randomUUID(), kind, viaKind, viaId],
        );
      } finally {
        await admin.query("ROLLBACK");
      }
    }

    it("holds a via exactly on a row of the kind integration, whole, and of a known kind", async () => {
      await expectError(insertPastTrigger("integration", null, null), CHECK_VIOLATION, /history_via_by_kind/);
      await expectError(insertPastTrigger("user", "api-token", randomUUID()), CHECK_VIOLATION, /history_via_by_kind/);
      await expectError(insertPastTrigger("system", "mcp-client", randomUUID()), CHECK_VIOLATION, /history_via_by_kind/);
      await expectError(insertPastTrigger("integration", "api-token", null), CHECK_VIOLATION, /history_via_whole/);
      await expectError(insertPastTrigger("integration", null, randomUUID()), CHECK_VIOLATION, /history_via_whole/);
      await expectError(insertPastTrigger("integration", "service-account", randomUUID()), CHECK_VIOLATION, /history_via_known/);
      // The probe itself: whole rows pass.
      for (const [kind, viaKind, viaId] of [
        ["integration", "api-token", randomUUID()],
        ["integration", "mcp-client", randomUUID()],
        ["user", null, null],
        ["system", null, null],
      ] as const) {
        expect(await insertPastTrigger(kind, viaKind, viaId)).toMatchObject({ rowCount: 1 });
      }
    });

    it("is validated on every row the history holds", async () => {
      const found = await admin.query<{ name: string; validated: boolean }>(
        `SELECT conname::text AS name, convalidated AS validated FROM pg_catalog.pg_constraint
         WHERE conrelid = 'audit.history'::pg_catalog.regclass AND conname LIKE 'history\\_via\\_%' ORDER BY 1`,
      );
      expect(found.rows).toEqual([
        { name: "history_via_by_kind", validated: true },
        { name: "history_via_known", validated: true },
        { name: "history_via_whole", validated: true },
      ]);
    });
  });
});
