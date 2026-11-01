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
  for (const { field, text } of source.fields) {
    findings.push(...scanField(text, words, field));
  }
  return findings;
}

const REASONS: Readonly<Record<Finding["reason"], string>> = {
  name: "holds a protected name",
  marker: "is a .protected-name-ok marker outside the marker allowlist",
  binary: "is a binary file of a type the names check cannot read yet",
};

/** The report. It names places only, never what was found there. */
export function report(findings: readonly Finding[], checked: { files: number; fields: number }): string[] {
  const counts = `${String(checked.files)} files and ${String(checked.fields)} texts`;
  if (findings.length === 0) {
    return [`names: checked ${counts}. Nothing found.`];
  }
  return [
    ...findings.map((finding) => `names: ${finding.place} ${REASONS[finding.reason]}.`),
    `names: checked ${counts}; ${String(findings.length)} to fix. The check never shows what it found. Reword the text at each place.`,
  ];
}
