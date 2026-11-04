// SPDX-License-Identifier: AGPL-3.0-only

// The tests' scan of answers and reports (test/secrets.ts) is a guard of its
// own: it must fail on a token that leaks, also a login challenge outside the
// one answer that gives it.

import { describe, expect, it } from "vitest";
import { expectNoTokensButChallenges } from "../../test/secrets.ts";
import { newToken } from "./tokens.ts";

describe("the scan of answers and reports", () => {
  const challenge = newToken("challenge");
  const answer = JSON.stringify({ outcome: "totp-required", challenge });

  it("lets a login challenge through only in the answer of loginWithPassword that gives it", () => {
    expect(() => {
      expectNoTokensButChallenges([answer, "", JSON.stringify({ outcome: "signed-in" })], [new Error("A fault.")]);
    }).not.toThrow();
  });

  it("fails on the same challenge in a problem, in an answer with more fields, or in a report", () => {
    const leaks: [string[], unknown[]][] = [
      [[answer, JSON.stringify({ code: "sign-in-failed", detail: `No ${challenge}.` })], []],
      [[JSON.stringify({ outcome: "totp-required", challenge, extra: true })], []],
      [[JSON.stringify({ outcome: "signed-in", challenge })], []],
      [[answer], [new Error(`It failed for ${challenge}.`)]],
    ];
    for (const [bodies, reports] of leaks) {
      expect(() => {
        expectNoTokensButChallenges(bodies, reports);
      }).toThrow("A token reached an answer, a tool result or a report.");
    }
  });

  it("fails on a token of another kind anywhere", () => {
    expect(() => {
      expectNoTokensButChallenges([JSON.stringify({ outcome: "totp-required", challenge: newToken("session") })], []);
    }).toThrow("A token reached an answer, a tool result or a report.");
  });
});
