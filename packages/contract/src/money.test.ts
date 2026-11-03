// SPDX-License-Identifier: AGPL-3.0-only

import { ore } from "@nortfox/engine";
import { describe, expect, it } from "vitest";
import { CURRENCIES, Money, ORE_MAX, ORE_MIN, moneyToOre, oreToMoney } from "./money.ts";
import { fieldIssues, type FieldIssue } from "./problem.ts";

/** The field issues the schema finds in an input, as the runner reads them. */
function issuesOf(input: unknown): FieldIssue[] {
  const result = Money.safeParse(input, { reportInput: true });
  return result.success ? [] : fieldIssues(result.error.issues);
}

describe("Money", () => {
  it.each([
    ["1234.50", "SEK"],
    ["1234.5", "SEK"],
    ["1234", "SEK"],
    ["0.05", "SEK"],
    ["-0.05", "SEK"],
    ["0", "SEK"],
  ])("takes %j %s", (amount, currency) => {
    expect(issuesOf({ amount, currency })).toEqual([]);
  });

  it("takes only the currencies the install knows: SEK in this slice", () => {
    expect(Object.keys(CURRENCIES)).toEqual(["SEK"]);
    expect(CURRENCIES.SEK.minorUnits).toBe(2);
  });

  it.each(["EUR", "sek", "XYZ", "", "constructor", "__proto__"])("refuses the currency %j with unknown-currency at /currency", (currency) => {
    expect(issuesOf({ amount: "1.00", currency })).toEqual([
      {
        code: "unknown-currency",
        detail: "The field /currency is not a currency this install knows. It knows SEK.",
        pointer: "/currency",
        data: { allowed: ["SEK"], value: currency },
      },
    ]);
  });

  it.each(["1,50", "1e3", "+1", "01.5", "", " 1.50", "1.50 ", "1.", ".5", "- 1", "1 000.00", "0x10", "Infinity", "NaN"])(
    "refuses %j with bad-format at /amount",
    (amount) => {
      expect(issuesOf({ amount, currency: "SEK" })).toEqual([
        {
          code: "bad-format",
          detail: 'The field /amount is not a decimal amount such as "1234.50": digits, then a point and the decimals.',
          pointer: "/amount",
          data: { value: amount },
        },
      ]);
    },
  );

  it.each(["1.234", "0.001", "-5.999"])("refuses %j, more decimals than SEK has, with fraction-of-ore at /amount", (amount) => {
    expect(issuesOf({ amount, currency: "SEK" })).toEqual([
      {
        code: "fraction-of-ore",
        detail: "The field /amount has more decimals than its currency has. SEK has 2.",
        pointer: "/amount",
        data: { maximum: 2, value: amount },
      },
    ]);
  });

  describe("the range of PostgreSQL's bigint, in öre", () => {
    it("is -92233720368547758.08 to 92233720368547758.07", () => {
      expect(ORE_MIN).toBe(-9223372036854775808n);
      expect(ORE_MAX).toBe(9223372036854775807n);
    });

    it.each(["92233720368547758.07", "-92233720368547758.08", "92233720368547758", "-92233720368547758.0"])("takes %j, inside it", (amount) => {
      expect(issuesOf({ amount, currency: "SEK" })).toEqual([]);
    });

    it.each(["92233720368547758.08", "-92233720368547758.09", "99999999999999999999.00", "-100000000000000000000"])(
      "refuses %j, one öre or more past it, with out-of-range and the bounds",
      (amount) => {
        expect(issuesOf({ amount, currency: "SEK" })).toEqual([
          {
            code: "out-of-range",
            detail: "The field /amount is outside the range of an amount, -92233720368547758.08 to 92233720368547758.07.",
            pointer: "/amount",
            data: { minimum: "-92233720368547758.08", maximum: "92233720368547758.07", value: amount },
          },
        ]);
      },
    );
  });

  it("refuses a JSON number for the amount with invalid-type at /amount", () => {
    expect(issuesOf({ amount: 1234.5, currency: "SEK" })).toEqual([
      {
        code: "invalid-type",
        detail: "The field /amount must be a string.",
        pointer: "/amount",
        data: { expected: "string", value: 1234.5 },
      },
    ]);
  });

  it("refuses a JSON number in place of the whole amount with invalid-type at the root", () => {
    expect(issuesOf(1234.5)).toEqual([
      {
        code: "invalid-type",
        detail: "The input must be an object.",
        pointer: "",
        data: { expected: "object", value: 1234.5 },
      },
    ]);
  });

  it("refuses an amount without its currency, and a field it does not know", () => {
    expect(issuesOf({ amount: "1.00", rate: "1" })).toEqual([
      {
        code: "missing-field",
        detail: "The field /currency is missing.",
        pointer: "/currency",
        data: { expected: "string" },
      },
      {
        code: "unknown-field",
        detail: "The field /rate is not part of this operation.",
        pointer: "/rate",
        data: {},
      },
    ]);
  });

  it("checks the amount only once its fields have their types", () => {
    expect(issuesOf({ amount: "1.234", currency: 1 }).map((issue) => issue.code)).toEqual(["invalid-type"]);
  });
});

describe("moneyToOre and oreToMoney", () => {
  it("turn a checked amount into öre and back, always with two decimals", () => {
    expect(moneyToOre({ amount: "1234.5", currency: "SEK" })).toBe(123450n);
    expect(moneyToOre({ amount: "-0.05", currency: "SEK" })).toBe(-5n);
    expect(oreToMoney(ore(123450n), "SEK")).toEqual({ amount: "1234.50", currency: "SEK" });
    expect(oreToMoney(ore(-5n), "SEK")).toEqual({ amount: "-0.05", currency: "SEK" });
    expect(oreToMoney(ore(ORE_MAX), "SEK")).toEqual({ amount: "92233720368547758.07", currency: "SEK" });
    expect(oreToMoney(ore(ORE_MIN), "SEK")).toEqual({ amount: "-92233720368547758.08", currency: "SEK" });
  });

  it("takes a plain bigint of öre, such as one the database gives", () => {
    expect(oreToMoney(12550n, "SEK")).toEqual({ amount: "125.50", currency: "SEK" });
    expect(oreToMoney(ORE_MAX * 10n, "SEK")).toEqual({ amount: "922337203685477580.70", currency: "SEK" });
  });

  it("refuses an amount the schema would refuse, since the handler gets only checked input", () => {
    expect(() => moneyToOre({ amount: "1.00", currency: "EUR" })).toThrow("EUR is not a currency this install knows.");
    expect(() => moneyToOre({ amount: "1.234", currency: "SEK" })).toThrow("An amount has at most two decimals");
    expect(() => moneyToOre({ amount: "92233720368547758.08", currency: "SEK" })).toThrow(
      "92233720368547758.08 is outside the range of an amount.",
    );
  });
});
