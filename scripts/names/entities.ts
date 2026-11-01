// SPDX-License-Identifier: AGPL-3.0-only

// Decodes HTML character references as a browser does in text, and as GitHub
// does when it shows a Markdown file or a PR body: numeric ones ("&#122;",
// "&#x7a;", also without the ";") and every named one in the HTML standard
// ("&zopf;" is a double-struck z). The names come from entities.txt.

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

function codePoint(value: number): string | undefined {
  return value <= 0x10ffff ? String.fromCodePoint(value) : undefined;
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

/** The text with its character references decoded; a reference that names nothing stays as it is. */
export function decodeEntities(text: string): string {
  return text.replace(REFERENCE, (whole, body: string) => {
    // parseInt reads the digits and stops at a ";".
    if (/^#[xX]/.test(body)) {
      return codePoint(Number.parseInt(body.slice(2), 16)) ?? whole;
    }
    if (body.startsWith("#")) {
      return codePoint(Number.parseInt(body.slice(1), 10)) ?? whole;
    }
    return named(body) ?? whole;
  });
}
