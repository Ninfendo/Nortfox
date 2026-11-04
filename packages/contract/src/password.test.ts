// SPDX-License-Identifier: AGPL-3.0-only

// The check of a new password in an operation's body: the rule's field
// problem at the field, beside every other field problem of the body, and
// never the password itself, also when the parse reports the input. The
// server's password tests (apps/server/src/auth/password.test.ts) walk the
// rule itself.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { newPassword, newPasswordIssue } from "./password.ts";
import { fieldIssues } from "./problem.ts";

const Body = z.strictObject({ name: z.string().min(1), password: z.string().check(newPassword()) });

describe("newPassword", () => {
  it.each([
    ["11 characters", "elva-tecken", "too-short"],
    ["more than 1024 characters", "å".repeat(1025), "too-long"],
    ["a lone surrogate", "första-lösenordet-\uD800", "invalid-value"],
    ["31 combining marks in a row", `a${"\u0301".repeat(31)}bcdefghijkl`, "invalid-value"],
  ])("refuses %s as the rule's field problem, with no value", (_case, password, code) => {
    const result = Body.safeParse({ name: "Signe Ek", password }, { reportInput: true });
    expect(result.success).toBe(false);
    const issues = fieldIssues(result.error?.issues ?? []);
    expect(issues).toEqual([newPasswordIssue(password, "/password")]);
    expect(issues[0]?.code).toBe(code);
    expect(result.error?.issues.map((issue) => issue.input)).toEqual([undefined]);
  });

  it("gives the password's problem with the other field problems of the body", () => {
    const result = Body.safeParse({ name: "", password: "elva-tecken" }, { reportInput: true });
    expect(fieldIssues(result.error?.issues ?? []).map((issue) => [issue.code, issue.pointer])).toEqual([
      ["too-short", "/name"],
      ["too-short", "/password"],
    ]);
  });

  it("takes a password of 12 to 1024 characters, counted after NFC", () => {
    // é as e and a combining accent is one character: twelve in all.
    for (const password of ["tolv-tecken!", "elva-tecke\u0301n!", "å".repeat(1024)]) {
      expect(Body.safeParse({ name: "Signe Ek", password }).success).toBe(true);
    }
  });
});
