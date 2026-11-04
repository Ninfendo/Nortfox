// SPDX-License-Identifier: AGPL-3.0-only

// The limits on guessing (choices 3 and 21), as pure rules of a counter and
// the server's time. The database keeps the counters; these rules say how
// long an attempt must wait, in whole seconds, or that it may run.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PASSWORD_CAP, PASSWORD_WINDOW_MS, TOTP_CAP, TOTP_LOCK_MS, TOTP_WINDOW_MS, lockWait, passwordLockEnd, passwordWait, totpWait, type AttemptCounter } from "./limits.ts";

const T0 = new Date("2090-03-15T10:00:00.000Z");

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

function counter(failures: number, lastFailure: number, options: { readonly started?: number; readonly lockedUntil?: number } = {}): AttemptCounter {
  return { failures, windowStartedAt: at(options.started ?? 0), lastFailureAt: at(lastFailure), lockedUntil: options.lockedUntil === undefined ? null : at(options.lockedUntil) };
}

describe("the password step's wait", () => {
  it("lets an attempt run with no counter, and with up to 4 failures at once", () => {
    expect(passwordWait(undefined, T0)).toBeUndefined();
    expect(passwordWait(counter(4, 0), T0)).toBeUndefined();
  });

  it("makes the attempt after the nth failure from the fifth on wait 2^(n-5) seconds after the last failure, at most 60", () => {
    expect([5, 6, 7, 8, 9, 10, 11, 12, 50].map((failures) => passwordWait(counter(failures, 10), at(10)))).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
    // The wait counts from the last failure, in whole seconds rounded up.
    expect(passwordWait(counter(7, 10), at(12.5))).toBe(2);
    expect(passwordWait(counter(7, 10), at(13.999))).toBe(1);
    expect(passwordWait(counter(7, 10), at(14))).toBeUndefined();
  });

  it("forgets the failures once their window's hour has passed, so no wait goes past the window's end", () => {
    expect(passwordWait(counter(9, 3500, { started: 0 }), at(3500))).toBe(16);
    expect(passwordWait(counter(9, 3599, { started: 0 }), at(3599))).toBe(1);
    expect(passwordWait(counter(9, 3599, { started: 0 }), at(3600))).toBeUndefined();
  });

  it("waits for a lock until it ends, also when the window has passed", () => {
    expect(passwordWait(counter(100, 60, { lockedUntil: 3600 }), at(120))).toBe(3480);
    expect(passwordWait(counter(100, 60, { started: 0, lockedUntil: 4000 }), at(3700))).toBe(300);
    // A lock that has ended waits no more.
    expect(passwordWait(counter(2, 60, { lockedUntil: 100 }), at(100))).toBeUndefined();
  });

  it("locks at 100 failures until the window's hour has passed", () => {
    expect(PASSWORD_CAP).toBe(100);
    expect(PASSWORD_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(passwordLockEnd(counter(100, 900, { started: 120 }))).toEqual(at(120 + 3600));
  });

  it("makes every attempt wait at 100 failures until the window's hour has passed, also before the lock is written", () => {
    // A counter at the cap is locked: the attempt that reached it may still be checking its password.
    expect(passwordWait(counter(100, 900, { started: 120 }), at(1000))).toBe(120 + 3600 - 1000);
    expect(passwordWait(counter(99, 900, { started: 120 }), at(1000))).toBeUndefined();
    expect(passwordWait(counter(100, 900, { started: 120 }), at(3720))).toBeUndefined();
  });

  it("never waits less after one more failure, inside a window", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 150 }), fc.integer({ min: 0, max: 3599 }), fc.integer({ min: 0, max: 3599 }), (failures, last, since) => {
        const now = at(Math.min(last + since, 3599));
        const before = passwordWait(counter(failures, last), now) ?? 0;
        const after = passwordWait(counter(failures + 1, last), now) ?? 0;
        expect(after).toBeGreaterThanOrEqual(before);
      }),
    );
  });
});

describe("the TOTP step's lock", () => {
  it("is 10 wrong codes in 15 minutes, which lock the step for 15 minutes", () => {
    expect([TOTP_CAP, TOTP_WINDOW_MS, TOTP_LOCK_MS]).toEqual([10, 15 * 60 * 1000, 15 * 60 * 1000]);
  });

  it("makes an attempt wait while the lock lasts, and only then", () => {
    expect(lockWait(undefined, T0)).toBeUndefined();
    expect(lockWait(counter(9, 0), T0)).toBeUndefined();
    expect(lockWait(counter(10, 0, { lockedUntil: 900 }), at(0.5))).toBe(900);
    expect(lockWait(counter(10, 0, { lockedUntil: 900 }), at(899.001))).toBe(1);
    expect(lockWait(counter(10, 0, { lockedUntil: 900 }), at(900))).toBeUndefined();
  });

  it("makes every attempt wait at 10 wrong codes for 15 minutes from the tenth, also before the lock is written", () => {
    expect(totpWait(undefined, T0)).toBeUndefined();
    expect(totpWait(counter(9, 100), at(200))).toBeUndefined();
    // The tenth code may still be checked: the counter at the cap locks the step on its own.
    expect(totpWait(counter(10, 100), at(200))).toBe(900 - 100);
    expect(totpWait(counter(10, 100, { lockedUntil: 1000 }), at(200))).toBe(800);
    // After the window of 15 minutes from the first wrong code, the counter at the cap still locks until 15 minutes from the tenth.
    expect(totpWait(counter(10, 100), at(900))).toBe(100);
    expect(totpWait(counter(10, 100, { lockedUntil: 1000 }), at(900))).toBe(100);
    expect(totpWait(counter(10, 100), at(1000))).toBeUndefined();
  });

  it("locks the step for 15 minutes from a tenth code counted just before its window ends, before the lock is written", () => {
    // The tenth code came 1 ms before the window's end; the next comes 1 ms after it, while the tenth is still being checked.
    expect(totpWait(counter(10, 899.999), at(900.001))).toBe(900);
    expect(totpWait(counter(10, 899.999), at(1799.998))).toBe(1);
    expect(totpWait(counter(10, 899.999), at(1799.999))).toBeUndefined();
  });
});
