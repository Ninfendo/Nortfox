// SPDX-License-Identifier: AGPL-3.0-only

// Folds text so that a protected name matches however it is written: in any
// case, with accents, with look-alike letters from other scripts, with digits
// for letters, or with anything between its letters. The words on the list
// are folded the same way, so both sides meet in plain a to z.
//
// Each table entry has a line of its own, so that no line of this file can
// spell a word once it is folded.

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

function letterFor(char: string): string {
  const mapped = LOOK_ALIKES.get(char) ?? char;
  return STAND_INS.get(mapped) ?? mapped;
}

/**
 * Folds one line: compatibility forms and accents go, letters become
 * lower case (look-alike capitals first become the Latin capital they look
 * like), look-alikes and stand-ins become the letter they stand for,
 * and everything that is not a to z (spaces, dots, dashes, other scripts) is
 * dropped. What is left is the line's letters, glued together.
 */
export function fold(text: string): string {
  const plain = text
    .normalize("NFKC")
    .normalize("NFD")
    .replace(MARKS, "")
    .replace(/./gsu, (char) => CAPITAL_LOOK_ALIKES.get(char) ?? char)
    .toLowerCase()
    .normalize("NFD")
    .replace(MARKS, "");
  let out = "";
  for (const char of plain) {
    for (const letter of letterFor(char)) {
      if (letter >= "a" && letter <= "z") {
        out += letter;
      }
    }
  }
  return out;
}
