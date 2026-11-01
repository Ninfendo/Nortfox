// SPDX-License-Identifier: AGPL-3.0-only

// The marker file. A folder that holds a `.protected-name-ok` marker may name
// one other system, but only when the folder is on the marker allowlist, which
// the check reads from the base branch (docs/decisions/0011-names-policy.md).
// A marker anywhere else is itself a finding, and silences nothing.

import type { Finding } from "./scan.ts";

export const MARKER = ".protected-name-ok";
export const ALLOWLIST_FILE = ".github/protected-name-allowlist.txt";

/** The allowlisted folders: one per line; empty lines and # comments are skipped. */
export function parseAllowlist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/\/+$/, ""));
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function isMarker(path: string): boolean {
  return path === MARKER || path.endsWith(`/${MARKER}`);
}

export interface MarkerVerdict {
  /** Allowlisted folders that hold a marker: their files may name the system. */
  readonly honoured: readonly string[];
  /** Markers outside the allowlist. */
  readonly findings: readonly Finding[];
}

/**
 * Sorts markers into honoured and refused. `markers` are every marker the
 * check can see, each with its path read as UTF-8 and any other readings of
 * it; `placeOf` names a refused marker for the report, by an alias when some
 * reading of its path holds a name.
 */
export function judgeMarkers<Marker extends { readonly path: string }>(
  markers: readonly Marker[],
  allowlist: readonly string[],
  placeOf: (marker: Marker) => string,
): MarkerVerdict {
  const honoured: string[] = [];
  const findings: Finding[] = [];
  for (const marker of markers) {
    const folder = folderOf(marker.path);
    if (folder !== "" && allowlist.includes(folder)) {
      honoured.push(folder);
    } else {
      findings.push({ place: placeOf(marker), reason: "marker" });
    }
  }
  return { honoured, findings };
}

/** The honoured folder a path lies in, if any. */
export function honouredFolderOf(path: string, honoured: readonly string[]): string | undefined {
  return honoured.find((folder) => path.startsWith(`${folder}/`));
}
