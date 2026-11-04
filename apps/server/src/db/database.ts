// SPDX-License-Identifier: AGPL-3.0-only

// One transaction per request (docs/decisions/0009, db/README.md). The server
// reads and writes the database only through here, as nortfox_app, from a
// pool of connections.
//
// - Each request runs in one transaction. Before the work's first query, one
//   statement sets the company, the actor, its kind and the channel with
//   set_config(name, value, true), which does what SET LOCAL does and takes
//   bind parameters. A person's transaction sets no company, and an
//   anonymous one only the channel: what a form leaves out is set to '',
//   which the database reads as unset. They are set once, at the start, and
//   never changed: the database keeps the transaction's first actor and
//   channel, and refuses another. They end with the transaction, so a pooled
//   connection never carries them on: after it, PostgreSQL gives '', which
//   the database reads as unset.
// - A read runs at REPEATABLE READ READ ONLY, so a page and its total come
//   from one snapshot, and a read cannot write. A write runs at READ
//   COMMITTED, as the ledger asks of every write. Both are named in BEGIN, so
//   a default of the connection's never changes them.
// - The work ends the transaction with commit(value) or rollBack(value). A
//   throw rolls it back and is thrown again, and so is a COMMIT that fails,
//   such as the ledger's checks at commit. The work's queries run only while
//   the transaction is open: a query after its end is refused, so it can
//   never run in the next request's transaction on the same connection.
// - A connection that breaks, or whose rollback fails, leaves the pool, so it
//   never serves another request. The server is told of an error on a
//   connection outside its queries, such as PostgreSQL ending it.
// - A caller that changes a voucher's row locks the voucher first, in the
//   same transaction (db/README.md, the lock order):
//   SELECT 1 FROM ledger.vouchers WHERE id = $1 FOR NO KEY UPDATE.

import { Pool, type ClientConfig, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

/** The kinds of actor the database knows. */
export type ActorKind = "user" | "system" | "integration";

/** The clients a request comes through, which the behandlingshistorik records. */
export type Channel = "rest" | "mcp";

/** An anonymous transaction, such as a sign-in's before it knows the person: only the channel. */
export interface AnonymousSettings {
  readonly channel: Channel;
  readonly actorId?: never;
  readonly actorKind?: never;
  readonly companyId?: never;
}

/** A person's transaction in no company: the actor, its kind and the channel. */
export interface PersonSettings {
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly channel: Channel;
  readonly companyId?: never;
}

/** A transaction in a company: the company, the actor, its kind and the channel. */
export interface CompanySettings {
  readonly companyId: string;
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly channel: Channel;
}

/**
 * What a transaction sets before the work's first query, in one of three
 * forms. A value that the form leaves out stays unset, '', which the
 * database reads as unset.
 */
export type TransactionSettings = AnonymousSettings | PersonSettings | CompanySettings;

/** The transaction, as the work sees it: its queries, and nothing else of the connection. */
export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

/** How the work ends its transaction: kept or rolled back, with the value the caller gets. */
export interface Ending<T> {
  readonly commit: boolean;
  readonly value: T;
}

/** Commits the transaction, and gives `value`. */
export function commit<T>(value: T): Ending<T> {
  return { commit: true, value };
}

/** Rolls the transaction back, and gives `value`: nothing the work wrote is kept. */
export function rollBack<T>(value: T): Ending<T> {
  return { commit: false, value };
}

/** A request's work in its transaction. */
export type Work<T> = (tx: Queryable) => Promise<Ending<T>>;

export interface Database {
  /** Runs `work` in a transaction at REPEATABLE READ READ ONLY. */
  read<T>(settings: TransactionSettings, work: Work<T>): Promise<T>;
  /** Runs `work` in a transaction at READ COMMITTED. */
  write<T>(settings: TransactionSettings, work: Work<T>): Promise<T>;
  /** Closes the pool's connections. */
  end(): Promise<void>;
}

export interface DatabaseOptions {
  /** The most connections the pool holds at once. */
  readonly max: number;
  /** Told of an error on a pooled connection outside its queries. The connection has left the pool, or leaves it once its request ends. */
  readonly onConnectionError: (error: Error) => void;
}

const READ = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const WRITE = "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE";

const SETTINGS = `SELECT pg_catalog.set_config('nortfox.company_id', $1, true), pg_catalog.set_config('nortfox.actor_id', $2, true),
  pg_catalog.set_config('nortfox.actor_kind', $3, true), pg_catalog.set_config('nortfox.channel', $4, true)`;

const ENDED = "The transaction has ended. A query after its end would run outside it.";

/** Runs `work` in one transaction that `begin` opens, on a connection of the pool. */
async function runInTransaction<T>(pool: Pool, begin: string, settings: TransactionSettings, work: Work<T>, onConnectionError: (error: Error) => void): Promise<T> {
  const client: PoolClient = await pool.connect();
  let broken = false;
  const noteBreak = (error: Error): void => {
    broken = true;
    onConnectionError(error);
  };
  // A checked-out connection that PostgreSQL ends emits its error here, not to the pool.
  client.on("error", noteBreak);
  let open = true;
  const tx: Queryable = {
    query: (text, values) => (open ? client.query(text, values === undefined ? undefined : [...values]) : Promise.reject(new Error(ENDED))),
  };
  try {
    let ending: Ending<T>;
    try {
      await client.query(begin);
      await client.query(SETTINGS, [settings.companyId ?? "", settings.actorId ?? "", settings.actorKind ?? "", settings.channel]);
      ending = await work(tx);
      open = false;
      await client.query(ending.commit ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      open = false;
      // After a failed COMMIT, PostgreSQL has rolled back already, and this only warns.
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw error;
    }
    return ending.value;
  } finally {
    client.off("error", noteBreak);
    client.release(broken);
  }
}

/** The database over `pool`, whose connections log in as nortfox_app. */
export function databaseOver(pool: Pool, onConnectionError: (error: Error) => void): Database {
  // An idle connection that PostgreSQL ends leaves the pool, which emits its error here.
  pool.on("error", onConnectionError);
  return {
    read: (settings, work) => runInTransaction(pool, READ, settings, work, onConnectionError),
    write: (settings, work) => runInTransaction(pool, WRITE, settings, work, onConnectionError),
    end: () => pool.end(),
  };
}

/** A database with a pool of its own, from a connection's config (connect.ts). The pool connects when the first request comes. */
export function createDatabase(config: ClientConfig, options: DatabaseOptions): Database {
  return databaseOver(new Pool({ ...config, max: options.max }), options.onConnectionError);
}
