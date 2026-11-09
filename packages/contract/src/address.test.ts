// SPDX-License-Identifier: AGPL-3.0-only

// An e-mail address that the API takes is one mailbox, so a mail goes to the
// address that the server stores and shows, and nowhere else: a dot-atom with
// RFC 6531's UTF-8, its one @ and a domain of labels. A display name, a
// comment, a group, a list, a quoted local part, an address literal, a space,
// a control character and a control of the text's direction are refused,
// with bad-format, in every field that takes an address. A person's and a
// company's name stand on one line: a line break, another control character
// and a control of the text's direction are refused, with invalid-value, in
// every field that takes one.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAILBOX } from "./address.ts";
import { bodySchema } from "./operation.ts";
import { completeSetup } from "./operations/auth.ts";
import { createCompany, updateCompany, updateMyMembership } from "./operations/companies.ts";
import { acceptInvitation } from "./operations/invitations.ts";
import { inviteUser, updateUser } from "./operations/users.ts";
import { fieldIssues } from "./problem.ts";
import { NOT_IN_A_NAME } from "./text.ts";
import type { Operation } from "./operation.ts";

/** The codes and pointers of the field problems of a body. */
function problemsOf(operation: Operation, body: unknown): string[][] {
  const result = (bodySchema(operation) ?? z.never()).safeParse(body, { reportInput: true });
  return result.success ? [] : fieldIssues(result.error.issues).map((issue) => [issue.code, issue.pointer]);
}

/** Addresses that are one mailbox. */
const MAILBOXES = [
  "karin.lund@example.com",
  "Karin.Lund@Example.COM",
  "o'brien+fakturor@example.org",
  "a!#$%&'*+/=?^_`{|}~-z@example.com",
  "åsa@exämple.test",
  "pär.öberg@example.org",
  "δοκιμή@παράδειγμα.example",
  "x@sub-domain.example.com",
  "x@localhost",
  `${"a".repeat(64)}@example.com`,
];

/** Strings that are not one mailbox, each of a kind that a mail program reads otherwise or that breaks the form. */
const NOT_MAILBOXES = [
  "victim<x@evil.example>",
  "<x@example.org>",
  "x@evil.example>",
  "a,b@evil.example",
  "anna@example.com,",
  "anna@example,com",
  "a;b@example.org",
  "g:x@example.org",
  "(c)x@example.org",
  "x(c)@example.org",
  "[x]@example.org",
  "x@[192.0.2.1]",
  "a\\b@example.org",
  '"a b"@example.org',
  "a b@example.org",
  "x@example.org\u0085",
  "x\u0085@example.org",
  "x\u0001@example.org",
  "x@exam\u202Eple.org",
  "x\u2028@example.org",
  "x\u00A0@example.org",
  ".x@example.org",
  "x.@example.org",
  "x..y@example.org",
  "x@.example.org",
  "x@example..org",
  "x@example.org.",
  "x@-example.test",
  "x@example-.test",
  "x@exa_mple.org",
  "x@@example.org",
  "x@y@example.org",
  "@example.org",
  "x@",
  `${"a".repeat(65)}@example.com`,
];

/** Names that stand on one line. */
const NAMES = ["Karin Lund", "Testbolaget Alfa AB", "Åsa Öberg-Ängström", "O'Brien & Söner HB", "Δοκιμή", "عربي", "क्षत्रिय", "👩\u200D💻 Alva"];

/** Names with a character that a name never holds. */
const NOT_NAMES = [
  "Karin\nLund",
  "Karin\r\nLund",
  "Karin\rLund",
  "Karin\tLund",
  "Karin\u000BLund",
  "Karin\u000CLund",
  "Karin\u001FLund",
  "Karin\u007FLund",
  "Karin\u0085Lund",
  "Karin\u009FLund",
  "Karin\u2028Lund",
  "Karin\u2029Lund",
  "Karin\u202ELund",
  "Karin\u2066Lund",
  "Karin\u200FLund",
  "Karin\u061CLund",
];

describe("an e-mail address", () => {
  it.each(MAILBOXES)("takes the mailbox %j", (address) => {
    expect(MAILBOX.test(address)).toBe(true);
  });

  it.each(NOT_MAILBOXES)("refuses %j, which is not one mailbox", (address) => {
    expect(MAILBOX.test(address)).toBe(false);
  });

  it("is the form of every address the API takes, refused with bad-format at its pointer", () => {
    for (const address of NOT_MAILBOXES) {
      expect(problemsOf(inviteUser, { name: "Karin Lund", email: address })).toContainEqual(["bad-format", "/email"]);
      expect(problemsOf(updateUser, { workEmail: address })).toContainEqual(["bad-format", "/workEmail"]);
      expect(problemsOf(updateMyMembership, { workEmail: address })).toContainEqual(["bad-format", "/workEmail"]);
      expect(problemsOf(updateCompany, { email: address })).toContainEqual(["bad-format", "/email"]);
      expect(problemsOf(completeSetup, { name: "Alva Berg", email: address, password: "första-lösenordet-20" })).toContainEqual(["bad-format", "/email"]);
    }
    for (const address of MAILBOXES) {
      expect(problemsOf(inviteUser, { name: "Karin Lund", email: address })).toEqual([]);
      expect(problemsOf(updateUser, { workEmail: address })).toEqual([]);
      expect(problemsOf(updateMyMembership, { workEmail: address })).toEqual([]);
      expect(problemsOf(updateCompany, { email: address })).toEqual([]);
      expect(problemsOf(completeSetup, { name: "Alva Berg", email: address, password: "första-lösenordet-20" })).toEqual([]);
    }
  });
});

describe("a name", () => {
  it.each(NOT_NAMES)("never holds the character in %j", (name) => {
    expect(NOT_IN_A_NAME.test(name)).toBe(true);
  });

  it.each(NAMES)("takes %j", (name) => {
    expect(NOT_IN_A_NAME.test(name)).toBe(false);
  });

  it("is refused with invalid-value at its pointer in every field that takes a person's or a company's name", () => {
    for (const name of NOT_NAMES) {
      expect(problemsOf(inviteUser, { name, email: "karin.lund@example.com" })).toEqual([["invalid-value", "/name"]]);
      expect(problemsOf(acceptInvitation, { newIdentity: { name, password: "karins-lösenord" } })).toEqual([["invalid-value", "/newIdentity/name"]]);
      expect(problemsOf(completeSetup, { name, email: "alva.berg@example.com", password: "första-lösenordet-20" })).toEqual([["invalid-value", "/name"]]);
      expect(problemsOf(createCompany, { name, organizationNumber: "556677-1234" })).toEqual([["invalid-value", "/name"]]);
      expect(problemsOf(updateCompany, { name })).toEqual([["invalid-value", "/name"]]);
    }
    for (const name of NAMES) {
      expect(problemsOf(inviteUser, { name, email: "karin.lund@example.com" })).toEqual([]);
      expect(problemsOf(acceptInvitation, { newIdentity: { name, password: "karins-lösenord" } })).toEqual([]);
      expect(problemsOf(updateCompany, { name })).toEqual([]);
    }
  });
});
