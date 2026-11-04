// SPDX-License-Identifier: AGPL-3.0-only

// A text that the server stores or looks up refuses U+0000, which
// PostgreSQL's text cannot hold, as a field problem at its pointer.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bodySchema } from "./operation.ts";
import { completeSetup, loginWithPassword } from "./operations/auth.ts";
import { fieldIssues } from "./problem.ts";
import { noNul } from "./text.ts";

/** The field problems of a body, as code, pointer and detail. */
function problemsOf(schema: z.ZodType, body: unknown): string[][] {
  const result = schema.safeParse(body, { reportInput: true });
  return result.success ? [] : fieldIssues(result.error.issues).map((issue) => [issue.code, issue.pointer, issue.detail]);
}

describe("a stored text", () => {
  it("refuses U+0000 anywhere in it, as invalid-value, and takes every other text", () => {
    const text = z.strictObject({ note: z.string().check(noNul()) });
    for (const note of ["\u0000", "a\u0000", "\u0000b", "ab\u0000cd"]) {
      expect(problemsOf(text, { note })).toEqual([["invalid-value", "/note", "The field /note holds the character U+0000, which no text may hold."]]);
    }
    expect(problemsOf(text, { note: "Alva Berg \u0001 \uFFFD" })).toEqual([]);
  });

  it("is the check of the sign-in's identifier and of the first person's name and e-mail address", () => {
    expect(problemsOf(bodySchema(loginWithPassword) ?? z.never(), { identifier: "a\u0000@example.com", password: "lösenord" })).toEqual([
      ["invalid-value", "/identifier", "The field /identifier holds the character U+0000, which no text may hold."],
    ]);
    expect(
      problemsOf(bodySchema(completeSetup) ?? z.never(), { name: "Alva\u0000", email: "alva\u0000@example.com", password: "första-lösenordet-20" }).map(
        ([code, pointer]) => [code, pointer],
      ),
    ).toEqual([
      ["invalid-value", "/name"],
      ["invalid-value", "/email"],
    ]);
  });
});
