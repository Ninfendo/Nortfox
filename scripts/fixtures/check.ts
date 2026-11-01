// SPDX-License-Identifier: AGPL-3.0-only

// Finds real-looking personal data in files: the fixture guard (docs/plan.md,
// step 1). A finding says where and what kind of value, never the value: the
// logs are public, and a real value must not reach them.

import type { SourceFile } from "../names/sources.ts";
import { isBinary, isLfsPointer, LOCKFILE, LOCKFILE_DIGEST, pathReadings, readings, splitLines } from "../names/scan.ts";
import { isListed, TEST_VALUES_FILE, type TestValues } from "./test-values.ts";
import { valuesIn, type Kind } from "./values.ts";

export type Reason = Kind | "binary" | "lfs" | "unreadable";

export interface Finding {
  readonly place: string;
  readonly reason: Reason;
}

/**
 * The kinds of unlisted value in a line, in the order found. Each line is read
 * as it is and as it decodes, from base64, percent-encoding and HTML
 * character references, the way the names check reads it: a test token or a
 * URL can carry an address in those forms.
 */
export function unlistedKinds(line: string, list: TestValues): Kind[] {
  const kinds = new Set<Kind>();
  for (const reading of readings(line)) {
    for (const value of valuesIn(reading)) {
      if (!isListed(value, list)) {
        kinds.add(value.kind);
      }
    }
  }
  return [...kinds];
}

/**
 * Checks a text line by line. In pnpm-lock.yaml the value of pnpm's own
 * integrity key is left out first, exactly where the names check reads it as
 * a digest: random base64 that pnpm computes, which can hold a run of digits
 * that passes the checks by chance, and never holds personal data.
 */
export function scanText(text: string, list: TestValues, placeOf: (line: number) => string, lockfile = false): Finding[] {
  const findings: Finding[] = [];
  for (const [index, raw] of splitLines(text).entries()) {
    const line = lockfile ? raw.replace(LOCKFILE_DIGEST, " ") : raw;
    for (const reason of unlistedKinds(line, list)) {
      findings.push({ place: placeOf(index + 1), reason });
    }
  }
  return findings;
}

/**
 * Checks a file's path and its contents. When any reading of the path holds a
 * value, the report names the file by its alias, so the log never shows the
 * path. A binary file is refused, as the names check refuses it: the guard
 * cannot read compressed or encoded data, and would pass a value it cannot
 * see. It reads no binary type yet, so it refuses every one, known as the
 * names check knows it: by its first bytes, its extension or a control byte.
 * So are a Git LFS pointer, whose file is somewhere else, and a file whose
 * contents the guard cannot get, such as a submodule.
 */
export function scanFile(file: SourceFile, list: TestValues): Finding[] {
  const inPath = new Set(pathReadings(file).flatMap((reading) => unlistedKinds(reading, list)));
  const label = inPath.size > 0 ? file.alias : file.path;
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
  // Every value the guard looks for is ASCII, so UTF-8 is the one reading it needs.
  const text = Buffer.from(file.bytes).toString("utf8");
  return [...findings, ...scanText(text, list, (line) => `${label}:${String(line)}`, file.path === LOCKFILE)];
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
