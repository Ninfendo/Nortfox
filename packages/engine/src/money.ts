// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Money is a whole number of öre, held as a bigint, and never a JavaScript
 * number (docs/decisions/0005-money.md). On the wire an amount is a decimal
 * string such as "1234.50". On a Swedish screen it reads "1 234,50".
 */

declare const oreBrand: unique symbol;

/** An amount in öre, the minor unit of SEK. One krona is 100 öre. */
export type Ore = bigint & { readonly [oreBrand]: true };

export type MoneyErrorCode =
  | "not-a-bigint"
  | "not-a-string"
  | "bad-format"
  | "fraction-of-ore";

/** Thrown when a value is not a valid amount. `code` says why. */
export class MoneyError extends Error {
  override readonly name = "MoneyError";
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const ORE_PER_KRONA = 100n;
const DECIMALS = 2;

/** "1234.50", "-0.05", "12": no sign but "-", no leading zeros, no spaces. */
const WIRE = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * "1 234,50", "1234,50", "-12 345 678,9": groups of three digits split by a
 * space, a no-break space or a narrow no-break space, or no groups at all. The
 * minus sign may be "-" or "\u2212".
 */
const SWEDISH =
  /^([-\u2212]?)(0|[1-9][0-9]{0,2}(?:[ \u00A0\u202F][0-9]{3})+|[1-9][0-9]*)(?:,([0-9]+))?$/;

const GROUP_SEPARATORS = /[ \u00A0\u202F]/g;

/** The separator `formatSwedish` puts between groups: a no-break space. */
export const SWEDISH_GROUP_SEPARATOR = "\u00A0";

function assertOre(value: unknown): asserts value is Ore {
  if (typeof value !== "bigint") {
    throw new MoneyError(
      "not-a-bigint",
      `An amount must be a bigint of öre, not a ${typeof value}.`,
    );
  }
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new MoneyError(
      "not-a-string",
      `An amount to parse must be a string, not a ${typeof value}.`,
    );
  }
}

/** Makes an amount from a bigint of öre. A JavaScript number is refused. */
export function ore(value: bigint): Ore;
export function ore(value: unknown): Ore {
  assertOre(value);
  return value;
}

/**
 * Both patterns have three groups. The sign and the digits always take part in
 * a match (the sign may be empty); only the decimals are optional.
 */
function groups(match: RegExpExecArray): [string, string, string, string | undefined] {
  return match as unknown as [string, string, string, string | undefined];
}

function fromParts(
  sign: string,
  whole: string,
  fraction: string | undefined,
): Ore {
  const decimals = fraction ?? "";
  if (decimals.length > DECIMALS) {
    throw new MoneyError(
      "fraction-of-ore",
      "An amount has at most two decimals: it is a whole number of öre.",
    );
  }
  const magnitude =
    BigInt(whole) * ORE_PER_KRONA + BigInt(decimals.padEnd(DECIMALS, "0"));
  return ore(sign === "" ? magnitude : -magnitude);
}

/** Reads a wire amount such as "1234.50" or "-0.05". */
export function parseWire(text: string): Ore {
  assertString(text);
  const match = WIRE.exec(text);
  if (match === null) {
    throw new MoneyError(
      "bad-format",
      'A wire amount looks like "1234.50": digits, then a point and at most two decimals.',
    );
  }
  const [, sign, whole, fraction] = groups(match);
  return fromParts(sign, whole, fraction);
}

/** Reads a Swedish amount such as "1 234,50" or "-12,5". */
export function parseSwedish(text: string): Ore {
  assertString(text);
  const match = SWEDISH.exec(text);
  if (match === null) {
    throw new MoneyError(
      "bad-format",
      'A Swedish amount looks like "1 234,50": groups of three digits, then a comma and at most two decimals.',
    );
  }
  const [, sign, grouped, fraction] = groups(match);
  return fromParts(sign, grouped.replace(GROUP_SEPARATORS, ""), fraction);
}

interface Parts {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
}

function split(amount: Ore): Parts {
  assertOre(amount);
  const value: bigint = amount;
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return {
    negative,
    whole: (magnitude / ORE_PER_KRONA).toString(),
    fraction: (magnitude % ORE_PER_KRONA).toString().padStart(DECIMALS, "0"),
  };
}

/** Writes an amount for the wire, always with two decimals: "1234.50". */
export function formatWire(amount: Ore): string {
  const { negative, whole, fraction } = split(amount);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Writes an amount the Swedish way, always with two decimals: "1 234,50".
 * Groups are split by a no-break space, so a line never breaks inside one.
 */
export function formatSwedish(amount: Ore): string {
  const { negative, whole, fraction } = split(amount);
  const grouped = whole.replace(/\B(?=(?:[0-9]{3})+$)/g, SWEDISH_GROUP_SEPARATOR);
  return `${negative ? "-" : ""}${grouped},${fraction}`;
}

/** a + b, exactly. */
export function add(a: Ore, b: Ore): Ore {
  assertOre(a);
  assertOre(b);
  return ore(a + b);
}

/** a - b, exactly. */
export function subtract(a: Ore, b: Ore): Ore {
  assertOre(a);
  assertOre(b);
  return ore(a - b);
}
