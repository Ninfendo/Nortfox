// SPDX-License-Identifier: AGPL-3.0-only

// The identifier of a password sign-in: the e-mail address or the
// personnummer (issue 12, behaviour 2). The database keeps a personnummer in
// its twelve digits with the hyphen, and finds an e-mail address in any
// letter case (access.find_login), so the server writes the identifier in
// that form first:
//
// - A personnummer of 12 digits, with or without its hyphen, gets the hyphen.
// - A personnummer of 10 digits gets its century, as Skatteverket writes it:
//   with - (or nothing) the person is under 100 this year, with + 100 or
//   older. So 900101-2385 is 1990 in 2026, and 2090 in 2090.
// - Anything else is an e-mail address, in NFC, so Å written as A and a
//   combining ring is the same address as Å.
//
// The spaces around an identifier are left out. An identifier that names no
// identity is counted under the HMAC of the form that access.find_login
// matches on, which the database gives (access.identifier_form): an e-mail
// address folded with casefold(), as the unique index folds it. So every
// spelling that would find one identity is counted as one, for an unknown
// address as for an identity, and the database never holds the address.
// The server never folds the case itself: JavaScript's lower case folds
// less than casefold() does, such as the long s and the sharp s.

import type { InstallKey } from "../../auth/install-key.ts";

export type Identifier = { readonly kind: "email"; readonly value: string } | { readonly kind: "personnummer"; readonly value: string };

const TWELVE_DIGITS = /^([0-9]{8})-?([0-9]{4})$/;
const TEN_DIGITS = /^([0-9]{2})([0-9]{4})([-+]?)([0-9]{4})$/;

/** The year of a two-digit year: the latest one up to this year, or a hundred years before for a person of 100 or more. */
function yearOf(twoDigits: number, today: Date, hundredOrOlder: boolean): number {
  const thisYear = today.getUTCFullYear();
  const latest = thisYear - ((((thisYear - twoDigits) % 100) + 100) % 100);
  return hundredOrOlder ? latest - 100 : latest;
}

/** The identifier as the database finds it, from the text a person typed and the server's date. */
export function readIdentifier(text: string, today: Date): Identifier {
  const trimmed = text.trim();
  const twelve = TWELVE_DIGITS.exec(trimmed);
  if (twelve !== null) {
    return { kind: "personnummer", value: `${String(twelve[1])}-${String(twelve[2])}` };
  }
  const ten = TEN_DIGITS.exec(trimmed);
  if (ten !== null) {
    // Each group of the form matched, so each is a string.
    const [, year, monthDay, sign, last] = ten as unknown as [string, string, string, string, string];
    return { kind: "personnummer", value: `${String(yearOf(Number(year), today, sign === "+"))}${monthDay}-${last}` };
  }
  return { kind: "email", value: trimmed.normalize("NFC") };
}

/** The attempt counter's subject of an identifier that names no identity: the HMAC, with the key's id, of the form that the database matches on. */
export function unknownSubject(installKey: InstallKey, form: string): string {
  return `hmac:${String(installKey.keyId)}:${installKey.mac("identifier v1", form)}`;
}
