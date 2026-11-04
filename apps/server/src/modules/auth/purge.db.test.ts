// SPDX-License-Identifier: AGPL-3.0-only

// The purge of part 1's install-wide rows (db/README.md, the schema
// access). The server calls access.purge_expired with its own clock every
// ten minutes. It deletes what has passed: login challenges and setup links
// past their end, sessions that ended more than 30 days ago or began more
// than 30 days and 12 hours ago, attempt counters whose hour has passed and
// whose lock has ended, a person's idempotency keys 24 hours after they were
// stored, and the account events past the 100 latest of each identity. It
// deletes no identity. The tests move the server's clock forwards only.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSUFFICIENT_PRIVILEGE, expectError, freshDatabase, inTransaction, type TestDatabase } from "../../../test/database.ts";
import { addIdentity, asPerson, later, tokenHash } from "../../../test/identities.ts";

/** The server's clock when the rows are made. */
const T0 = new Date("2090-03-15T10:00:00.000Z");

const DAY = 24 * 60;

describe("the purge of expired login rows", () => {
  let db: TestDatabase;
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    owner = await db.connect("owner");
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs the purge as the server does: as the app, in a transaction with only the channel, with its clock. */
  async function purge(at: Date): Promise<void> {
    await inTransaction(app, { channel: "rest" }, () => app.query("SELECT access.purge_expired($1)", [at]));
  }

  /** The ids left in `table`, sorted. */
  async function left(table: string, column = "id"): Promise<string[]> {
    return (await owner.query<{ id: string }>(`SELECT ${column}::text AS id FROM ${table} ORDER BY 1`)).rows.map((row) => row.id);
  }

  async function insert(sql: string, params: readonly unknown[]): Promise<string> {
    return (await owner.query<{ id: string }>(`${sql} RETURNING id::text`, [...params])).rows[0]?.id ?? "";
  }

  it("deletes a login challenge and a setup link at their end, and keeps them until then", async () => {
    const person = await addIdentity(owner);
    const challenge = (end: Date, used: Date | null = null): Promise<string> =>
      insert("INSERT INTO access.login_challenges (token_hash, identity_id, method, created_at, expires_at, used_at) VALUES ($1, $2, 'password-email', $3, $4, $5)", [
        tokenHash(),
        person,
        T0,
        end,
        used,
      ]);
    const link = (end: Date): Promise<string> => insert("INSERT INTO access.setup_tokens (token_hash, created_at, expires_at) VALUES ($1, $2, $3)", [tokenHash(), T0, end]);
    const soon = await challenge(later(T0, 20));
    const used = await challenge(later(T0, 20), later(T0, 1));
    const after = await challenge(later(T0, 40));
    const shortLink = await link(later(T0, 20));
    const longLink = await link(later(T0, 28 * DAY));
    await purge(later(T0, 19));
    expect(await left("access.login_challenges")).toEqual([soon, used, after].sort());
    await purge(later(T0, 20));
    expect(await left("access.login_challenges")).toEqual([after]);
    expect(await left("access.setup_tokens")).toEqual([longLink]);
    expect(shortLink).not.toBe(longLink);
    await purge(later(T0, 28 * DAY));
    expect(await left("access.login_challenges")).toEqual([]);
    expect(await left("access.setup_tokens")).toEqual([]);
  });

  it("deletes a session 30 days after it ended, and one that never ended 30 days after its 12 hours", async () => {
    const person = await addIdentity(owner);
    const session = (ended: Date | null): Promise<string> =>
      insert("INSERT INTO access.sessions (token_hash, identity_id, method, started_at, last_seen_at, ended_at, end_reason) VALUES ($1, $2, 'password-email', $3, $3, $4, $5)", [
        tokenHash(),
        person,
        T0,
        ended,
        ended === null ? null : "logout",
      ]);
    const ended = await session(later(T0, 60));
    const open = await session(null);
    await purge(later(T0, 30 * DAY + 59));
    expect(await left("access.sessions")).toEqual([ended, open].sort());
    await purge(later(T0, 30 * DAY + 60));
    expect(await left("access.sessions")).toEqual([open]);
    await purge(later(T0, 30 * DAY + 12 * 60 - 1));
    expect(await left("access.sessions")).toEqual([open]);
    await purge(later(T0, 30 * DAY + 12 * 60));
    expect(await left("access.sessions")).toEqual([]);
  });

  it("deletes an attempt counter once its hour has passed and its lock has ended", async () => {
    const counter = (subject: string, locked: Date | null): Promise<unknown> =>
      owner.query(
        "INSERT INTO access.attempt_counters (subject, kind, window_started_at, failures, last_failure_at, locked_until) VALUES ($1, 'password', $2, 3, $2, $3)",
        [subject, T0, locked],
      );
    const plain = randomUUID();
    const locked = randomUUID();
    await counter(plain, null);
    await counter(locked, later(T0, 90));
    await purge(later(T0, 59));
    expect(await left("access.attempt_counters", "subject")).toEqual([plain, locked].sort());
    await purge(later(T0, 60));
    expect(await left("access.attempt_counters", "subject")).toEqual([locked]);
    await purge(later(T0, 89));
    expect(await left("access.attempt_counters", "subject")).toEqual([locked]);
    await purge(later(T0, 90));
    expect(await left("access.attempt_counters", "subject")).toEqual([]);
  });

  it("keeps each identity's 100 latest account events, and deletes no identity", async () => {
    const busy = await addIdentity(owner);
    const quiet = await addIdentity(owner);
    for (let count = 0; count < 103; count += 1) {
      await asPerson(app, busy, () => app.query("INSERT INTO access.account_events (identity_id, kind, details) VALUES ($1, 'sign-in', $2)", [busy, { count }]));
    }
    await asPerson(app, quiet, () => app.query("INSERT INTO access.account_events (identity_id, kind) VALUES ($1, 'logout')", [quiet]));
    await purge(T0);
    const kept = await owner.query<{ count: number }>("SELECT (details ->> 'count')::integer AS count FROM access.account_events WHERE identity_id = $1 ORDER BY at", [busy]);
    expect(kept.rows.map((row) => row.count)).toEqual(Array.from({ length: 100 }, (_unused, index) => index + 3));
    expect(await left("access.account_events", "identity_id")).toEqual([...Array.from({ length: 100 }, () => busy), quiet].sort());
    // A purge far in the future still deletes no identity.
    await purge(later(T0, 365 * DAY));
    const identities = await owner.query("SELECT id FROM access.identities WHERE id = ANY ($1::uuid[])", [[busy, quiet]]);
    expect(identities.rows).toHaveLength(2);
  });

  it("is the app's to run, and a reader's not", async () => {
    const reader = await db.connect("readerA");
    await expectError(reader.query("SELECT access.purge_expired($1)", [T0]), INSUFFICIENT_PRIVILEGE);
  });
});
