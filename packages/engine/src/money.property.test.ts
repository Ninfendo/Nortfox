// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MoneyError,
  add,
  formatSwedish,
  formatWire,
  ore,
  parseSwedish,
  parseWire,
  subtract,
} from "./money.ts";

const amount = fc.bigInt().map((value) => ore(value));

describe("money properties", () => {
  it("a wire amount reads back to the same öre", () => {
    fc.assert(
      fc.property(amount, (value) => {
        expect(parseWire(formatWire(value))).toBe(value);
      }),
    );
  });

  it("a Swedish amount reads back to the same öre", () => {
    fc.assert(
      fc.property(amount, (value) => {
        expect(parseSwedish(formatSwedish(value))).toBe(value);
      }),
    );
  });

  it("every written amount has exactly two decimals", () => {
    fc.assert(
      fc.property(amount, (value) => {
        expect(formatWire(value)).toMatch(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/);
        expect(formatSwedish(value)).toMatch(
          /^-?(0|[1-9][0-9]{0,2}(\u00A0[0-9]{3})*),[0-9]{2}$/,
        );
      }),
    );
  });

  it("any space a person types between groups reads the same", () => {
    const separator = fc.constantFrom(" ", "\u00A0", "\u202F");
    fc.assert(
      fc.property(amount, separator, (value, typed) => {
        const text = formatSwedish(value).replaceAll("\u00A0", typed);
        expect(parseSwedish(text)).toBe(value);
      }),
    );
  });

  it("adding and subtracting are exact", () => {
    fc.assert(
      fc.property(amount, amount, amount, (a, b, c) => {
        expect(subtract(add(a, b), b)).toBe(a);
        expect(add(a, b)).toBe(add(b, a));
        expect(add(add(a, b), c)).toBe(add(a, add(b, c)));
        expect(add(a, ore(0n))).toBe(a);
      }),
    );
  });

  it("a fraction of an öre is always refused", () => {
    const krona = fc.bigInt({ min: 0n });
    const decimals = fc.string({
      unit: fc.integer({ min: 0, max: 9 }).map(String),
      minLength: 3,
      maxLength: 12,
    });
    fc.assert(
      fc.property(krona, decimals, fc.boolean(), (whole, digits, negative) => {
        const sign = negative ? "-" : "";
        expect(() => parseWire(`${sign}${whole.toString()}.${digits}`)).toThrow(
          expect.objectContaining({ code: "fraction-of-ore" }),
        );
        expect(() => parseSwedish(`${sign}${whole.toString()},${digits}`)).toThrow(
          expect.objectContaining({ code: "fraction-of-ore" }),
        );
      }),
    );
  });

  it("a JavaScript number is always refused", () => {
    const unchecked = ore as (value: unknown) => unknown;
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.double()), (value) => {
        expect(() => unchecked(value)).toThrow(
          expect.objectContaining({ code: "not-a-bigint" }),
        );
      }),
    );
  });

  it("any text either reads as an amount or is refused with a MoneyError", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        for (const parse of [parseWire, parseSwedish]) {
          try {
            expect(typeof parse(text)).toBe("bigint");
          } catch (error) {
            expect(error).toBeInstanceOf(MoneyError);
          }
        }
      }),
    );
  });
});
