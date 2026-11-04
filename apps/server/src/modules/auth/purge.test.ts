// SPDX-License-Identifier: AGPL-3.0-only

// The purge timer: every 10 minutes the server runs access.purge_expired with
// its own clock, in a transaction of its own, one run at a time. A run that
// fails goes to the reporter, and the next one still runs. stop() ends the
// timer and waits for a run that has begun. purge.db.test.ts tests the
// purge itself.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDatabase } from "../../../test/shapes.ts";
import type { Database } from "../../db/database.ts";
import { PURGE_EVERY_MS, purgeExpired, startPurgeTimer } from "./purge.ts";

const AT = new Date("2090-03-15T10:00:00.000Z");

/** A database whose transactions run the purge's one query, and record it. */
function purgingDatabase(fail: () => boolean = () => false): { database: Database; runs: { readonly sql: string; readonly values: readonly unknown[]; readonly channel: string }[] } {
  const runs: { sql: string; values: readonly unknown[]; channel: string }[] = [];
  const base = fakeDatabase();
  const database: Database = {
    ...base,
    write: (settings, work) =>
      work({
        query: (sql, values = []) => {
          runs.push({ sql, values, channel: settings.channel });
          return fail() ? Promise.reject(new Error("The purge failed.")) : Promise.resolve({ rows: [] } as never);
        },
      }).then((ending) => ending.value),
  };
  return { database, runs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the purge", () => {
  it("runs access.purge_expired with the server's time", async () => {
    const { database, runs } = purgingDatabase();
    await purgeExpired(database, AT);
    expect(runs).toEqual([{ sql: "SELECT access.purge_expired($1)", values: [AT], channel: "rest" }]);
  });

  it("runs every 10 minutes with the clock's time, and stop ends it", async () => {
    vi.useFakeTimers();
    const { database, runs } = purgingDatabase();
    let now = AT;
    const timer = startPurgeTimer({ database, now: () => now, report: () => undefined });
    expect(PURGE_EVERY_MS).toBe(10 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(PURGE_EVERY_MS - 1);
    expect(runs).toEqual([]);
    now = new Date(AT.getTime() + PURGE_EVERY_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs.map((run) => run.values)).toEqual([[now]]);
    await vi.advanceTimersByTimeAsync(PURGE_EVERY_MS);
    expect(runs).toHaveLength(2);
    await timer.stop();
    await vi.advanceTimersByTimeAsync(3 * PURGE_EVERY_MS);
    expect(runs).toHaveLength(2);
  });

  it("tells the reporter of a run that fails, and runs again on the next tick, also when the reporter fails", async () => {
    vi.useFakeTimers();
    const { database, runs } = purgingDatabase(() => true);
    const reported: unknown[] = [];
    const timer = startPurgeTimer({
      database,
      now: () => AT,
      everyMs: 1000,
      report: (error) => {
        reported.push(error);
        throw new Error("The reporter failed too.");
      },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs).toHaveLength(3);
    expect(reported.map((error) => (error as Error).message)).toEqual(["The purge failed.", "The purge failed.", "The purge failed."]);
    await timer.stop();
  });

  it("waits in stop for a run that has begun", async () => {
    vi.useFakeTimers();
    const held = Promise.withResolvers<undefined>();
    let ended = false;
    const database: Database = {
      ...fakeDatabase(),
      write: async () => {
        await held.promise;
        ended = true;
        return undefined as never;
      },
    };
    const timer = startPurgeTimer({ database, now: () => AT, everyMs: 1000, report: () => undefined });
    await vi.advanceTimersByTimeAsync(1000);
    const stopped = timer.stop();
    expect(ended).toBe(false);
    held.resolve(undefined);
    await stopped;
    expect(ended).toBe(true);
  });

  it("lets the process end while the timer waits", async () => {
    const real = setInterval;
    const handles: NodeJS.Timeout[] = [];
    vi.stubGlobal("setInterval", (...args: Parameters<typeof setInterval>) => {
      const handle = real(...args);
      handles.push(handle);
      return handle;
    });
    try {
      const timer = startPurgeTimer({ database: purgingDatabase().database, now: () => AT, report: () => undefined });
      expect(handles.map((handle) => handle.hasRef())).toEqual([false]);
      await timer.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
