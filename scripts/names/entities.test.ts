// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { decodeEntities, parseEntities } from "./entities.ts";

const char = (code: number): string => String.fromCodePoint(code);

describe("decodeEntities", () => {
  it.each([
    ["a common name", "zar&amp;quon", "zar&quon"],
    ["a double-struck letter", "&zopf;", char(0x1d56b)],
    ["a script and a fraktur letter", "&Xscr;&Xfr;", `${char(0x1d4b3)}${char(0x1d51b)}`],
    ["a name of two code points", "&NotEqualTilde;", "≂̸"],
    ["a name with digits", "&frac12;", "½"],
    ["an old name without its semicolon", "z&aacute rquon", "zá rquon"],
    ["the longest name that fits, as HTML reads it", "&notit;", "¬it;"],
    ["a longer name before a shorter one", "&notin;", "∉"],
    ["an old name before more letters", "&ampx", "&x"],
    ["a decimal reference", "&#122;", "z"],
    ["a decimal reference without its semicolon", "&#122abc", "zabc"],
    ["a decimal reference with leading zeros", "&#0000122;", "z"],
    ["a hex reference", "&#x7a;&#X61;", "za"],
    ["a hex reference without its semicolon", "&#x7a", "z"],
  ])("decodes %s", (_case, text, decoded) => {
    expect(decodeEntities(text)).toBe(decoded);
  });

  it.each([
    ["an unknown name", "zar&bogus;quon"],
    ["a name in the wrong case", "&Amp;"],
    ["a name that needs its semicolon", "&zopf"],
    ["a reference beyond Unicode", "&#x110000;&#99999999999;"],
    ["an & alone", "AT&T and R & D"],
  ])("leaves %s as it is", (_case, text) => {
    expect(decodeEntities(text)).toBe(text);
  });
});

describe("parseEntities", () => {
  it("reads a name and its code points per line, without comments", () => {
    expect([...parseEntities("# table\n\namp 0026\r\nzopf; 1D56B # double-struck\nNotEqualTilde; 2242 0338\n")]).toEqual([
      ["amp", "&"],
      ["zopf;", char(0x1d56b)],
      ["NotEqualTilde;", "≂̸"],
    ]);
  });

  it.each(["amp", "amp 26", "&amp; 0026", "amp  0026", "amp 0026 x", "1amp 0026", "amp 110000"])("refuses %j", (line) => {
    expect(() => parseEntities(`# table\n${line}\n`)).toThrow(
      'Line 2 of the entity table is not "<name> <hex code point> ...".',
    );
  });
});
