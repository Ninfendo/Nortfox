// SPDX-License-Identifier: AGPL-3.0-only

// Decodes HTML character references as a browser does in text, and as GitHub
// does when it shows a Markdown file or a PR body: numeric ones ("&#122;",
// "&#x7a;", also without the ";") and every named one in the HTML standard
// ("&zopf;" is a double-struck z). The names come from entities.txt. A number
// from 128 to 159 is read as HTML reads it, as a windows-1252 character:
// "&#142;" is Ž.

import { readFileSync } from "node:fs";

/** Named character references: a name without its "&", and the characters it stands for. */
export type Entities = ReadonlyMap<string, string>;

/** Reads entities.txt: "<name> <hex code point> ..." per line; # starts a comment. */
export function parseEntities(text: string): Map<string, string> {
  const entities = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const entry = line.replace(/#.*/, "").trim();
    if (entry === "") {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9]*;?)((?: [0-9A-F]{4,6})+)$/.exec(entry);
    const codes = match?.[2]?.trim().split(" ").map((code) => Number.parseInt(code, 16));
    if (match?.[1] === undefined || codes === undefined || codes.some((code) => code > 0x10ffff)) {
      throw new Error(`Line ${String(index + 1)} of the entity table is not "<name> <hex code point> ...".`);
    }
    entities.set(match[1], String.fromCodePoint(...codes));
  }
  return entities;
}

/** The named character references of the HTML standard. */
export const ENTITIES: Entities = parseEntities(readFileSync(new URL("entities.txt", import.meta.url), "utf8"));

const LONGEST_NAME = Math.max(0, ...[...ENTITIES.keys()].map((name) => name.length));
const REFERENCE = /&(#[xX][0-9A-Fa-f]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)/g;

/**
 * The numbers from 128 to 159 that HTML reads as windows-1252 characters
 * (the "numeric character reference end state" of the HTML standard). The
 * five numbers that windows-1252 leaves out stay as they are.
 */
const WINDOWS_1252: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);

/**
 * The character a numeric reference stands for, as HTML reads it: 0, a
 * surrogate and a number beyond Unicode give U+FFFD, and a number from 128
 * to 159 gives its windows-1252 character.
 */
function codePoint(value: number): string {
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(WINDOWS_1252.get(value) ?? value);
}

/**
 * The longest name that a reference starts with, and the rest after it, as
 * HTML reads it in text: "&notit;" is "¬it;", and "&ampx" is "&x".
 */
function named(candidate: string): string | undefined {
  for (let length = Math.min(candidate.length, LONGEST_NAME); length > 0; length -= 1) {
    const chars = ENTITIES.get(candidate.slice(0, length));
    if (chars !== undefined) {
      return chars + candidate.slice(length);
    }
  }
  return undefined;
}

/** The text with its character references decoded; a name that names nothing stays as it is. */
export function decodeEntities(text: string): string {
  return text.replace(REFERENCE, (whole, body: string) => {
    // parseInt reads the digits and stops at a ";".
    if (/^#[xX]/.test(body)) {
      return codePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return codePoint(Number.parseInt(body.slice(1), 10));
    }
    return named(body) ?? whole;
  });
}
