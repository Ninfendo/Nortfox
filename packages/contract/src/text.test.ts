// SPDX-License-Identifier: AGPL-3.0-only

// A text that the server stores or looks up refuses U+0000, which
// PostgreSQL's text cannot hold, and a lone surrogate, which is not a
// character, as a field problem at its pointer.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bodySchema, querySchema } from "./operation.ts";
import { completeSetup, loginWithPassword } from "./operations/auth.ts";
import { createCompany, listCompanies, updateMyMembership } from "./operations/companies.ts";
import { fieldIssues } from "./problem.ts";
import { noNul, wellFormed } from "./text.ts";

/** The field problems of a body, as code, pointer and detail. */
function problemsOf(schema: z.ZodType, body: unknown): string[][] {
  const result = schema.safeParse(body, { reportInput: true });
  return result.success ? [] : fieldIssues(result.error.issues).map((issue) => [issue.code, issue.pointer, issue.detail]);
}

/** The lone surrogates at the ends of both halves: a high one with no low one after it, and a low one with no high one before it. */
const LONE = ["\uD800", "\uDBFF", "\uDC00", "\uDFFF"];

/** What a field with a lone surrogate gets. */
function loneSurrogate(pointer: string): string[] {
  return ["invalid-value", pointer, `The field ${pointer} holds a lone surrogate, which is not a character.`];
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

  it("is the check of every stored text of the companies and the memberships", () => {
    /** What a field with U+0000 gets. */
    const nul = (pointer: string): string[] => ["invalid-value", pointer, `The field ${pointer} holds the character U+0000, which no text may hold.`];
    expect(problemsOf(bodySchema(createCompany) ?? z.never(), { name: "Testbolaget \u0000 AB", organizationNumber: "556677-1234" })).toEqual([nul("/name")]);
    expect(problemsOf(querySchema(listCompanies) ?? z.never(), { query: "Alfa\u0000" })).toEqual([nul("/query")]);
    expect(problemsOf(bodySchema(updateMyMembership) ?? z.never(), { workPhone: "070-174 06 07\u0000" })).toEqual([nul("/workPhone")]);
    expect(problemsOf(bodySchema(updateMyMembership) ?? z.never(), { workEmail: "a\u0000@example.com" })).toEqual([nul("/workEmail")]);
  });

  it("refuses a lone surrogate anywhere in it, as invalid-value, and takes a pair and every other text", () => {
    const text = z.strictObject({ note: z.string().check(wellFormed()) });
    for (const lone of LONE) {
      for (const note of [lone, `a${lone}`, `${lone}b`, `Testbolaget ${lone} AB`]) {
        expect(problemsOf(text, { note })).toEqual([loneSurrogate("/note")]);
      }
    }
    // A low surrogate before a high one is two lone ones.
    expect(problemsOf(text, { note: "\uDC00\uD800" })).toEqual([loneSurrogate("/note")]);
    expect(problemsOf(text, { note: "Alva Berg \uD83D\uDE00 \uFFFD \u0001" })).toEqual([]);
  });

  it("is the check of every stored text of the companies and the memberships, and of the sign-in and the first identity", () => {
    const lone = "\uD800";
    expect(problemsOf(bodySchema(createCompany) ?? z.never(), { name: `Testbolaget ${lone} AB`, organizationNumber: "556677-1234" })).toEqual([loneSurrogate("/name")]);
    expect(problemsOf(querySchema(listCompanies) ?? z.never(), { query: `Alfa${lone}` })).toEqual([loneSurrogate("/query")]);
    expect(problemsOf(bodySchema(updateMyMembership) ?? z.never(), { workPhone: `070 ${lone}` })).toEqual([loneSurrogate("/workPhone")]);
    expect(problemsOf(bodySchema(updateMyMembership) ?? z.never(), { workEmail: `a${lone}@example.com` })).toEqual([loneSurrogate("/workEmail")]);
    expect(problemsOf(bodySchema(loginWithPassword) ?? z.never(), { identifier: `a${lone}@example.com`, password: "lösenord" })).toEqual([loneSurrogate("/identifier")]);
    expect(
      problemsOf(bodySchema(completeSetup) ?? z.never(), { name: `Alva${lone}`, email: `alva${lone}@example.com`, password: "första-lösenordet-20" }).map(
        ([code, pointer]) => [code, pointer],
      ),
    ).toEqual([
      ["invalid-value", "/name"],
      ["invalid-value", "/email"],
    ]);
  });
});
