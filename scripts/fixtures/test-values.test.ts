// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { address, numberWith } from "../testing/personal-data.ts";
import { isListed, parseTestValues, TEST_VALUES_FILE } from "./test-values.ts";
import { valuesIn, type Value } from "./values.ts";

const committed = readFileSync(new URL("./test-values.txt", import.meta.url), "utf8");

/** The one value in a text. */
function only(text: string): Value {
  const [value, ...rest] = valuesIn(text);
  expect(rest).toEqual([]);
  if (value === undefined) {
    throw new Error("The text holds no value.");
  }
  return value;
}

describe("the committed list", () => {
  const { values, problems } = parseTestValues(committed);

  it("is in order: every entry has its form, looks real and is there once", () => {
    expect(problems).toEqual([]);
  });

  it("holds the test values, and stays short", () => {
    expect([...values.identities]).toEqual(["199001012385", "200001012384", "201001012382", "202601612381"]);
    expect([...values.organisations]).toEqual(["5560000167", "5999990129"]);
    expect([...values.emails]).toEqual(["noreply@anthropic.com"]);
  });

  it("says where each group of entries comes from", () => {
    const blocks = committed.split(/\n\s*\n/).filter((block) => /^[a-z-]+ \S+$/m.test(block));
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      expect(block.split("\n")[0]).toMatch(/^# /);
    }
  });

  it.each([
    "19900101-2385",
    "199001012385",
    "19900101+2385",
    "900101-2385",
    "9001012385",
    "SE900101238501",
    "20260161-2381",
    "2601612381",
    "556000-0167",
    "16556000-0167",
    "165560000167",
    "SE556000016701",
    "se599999012901",
    "noreply@anthropic.com",
    "NoReply@Anthropic.COM",
  ])("lets %s through", (text) => {
    expect(isListed(only(text), values)).toBe(true);
  });

  it.each([
    ["another identity number", numberWith("19900101", "-", "239")],
    ["a listed number's 10 digits after another century, written in 12", numberWith("18900101", "-", "238")],
    // In 10 digits, "+" says the person is 100 or older: these are the listed numbers' digits a century earlier.
    ["a listed number in 10 digits with a plus", numberWith("900101", "+", "238")],
    ["another listed number in 10 digits with a plus", numberWith("000101", "+", "238")],
    ["a third listed number in 10 digits with a plus", numberWith("100101", "+", "238")],
    ["a listed coordination number in 10 digits with a plus", numberWith("260161", "+", "238")],
    ["another organisation number", numberWith("556000", "-", "017")],
    ["another address", address("noreply", "zarquon.zz")],
  ])("does not let %s through", (_case, text) => {
    expect(isListed(only(text), values)).toBe(false);
  });
});

describe("parseTestValues", () => {
  const problemsOf = (text: string): readonly string[] => parseTestValues(text, "list.txt").problems;

  it("skips comments and empty lines, and reads entries with any spaces around them", () => {
    const { values, problems } = parseTestValues(
      "# A comment\n\n  personal-identity-number   19900101-2385  \r\norganisation-number 556000-0167\n",
    );
    expect(problems).toEqual([]);
    expect([...values.identities]).toEqual(["199001012385"]);
    expect([...values.identityTails]).toEqual(["9001012385"]);
    expect([...values.organisations]).toEqual(["5560000167"]);
  });

  it.each([
    ["an unknown kind", "phone 19900101-2385"],
    ["a kind without a value", "personal-identity-number"],
    ["more than one value", "personal-identity-number 19900101-2385 20000101-2384"],
    ["a value with a comment after it", "personal-identity-number 19900101-2385 # Skatteverket"],
  ])("refuses %s", (_case, line) => {
    expect(problemsOf(line)).toEqual([
      'list.txt:1 is not "<kind> <value>", where the kind is one of personal-identity-number, coordination-number, organisation-number, email.',
    ]);
  });

  it.each([
    ["an identity number without the century", "personal-identity-number 900101-2385", "is not in the form YYYYMMDD-NNNN"],
    ["an identity number without the dash", "personal-identity-number 199001012385", "is not in the form YYYYMMDD-NNNN"],
    [
      "an identity number with a wrong check digit",
      "personal-identity-number 19900101-2386",
      "is not a personal identity number with a valid date and check digit, so the guard lets it through without an entry",
    ],
    [
      "a coordination number listed as a personal identity number",
      "personal-identity-number 20260161-2381",
      "is not a personal identity number with a valid date and check digit, so the guard lets it through without an entry",
    ],
    [
      "a personal identity number listed as a coordination number",
      "coordination-number 19900101-2385",
      "is not a coordination number with a valid date and check digit, so the guard lets it through without an entry",
    ],
    ["an organisation number with 16 in front", "organisation-number 16556000-0167", "is not in the form NNNNNN-NNNN"],
    [
      "an organisation number with a wrong check digit",
      "organisation-number 556000-0168",
      "is not an organisation number with a valid group digit and check digit, so the guard lets it through without an entry",
    ],
    [
      "an organisation number with a group digit that is not given out",
      "organisation-number 456000-0168",
      "is not an organisation number with a valid group digit and check digit, so the guard lets it through without an entry",
    ],
    ["an address in capitals", `email ${address("NoReply", "zarquon.zz")}`, "is not one e-mail address in lower case"],
    ["something that is not an address", "email noreply", "is not one e-mail address in lower case"],
    ["a file name shaped like an address", "email logo@2x.png", "is not one e-mail address in lower case"],
    [
      "an address at a reserved domain",
      `email ${address("ann", "example.com")}`,
      "is at a domain the guard always lets through, so it needs no entry",
    ],
    [
      "a GitHub noreply address",
      `email ${address("1+zarquon", "users.noreply.github.com")}`,
      "is at a domain the guard always lets through, so it needs no entry",
    ],
  ])("refuses %s", (_case, line, problem) => {
    expect(problemsOf(line)).toEqual([`list.txt:1: the value ${problem}.`]);
  });

  describe("in the year 2026", () => {
    const AGE_PROBLEM =
      'list.txt:1: the value is for a person who is 100 or older this year, or born after this year. In 10 digits with "-", its digits name another person, so it cannot be on the list.';
    const parsed = (kind: string, number: string) => parseTestValues(`${kind} ${number}`, "list.txt", 2026);

    // Skatteverket's series of test numbers starts with people born in 1890, so the list could be offered one of these.
    it.each([
      ["a person born in 1890", "personal-identity-number", numberWith("18900101", "-", "980")],
      ["a person born in 1910", "personal-identity-number", numberWith("19100101", "-", "980")],
      ["a person who turns 100 this year", "personal-identity-number", numberWith("19261231", "-", "980")],
      ["a person born after this year", "personal-identity-number", numberWith("20270101", "-", "980")],
      ["a coordination number of a person born in 1910", "coordination-number", numberWith("19100161", "-", "980")],
    ])("refuses the number of %s", (_case, kind, number) => {
      const { values, problems } = parsed(kind, number);
      expect(problems).toEqual([AGE_PROBLEM]);
      // So its 10 digits with "-", which name a person born a century later, are not listed.
      expect([...values.identities, ...values.identityTails]).toEqual([]);
      const dashed = number.slice(2);
      expect(isListed(only(dashed), values)).toBe(false);
    });

    it.each([
      ["a person who turns 99 this year", "personal-identity-number", numberWith("19270101", "-", "980")],
      ["a person born this year", "personal-identity-number", numberWith("20261231", "-", "980")],
      ["a coordination number of a person born this year", "coordination-number", numberWith("20260161", "-", "980")],
    ])("takes the number of %s, and lets it through in 10 digits with a dash", (_case, kind, number) => {
      const { values, problems } = parsed(kind, number);
      expect(problems).toEqual([]);
      expect(isListed(only(number.slice(2)), values)).toBe(true);
      expect(isListed(only(`${number.slice(2, 8)}+${number.slice(9)}`), values)).toBe(false);
    });
  });

  it("refuses a value that is on the list already, and names each line", () => {
    expect(
      problemsOf(
        [
          "personal-identity-number 19900101-2385",
          "personal-identity-number 19900101-2385",
          `email ${address("noreply", "zarquon.zz")}`,
          `email ${address("noreply", "zarquon.zz")}`,
        ].join("\n"),
      ),
    ).toEqual(["list.txt:2: the value is on the list already.", "list.txt:4: the value is on the list already."]);
  });

  it("never names the value in a problem", () => {
    const lines = [
      "phone 19900101-2385",
      "personal-identity-number 19900101-2386",
      "organisation-number 556000-0168",
      `email ${address("NoReply", "zarquon.zz")}`,
      "personal-identity-number 20000101-2384",
      "personal-identity-number 20000101-2384",
    ];
    const text = problemsOf(lines.join("\n")).join("\n");
    expect(text).not.toMatch(/\d{4}/);
    expect(text.toLowerCase()).not.toContain("zarquon");
  });

  it("names the committed list by its path", () => {
    expect(parseTestValues("phone 1").problems).toEqual([
      `${TEST_VALUES_FILE}:1 is not "<kind> <value>", where the kind is one of personal-identity-number, coordination-number, organisation-number, email.`,
    ]);
  });
});
