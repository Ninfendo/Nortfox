// SPDX-License-Identifier: AGPL-3.0-only

// A text that the server stores or looks up in PostgreSQL. PostgreSQL's text
// holds no U+0000, and a lone surrogate is not a character: the driver would
// store it as U+FFFD, a text that nobody sent, and a jsonb value refuses it.
// So such a text refuses both before the server sees it: a field problem,
// invalid-value, at its pointer, never a server failure. Every input field
// that reaches the database as text takes both checks.

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
