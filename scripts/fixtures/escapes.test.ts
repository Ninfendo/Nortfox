// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { escapeDecodings } from "./escapes.ts";

describe("escapeDecodings", () => {
  it.each([
    ["\\u and four hex digits, as JSON writes them", String.raw`zarqu\u00f6n`, ["zarquön"]],
    ["the same in capitals, as .NET writes them", String.raw`zarqu\u00F6n`, ["zarquön"]],
    ["\\u and hex digits in braces, as JavaScript may write them", String.raw`zarqu\u{f6}n`, ["zarquön"]],
    ["a letter outside the first plane, as JSON writes it in two halves", String.raw`\ud835\udc9c`, ["\u{1d49c}"]],
    ["\\x and two hex digits, as JavaScript reads them", String.raw`zarqu\xf6n`, ["zarquön"]],
    ["a run of \\x that makes UTF-8, as a Python bytes literal holds it", String.raw`zarqu\xc3\xb6n`, ["zarquÃ¶n", "zarquön"]],
    ["each kind on one line", String.raw`\u0061\u{62}\x63`, ["abc"]],
  ])("decodes %s", (_case, text, decoded) => {
    expect(escapeDecodings(text)).toEqual(decoded);
  });

  it.each([
    ["a text without a backslash", "zarquon"],
    ["a backslash that starts no escape", String.raw`C:\Users\ann`],
    ["\\u with too few hex digits", String.raw`\u00f`],
    ["\\u in braces past the last code point", String.raw`\u{110000}`],
  ])("gives nothing for %s", (_case, text) => {
    expect(escapeDecodings(text)).toEqual([]);
  });
});
