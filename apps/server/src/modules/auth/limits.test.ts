// SPDX-License-Identifier: AGPL-3.0-only

// The limits on guessing (choices 3 and 21), as pure rules of a counter and
// the server's time. The database keeps the counters; these rules say how
// long an attempt must wait, in whole seconds, or that it may run.

import { describe, expect, it } from "vitest";
import { PASSWORD_CAP, PASSWORD_WINDOW_MS, TOTP_CAP, TOTP_LOCK_MS, TOTP_WINDOW_MS, lockWait, passwordLockEnd, passwordWait, type AttemptCounter } from "./limits.ts";

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

  it("forgets the failures once their window's hour has passed", () => {
    expect(passwordWait(counter(9, 3599, { started: 0 }), at(3599))).toBe(16);
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
});
