// SPDX-License-Identifier: AGPL-3.0-only

// The tests' scans (test/secrets.ts) are guards of their own. The scan of
// answers and reports must fail on a token that leaks, also a login
// challenge outside the one answer that gives it. The scan of the database
// must find a password, a code or a TOTP secret in clear in a row, and take
// no digits of a time or an id for a code.

import { describe, expect, it } from "vitest";
import { expectNoTokensButChallenges, holdsSecret } from "../../test/secrets.ts";
import { base32Encode, newTotpSecret } from "./totp.ts";
import { newToken } from "./tokens.ts";

describe("the scan of a database row", () => {
  const row = (fields: Record<string, unknown>): string => JSON.stringify({ id: "0d1a5c3e-1234-4567-8901-123456789012", at: "2090-03-15T10:00:00.123456+00:00", ...fields });

  it("finds a typed password anywhere in a row, in any letter case, but not the empty one", () => {
    expect(holdsSecret(row({ details: { typed: "Fel-Lösenord-Här" } }), { passwords: ["fel-lösenord-här"] })).toBe(true);
    expect(holdsSecret(row({ note: "it was fel-lösenord-här, I think" }), { passwords: ["fel-lösenord-här"] })).toBe(true);
    expect(holdsSecret(row({ details: { typed: "något annat" } }), { passwords: ["fel-lösenord-här", ""] })).toBe(false);
  });

  it("finds a code as a whole JSON string, and not in the digits of a time or an id", () => {
    expect(holdsSecret(row({ details: { code: "123456" } }), { codes: ["123456"] })).toBe(true);
    expect(holdsSecret(row({ name: "123456" }), { codes: ["123456"] })).toBe(true);
    expect(holdsSecret(row({}), { codes: ["123456", "567890"] })).toBe(false);
  });

  it("finds a TOTP secret in hexadecimal or in base32", () => {
    const secret = newTotpSecret();
    expect(holdsSecret(row({ secret: `\\x${secret.toString("hex")}` }), { totpSecrets: [secret] })).toBe(true);
    expect(holdsSecret(row({ uri: `otpauth://totp/x?secret=${base32Encode(secret)}` }), { totpSecrets: [secret] })).toBe(true);
    expect(holdsSecret(row({}), { totpSecrets: [secret] })).toBe(false);
  });
});

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
