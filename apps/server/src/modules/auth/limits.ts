// SPDX-License-Identifier: AGPL-3.0-only

// The limits on guessing (choices 3 and 21), NortFox's own. The database
// keeps each account's counters (access.attempt_counters), and the server
// holds the rules, here, as plain functions of a counter and the server's
// time:
//
// - The password step counts failures per account in a window of an hour
//   from its first failure. Up to 5 failures, an attempt runs at once. After
//   the nth failure from the fifth on, the next attempt waits 2^(n-5)
//   seconds after the last failure, at most 60. At 100 failures the step is
//   locked until the window's hour has passed (ASVS 4.0.3 2.2.1).
// - The TOTP step counts wrong codes per identity in a window of 15 minutes.
//   The tenth locks the step for 15 minutes.
//
// A wait is given in whole seconds, rounded up, so Retry-After never says a
// second too few.

import type { Queryable } from "../../db/database.ts";

/** An account's counter of one kind of guess, as access.attempt_counter gives it. */
export interface AttemptCounter {
  readonly failures: number;
  readonly windowStartedAt: Date;
  readonly lastFailureAt: Date;
  readonly lockedUntil: Date | null;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const PASSWORD_WINDOW_MS = 60 * MINUTE;
/** The failures after which each attempt waits. */
export const PASSWORD_FREE_FAILURES = 5;
export const PASSWORD_MAX_DELAY_SECONDS = 60;
/** The failures in a window that lock the step until the window ends. */
export const PASSWORD_CAP = 100;

export const TOTP_WINDOW_MS = 15 * MINUTE;
/** The wrong codes in a window that lock the step. */
export const TOTP_CAP = 10;
export const TOTP_LOCK_MS = 15 * MINUTE;

/** The whole seconds from `at` to `end`, rounded up: at least 1 while `end` is still to come. */
function secondsUntil(end: Date, at: Date): number {
  return Math.ceil((end.getTime() - at.getTime()) / SECOND);
}

/** The seconds an attempt must wait for a lock, or undefined when there is none at `at`. */
export function lockWait(counter: AttemptCounter | undefined, at: Date): number | undefined {
  const until = counter?.lockedUntil;
  return until !== undefined && until !== null && until > at ? secondsUntil(until, at) : undefined;
}

/** The seconds a password attempt at `at` must wait, or undefined when it may run. */
export function passwordWait(counter: AttemptCounter | undefined, at: Date): number | undefined {
  const locked = lockWait(counter, at);
  if (locked !== undefined || counter === undefined) {
    return locked;
  }
  const windowLive = counter.windowStartedAt.getTime() + PASSWORD_WINDOW_MS > at.getTime();
  if (!windowLive || counter.failures < PASSWORD_FREE_FAILURES) {
    return undefined;
  }
  const delay = Math.min(PASSWORD_MAX_DELAY_SECONDS, 2 ** (counter.failures - PASSWORD_FREE_FAILURES));
  const ready = new Date(counter.lastFailureAt.getTime() + delay * SECOND);
  return ready > at ? secondsUntil(ready, at) : undefined;
}

/** When a password step locked at its cap opens again: when its window's hour has passed. */
export function passwordLockEnd(counter: AttemptCounter): Date {
  return new Date(counter.windowStartedAt.getTime() + PASSWORD_WINDOW_MS);
}

/** The kinds of guess that part 1 counts. */
export type AttemptKind = "password" | "totp";

interface CounterRow {
  readonly failures: number;
  readonly window_started_at: Date;
  readonly last_failure_at: Date;
  readonly locked_until: Date | null;
}

function counterOf(row: CounterRow): AttemptCounter {
  return { failures: row.failures, windowStartedAt: row.window_started_at, lastFailureAt: row.last_failure_at, lockedUntil: row.locked_until };
}

/** A subject's counter of one kind, or undefined when it has none. */
export async function attemptCounter(tx: Queryable, subject: string, kind: AttemptKind): Promise<AttemptCounter | undefined> {
  const found = await tx.query<CounterRow>("SELECT failures, window_started_at, last_failure_at, locked_until FROM access.attempt_counter($1, $2)", [subject, kind]);
  const [row] = found.rows;
  return row === undefined ? undefined : counterOf(row);
}

/** Counts one failure in the subject's window of `spanMs`, and gives the counter after it. Parallel calls each count. */
export async function countFailure(tx: Queryable, subject: string, kind: AttemptKind, spanMs: number, at: Date): Promise<AttemptCounter> {
  const found = await tx.query<CounterRow>("SELECT failures, window_started_at, last_failure_at, locked_until FROM access.count_failure($1, $2, $3::interval, $4)", [
    subject,
    kind,
    `${String(spanMs)} milliseconds`,
    at,
  ]);
  // The function always gives the counter it counted in.
  const [row] = found.rows as [CounterRow];
  return counterOf(row);
}

/** Locks the subject's guesses of one kind until `until`. A shorter lock never shortens a longer one. */
export async function lockAttempts(tx: Queryable, subject: string, kind: AttemptKind, until: Date): Promise<void> {
  await tx.query("SELECT access.lock_attempts($1, $2, $3)", [subject, kind, until]);
}

/** Clears the subject's counter of one kind, as a right password does. */
export async function clearAttempts(tx: Queryable, subject: string, kind: AttemptKind): Promise<void> {
  await tx.query("SELECT access.clear_attempts($1, $2)", [subject, kind]);
}
