// SPDX-License-Identifier: AGPL-3.0-only

// The identifier of a password sign-in: a personnummer in 10 or 12 digits,
// which the server writes in its twelve digits with the hyphen, as the
// database keeps it; or else an e-mail address, in NFC, which the database
// finds in any letter case. An identifier that names no identity is counted
// under the HMAC of its normalised form, with the key's id.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TEST_INSTALL_KEY } from "../../../test/api.ts";
import { readIdentifier, unknownSubject } from "./identifier.ts";

const TODAY = new Date("2026-11-04T09:00:00.000Z");

describe("readIdentifier", () => {
  it("writes a personnummer of 12 digits with its hyphen, with or without one given", () => {
    for (const text of ["19900101-2385", "199001012385", " 19900101-2385 "]) {
      expect(readIdentifier(text, TODAY)).toEqual({ kind: "personnummer", value: "19900101-2385" });
    }
  });

  it("gives a personnummer of 10 digits its century: with - the person is under 100 this year, with + 100 or older", () => {
    expect(readIdentifier("900101-2385", TODAY)).toEqual({ kind: "personnummer", value: "19900101-2385" });
    expect(readIdentifier("9001012385", TODAY)).toEqual({ kind: "personnummer", value: "19900101-2385" });
    expect(readIdentifier("000101-2384", TODAY)).toEqual({ kind: "personnummer", value: "20000101-2384" });
    expect(readIdentifier("261231-0000", TODAY)).toEqual({ kind: "personnummer", value: "20261231-0000" });
    expect(readIdentifier("270101-0000", TODAY)).toEqual({ kind: "personnummer", value: "19270101-0000" });
    expect(readIdentifier("270101+0000", TODAY)).toEqual({ kind: "personnummer", value: "18270101-0000" });
    expect(readIdentifier("100101-2382", new Date("2090-03-15T00:00:00.000Z"))).toEqual({ kind: "personnummer", value: "20100101-2382" });
  });

  it("takes anything else as an e-mail address in NFC, without the spaces around it", () => {
    expect(readIdentifier("  Åsa@Example.com ", TODAY)).toEqual({ kind: "email", value: "Åsa@Example.com" });
    for (const text of ["1990-01-01-2385", "19900101_2385", "900101--2385", "19900101-238", "anna@example.com"]) {
      expect(readIdentifier(text, TODAY).kind).toBe("email");
    }
  });
});

describe("unknownSubject", () => {
  it("is the HMAC, with the key's id, of the form that the database matches on", () => {
    // The database gives the form (access.identifier_form): the server takes it as it is.
    const subject = unknownSubject(TEST_INSTALL_KEY, "okand@example.com");
    expect(subject).toBe(`hmac:9:${TEST_INSTALL_KEY.mac("identifier v1", "okand@example.com")}`);
    expect(subject).toMatch(/^hmac:[0-9]{1,3}:[0-9a-f]{64}$/);
    expect(unknownSubject(TEST_INSTALL_KEY, "19900101-2385")).toBe(`hmac:9:${TEST_INSTALL_KEY.mac("identifier v1", "19900101-2385")}`);
    expect(unknownSubject(TEST_INSTALL_KEY, "Okand@example.com")).not.toBe(subject);
  });
});

/** A personnummer of the fixture guard's list, in its twelve digits with the hyphen. */
const NUMBERS = ["19900101-2385", "20000101-2384", "20100101-2382"];

/** The combining ring above and the combining acute accent. */
const RING = String.fromCodePoint(0x30a);
const ACUTE = String.fromCodePoint(0x301);

describe("readIdentifier's forms", () => {
  it("reads every spelling of a personnummer to one form: 12 or 10 digits, with or without the hyphen, with spaces around", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NUMBERS), fc.boolean(), fc.boolean(), fc.string({ unit: fc.constantFrom(" ", "\t"), maxLength: 3 }), (number, short, hyphen, space) => {
        const digits = number.replace("-", "");
        const date = short ? digits.slice(2, 8) : digits.slice(0, 8);
        const text = `${space}${date}${hyphen ? "-" : ""}${digits.slice(8)}${space}`;
        expect(readIdentifier(text, TODAY)).toEqual({ kind: "personnummer", value: number });
      }),
    );
  });

  it("reads an e-mail address to its NFC form, whatever form it came in", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("a", "Å", `A${RING}`, `e${ACUTE}`, "é", ".", "-"), minLength: 1, maxLength: 12 }), (local) => {
        const address = `${local}@example.com`;
        const read = readIdentifier(address, TODAY);
        expect(read).toEqual({ kind: "email", value: address.normalize("NFC") });
        expect(readIdentifier(address.normalize("NFD"), TODAY)).toEqual(read);
      }),
    );
  });
});
