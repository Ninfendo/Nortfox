// SPDX-License-Identifier: AGPL-3.0-only

// The behandlingshistorik of a voucher (rules 25 and 41 of the slice): after
// each kind of change (the description, the date, a row text, an added row, a
// strike), it holds each earlier value of the voucher and its rows, with the
// actor and the time. So every earlier version can be read from it: this
// test rebuilds each one from the history alone and compares it with what
// the tables held at that moment.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addBooks, balanced, someIntegration, someUser, writeRow, type Actor } from "../../../test/ledger.ts";

type Row = Record<string, unknown>;

/** A voucher and its rows, as JSON, the rows by their id. */
interface Version {
  readonly voucher: Row | null;
  readonly rows: Readonly<Record<string, Row>>;
}

interface HistoryRow {
  readonly table_name: string;
  readonly row_id: string;
  readonly operation: "INSERT" | "UPDATE" | "DELETE";
  readonly old_values: Row | null;
  readonly new_values: Row | null;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly transaction: string;
  readonly at: string;
}

describe("the history of a voucher", () => {
  let db: TestDatabase;
  let app: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
  });

  afterAll(async () => {
    await db.close();
  });

  it("holds every earlier version of the voucher and its rows, each change with its actor, its kind and its time", async () => {
    const booker = someUser();
    const books = await addBooks(app, booker);
    const company = books.company;

    async function version(id: string): Promise<Version> {
      return inTransaction(app, { company }, async () => {
        const voucher = await app.query<{ row: Row }>("SELECT pg_catalog.to_jsonb(v) AS row FROM ledger.vouchers AS v WHERE v.id = $1", [id]);
        const rows = await app.query<{ id: string; row: Row }>(
          "SELECT r.id, pg_catalog.to_jsonb(r) AS row FROM ledger.voucher_rows AS r WHERE r.voucher_id = $1 ORDER BY r.position",
          [id],
        );
        return { voucher: voucher.rows[0]?.row ?? null, rows: Object.fromEntries(rows.rows.map((row) => [row.id, row.row])) };
      });
    }

    /** Runs a change as `who` in its own transaction, and notes the transaction, its time, the actor and the version after it. */
    const steps: { transaction: string; started: string; ended: string; who: Actor; after: Version }[] = [];
    async function step(id: string, who: Actor, work: () => Promise<unknown>): Promise<void> {
      const stamps = await inTransaction(app, { company, ...who }, async () => {
        await work();
        const found = await app.query<{ transaction: string; started: string; ended: string }>(
          "SELECT pg_catalog.pg_current_xact_id()::text AS transaction, pg_catalog.transaction_timestamp()::text AS started, pg_catalog.clock_timestamp()::text AS ended",
        );
        return found.rows[0] ?? { transaction: "", started: "", ended: "" };
      });
      steps.push({ ...stamps, who, after: await version(id) });
    }

    const voucher = randomUUID();
    await step(voucher, booker, async () => {
      await app.query(
        `INSERT INTO ledger.vouchers (id, company_id, fiscal_year_id, series_code, description, transaction_date, reference_type)
         VALUES ($1, $2, $3, 'A', 'Pennor', '2090-03-15', 'MANUAL')`,
        [voucher, company, books.year.id],
      );
      for (const row of balanced(2000n)) {
        await writeRow(app, company, voucher, row);
      }
    });
    const changer: Actor = someIntegration();
    const system: Actor = { actor: randomUUID(), kind: "system" };
    await step(voucher, changer, () => app.query("UPDATE ledger.vouchers SET description = 'Pennor och papper' WHERE id = $1", [voucher]));
    await step(voucher, system, () => app.query("UPDATE ledger.vouchers SET transaction_date = '2090-03-20' WHERE id = $1", [voucher]));
    await step(voucher, booker, () => app.query("UPDATE ledger.voucher_rows SET transaction_information = 'Kvitto 1' WHERE voucher_id = $1 AND position = 1", [voucher]));
    await step(voucher, booker, () => app.query("UPDATE ledger.voucher_rows SET transaction_information = 'Kvitto 2' WHERE voucher_id = $1 AND position = 1", [voucher]));
    await step(voucher, changer, () => writeRow(app, company, voucher, { account: 3001, text: "Nollrad" }));
    await step(voucher, system, async () => {
      await app.query("UPDATE ledger.voucher_rows SET removed = true WHERE voucher_id = $1 AND position = 1", [voucher]);
      await writeRow(app, company, voucher, { account: 6110, debit: 2000n, text: "Rätt rad" });
    });

    const history = await inTransaction(app, { company }, async () =>
      app.query<HistoryRow>(
        `SELECT table_name, row_id, operation, old_values, new_values, actor_id, actor_kind, transaction_id::text AS transaction, at::text AS at
         FROM audit.history
         WHERE (table_name = 'ledger.vouchers' AND row_id = $1)
            OR (table_name = 'ledger.voucher_rows' AND COALESCE(new_values, old_values) ->> 'voucher_id' = $1::text)
         ORDER BY id`,
        [voucher],
      ),
    );

    // Rebuild each version from the history alone, one transaction at a time.
    let rebuilt: Version = { voucher: null, rows: {} };
    for (const [index, noted] of steps.entries()) {
      const changes = history.rows.filter((row) => row.transaction === noted.transaction);
      expect(changes.length, `step ${String(index)} wrote history`).toBeGreaterThan(0);
      for (const change of changes) {
        const before = change.table_name === "ledger.vouchers" ? rebuilt.voucher : (rebuilt.rows[change.row_id] ?? null);
        // Each change keeps the value it replaced.
        expect(change.old_values, `step ${String(index)}, ${change.table_name}`).toEqual(change.operation === "INSERT" ? null : before);
        expect({ actor: change.actor_id, kind: change.actor_kind }).toEqual({ actor: noted.who.actor, kind: noted.who.kind });
        const atInside = await app.query<{ inside: boolean }>("SELECT $1::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz AS inside", [
          change.at,
          noted.started,
          noted.ended,
        ]);
        expect(atInside.rows[0]?.inside).toBe(true);
        rebuilt =
          change.table_name === "ledger.vouchers"
            ? { ...rebuilt, voucher: change.new_values }
            : { ...rebuilt, rows: { ...rebuilt.rows, [change.row_id]: change.new_values ?? {} } };
      }
      expect(rebuilt, `the version after step ${String(index)}`).toEqual(noted.after);
    }
    expect(history.rows.length).toBe(history.rows.filter((row) => steps.some((noted) => noted.transaction === row.transaction)).length);
    // The overwritten texts are there, in order.
    const texts = history.rows
      .filter((row) => row.table_name === "ledger.voucher_rows" && row.operation === "UPDATE")
      .map((row) => [row.old_values?.["transaction_information"], row.new_values?.["transaction_information"]]);
    expect(texts).toContainEqual(["", "Kvitto 1"]);
    expect(texts).toContainEqual(["Kvitto 1", "Kvitto 2"]);
    const descriptions = history.rows
      .filter((row) => row.table_name === "ledger.vouchers" && row.operation === "UPDATE")
      .map((row) => row.old_values?.["description"]);
    expect(descriptions[0]).toBe("Pennor");
  });
});
