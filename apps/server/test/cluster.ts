// SPDX-License-Identifier: AGPL-3.0-only

// The test cluster: a PostgreSQL cluster of its own, with trust authentication
// for local connections, reached as a superuser through
// NORTFOX_TEST_DATABASE_URL. `pnpm db:test` starts one
// (deploy/test-database/compose.yaml), and CI runs one as a service.
//
// Roles belong to the whole cluster, so the tests run only on a cluster that
// holds nothing but the databases they make. They drop only those, by the
// prefix nortfox_test_.

import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { connectionConfig, typeParsers } from "../src/db/connect.ts";

export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:55433/postgres";

/** db/roles.sql, which the setup runs as a superuser, as an install's init step does. */
export const ROLES_FILE = fileURLToPath(new URL("../../../db/roles.sql", import.meta.url));

/** The two reader roles the tests bind to companies. Each is a member of nortfox_reader. */
export const TEST_READERS = ["nortfox_test_reader_a", "nortfox_test_reader_b"] as const;

/** The prefix of every database the tests make. */
export const PREFIX = "nortfox_test_";

/** The databases a cluster holds of its own. */
const CLUSTER_DATABASES = ["postgres", "template0", "template1"];

export function adminUrl(): string {
  const url = process.env["NORTFOX_TEST_DATABASE_URL"];
  return url === undefined || url === "" ? DEFAULT_TEST_DATABASE_URL : url;
}

/** A client that ignores the error event: a test that ends a connection on purpose must not crash the run. */
function quiet(client: Client): Client {
  client.on("error", () => undefined);
  return client;
}

/** The superuser, in `database` (by default the one the address names). For setup only, never for a rule test. */
export async function adminClient(database?: string): Promise<Client> {
  const url = new URL(adminUrl());
  if (database !== undefined) {
    url.pathname = `/${database}`;
  }
  const client = quiet(new Client({ connectionString: url.toString(), types: typeParsers }));
  try {
    await client.connect();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No test database at ${adminUrl()} (${cause}). Start one with "pnpm db:test", or set NORTFOX_TEST_DATABASE_URL to a superuser on a cluster of its own.`,
      { cause: error },
    );
  }
  return client;
}

/** The address of `database` on the test cluster as `role`, without a password: the cluster trusts local connections. */
export function urlOf(role: string, database: string): string {
  const url = new URL(adminUrl());
  url.username = role;
  url.password = "";
  url.pathname = `/${database}`;
  return url.toString();
}

/** `role` in `database`, with trust authentication. */
export async function connectAs(role: string, database: string): Promise<Client> {
  const client = quiet(new Client(connectionConfig(urlOf(role, database))));
  await client.connect();
  return client;
}

/**
 * Refuses a cluster that is not the tests' own: a role that is not a
 * superuser, or a cluster that holds a database the tests did not make.
 */
export async function refuseSharedCluster(admin: Client): Promise<void> {
  const superuser = await admin.query<{ super: boolean }>("SELECT rolsuper AS super FROM pg_catalog.pg_roles WHERE rolname = current_user");
  if (superuser.rows[0]?.super !== true) {
    throw new Error(`NORTFOX_TEST_DATABASE_URL must name a superuser. ${adminUrl()} does not.`);
  }
  const others = await admin.query<{ name: string }>(
    "SELECT datname AS name FROM pg_catalog.pg_database WHERE NOT (datname = ANY ($1)) AND left(datname, length($2)) <> $2 ORDER BY 1",
    [CLUSTER_DATABASES, PREFIX],
  );
  if (others.rows.length > 0) {
    throw new Error(
      `The test cluster at ${adminUrl()} holds the database ${others.rows.map((row) => row.name).join(", ")}. ` +
        'The database tests make roles for the whole cluster, so they run only on a cluster of their own, such as the one "pnpm db:test" starts.',
    );
  }
}

/** Makes a reader role that is missing, and sets its attributes and its membership of nortfox_reader. */
export async function makeReaderRole(admin: Client, role: string): Promise<void> {
  await admin.query(
    `DO $reader$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF; END $reader$`,
  );
  await admin.query(`ALTER ROLE ${role} WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await admin.query(`GRANT nortfox_reader TO ${role} WITH INHERIT TRUE, SET FALSE`);
}

/** Drops a database the tests made, and its template mark first. */
export async function dropDatabase(admin: Client, name: string): Promise<void> {
  if (!name.startsWith(PREFIX)) {
    throw new Error(`The tests drop only their own databases, not ${name}.`);
  }
  await admin.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE false`);
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
}

/** Drops every database of a run. */
export async function dropRunDatabases(run: string): Promise<void> {
  const admin = await adminClient();
  try {
    const found = await admin.query<{ name: string }>(
      "SELECT datname AS name FROM pg_catalog.pg_database WHERE left(datname, length($1)) = $1 ORDER BY 1",
      [`${PREFIX}${run}_`],
    );
    for (const { name } of found.rows) {
      await dropDatabase(admin, name);
    }
  } finally {
    await admin.end();
  }
}
