// SPDX-License-Identifier: AGPL-3.0-only

// The report takes out every e-mail address that the API takes, whole: an
// address of any character that the contract's check takes, in its local
// part or its domain, as a mail server quotes it when it refuses one. So a
// refused invitation never puts the invited person's address in the log.

import { emailAddress } from "@nortfox/contract";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scrub } from "./report.ts";

/** Characters of a local part: RFC 5322's atext, the dot, and characters outside ASCII of every kind, symbols and punctuation too. */
const LOCAL = [
  ...Array.from("abcXYZ019.!#$%&'*+/=?^_`{|}~-"),
  ..."\u{00E5}\u{00E4}\u{00F6}\u{00DF}\u{03B4}\u{4E2D}\u{0627}\u{0915}\u{094D}\u{0958}\u{0301}".split(""),
  ..."\u{00A9}\u{00AB}\u{00B7}\u{00BB}\u{00BF}\u{00B5}\u{20AC}\u{2019}\u{2018}\u{201C}\u{2026}\u{2122}\u{2603}\u{2665}\u{037E}\u{3002}".split(""),
  "\u{1F600}",
  "\u{1F4A9}",
  "\u{1D400}",
  // Characters that no address holds, so the contract refuses each address with one.
  " ",
  "\u{00A0}",
  "\u{200E}",
  "\u{202E}",
  "\u{2028}",
  "@",
];

/** Characters of a domain's label: letters, digits and the hyphen, in ASCII and beyond, symbols too. */
const DOMAIN = [...Array.from("abcxyz019-"), ..."\u{00E4}\u{00F6}\u{03B4}\u{4E2D}\u{0958}\u{2603}\u{20AC}".split(""), "\u{1F4A9}"];

const localPart = fc.array(fc.constantFrom(...LOCAL), { minLength: 1, maxLength: 12 }).map((parts) => parts.join(""));
const label = fc.array(fc.constantFrom(...DOMAIN), { minLength: 1, maxLength: 8 }).map((parts) => parts.join(""));
const domain = fc.tuple(fc.array(label, { minLength: 0, maxLength: 2 }), fc.constantFrom("example", "example.com", "example.org", "test")).map(([labels, end]) => [...labels, end].join("."));

describe("the report's scrub of an address", () => {
  it("takes out every address that the contract takes, whole, as a mail server quotes it", () => {
    let taken = 0;
    fc.assert(
      fc.property(localPart, domain, (local, name) => {
        const address = `${local}@${name}`;
        if (!emailAddress().safeParse(address).success) {
          return;
        }
        taken += 1;
        const reply = (quoted: string): string => `Can't send mail - all recipients were rejected: 550 5.1.1 <${quoted}>: Recipient address rejected`;
        expect(scrub(reply(address))).toBe(reply("[e-mail]"));
        expect(scrub(`to ${address}, now`)).toBe("to [e-mail], now");
      }),
      { numRuns: 3000 },
    );
    expect(taken).toBeGreaterThan(500);
  });

  it.each([
    ["an emoji local part", "\u{1F600}@example.com"],
    ["a snowman in the local part", "anna\u{2603}berg@example.com"],
    ["a middle dot in the local part", "col\u{00B7}lecta@example.com"],
    ["a euro sign in the local part", "anna\u{20AC}berg@example.com"],
    ["a typographic apostrophe in the local part", "anna\u{2019}s@example.com"],
    ["a symbol at the local part's end", "anna\u{1F600}@example.com"],
    ["a guillemet in the local part", "anna\u{00AB}@example.com"],
    ["an inverted question mark in the local part", "anna\u{00BF}lind@example.org"],
    ["a snowman for a domain", "anna.lind@\u{2603}.example"],
    ["a symbol in the domain", "anna.lind@ex\u{2603}ample.org"],
    ["a local part with a token's form", "nfs_abc@example.com"],
    ["a local part of digits like a personnummer", "199001012385@example.com"],
  ])("takes out an address with %s", (_case, address) => {
    expect(emailAddress().safeParse(address).success).toBe(true);
    expect(scrub(`550 5.1.1 <${address}>: Recipient address rejected`)).toBe("550 5.1.1 <[e-mail]>: Recipient address rejected");
  });
});
