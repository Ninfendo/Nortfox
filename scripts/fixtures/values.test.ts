// SPDX-License-Identifier: AGPL-3.0-only

// The tests plant numbers from Skatteverket's published test series, which
// are on the list of test values, so this file passes the guard. Here they
// are read without the list, to show that the guard finds them. Every other
// number that should be found is built while the test runs, and every
// address that should be found is joined from its parts, so neither appears
// in this file as written.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { address, checkDigit } from "../testing/personal-data.ts";
import { hasValueShape, identityKind, isOrganisationNumber, luhnValid, valuesIn, valuesInPath, type Kind } from "./values.ts";

/** The kinds found in a line. */
const kinds = (line: string): Kind[] => valuesIn(line).map((value) => value.kind);

/** The kinds found in a file's path. */
const pathKinds = (path: string): Kind[] => valuesInPath(path).map((value) => value.kind);

/** True when the date is on the calendar, by the Date object's own reckoning. */
function onCalendar(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const digits = (length: number): fc.Arbitrary<string> =>
  fc.array(fc.integer({ min: 0, max: 9 }), { minLength: length, maxLength: length }).map((list) => list.join(""));

describe("identity numbers", () => {
  it.each([
    ["12 digits with a dash", "19900101-2385", "personal-identity-number"],
    ["12 digits without one", "199001012385", "personal-identity-number"],
    ["12 digits with a plus", "19900101+2385", "personal-identity-number"],
    ["10 digits with a dash", "900101-2385", "personal-identity-number"],
    ["10 digits with a plus", "900101+2385", "personal-identity-number"],
    ["10 digits without one", "9001012385", "personal-identity-number"],
    ["a coordination number in 12 digits with a dash", "20260161-2381", "coordination-number"],
    ["a coordination number in 12 digits without one", "202601612381", "coordination-number"],
    ["a coordination number in 10 digits with a dash", "260161-2381", "coordination-number"],
    ["a coordination number in 10 digits without one", "2601612381", "coordination-number"],
  ])("finds %s", (_form, value, kind) => {
    expect(valuesIn(value)).toEqual([{ kind, key: value.replace(/[-+]/, "") }]);
  });

  it.each([
    ["in a sentence", "The customer 19900101-2385 paid."],
    ["at the end of a sentence", "Born as 900101-2385."],
    ["in JSON", '{"personnummer":"199001012385"}'],
    ["in a CSV row", "1,9001012385,Anna"],
    ["after a word and an underscore", "pnr_199001012385"],
    ["after a dash", "id-199001012385"],
    ["in a URL path", "/v1/people/199001012385/vouchers"],
    ["in parentheses", "(20000101-2384)"],
  ])("finds one %s", (_where, line) => {
    expect(kinds(line)).toEqual(["personal-identity-number"]);
  });

  it.each(["19900101-2385", "199001012385", "19900101+2385", "900101-2385", "900101+2385", "9001012385"])(
    "finds %s with a dash and a word or a number after it, as in a file name",
    (number) => {
      for (const after of ["-anna", "-kvitto.json", "-2024", "-1"]) {
        expect(kinds(`${number}${after}`)).toEqual(["personal-identity-number"]);
        expect(kinds(`kund-${number}${after}`)).toEqual(["personal-identity-number"]);
      }
    },
  );

  it("finds every number in a line, in order", () => {
    expect(kinds("19900101-2385, 20000101-2384 and 260161-2381")).toEqual([
      "personal-identity-number",
      "personal-identity-number",
      "coordination-number",
    ]);
  });

  it.each([
    ["a wrong check digit", "19900101-2386"],
    ["a wrong check digit in 10 digits", "900101-2380"],
    ["month 0", "19900001-2385"],
    ["month 13", "19901301-2385"],
    ["day 0", "19900100-2385"],
    ["day 32", "19900132-2385"],
    ["30 February", "19900230-2385"],
    ["31 April", "19900431-2385"],
    ["a coordination day past 91", "19900192-2385"],
    ["a day between 31 and 61", "19900145-2385"],
    ["the century 17", "17900101-2385"],
    ["the century 21", "21900101-2385"],
    ["11 digits", "19001012385"],
    ["13 digits", "1199001012385"],
    ["a letter before it", "a199001012385"],
    ["a letter after it", "199001012385a"],
    ["the start of a UUID", "19900101-2385-4abc-8def-0123456789ab"],
    ["the start of a UUID in capitals", "19900101-2385-4ABC-8DEF-0123456789AB"],
    ["the decimals of a number", "0.9001012385"],
    ["the whole part of a decimal number", "9001012385.25"],
    ["a space for the dash", "900101 2385"],
  ])("lets through %s", (_case, line) => {
    expect(valuesIn(line)).toEqual([]);
  });

  it("knows the leap years: 29 February only in a leap year, and in any year that 10 digits may mean", () => {
    // 1900 is not a leap year and 2000 is, so 29 February 00 is real in 10 digits.
    const of = (date: string, digitsAfter = "123"): Kind | undefined => {
      const nine = date.slice(-6) + digitsAfter;
      return identityKind(date, digitsAfter + checkDigit(nine));
    };
    expect(of("19000229")).toBeUndefined();
    expect(of("20000229")).toBe("personal-identity-number");
    expect(of("000229")).toBe("personal-identity-number");
    expect(of("19840229")).toBe("personal-identity-number");
    expect(of("19850229")).toBeUndefined();
    expect(of("850229")).toBeUndefined();
    expect(of("20000289")).toBe("coordination-number");
    expect(of("19000289")).toBeUndefined();
    expect(of("18991231")).toBe("personal-identity-number");
  });

  it("finds a 10-digit number exactly when its date is on the calendar in some century and its check digit is right", () => {
    fc.assert(
      fc.property(digits(6), digits(3), (date, birth) => {
        const year = Number(date.slice(0, 2));
        const month = Number(date.slice(2, 4));
        const coded = Number(date.slice(4, 6));
        const day = coded > 60 ? coded - 60 : coded;
        const real = month >= 1 && day >= 1 && (onCalendar(1900 + year, month, day) || onCalendar(2000 + year, month, day));
        const right = checkDigit(date + birth);
        const kind = coded > 60 ? "coordination-number" : "personal-identity-number";
        // Digits that make no date may make an organisation number instead: with a dash, or
        // without one when the group digit is not 1.
        const organisationShaped = "12356789".includes(date.charAt(0)) && Number(date.charAt(2)) >= 2;
        const withoutDash = organisationShaped && !date.startsWith("1");
        for (let last = 0; last <= 9; last += 1) {
          const number = `${birth}${String(last)}`;
          const rightDigit = String(last) === right;
          const identity = real && rightDigit ? [kind] : [];
          expect(kinds(`${date}${number}`)).toEqual(withoutDash && rightDigit ? ["organisation-number"] : identity);
          expect(kinds(`${date}+${number}`)).toEqual(identity);
          expect(kinds(`${date}-${number}`)).toEqual(organisationShaped && rightDigit ? ["organisation-number"] : identity);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("finds a 12-digit number exactly when its century is 18, 19 or 20, its date is on the calendar and its check digit is right", () => {
    fc.assert(
      fc.property(fc.integer({ min: 15, max: 22 }), digits(6), digits(3), (century, date, birth) => {
        const year = century * 100 + Number(date.slice(0, 2));
        const month = Number(date.slice(2, 4));
        const coded = Number(date.slice(4, 6));
        const day = coded > 60 ? coded - 60 : coded;
        const real = [18, 19, 20].includes(century) && month >= 1 && day >= 1 && onCalendar(year, month, day);
        const right = checkDigit(date + birth);
        const kind = coded > 60 ? "coordination-number" : "personal-identity-number";
        for (let last = 0; last <= 9; last += 1) {
          // 16 in front is the 12-digit form of an organisation number, which a later test covers.
          const expected = real && String(last) === right ? [kind] : [];
          if (century !== 16) {
            expect(kinds(`${String(century)}${date}-${birth}${String(last)}`)).toEqual(expected);
            expect(kinds(`${String(century)}${date}${birth}${String(last)}`)).toEqual(expected);
          }
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe("organisation numbers", () => {
  /** An organisation number with this start and a right check digit. */
  const organisation = (nine: string): string => `${nine.slice(0, 6)}-${nine.slice(6)}${checkDigit(nine)}`;

  it.each([
    ["NNNNNN-NNNN", "556000-0167"],
    ["16NNNNNN-NNNN", "16556000-0167"],
    ["16NNNNNNNNNN", "165560000167"],
    ["NNNNNN-NNNN in a sentence", "AB 599999-0129, Stockholm"],
    ["NNNNNNNNNN, ten digits without the dash", "5560000167"],
    ["NNNNNNNNNN in JSON", '{"organisationsnummer":"5560000167"}'],
    ["NNNNNNNNNN in a Peppol e-invoice", '<cbc:EndpointID schemeID="0007">5999990129</cbc:EndpointID>'],
  ])("finds the form %s", (_form, line) => {
    expect(valuesIn(line)).toEqual([{ kind: "organisation-number", key: line.replace(/\D/g, "").slice(-10) }]);
  });

  it.each(["1", "2", "3", "5", "6", "7", "8", "9"])("finds one with the group digit %s", (group) => {
    const number = organisation(`${group}62000012`);
    expect(kinds(number)).toEqual(["organisation-number"]);
    expect(isOrganisationNumber(number.replace("-", ""))).toBe(true);
    // Without the dash, the group digit 1 is a Unix time from 2001 to 2033 as well.
    expect(kinds(number.replace("-", ""))).toEqual(group === "1" ? [] : ["organisation-number"]);
  });

  it.each([
    ["the group digit 0", organisation("062000012")],
    ["the group digit 4", organisation("462000012")],
    ["a third digit below 2, where the date is not on the calendar either", organisation("551300012")],
    ["a wrong check digit", "556000-0168"],
    ["ten digits without the dash and with the group digit 1, which a Unix time also is", organisation("162000012").replace("-", "")],
    ["a plus for the dash", "556000+0167"],
    ["16 in front and a plus", "16556000+0167"],
    ["a letter after it", "556000-0167x"],
  ])("lets through %s", (_case, line) => {
    expect(valuesIn(line)).toEqual([]);
  });

  it("finds an organisation number exactly when its group digit is given out, its third digit is 2 or more and its check digit is right", () => {
    fc.assert(
      fc.property(digits(9), (nine) => {
        const right = checkDigit(nine);
        const shaped = "12356789".includes(nine.charAt(0)) && Number(nine.charAt(2)) >= 2;
        for (let last = 0; last <= 9; last += 1) {
          const ten = `${nine}${String(last)}`;
          expect(isOrganisationNumber(ten)).toBe(shaped && String(last) === right);
          expect(luhnValid(ten)).toBe(String(last) === right);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe("e-mail addresses", () => {
  it.each([
    ["alone", address("ann.berg", "zarquon.se")],
    ["in capitals", address("Ann.Berg", "ZARQUON.SE")],
    ["with a plus and digits", address("ann+invoices2", "mail.zarquon.se")],
    ["at a domain with letters outside ASCII", address("ann", "zarquön.se")],
    ["after mailto:", `mailto:${address("ann", "zarquon.se")}`],
    ["in angle brackets", `Ann Berg <${address("ann", "zarquon.se")}>`],
    ["in JSON", `{"email":"${address("ann", "zarquon.se")}"}`],
    ["at the end of a sentence", `Write to ${address("ann", "zarquon.se")}.`],
    ["before a colon and a space", `${address("ann", "zarquon.se")}: the invoice`],
    ["in a URL's query", `https://zarquon.se/send?to=${address("ann", "zarquon.se")}`],
    ["after a word with a colon", `email:${address("ann", "zarquon.se")}`],
    ["in a ';' separated row, after a URL without a path", `Zarquon AB;https://zarquon.se;${address("ann.berg", "zarquon.se")};08-123 45 67`],
    ["in a '|' separated row, after a URL without a path", `Zarquon AB|https://zarquon.se|${address("ann.berg", "zarquon.se")}|08-123 45 67`],
    ["after a URL and a word with a dot", `https://ann.berg:${address("ann", "zarquon.se")}`],
    ["before a colon and a password", `${address("ann.berg", "zarquon.se")}:hunter2`],
    ["used as a file name", `attachment: ${address("ann.berg", "zarquon.se")}.csv`],
    ["used as a file name in JSON", `{"file": "${address("ann.berg", "zarquon.se")}.json"}`],
    ["used as a file name with two extensions", `${address("ann.berg", "zarquon.se")}.json.map`],
    ["used as a folder name", `fixtures/${address("ann.berg", "zarquon.se")}/receipt.json`],
    ["in a path that is not a URL", `/npm/${address("pkg", "zarquon.se")}/file`],
  ])("finds one %s", (_where, line) => {
    expect(kinds(line)).toEqual(["email"]);
  });

  it("keys an address in lower case, and without the extension when it is used as a file name", () => {
    expect(valuesIn(address("Ann", "Zarquon.SE"))).toEqual([{ kind: "email", key: address("ann", "zarquon.se") }]);
    expect(valuesIn(`${address("Ann", "Zarquon.SE")}.JSON`)).toEqual([{ kind: "email", key: address("ann", "zarquon.se") }]);
  });

  it.each([
    ["example.com", address("ann", "example.com")],
    ["example.net", address("ann", "example.net")],
    ["example.org", address("ann", "example.org")],
    ["a name under example.com", address("ann", "mail.example.com")],
    ["example.com in capitals", address("ann", "EXAMPLE.COM")],
    [".example", address("ann", "zarquon.example")],
    [".test", address("ann", "zarquon.test")],
    [".invalid", address("ann", "example.invalid")],
    [".localhost", address("ann", "app.localhost")],
    ["GitHub's noreply addresses", address("1+zarquon", "users.noreply.github.com")],
    ["example.com, used as a file name", `${address("ann", "example.com")}.json`],
  ])("lets through an address at %s", (_domain, line) => {
    expect(valuesIn(line)).toEqual([]);
  });

  it.each([
    ["an address at a domain that only looks reserved", address("ann", "example.se")],
    ["an address at a name that ends in example.com", address("ann", "myexample.com")],
    ["an address at a name with test in it", address("ann", "zarquontest.se")],
  ])("finds %s", (_case, line) => {
    expect(kinds(line)).toEqual(["email"]);
  });

  it.each([
    ["a package scope", "@types/node"],
    ["a scoped package with its version", "@typescript/native@7.0.2"],
    ["an npm spec", "npm:@typescript/typescript6@6.0.2"],
    ["a version spec", "typescript@7.0.2"],
    ["an action pinned to a commit", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"],
    ["a decorator", "@Component({ selector: 'app' })"],
    ["a CSS rule", "@media (prefers-color-scheme: dark) {"],
    ["a JSDoc tag", " * @param value the amount"],
    ["a host without a top-level domain", "ann@localhost"],
    ["a git remote", "git@github.com:owner/repo.git"],
    ["a git remote with a port", `${address("git", "git.zarquon.se")}:22/owner/repo.git`],
    ["a copy target with a path from the root", `${address("ann", "build.zarquon.se")}:/srv/app`],
    ["an ssh URL", "ssh://git@github.com/owner/repo.git"],
    ["the user part of a URL", "https://user:token@registry.zarquon.se/"],
    ["the user part of a URL, without a path", "https://ann@zarquon.se"],
    ["a path after a domain", "https://cdn.jsdelivr.net/npm/pkg@next.dev/dist/x.js"],
    ["a scope in a URL", "https://www.npmjs.com/package/@types/node"],
    ["a file name for a high-density picture", "logo@2x.png"],
    ["another such file name", "icons/arrow@3x.webp"],
    ["such a file name with two extensions", "logo@2x.png.map"],
  ])("lets through %s", (_case, line) => {
    expect(valuesIn(line)).toEqual([]);
  });

  it("finds an address after a URL on the same line", () => {
    expect(kinds(`https://zarquon.se/ ${address("ann", "zarquon.se")}`)).toEqual(["email"]);
  });
});

describe("paths", () => {
  it.each([
    ["an address before .json", `fixtures/${address("ann.berg", "zarquon.se")}.json`, "email"],
    ["an address before an extension that is not on the list", `mail/${address("ann.berg", "zarquon.se")}.eml`, "email"],
    ["an address as a folder name", `fixtures/${address("ann.berg", "zarquon.se")}/statement.csv`, "email"],
    ["an address before a colon", `notes/${address("ann.berg", "zarquon.se")}:old.txt`, "email"],
    ["an address as a folder name after a URL's scheme", `https:/${address("ann.berg", "zarquon.se")}/a`, "email"],
    ["an identity number joined by dashes", "kunder/900101-2385-faktura.csv", "personal-identity-number"],
    ["an identity number with the century, joined by dashes", "kunder/19900101-2385-2024.csv", "personal-identity-number"],
    ["an identity number that starts a UUID", "fixtures/19900101-2385-4abc-8def-0123456789ab.json", "personal-identity-number"],
    ["an organisation number as a file name", "bolag/5560000167.json", "organisation-number"],
  ])("finds %s", (_case, path, kind) => {
    expect(pathKinds(path)).toEqual([kind]);
  });

  it("gives each value once, keyed without the extension", () => {
    expect(valuesInPath(`a/${address("Ann", "Zarquon.se")}.json/${address("ann", "zarquon.se")}`)).toEqual([
      { kind: "email", key: address("ann", "zarquon.se") },
    ]);
  });

  it.each([
    ["a high-density picture", "icons/arrow@3x.webp"],
    ["an address at example.com as a file name", `fixtures/${address("ann", "example.com")}.json`],
    ["a timestamp as a file name", "logs/1767225600.json"],
    ["a UUID as a file name", "fixtures/3f2504e0-4f89-11d3-9a0c-0305e82c3301.json"],
    ["a scoped package", "node_modules/@types/node/index.d.ts"],
  ])("lets through %s", (_case, path) => {
    expect(valuesInPath(path)).toEqual([]);
  });
});

describe("hasValueShape", () => {
  it.each([
    ["a run of 10 digits", "logs/1767225600.json"],
    ["a run of 12 digits with a dash", "a/19900101-2385-anna"],
    ["an address at example.com", `x/${address("ann", "example.com")}.json`],
    ["an address", `x/${address("ann.berg", "zarquon.se")}/y`],
  ])("sees %s", (_case, text) => {
    expect(hasValueShape(text)).toBe(true);
  });

  it.each([
    ["a high-density picture", "docs/logo@2x.png"],
    ["a plain path", "docs/a.md"],
    ["a scoped package", "@types/node"],
    ["a version", "typescript@7.0.2"],
    ["a run of 9 digits", "123456789"],
  ])("sees no shape in %s", (_case, text) => {
    expect(hasValueShape(text)).toBe(false);
  });
});

describe("random data", () => {
  it("finds nothing in timestamps, versions and hashes", () => {
    for (const line of [
      "1767225600",
      "1798761599",
      "1767225600000",
      "2026-11-01T12:00:00Z",
      "20261101120000",
      "version 1.2.3 and 10.13.0",
      "3d3c42e5aac5ba805825da76410c181273ba90b1",
      "sha512-2iPzY1ZAiA0ZlBpXr0lVx8XUhnKsqTqA5h7Hk4G6qVd1j4c3d5f6789gT==",
    ]) {
      expect(valuesIn(line)).toEqual([]);
    }
  });

  it("finds nothing in a run of digits that touches a letter", () => {
    fc.assert(
      fc.property(digits(10), fc.constantFrom("a", "f", "Z"), (run, letter) => {
        expect(valuesIn(`${letter}${run}`)).toEqual([]);
        expect(valuesIn(`${run}${letter}`)).toEqual([]);
      }),
    );
  });
});
