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
import { testMembership } from "../../test/api.ts";
import type { ResolvedMembership } from "../modules/memberships/resolve.ts";
import { commit, databaseOver, type TransactionSettings } from "./database.ts";

const SETTINGS: TransactionSettings = { actorId: "an actor", actorKind: "user", channel: "mcp" };

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

// A lookup enters a company only with a membership that the one membership
// function gave in that lookup (modules/memberships/resolve.ts). Anything
// else is refused before any statement; resolve.db.test.ts shows the rest on
// PostgreSQL.
describe("entering a company in a lookup", () => {
  it("refuses a plain object with a membership's fields, and sends no statement for it", async () => {
    const connection = new FakeConnection(() => Promise.resolve({ rows: [] }));
    const database = databaseOver(poolOf(connection), () => undefined);
    const plain = { personId: "an actor", membershipId: "a membership", companyId: "a company", adminLevel: null, idleTimeoutMinutes: 120 };
    const refused = await database.lookup("rest", async (tx) => {
      await tx.actAs("an actor", "user");
      return commit(await tx.enter(plain as unknown as ResolvedMembership).then(() => undefined, (error: unknown) => error));
    });
    expect(refused).toEqual(new Error("tx.enter takes only a membership that the one membership function gave in this transaction (modules/memberships/resolve.ts)."));
    expect(connection.sent).toEqual(["BEGIN", "SELECT", "SELECT", "COMMIT"]);
  });
});

// A read or a write in a company takes the company only as a company access
// that the one membership function gave (modules/memberships/resolve.ts),
// for the transaction's actor. A company id by itself, a plain object and
// another person's access are refused before any statement, so no file sets
// a company that the function did not give.
describe("a transaction in a company", () => {
  const COMPANY = "5d1e7c3a-9b2f-4e8d-a6c4-1f0e2d3c4b5a";
  const ACTOR = "4f3e2d1c-0b9a-4876-9543-210fedcba987";
  const NOT_AN_ACCESS = new Error("A transaction in a company takes a company access that the one membership function gave (modules/memberships/resolve.ts).");

  it("refuses a company id, or a plain object with an access's fields, and sends no statement", async () => {
    for (const company of [COMPANY, { companyId: COMPANY, membershipId: "a membership", personId: ACTOR, adminLevel: null, permissions: new Set<string>() }]) {
      const connection = new FakeConnection(() => Promise.resolve({ rows: [] }));
      const database = databaseOver(poolOf(connection), () => undefined);
      const settings = { company, actorId: ACTOR, actorKind: "user", channel: "rest" } as unknown as TransactionSettings;
      await expect(database.read(settings, () => Promise.resolve(commit(1)))).rejects.toEqual(NOT_AN_ACCESS);
      await expect(database.write(settings, () => Promise.resolve(commit(1)))).rejects.toEqual(NOT_AN_ACCESS);
      expect(connection.sent).toEqual([]);
    }
  });

  it("refuses an access of another person than the actor, and sends no statement", async () => {
    const connection = new FakeConnection(() => Promise.resolve({ rows: [] }));
    const database = databaseOver(poolOf(connection), () => undefined);
    const access = (await testMembership(COMPANY, ACTOR)).access([]);
    const settings: TransactionSettings = { company: access, actorId: "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d", actorKind: "user", channel: "rest" };
    await expect(database.write(settings, () => Promise.resolve(commit(1)))).rejects.toEqual(new Error("A transaction in a company acts as the person of its company access."));
    expect(connection.sent).toEqual([]);
  });

  it("sets the company of an access of its actor", async () => {
    const values: unknown[][] = [];
    const connection = new FakeConnection(() => Promise.resolve({ rows: [] }));
    const query = connection.query.bind(connection);
    connection.query = (text: string, sent?: unknown[]) => {
      values.push(sent ?? []);
      return query(text);
    };
    const database = databaseOver(poolOf(connection), () => undefined);
    const access = (await testMembership(COMPANY, ACTOR)).access([]);
    expect(await database.read({ company: access, actorId: ACTOR, actorKind: "integration", channel: "mcp" }, () => Promise.resolve(commit(1)))).toBe(1);
    expect(values[1]).toEqual([COMPANY, ACTOR, "integration", "mcp"]);
  });
});
