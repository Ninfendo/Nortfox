// SPDX-License-Identifier: AGPL-3.0-only

// The tests plant numbers from Skatteverket's published test series, which
// are on the list of test values, so this file passes the guard. Here they
// are read without the list, to show that the guard finds them. Every other
// number that should be found is built while the test runs, and every
// address that should be found is joined from its parts, so neither appears
// in this file as written. Such an address is at zarquon.zz, or at another
// name that no one can register (scripts/testing/personal-data.ts).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { address, checkDigit, numberWith } from "../testing/personal-data.ts";
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
  // A listed number in 10 digits with "+" names a person a century earlier, who is not on the
  // list, so those forms are built while the test runs.
  const plus = numberWith("900101", "+", "238");
  const coordinationPlus = numberWith("260161", "+", "238");

  it.each([
    ["12 digits with a dash", "19900101-2385", "personal-identity-number", "199001012385"],
    ["12 digits without one", "199001012385", "personal-identity-number", "199001012385"],
    ["12 digits with a plus", "19900101+2385", "personal-identity-number", "199001012385"],
    ["10 digits with a dash", "900101-2385", "personal-identity-number", "9001012385"],
    ["10 digits with a plus, which keeps the plus in its key", plus, "personal-identity-number", plus],
    ["10 digits without one", "9001012385", "personal-identity-number", "9001012385"],
    ["a coordination number in 12 digits with a dash", "20260161-2381", "coordination-number", "202601612381"],
    ["a coordination number in 12 digits without one", "202601612381", "coordination-number", "202601612381"],
    ["a coordination number in 10 digits with a dash", "260161-2381", "coordination-number", "2601612381"],
    ["a coordination number in 10 digits with a plus", coordinationPlus, "coordination-number", coordinationPlus],
    ["a coordination number in 10 digits without one", "2601612381", "coordination-number", "2601612381"],
  ])("finds %s", (_form, value, kind, key) => {
    expect(valuesIn(value)).toEqual([{ kind, key }]);
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

  it.each([
    ["12 digits with a dash", "19900101-2385"],
    ["12 digits without one", "199001012385"],
    ["12 digits with a plus", "19900101+2385"],
    ["10 digits with a dash", "900101-2385"],
    ["10 digits with a plus", plus],
    ["10 digits without one", "9001012385"],
  ])("finds one in %s with a dash and a word or a number after it, as in a file name", (_form, number) => {
    for (const after of ["-anna", "-kvitto.json", "-2024", "-1", "-2024-11.pdf", "-0001-A"]) {
      expect(kinds(`${number}${after}`)).toEqual(["personal-identity-number"]);
      expect(kinds(`kund-${number}${after}`)).toEqual(["personal-identity-number"]);
    }
  });

  it.each([
    ["a file name of the form number-year-month, in JSON", '"file": "19900101-2385-2024-11.pdf"'],
    ["a reference with a serial number after the number", "ref 19900101-2385-0001-A"],
    ["10 digits with the rest of a UUID after them", "900101-2385-4abc-8def-0123456789ab"],
    ["12 digits with a plus and the rest of a UUID after them", "19900101+2385-4abc-8def-0123456789ab"],
    ["12 digits without a dash and with the rest of a UUID after them", "199001012385-4abc-8def-0123456789ab"],
    ["the shape of a UUID whose last group is one digit too long", "19900101-2385-4abc-8def-0123456789abc"],
    ["the shape of a UUID whose last group is one digit too short", "19900101-2385-4abc-8def-0123456789a"],
  ])("finds one in %s", (_case, line) => {
    expect(kinds(line)).toEqual(["personal-identity-number"]);
  });

  it.each([
    ["12 digits with a dash, before a dot and a year, as in a file name in JSON", '{"file": "19900101-2385.2024.pdf"}'],
    ["10 digits with a dash, before a dot and a digit", "900101-2385.1"],
    ["10 digits with a plus, before a dot and a digit", `${plus}.1`],
    ["12 digits with a plus, before a dot and a year", "19900101+2385.2024"],
    ["12 digits with a dash, after a digit and a dot", "v1.19900101-2385"],
  ])("finds one in %s, since a number with a dash or a plus is never a decimal number", (_case, line) => {
    expect(kinds(line)).toEqual(["personal-identity-number"]);
  });

  it.each([
    ["10 digits without a dash, at the end of a sentence", "Personnummer 9001012385.", "personal-identity-number"],
    ["10 digits without a dash, before a dot and an extension, in JSON", '{"file": "9001012385.json"}', "personal-identity-number"],
    ["12 digits without a dash, after a space and a dot", "see .199001012385", "personal-identity-number"],
    ["an organisation number without a dash, after a word and a dot", "Org.nr.5560000167", "organisation-number"],
  ])("finds one in %s, since a dot without a digit on its other side is no decimal point", (_case, line, kind) => {
    expect(kinds(line)).toEqual([kind]);
  });

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
    ["12 digits without a dash before a dot and a year, which is a decimal number in a line", "199001012385.2024"],
    ["a space for the dash", "900101 2385"],
  ])("lets through %s", (_case, line) => {
    expect(valuesIn(line)).toEqual([]);
  });

  // Each number here has a right check digit, so only its date can let it through. Its third digit is
  // the first digit of a month, 0 or 1, so its ten digits make no organisation number either.
  it.each([
    ["month 0", "19900001"],
    ["month 13", "19901301"],
    ["day 0", "19900100"],
    ["day 32", "19900132"],
    ["30 February", "19900230"],
    ["31 April", "19900431"],
    ["31 June", "19900631"],
    ["31 September", "19900931"],
    ["31 November", "19901131"],
    ["the coordination day for 31 April", "19900491"],
    ["the coordination day for 31 November", "19901191"],
    ["a coordination day past 91", "19900192"],
    ["a day between 31 and 61", "19900145"],
  ])("lets through a date that is not on the calendar, %s, though the check digit is right", (_case, date) => {
    for (const head of [date, date.slice(2)]) {
      for (const separator of ["-", "+", ""]) {
        const number = numberWith(head, separator, "238");
        const ten = number.replace(/\D/g, "").slice(-10);
        expect(luhnValid(ten)).toBe(true);
        expect(valuesIn(number)).toEqual([]);
        expect(valuesIn(`SE${ten}01`)).toEqual([]);
      }
    }
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

  it.each([
    ["NNNNNN-NNNN before a dot and a digit", "Org.nr 556000-0167.1"],
    ["16NNNNNN-NNNN before a dot and a year, as in a file name", "16556000-0167.2024.pdf"],
  ])("finds the form %s, since a number with a dash is never a decimal number", (_form, line) => {
    expect(valuesIn(line)).toEqual([{ kind: "organisation-number", key: "5560000167" }]);
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

  it("finds nothing in a made-up reference that follows the advice in CONTRIBUTING.md", () => {
    // In 10 digits: a first digit of 0 or 4, and a third and fourth digit of 13 or more.
    const tenDigits = fc.tuple(fc.constantFrom("0", "4"), digits(1), fc.integer({ min: 13, max: 99 }), digits(5));
    fc.assert(
      fc.property(tenDigits, ([first, second, month, rest]) => {
        const nine = `${first}${second}${String(month)}${rest}`;
        const reference = `${nine}${checkDigit(nine)}`;
        expect(valuesIn(reference)).toEqual([]);
        expect(valuesIn(`OCR ${reference}`)).toEqual([]);
      }),
      { numRuns: 400 },
    );
    // Any other length than 10 or 12 digits.
    const otherLength = fc.constantFrom(7, 8, 9, 11, 13, 14, 15, 16).chain((length) => digits(length));
    fc.assert(
      fc.property(otherLength, (reference) => {
        expect(valuesIn(`OCR ${reference}`)).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });
});

describe("VAT numbers", () => {
  /** An organisation number's ten digits with this start and a right check digit. */
  const ten = (nine: string): string => `${nine}${checkDigit(nine)}`;

  it.each([
    ["alone", "SE556000016701", "organisation-number", "5560000167"],
    ["in lower case", "se599999012901", "organisation-number", "5999990129"],
    ["in a Peppol e-invoice", "<cbc:CompanyID>SE556000016701</cbc:CompanyID>", "organisation-number", "5560000167"],
    ["in JSON", '"vat": "SE556000016701"', "organisation-number", "5560000167"],
    ["of a sole trader, which holds an identity number", "SE900101238501", "personal-identity-number", "9001012385"],
    ["of a sole trader with a coordination number", "SE260161238101", "coordination-number", "2601612381"],
  ])("finds the number in a VAT number %s", (_case, line, kind, key) => {
    expect(valuesIn(line)).toEqual([{ kind, key }]);
  });

  it("finds an organisation number with the group digit 1 in a VAT number, which is never a Unix time", () => {
    const number = ten("162000012");
    expect(kinds(number)).toEqual([]);
    expect(kinds(`SE${number}01`)).toEqual(["organisation-number"]);
  });

  it.each([
    ["a wrong check digit", "SE556000016801"],
    ["a date that is not on the calendar, and a right check digit", `SE${numberWith("901301", "", "238")}01`],
    ["the group digit 4", `SE${ten("462000012")}01`],
    ["an end other than 01", "SE556000016702"],
    ["a letter before it", "XSE556000016701"],
    ["a letter after it", "SE556000016701x"],
    ["11 digits", "SE5560000167001"],
  ])("lets through a VAT number with %s", (_case, line) => {
    expect(valuesIn(line)).toEqual([]);
  });

  it("finds a VAT number exactly when its ten digits, written NNNNNN-NNNN, are found", () => {
    fc.assert(
      fc.property(digits(10), (number) => {
        const written = `${number.slice(0, 6)}-${number.slice(6)}`;
        expect(kinds(`SE${number}01`)).toEqual(kinds(written));
        expect(valuesInPath(`fakturor/SE${number}01.xml`).map((value) => value.kind)).toEqual(kinds(written));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("e-mail addresses", () => {
  it.each([
    ["alone", address("ann.berg", "zarquon.zz")],
    ["in capitals", address("Ann.Berg", "ZARQUON.ZZ")],
    ["with a plus and digits", address("ann+invoices2", "mail.zarquon.zz")],
    ["at a domain with letters outside ASCII", address("ann", "zarquön.zz")],
    ["after mailto:", `mailto:${address("ann", "zarquon.zz")}`],
    ["in angle brackets", `Ann Berg <${address("ann", "zarquon.zz")}>`],
    ["in JSON", `{"email":"${address("ann", "zarquon.zz")}"}`],
    ["at the end of a sentence", `Write to ${address("ann", "zarquon.zz")}.`],
    ["before a colon and a space", `${address("ann", "zarquon.zz")}: the invoice`],
    ["in a URL's query", `https://zarquon.zz/send?to=${address("ann", "zarquon.zz")}`],
    ["after a word with a colon", `email:${address("ann", "zarquon.zz")}`],
    ["in a ';' separated row, after a URL without a path", `Zarquon AB;https://zarquon.zz;${address("ann.berg", "zarquon.zz")};08-123 45 67`],
    ["in a '|' separated row, after a URL without a path", `Zarquon AB|https://zarquon.zz|${address("ann.berg", "zarquon.zz")}|08-123 45 67`],
    ["after a URL and a word with a dot", `https://ann.berg:${address("ann", "zarquon.zz")}`],
    ["before a colon and a password", `${address("ann.berg", "zarquon.zz")}:hunter2`],
    ["used as a file name", `attachment: ${address("ann.berg", "zarquon.zz")}.csv`],
    ["used as a file name in JSON", `{"file": "${address("ann.berg", "zarquon.zz")}.json"}`],
    ["used as a file name with two extensions", `${address("ann.berg", "zarquon.zz")}.json.map`],
    ["used as a folder name", `fixtures/${address("ann.berg", "zarquon.zz")}/receipt.json`],
    ["used as a file name with a dash and a word after it", `${address("ann.berg", "zarquon.zz")}-photo.png`],
    ["used as a file name with a digit after it", `${address("ann.berg", "zarquon.zz")}2.png`],
    ["before a dash and a word, as in a Swedish compound", `Skicka till ${address("ekonomi", "zarquon.zz")}-adressen.`],
    ["in a path that is not a URL", `/npm/${address("pkg", "zarquon.zz")}/file`],
    ["in a URL's path, as in a REST call", `GET https://api.zarquon.zz/v1.0/users/${address("ann.berg", "zarquon.zz")}/messages`],
    ["in a URL's path, in JSON", `{"url": "https://api.zarquon.zz/v1/users/${address("ann.berg", "zarquon.zz")}/messages?x=1"}`],
    ["in a ';' separated row, before a path", `Zarquon AB;https://zarquon.zz;${address("ann.berg", "zarquon.zz")}/kontakt`],
    ["in a URL's query, before a '/'", `https://zarquon.zz/send?to=${address("ann", "zarquon.zz")}/`],
    ["after a ',' in a URL's path", `https://zarquon.zz/a,${address("ann", "zarquon.zz")}/b`],
    [
      "as the user name of a URL, percent-encoded",
      `url = https://${encodeURIComponent(address("ann.berg", "zarquon.zz"))}@git.zarquon.zz/team/repo.git`,
    ],
    ["as the user name of a URL, before the host's '@'", `https://${address("ann.berg", "zarquon.zz")}@git.example.com/team/repo.git`],
    ["as the user name of a URL, before a password", `https://${address("ann", "zarquon.zz")}:token@git.example.com/`],
  ])("finds one %s", (_where, line) => {
    expect(kinds(line)).toEqual(["email"]);
  });

  it("keys an address in lower case, and without what follows it when it is used as a file name", () => {
    const key = address("ann", "zarquon.zz");
    expect(valuesIn(address("Ann", "Zarquon.ZZ"))).toEqual([{ kind: "email", key }]);
    expect(valuesIn(`${address("Ann", "Zarquon.ZZ")}.JSON`)).toEqual([{ kind: "email", key }]);
    expect(valuesIn(`${address("ann", "zarquon.zz")}-photo.png`)).toEqual([{ kind: "email", key }]);
    expect(valuesIn(`${address("ann", "zarquon.zz")}2.png`)).toEqual([{ kind: "email", key }]);
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
    ["an address at a domain that only looks reserved", address("ann", "example.zz")],
    // No registry takes a name with "--" as its third and fourth characters, so this one is never real.
    ["an address at a name that ends in example.com", address("ann", "my--example.com")],
    ["an address at a name with test in it", address("ann", "zarquontest.zz")],
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
    ["a git remote with a port", `${address("git", "git.zarquon.zz")}:22/owner/repo.git`],
    ["a copy target with a path from the root", `${address("ann", "build.zarquon.zz")}:/srv/app`],
    ["an ssh URL", "ssh://git@github.com/owner/repo.git"],
    ["the user part of a URL", "https://user:token@registry.zarquon.zz/"],
    ["the user part of a URL, without a path", "https://ann@zarquon.zz"],
    ["the user part of a URL, with an allowed address after its path", `https://ann@zarquon.zz/ ${address("bo", "example.com")}`],
    ["a scope in a URL", "https://www.npmjs.com/package/@types/node"],
    ["a file name for a high-density picture", "logo@2x.png"],
    ["another such file name", "icons/arrow@3x.webp"],
    ["such a file name with two extensions", "logo@2x.png.map"],
    ["a pre-release version that ends in a word and a digit", "pkg@1.0.0-alpha.beta1"],
    ["a pre-release version with a dot and a digit after a word", "pkg@1.0.0-alpha.beta.1"],
    ["a pre-release version with a dot and a letter after a word", "pkg@1.0.0-alpha.beta.x"],
    ["a name whose last part is longer than a top-level domain can be", address("ann", `zarquon.${"a".repeat(64)}`)],
    ["such a name used as a file name", `${address("ann", `zarquon.${"a".repeat(64)}`)}.json`],
  ])("lets through %s", (_case, line) => {
    expect(valuesIn(line)).toEqual([]);
  });

  it("finds an address after a URL on the same line", () => {
    expect(kinds(`https://zarquon.zz/ ${address("ann", "zarquon.zz")}`)).toEqual(["email"]);
  });
});

describe("paths", () => {
  it.each([
    ["an address before .json", `fixtures/${address("ann.berg", "zarquon.zz")}.json`, "email"],
    ["an address before an extension that is not on the list", `mail/${address("ann.berg", "zarquon.zz")}.eml`, "email"],
    ["an address as a folder name", `fixtures/${address("ann.berg", "zarquon.zz")}/statement.csv`, "email"],
    ["an address before a colon", `notes/${address("ann.berg", "zarquon.zz")}:old.txt`, "email"],
    ["an address as a folder name after a URL's scheme", `https:/${address("ann.berg", "zarquon.zz")}/a`, "email"],
    ["an identity number joined by dashes", "kunder/900101-2385-faktura.csv", "personal-identity-number"],
    ["an identity number with the century, joined by dashes", "kunder/19900101-2385-2024.csv", "personal-identity-number"],
    ["an identity number that starts a UUID", "fixtures/19900101-2385-4abc-8def-0123456789ab.json", "personal-identity-number"],
    ["an identity number with a dash, a dot and a year", "kunder/19900101-2385.2024.csv", "personal-identity-number"],
    ["an identity number in 10 digits with a dash, a dot and a digit", "kunder/900101-2385.1.json", "personal-identity-number"],
    ["an identity number without a dash, before a dot and a year", "kunder/199001012385.2024.csv", "personal-identity-number"],
    ["an identity number without a dash, after a digit and a dot", "kunder/1.9001012385", "personal-identity-number"],
    ["an organisation number with a dash, a dot and a digit", "bolag/556000-0167.1.json", "organisation-number"],
    ["an organisation number as a file name", "bolag/5560000167.json", "organisation-number"],
    ["an organisation number in a VAT number", "fakturor/SE556000016701.xml", "organisation-number"],
    ["an address with a dash and a word after it", `avatars/${address("ann.berg", "zarquon.zz")}-photo.png`, "email"],
    ["an address with a dash and a year after it, as a folder name", `inbox/${address("ann.berg", "zarquon.zz")}-2024/mail.png`, "email"],
    ["an address with a digit after it", `avatars/${address("ann.berg", "zarquon.zz")}2.png`, "email"],
    ["an address with a digit after it, as a folder name", `people/${address("ann.berg", "zarquon.zz")}2/a.json`, "email"],
    ["an address with a dot and a digit after it, as a folder name", `people/${address("ann.berg", "zarquon.zz")}.2/a.json`, "email"],
  ])("finds %s, and sees its shape", (_case, path, kind) => {
    expect(pathKinds(path)).toEqual([kind]);
    // The shape test is looser than the rules, so it sees every value they find.
    expect(hasValueShape(path)).toBe(true);
  });

  it("finds an address in a folder name that a line lets through, because a digit follows it", () => {
    const folder = `people/${address("ann.berg", "zarquon.zz")}2/a.json`;
    expect(kinds(folder)).toEqual([]);
    expect(pathKinds(folder)).toEqual(["email"]);
  });

  it("finds a number in a file name that a line reads as a part of a decimal number", () => {
    for (const name of ["199001012385.2024.csv", "9001012385.25", "0.9001012385"]) {
      expect(kinds(name)).toEqual([]);
      expect(pathKinds(`kunder/${name}`)).toEqual(["personal-identity-number"]);
    }
  });

  it("gives each value once, keyed without the extension", () => {
    expect(valuesInPath(`a/${address("Ann", "Zarquon.zz")}.json/${address("ann", "zarquon.zz")}`)).toEqual([
      { kind: "email", key: address("ann", "zarquon.zz") },
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
    ["an address", `x/${address("ann.berg", "zarquon.zz")}/y`],
    ["a VAT number", "fakturor/SE556000016701.xml"],
    ["a domain after an '@' without a local part, which no rule finds", "people/@zarquon.zz/a.json"],
  ])("sees %s", (_case, text) => {
    expect(hasValueShape(text)).toBe(true);
  });

  it.each([
    ["a high-density picture", "docs/logo@2x.png"],
    ["a high-density picture with a dash and a word", "docs/logo@2x-dark.png"],
    ["a plain path", "docs/a.md"],
    ["a scoped package", "@types/node"],
    ["a version", "typescript@7.0.2"],
    ["a pre-release version", "pkg@1.0.0-rc.1"],
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

  it("finds a date with a time after it one time in ten, as CONTRIBUTING.md says, and nothing in a time written with a T", () => {
    const times: string[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      for (let minute = 0; minute < 60; minute += 1) {
        times.push(`${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`);
      }
    }
    // The date always has a valid date, so only the check digit decides: one minute in ten.
    expect(times.filter((time) => kinds(`backup-20261102-${time}.sql`).length > 0)).toHaveLength(144);
    expect(times.filter((time) => kinds(`"generated": "20261102${time}"`).length > 0)).toHaveLength(144);
    for (const time of times) {
      expect(valuesIn(`backup-20261102T${time}.sql`)).toEqual([]);
      expect(valuesIn(`backup-2026-11-02T${time.slice(0, 2)}:${time.slice(2)}.sql`)).toEqual([]);
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
