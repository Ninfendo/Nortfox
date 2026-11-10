// SPDX-License-Identifier: AGPL-3.0-only

// A database of its own for each test file, and the helpers the database
// tests share. Rule tests run as nortfox_app, unless they test another role.
// The superuser is for setup only.

import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "pg";
import { expect, inject } from "vitest";
import { codeOf, readRefusal, type RefusalReason } from "../src/db/refusals.ts";
import { PREFIX, TEST_READERS, adminClient, connectAs, dropDatabase } from "./cluster.ts";

/** The roles a test connects as. */
export const ROLES = {
  owner: "nortfox_owner",
  app: "nortfox_app",
  readerA: TEST_READERS[0],
  readerB: TEST_READERS[1],
} as const;

export type Role = keyof typeof ROLES;

export interface TestDatabase {
  readonly name: string;
  /** A new connection as `role`. close() ends it. */
  connect(role: Role): Promise<Client>;
  /** A new connection as the superuser, for setup only. close() ends it. */
  admin(): Promise<Client>;
  /** Ends every connection and drops the database. */
  close(): Promise<void>;
}

/** Locks the admin connection's clones apart, so that two never copy the template at once. */
const CLONE_LOCK = 4_646_212;

function databaseName(): string {
  return `${PREFIX}${inject("nortfoxRun")}_${randomBytes(6).toString("hex")}`;
}

function testDatabase(name: string): TestDatabase {
  const clients: Client[] = [];
  const track = async (client: Promise<Client>): Promise<Client> => {
    const connected = await client;
    clients.push(connected);
    return connected;
  };
  return {
    name,
    connect: (role) => track(connectAs(ROLES[role], name)),
    admin: () => track(adminClient(name)),
    async close() {
      await Promise.all(clients.splice(0).map((client) => client.end()));
      const admin = await adminClient();
      try {
        await dropDatabase(admin, name);
      } finally {
        await admin.end();
      }
    },
  };
}

/** The privileges on a database, sorted, as "grantee:privilege". */
async function databasePrivileges(admin: Client, name: string): Promise<string[]> {
  const found = await admin.query<{ entry: string }>(
    `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS entry
     FROM pg_catalog.pg_database AS d, pg_catalog.aclexplode(d.datacl) AS a
     WHERE d.datname = $1 ORDER BY 1`,
    [name],
  );
  return found.rows.map((row) => row.entry);
}

/**
 * A copy of the migrated template. CREATE DATABASE does not copy a database's
 * own privileges, so they are set again, as the migration set them on the
 * template, and checked.
 */
export async function freshDatabase(): Promise<TestDatabase> {
  const template = inject("nortfoxTemplate");
  const name = databaseName();
  const admin = await adminClient();
  try {
    await admin.query("SELECT pg_catalog.pg_advisory_lock($1)", [CLONE_LOCK]);
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template} OWNER nortfox_owner`);
    } finally {
      await admin.query("SELECT pg_catalog.pg_advisory_unlock($1)", [CLONE_LOCK]);
    }
    const wanted = await databasePrivileges(admin, template);
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    for (const entry of wanted) {
      const [grantee = "", privilege = ""] = entry.split(":");
      if (grantee !== "nortfox_owner") {
        await admin.query(`GRANT ${privilege} ON DATABASE ${name} TO ${grantee}`);
      }
    }
    expect(await databasePrivileges(admin, name)).toEqual(wanted);
  } finally {
    await admin.end();
  }
  return testDatabase(name);
}

/** An empty database owned by the owner role, for the runner's tests. */
export async function emptyDatabase(): Promise<TestDatabase> {
  const name = databaseName();
  const admin = await adminClient();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER nortfox_owner`);
  } finally {
    await admin.end();
  }
  return testDatabase(name);
}

/** The isolation levels a transaction can ask for. */
export const ISOLATION_LEVELS = ["read uncommitted", "read committed", "repeatable read", "serializable"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

/**
 * The settings a transaction may carry. A setting left out is not set, and
 * the isolation level is then the default, READ COMMITTED. An integration
 * names the API token or the MCP client it acts through: viaKind and viaId.
 */
export interface Settings {
  readonly company?: string;
  readonly actor?: string;
  readonly kind?: string;
  readonly viaKind?: string;
  readonly viaId?: string;
  readonly channel?: string;
  readonly isolation?: IsolationLevel;
}

const SETTING_NAMES = {
  company: "nortfox.company_id",
  actor: "nortfox.actor_id",
  kind: "nortfox.actor_kind",
  viaKind: "nortfox.via_kind",
  viaId: "nortfox.via_id",
  channel: "nortfox.channel",
} as const;

/**
 * Starts a transaction with the settings, as the server does:
 * set_config(name, value, true). The caller commits or rolls it back.
 */
export async function begin(client: Client, settings: Settings): Promise<void> {
  await client.query(settings.isolation === undefined ? "BEGIN" : `BEGIN ISOLATION LEVEL ${settings.isolation.toUpperCase()}`);
  for (const key of ["company", "actor", "kind", "viaKind", "viaId", "channel"] as const) {
    const value = settings[key];
    if (value !== undefined) {
      await client.query("SELECT pg_catalog.set_config($1, $2, true)", [SETTING_NAMES[key], value]);
    }
  }
}

/** Runs `work` in one transaction with the settings, as the server does: set_config(name, value, true). */
export async function inTransaction<T>(client: Client, settings: Settings, work: () => Promise<T>): Promise<T> {
  try {
    await begin(client, settings);
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** What a promise rejected with, or undefined when it resolved. */
export async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function sqlState(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

/** Expects the database to refuse with `reason`, its SQLSTATE and, when given, exactly these facts. */
export async function expectRefusal(promise: Promise<unknown>, reason: RefusalReason, facts?: Record<string, unknown>): Promise<void> {
  const error = await failureOf(promise);
  expect(error, `The database should refuse with ${reason}, but it did not refuse.`).toBeDefined();
  expect(sqlState(error), String(error)).toBe(codeOf(reason));
  const refusal = readRefusal(error);
  expect(refusal?.reason).toBe(reason);
  if (facts !== undefined) {
    expect(refusal?.facts).toEqual(facts);
  }
}

/** Expects PostgreSQL's own error with this SQLSTATE, and a message that matches. */
export async function expectError(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const error = await failureOf(promise);
  expect(error, `The database should fail with ${code}, but it did not fail.`).toBeDefined();
  expect(sqlState(error), String(error)).toBe(code);
  if (message !== undefined) {
    expect(String(error)).toMatch(message);
  }
}

/** The SQLSTATE of "insufficient privilege", and of a row that a row level security policy refuses. */
export const INSUFFICIENT_PRIVILEGE = "42501";

/** PostgreSQL's SQLSTATEs for a unique key, an exclusion constraint and a check that refused a row. */
export const UNIQUE_VIOLATION = "23505";
export const EXCLUSION_VIOLATION = "23P01";
export const CHECK_VIOLATION = "23514";

/** The process id of the connection's backend, so that another connection can watch it. */
export async function backendPid(client: Client): Promise<number> {
  const found = await client.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid");
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The backend gave no process id.");
  }
  return row.pid;
}

/**
 * Waits until the backend `pid` waits for a lock that another transaction
 * holds. `observer` must log in as the same role, which pg_stat_activity
 * shows that backend's wait to.
 */
export async function untilWaitingForLock(observer: Client, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const found = await observer.query<{ waiting: boolean }>(
      "SELECT wait_event_type IS NOT DISTINCT FROM 'Lock' AS waiting FROM pg_catalog.pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (found.rows[0]?.waiting === true) {
      return;
    }
    await delay(10);
  }
  throw new Error(`The backend ${String(pid)} never waited for a lock.`);
}
