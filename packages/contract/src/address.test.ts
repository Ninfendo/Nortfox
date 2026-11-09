// SPDX-License-Identifier: AGPL-3.0-only

// An e-mail address that the API takes is one mailbox, so a mail goes to the
// address that the server stores and shows, and nowhere else: a dot-atom with
// RFC 6531's UTF-8, its one @ and a domain of labels. A display name, a
// comment, a group, a list, a quoted local part, an address literal, a space,
// a control character and a control of the text's direction are refused,
// with bad-format, in every field that takes an address. So is a domain that
// a mail reaches under another name than the one written: one that IDNA's
// mapping changes, an A-label, and one that ends in a number. A person's and a
// company's name stand on one line: a line break, another control character
// and a control of the text's direction are refused, with invalid-value, in
// every field that takes one.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAILBOX, emailAddress, writtenAsMailed } from "./address.ts";
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
  // A local part that ends in a slash: no mailbox has one, and a log reads it as a package's path (/@scope).
  "a/@example.org",
  "a.b/@example.org",
];

/**
 * Addresses whose domain a mail is not sent to as it is written: IDNA's
 * mapping (UTS 46, as nodemailer, the browsers and the resolvers read a
 * domain) drops a character of it, folds one into another, or reads a dot in
 * it, or the domain is written as its A-label, or ends in a number, which
 * the URL Standard reads as an IPv4 address. Each would be stored and shown
 * as one address and mailed to another, so it is refused.
 */
const NOT_AS_MAILED = [
  "anna.lind@example\u3002com",
  "anna.lind@example\uFF0Ecom",
  "anna.lind@example\uFF61com",
  "anna.lind@example.com\u200B",
  "anna.lind@ex\u00ADample.com",
  "anna.lind@ex\u2060ample.com",
  "anna.lind@example\uFE0F.com",
  "anna.lind@ex\u034Fample.com",
  "anna.lind@ex\u200Dample.com",
  "anna.lind@\uFF45xample.test",
  "anna.lind@\uFF25\uFF38\uFF21\uFF2D\uFF30\uFF2C\uFF25.test",
  "anna.lind@\uFB01le.example",
  "anna.lind@\u2460.example",
  "anna.lind@\u00B5.example",
  "anna.lind@\u210Cej.example",
  "anna.lind@xn--bcher-kva.example",
  "anna.lind@XN--BCHER-KVA.example",
  "anna.lind@xn--zz.example",
  "anna.lind@example.123",
  "anna.lind@192.0.2.1",
  "anna.lind@10.3.1",
  "anna.lind@example.0x1f",
];

/** Names that stand on one line. */
const NAMES = ["Karin Lund", "Testbolaget Alfa AB", "Åsa Öberg-Ängström", "O'Brien & Söner HB", "Δοκιμή", "عربي", "क\u094Dषत\u094Dरिय", "👩\u200D💻 Alva"];

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

  it.each(NOT_AS_MAILED)("refuses %j, which a mail would reach under another domain", (address) => {
    expect(emailAddress().safeParse(address).success).toBe(false);
  });

  it.each(MAILBOXES)("takes %j, whose domain a mail reaches as it is written", (address) => {
    expect(emailAddress().safeParse(address).success).toBe(true);
  });

  it("names its domain as it is written: the labels in Unicode, or in ASCII, in any letter case", () => {
    expect(writtenAsMailed("exämple.test")).toBe(true);
    expect(writtenAsMailed("ExÄmple.TEST")).toBe(true);
    expect(writtenAsMailed("exa\u0308mple.test")).toBe(true);
    expect(writtenAsMailed("localhost")).toBe(true);
    expect(writtenAsMailed("ex\u00ADample.com")).toBe(false);
    expect(writtenAsMailed("xn--exmple-cua.test")).toBe(false);
    expect(writtenAsMailed("1.example.42")).toBe(false);
  });

  it("refuses an address that is not mailed as it is written with bad-format, in every field that takes one", () => {
    for (const address of NOT_AS_MAILED) {
      expect(problemsOf(inviteUser, { name: "Karin Lund", email: address })).toEqual([["bad-format", "/email"]]);
      expect(problemsOf(updateUser, { workEmail: address })).toEqual([["bad-format", "/workEmail"]]);
      expect(problemsOf(updateMyMembership, { workEmail: address })).toEqual([["bad-format", "/workEmail"]]);
      expect(problemsOf(updateCompany, { email: address })).toEqual([["bad-format", "/email"]]);
      expect(problemsOf(completeSetup, { name: "Alva Berg", email: address, password: "första-lösenordet-20" })).toEqual([["bad-format", "/email"]]);
    }
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
