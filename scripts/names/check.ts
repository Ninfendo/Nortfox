// SPDX-License-Identifier: AGPL-3.0-only

import { honouredFolderOf, judgeMarkers } from "./markers.ts";
import { lineHasName, scanField, scanFile, type Finding } from "./scan.ts";
import type { Source } from "./sources.ts";

/** Checks everything a source gathered. */
export function check(source: Source, words: readonly string[]): Finding[] {
  const aliases = new Map(source.files.map((file) => [file.path, file.alias]));
  const verdict = judgeMarkers(source.markers, source.allowlist, (path) =>
    lineHasName(path, words) ? (aliases.get(path) ?? "a marker file") : path,
  );
  const findings: Finding[] = [...verdict.findings];
  for (const file of source.files) {
    findings.push(
      ...scanFile({ ...file, honouredFolder: honouredFolderOf(file.path, verdict.honoured) }, words),
    );
  }
  for (const { field, text, alsoReadAs = [] } of source.fields) {
    // Each place once, however many readings of the field find something there.
    const places = new Set<string>();
    for (const reading of [text, ...alsoReadAs]) {
      for (const finding of scanField(reading, words, field)) {
        if (!places.has(finding.place)) {
          places.add(finding.place);
          findings.push(finding);
        }
      }
    }
  }
  return findings;
}

const REASONS: Readonly<Record<Finding["reason"], string>> = {
  name: "holds a protected name",
  marker: "is a .protected-name-ok marker outside the marker allowlist",
  binary: "is a binary file of a type the names check cannot read yet",
  lfs: "uses Git LFS, whose files the names check cannot read",
  unreadable: "has contents the names check cannot get, such as a submodule",
};

/**
 * The report. It names places only, never what was found there. Without
 * `showPlaces` it gives only how many places there are: for a PR from outside
 * the owner's account, a place would tell the author which line of their own
 * text matched, and so let anyone test guesses at the list.
 */
export function report(
  findings: readonly Finding[],
  checked: { files: number; fields: number },
  showPlaces = true,
): string[] {
  const counts = `${String(checked.files)} files and ${String(checked.fields)} texts`;
  if (findings.length === 0) {
    return [`names: checked ${counts}. Nothing found.`];
  }
  if (!showPlaces) {
    return [
      `names: checked ${counts}; ${String(findings.length)} to fix. For a PR from outside the owner's account the check does not say where. The owner finds the places with the list.`,
    ];
  }
  return [
    ...findings.map((finding) => `names: ${finding.place} ${REASONS[finding.reason]}.`),
    `names: checked ${counts}; ${String(findings.length)} to fix. The check never shows what it found. Reword the text at each place.`,
  ];
}
