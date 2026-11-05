// SPDX-License-Identifier: AGPL-3.0-only

// One transaction per request (decision 9, db/README.md). The server opens
// it, sets the company, the actor, its kind and the channel once, before the
// work's first query, with set_config(name, value, true), and ends it. The
// settings end with the transaction, so a pooled connection never carries
// them on to the next request, after a request that failed neither. A
// connection that breaks leaves the pool. These tests run as the app role.

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testMembership } from "../../test/api.ts";
import { urlOf } from "../../test/cluster.ts";
import { UNIQUE_VIOLATION, failureOf, freshDatabase, inTransaction, type TestDatabase } from "../../test/database.ts";
import { INSERT_ROW, INSERT_VOUCHER, addBooks, type Books } from "../../test/ledger.ts";
import { connectionConfig } from "./connect.ts";
import {
  commit,
  createDatabase,
  databaseOver,
  rollBack,
  type ActorKind,
  type Channel,
  type Database,
  type Queryable,
  type TransactionSettings,
} from "./database.ts";
import { readRefusal } from "./refusals.ts";

/** PostgreSQL's SQLSTATE for a write in a READ ONLY transaction, and for a backend that an administrator ended. */
const READ_ONLY_SQL_TRANSACTION = "25006";
const ADMIN_SHUTDOWN = "57P01";

/** What a connection holds of the four settings, "" when unset, and its backend. */
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

const UNSET = { company: "", actor: "", kind: "", channel: "" };

const ENDED = new Error("The transaction has ended. A query after its end would run outside it.");

async function seenBy(tx: Queryable): Promise<Seen> {
  const found = await tx.query<Seen>(SEEN);
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The connection gave no settings.");
  }
  return row;
}

describe("one transaction per request", () => {
  let db: TestDatabase;
  let books: Books;
  let app: Client;
  let admin: Client;
  const pools: Pool[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    app = await db.connect("app");
    books = await addBooks(app);
    admin = await db.admin();
  });

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  afterAll(async () => {
    await db.close();
  });

  /** A pool of `max` connections as the app, the database over it, and the connection errors it was told of. */
  function poolOf(max: number): { pool: Pool; database: Database; errors: Error[] } {
    const pool = new Pool({ ...connectionConfig(urlOf("nortfox_app", db.name)), max });
    pools.push(pool);
    const errors: Error[] = [];
    return { pool, database: databaseOver(pool, (error) => errors.push(error)), errors };
  }

  /** The settings of a transaction in the books' company, as a made-up person: a company access is the only way into a company. */
  async function settingsOf(kind: ActorKind = "integration", channel: Channel = "rest"): Promise<TransactionSettings> {
    const actorId = randomUUID();
    return { company: (await testMembership(books.company, actorId)).access([]), actorId, actorKind: kind, channel };
  }

  function seenAs(settings: TransactionSettings): Omit<Seen, "pid"> {
    return { company: settings.company?.companyId ?? "", actor: settings.actorId ?? "", kind: settings.actorKind ?? "", channel: settings.channel };
  }

  /** The transaction's level and whether it is read only. */
  async function modeOf(tx: Queryable): Promise<{ level: string; readOnly: string }> {
    const found = await tx.query<{ level: string; readOnly: string }>(
      "SELECT pg_catalog.current_setting('transaction_isolation') AS level, pg_catalog.current_setting('transaction_read_only') AS \"readOnly\"",
    );
    return found.rows[0] ?? { level: "", readOnly: "" };
  }

  /** Waits until `found` holds something, or fails after five seconds. */
  async function until(found: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (found()) {
        return;
      }
      await delay(10);
    }
    throw new Error(`Waited in vain for ${what}.`);
  }

  /** An account number of its own for each write here. */
  let nextAccount = 2000;
  function anAccount(): number {
    nextAccount += 1;
    return nextAccount;
  }
  const INSERT_ACCOUNT = "INSERT INTO ledger.accounts (company_id, fiscal_year_id, number, description) VALUES ($1, $2, $3, 'Övrigt')";

  /** Whether the company holds the account, as a connection of its own sees it. */
  async function holds(account: number): Promise<boolean> {
    const found = await inTransaction(app, { company: books.company }, () => app.query("SELECT 1 FROM ledger.accounts WHERE number = $1", [account]));
    return found.rows.length === 1;
  }

  it("sets the company, the actor, its kind and the channel before the work's first query, for a read and for a write", async () => {
    const { database } = poolOf(2);
    for (const kind of ["user", "system", "integration"] as const) {
      for (const channel of ["rest", "mcp"] as const) {
        const settings = await settingsOf(kind, channel);
        expect(await database.read(settings, async (tx) => commit(await seenBy(tx)))).toMatchObject(seenAs(settings));
        expect(await database.write(settings, async (tx) => commit(await seenBy(tx)))).toMatchObject(seenAs(settings));
      }
    }
    // The company's rows, and only through row level security: no condition of the work's own.
    const companies = await database.read(await settingsOf(), async (tx) => commit((await tx.query("SELECT company_id FROM ledger.companies")).rows));
    expect(companies).toEqual([{ company_id: books.company }]);
  });

  it("sets only what its form names: a person's transaction no company, an anonymous one only the channel", async () => {
    const { database } = poolOf(1);
    const person: TransactionSettings = { actorId: randomUUID(), actorKind: "user", channel: "rest" };
    const anonymous: TransactionSettings = { channel: "rest" };
    for (const settings of [person, anonymous]) {
      expect(await database.read(settings, async (tx) => commit(await seenBy(tx)))).toMatchObject(seenAs(settings));
      expect(await database.write(settings, async (tx) => commit(await seenBy(tx)))).toMatchObject(seenAs(settings));
    }
    expect(seenAs(person)).toEqual({ company: "", actor: person.actorId, kind: "user", channel: "rest" });
    expect(seenAs(anonymous)).toEqual({ company: "", actor: "", kind: "", channel: "rest" });
    // With no company set, row level security shows no company's rows.
    expect(await database.read(person, async (tx) => commit((await tx.query("SELECT company_id FROM ledger.companies")).rows))).toEqual([]);
  });

  // A lookup is the resolver's transaction (db/README.md): it finds the
  // credential through the lookup functions before it knows the person, so
  // it starts with only the channel, and may then set the person once.
  it("runs a lookup at READ COMMITTED with only the channel set, lets the work set the person once, and carries nothing on", async () => {
    const { database } = poolOf(1);
    const person = randomUUID();
    const seen = await database.lookup("rest", async (tx) => {
      const before = await seenBy(tx);
      const mode = await modeOf(tx);
      await tx.actAs(person, "user");
      const after = await seenBy(tx);
      const again = await failureOf(tx.actAs(randomUUID(), "integration"));
      return commit({ before, mode, after, again, last: await seenBy(tx) });
    });
    expect(seen.before).toMatchObject({ company: "", actor: "", kind: "", channel: "rest" });
    expect(seen.mode).toEqual({ level: "read committed", readOnly: "off" });
    expect(seen.after).toMatchObject({ company: "", actor: person, kind: "user", channel: "rest" });
    expect(seen.again).toEqual(new Error("The lookup has set its person already. A lookup sets the person once."));
    expect(seen.last).toMatchObject({ actor: person, kind: "user" });
    expect(await database.read({ channel: "mcp" }, async (tx) => commit(await seenBy(tx)))).toMatchObject({ ...UNSET, channel: "mcp" });
    // An integration, as a token's lookup sets it, with the other channel.
    const token = await database.lookup("mcp", async (tx) => {
      await tx.actAs(person, "integration");
      return commit(await seenBy(tx));
    });
    expect(token).toMatchObject({ company: "", actor: person, kind: "integration", channel: "mcp" });
    // Its writes commit, or roll back.
    const kept = Buffer.from("a made-up check value");
    const keep = (value: Buffer) => async (tx: Queryable) =>
      (await tx.query<{ kept: Buffer }>("SELECT kept FROM access.install_key(9, $1)", [value])).rows[0]?.kept;
    expect(await database.lookup("rest", async (tx) => rollBack(await keep(Buffer.from("rolled back"))(tx)))).toEqual(Buffer.from("rolled back"));
    expect(await database.lookup("rest", async (tx) => commit(await keep(kept)(tx)))).toEqual(kept);
    expect(await database.lookup("rest", async (tx) => commit(await keep(Buffer.from("later"))(tx)))).toEqual(kept);
    // Once it has ended, neither a query nor setting the person runs.
    let ended: Parameters<Parameters<Database["lookup"]>[1]>[0] | undefined;
    await database.lookup("rest", (tx) => {
      ended = tx;
      return Promise.resolve(commit(undefined));
    });
    expect(await failureOf(ended?.actAs(person, "user") ?? Promise.resolve())).toEqual(ENDED);
    expect(await failureOf(ended?.query("SELECT 1") ?? Promise.resolve())).toEqual(ENDED);
  });

  it("runs a read at REPEATABLE READ READ ONLY and a write at READ COMMITTED, whatever the connection's defaults", async () => {
    const { pool, database } = poolOf(1);
    for (const defaults of [[], ["SET default_transaction_isolation = 'serializable'", "SET default_transaction_read_only = on"]]) {
      for (const sql of defaults) {
        await pool.query(sql);
      }
      expect(await database.read(await settingsOf(), async (tx) => commit(await modeOf(tx)))).toEqual({ level: "repeatable read", readOnly: "on" });
      expect(await database.write(await settingsOf(), async (tx) => commit(await modeOf(tx)))).toEqual({ level: "read committed", readOnly: "off" });
    }
    const account = anAccount();
    const error = await failureOf(database.read(await settingsOf(), async (tx) => commit(await tx.query(INSERT_ACCOUNT, [books.company, books.year.id, account]))));
    expect((error as { code?: unknown }).code, String(error)).toBe(READ_ONLY_SQL_TRANSACTION);
    expect(await holds(account)).toBe(false);
  });

  it("keeps the work's writes on a commit, and none on a rollback, a throw, a refused statement or a failed commit, and the one pooled connection carries no setting after each", async () => {
    const { pool, database } = poolOf(1);
    const first = await seenBy(pool);
    expect(first).toMatchObject(UNSET);
    const settings = await settingsOf();
    /** After each request: the one connection, with no setting, and no company's rows to see. */
    const expectEmpty = async (): Promise<void> => {
      expect(await seenBy(pool)).toEqual({ ...UNSET, pid: first.pid });
      expect((await pool.query("SELECT company_id FROM ledger.companies")).rows).toEqual([]);
      expect(pool.totalCount).toBe(1);
    };

    const kept = anAccount();
    expect(await database.write(settings, async (tx) => commit((await tx.query(INSERT_ACCOUNT, [books.company, books.year.id, kept])).rowCount))).toBe(1);
    expect(await holds(kept)).toBe(true);
    await expectEmpty();

    const rolledBack = anAccount();
    expect(
      await database.write(settings, async (tx) => {
        await tx.query(INSERT_ACCOUNT, [books.company, books.year.id, rolledBack]);
        return rollBack("refused by a rule of the handler");
      }),
    ).toBe("refused by a rule of the handler");
    expect(await holds(rolledBack)).toBe(false);
    await expectEmpty();

    const thrown = anAccount();
    const madeUp = new Error("a made-up fault of the handler");
    expect(
      await failureOf(
        database.write(settings, async (tx) => {
          await tx.query(INSERT_ACCOUNT, [books.company, books.year.id, thrown]);
          throw madeUp;
        }),
      ),
    ).toBe(madeUp);
    expect(await holds(thrown)).toBe(false);
    await expectEmpty();

    const refused = anAccount();
    const duplicate = await failureOf(
      database.write(settings, async (tx) => {
        await tx.query(INSERT_ACCOUNT, [books.company, books.year.id, refused]);
        await tx.query(INSERT_ACCOUNT, [books.company, books.year.id, refused]);
        return commit("never");
      }),
    );
    expect((duplicate as { code?: unknown }).code, String(duplicate)).toBe(UNIQUE_VIOLATION);
    expect(await holds(refused)).toBe(false);
    await expectEmpty();

    // A voucher out of balance passes each statement, and its check at commit refuses it.
    const unbalanced = await failureOf(
      database.write(settings, async (tx) => {
        const booked = await tx.query<{ id: string }>(INSERT_VOUCHER, [books.company, books.year.id, "A", "Kontorsmaterial", "", "2090-08-12", "MANUAL", "", null]);
        const voucher = booked.rows[0]?.id;
        await tx.query(INSERT_ROW, [books.company, voucher, 6110, 1000n, 0n, "", 0]);
        await tx.query(INSERT_ROW, [books.company, voucher, 1930, 0n, 900n, "", 0]);
        return commit(voucher);
      }),
    );
    expect(readRefusal(unbalanced)).toMatchObject({ reason: "unbalanced", facts: { debit: "1000", credit: "900" } });
    const vouchers = await database.read(settings, async (tx) => commit((await tx.query("SELECT id FROM ledger.vouchers")).rows));
    expect(vouchers).toEqual([]);
    await expectEmpty();

    // A read too, ended either way.
    expect(await database.read(settings, async (tx) => commit((await seenBy(tx)).pid))).toBe(first.pid);
    await expectEmpty();
    expect(await database.read(settings, () => Promise.resolve(rollBack("nothing to keep")))).toBe("nothing to keep");
    await expectEmpty();
    expect(await failureOf(database.read(settings, () => Promise.reject(madeUp)))).toBe(madeUp);
    await expectEmpty();
  });

  it("refuses a query on the transaction after the transaction ended, so it never runs in the next request's", async () => {
    const { pool, database } = poolOf(1);
    let kept: Queryable | undefined;
    await database.write(await settingsOf(), (tx) => {
      kept = tx;
      return Promise.resolve(commit(undefined));
    });
    let thrownBy: Queryable | undefined;
    await failureOf(
      database.write(await settingsOf(), (tx) => {
        thrownBy = tx;
        return Promise.reject(new Error("a made-up fault of the handler"));
      }),
    );
    // The next request holds the one connection while the stale queries come.
    const next = await settingsOf();
    const stale = await database.write(next, async (tx) => {
      const account = anAccount();
      const refused = [
        await failureOf(kept?.query(INSERT_ACCOUNT, [books.company, books.year.id, account]) ?? Promise.resolve()),
        await failureOf(thrownBy?.query("SELECT pg_catalog.set_config('nortfox.company_id', '', true)") ?? Promise.resolve()),
      ];
      return commit({ refused, account, seen: await seenBy(tx) });
    });
    expect(stale.refused).toEqual([ENDED, ENDED]);
    expect(stale.seen).toMatchObject(seenAs(next));
    expect(await holds(stale.account)).toBe(false);
    expect(pool.totalCount).toBe(1);
  });

  it("lets a connection that breaks between the work's queries leave the pool, tells of it, and gives the next request a new one", async () => {
    const { pool, database, errors } = poolOf(1);
    const settings = await settingsOf();
    let pid = 0;
    const failure = await failureOf(
      database.write(settings, async (tx) => {
        pid = (await seenBy(tx)).pid;
        await admin.query("SELECT pg_catalog.pg_terminate_backend($1, 5000)", [pid]);
        await until(() => errors.length > 0, "the error of the ended connection");
        return commit(await tx.query("SELECT 1"));
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(errors.map((error) => (error as { code?: unknown }).code)).toContain(ADMIN_SHUTDOWN);
    await until(() => pool.totalCount === 0, "the pool to let the connection go");
    const next = await database.write(settings, async (tx) => commit(await seenBy(tx)));
    expect(next).toMatchObject(seenAs(settings));
    expect(next.pid).not.toBe(pid);
  });

  it("lets a connection that breaks during a query leave the pool, throws the query's error, and gives the next request a new one", async () => {
    const { pool, database } = poolOf(1);
    const settings = await settingsOf();
    let pid = 0;
    const running = failureOf(
      database.write(settings, async (tx) => {
        pid = (await seenBy(tx)).pid;
        return commit(await tx.query("SELECT pg_catalog.pg_sleep(30)"));
      }),
    );
    await until(() => pid !== 0, "the request's backend");
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const found = await admin.query("SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND query LIKE '%pg_sleep%' AND state = 'active'", [pid]);
      if (found.rows.length > 0) {
        break;
      }
      await delay(10);
    }
    await admin.query("SELECT pg_catalog.pg_terminate_backend($1, 5000)", [pid]);
    const failure = await running;
    expect((failure as { code?: unknown }).code, String(failure)).toBe(ADMIN_SHUTDOWN);
    await until(() => pool.totalCount === 0, "the pool to let the connection go");
    const next = await database.read(settings, async (tx) => commit(await seenBy(tx)));
    expect(next).toMatchObject(seenAs(settings));
    expect(next.pid).not.toBe(pid);
  });

  it("lets an idle connection that breaks leave the pool, tells of it, and gives the next request a new one", async () => {
    const { pool, database, errors } = poolOf(1);
    const settings = await settingsOf();
    const { pid } = await database.read(settings, async (tx) => commit(await seenBy(tx)));
    await admin.query("SELECT pg_catalog.pg_terminate_backend($1, 5000)", [pid]);
    await until(() => errors.length > 0, "the error of the idle connection");
    expect(errors.map((error) => (error as { code?: unknown }).code)).toContain(ADMIN_SHUTDOWN);
    expect(pool.totalCount).toBe(0);
    const next = await database.read(settings, async (tx) => commit(await seenBy(tx)));
    expect(next).toMatchObject(seenAs(settings));
    expect(next.pid).not.toBe(pid);
  });

  it("makes its pool from a connection's config, connects only when a request comes, as the app, and ends", async () => {
    const errors: Error[] = [];
    const nowhere = createDatabase(connectionConfig("postgres://nortfox_app@127.0.0.1:1/nowhere"), { max: 1, onConnectionError: (error) => errors.push(error) });
    expect(await failureOf(nowhere.read(await settingsOf(), () => Promise.resolve(commit(undefined))))).toBeInstanceOf(Error);
    await nowhere.end();
    const database = createDatabase(connectionConfig(urlOf("nortfox_app", db.name)), { max: 1, onConnectionError: (error) => errors.push(error) });
    const who = await database.read(await settingsOf(), async (tx) => commit((await tx.query<{ role: string; balance: bigint }>("SELECT current_user AS role, 1::bigint AS balance")).rows));
    expect(who).toEqual([{ role: "nortfox_app", balance: 1n }]);
    await database.end();
    expect(await failureOf(database.read(await settingsOf(), () => Promise.resolve(commit(undefined))))).toBeInstanceOf(Error);
    expect(errors).toEqual([]);
  });
});
