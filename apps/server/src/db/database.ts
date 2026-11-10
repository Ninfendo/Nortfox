// SPDX-License-Identifier: AGPL-3.0-only

// One transaction per request (docs/decisions/0009, db/README.md). The server
// reads and writes the database only through here, as nortfox_app, from a
// pool of connections.
//
// - Each request runs in one transaction. Before the work's first query, one
//   statement sets the company, the actor, its kind, the channel and, for an
//   integration, the via: the API token or the MCP client it acts through
//   (decision 2). It uses set_config(name, value, true), which does what
//   SET LOCAL does and takes bind parameters. An integration names a via,
//   and a user or the system user none, or the transaction throws before any
//   statement: the database refuses a write otherwise. A person's transaction sets no company, and an
//   anonymous one only the channel: what a form leaves out is set to '',
//   which the database reads as unset. A read or a write in a company takes
//   its company only as a company access that the one membership function
//   gave (modules/memberships/resolve.ts), for its actor: a company id by
//   itself, any other object, and another person's access throw before any
//   statement. The actor, its kind, its via and the channel are set once and
//   never changed: the database keeps the transaction's first actor, via and
//   channel, and refuses another (a lookup sets its person once, later, with actAs).
//   The company is set at the start, or once later, from the one function's
//   answer, from a live invitation link to accept it, or for a company the
//   work makes (enter and inNewCompany, below).
//   They end with the transaction, so a pooled connection never carries them
//   on: after it, PostgreSQL gives '', which the database reads as unset.
// - A read runs at REPEATABLE READ READ ONLY, so a page and its total come
//   from one snapshot, and a read cannot write. A write runs at READ
//   COMMITTED, as the ledger asks of every write. Both are named in BEGIN, so
//   a default of the connection's never changes them.
// - A lookup is the resolver's transaction, before the request's own. It
//   writes, at READ COMMITTED, and starts with only the channel set, since
//   it finds the credential through the lookup functions before it knows the
//   person. The work may then set the person once, with actAs: the actor and
//   its kind, a user or an integration with its via, never the internal
//   system user. A
//   second actAs throws. After that it may enter one company, with enter:
//   only with a membership that the one membership function gave in this
//   same lookup, to the person it acts as (modules/memberships/resolve.ts).
//   Anything else, and a second enter, throws before any statement.
// - A person's transaction (person) is a read or a write as the person, in
//   no company at first. It may set its company once: with enter, from a
//   membership that the one membership function gave in it, to its person,
//   as for a request whose input names its company, or from a live
//   invitation link that the database gave in it, to its person, who accepts
//   the invitation (modules/memberships/resolve.ts); or with inNewCompany,
//   for the company that the work makes, whose id the layer picks, so no
//   caller can name an existing company there. The company is set while
//   that work runs and unset after it.
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

import { randomUUID } from "node:crypto";
import { Pool, type ClientConfig, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { CompanyAccess, InvitationEntry, ResolvedMembership } from "../modules/memberships/resolve.ts";

/** The kinds of actor the database knows. */
export type ActorKind = "user" | "system" | "integration";

/** The clients a request comes through, which the behandlingshistorik records. */
export type Channel = "rest" | "mcp";

/** What an integration acts through (decision 2): an API token, or an MCP client. */
export type ViaKind = "api-token" | "mcp-client";

/**
 * The API token or the MCP client an integration acts through, by its id:
 * the token's, or the client's. The behandlingshistorik records it beside
 * the person and the kind.
 */
export interface Via {
  readonly kind: ViaKind;
  readonly id: string;
}

/** An anonymous transaction, such as a sign-in's before it knows the person: only the channel. */
export interface AnonymousSettings {
  readonly channel: Channel;
  readonly actorId?: never;
  readonly actorKind?: never;
  readonly via?: never;
  readonly company?: never;
}

/**
 * A person's transaction in no company: the actor, its kind, its via and
 * the channel. An integration names its via, and a user or the system user
 * none.
 */
export interface PersonSettings {
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly via?: Via;
  readonly channel: Channel;
  readonly company?: never;
}

/**
 * A transaction in a company: the company, as a company access that the one
 * membership function gave, its person as the actor, the actor's kind, its
 * via and the channel.
 */
export interface CompanySettings {
  readonly company: CompanyAccess;
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly via?: Via;
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

/** The kinds of actor that a credential gives a person: never the internal system user. */
export type PersonKind = "user" | "integration";

/** The lookup's transaction: its queries, the person it may set once, and the company it may enter once. */
export interface LookupQueryable extends Queryable {
  /**
   * Sets the transaction's person, the actor and its kind, once, with the
   * via that an integration acts through. A second call, an integration
   * without a via and a user with one throw before any statement.
   */
  actAs(personId: string, kind: PersonKind, via?: Via): Promise<void>;
  /**
   * Sets the transaction's company, once, from a membership that the one
   * membership function gave in this lookup, to the person it acts as
   * (modules/memberships/resolve.ts). Anything else, and a second call,
   * throws before any statement.
   */
  enter(membership: ResolvedMembership): Promise<void>;
}

/** The resolver's work in its lookup. */
export type LookupWork<T> = (tx: LookupQueryable) => Promise<Ending<T>>;

/** A person's transaction: its queries, and the one company it may come to work in. */
export interface PersonQueryable extends Queryable {
  /**
   * Sets the transaction's company from a membership that the one
   * membership function gave in this transaction, or from a live invitation
   * link that the database gave in it, to the person it acts as
   * (modules/memberships/resolve.ts). Anything else, and a company set
   * before, throws before any statement.
   */
  enter(membership: ResolvedMembership | InvitationEntry): Promise<void>;
  /**
   * Picks a new company's id, sets it as the transaction's company while
   * `work` runs, and sets no company again after it: the company that the
   * work makes. A company set before throws before any statement.
   */
  inNewCompany<T>(work: (companyId: string) => Promise<T>): Promise<T>;
}

/** A person's work in a transaction that may come to work in one company. */
export type PersonWork<T> = (tx: PersonQueryable) => Promise<Ending<T>>;

export interface Database {
  /** Runs `work` in a transaction at REPEATABLE READ READ ONLY. */
  read<T>(settings: TransactionSettings, work: Work<T>): Promise<T>;
  /** Runs `work` in a transaction at READ COMMITTED. */
  write<T>(settings: TransactionSettings, work: Work<T>): Promise<T>;
  /** Runs a person's `work` in a read or a write that starts in no company, and may set its company once (PersonQueryable). */
  person<T>(mode: "read" | "write", settings: PersonSettings, work: PersonWork<T>): Promise<T>;
  /** Runs the resolver's `work` in a transaction at READ COMMITTED, with only the channel set. */
  lookup<T>(channel: Channel, work: LookupWork<T>): Promise<T>;
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
  pg_catalog.set_config('nortfox.actor_kind', $3, true), pg_catalog.set_config('nortfox.channel', $4, true),
  pg_catalog.set_config('nortfox.via_kind', $5, true), pg_catalog.set_config('nortfox.via_id', $6, true)`;

const SET_PERSON = `SELECT pg_catalog.set_config('nortfox.actor_id', $1, true), pg_catalog.set_config('nortfox.actor_kind', $2, true),
  pg_catalog.set_config('nortfox.via_kind', $3, true), pg_catalog.set_config('nortfox.via_id', $4, true)`;

const VIA_MISSING = "An integration acts through an API token or an MCP client: its transaction names the via.";

const VIA_NOT_ITS = "Only an integration acts through a token or a client: a transaction of a user or of the system user names no via.";

/**
 * The via settings of an actor of `kind`, as the settings hold them: the
 * via's kind and id for an integration, and '' and '' for another actor or
 * none. An integration without a via, and a via of another actor, throw.
 */
function viaSettings(kind: ActorKind | undefined, via: Via | undefined): [string, string] {
  if (kind === "integration") {
    if (via === undefined) {
      throw new Error(VIA_MISSING);
    }
    return [via.kind, via.id];
  }
  if (via !== undefined) {
    throw new Error(VIA_NOT_ITS);
  }
  return ["", ""];
}

const ENDED = "The transaction has ended. A query after its end would run outside it.";

const SET_COMPANY = "SELECT pg_catalog.set_config('nortfox.company_id', $1, true)";

const PERSON_SET = "The lookup has set its person already. A lookup sets the person once.";

const NOT_RESOLVED_HERE = "tx.enter takes only a membership that the one membership function gave in this transaction (modules/memberships/resolve.ts).";

const ANOTHER_PERSON = "tx.enter takes a membership of the person the lookup acts as.";

const COMPANY_ENTERED = "The lookup has entered its company already. A lookup enters one company.";

/** The lookup's transaction over `tx`: its queries, actAs once, and enter once. */
function lookupOver(tx: Queryable): LookupQueryable {
  let person: string | undefined;
  let entered = false;
  const lookup: LookupQueryable = {
    query: (text, values) => tx.query(text, values),
    actAs: async (personId, kind, via) => {
      if (person !== undefined) {
        throw new Error(PERSON_SET);
      }
      const [viaKind, viaId] = viaSettings(kind, via);
      person = personId;
      await tx.query(SET_PERSON, [personId, kind, viaKind, viaId]);
    },
    enter: async (membership) => {
      // The membership must be this module's object, made in this lookup, so
      // neither a plain object nor one from an earlier transaction enters.
      if (!(membership instanceof ResolvedMembership) || !membership.resolvedIn(lookup)) {
        throw new Error(NOT_RESOLVED_HERE);
      }
      if (membership.personId !== person) {
        throw new Error(ANOTHER_PERSON);
      }
      if (entered) {
        throw new Error(COMPANY_ENTERED);
      }
      entered = true;
      await tx.query(SET_COMPANY, [membership.companyId]);
    },
  };
  return lookup;
}

const NOT_AN_ACCESS = "A transaction in a company takes a company access that the one membership function gave (modules/memberships/resolve.ts).";

const ACCESS_ELSEWHERE = "A transaction in a company acts as the person of its company access.";

/**
 * The company that `settings` set, as the setting holds it: '' for none, and
 * otherwise the company of a company access that the one membership function
 * gave, for the settings' actor. Anything else throws.
 */
function companyOf(settings: TransactionSettings): string {
  const { company } = settings;
  if (company === undefined) {
    return "";
  }
  // The type allows only an access, and a caller past the type gets a throw.
  if (!((company as unknown) instanceof CompanyAccess)) {
    throw new Error(NOT_AN_ACCESS);
  }
  if (company.personId !== settings.actorId) {
    throw new Error(ACCESS_ELSEWHERE);
  }
  return company.companyId;
}

const PERSON_ELSEWHERE = "tx.enter takes a membership of the person the transaction acts as.";

const COMPANY_SET = "The transaction works in a company already. It sets its company once.";

/**
 * A person's transaction over `tx`, which starts in no company: its queries,
 * and one company, entered from a membership that the one function gave in
 * it, or from a live invitation link that the database gave in it, to accept
 * the invitation, or made by the work.
 */
function personOver(tx: Queryable, settings: PersonSettings): PersonQueryable {
  let companySet = false;
  const person: PersonQueryable = {
    query: (text, values) => tx.query(text, values),
    enter: async (membership) => {
      // The membership or the link must be the memberships module's object, made in this transaction, for its person.
      if (!(membership instanceof ResolvedMembership || membership instanceof InvitationEntry) || !membership.resolvedIn(person)) {
        throw new Error(NOT_RESOLVED_HERE);
      }
      if (membership.personId !== settings.actorId) {
        throw new Error(PERSON_ELSEWHERE);
      }
      if (companySet) {
        throw new Error(COMPANY_SET);
      }
      companySet = true;
      await tx.query(SET_COMPANY, [membership.companyId]);
    },
    inNewCompany: async (work) => {
      if (companySet) {
        throw new Error(COMPANY_SET);
      }
      companySet = true;
      const companyId = randomUUID();
      await tx.query(SET_COMPANY, [companyId]);
      // A throw of the work rolls the transaction back, with the company.
      const result = await work(companyId);
      await tx.query(SET_COMPANY, [""]);
      return result;
    },
  };
  return person;
}

/**
 * Runs `work` in one transaction that `begin` opens, on a connection of the
 * pool. `over` gives the work its view of the transaction.
 */
async function runInTransaction<T, Q extends Queryable>(
  pool: Pool,
  begin: string,
  settings: TransactionSettings,
  over: (tx: Queryable) => Q,
  work: (tx: Q) => Promise<Ending<T>>,
  onConnectionError: (error: Error) => void,
): Promise<T> {
  // Before a connection is asked for, so a company that the one function did not give, and an actor without its via, send no statement.
  const company = companyOf(settings);
  const [viaKind, viaId] = viaSettings(settings.actorKind, settings.via);
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
      await client.query(SETTINGS, [company, settings.actorId ?? "", settings.actorKind ?? "", settings.channel, viaKind, viaId]);
      ending = await work(over(tx));
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

/** The transaction as it is, for a read or a write. */
function same(tx: Queryable): Queryable {
  return tx;
}

/** The database over `pool`, whose connections log in as nortfox_app. */
export function databaseOver(pool: Pool, onConnectionError: (error: Error) => void): Database {
  // An idle connection that PostgreSQL ends leaves the pool, which emits its error here.
  pool.on("error", onConnectionError);
  return {
    read: (settings, work) => runInTransaction(pool, READ, settings, same, work, onConnectionError),
    write: (settings, work) => runInTransaction(pool, WRITE, settings, same, work, onConnectionError),
    person: (mode, settings, work) => runInTransaction(pool, mode === "read" ? READ : WRITE, settings, (tx) => personOver(tx, settings), work, onConnectionError),
    lookup: (channel, work) => runInTransaction(pool, WRITE, { channel }, lookupOver, work, onConnectionError),
    end: () => pool.end(),
  };
}

/** A database with a pool of its own, from a connection's config (connect.ts). The pool connects when the first request comes. */
export function createDatabase(config: ClientConfig, options: DatabaseOptions): Database {
  return databaseOver(new Pool({ ...config, max: options.max }), options.onConnectionError);
}
