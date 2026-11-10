// SPDX-License-Identifier: AGPL-3.0-only

// The purge (db/README.md, the schema access): every 10 minutes, the server
// runs access.purge_expired with its own clock, which deletes the login rows
// that have passed: challenges, and unused setup links, at their end (a used
// link stays: it names the identity it made), invitation links at their
// end, ended sessions after 30 days, attempt counters after their window, a
// person's idempotency keys after 24 hours, the account events past the 100
// latest of each identity, the MCP login's requests, codes and access tokens
// at their end, a grant family's refresh tokens once all of them have
// passed their end, and an MCP client with no consent 24 hours after it
// registered. It takes the setup links' lock first, as the setup functions
// do, so it and a setup link's use take turns. One run at a time, in a
// transaction of its own. A run that fails goes to the reporter, and the
// next one still runs. The timer does not keep the process alive, and
// stop() waits for a run that has begun.

import { commit, type Database } from "../../db/database.ts";

export const PURGE_EVERY_MS = 10 * 60 * 1000;

export interface PurgeTimer {
  /** Ends the timer, and resolves once a run that has begun has ended. */
  stop(): Promise<void>;
}

export interface PurgeTimerOptions {
  readonly database: Database;
  /** The server's clock. */
  readonly now: () => Date;
  /** Told of a run that fails. */
  readonly report: (error: unknown) => void;
  /** How often it runs. By default every 10 minutes. */
  readonly everyMs?: number;
}

/** Deletes the login rows that have passed at `at`. No row it deletes takes the channel; it is set because every transaction needs one. */
export async function purgeExpired(database: Database, at: Date): Promise<void> {
  await database.write({ channel: "rest" }, async (tx) => {
    await tx.query("SELECT access.purge_expired($1)", [at]);
    return commit(undefined);
  });
}

export function startPurgeTimer(options: PurgeTimerOptions): PurgeTimer {
  const { database, now, report } = options;
  let running: Promise<void> = Promise.resolve();
  const run = async (): Promise<void> => {
    try {
      await purgeExpired(database, now());
    } catch (error) {
      report(error);
    }
  };
  const timer = setInterval(() => {
    // A reporter that fails is let go, so the next run still comes.
    running = running.then(run).catch(() => undefined);
  }, options.everyMs ?? PURGE_EVERY_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      return running;
    },
  };
}
