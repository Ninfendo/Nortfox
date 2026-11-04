// SPDX-License-Identifier: AGPL-3.0-only

// The rule of a new password (issue 12). A new password is 12 to 1024
// characters, counted in code points after NFC normalisation. So é written
// as one code point or as e and a combining accent is the same password, and
// an emoji counts once. The upper bound is NortFox's own: no request makes
// the server hash a megabyte.
//
// Some strings are never normalised, since NFC could hold the event loop on
// them, and no password is one: a string of more than 6144 UTF-16 units,
// which is longer than 1024 characters in any form; one with a lone
// surrogate, which UTF-8 would write as U+FFFD, so two such passwords would
// be one; and one with more than 30 combining marks in a row (the
// stream-safe limit of UAX #15), on which NFC takes time that grows with the
// square of the run.
//
// An operation's body takes the rule as a check of its own, newPassword(),
// so a bad password is a field problem beside every other one of the
// request. The refusal never holds the password. The server's password
// wrapper checks the same rule again before it hashes.

import { z } from "zod";
import type { FieldIssue, JsonValue } from "./problem.ts";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

/**
 * The most UTF-16 units that a password of 1024 characters can have: NFC
 * makes at most six units one character, such as U+16126 written as its
 * three vowel signs (a test walks every code point). A longer string is
 * longer than any password, and is never normalised.
 */
export const PASSWORD_MAX_UNITS = 6 * PASSWORD_MAX_LENGTH;

/**
 * The most combining marks in a row that a password may hold. Every
 * character whose decomposition starts with a mark that NFC reorders is a
 * mark (a test walks every code point), so this bounds each run that NFC
 * sorts.
 */
export const PASSWORD_MAX_MARK_RUN = 30;

const MARK_RUN = new RegExp(`\\p{M}{${String(PASSWORD_MAX_MARK_RUN + 1)}}`, "u");

/** Why a string can never be a password, seen before it is normalised; undefined when it may be one. */
function unfitness(password: string): "too-long" | "lone-surrogate" | "mark-run" | undefined {
  if (password.length > PASSWORD_MAX_UNITS) {
    return "too-long";
  }
  if (!password.isWellFormed()) {
    return "lone-surrogate";
  }
  return MARK_RUN.test(password) ? "mark-run" : undefined;
}

/** A password's length: its code points after NFC normalisation, or Infinity for a string that is never normalised, which no password is. */
export function passwordLength(password: string): number {
  // A string's iterator gives its code points, which is what the rule counts.
  return unfitness(password) === undefined ? Array.from(password.normalize("NFC")).length : Number.POSITIVE_INFINITY;
}

/** What is wrong with a new password: a field problem's code, its detail after "The field /x ", and its facts. */
interface PasswordProblem {
  readonly code: string;
  readonly rest: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

const TOO_LONG: PasswordProblem = { code: "too-long", rest: `must be at most ${String(PASSWORD_MAX_LENGTH)} characters long.`, data: { maximum: PASSWORD_MAX_LENGTH } };

function passwordProblem(password: string): PasswordProblem | undefined {
  switch (unfitness(password)) {
    case "too-long":
      return TOO_LONG;
    case "lone-surrogate":
      return { code: "invalid-value", rest: "holds a lone surrogate, which is not a character.", data: {} };
    case "mark-run":
      return { code: "invalid-value", rest: `holds more than ${String(PASSWORD_MAX_MARK_RUN)} combining marks in a row.`, data: {} };
    case undefined:
      break;
  }
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    return { code: "too-short", rest: `must be at least ${String(PASSWORD_MIN_LENGTH)} characters long.`, data: { minimum: PASSWORD_MIN_LENGTH } };
  }
  return length > PASSWORD_MAX_LENGTH ? TOO_LONG : undefined;
}

/** What is wrong with a new password, as a field problem at `pointer`; undefined when nothing is. It never holds the password. */
export function newPasswordIssue(password: string, pointer: string): FieldIssue | undefined {
  const problem = passwordProblem(password);
  return problem === undefined ? undefined : { code: problem.code, detail: `The field ${pointer} ${problem.rest}`, pointer, data: problem.data };
}

/**
 * The check of a new password in an operation's body: the rule's field
 * problem at the field's pointer. Its issue carries no input, so the refusal
 * never holds the password, also when the parse reports the input.
 */
export function newPassword(): z.core.$ZodCheck<string> {
  return z.check<string>((payload) => {
    const problem = passwordProblem(payload.value);
    if (problem !== undefined) {
      payload.issues.push({ code: "custom", message: problem.rest, params: { code: problem.code, data: problem.data }, input: undefined, path: [] });
    }
  });
}
