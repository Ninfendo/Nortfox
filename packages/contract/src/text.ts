// SPDX-License-Identifier: AGPL-3.0-only

// A text that the server stores or looks up in PostgreSQL. PostgreSQL's text
// holds no U+0000, and a lone surrogate is not a character: the driver would
// store it as U+FFFD, a text that nobody sent, and a jsonb value refuses it.
// So such a text refuses both before the server sees it: a field problem,
// invalid-value, at its pointer, never a server failure. Every input field
// that reaches the database as text takes both checks. A person's or a
// company's name also takes singleLine, and an e-mail address takes
// emailAddress (address.ts).

import { z } from "zod";

/** The check of a text that the server stores or looks up: it holds no U+0000. */
export function noNul(): z.core.$ZodCheck<string> {
  return z.refine((text: string) => !text.includes("\u0000"), {
    message: "holds the character U+0000, which no text may hold.",
    params: { code: "invalid-value", data: {} },
  });
}

/** The check of a text that the server stores or looks up: it holds no lone surrogate, so each of its code units is part of a character. */
export function wellFormed(): z.core.$ZodCheck<string> {
  return z.refine((text: string) => text.isWellFormed(), {
    message: "holds a lone surrogate, which is not a character.",
    params: { code: "invalid-value", data: {} },
  });
}

/**
 * The characters that a name never holds: a control character (C0 and C1,
 * with the tab, the line feed, the carriage return and the next line), the
 * line and the paragraph separator, and the controls of the text's
 * direction. A name stands on one line wherever it is shown, also in
 * a mail that the server sends, so none of them can add a line to the mail
 * or turn its text around. The database holds the same of a name
 * (db/migrations/0009_roles_programs.sql).
 */
export const NOT_IN_A_NAME = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** U+0000, which noNul refuses, so a name that holds it gets one problem. */
const NUL = String.fromCodePoint(0);

/** The check of a person's or a company's name: one line, with no control character (NOT_IN_A_NAME) but U+0000, which is noNul's. */
export function singleLine(): z.core.$ZodCheck<string> {
  return z.refine((text: string) => !NOT_IN_A_NAME.test(text.replaceAll(NUL, "")), {
    message: "holds a line break or another control character, which a name never holds.",
    params: { code: "invalid-value", data: {} },
  });
}
