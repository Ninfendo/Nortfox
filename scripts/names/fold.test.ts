// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { fold, foldings, foldWith, isHandMade, parseLookAlikes } from "./fold.ts";

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

  it.each([
    ["a box-drawing line for l", "b│irvex", "blirvex"],
    ["a divides sign for l", "b∣irvex", "blirvex"],
    ["an empty set for o", "zarqu∅n", "zarquon"],
    ["an APL alpha for a", "z⍺rquon", "zarquon"],
    ["a cent sign for c", "¢at", "cat"],
    ["an estimated sign for e", "℮x", "ex"],
    ["an inverted exclamation mark for i", "¡n", "in"],
    ["a multiplication sign for x", "blirve×", "blirvex"],
    ["a lunate sigma for c, at the start of a word", "Ϲat", "cat"],
    ["a lunate sigma for c, at the end of a word", "zaϹ", "zac"],
  ])("reads look-alike symbols from Unicode's confusables data: %s", (_case, text, plain) => {
    expect(fold(text)).toBe(fold(plain));
  });

  it("reads a plain | as l only between two letters or digits", () => {
    expect(fold("b|irvex")).toBe(fold("blirvex"));
    expect(fold("z4rq|1n")).toBe("zarqiin");
    expect(fold(`b|${char(0x200b)}irvex`)).toBe(fold("blirvex"));
    expect(fold("| b | irvex |")).toBe("birvex");
    expect(fold("b || irvex")).toBe("birvex");
    expect(fold("b||irvex")).toBe("birvex");
    expect(fold("|birvex|")).toBe("birvex");
  });

  it("reads ! as a separator: Unicode's data maps no ASCII punctuation but | to a letter", () => {
    expect(fold("b!irvex")).toBe("birvex");
    expect(foldings("b!irvex")).toEqual({ letters: "birvex", separators: "birvex" });
  });

  it("lets a hand-made table win over the Unicode data", () => {
    // Unicode reads a Cyrillic ze as the digit 3, and so as e; the table agrees.
    expect(foldWith("з", new Map([["з", "z"]]))).toBe("e");
    expect(foldWith(char(0x585), new Map())).toBe("");
    expect(foldWith(char(0x585), new Map([[char(0x585), "o"]]))).toBe("o");
  });

  it("reads the Unicode table before NFKC, which would make a lunate sigma a Σ", () => {
    expect(foldWith("Ϲat", new Map())).toBe("oat");
    expect(foldWith("Ϲat", new Map([["Ϲ", "c"]]))).toBe("cat");
  });
});

describe("foldings", () => {
  it("reads a look-alike symbol both as its letters and as a separator", () => {
    expect(foldings("zar×quon")).toEqual({ letters: "zarxquon", separators: "zarquon" });
    expect(foldings("b|irvex")).toEqual({ letters: "biirvex", separators: "birvex" });
    expect(foldings("z∅rbex")).toEqual({ letters: "zorbex", separators: "zrbex" });
  });

  it("reads a look-alike letter or digit as its letters both times", () => {
    expect(foldings(`zarqu${char(0x585)}n`)).toEqual({ letters: "zarquon", separators: "zarquon" });
    expect(foldings("Ϲat")).toEqual({ letters: "cat", separators: "cat" });
  });

  it("gives one reading twice for a text without look-alike symbols", () => {
    expect(foldings("zárquon")).toEqual({ letters: "zarquon", separators: "zarquon" });
    expect(foldings("| zar | quon |")).toEqual({ letters: "zarquon", separators: "zarquon" });
  });

  it("drops a symbol in the separators reading of foldWith too", () => {
    const table = new Map([
      ["×", "x"],
      [char(0x585), "o"],
    ]);
    expect(foldWith(`zar×qu${char(0x585)}n`, table)).toBe("zarxquon");
    expect(foldWith(`zar×qu${char(0x585)}n`, table, "separators")).toBe("zarquon");
  });
});

describe("isHandMade", () => {
  it.each([
    ["a Cyrillic capital", "А", true],
    ["a Greek small letter", "ο", true],
    ["a stand-in", "$", true],
    ["a negative squared letter", char(0x1f170), true],
    ["a lunate sigma", "Ϲ", false],
    ["a box-drawing line", "│", false],
  ])("%s", (_case, text, handMade) => {
    expect(isHandMade(text)).toBe(handMade);
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

  it("refuses an ASCII character, which the fold reads by its own rules", () => {
    expect(() => parseLookAlikes("# table\n007C i\n")).toThrow("Line 2 of the look-alike table maps an ASCII character.");
  });
});
