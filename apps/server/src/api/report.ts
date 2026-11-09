// SPDX-License-Identifier: AGPL-3.0-only

// What the server logs of an error that it did not expect: the default
// reporter of createApp, and of the database's connection errors. An error
// can carry what must never reach a log. A database error's detail can hold
// the failing row or the key that was taken, such as a personnummer, its
// where and its internal query can hold values, and a message can hold a
// token. So the report holds only:
//
// - the error's class and its message,
// - its code (a database error's SQLSTATE, a system error's code), and the
//   constraint, schema, table and column that a database error names,
// - the frames of its stack,
// - and its cause, the same way, five deep at most.
//
// It never holds a detail, a where, a hint, an internal query or a
// statement's parameters. It takes every token (nf?_...), every
// personnummer form (8 or 6 digits, then 4, with or without a hyphen or a
// plus) and every e-mail address that the API takes, in any script, out of
// what it keeps. A thrown value that is not an Error is reported by its type
// only.

/** NortFox's tokens, and any cut piece of one. */
const TOKEN = /nf[a-z]_[A-Za-z0-9_-]*/g;

/** A personnummer, a coordination number or an organisation number, in any of its forms, not inside a longer run of digits. */
const IDENTITY_NUMBER = /(?<![0-9])(?:[0-9]{8}|[0-9]{6})[-+]?[0-9]{4}(?![0-9])/g;

/**
 * An e-mail address, as every address that the API takes is one (packages/contract/src/address.ts): a local part,
 * @, and a domain of one label or more. The local part holds letters, marks and digits of any script (RFC 6531),
 * dots, and every symbol that RFC 5322 lets an atom hold, and does not end in a slash, as no address the API takes
 * does: so a package's path, /@scope, stays as it is. The domain's labels hold letters, marks, digits and hyphens,
 * so an internationalised domain is one too, and a domain of one label, such as intranet, or with a last label of
 * one letter is one too. A domain of digits and dots alone, such as a package's version (pkg@2.1.5), is not one.
 */
const EMAIL = /[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]*[\p{L}\p{M}\p{N}.!#$%&'*+=?^_`{|}~-]@(?=[\p{L}\p{M}\p{N}.-]*?(?![0-9])[\p{L}\p{M}\p{N}-])[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)*/gu;

/** The text with every token, personnummer form and e-mail address taken out. */
export function scrub(text: string): string {
  return text.replace(TOKEN, "[token]").replace(IDENTITY_NUMBER, "[personnummer]").replace(EMAIL, "[e-mail]");
}

/** The fields of an error that the report names, when each is a plain text. */
const NAMED_FIELDS = ["code", "constraint", "schema", "table", "column"] as const;

/** A code as codes are written: a SQLSTATE, NF021, ECONNREFUSED, ERR_INVALID_ARG_TYPE. */
const CODE = /^[A-Z0-9_]{1,64}$/;

/** A name of the database: a constraint, a schema, a table or a column. */
const DATABASE_NAME = /^[a-z_][a-z0-9_$]{0,62}$/;

/** The line of facts: the code and the database names that the error holds. */
function factsOf(error: Error): string | undefined {
  const fields = error as unknown as Readonly<Record<string, unknown>>;
  const facts = NAMED_FIELDS.flatMap((field) => {
    const value = fields[field];
    const form = field === "code" ? CODE : DATABASE_NAME;
    return typeof value === "string" && form.test(value) ? [`${field} ${value}`] : [];
  });
  return facts.length === 0 ? undefined : `  ${facts.join(", ")}`;
}

/** The deepest cause the report follows. */
const CAUSE_DEPTH = 5;

function reportOf(error: unknown, depth: number): string {
  if (!(error instanceof Error)) {
    return `a thrown ${error === null ? "null" : typeof error}, which is not an Error`;
  }
  // The class, since a database error's name is only "error".
  const lines = [`${error.constructor.name}: ${scrub(error.message)}`];
  const facts = factsOf(error);
  if (facts !== undefined) {
    lines.push(facts);
  }
  // The stack starts with the class and the message, which the first line holds.
  lines.push(...(error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line)).map(scrub));
  if (error.cause !== undefined && depth < CAUSE_DEPTH) {
    lines.push(`Caused by: ${reportOf(error.cause, depth + 1)}`);
  }
  return lines.join("\n");
}

/** What the server logs of `error`. */
export function errorReport(error: unknown): string {
  return reportOf(error, 0);
}

/** The default reporter: one console.error call with the safe report. */
export function reportSafely(error: unknown): void {
  console.error(`The server failed: ${errorReport(error)}`);
}
