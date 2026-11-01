// SPDX-License-Identifier: AGPL-3.0-only

// Finds the values that look like real personal data in a text: a Swedish
// personal identity number (personnummer), a coordination number
// (samordningsnummer), an organisation number and an e-mail address
// (docs/plan.md, step 1). A number counts only when its date and its check
// digit are valid, so a random run of digits, such as a hash, a version or a
// timestamp, almost never does. Nothing here prints what it finds.

export type Kind = "personal-identity-number" | "coordination-number" | "organisation-number" | "email";

export interface Value {
  readonly kind: Kind;
  /**
   * The value in the form the list of test values is matched on: the 10 or
   * 12 digits of a number, or an address in lower case.
   */
  readonly key: string;
}

/**
 * A run of 10 or 12 digits, with "-" or "+" before the last four or without.
 * It stands alone: no letter or digit right before or after it, and it is not
 * part of a decimal number (1.8112189876). An identity number written in 10
 * digits drops the century, and "+" there says the person is 100 or older.
 */
const NUMBER = /(?<![0-9A-Za-z])(?<!\d\.)(\d{6}|\d{8})([-+]?)(\d{4})(?![0-9A-Za-z]|\.\d)/g;

/**
 * What follows the first two groups of a UUID (8 hex digits, a dash and 4
 * more) in a line: a dash, 4 hex digits and a dash. 8 digits, a dash and 4
 * digits with this after them start a UUID, so they are not a number. Any
 * other dash after a number, as in <number>-anna.json, leaves it a number.
 */
const UUID_TAIL = /^-[0-9A-Fa-f]{4}-/;

/** The centuries of a 12-digit identity number: people born from 1800 to 2099. */
const CENTURIES = new Set(["18", "19", "20"]);

/** The group digit that starts an organisation number. 0 and 4 are not given out. */
const GROUP_DIGITS = new Set(["1", "2", "3", "5", "6", "7", "8", "9"]);

/** The Luhn check (modulus 10) that the last digit of each number satisfies. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits.charCodeAt(index) - 48;
    if ((digits.length - index) % 2 === 0) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * The days in a month. Without the century (a 10-digit number), February
 * has 29 days in every year that some century makes a leap year: 00 is 2000.
 */
function daysIn(month: number, twoDigitYear: number, fullYear: number | undefined): number {
  if (month !== 2) {
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }
  const leap =
    fullYear === undefined
      ? twoDigitYear % 4 === 0
      : (fullYear % 4 === 0 && fullYear % 100 !== 0) || fullYear % 400 === 0;
  return leap ? 29 : 28;
}

/**
 * The kind of identity number that a date part (YYMMDD, or YYYYMMDD with the
 * century) and the last four digits make, or undefined when they make none.
 * A coordination number adds 60 to the day.
 */
export function identityKind(datePart: string, lastFour: string): Kind | undefined {
  const century = datePart.length === 8 ? datePart.slice(0, 2) : undefined;
  if (century !== undefined && !CENTURIES.has(century)) {
    return undefined;
  }
  const date = datePart.slice(-6);
  const year = Number(date.slice(0, 2));
  const month = Number(date.slice(2, 4));
  const coded = Number(date.slice(4, 6));
  const coordination = coded > 60;
  const day = coordination ? coded - 60 : coded;
  const fullYear = century === undefined ? undefined : Number(century) * 100 + year;
  if (month < 1 || month > 12 || day < 1 || day > daysIn(month, year, fullYear)) {
    return undefined;
  }
  if (!luhnValid(date + lastFour)) {
    return undefined;
  }
  return coordination ? "coordination-number" : "personal-identity-number";
}

/**
 * True for the ten digits of a real-looking organisation number: a group
 * digit that is given out, a third and fourth digit of 20 or more (where an
 * identity number has its month, so the two never meet), and a valid check
 * digit.
 */
export function isOrganisationNumber(ten: string): boolean {
  return GROUP_DIGITS.has(ten.charAt(0)) && Number(ten.charAt(2)) >= 2 && luhnValid(ten);
}

/**
 * The value that one run of digits makes, if any. An organisation number
 * counts as NNNNNN-NNNN, as its ten digits without the dash, and with 16 in
 * front, as in its 12-digit form, with the dash or without. Ten digits
 * without the dash and with the group digit 1 are not read as one: a Unix
 * time in seconds from 2001 to 2033 has that form, and passes the group and
 * Luhn rules about one time in ten. A Unix time that starts with 2 or more
 * lies after 2033.
 */
function numberValue(datePart: string, separator: string, lastFour: string): Value | undefined {
  if (datePart.length === 8 && datePart.startsWith("16")) {
    const ten = datePart.slice(2) + lastFour;
    return separator !== "+" && isOrganisationNumber(ten) ? { kind: "organisation-number", key: ten } : undefined;
  }
  const kind = identityKind(datePart, lastFour);
  if (kind !== undefined) {
    return { kind, key: datePart + lastFour };
  }
  const ten = datePart + lastFour;
  const form = separator === "-" || (separator === "" && !ten.startsWith("1"));
  return datePart.length === 6 && form && isOrganisationNumber(ten) ? { kind: "organisation-number", key: ten } : undefined;
}

/**
 * An e-mail address: a local part, "@", and a domain of labels joined by dots
 * that ends in a top-level domain of letters. A version (typescript@7.0.2),
 * a commit (checkout@3d3c42e…) or a scope (@types/node) has no such domain,
 * so it never matches. The local part starts where its characters start.
 */
const EMAIL = /(?<![\p{L}\p{N}._%+-])([\p{L}\p{N}._%+-]+)@((?:[\p{L}\p{N}-]+\.)+\p{L}{2,63})(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])/gu;

/**
 * The domains of RFC 2606 and RFC 6761, which no one can register, so an
 * address there is never a real person's: example.com, example.net,
 * example.org and every name under .example, .test, .invalid and .localhost.
 */
const RESERVED_DOMAIN = /(?:^|\.)(?:example|test|invalid|localhost|example\.com|example\.net|example\.org)$/;

/** GitHub's noreply addresses, which stand in for an account's own address. */
const GITHUB_NOREPLY = "users.noreply.github.com";

/**
 * File extensions that are not top-level domains. A file name such as
 * logo@2x.png has the shape of an address, so the guard takes these off the
 * end of a domain before it reads the domain. Extensions that are also
 * top-level domains, such as .md and .zip, are left out on purpose.
 */
const FILE_EXTENSIONS = new Set(
  (
    "avif bmp cjs css csv cts gif htm html ico jpeg jpg js json jsx lock map mjs mts otf pdf png " +
    "scss svg ts tsx ttf txt wasm webp woff woff2 xml yaml yml"
  ).split(" "),
);

/** A domain: labels joined by dots that end in a top-level domain of letters. */
const DOMAIN = /^(?:[\p{L}\p{N}-]+\.)+\p{L}{2,63}$/u;

/** The characters that end the word an address stands in, looking back from it. */
const WORD_START = /[^\s"'`<>()[\]{},]*$/u;

/**
 * What may stand between a URL's scheme and an address that is the user part
 * of the URL: nothing (https://user@host.se), or a user name and a colon
 * before a password (https://user:token@host.se). A dot, a ";" or a "|"
 * there says the text is not one URL, as in a CSV row
 * (https://zarquon.se;<address>).
 */
const USER_BEFORE_PASSWORD = /^(?:[\p{L}\p{N}_~%+-]*:)?$/u;

/** A path after an address and a colon, as in a git remote (git@host.se:owner/repo). */
const REMOTE_PATH = /^:[\w.~%+-]*\//u;

/** True when an address lies in a domain that is always allowed. */
export function isAlwaysAllowedDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return RESERVED_DOMAIN.test(lower) || lower === GITHUB_NOREPLY;
}

/**
 * The domain that a match stands for once its file extensions are taken off
 * its end, or undefined when no domain is left. logo@2x.png is a file name:
 * without .png, 2x is no domain. An address used as a file name, such as
 * <address>.json, keeps its domain without .json, so it is an address.
 */
function addressDomain(domain: string): string | undefined {
  let rest = domain;
  let dot = rest.lastIndexOf(".");
  while (dot !== -1 && FILE_EXTENSIONS.has(rest.slice(dot + 1).toLowerCase())) {
    rest = rest.slice(0, dot);
    dot = rest.lastIndexOf(".");
  }
  return DOMAIN.test(rest) ? rest : undefined;
}

/**
 * True when what looks like an address in a line is part of something else:
 * the user part of a URL (https://user@host.se), a host and path in a git
 * remote (git@host.se:owner/repo), or a part of a URL's path
 * (https://cdn.host.se/npm/pkg@next.dev/file).
 */
function isPartOfSomethingElse(line: string, start: number, end: number): boolean {
  const after = line.slice(end);
  if (REMOTE_PATH.test(after)) {
    return true;
  }
  const word = WORD_START.exec(line.slice(0, start))?.[0] ?? "";
  const scheme = word.lastIndexOf("://");
  if (scheme === -1) {
    return false;
  }
  const url = word.slice(scheme + 3);
  return USER_BEFORE_PASSWORD.test(url) || (after.startsWith("/") && url.includes("/") && !/[?#]/.test(url));
}

/**
 * Every value in a text, in the order found. In a line, a match that is part
 * of something else is not a value: the user part of a URL, a git remote, a
 * part of a URL's path, or the start of a UUID. A part of a path is read
 * strictly, without those exceptions: a file or folder name is none of them.
 */
function find(text: string, strict: boolean): Value[] {
  const found: Value[] = [];
  if (/\d{4}/.test(text)) {
    for (const match of text.matchAll(NUMBER)) {
      const [whole, datePart = "", separator = "", lastFour = ""] = match;
      const uuid = datePart.length === 8 && separator === "-" && UUID_TAIL.test(text.slice(match.index + whole.length));
      const value = strict || !uuid ? numberValue(datePart, separator, lastFour) : undefined;
      if (value !== undefined) {
        found.push(value);
      }
    }
  }
  if (text.includes("@")) {
    for (const match of text.matchAll(EMAIL)) {
      const [whole, local = "", matched = ""] = match;
      const domain = addressDomain(matched);
      if (
        domain !== undefined &&
        !isAlwaysAllowedDomain(domain) &&
        (strict || !isPartOfSomethingElse(text, match.index, match.index + whole.length))
      ) {
        found.push({ kind: "email", key: `${local}@${domain}`.toLowerCase() });
      }
    }
  }
  return found;
}

/** Every value in one line of text that looks real, in the order found. Listed test values are included. */
export function valuesIn(line: string): Value[] {
  return find(line, false);
}

/** A file extension at the end of a file or folder name. */
const EXTENSION = /\.[0-9A-Za-z]+$/;

/**
 * Every value in a file's path that looks real. A path is read more strictly
 * than a line: each part between "/" on its own, and again without its file
 * extension, and none of the exceptions of a line apply. So an address or a
 * number used as a file or folder name is found, also with an extension or
 * with a dash and a word after it. Each value is given once.
 */
export function valuesInPath(path: string): Value[] {
  const found = new Map<string, Value>();
  for (const part of path.split("/")) {
    const extension = EXTENSION.exec(part)?.[0].toLowerCase() ?? "";
    const bare = extension === "" ? [] : find(part.slice(0, -extension.length), true);
    // The same address with the extension read as part of its domain is not a second value.
    const doubled = new Set(bare.map((value) => `${value.kind} ${value.key}${extension}`));
    const whole = find(part, true).filter((value) => !doubled.has(`${value.kind} ${value.key}`));
    for (const value of [...bare, ...whole]) {
      found.set(`${value.kind} ${value.key}`, value);
    }
  }
  return [...found.values()];
}

/**
 * True when a text holds anything shaped like a value, whether it counts or
 * not: a run of 10 or more digits, with or without a "-" or "+" before the
 * last four, or an address with a domain, also one that is allowed. The report names a file by its alias when its path holds such
 * a shape, so that no gap in the rules can print a value that is in a path.
 */
export function hasValueShape(text: string): boolean {
  return /\d{6}[-+]?\d{4}/.test(text) || [...text.matchAll(EMAIL)].some((match) => addressDomain(match[2] ?? "") !== undefined);
}
