// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { fold } from "./fold.ts";

const char = (code: number): string => String.fromCodePoint(code);

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
});
