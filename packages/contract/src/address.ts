// SPDX-License-Identifier: AGPL-3.0-only

// An e-mail address as the API takes it: one mailbox, an RFC 5321 Mailbox
// with RFC 6531's UTF-8. The local part is a dot-atom: atoms of RFC 5322's
// atext and of characters outside ASCII, with one dot between two atoms,
// and no slash at its end, which no mailbox has and a log reads as a
// package's path (/@scope). The domain is labels of letters, digits and
// hyphens, or characters outside ASCII, with one dot between two labels,
// and no hyphen at a label's start or end. So an address holds none of RFC
// 5322's specials, ( ) < > [ ] : ; @ \ , " beside its one @, no space, no
// control character and no control of the text's direction: no display
// name, comment, group or list of addresses, which a mail program would
// read in it. A quoted local part and an address literal are not taken. The
// local part holds at most 64 characters, the domain at most 255, and the
// address at most 254.
//
// The domain is written as a mail is sent to it (writtenAsMailed). A mail
// program maps a domain by IDNA's UTS 46 before it sends, as nodemailer, the
// browsers and the resolvers do: it drops some characters, such as a soft
// hyphen or a zero-width space, folds others, such as a fullwidth letter or
// a ligature, and reads U+3002 as a dot. The server stores, compares and
// shows the address as it is written, so a domain that the mapping changes
// would be one address in NortFox and another in the mail. So the mapping
// must give the domain's own labels back, in lower case; an A-label (xn--)
// is not taken either, since its U-label is the same domain, and neither is
// a domain that ends in a number, which the URL Standard reads as an IPv4
// address. So a mail goes to the one mailbox that the server stores and
// shows.

import { domainToASCII, domainToUnicode } from "node:url";
import { z } from "zod";
import { noNul, wellFormed } from "./text.ts";

/** RFC 5322's atext: the ASCII characters of an atom. */
const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~\\-";

/** RFC 5322's atext but the slash: the last character of a local part. */
const ATEXT_END = "A-Za-z0-9!#$%&'*+=?^_`{|}~\\-";

/**
 * A character outside ASCII that an address may hold: not a C1 control
 * character, a space or a separator (Unicode's Z, and U+FEFF), or a control
 * of the text's direction. Written with escapes only, and no property class,
 * so a client of any regex dialect reads the pattern in the API's
 * description and in the tools' schemas.
 */
const WIDE_SET = "\\x00-\\x9F\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069";

const WIDE = `[^${WIDE_SET}]`;

/**
 * A character outside ASCII that a domain may hold: WIDE, but not one that
 * IDNA's mapping reads as a dot (U+3002, U+FF0E, U+FF61), drops (the soft
 * hyphen, the Hangul fillers, the zero-width space, the word joiner and the
 * invisible operators), or folds as a fullwidth or a halfwidth form (U+FF00
 * to U+FFEF). The pattern refuses these where a client checks it;
 * writtenAsMailed refuses every other change that the mapping makes, such
 * as a variation selector that it drops, which the pattern leaves alone, as
 * a mark that joins the character before it.
 */
const DOMAIN_WIDE = `[^${WIDE_SET}\\u3002\\u00AD\\u115F\\u1160\\u200B\\u2060-\\u2064\\u3164\\uFF00-\\uFFEF]`;

/** A character of a local part's atom. */
const ATOM_CHARACTER = `(?:[${ATEXT}]|${WIDE})`;

/** The last character of a local part: not a slash. */
const ATOM_END = `(?:[${ATEXT_END}]|${WIDE})`;

/** A letter or a digit of a domain's label, or a character outside ASCII. */
const LABEL_END = `(?:[A-Za-z0-9]|${DOMAIN_WIDE})`;

/** A domain's label: no hyphen at its start or end. */
const LABEL = `${LABEL_END}(?:(?:[A-Za-z0-9-]|${DOMAIN_WIDE})*${LABEL_END})?`;

/** One mailbox: a dot-atom with no slash at its end, its one @, and a domain of labels. */
export const MAILBOX = new RegExp(`^(?=[^@]{1,64}@)(?:${ATOM_CHARACTER}+\\.)*${ATOM_CHARACTER}*${ATOM_END}@(?=[^@]{1,255}$)${LABEL}(?:\\.${LABEL})*$`, "u");

/** The longest address: RFC 5321's path of 256 octets, less its angle brackets. */
export const EMAIL_MAX = 254;

/**
 * Whether a mail is sent to `domain` as it is written: the mapping of IDNA's
 * UTS 46, node:url's domainToASCII, which nodemailer makes before it sends,
 * and back again gives the domain's own labels, in lower case; and its last
 * label is not a number. An A-label (xn--) maps back to its U-label, which
 * is not what is written, so it is refused too.
 */
export function writtenAsMailed(domain: string): boolean {
  const written = domain.toLowerCase().normalize("NFC");
  if (/(?:^|\.)[0-9]+$/.test(written)) {
    return false;
  }
  const ascii = domainToASCII(domain);
  return ascii !== "" && domainToUnicode(ascii) === written;
}

/** The check of an address's domain: written as it is mailed (writtenAsMailed). An address that is no mailbox has MAILBOX's problem alone. */
function mailedAsWritten(): z.core.$ZodCheck<string> {
  return z.refine((address: string) => !MAILBOX.test(address) || writtenAsMailed(address.slice(address.lastIndexOf("@") + 1)), {
    message: "does not have the format email: a mail would reach its domain under another name, so its domain must be written as it is mailed, in Unicode or in ASCII, and not end in a number.",
    params: { code: "bad-format", data: { format: "email" } },
  });
}

/**
 * An e-mail address that the server stores, looks up and may send mail to:
 * one mailbox (MAILBOX), mailed as it is written, at most 254 characters.
 * Its JSON Schema is RFC 6531's address, the format idn-email (JSON Schema
 * 2020-12's email is RFC 5321's, ASCII only), with MAILBOX as its pattern,
 * in the API's description and in the tools' schemas alike.
 */
export function emailAddress(): z.ZodEmail {
  return z.email({ pattern: MAILBOX }).max(EMAIL_MAX).check(noNul(), wellFormed(), mailedAsWritten()).meta({ format: "idn-email", pattern: MAILBOX.source });
}
