// SPDX-License-Identifier: AGPL-3.0-only

// Before the database tests: the cluster roles from db/roles.sql, the test
// reader roles, and one template database, set up by db/database.sql as an
// install's database is, that the real runner migrates as the owner. Each
// test file clones the template (database.ts). After the tests, every
// database of the run is dropped.
//
// With no test cluster, the setup fails with one line that says how to start
// one. It never skips the database tests.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TestProject } from "vitest/node";
import { migrate, readMigrations } from "../src/db/migrate.ts";
import {
  DATABASE_FILE,
  PREFIX,
  ROLES_FILE,
  TEST_READERS,
  adminClient,
  connectAs,
  dropRunDatabases,
  dropTemporaryRoles,
  makeReaderRole,
  refuseSharedCluster,
} from "./cluster.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** The id of this run, in the name of every database it makes. */
    nortfoxRun: string;
    /** The migrated template database that each test file clones. */
    nortfoxTemplate: string;
  }
}

/**
 * The error as one plain line. Vitest maps the stack of an error from a global
 * setup through its module runner, which fails on frames from the database
 * driver and then shows its own error in place of ours.
 */
function plain(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const found = new Error(message);
  found.stack = `Error: ${message}`;
  return found;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  try {
    return await prepare(project);
  } catch (error) {
    throw plain(error);
  }
}

async function prepare(project: TestProject): Promise<() => Promise<void>> {
  const run = randomBytes(5).toString("hex");
  const template = `${PREFIX}${run}_template`;
  const admin = await adminClient();
  try {
    await refuseSharedCluster(admin);
    await admin.query(readFileSync(ROLES_FILE, "utf8"));
    for (const reader of TEST_READERS) {
      await makeReaderRole(admin, reader);
    }
    await dropTemporaryRoles(admin);
    await admin.query(`CREATE DATABASE ${template} OWNER nortfox_owner`);
    const inTemplate = await adminClient(template);
    try {
      await inTemplate.query(readFileSync(DATABASE_FILE, "utf8"));
    } finally {
      await inTemplate.end();
    }
    const owner = await connectAs("nortfox_owner", template);
    try {
      await migrate(owner, readMigrations());
    } finally {
      await owner.end();
    }
    await admin.query(`ALTER DATABASE ${template} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  } catch (error) {
    await admin.end();
    await dropRunDatabases(run);
    throw error;
  }
  await admin.end();
  project.provide("nortfoxRun", run);
  project.provide("nortfoxTemplate", template);
  return () => dropRunDatabases(run);
}
