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
    // As a browser shows them: "&#142;arquon" is "Žarquon".
    ["a number from 128 to 159 as windows-1252", "&#142;arquon &#x9E;&#x8a;&#140;&#x9C;&#159;&#131;&#153;", "Žarquon žŠŒœŸƒ™"],
    ["each number from 128 to 159 in windows-1252", "&#128;&#x82;&#x96;&#151;&#x98;", "€‚–—˜"],
    ["a number from 128 to 159 that windows-1252 leaves out, as it is", "&#129;&#x8D;&#143;&#x90;&#157;", `${char(0x81)}${char(0x8d)}${char(0x8f)}${char(0x90)}${char(0x9d)}`],
    ["0, a surrogate and a number beyond Unicode, as U+FFFD", "&#0;&#xD800;&#57343;&#x110000;&#99999999999;", "�".repeat(5)],
    ["the numbers just outside those ranges", "&#127;&#160;&#xD7FF;&#xE000;&#x10FFFF;", `${char(0x7f)}${char(0xa0)}${char(0xd7ff)}${char(0xe000)}${char(0x10ffff)}`],
  ])("decodes %s", (_case, text, decoded) => {
    expect(decodeEntities(text)).toBe(decoded);
  });

  it.each([
    ["an unknown name", "zar&bogus;quon"],
    ["a name in the wrong case", "&Amp;"],
    ["a name that needs its semicolon", "&zopf"],
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
