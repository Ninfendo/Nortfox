// SPDX-License-Identifier: AGPL-3.0-only

// Builders for the tests of the fixture guard. A test that shows the guard
// finds a value needs a value that looks real. Written out in a test file,
// such a value would be found in the repository itself, so the tests build
// it while they run, from parts that do not look real on their own.
//
// An address that the guard must find cannot be at a reserved example domain,
// which the guard lets through, and it must never be a real one either. So the
// tests put it at zarquon.zz, or at a name under it. No one can ever register
// such a name:
// - ZZ is one of the codes that ISO 3166-1 leaves to its users. It is never
//   given to a country, so it never becomes a country's top-level domain.
// - ICANN's Applicant Guidebook for new generic top-level domains takes no
//   name of two letters, which it keeps for the country codes.
// - IANA's list of top-level domains, version 2026110100, holds no ZZ:
//   https://data.iana.org/TLD/tlds-alpha-by-domain.txt
// A test may also use a name that no registry takes, such as one with "--"
// as its third and fourth characters (RFC 5890, section 2.3.1).

/** An address, joined at run time so that no test file holds it as written. */
export function address(local: string, domain: string): string {
  return [local, domain].join("@");
}

/**
 * The Luhn check digit of nine digits, computed another way than the guard
 * computes it: by fixed weights, adding the digits of each product.
 */
export function checkDigit(nine: string): string {
  const weights = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (const [index, weight] of weights.entries()) {
    const product = Number(nine.charAt(index)) * weight;
    sum += Math.floor(product / 10) + (product % 10);
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * A number with a right check digit: `head` is the century, if any, and the
 * date part; `separator` goes before the last four digits; `birth` is the
 * three digits before the check digit.
 */
export function numberWith(head: string, separator: string, birth: string): string {
  return `${head}${separator}${birth}${checkDigit(head.slice(-6) + birth)}`;
}
