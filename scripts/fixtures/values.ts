// SPDX-License-Identifier: AGPL-3.0-only

// Finds the values that look like real personal data in a text: a Swedish
// personal identity number (personnummer), a coordination number
// (samordningsnummer), an organisation number, each also inside a VAT number,
// and an e-mail address (docs/plan.md, step 1). A number counts only when its date and its check
// digit are valid, so a run of digits in a hash or a version seldom does. A
// date with four digits after it, such as a time, always has a valid date, so
// it counts about one time in ten. Nothing here prints what it finds.

export type Kind = "personal-identity-number" | "coordination-number" | "organisation-number" | "email";

export interface Value {
  readonly kind: Kind;
  /**
   * The value in the form the list of test values is matched on: the 10 or
   * 12 digits of a number, or an address in lower case. An identity number
   * in 10 digits with "+" keeps the "+": it names the person with the same
   * digits a century earlier, so it is never a listed number.
   */
  readonly key: string;
}

/**
 * A run of 10 or 12 digits, with "-" or "+" before the last four or without.
 * It stands alone: no letter or digit right before or after it. An identity
 * number written in 10 digits drops the century, and "+" there says the person
 * is 100 or older.
 */
const NUMBER = /(?<![0-9A-Za-z])(\d{6}|\d{8})([-+]?)(\d{4})(?![0-9A-Za-z])/g;

/** True when the character at this index is a digit. */
function isDigitAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}

/**
 * True when a match of NUMBER is a part of a decimal number: a digit and a
 * dot come right before it (0.9001012385), or a dot and a digit right after
 * it (9001012385.25). Only a run of digits without "-" or "+" can be one. With
 * "-" or "+" it is a number, also before ".2024" or after "1.".
 */
function isPartOfDecimal(text: string, start: number, end: number, separator: string): boolean {
  return (
    separator === "" &&
    ((text.charAt(start - 1) === "." && isDigitAt(text, start - 2)) || (text.charAt(end) === "." && isDigitAt(text, end + 1)))
  );
}

/**
 * What follows the first two groups of a UUID (8 hex digits, a dash and 4
 * more) in a line: the other three groups, of 4, 4 and 12 hex digits, each
 * after a dash. 8 digits, a dash and 4 digits with this after them start a
 * UUID, so they are not a number. Any other dash after a number, as in
 * <number>-anna.json or <number>-2024-11.pdf, leaves it a number.
 */
const UUID_TAIL = /^-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Za-z])/;

/**
 * A Swedish VAT number: "SE", the ten digits of an organisation number, and
 * "01". A sole trader's holds their personal identity number in 10 digits.
 * It stands alone, as a number does.
 */
const VAT_NUMBER = /(?<![0-9A-Za-z])SE(\d{10})01(?![0-9A-Za-z])/gi;

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
    return { kind, key: datePart + (datePart.length === 6 && separator === "+" ? "+" : "") + lastFour };
  }
  const ten = datePart + lastFour;
  const form = separator === "-" || (separator === "" && !ten.startsWith("1"));
  return datePart.length === 6 && form && isOrganisationNumber(ten) ? { kind: "organisation-number", key: ten } : undefined;
}

/**
 * The value that the ten digits of a VAT number make, if any: an identity
 * number, or an organisation number. Here the group digit 1 counts too,
 * since a VAT number is never a Unix time.
 */
function vatValue(ten: string): Value | undefined {
  const kind = identityKind(ten.slice(0, 6), ten.slice(6));
  if (kind !== undefined) {
    return { kind, key: ten };
  }
  return isOrganisationNumber(ten) ? { kind: "organisation-number", key: ten } : undefined;
}

/**
 * An address in a file's path: a local part, "@", and a domain of labels
 * joined by dots that ends in a top-level domain of letters. A version
 * (typescript@7.0.2), a commit (checkout@3d3c42e…) or a scope (@types/node)
 * has no such domain, so it never matches. The local part starts where its
 * characters start. What follows the domain does not matter: a file or
 * folder name may go on with a dash, a digit or a dot.
 */
const PATH_EMAIL = /(?<![\p{L}\p{N}._%+-])([\p{L}\p{N}._%+-]+)@((?:[\p{L}\p{N}-]+\.)+\p{L}{2,63})/gu;

/**
 * An address in a line: the same, when no letter or digit follows the
 * top-level domain, and no dot with a letter or digit after it. So a
 * pre-release version such as pkg@1.0.0-alpha.beta1 or pkg@1.0.0-alpha.beta.1
 * is not an address. A dash may follow, as in <address>-adressen.
 */
const EMAIL = new RegExp(String.raw`${PATH_EMAIL.source}(?![\p{L}\p{N}]|\.[\p{L}\p{N}])`, "gu");

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

/**
 * A domain at the start of a name: labels joined by dots that end in a
 * top-level domain of letters, with no letter right after it. In
 * <address>-photo or <address>2, the domain ends before the dash or the digit.
 */
const DOMAIN = /^(?:[\p{L}\p{N}-]+\.)+\p{L}{2,63}(?!\p{L})/u;

/**
 * What may stand between a URL's scheme and an address that is the user part
 * of the URL: nothing (https://user@example.com), or a user name and a colon
 * before a password (https://user:token@example.com). A dot, a ";" or a "|"
 * there says the text is not one URL, as in a CSV row
 * (https://example.com;<address>).
 */
const USER_BEFORE_PASSWORD = /^(?:[\p{L}\p{N}_~%+-]*:)?$/u;

/** A path after an address and a colon, as in a git remote (git@example.com:owner/repo). */
const REMOTE_PATH = /^:[\w.~%+-]*\//u;

/** The rest of a URL's user and host part after a match: up to a path, a query, a fragment or the end of the URL. */
const REST_OF_HOST = /^[^/?#\s"'`<>]*/u;

/** True when an address lies in a domain that is always allowed. */
export function isAlwaysAllowedDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return RESERVED_DOMAIN.test(lower) || lower === GITHUB_NOREPLY;
}

/** A name with the file extensions taken off its end: logo@2x.png.map becomes logo@2x. */
function withoutExtensions(name: string): string {
  let rest = name;
  let dot = rest.lastIndexOf(".");
  while (dot !== -1 && FILE_EXTENSIONS.has(rest.slice(dot + 1).toLowerCase())) {
    rest = rest.slice(0, dot);
    dot = rest.lastIndexOf(".");
  }
  return rest;
}

/**
 * The domain that a match stands for once its file extensions are taken off
 * its end, or undefined when no domain is left. logo@2x.png is a file name:
 * without .png, 2x is no domain. An address used as a file name, such as
 * <address>.json, <address>-photo.png or <address>2.png, keeps its domain.
 */
function addressDomain(domain: string): string | undefined {
  return DOMAIN.exec(withoutExtensions(domain))?.[0];
}

/**
 * True when what looks like an address in a line is part of something else:
 * the user part of a URL (https://user@example.com), or a host and path in a
 * git remote (git@example.com:owner/repo). A local part that holds "%40" is an
 * address in percent-encoding, and a second "@" after the match makes the
 * match part of a URL's user name, so neither is excused.
 */
function isPartOfSomethingElse(line: string, start: number, end: number, local: string): boolean {
  if (local.includes("%40")) {
    return false;
  }
  const after = line.slice(end);
  if (REMOTE_PATH.test(after)) {
    return true;
  }
  const before = line.slice(0, start);
  const scheme = before.lastIndexOf("://");
  if (scheme === -1 || REST_OF_HOST.exec(after)?.[0].includes("@") === true) {
    return false;
  }
  return USER_BEFORE_PASSWORD.test(before.slice(scheme + 3));
}

/**
 * Every value in a text, in the order found: numbers, then VAT numbers, then
 * addresses. In a line, a match that is part of something else is not a
 * value: the user part of a URL, a git remote, the start of a UUID, or a part
 * of a decimal number. A part of a path is read strictly, without those
 * exceptions: a file or folder name is none of them.
 */
function find(text: string, strict: boolean): Value[] {
  const found: Value[] = [];
  if (/\d{4}/.test(text)) {
    for (const match of text.matchAll(NUMBER)) {
      const [whole, datePart = "", separator = "", lastFour = ""] = match;
      const end = match.index + whole.length;
      const uuid = datePart.length === 8 && separator === "-" && UUID_TAIL.test(text.slice(end));
      const excused = uuid || isPartOfDecimal(text, match.index, end, separator);
      const value = strict || !excused ? numberValue(datePart, separator, lastFour) : undefined;
      if (value !== undefined) {
        found.push(value);
      }
    }
    for (const match of text.matchAll(VAT_NUMBER)) {
      const value = vatValue(match[1] ?? "");
      if (value !== undefined) {
        found.push(value);
      }
    }
  }
  if (text.includes("@")) {
    for (const match of text.matchAll(strict ? PATH_EMAIL : EMAIL)) {
      const [whole, local = "", matched = ""] = match;
      const domain = addressDomain(matched);
      if (
        domain !== undefined &&
        !isAlwaysAllowedDomain(domain) &&
        (strict || !isPartOfSomethingElse(text, match.index, match.index + whole.length, local))
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

/** An "@" and the run of name characters after it, as far as a domain could reach. */
const AFTER_AT = /@([\p{L}\p{N}.-]+)/gu;

/**
 * True when a text holds anything shaped like a value, whether it counts or
 * not. The test is looser than the rules, on purpose, so it also sees every
 * value they find, an allowed one too: a run of 10 or more digits, with or
 * without a "-" or "+" before the last four, or an "@" with a dot and two
 * letters after it once file extensions are taken off. It needs no local
 * part, and it does not care what follows the domain. logo@2x.png has no
 * such shape. The report names a file by its alias when its path holds such
 * a shape, so that no gap in the rules can print a value that is in a path.
 */
export function hasValueShape(text: string): boolean {
  return (
    /\d{6}[-+]?\d{4}/.test(text) ||
    [...text.matchAll(AFTER_AT)].some((match) => /\.\p{L}{2}/u.test(withoutExtensions(match[1] ?? "")))
  );
}
