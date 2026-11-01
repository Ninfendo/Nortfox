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
    "900101+2385",
    "9001012385",
    "20260161-2381",
    "2601612381",
    "556000-0167",
    "16556000-0167",
    "165560000167",
    "noreply@anthropic.com",
    "NoReply@Anthropic.COM",
  ])("lets %s through", (text) => {
    expect(isListed(only(text), values)).toBe(true);
  });

  it.each([
    ["another identity number", numberWith("19900101", "-", "239")],
    ["a listed number's 10 digits after another century, written in 12", numberWith("18900101", "-", "238")],
    ["another organisation number", numberWith("556000", "-", "017")],
    ["another address", address("noreply", "zarquon.se")],
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
    ["an address in capitals", `email ${address("NoReply", "zarquon.se")}`, "is not one e-mail address in lower case"],
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

  it("refuses a value that is on the list already, and names each line", () => {
    expect(
      problemsOf(
        [
          "personal-identity-number 19900101-2385",
          "personal-identity-number 19900101-2385",
          `email ${address("noreply", "zarquon.se")}`,
          `email ${address("noreply", "zarquon.se")}`,
        ].join("\n"),
      ),
    ).toEqual(["list.txt:2: the value is on the list already.", "list.txt:4: the value is on the list already."]);
  });

  it("never names the value in a problem", () => {
    const lines = [
      "phone 19900101-2385",
      "personal-identity-number 19900101-2386",
      "organisation-number 556000-0168",
      `email ${address("NoReply", "zarquon.se")}`,
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
