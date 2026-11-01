// SPDX-License-Identifier: AGPL-3.0-only

// Finds protected names in text and in files. A finding says where, never
// what: the logs are public.

import { isUtf8 } from "node:buffer";
import { decodeEntities } from "./entities.ts";
import { foldings, type Foldings } from "./fold.ts";

export type Reason = "name" | "marker" | "binary" | "lfs" | "unreadable";

export interface Finding {
  readonly place: string;
  readonly reason: Reason;
}

/** Binary file types the check may pass without reading. None yet. */
export const READABLE_BINARY_EXTENSIONS: ReadonlySet<string> = new Set<string>();

/** The one file whose integrity digests are read only by their base64. */
export const LOCKFILE = "pnpm-lock.yaml";

const MAX_DEPTH = 2;
const BASE64_RUN = /[A-Za-z0-9+/_-]{4,}={0,2}/g;
// A base64 run this long that decodes to bytes rather than text is also
// searched for runs of printable characters: a data: URI can carry a picture
// whose text chunks hold a name.
const LONG_BASE64_RUN = 24;
const PRINTABLE_RUN = /[ -~\t]{6,}/g;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const HAS_PERCENT = /%[0-9A-Fa-f]{2}/;
// pnpm-lock.yaml holds an integrity digest for every package, which pnpm
// writes as "    resolution: {integrity: sha512-" and 86 base64 letters. A
// digest is data, so it is read the way base64 is read: decoded, and what it
// decodes to is searched. Its letters are not also read as words, because so
// many random letters spell a short word by chance sooner or later. A digest
// is read this way only in that file, only at the exact length of its
// algorithm, and only as the value of pnpm's own integrity key at the start of
// a line: "resolution: {integrity: <digest>" followed by "," or "}", or
// "integrity: <digest>" alone. Everywhere else, also on a comment line, later
// on the line or in another key, a run shaped like a digest is read like any
// other text.
const DIGEST = "sha(?:1-[A-Za-z0-9+/]{27}=|256-[A-Za-z0-9+/]{43}=|384-[A-Za-z0-9+/]{64}|512-[A-Za-z0-9+/]{86}==)";
const LOCKFILE_DIGEST = new RegExp(
  `(?<=^ +resolution: \\{integrity: )${DIGEST}(?=[,}])|(?<=^ +integrity: )${DIGEST}$`,
);
const PRINTABLE = /[\p{L}\p{N}\p{P}\p{S}\p{Zs}\t]/u;

/** Text that decodes from base64 and reads as text, not as random bytes. */
function readableText(bytes: Buffer): string | undefined {
  if (bytes.length < 3 || !isUtf8(bytes)) {
    return undefined;
  }
  const text = bytes.toString("utf8");
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

interface Decodings {
  /** Texts to read and decode further. */
  readonly texts: string[];
  /** Printable runs from bytes that are not text: read, never decoded further. */
  readonly runs: string[];
}

function base64Decodings(line: string): Decodings {
  const found: Decodings = { texts: [], runs: [] };
  for (const [whole] of line.matchAll(BASE64_RUN)) {
    // "/" is a base64 letter and also a path separator, so each part between
    // slashes is tried on its own too.
    for (const run of new Set([whole, ...whole.split("/")])) {
      const standard = run.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
      for (let offset = 0; offset < 4 && standard.length - offset >= 4; offset += 1) {
        const bytes = Buffer.from(standard.slice(offset), "base64");
        const text = readableText(bytes);
        if (text !== undefined) {
          found.texts.push(text);
        } else if (standard.length - offset >= LONG_BASE64_RUN) {
          found.runs.push(...(bytes.toString("latin1").match(PRINTABLE_RUN) ?? []));
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
  if (!line.includes("&")) {
    return undefined;
  }
  const decoded = decodeEntities(line);
  return decoded === line ? undefined : decoded;
}

/** What a line decodes to, as base64, percent-encoding or HTML entities. */
function decodedReadings(line: string, depth: number): string[] {
  const out: string[] = [];
  if (depth >= MAX_DEPTH) {
    return out;
  }
  const base64 = base64Decodings(line);
  for (const text of [percentDecoding(line), entityDecoding(line), ...base64.texts]) {
    if (text !== undefined) {
      out.push(text, ...decodedReadings(text, depth + 1));
    }
  }
  out.push(...base64.runs);
  return out;
}

/** The line with its percent-encoding and HTML entities decoded where they stand. */
function decodedInPlace(line: string): string {
  const percent = percentDecoding(line) ?? line;
  return entityDecoding(percent) ?? percent;
}

/** The line itself and what it decodes to, as base64, percent-encoding or HTML entities. */
export function readings(line: string): string[] {
  return [line, ...decodedReadings(line, 0)];
}

function hasWord(folded: string, words: readonly string[]): boolean {
  return words.some((word) => folded.includes(word));
}

function foldsToWord(folded: Foldings, words: readonly string[]): boolean {
  return hasWord(folded.letters, words) || (folded.separators !== folded.letters && hasWord(folded.separators, words));
}

/** True when the text holds a word once folded, with look-alike symbols read as letters or as separators. */
function hasName(text: string, words: readonly string[]): boolean {
  return foldsToWord(foldings(text), words);
}

/** True when some reading of the line holds a word, once folded. */
export function lineHasName(line: string, words: readonly string[]): boolean {
  return readings(line).some((reading) => hasName(reading, words));
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

interface Line {
  /** The line as text. */
  readonly plain: string;
  /** Digests taken out of the line, read only by their base64. */
  readonly digests: readonly string[];
}

/** One line of pnpm-lock.yaml: the line without its digest, and the digest. */
function lockfileLine(line: string): Line {
  const digest = LOCKFILE_DIGEST.exec(line)?.[0];
  return digest === undefined
    ? { plain: line, digests: [] }
    : { plain: line.replace(LOCKFILE_DIGEST, " "), digests: [digest.slice(digest.indexOf("-") + 1)] };
}

/** What a line and its digests decode to. */
function decodedLine({ plain, digests }: Line): string[] {
  const out = decodedReadings(plain, 0);
  for (const digest of digests) {
    const base64 = base64Decodings(digest);
    for (const text of base64.texts) {
      out.push(text, ...decodedReadings(text, 1));
    }
    out.push(...base64.runs);
  }
  return out;
}

/**
 * The lines on which a word starts that runs on into the next line or
 * lines: a name wrapped in a commit message or a paragraph.
 */
function linesAcross(folded: readonly string[], words: readonly string[]): number[] {
  const starts: number[] = [];
  let length = 0;
  for (const letters of folded) {
    starts.push(length);
    length += letters.length;
  }
  // The line that holds a letter is the last line that starts at or before
  // it: an empty line starts where the next line does.
  const lineAt = (position: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= position) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  };
  const joined = folded.join("");
  const found: number[] = [];
  for (const word of words) {
    for (let at = joined.indexOf(word); at !== -1; at = joined.indexOf(word, at + 1)) {
      const first = lineAt(at);
      if (first !== lineAt(at + word.length - 1)) {
        found.push(first);
      }
    }
  }
  return found;
}

// The indentation and the quote or comment markers in front of a line: "  ",
// "> ", "# ", "// ", " * ", "-- " or "; ". ">" also counts without a space
// after it. The others need a space or the end of the line, because "//" and
// "--" also start base64, and "#" and ";" are parts of an entity.
const LINE_PREFIX = /^[ \t]*(?:(?:>+|(?:#+|\/\/+|--|;+|\*)(?=[ \t]|$))[ \t]*)*/;

/** One piece of a wrapped encoding: a word of a line, or the whole line. */
interface Piece {
  readonly line: number;
  readonly text: string;
}

/**
 * The runs of text that go on from one line into the next: the last word of
 * a line, every following line that is one word, and the first word of the
 * line after them. A base64 blob wrapped at 76 columns is one run, with the
 * indentation or the quote or comment markers of its lines left out.
 */
function wrappedRuns(lines: readonly string[]): Piece[][] {
  const runs: Piece[][] = [];
  let run: Piece[] = [];
  const end = (): void => {
    if (run.length > 1) {
      runs.push(run);
    }
    run = [];
  };
  for (const [line, text] of lines.entries()) {
    const words = text.replace(LINE_PREFIX, "").trim().split(/\s+/);
    const first = words[0] ?? "";
    const last = words[words.length - 1] ?? "";
    if (first === "") {
      end();
      continue;
    }
    if (run.length > 0) {
      run.push({ line, text: first });
    }
    if (words.length > 1) {
      end();
    }
    if (words.length > 1 || run.length === 0) {
      run.push({ line, text: last });
    }
  }
  end();
  return runs;
}

/** The widest window of pieces in which the check looks for where a wrapped name starts. */
const MAX_WINDOW = 32;

type DecodesToName = (pieces: readonly Piece[]) => boolean;

/**
 * The lines on which a name starts in a stretch of pieces that decodes to
 * one: the first line of each window of pieces that decodes to a name while
 * no smaller window inside it does. When no window up to MAX_WINDOW pieces
 * does, the name starts somewhere in the stretch, and its first line is given.
 */
function whereNamesStart(stretch: readonly Piece[], decodesToName: DecodesToName): number[] {
  // A window "holds" a name when it, or a window inside it, decodes to one.
  let holds = stretch.map((piece) => decodesToName([piece]));
  // A single piece that decodes to a name is found on its own line already.
  const single = holds.includes(true);
  const found: number[] = [];
  for (let width = 2; width <= Math.min(stretch.length, MAX_WINDOW); width += 1) {
    const wider: boolean[] = [];
    for (let first = 0; first + width <= stretch.length; first += 1) {
      const inside = holds[first] === true || holds[first + 1] === true;
      const hit = !inside && decodesToName(stretch.slice(first, first + width));
      if (hit) {
        found.push(stretch[first]?.line ?? 0);
      }
      wider.push(inside || hit);
    }
    holds = wider;
  }
  return found.length === 0 && !single ? [stretch[0]?.line ?? 0] : found;
}

/**
 * The lines on which an encoding that is wrapped across lines starts to
 * spell a word: base64, percent-encoding or HTML entities, put back together
 * before they are decoded. A long run is searched in stretches of twice
 * MAX_WINDOW pieces that overlap by MAX_WINDOW, so that a name in a long blob
 * is placed without decoding every window of the blob.
 */
function wrappedEncodings(lines: readonly string[], words: readonly string[]): number[] {
  const decodesToName: DecodesToName = (pieces) =>
    decodedReadings(pieces.map((piece) => piece.text).join(""), 0).some((reading) => hasName(reading, words));
  const found: number[] = [];
  for (const run of wrappedRuns(lines)) {
    let hit = false;
    for (let first = 0; ; first += MAX_WINDOW) {
      const stretch = run.slice(first, first + 2 * MAX_WINDOW);
      if (decodesToName(stretch)) {
        hit = true;
        found.push(...whereNamesStart(stretch, decodesToName));
      }
      if (first + 2 * MAX_WINDOW >= run.length) {
        break;
      }
    }
    // A name wider than a stretch.
    if (!hit && run.length > 2 * MAX_WINDOW && decodesToName(run)) {
      found.push(run[0]?.line ?? 0);
    }
  }
  return found;
}

export interface ScanOptions {
  /** The text is pnpm-lock.yaml: its integrity digests are read only by their base64. */
  readonly lockfile?: boolean;
}

/**
 * Checks a text line by line, and across line breaks. `placeOf` names a line
 * for the report; for a one-line text it is called with line 0.
 */
export function scanText(
  text: string,
  words: readonly string[],
  placeOf: (line: number) => string,
  options: ScanOptions = {},
): Finding[] {
  const lines = splitLines(text).map((line): Line =>
    options.lockfile === true ? lockfileLine(line) : { plain: line, digests: [] },
  );
  const hits = new Set<number>();
  // The folded letters of every line, read four ways, for the words that run
  // on across line breaks: the line as it is and with its percent-encoding
  // and entities decoded where they stand, each with look-alike symbols read
  // as letters and as separators.
  const across: string[][] = [[], [], [], []];
  for (const [index, line] of lines.entries()) {
    const own = foldings(line.plain);
    const inPlace = decodedInPlace(line.plain);
    const decoded = inPlace === line.plain ? own : foldings(inPlace);
    [own.letters, own.separators, decoded.letters, decoded.separators].forEach((letters, way) => {
      across[way]?.push(letters);
    });
    if (foldsToWord(own, words) || decodedLine(line).some((reading) => hasName(reading, words))) {
      hits.add(index);
    }
  }
  for (const [way, folded] of across.entries()) {
    if (way === 0 || folded.some((letters, index) => letters !== across[0]?.[index])) {
      for (const index of linesAcross(folded, words)) {
        hits.add(index);
      }
    }
  }
  for (const index of wrappedEncodings(lines.map((line) => line.plain), words)) {
    hits.add(index);
  }
  return [...hits]
    .sort((a, b) => a - b)
    .map((index) => ({ place: placeOf(lines.length === 1 ? 0 : index + 1), reason: "name" }));
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

/**
 * The first bytes of file types that hold compressed or encoded data: PDF,
 * zip (and the office formats and jars built on it), gzip, zlib, bzip2, xz,
 * zstd, 7-Zip, RAR, PNG, JPEG, GIF, RIFF (WebP, WAV, AVI), Ogg, the web
 * fonts, OpenType, ELF and Java classes.
 */
const MAGIC_NUMBERS: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0x1f, 0x8b],
  [0x78, 0x01],
  [0x78, 0x5e],
  [0x78, 0x9c],
  [0x78, 0xda],
  [0x42, 0x5a, 0x68],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a],
  [0x28, 0xb5, 0x2f, 0xfd],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x52, 0x61, 0x72, 0x21],
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
  [0x52, 0x49, 0x46, 0x46],
  [0x4f, 0x67, 0x67, 0x53],
  [0x77, 0x4f, 0x46, 0x46],
  [0x77, 0x4f, 0x46, 0x32],
  [0x4f, 0x54, 0x54, 0x4f],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xca, 0xfe, 0xba, 0xbe],
];

/** Extensions of binary file types, refused whatever their bytes look like. */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "7z a apk avi avif bin bmp br bz2 class dll dmg doc docx dylib eot epub exe flac gif gz heic ico iso " +
    "jar jpeg jpg lz lz4 m4a mov mp3 mp4 o odp ods odt ogg otf pdf png ppt pptx psd rar so sqlite tar " +
    "tgz tif tiff ttf war wasm wav webm webp woff woff2 xls xlsx xz zip zst"
  ).split(" "),
);

/** A control byte that text never holds: everything below space but tab, newlines, form feed and escape, and DEL. */
function isControlByte(byte: number): boolean {
  return (byte < 0x20 && ![0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b].includes(byte)) || byte === 0x7f;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** A file the check cannot read as text: by its extension, its first bytes, or a control byte. */
export function isBinary(bytes: Uint8Array, path = ""): boolean {
  return (
    BINARY_EXTENSIONS.has(extensionOf(path)) ||
    MAGIC_NUMBERS.some((magic) => magic.every((byte, index) => bytes[index] === byte)) ||
    bytes.some(isControlByte)
  );
}

const LFS_POINTER = "version https://git-lfs.github.com/spec/";
const LFS_ATTRIBUTE = /(?:^|\s)filter=lfs(?:\s|$)/;

/** A Git LFS pointer: the check would read the pointer, never the file it points to. */
export function isLfsPointer(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, LFS_POINTER.length)).toString("latin1") === LFS_POINTER;
}

export interface FileToCheck {
  readonly path: string;
  /** How to name the file when its path holds a name, for example "changed file 3". */
  readonly alias: string;
  readonly bytes: Uint8Array | undefined;
  /** True when the file has contents the check cannot get, such as a blob the API does not give. */
  readonly unreadable?: boolean;
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
  if (file.honouredFolder !== undefined) {
    return findings;
  }
  if (file.unreadable === true) {
    findings.push({ place: label, reason: "unreadable" });
    return findings;
  }
  if (file.bytes === undefined) {
    return findings;
  }
  if (isLfsPointer(file.bytes)) {
    findings.push({ place: label, reason: "lfs" });
    return findings;
  }
  if (isBinary(file.bytes, file.path)) {
    if (!READABLE_BINARY_EXTENSIONS.has(extensionOf(file.path))) {
      findings.push({ place: label, reason: "binary" });
    }
    return findings;
  }
  const seen = new Set<string>();
  const options = { lockfile: file.path === LOCKFILE };
  for (const text of fileTexts(file.bytes)) {
    for (const finding of scanText(text, words, (line) => `${label}:${String(Math.max(line, 1))}`, options)) {
      if (!seen.has(finding.place)) {
        seen.add(finding.place);
        findings.push(finding);
      }
    }
  }
  if (file.path === ".gitattributes" || file.path.endsWith("/.gitattributes")) {
    for (const [index, line] of splitLines(Buffer.from(file.bytes).toString("utf8")).entries()) {
      if (LFS_ATTRIBUTE.test(line.replace(/#.*/, ""))) {
        findings.push({ place: `${label}:${String(index + 1)}`, reason: "lfs" });
      }
    }
  }
  return findings;
}
