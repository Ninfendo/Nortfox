// SPDX-License-Identifier: AGPL-3.0-only

// The limits on guessing (choices 3 and 21), NortFox's own. The database
// keeps each account's counters (access.attempt_counters), and the server
// holds the rules, here, as plain functions of a counter and the server's
// time:
//
// - The password step counts failures per account in a window of an hour
//   from its first failure. Up to 5 failures, an attempt runs at once. After
//   the nth failure from the fifth on, the next attempt waits 2^(n-5)
//   seconds after the last failure, at most 60, and never past the window's
//   end, when its failures are forgotten. At 100 failures the step is locked
//   until the window's hour has passed (ASVS 4.0.3 2.2.1).
// - The TOTP step counts wrong codes per identity in a window of 15 minutes.
//   The tenth locks the step for 15 minutes.
//
// An attempt is counted before it is checked (access.count_failure), under
// the counter's row lock, and the rules decide from the counter as it was
// just before. So attempts sent at once come one after another, each sees the
// ones before it, and a burst gets no more through than one attempt after
// another would. A counter at its cap is locked by the rules alone, so the
// attempt that reached the cap, while it is still being checked, already
// stops the next one. An attempt that the rules refuse rolls its count back,
// and one whose check finds no failure gives it back.
//
// A wait is given in whole seconds, rounded up, so Retry-After never says a
// second too few.

import type { Queryable } from "../../db/database.ts";

/** An account's counter of one kind of guess, as access.count_failure gives it. */
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

/** Whether the counter's window of `spanMs` from its first failure still holds at `at`. */
function windowLive(counter: AttemptCounter, spanMs: number, at: Date): boolean {
  return counter.windowStartedAt.getTime() + spanMs > at.getTime();
}

/** The seconds a password attempt at `at` must wait, or undefined when it may run. */
export function passwordWait(counter: AttemptCounter | undefined, at: Date): number | undefined {
  const locked = lockWait(counter, at);
  if (locked !== undefined || counter === undefined) {
    return locked;
  }
  if (!windowLive(counter, PASSWORD_WINDOW_MS, at) || counter.failures < PASSWORD_FREE_FAILURES) {
    return undefined;
  }
  const end = passwordLockEnd(counter);
  if (counter.failures >= PASSWORD_CAP) {
    return secondsUntil(end, at);
  }
  const delay = Math.min(PASSWORD_MAX_DELAY_SECONDS, 2 ** (counter.failures - PASSWORD_FREE_FAILURES));
  // The window's end forgets the failures, so no wait goes past it.
  const ready = new Date(Math.min(counter.lastFailureAt.getTime() + delay * SECOND, end.getTime()));
  return ready > at ? secondsUntil(ready, at) : undefined;
}

/** When a password step locked at its cap opens again: when its window's hour has passed. */
export function passwordLockEnd(counter: AttemptCounter): Date {
  return new Date(counter.windowStartedAt.getTime() + PASSWORD_WINDOW_MS);
}

/** The seconds a TOTP attempt at `at` must wait, or undefined when it may run. */
export function totpWait(counter: AttemptCounter | undefined, at: Date): number | undefined {
  const locked = lockWait(counter, at);
  if (locked !== undefined || counter === undefined) {
    return locked;
  }
  return windowLive(counter, TOTP_WINDOW_MS, at) && counter.failures >= TOTP_CAP ? secondsUntil(totpLockEnd(counter.lastFailureAt), at) : undefined;
}

/** When a TOTP step locked by a wrong code at `at` opens again. */
export function totpLockEnd(at: Date): Date {
  return new Date(at.getTime() + TOTP_LOCK_MS);
}

/** The kinds of guess that part 1 counts. */
export type AttemptKind = "password" | "totp";

interface CounterRow {
  readonly failures: number;
  readonly window_started_at: Date;
  readonly last_failure_at: Date;
  readonly locked_until: Date | null;
}

/** A count's row: the counter after it, and the one before it, which is all NULL before the subject's first failure. */
type CountRow = CounterRow &
  (
    | { readonly before_failures: null; readonly before_window_started_at: null; readonly before_last_failure_at: null; readonly before_locked_until: null }
    | { readonly before_failures: number; readonly before_window_started_at: Date; readonly before_last_failure_at: Date; readonly before_locked_until: Date | null }
  );

/** A counted attempt: the counter as it was just before the count, if there was one, and after it. */
export interface Counted {
  readonly before: AttemptCounter | undefined;
  readonly after: AttemptCounter;
}

/**
 * Counts one attempt in the subject's window of `spanMs`, before it is
 * checked, and gives the counter just before the count and after it.
 * Parallel calls count one after another under the counter's row lock, so
 * each sees the counts before its own. The caller rolls the count back when
 * the rules refuse the attempt.
 */
export async function countFailure(tx: Queryable, subject: string, kind: AttemptKind, spanMs: number, at: Date): Promise<Counted> {
  const found = await tx.query<CountRow>("SELECT * FROM access.count_failure($1, $2, $3::interval, $4)", [subject, kind, `${String(spanMs)} milliseconds`, at]);
  // The function always gives the counter it counted in.
  const [row] = found.rows as [CountRow];
  const after: AttemptCounter = { failures: row.failures, windowStartedAt: row.window_started_at, lastFailureAt: row.last_failure_at, lockedUntil: row.locked_until };
  const before =
    row.before_failures === null
      ? undefined
      : { failures: row.before_failures, windowStartedAt: row.before_window_started_at, lastFailureAt: row.before_last_failure_at, lockedUntil: row.before_locked_until };
  return { before, after };
}

/** Gives back an attempt that was counted before its check, when the check found no failure. */
export async function giveBackFailure(tx: Queryable, subject: string, kind: AttemptKind): Promise<void> {
  await tx.query("SELECT access.give_back_failure($1, $2)", [subject, kind]);
}

/** Locks the subject's guesses of one kind until `until`. A shorter lock never shortens a longer one. */
export async function lockAttempts(tx: Queryable, subject: string, kind: AttemptKind, until: Date): Promise<void> {
  await tx.query("SELECT access.lock_attempts($1, $2, $3)", [subject, kind, until]);
}

/** Clears the subject's counter of one kind, as a right password does. */
export async function clearAttempts(tx: Queryable, subject: string, kind: AttemptKind): Promise<void> {
  await tx.query("SELECT access.clear_attempts($1, $2)", [subject, kind]);
}
