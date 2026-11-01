// SPDX-License-Identifier: AGPL-3.0-only

// Folds text so that a protected name matches however it is written: in any
// case, with accents, with look-alike letters from other scripts, with digits
// for letters, or with anything between its letters. The words on the list
// are folded the same way, so both sides meet in plain a to z.
//
// The look-alikes come from two places: the hand-made tables below, and
// confusables.txt, the characters that Unicode's confusables data (UTS #39)
// maps to Latin letters: letters, digits and symbols, such as "│" for l. A
// hand-made entry wins over the Unicode data.
//
// A symbol can stand for a letter or stand between letters. So foldings()
// reads a text both ways: with each look-alike symbol as its letters, and with
// it dropped like any other separator. A plain "|" is read as l only between
// two letters or digits, as in a word written with "|" for l. In Markdown
// tables, union types and shell pipes it stands between spaces, and there it
// is only a separator.
//
// Each table entry has a line of its own and maps a letter to the letter it
// looks like, so that a run of entries folds to doubled letters ("aabb") and
// spells no word.

import { readFileSync } from "node:fs";

/**
 * Capitals that look like a Latin capital. They are read before lower-casing,
 * because some lose the likeness in lower case: a Greek capital nu looks like
 * N, its small letter like v.
 */
const CAPITAL_LOOK_ALIKES = new Map<string, string>([
  // Greek
  ["Α", "A"],
  ["Β", "B"],
  ["Ε", "E"],
  ["Ζ", "Z"],
  ["Η", "H"],
  ["Ι", "I"],
  ["Κ", "K"],
  ["Μ", "M"],
  ["Ν", "N"],
  ["Ο", "O"],
  ["Ρ", "P"],
  ["Τ", "T"],
  ["Υ", "Y"],
  ["Χ", "X"],
  // Cyrillic
  ["А", "A"],
  ["В", "B"],
  ["Е", "E"],
  ["К", "K"],
  ["М", "M"],
  ["Н", "H"],
  ["О", "O"],
  ["Р", "P"],
  ["С", "C"],
  ["Т", "T"],
  ["Х", "X"],
  ["Ѕ", "S"],
  ["І", "I"],
  ["Ј", "J"],
  ["Ү", "Y"],
  ["Һ", "H"],
  ["Ӏ", "I"],
]);

/** Small letters from other scripts that look like a Latin letter. */
const LOOK_ALIKES = new Map<string, string>([
  // Cyrillic
  ["а", "a"],
  ["в", "b"],
  ["г", "r"],
  ["д", "d"],
  ["е", "e"],
  ["ё", "e"],
  ["з", "e"],
  ["и", "u"],
  ["й", "u"],
  ["к", "k"],
  ["л", "n"],
  ["м", "m"],
  ["н", "h"],
  ["о", "o"],
  ["п", "n"],
  ["р", "p"],
  ["с", "c"],
  ["т", "t"],
  ["у", "y"],
  ["х", "x"],
  ["ц", "u"],
  ["ч", "y"],
  ["ш", "w"],
  ["щ", "w"],
  ["ъ", "b"],
  ["ь", "b"],
  ["ѕ", "s"],
  ["і", "i"],
  ["ї", "i"],
  ["ј", "j"],
  ["ԁ", "d"],
  ["ԛ", "q"],
  ["ԝ", "w"],
  ["ү", "y"],
  ["һ", "h"],
  ["ӏ", "i"],
  ["ѡ", "w"],
  ["ҫ", "c"],
  // Greek
  ["α", "a"],
  ["β", "b"],
  ["γ", "y"],
  ["δ", "d"],
  ["ε", "e"],
  ["ζ", "z"],
  ["η", "n"],
  ["θ", "o"],
  ["ι", "i"],
  ["κ", "k"],
  ["μ", "u"],
  ["ν", "v"],
  ["ο", "o"],
  ["π", "n"],
  ["ρ", "p"],
  ["σ", "o"],
  ["ς", "c"],
  ["τ", "t"],
  ["υ", "u"],
  ["χ", "x"],
  ["ω", "w"],
  ["ϲ", "c"],
  ["ϳ", "j"],
  // Latin small capitals, which "small caps" text generators use. Unicode's
  // confusables data has only some of them.
  ["ᴀ", "a"],
  ["ʙ", "b"],
  ["ᴄ", "c"],
  ["ᴅ", "d"],
  ["ᴇ", "e"],
  ["ꜰ", "f"],
  ["ɢ", "g"],
  ["ʜ", "h"],
  ["ɪ", "i"],
  ["ᴊ", "j"],
  ["ᴋ", "k"],
  ["ʟ", "l"],
  ["ᴍ", "m"],
  ["ɴ", "n"],
  ["ᴏ", "o"],
  ["ᴘ", "p"],
  ["ꞯ", "q"],
  ["ʀ", "r"],
  ["ꜱ", "s"],
  ["ᴛ", "t"],
  ["ᴜ", "u"],
  ["ᴠ", "v"],
  ["ᴡ", "w"],
  ["ʏ", "y"],
  ["ᴢ", "z"],
  // Latin letters that do not decompose
  ["ı", "i"],
  ["ȷ", "j"],
  ["ł", "l"],
  ["ø", "o"],
  ["đ", "d"],
  ["ð", "d"],
  ["ħ", "h"],
  ["ŧ", "t"],
  ["ƀ", "b"],
  ["ɡ", "g"],
  ["ß", "ss"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["þ", "p"],
]);

/** Digits and symbols that stand in for letters. */
const STAND_INS = new Map<string, string>([
  ["0", "o"],
  ["1", "i"],
  ["3", "e"],
  ["4", "a"],
  ["5", "s"],
  ["7", "t"],
  ["$", "s"],
  // "1" can stand for both "i" and "l", so "l" and "i" are one letter here.
  ["l", "i"],
]);

const MARKS = /[\p{M}\p{Cf}]/gu;

/**
 * Letters in boxes and circles that NFKC leaves alone, and the regional
 * indicators that flags are made of: each block runs from A to Z.
 */
const ENCLOSED_LETTER_BLOCKS: readonly number[] = [
  0x1f150, // negative circled
  0x1f170, // negative squared
  0x1f1e6, // regional indicators
];

function enclosedLetter(char: string): string | undefined {
  const code = char.codePointAt(0) ?? 0;
  const block = ENCLOSED_LETTER_BLOCKS.find((first) => code >= first && code < first + 26);
  return block === undefined ? undefined : String.fromCharCode(0x61 + code - block);
}

/** True when a hand-made table reads the character: those entries win over the Unicode data. */
export function isHandMade(char: string): boolean {
  return (
    CAPITAL_LOOK_ALIKES.has(char) || LOOK_ALIKES.has(char) || STAND_INS.has(char) || enclosedLetter(char) !== undefined
  );
}

/** A table of look-alikes: a character outside ASCII and the folded letters it stands for. */
export type LookAlikes = ReadonlyMap<string, string>;

/**
 * Reads confusables.txt: "<hex code point> <letters>" per line; # starts a
 * comment. ASCII is read by the fold's own rules, so the table never maps it.
 */
export function parseLookAlikes(text: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const entry = line.replace(/#.*/, "").trim();
    if (entry === "") {
      continue;
    }
    const match = /^([0-9A-F]{4,6}) ([a-z]+)$/.exec(entry);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`Line ${String(index + 1)} of the look-alike table is not "<hex code point> <letters>".`);
    }
    const code = Number.parseInt(match[1], 16);
    if (code < 0x80) {
      throw new Error(`Line ${String(index + 1)} of the look-alike table maps an ASCII character.`);
    }
    table.set(String.fromCodePoint(code), match[2]);
  }
  return table;
}

/** The look-alikes from Unicode's confusables data. */
export const CONFUSABLES: LookAlikes = parseLookAlikes(
  readFileSync(new URL("confusables.txt", import.meta.url), "utf8"),
);

/** How a fold reads a look-alike symbol: as the letters it looks like, or as a separator. */
export type SymbolReading = "letters" | "separators";

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const ASCII_ONLY = /^\p{ASCII}*$/u;
/** A "|" with a letter or digit on each side, as in "ki|vant" for "kilvant". */
const BAR_IN_A_WORD = /(?<=[\p{L}\p{N}][\p{M}\p{Cf}]*)\|(?=\p{Cf}*[\p{L}\p{N}])/gu;
/** A text that may hold a look-alike symbol: one outside ASCII, or a "|". */
const MAY_HOLD_SYMBOL = /[^\p{ASCII}]|\|/u;

type Lookup = (char: string) => string | undefined;

function lookupIn(confusables: LookAlikes, symbols: SymbolReading): Lookup {
  return (char) => {
    const letters = confusables.get(char);
    return letters !== undefined && (symbols === "letters" || LETTER_OR_DIGIT.test(char)) ? letters : undefined;
  };
}

function letterFor(char: string, look: Lookup): string {
  // A small letter that is not in a table may be the small form of a capital
  // that is, as Cherokee small letters are.
  const mapped = LOOK_ALIKES.get(char) ?? look(char) ?? look(char.toUpperCase()) ?? char;
  return STAND_INS.get(mapped) ?? mapped;
}

/**
 * Folds one line: compatibility forms and accents go, letters become
 * lower case (look-alike capitals first become the Latin capital they look
 * like), look-alikes and stand-ins become the letter they stand for,
 * and everything that is not a to z (spaces, dots, dashes, other scripts) is
 * dropped. What is left is the line's letters, glued together. Look-alike
 * symbols are read as letters here; foldings() also reads them as separators.
 */
export function fold(text: string): string {
  return foldWith(text, CONFUSABLES);
}

/** The two readings of a text: look-alike symbols as letters, and as separators. */
export interface Foldings {
  readonly letters: string;
  readonly separators: string;
}

/** Folds a text both ways. The two are the same when it holds no look-alike symbol. */
export function foldings(text: string): Foldings {
  const letters = fold(text);
  return {
    letters,
    separators: MAY_HOLD_SYMBOL.test(text) ? foldWith(text, CONFUSABLES, "separators") : letters,
  };
}

/**
 * fold() with another table of Unicode look-alikes; the hand-made tables
 * always apply. The table is read before NFKC too, because NFKC turns some
 * look-alikes into a letter of another script: the Greek lunate sigma that
 * looks like C becomes a Σ, and so an o.
 */
export function foldWith(text: string, confusables: LookAlikes, symbols: SymbolReading = "letters"): string {
  const look = lookupIn(confusables, symbols);
  const read = symbols === "letters" && text.includes("|") ? text.replace(BAR_IN_A_WORD, "l") : text;
  const plain = ASCII_ONLY.test(read)
    ? read.toLowerCase()
    : read
        .replace(/./gsu, (char) => (CAPITAL_LOOK_ALIKES.has(char) || LOOK_ALIKES.has(char) ? char : (look(char) ?? char)))
        .normalize("NFKC")
        .normalize("NFD")
        .replace(MARKS, "")
        .replace(
          /./gsu,
          (char) => CAPITAL_LOOK_ALIKES.get(char) ?? LOOK_ALIKES.get(char) ?? enclosedLetter(char) ?? look(char) ?? char,
        )
        .toLowerCase()
        .normalize("NFD")
        .replace(MARKS, "");
  let out = "";
  for (const char of plain) {
    for (const letter of letterFor(char, look)) {
      if (letter >= "a" && letter <= "z") {
        out += letter;
      }
    }
  }
  return out;
}
