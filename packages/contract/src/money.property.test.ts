// SPDX-License-Identifier: AGPL-3.0-only

import { formatWire, ore } from "@nortfox/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, ORE_MAX, ORE_MIN, moneyToOre, oreToMoney } from "./money.ts";
import { fieldIssues } from "./problem.ts";

/** Any amount a bigint column holds, the bounds drawn more often. */
const inRange = fc.oneof(
  fc.bigInt({ min: ORE_MIN, max: ORE_MAX }),
  fc.constantFrom(ORE_MIN, ORE_MAX, ORE_MIN + 1n, ORE_MAX - 1n, 0n, -1n, 1n),
);

/** Amounts past the bounds, up to a few times the range. */
const pastRange = fc.oneof(
  fc.bigInt({ min: ORE_MAX + 1n, max: ORE_MAX * 4n }),
  fc.bigInt({ min: ORE_MIN * 4n, max: ORE_MIN - 1n }),
);

describe("money on the wire", () => {
  it("random öre round-trip through the wire form and the schema", () => {
    fc.assert(
      fc.property(inRange, (value) => {
        const money = oreToMoney(ore(value), "SEK");
        expect(money.amount).toMatch(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/);
        const parsed = Money.parse(money);
        expect(parsed).toEqual(money);
        expect(moneyToOre(parsed)).toBe(value);
      }),
    );
  });

  it("an amount with fewer decimals reads as the same öre", () => {
    fc.assert(
      fc.property(inRange.filter((value) => value % 100n === 0n), (value) => {
        const whole = formatWire(ore(value)).replace(/\.00$/, "");
        expect(moneyToOre(Money.parse({ amount: whole, currency: "SEK" }))).toBe(value);
      }),
    );
  });

  it("an amount past the bigint range is refused with out-of-range at /amount, never taken", () => {
    fc.assert(
      fc.property(pastRange, (value) => {
        const amount = formatWire(ore(value));
        const result = Money.safeParse({ amount, currency: "SEK" }, { reportInput: true });
        expect(result.success).toBe(false);
        expect(result.success ? [] : fieldIssues(result.error.issues).map((issue) => [issue.code, issue.pointer])).toEqual([
          ["out-of-range", "/amount"],
        ]);
      }),
    );
  });

  it("an amount with a third decimal is refused, whatever its size", () => {
    fc.assert(
      fc.property(inRange, fc.integer({ min: 1, max: 9 }), (value, digit) => {
        const amount = `${formatWire(ore(value))}${String(digit)}`;
        const result = Money.safeParse({ amount, currency: "SEK" }, { reportInput: true });
        expect(result.success ? [] : fieldIssues(result.error.issues).map((issue) => issue.code)).toEqual(["fraction-of-ore"]);
      }),
    );
  });
});
