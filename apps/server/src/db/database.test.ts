// SPDX-License-Identifier: AGPL-3.0-only

// How the database layer hands a connection back to the pool. pg's pool
// destroys a connection that is released with an error, or with true, and
// drops one that has lost its socket by itself. A connection whose ROLLBACK
// fails while its socket still looks sound is in a state no one knows, so it
// must be released as broken too. Real PostgreSQL gives no such connection on
// demand, so a fake pool stands in here. database.db.test.ts runs the rest
// against PostgreSQL.

import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { commit, databaseOver, type TransactionSettings } from "./database.ts";

const SETTINGS: TransactionSettings = { companyId: "a company", actorId: "an actor", actorKind: "user", channel: "mcp" };

/** A fake connection that answers each statement as `answer` says, and notes how it was released. */
class FakeConnection extends EventEmitter {
  readonly sent: string[] = [];
  released: unknown[] | undefined;
  private readonly answer: (text: string) => Promise<unknown>;

  constructor(answer: (text: string) => Promise<unknown>) {
    super();
    this.answer = answer;
  }

  query(text: string): Promise<unknown> {
    this.sent.push(text.split(" ")[0] ?? "");
    return this.answer(text);
  }

  release(...args: unknown[]): void {
    this.released = args;
  }
}

/** A fake pool that gives out `connection`. */
function poolOf(connection: FakeConnection): Pool {
  const pool = new EventEmitter() as EventEmitter & { connect: () => Promise<FakeConnection>; end: () => Promise<void> };
  pool.connect = () => Promise.resolve(connection);
  pool.end = () => Promise.resolve();
  return pool as unknown as Pool;
}

const failing = (statement: string, error: Error) => (text: string) => (text.startsWith(statement) ? Promise.reject(error) : Promise.resolve({ rows: [] }));

describe("handing a connection back", () => {
  it("releases a connection whose rollback failed as broken, so the pool destroys it, and throws the work's error", async () => {
    const connection = new FakeConnection(failing("ROLLBACK", new Error("the rollback failed")));
    const madeUp = new Error("a made-up fault of the handler");
    const database = databaseOver(poolOf(connection), () => undefined);
    await expect(database.write(SETTINGS, () => Promise.reject(madeUp))).rejects.toBe(madeUp);
    expect(connection.sent).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);
    expect(connection.released).toEqual([true]);
  });

  it("releases a connection whose COMMIT failed, and whose rollback did not, as sound, and throws the COMMIT's error", async () => {
    const refused = new Error("the commit failed");
    const connection = new FakeConnection(failing("COMMIT", refused));
    const database = databaseOver(poolOf(connection), () => undefined);
    await expect(database.write(SETTINGS, () => Promise.resolve(commit("never")))).rejects.toBe(refused);
    expect(connection.sent).toEqual(["BEGIN", "SELECT", "COMMIT", "ROLLBACK"]);
    expect(connection.released).toEqual([false]);
  });

  it("releases a connection that failed while the request held it as broken, and tells of the error", async () => {
    const connection = new FakeConnection(() => Promise.resolve({ rows: [] }));
    const told: Error[] = [];
    const lost = new Error("the connection was lost");
    const database = databaseOver(poolOf(connection), (error) => told.push(error));
    expect(
      await database.read(SETTINGS, () => {
        connection.emit("error", lost);
        return Promise.resolve(commit("answered"));
      }),
    ).toBe("answered");
    expect(told).toEqual([lost]);
    expect(connection.released).toEqual([true]);
    // Once handed back, its errors are the pool's.
    expect(connection.listenerCount("error")).toBe(0);
  });

  it("releases a sound connection as sound", async () => {
    const connection = new FakeConnection(() => Promise.resolve({ rows: [] }));
    const database = databaseOver(poolOf(connection), () => undefined);
    expect(await database.read(SETTINGS, () => Promise.resolve(commit(1)))).toBe(1);
    expect(connection.sent).toEqual(["BEGIN", "SELECT", "COMMIT"]);
    expect(connection.released).toEqual([false]);
  });
});
