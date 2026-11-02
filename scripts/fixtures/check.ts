// SPDX-License-Identifier: AGPL-3.0-only

// Finds real-looking personal data in files: the fixture guard (docs/plan.md,
// step 1). A finding says where and what kind of value, never the value: the
// logs are public, and a real value must not reach them.

import { isUtf8 } from "node:buffer";
import type { SourceFile } from "../names/sources.ts";
import { decodeCp437, isBinary, isLfsPointer, LOCKFILE, LOCKFILE_DIGEST, pathReadings, readings, splitLines } from "../names/scan.ts";
import { escapeDecodings } from "./escapes.ts";
import { isListed, TEST_VALUES_FILE, type TestValues } from "./test-values.ts";
import { hasValueShape, valuesIn, valuesInPath, type Kind, type Value } from "./values.ts";

export type Reason = Kind | "binary" | "lfs" | "unreadable";

export interface Finding {
  readonly place: string;
  readonly reason: Reason;
}

/**
 * A text as it is and as it decodes: from base64, percent-encoding and HTML
 * character references, the way the names check reads it (readings), and from
 * the escapes of JSON and JavaScript, also inside what those decode to.
 */
export function textReadings(text: string): string[] {
  const all = new Set<string>();
  for (const reading of readings(text)) {
    all.add(reading);
    for (const unescaped of escapeDecodings(reading)) {
      for (const further of readings(unescaped)) {
        all.add(further);
      }
    }
  }
  return [...all];
}

/** The kinds of unlisted value that `find` gives in any reading of a text, in the order found. */
function unlisted(text: string, list: TestValues, find: (reading: string) => Value[]): Kind[] {
  const kinds = new Set<Kind>();
  for (const reading of textReadings(text)) {
    for (const value of find(reading)) {
      if (!isListed(value, list)) {
        kinds.add(value.kind);
      }
    }
  }
  return [...kinds];
}

/**
 * The kinds of unlisted value in a line, in the order found. Each line is read
 * as it is and as it decodes (textReadings): a test token, a URL or a JSON
 * file can carry an address in those forms.
 */
export function unlistedKinds(line: string, list: TestValues): Kind[] {
  return unlisted(line, list, valuesIn);
}

/**
 * The kinds of unlisted value in a file's path, read in the same forms as a
 * line, but more strictly (valuesInPath): each part on its own, and without
 * the exceptions of a line.
 */
export function unlistedPathKinds(path: string, list: TestValues): Kind[] {
  return unlisted(path, list, valuesInPath);
}

/**
 * Checks the readings of a text line by line: a line holds a kind when any
 * reading of it does, and the report names the lines in order. The readings
 * have the same lines, because a line break is the same byte in each. In
 * pnpm-lock.yaml the value of pnpm's own integrity key is left out first,
 * exactly where the names check reads it as a digest: random base64 that pnpm
 * computes, which can hold a run of digits that passes the checks by chance,
 * and never holds personal data.
 */
function scanReadings(texts: readonly string[], list: TestValues, placeOf: (line: number) => string, lockfile: boolean): Finding[] {
  const kindsByLine = new Map<number, Set<Kind>>();
  for (const text of texts) {
    for (const [index, raw] of splitLines(text).entries()) {
      const line = lockfile ? raw.replace(LOCKFILE_DIGEST, " ") : raw;
      for (const kind of unlistedKinds(line, list)) {
        kindsByLine.set(index, (kindsByLine.get(index) ?? new Set<Kind>()).add(kind));
      }
    }
  }
  return [...kindsByLine]
    .sort(([a], [b]) => a - b)
    .flatMap(([index, kinds]) => [...kinds].map((reason): Finding => ({ place: placeOf(index + 1), reason })));
}

/** Checks a text line by line, as one reading. */
export function scanText(text: string, list: TestValues, placeOf: (line: number) => string, lockfile = false): Finding[] {
  return scanReadings([text], list, placeOf, lockfile);
}

/** Windows-1252, in which Excel on Windows writes a CSV file. */
const WINDOWS_1252 = new TextDecoder("windows-1252");

/**
 * The texts a file is read as. A file that is UTF-8 is read as UTF-8 only.
 * Any other file is read as UTF-8, as Windows-1252 and as CP437. A SIE file
 * is CP437, and a CSV file from Excel on Windows is Windows-1252. Read as
 * UTF-8, a letter such as ö in those encodings breaks an address's domain,
 * so the address would pass. Windows-1252 has every letter of Latin-1, at the
 * same byte, and more, such as š and ž, so it stands in for the Latin-1
 * reading of the names check (fileTexts).
 *
 * A lone byte above ASCII, such as that ö between two ASCII letters, is never
 * UTF-8, so a file that holds one is read every way. A file that is UTF-8 is
 * not read the other ways: there, a ” right after an allowed address would
 * read as a letter (â in Windows-1252), and make its domain another one.
 */
export function fileReadings(bytes: Uint8Array): string[] {
  const utf8 = Buffer.from(bytes).toString("utf8");
  return isUtf8(bytes) ? [utf8] : [utf8, WINDOWS_1252.decode(bytes), decodeCp437(bytes)];
}

/**
 * Checks a file's path and its contents. When any reading of the path holds a
 * value, or only the shape of one, the report names the file by its alias, so
 * the log never shows that path. A binary file is refused, as the names check refuses it: the guard
 * cannot read compressed or encoded data, and would pass a value it cannot
 * see. It reads no binary type yet, so it refuses every one, known as the
 * names check knows it: by its first bytes, its extension or a control byte.
 * So are a Git LFS pointer, whose file is somewhere else, and a file whose
 * contents the guard cannot get, such as a submodule.
 */
export function scanFile(file: SourceFile, list: TestValues): Finding[] {
  const paths = pathReadings(file);
  const inPath = new Set(paths.flatMap((reading) => unlistedPathKinds(reading, list)));
  const shaped = paths.some((path) => textReadings(path).some(hasValueShape));
  const label = inPath.size > 0 || shaped ? file.alias : file.path;
  const findings: Finding[] = [...inPath].map((reason) => ({ place: `${label} (its path)`, reason }));
  if (file.unreadable === true) {
    return [...findings, { place: label, reason: "unreadable" }];
  }
  if (file.bytes === undefined) {
    return findings;
  }
  if (isLfsPointer(file.bytes)) {
    return [...findings, { place: label, reason: "lfs" }];
  }
  if (isBinary(file.bytes, file.path)) {
    return [...findings, { place: label, reason: "binary" }];
  }
  const texts = fileReadings(file.bytes);
  return [...findings, ...scanReadings(texts, list, (line) => `${label}:${String(line)}`, file.path === LOCKFILE)];
}

const REASONS: Readonly<Record<Reason, string>> = {
  "personal-identity-number": "holds a real-looking personal identity number (personnummer)",
  "coordination-number": "holds a real-looking coordination number (samordningsnummer)",
  "organisation-number": "holds a real-looking organisation number",
  email: "holds an e-mail address outside the reserved example domains",
  binary: "is a binary file of a type the fixture guard cannot read yet",
  lfs: "uses Git LFS, whose files the fixture guard cannot read",
  unreadable: "has contents the fixture guard cannot get, such as a submodule",
};

/** The report. It names the place and the kind of value, never the value. */
export function report(findings: readonly Finding[], files: number): string[] {
  const checked = `checked ${String(files)} files`;
  if (findings.length === 0) {
    return [`fixtures: ${checked}. Nothing found.`];
  }
  return [
    ...findings.map((finding) => `fixtures: ${finding.place} ${REASONS[finding.reason]}.`),
    `fixtures: ${checked}; ${String(findings.length)} to fix. The guard never shows what it found. ` +
      `Use a test value from ${TEST_VALUES_FILE}, or an address at example.com or under .test or .invalid.`,
  ];
}
