// SPDX-License-Identifier: AGPL-3.0-only

// A domain that the API takes is written as a mail is sent to it: the
// mapping of IDNA's UTS 46, which node:url's domainToASCII does as nodemailer
// does, gives back the same labels, in lower case. So the address that the
// server stores, looks up and shows is the one the mail goes to. A domain
// that the mapping changes is refused, and so is an A-label and a domain
// that ends in a number, which the URL Standard reads as an IPv4 address.

import fc from "fast-check";
import { domainToASCII, domainToUnicode } from "node:url";
import { describe, expect, it } from "vitest";
import { writtenAsMailed } from "./address.ts";

/** Characters a label may be made of: ASCII, letters beyond it, and the ones IDNA drops, folds or reads as a dot. */
const CHARACTERS = [
  ...Array.from("abcxyzABCXYZ019-"),
  ...Array.from("äÄöåß\u1E9E\u00B5δΣςİıǅΩ中文يل١"),
  "a\u0308",
  "\u0300",
  "\u00AD",
  "\u034F",
  "\u200B",
  "\u200C",
  "\u200D",
  "\u2060",
  "\uFE0F",
  "\u3164",
  "\u3002",
  "\uFF0E",
  "\uFF61",
  "\uFF45",
  "\uFF25",
  "\uFF9F",
  "\uFB01",
  "\u2460",
  "\u210C",
  "\u2126",
];

/** A label of those characters, an A-label's prefix now and then. */
const label = fc.tuple(fc.constantFrom("", "", "", "xn--"), fc.array(fc.constantFrom(...CHARACTERS), { minLength: 1, maxLength: 8 })).map(([prefix, parts]) => prefix + parts.join(""));

/** A domain of one to four labels. */
const domain = fc.array(label, { minLength: 1, maxLength: 4 }).map((labels) => labels.join("."));

/** Whether the domain's mapping gives back its own labels, in lower case: node:url's reading. */
function mappedAsWritten(name: string): boolean {
  const ascii = domainToASCII(name);
  return ascii !== "" && domainToUnicode(ascii) === name.toLowerCase().normalize("NFC");
}

describe("a domain as it is mailed", () => {
  it("is taken when the mapping gives back its labels, and it is no A-label and ends in no number", () => {
    fc.assert(
      fc.property(domain, (name) => {
        const labels = name.split(".");
        const aLabel = labels.some((part) => part.toLowerCase().startsWith("xn--"));
        const endsInNumber = /^[0-9]+$/.test(labels.at(-1) ?? "");
        expect(writtenAsMailed(name)).toBe(mappedAsWritten(name) && !aLabel && !endsInNumber);
      }),
      { numRuns: 2000 },
    );
  });
});
