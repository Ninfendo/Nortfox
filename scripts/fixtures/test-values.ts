// SPDX-License-Identifier: AGPL-3.0-only

// The fixture guard's list of test values: the published test identity and
// organisation numbers that tests may use (docs/plan.md, section 6), and the
// one address that the Co-Authored-By example in AGENTS.md needs. The list is
// short on purpose, and each entry says where it comes from. The guard holds
// the list to its own rules, so an entry that would not be found anyway, a
// value in a wrong form, or a number whose 10-digit form names another person
// this year, fails the guard.

import { identityKind, isAlwaysAllowedDomain, isOrganisationNumber, valuesIn, type Kind, type Value } from "./values.ts";

/** Where the list sits, from the root of the repository. */
export const TEST_VALUES_FILE = "scripts/fixtures/test-values.txt";

export interface TestValues {
  /** The 12 digits of each listed identity or coordination number. */
  readonly identities: ReadonlySet<string>;
  /** Their last 10 digits: the form without the century. */
  readonly identityTails: ReadonlySet<string>;
  /** The 10 digits of each listed organisation number. */
  readonly organisations: ReadonlySet<string>;
  /** Each listed address, in lower case. */
  readonly emails: ReadonlySet<string>;
}

export interface ParsedTestValues {
  readonly values: TestValues;
  /** What is wrong with the list, by line. Never the value itself. */
  readonly problems: readonly string[];
}

const KINDS: readonly Kind[] = ["personal-identity-number", "coordination-number", "organisation-number", "email"];

const IDENTITY_FORM = /^(\d{8})-(\d{4})$/;
const ORGANISATION_FORM = /^\d{6}-\d{4}$/;

/**
 * True when a person born in the year `born` writes their number in 10
 * digits with "-" in the year `year`. From the year a person turns 100, the
 * "-" becomes a "+". So 10 digits with "-" name a person born in the last 100
 * years, and never one born later.
 */
function writesDashIn(born: number, year: number): boolean {
  return born > year - 100 && born <= year;
}

/** Why an entry of this kind and value does not belong on the list in this year, or undefined when it does. */
function entryProblem(kind: Kind, value: string, year: number): string | undefined {
  switch (kind) {
    case "personal-identity-number":
    case "coordination-number": {
      const form = IDENTITY_FORM.exec(value);
      if (form === null) {
        return "is not in the form YYYYMMDD-NNNN";
      }
      const datePart = form[1] ?? "";
      if (identityKind(datePart, form[2] ?? "") !== kind) {
        return `is not a ${kind === "coordination-number" ? "coordination" : "personal identity"} number with a valid date and check digit, so the guard lets it through without an entry`;
      }
      return writesDashIn(Number(datePart.slice(0, 4)), year)
        ? undefined
        : 'is for a person who is 100 or older this year, or born after this year. In 10 digits with "-", its digits name another person, so it cannot be on the list';
    }
    case "organisation-number":
      if (!ORGANISATION_FORM.test(value)) {
        return "is not in the form NNNNNN-NNNN";
      }
      return isOrganisationNumber(value.replace("-", ""))
        ? undefined
        : "is not an organisation number with a valid group digit and check digit, so the guard lets it through without an entry";
    case "email": {
      const found = valuesIn(value);
      if (value !== value.toLowerCase() || found.length !== 1 || found[0]?.key !== value) {
        if (isAlwaysAllowedDomain(value.slice(value.lastIndexOf("@") + 1))) {
          return "is at a domain the guard always lets through, so it needs no entry";
        }
        return "is not one e-mail address in lower case";
      }
      return undefined;
    }
  }
}

/** The key that a listed value is matched on. */
function keyOf(kind: Kind, value: string): string {
  return kind === "email" ? value : value.replace("-", "");
}

/**
 * Reads the list: one entry per line, "<kind> <value>". Empty lines and lines
 * that start with # are skipped. `file` names the list in the problems.
 * `year` is the current year, which says what each listed identity number
 * looks like in 10 digits.
 */
export function parseTestValues(text: string, file = TEST_VALUES_FILE, year = new Date().getFullYear()): ParsedTestValues {
  const identities = new Set<string>();
  const identityTails = new Set<string>();
  const organisations = new Set<string>();
  const emails = new Set<string>();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const place = `${file}:${String(index + 1)}`;
    const [kindText = "", value = "", ...rest] = line.split(/\s+/);
    const kind = KINDS.find((known) => known === kindText);
    if (kind === undefined || rest.length > 0 || value === "") {
      problems.push(`${place} is not "<kind> <value>", where the kind is one of ${KINDS.join(", ")}.`);
      continue;
    }
    const problem = entryProblem(kind, value, year);
    if (problem !== undefined) {
      problems.push(`${place}: the value ${problem}.`);
      continue;
    }
    const key = keyOf(kind, value);
    if (seen.has(key)) {
      problems.push(`${place}: the value is on the list already.`);
      continue;
    }
    seen.add(key);
    if (kind === "email") {
      emails.add(key);
    } else if (kind === "organisation-number") {
      organisations.add(key);
    } else {
      identities.add(key);
      identityTails.add(key.slice(2));
    }
  }
  return { values: { identities, identityTails, organisations, emails }, problems };
}

/**
 * True when a value found in a file is one of the listed test values. A
 * 10-digit identity number with "+" keeps the "+" in its key, so it never
 * matches a listed number: it names the person a century earlier. The list
 * holds no one who is 100 or older this year, so a listed number in 10 digits
 * with "-" names the listed person.
 */
export function isListed(value: Value, list: TestValues): boolean {
  switch (value.kind) {
    case "personal-identity-number":
    case "coordination-number":
      return value.key.length === 12 ? list.identities.has(value.key) : list.identityTails.has(value.key);
    case "organisation-number":
      return list.organisations.has(value.key);
    case "email":
      return list.emails.has(value.key);
  }
}
