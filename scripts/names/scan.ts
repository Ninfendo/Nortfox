// SPDX-License-Identifier: AGPL-3.0-only

// Finds protected names in text and in files. A finding says where, never
// what: the logs are public.

import { fold } from "./fold.ts";

export type Reason = "name" | "marker" | "binary";

export interface Finding {
  readonly place: string;
  readonly reason: Reason;
}

/** Binary file types the check may pass without reading. None yet. */
export const READABLE_BINARY_EXTENSIONS: ReadonlySet<string> = new Set<string>();

const MAX_DEPTH = 2;
const BASE64_RUN = /[A-Za-z0-9+/_-]{4,}={0,2}/g;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const HAS_PERCENT = /%[0-9A-Fa-f]{2}/;
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z]+);/g;
const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);
// An integrity digest such as "sha512-5xoD..." in a lockfile is random, and the
// package manager checks it against the package, so it cannot carry chosen
// text. Folded, its 80-odd random letters would sooner or later spell a short
// name by chance, so the check reads the line without it. An allowlist of the
// digests that matched would not do: it would let anyone test a guess.
const INTEGRITY_DIGEST = /\bsha(?:1|256|384|512)-[A-Za-z0-9+/]{20,}={0,2}/g;
const PRINTABLE = /[\p{L}\p{N}\p{P}\p{S}\p{Zs}\t]/u;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Text that decodes from base64 and reads as text, not as random bytes. */
function readableText(bytes: Uint8Array): string | undefined {
  if (bytes.length < 3) {
    return undefined;
  }
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
  let printable = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    if (PRINTABLE.test(char)) {
      printable += 1;
    }
  }
  return printable / total >= 0.9 ? text : undefined;
}

function base64Decodings(line: string): string[] {
  const found: string[] = [];
  for (const [whole] of line.matchAll(BASE64_RUN)) {
    // "/" is a base64 letter and also a path separator, so each part between
    // slashes is tried on its own too.
    for (const run of new Set([whole, ...whole.split("/")])) {
      const standard = run.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
      for (let offset = 0; offset < 4 && standard.length - offset >= 4; offset += 1) {
        const text = readableText(Buffer.from(standard.slice(offset), "base64"));
        if (text !== undefined) {
          found.push(text);
        }
      }
    }
  }
  return found;
}

function percentDecoding(line: string): string | undefined {
  if (!HAS_PERCENT.test(line)) {
    return undefined;
  }
  return line.replace(PERCENT_RUN, (run) =>
    Buffer.from(run.replaceAll("%", ""), "hex").toString("utf8"),
  );
}

function entityDecoding(line: string): string | undefined {
  const decoded = line.replace(ENTITY, (whole, body: string) => {
    let char: string | undefined;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      char = codePoint(Number.parseInt(body.slice(2), 16));
    } else if (body.startsWith("#")) {
      char = codePoint(Number.parseInt(body.slice(1), 10));
    } else {
      char = NAMED_ENTITIES.get(body.toLowerCase());
    }
    return char ?? whole;
  });
  return decoded === line ? undefined : decoded;
}

function codePoint(value: number): string | undefined {
  return value <= 0x10ffff ? String.fromCodePoint(value) : undefined;
}

/** The line itself and what it decodes to, as base64, percent-encoding or HTML entities. */
export function readings(line: string, depth = 0): string[] {
  const out = [line];
  if (depth >= MAX_DEPTH) {
    return out;
  }
  const decoded = [percentDecoding(line), entityDecoding(line), ...base64Decodings(line)];
  for (const text of decoded) {
    if (text !== undefined) {
      out.push(...readings(text, depth + 1));
    }
  }
  return out;
}

/** True when some reading of the line holds a word, once folded. */
export function lineHasName(line: string, words: readonly string[]): boolean {
  return readings(line.replace(INTEGRITY_DIGEST, " ")).some((reading) => {
    const folded = fold(reading);
    return words.some((word) => folded.includes(word));
  });
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Checks a text line by line. `placeOf` names a line for the report; for a
 * one-line text it is called with line 0.
 */
export function scanText(
  text: string,
  words: readonly string[],
  placeOf: (line: number) => string,
): Finding[] {
  const lines = splitLines(text);
  const findings: Finding[] = [];
  for (const [index, line] of lines.entries()) {
    if (lineHasName(line, words)) {
      findings.push({ place: placeOf(lines.length === 1 ? 0 : index + 1), reason: "name" });
    }
  }
  return findings;
}

/** A text field such as a PR title: "PR title", or "PR body line 3". */
export function scanField(text: string, words: readonly string[], field: string): Finding[] {
  return scanText(text, words, (line) => (line === 0 ? field : `${field} line ${String(line)}`));
}

// Bytes 0x80 to 0xFF of code page 437. The last one, a no-break space, is
// written as a plain space: both are separators to the fold.
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeCp437(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte < 0x80 ? String.fromCharCode(byte) : (CP437_HIGH[byte - 0x80] ?? "");
  }
  return out;
}

/** The texts a file may be read as: UTF-8, and Latin-1 and CP437 when it has bytes above ASCII. */
export function fileTexts(bytes: Uint8Array): string[] {
  const texts = [Buffer.from(bytes).toString("utf8")];
  if (bytes.some((byte) => byte >= 0x80)) {
    texts.push(Buffer.from(bytes).toString("latin1"), decodeCp437(bytes));
  }
  return texts;
}

export function isBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export interface FileToCheck {
  readonly path: string;
  /** How to name the file when its path holds a name, for example "changed file 3". */
  readonly alias: string;
  readonly bytes: Uint8Array | undefined;
  /** The allowlisted folder whose marker covers this file, if any. */
  readonly honouredFolder: string | undefined;
}

/**
 * Checks a file's path and its contents. When the path holds a name, the
 * report names the file by its alias, so the log never shows the path.
 */
export function scanFile(file: FileToCheck, words: readonly string[]): Finding[] {
  const pathToCheck = file.honouredFolder ?? file.path;
  const pathHasName = lineHasName(pathToCheck, words);
  const label = pathHasName ? file.alias : file.path;
  const findings: Finding[] = [];
  if (pathHasName) {
    findings.push({ place: `${label} (its path)`, reason: "name" });
  }
  if (file.honouredFolder !== undefined || file.bytes === undefined) {
    return findings;
  }
  if (isBinary(file.bytes)) {
    if (!READABLE_BINARY_EXTENSIONS.has(extensionOf(file.path))) {
      findings.push({ place: label, reason: "binary" });
    }
    return findings;
  }
  const seen = new Set<string>();
  for (const text of fileTexts(file.bytes)) {
    for (const finding of scanText(text, words, (line) => `${label}:${String(Math.max(line, 1))}`)) {
      if (!seen.has(finding.place)) {
        seen.add(finding.place);
        findings.push(finding);
      }
    }
  }
  return findings;
}
