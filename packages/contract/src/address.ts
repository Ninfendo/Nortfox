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
// local part holds at most 64 characters, and the address at most 254.
//
// The server stores an invitation's and a new identity's address in NFC,
// which can be longer than the text sent, and can change a character: U+0958
// is two characters in NFC, and U+037E is a semicolon. So the form, the
// local part's 64 and the address's 254 hold for the NFC form too.
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
//
// The owner's two rules of 2026-11-09 come on top, where the issue says
// nothing. An address that can become an identity's (identityAddress for
// completeSetup, invitedAddress for inviteUser and the work e-mail, which a
// disconnect invites) holds no character whose case fold is not its lower
// case, in NFC (foldsAsLowerCase): ß, ẞ, ς, ſ, µ, the ligatures, the
// Cherokee letters and the others that Unicode's data gives. The identities'
// unique index and the sign-in fold an address with casefold(), which makes
// straße.example into strasse.example, while IDNA2008 and a mail program
// keep the two apart: such an address would share an identity's place with
// another mailbox. An address that NortFox sends mail to (invitedAddress)
// has a local part in ASCII (INVITED_PATTERN): a relay that does not offer
// SMTPUTF8 must not take another (RFC 6531), and nodemailer sends it anyway.
// Its domain may be internationalised: nodemailer sends it as its A-label.
// The company's own address (emailAddress) keeps neither rule: it is no
// identity's, and NortFox sends it no mail.
//
// The pattern (MAILBOX_PATTERN) is the server's check, and the API's
// description and the tools' schemas publish it. It holds only the tokens
// that every regex dialect reads, as JSON Schema asks (2020-12, section
// 6.4): classes, ranges, quantifiers, plain groups, alternation and the two
// anchors. A character up to U+00FF is the escape \xHH, and any other
// stands as itself, since no escape of it is read by ECMA-262, RE2 and
// Python alike. So the pattern has no lookahead, and the lengths are the
// checks' own.

import { domainToASCII, domainToUnicode } from "node:url";
import { z } from "zod";
import { noNul, wellFormed } from "./text.ts";

/** A character in the pattern: \xHH up to U+00FF, which every dialect reads, and any other as itself. */
function character(codePoint: number): string {
  return codePoint <= 0xff ? `\\x${codePoint.toString(16).toUpperCase().padStart(2, "0")}` : String.fromCodePoint(codePoint);
}

/** The characters from `from` to `to` in a class, or the one character `from`. */
function range(from: number, to = from): string {
  return from === to ? character(from) : `${character(from)}-${character(to)}`;
}

/** RFC 5322's atext: the ASCII characters of an atom. The hyphen stands last, so it needs no escape. */
export const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";

/** RFC 5322's atext but the slash: the last character of a local part. */
export const ATEXT_END = "A-Za-z0-9!#$%&'*+=?^_`{|}~-";

/**
 * The characters outside ASCII that an address never holds: a C1 control
 * character, a space or a separator (Unicode's Z, and U+FEFF), or a control
 * of the text's direction. ASCII is in the set too, so its negation is the
 * characters outside ASCII that an address may hold.
 */
const WIDE_SET = [
  range(0x00, 0xa0),
  range(0x1680),
  range(0x2000, 0x200a),
  range(0x2028, 0x2029),
  range(0x202f),
  range(0x205f),
  range(0x3000),
  range(0xfeff),
  range(0x061c),
  range(0x200e, 0x200f),
  range(0x202a, 0x202e),
  range(0x2066, 0x2069),
].join("");

/** A character outside ASCII that an address may hold. */
export const WIDE = `[^${WIDE_SET}]`;

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
const DOMAIN_WIDE = `[^${WIDE_SET}${[range(0x3002), range(0xad), range(0x115f, 0x1160), range(0x200b), range(0x2060, 0x2064), range(0x3164), range(0xff00, 0xffef)].join("")}]`;

/** A character of a local part's atom. */
const ATOM_CHARACTER = `([${ATEXT}]|${WIDE})`;

/** The last character of a local part: not a slash. */
const ATOM_END = `([${ATEXT_END}]|${WIDE})`;

/** A letter or a digit of a domain's label, or a character outside ASCII. */
const LABEL_END = `([A-Za-z0-9]|${DOMAIN_WIDE})`;

/** A domain's label: no hyphen at its start or end. */
const LABEL = `${LABEL_END}(([A-Za-z0-9-]|${DOMAIN_WIDE})*${LABEL_END})?`;

/** One mailbox, as the pattern of the API's description and of the tools' schemas: a dot-atom with no slash at its end, its one @, and a domain of labels. */
export const MAILBOX_PATTERN = `^(${ATOM_CHARACTER}+[.])*${ATOM_CHARACTER}*${ATOM_END}@${LABEL}([.]${LABEL})*$`;

/** One mailbox (MAILBOX_PATTERN), as the server checks it. */
export const MAILBOX = new RegExp(MAILBOX_PATTERN, "u");

/** One mailbox with a local part in ASCII, as the pattern of an address that NortFox sends mail to: atoms of atext alone, its one @, and a domain of labels. */
export const INVITED_PATTERN = `^([${ATEXT}]+[.])*[${ATEXT}]*[${ATEXT_END}]@${LABEL}([.]${LABEL})*$`;

/** One mailbox with a local part in ASCII (INVITED_PATTERN), as the server checks it. */
const INVITED = new RegExp(INVITED_PATTERN, "u");

/** The longest address: RFC 5321's path of 256 octets, less its angle brackets. */
export const EMAIL_MAX = 254;

/** The longest local part, RFC 5321's 64. */
const LOCAL_PART_MAX = 64;

/** A label of a domain that is an A-label, in any letter case. */
const A_LABEL = /(?:^|\.)xn--/i;

/**
 * Whether a mail is sent to `domain` as it is written: no label of it is an
 * A-label (xn--), whose U-label is the same domain written otherwise; its
 * last label is not a number; and the mapping of IDNA's UTS 46, node:url's
 * domainToASCII, which nodemailer makes before it sends, and back again
 * gives the domain's own labels, in lower case. The A-label is a rule of its
 * own, since how the mapping reads one whose Punycode does not decode
 * differs between Node releases.
 */
export function writtenAsMailed(domain: string): boolean {
  const written = domain.toLowerCase().normalize("NFC");
  if (A_LABEL.test(written) || /(?:^|\.)[0-9]+$/.test(written)) {
    return false;
  }
  const ascii = domainToASCII(domain);
  return ascii !== "" && domainToUnicode(ascii) === written;
}

/** The domain of a mailbox: the text after its last @. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/** The check of an address's length in the form the server stores, NFC: at most 254 characters. One that is longer as it is sent has the length's own problem alone. */
function storedFits(): z.core.$ZodCheck<string> {
  return z.refine((address: string) => address.length > EMAIL_MAX || address.normalize("NFC").length <= EMAIL_MAX, {
    message: `must be at most ${String(EMAIL_MAX)} characters long, also in NFC, the form the server stores.`,
    params: { code: "too-long", data: { maximum: EMAIL_MAX } },
  });
}

/** A character that case folding changes: Unicode's property Changes_When_Casefolded. */
const CHANGES_WHEN_CASEFOLDED = /\p{Changes_When_Casefolded}/u;

/**
 * Whether every character of `address`, in NFC, the form the server stores,
 * folds as its lower case does: its case fold, which casefold() gives under
 * pg_unicode_fast, is its plain lower case. A character's fold is the fold
 * of its lower case, so the two differ exactly when the lower case still
 * changes when it is case-folded. That is so for ß, ẞ, ς, ſ, µ, the
 * ligatures, the Cherokee letters, the Greek letters with a ypogegrammeni
 * and the others that Unicode's data gives; never for Σ, the Kelvin sign, İ
 * or the dotless i. The database's access.folds_as_lower_case finds the same
 * characters from PostgreSQL's own data, for every code point
 * (fold-twins.db.test.ts).
 */
export function foldsAsLowerCase(address: string): boolean {
  return Array.from(address.normalize("NFC")).every((character) => !CHANGES_WHEN_CASEFOLDED.test(character.toLowerCase()));
}

/** A rule of an address's form beyond MAILBOX: whether an address keeps it, and what its problem says when it does not. */
interface FormRule {
  readonly holds: (address: string) => boolean;
  readonly message: string;
}

/** The address in NFC, the form the server stores, is one mailbox still, with a local part of at most 64 characters. */
const STORED_AS_MAILBOX: FormRule = {
  holds: (address) => {
    const stored = address.normalize("NFC");
    return MAILBOX.test(stored) && Array.from(stored.slice(0, stored.lastIndexOf("@"))).length <= LOCAL_PART_MAX;
  },
  message: `does not have the format email: its local part holds at most ${String(LOCAL_PART_MAX)} characters, and it is one mailbox, also in NFC, the form the server stores.`,
};

/** The domain is written as it is mailed (writtenAsMailed). */
const MAILED_AS_WRITTEN: FormRule = {
  holds: (address) => writtenAsMailed(domainOf(address)),
  message: "does not have the format email: a mail would reach its domain under another name, so its domain must be written as it is mailed, in Unicode or in ASCII, and not end in a number.",
};

/** The local part is in ASCII (INVITED_PATTERN): the owner's rule of 2026-11-09 for an address that NortFox sends mail to. */
const LOCAL_PART_IN_ASCII: FormRule = {
  holds: (address) => INVITED.test(address),
  message:
    "does not have the format email: NortFox sends mail to it, so its local part, before the @, is in ASCII, which a mail server takes also without SMTPUTF8. Its domain may be in Unicode.",
};

/** Every character folds as its lower case does (foldsAsLowerCase): the owner's rule of 2026-11-09 for an address that can become an identity's. */
const FOLDS_AS_LOWER_CASE: FormRule = {
  holds: foldsAsLowerCase,
  message:
    "does not have the format email: it holds a character whose case fold is not its lower case, such as ß, ς, ſ, µ or a ligature, so NortFox would take it for another address, which a mail reaches as another mailbox.",
};

/**
 * The checks of the rules, in order, each refused with bad-format. An
 * address has the problem of the first rule it breaks alone: an address that
 * is no mailbox has MAILBOX's, a text with a lone surrogate has
 * wellFormed's, and one that breaks a rule has none of the later ones.
 */
function formChecks(rules: readonly FormRule[]): z.core.$ZodCheck<string>[] {
  return rules.map((rule, index) =>
    z.refine(
      (address: string) => !MAILBOX.test(address) || !address.isWellFormed() || rules.slice(0, index).some((earlier) => !earlier.holds(address)) || rule.holds(address),
      {
        message: rule.message,
        params: { code: "bad-format", data: { format: "email" } },
      },
    ),
  );
}

/** An address of one mailbox, at most 254 characters, also in NFC, that keeps `rules`, with `pattern` as its published pattern. */
function addressOf(pattern: string, rules: readonly FormRule[]): z.ZodEmail {
  return z
    .email({ pattern: MAILBOX })
    .max(EMAIL_MAX)
    .check(noNul(), wellFormed(), storedFits(), ...formChecks(rules))
    .meta({ format: "idn-email", pattern });
}

/**
 * An e-mail address that the server stores and looks up: one mailbox
 * (MAILBOX), mailed as it is written, at most 254 characters, also in NFC.
 * Its JSON Schema is RFC 6531's address, the format idn-email (JSON Schema
 * 2020-12's email is RFC 5321's, ASCII only), with MAILBOX_PATTERN as its
 * pattern, in the API's description and in the tools' schemas alike. The
 * company's own address is one: it is no identity's, and NortFox sends it no
 * mail.
 */
export function emailAddress(): z.ZodEmail {
  return addressOf(MAILBOX_PATTERN, [STORED_AS_MAILBOX, MAILED_AS_WRITTEN]);
}

/**
 * An address that can become an identity's, which NortFox sends no mail to
 * in this part: completeSetup's. An e-mail address (emailAddress) whose
 * every character folds as its lower case does (foldsAsLowerCase), the
 * owner's rule of 2026-11-09. Its local part may hold characters outside
 * ASCII.
 */
export function identityAddress(): z.ZodEmail {
  return addressOf(MAILBOX_PATTERN, [STORED_AS_MAILBOX, MAILED_AS_WRITTEN, FOLDS_AS_LOWER_CASE]);
}

/**
 * An address that NortFox sends an invitation to, and that can become an
 * identity's: inviteUser's, and the work e-mail, which a disconnect invites.
 * An identity's address (identityAddress) with a local part in ASCII, the
 * owner's rule of 2026-11-09, with INVITED_PATTERN as its published
 * pattern. Its domain may be internationalised: nodemailer sends it as its
 * A-label.
 */
export function invitedAddress(): z.ZodEmail {
  return addressOf(INVITED_PATTERN, [LOCAL_PART_IN_ASCII, STORED_AS_MAILBOX, MAILED_AS_WRITTEN, FOLDS_AS_LOWER_CASE]);
}
