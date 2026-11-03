// SPDX-License-Identifier: AGPL-3.0-only

/**
 * On /v1 an amount is a decimal string with its currency code, such as
 * {"amount": "1234.50", "currency": "SEK"}, never a JSON number
 * (docs/decisions/0005-money.md). Every amount on /v1 uses this one schema.
 * Inside the server an amount is a bigint of öre: the handlers convert with
 * moneyToOre and oreToMoney.
 */

import { MoneyError, formatWire, ore, parseWire, type Ore } from "@nortfox/engine";
import { z } from "zod";

/** The currencies this install knows, with their minor units (ISO 4217). */
export const CURRENCIES = { SEK: { minorUnits: 2 } } as const;

export type Currency = keyof typeof CURRENCIES;

/**
 * The range of PostgreSQL's bigint, which holds every amount in öre. An
 * amount outside it is refused as the caller's own input, before it can
 * reach the database.
 */
export const ORE_MIN = -(2n ** 63n);
export const ORE_MAX = 2n ** 63n - 1n;

const MINIMUM = formatWire(ore(ORE_MIN));
const MAXIMUM = formatWire(ore(ORE_MAX));

function isCurrency(code: string): code is Currency {
  return Object.hasOwn(CURRENCIES, code);
}

/** Why an amount is not one, or undefined when it is. The texts go on from "The field /x". */
function amountProblem(amount: string, currency: Currency): { code: string; message: string; data: Record<string, unknown> } | undefined {
  let value: bigint;
  try {
    value = parseWire(amount);
  } catch (error) {
    if (error instanceof MoneyError && error.code === "fraction-of-ore") {
      const decimals = CURRENCIES[currency].minorUnits;
      return {
        code: "fraction-of-ore",
        message: `has more decimals than its currency has. ${currency} has ${String(decimals)}.`,
        data: { maximum: decimals },
      };
    }
    return {
      code: "bad-format",
      message: 'is not a decimal amount such as "1234.50": digits, then a point and the decimals.',
      data: {},
    };
  }
  if (value < ORE_MIN || value > ORE_MAX) {
    return {
      code: "out-of-range",
      message: `is outside the range of an amount, ${MINIMUM} to ${MAXIMUM}.`,
      data: { minimum: MINIMUM, maximum: MAXIMUM },
    };
  }
  return undefined;
}

export const Money = z
  .strictObject({
    // The pattern documents the form; the check below refuses with the
    // engine's own codes, so zod does not check the pattern itself.
    amount: z.string().meta({
      pattern: String.raw`^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`,
      description: 'The amount as a decimal string, such as "1234.50" or "-0.05", with no more decimals than its currency has.',
      examples: ["1234.50"],
    }),
    currency: z.string().meta({
      enum: Object.keys(CURRENCIES),
      description: "The currency's ISO 4217 code. This install knows SEK.",
    }),
  })
  .superRefine((money, context) => {
    if (!isCurrency(money.currency)) {
      context.addIssue({
        code: "custom",
        path: ["currency"],
        input: money.currency,
        message: `is not a currency this install knows. It knows ${Object.keys(CURRENCIES).join(", ")}.`,
        params: { code: "unknown-currency", data: { allowed: Object.keys(CURRENCIES) } },
      });
      return;
    }
    const problem = amountProblem(money.amount, money.currency);
    if (problem !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        input: money.amount,
        message: problem.message,
        params: { code: problem.code, data: problem.data },
      });
    }
  })
  .meta({ id: "Money", description: "An amount: a decimal string and its ISO 4217 currency code. Never a JSON number." });

export type Money = z.infer<typeof Money>;

/**
 * The öre of an amount the schema has checked. An amount it would refuse
 * throws: a handler gets only checked input, so that is a fault of the server.
 */
export function moneyToOre(money: Money): Ore {
  if (!isCurrency(money.currency)) {
    throw new Error(`${money.currency} is not a currency this install knows.`);
  }
  const value = parseWire(money.amount);
  if (value < ORE_MIN || value > ORE_MAX) {
    throw new Error(`${money.amount} is outside the range of an amount.`);
  }
  return value;
}

/**
 * An amount for the wire, always with all its currency's decimals: "1234.50".
 * It takes any bigint of öre, such as one the database gives.
 */
export function oreToMoney(value: bigint, currency: Currency): Money {
  return { amount: formatWire(ore(value)), currency };
}
