// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { fold, foldWith, parseLookAlikes } from "./fold.ts";

const char = (code: number): string => String.fromCodePoint(code);
/** The letters of ZARQUON in a block of letters that runs from A to Z. */
const inBlock = (first: number): string => "ZARQUON".replace(/[A-Z]/g, (letter) => char(first + letter.charCodeAt(0) - 65));

describe("fold", () => {
  it("lower-cases and drops everything but the letters", () => {
    expect(fold("Z a-R.q_U o/N!")).toBe("zarquon");
    expect(fold("")).toBe("");
    expect(fold("2026-11-01 ... ()")).toBe("oiioi");
  });

  it("drops accents, written either way", () => {
    expect(fold("zárquòn")).toBe("zarquon");
    expect(fold(`za${char(0x301)}rquo${char(0x300)}n`)).toBe("zarquon");
    expect(fold(`ZA${char(0x30a)}RQUON`)).toBe("zarquon");
  });

  it("reads compatibility forms: full width, ligatures, styled letters", () => {
    expect(fold("ｚａｒｑｕｏｎ")).toBe("zarquon");
    expect(fold(`${char(0x1d433)}arquon`)).toBe("zarquon");
    expect(fold("ﬁx")).toBe("fix");
  });

  it("drops format characters such as zero-width spaces and soft hyphens", () => {
    expect(fold(`zar${char(0x200b)}qu${char(0xad)}on${char(0x2060)}`)).toBe("zarquon");
  });

  it("reads Cyrillic and Greek look-alikes as Latin letters", () => {
    expect(fold("zаrquоn")).toBe("zarquon");
    expect(fold("ΖΑRQUΟΝ")).toBe("zarquon");
    expect(fold("ZARQUОН")).toBe("zarquoh");
    expect(fold("zαrquοn")).toBe("zarquon");
    expect(fold("ѕаԁ")).toBe("sad");
  });

  it("reads digits and symbols that stand in for letters", () => {
    expect(fold("z4rqu0n")).toBe("zarquon");
    expect(fold("$3v3n")).toBe("seven");
    expect(fold("5747")).toBe("stat");
  });

  it("reads 1, l and i as one letter", () => {
    expect(fold("b1irvex")).toBe(fold("blirvex"));
    expect(fold("BIIRVEX")).toBe(fold("blirvex"));
  });

  it("spells out letters that do not decompose", () => {
    expect(fold("straße")).toBe("strasse");
    expect(fold("Œuvre")).toBe("oeuvre");
    expect(fold("łódź")).toBe("iodz");
  });

  it("drops letters of scripts it does not map", () => {
    expect(fold("zar日本quon")).toBe("zarquon");
  });

  it.each([
    ["Armenian", `zarqu${char(0x585)}n`],
    ["Latin small capitals", "ᴢᴀʀqᴜᴏɴ"],
    ["IPA letters", `z${char(0x251)}rquon`],
    ["Lisu capitals", `ZA${char(0xa4e3)}QU${char(0xa4f3)}N`],
    ["negative circled letters", inBlock(0x1f150)],
    ["negative squared letters", inBlock(0x1f170)],
    ["regional indicators", inBlock(0x1f1e6)],
  ])("reads look-alikes from Unicode's confusables data and more: %s", (_script, text) => {
    expect(fold(text)).toBe("zarquon");
  });

  it("reads a Cherokee small letter by the capital it is the small form of", () => {
    // Cherokee capital a looks like a Latin D.
    expect(fold(char(0x13a0))).toBe("d");
    expect(fold(char(0xab70))).toBe("d");
  });

  it("lets a hand-made table win over the Unicode data", () => {
    // Unicode reads a Cyrillic ze as the digit 3, and so as e; the table agrees.
    expect(foldWith("з", new Map([["з", "z"]]))).toBe("e");
    expect(foldWith(char(0x585), new Map())).toBe("");
    expect(foldWith(char(0x585), new Map([[char(0x585), "o"]]))).toBe("o");
  });
});

describe("parseLookAlikes", () => {
  it("reads one code point and its letters per line, without comments", () => {
    expect([...parseLookAlikes("# table\n\n0585 o\r\n1F170 a # boxed\n")]).toEqual([
      [char(0x585), "o"],
      [char(0x1f170), "a"],
    ]);
  });

  it.each(["0585", "585 o", "0585 O", "0585  o", "zz o"])("refuses %j", (line) => {
    expect(() => parseLookAlikes(`# table\n${line}\n`)).toThrow(
      'Line 2 of the look-alike table is not "<hex code point> <letters>".',
    );
  });
});
