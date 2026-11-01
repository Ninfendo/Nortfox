// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import * as engine from "./index.ts";
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

const NBSP = "\u00A0";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MoneyError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected a MoneyError");
}

describe("ore", () => {
  it("keeps a bigint as it is", () => {
    expect(ore(123450n)).toBe(123450n);
    expect(ore(-5n)).toBe(-5n);
    expect(ore(0n)).toBe(0n);
  });

  it("refuses a JavaScript number, also a whole one", () => {
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => ore(1234.5))).toBe("not-a-bigint");
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => ore(100))).toBe("not-a-bigint");
    // @ts-expect-error A string is not an amount; parse it.
    expect(codeOf(() => ore("100"))).toBe("not-a-bigint");
  });

  it("says what it got", () => {
    // @ts-expect-error A number is never an amount.
    const run = () => ore(1);
    expect(run).toThrow(MoneyError);
    expect(run).toThrow("An amount must be a bigint of öre, not a number.");
    expect(run).toThrow(expect.objectContaining({ name: "MoneyError" }));
  });
});

describe("parseWire", () => {
  it.each([
    ["1234.50", 123450n],
    ["1234.5", 123450n],
    ["1234", 123400n],
    ["0.05", 5n],
    ["-0.05", -5n],
    ["0", 0n],
    ["-0.00", 0n],
    ["-1234.56", -123456n],
    ["90071992547409930.99", 9007199254740993099n],
  ])("reads %j", (text, expected) => {
    expect(parseWire(text)).toBe(expected);
  });

  it.each([
    "",
    "1 234.50",
    "1234,50",
    "+1.00",
    "01.00",
    "1.",
    ".5",
    " 1.00",
    "1.00 ",
    "1e3",
    "--1",
    "0x10",
    "\u0661\u0662",
  ])("refuses %j", (text) => {
    expect(codeOf(() => parseWire(text))).toBe("bad-format");
  });

  it("refuses a fraction of an öre, also when it is written as zeros", () => {
    expect(codeOf(() => parseWire("1.005"))).toBe("fraction-of-ore");
    expect(codeOf(() => parseWire("1.500"))).toBe("fraction-of-ore");
  });

  it("refuses anything but a string", () => {
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => parseWire(1234.5))).toBe("not-a-string");
  });
});

describe("parseSwedish", () => {
  it.each([
    ["1 234,50", 123450n],
    [`1${NBSP}234,50`, 123450n],
    ["1\u202F234,50", 123450n],
    ["1234,50", 123450n],
    ["12 345 678,9", 1234567890n],
    ["-1 234,50", -123450n],
    ["\u22121 234,50", -123450n],
    ["0,05", 5n],
    ["7", 700n],
  ])("reads %j", (text, expected) => {
    expect(parseSwedish(text)).toBe(expected);
  });

  it.each([
    "",
    "12 34,50",
    "1 2345",
    "1234.50",
    "1 234,",
    ",5",
    "01 234,50",
    " 1,00",
    "1,00 kr",
  ])("refuses %j", (text) => {
    expect(codeOf(() => parseSwedish(text))).toBe("bad-format");
  });

  it("refuses a fraction of an öre", () => {
    expect(codeOf(() => parseSwedish("1 234,505"))).toBe("fraction-of-ore");
  });

  it("refuses anything but a string", () => {
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => parseSwedish(12))).toBe("not-a-string");
  });
});

describe("formatWire and formatSwedish", () => {
  it.each([
    [123450n, "1234.50", `1${NBSP}234,50`],
    [5n, "0.05", "0,05"],
    [-5n, "-0.05", "-0,05"],
    [0n, "0.00", "0,00"],
    [100n, "1.00", "1,00"],
    [-123456789n, "-1234567.89", `-1${NBSP}234${NBSP}567,89`],
    [99999n, "999.99", "999,99"],
  ])("write %s öre", (value, wire, swedish) => {
    expect(formatWire(ore(value))).toBe(wire);
    expect(formatSwedish(ore(value))).toBe(swedish);
  });

  it("refuse a JavaScript number", () => {
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => formatWire(12))).toBe("not-a-bigint");
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => formatSwedish(12))).toBe("not-a-bigint");
  });
});

describe("add and subtract", () => {
  it("count exactly where a float would not", () => {
    expect(add(parseWire("0.10"), parseWire("0.20"))).toBe(parseWire("0.30"));
    expect(subtract(ore(1000n), ore(1n))).toBe(999n);
    expect(add(ore(9007199254740993n), ore(1n))).toBe(9007199254740994n);
  });

  it("refuse a JavaScript number on either side", () => {
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => add(1, ore(1n)))).toBe("not-a-bigint");
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => add(ore(1n), 1))).toBe("not-a-bigint");
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => subtract(1, ore(1n)))).toBe("not-a-bigint");
    // @ts-expect-error A number is never an amount.
    expect(codeOf(() => subtract(ore(1n), 1))).toBe("not-a-bigint");
  });
});

describe("the package entry", () => {
  it("exports the money functions and nothing else", () => {
    expect(Object.keys(engine).sort()).toEqual([
      "MoneyError",
      "SWEDISH_GROUP_SEPARATOR",
      "add",
      "formatSwedish",
      "formatWire",
      "ore",
      "parseSwedish",
      "parseWire",
      "subtract",
    ]);
  });
});
