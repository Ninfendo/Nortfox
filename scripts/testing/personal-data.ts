// SPDX-License-Identifier: AGPL-3.0-only

// Builders for the tests of the fixture guard. A test that shows the guard
// finds a value needs a value that looks real. Written out in a test file,
// such a value would be found in the repository itself, so the tests build
// it while they run, from parts that do not look real on their own.

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
