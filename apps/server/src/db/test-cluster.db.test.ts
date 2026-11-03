// SPDX-License-Identifier: AGPL-3.0-only

// The test cluster serves one run of the database tests at a time. Its roles
// and its limit of connections belong to the whole cluster. A second run's
// setup would run db/roles.sql again and drop the temporary roles that the
// first run's tests use, and the two runs together would need more
// connections than the cluster has. So a run holds the cluster from its setup
// to its teardown (apps/server/test/cluster.ts). A second run on the same
// cluster says so, and waits until the first ends.

import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { RUN_LOCK, adminClient, holdCluster } from "../../test/cluster.ts";
import { backendPid } from "../../test/database.ts";

/** A key of this file's own, so that its holds never meet the run's. */
const KEY = RUN_LOCK + 1;

/** Whether a new connection as the superuser, in the database postgres, gets the advisory lock `key`. Its end gives the lock back. */
async function isFree(key: number): Promise<boolean> {
  const probe = await adminClient("postgres");
  try {
    const found = await probe.query<{ got: boolean }>("SELECT pg_catalog.pg_try_advisory_lock($1) AS got", [key]);
    return found.rows[0]?.got === true;
  } finally {
    await probe.end();
  }
}

/** The backends that hold the advisory lock `key` in the database postgres, and those that wait for it. */
async function holders(admin: Client, key: number): Promise<{ pid: number; granted: boolean }[]> {
  const found = await admin.query<{ pid: number; granted: boolean }>(
    `SELECT pid, granted FROM pg_catalog.pg_locks
     WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1
       AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = 'postgres')
     ORDER BY granted DESC, pid`,
    [key],
  );
  return found.rows;
}

describe("the test cluster", () => {
  it("is held by this run, so that a second run on it waits", async () => {
    expect(await isFree(RUN_LOCK)).toBe(false);
  });

  it("makes a second hold say that it waits, with the first's backend, and wait until the first ends", async () => {
    const admin = await adminClient("postgres");
    const firstSaid: string[] = [];
    const secondSaid: string[] = [];
    const first = await holdCluster((line) => firstSaid.push(line), KEY);
    let waiting: Promise<Client> | undefined;
    let done = false;
    try {
      const firstPid = await backendPid(first);
      waiting = holdCluster((line) => secondSaid.push(line), KEY);
      void waiting.then(
        () => (done = true),
        () => undefined,
      );
      let found = await holders(admin, KEY);
      for (let attempt = 0; attempt < 1000 && found.length < 2; attempt += 1) {
        await delay(10);
        found = await holders(admin, KEY);
      }
      expect(found.map((row) => row.granted)).toEqual([true, false]);
      expect(found[0]?.pid).toBe(firstPid);
      expect(done).toBe(false);
      expect(firstSaid).toEqual([]);
      expect(secondSaid).toHaveLength(1);
      expect(secondSaid[0]).toMatch(new RegExp(`^Another run of the database tests holds the test cluster at .+ \\(backend ${String(firstPid)}, connected at .+\\)\\. This run waits for it to end\\.$`));
      await first.end();
      const client = await waiting;
      expect((await holders(admin, KEY)).map((row) => [row.pid, row.granted])).toEqual([[await backendPid(client), true]]);
    } finally {
      await first.end();
      await (await waiting)?.end();
      await admin.end();
    }
    expect(await isFree(KEY)).toBe(true);
  });
});
