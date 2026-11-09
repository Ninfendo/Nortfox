// SPDX-License-Identifier: AGPL-3.0-only

// An e-mail address as the API takes it: one mailbox, an RFC 5321 Mailbox
// with RFC 6531's UTF-8. The local part is a dot-atom: atoms of RFC 5322's
// atext and of characters outside ASCII, with one dot between two atoms. The
// domain is labels of letters, digits and hyphens, or characters outside
// ASCII, with one dot between two labels, and no hyphen at a label's start
// or end. So an address holds none of RFC 5322's specials, ( ) < > [ ] : ; @
// \ , " beside its one @, no space, no control character and no control of
// the text's direction: no display name, comment, group or list of
// addresses, which a mail program would read in it, so a mail goes to the
// one mailbox that the server stores and shows. A quoted local part and an
// address literal are not taken. The local part holds at most 64
// characters, the domain at most 255, and the address at most 254.

import { z } from "zod";
import { noNul, wellFormed } from "./text.ts";

/** RFC 5322's atext: the ASCII characters of an atom. */
const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~\\-";

/**
 * A character outside ASCII that an address may hold: not a C1 control
 * character, a space or a separator (Unicode's Z, and U+FEFF), or a control
 * of the text's direction. Written with escapes only, and no property class,
 * so a client of any regex dialect reads the pattern in the API's
 * description and in the tools' schemas.
 */
const WIDE = "[^\\x00-\\x9F\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]";

/** A character of a local part's atom. */
const ATOM_CHARACTER = `(?:[${ATEXT}]|${WIDE})`;

/** A letter or a digit of a domain's label, or a character outside ASCII. */
const LABEL_END = `(?:[A-Za-z0-9]|${WIDE})`;

/** A domain's label: no hyphen at its start or end. */
const LABEL = `${LABEL_END}(?:(?:[A-Za-z0-9-]|${WIDE})*${LABEL_END})?`;

/** One mailbox: a dot-atom, its one @, and a domain of labels. */
export const MAILBOX = new RegExp(`^(?=[^@]{1,64}@)${ATOM_CHARACTER}+(?:\\.${ATOM_CHARACTER}+)*@(?=[^@]{1,255}$)${LABEL}(?:\\.${LABEL})*$`, "u");

/** The longest address: RFC 5321's path of 256 octets, less its angle brackets. */
export const EMAIL_MAX = 254;

/** An e-mail address that the server stores, looks up and may send mail to: one mailbox (MAILBOX), at most 254 characters. */
export function emailAddress(): z.ZodEmail {
  return z.email({ pattern: MAILBOX }).max(EMAIL_MAX).check(noNul(), wellFormed());
}
