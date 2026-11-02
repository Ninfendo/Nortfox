// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the licence identifiers and files in place
// (docs/decisions/0004-licences.md): every source file names its licence in
// its first lines, MIT inside packages/client and AGPL-3.0-only everywhere
// else, each licence file is where it belongs, and the MIT licence names the
// NortFox authors as its holder.

/**
 * File types that carry an SPDX line: every kind of TypeScript and JavaScript
 * file, CSS, HTML, YAML, shell, SQL, .conf files and Dockerfiles. JSON and
 * Markdown cannot or need not.
 */
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|css|html|ya?ml|sh|sql|conf)$|^\.githooks\/|(?:^|\/)Dockerfile$/;

const TAG = "SPDX-License-Identifier:";

/** The end of an SPDX line that is not part of the licence: a comment's end and spaces. */
const LINE_END = /\s*(?:\*\/|-->)?\s*$/;

/**
 * The one file of those types that is not source: pnpm writes pnpm-lock.yaml
 * itself, and writes it whole again on each change, so a line added by hand
 * would not stay. pnpm-workspace.yaml is written by hand, so it carries the
 * line like every other file.
 */
const EXEMPT = new Set(["pnpm-lock.yaml"]);

export const MIT_FOLDER = "packages/client/";

/** The copyright line of the MIT licence. It names no person. */
export const COPYRIGHT_LINE = "Copyright (C) 2026 The NortFox authors";

export function expectedLicence(path: string): "MIT" | "AGPL-3.0-only" {
  return path.startsWith(MIT_FOLDER) ? "MIT" : "AGPL-3.0-only";
}

export function needsSpdx(path: string): boolean {
  return SOURCE.test(path) && !EXEMPT.has(path);
}

/**
 * The problems with one file, or none. Its first lines hold one SPDX line, and
 * that line names exactly the licence of its folder: one identifier, with no
 * OR, AND, WITH or parentheses.
 */
export function spdxProblem(path: string, text: string): string | undefined {
  if (!needsSpdx(path)) {
    return undefined;
  }
  const expected = expectedLicence(path);
  const lines = text
    .split("\n")
    .slice(0, 3)
    .filter((line) => line.includes(TAG));
  const [line] = lines;
  if (line === undefined) {
    return `${path} has no SPDX-License-Identifier line at the top. Add "SPDX-License-Identifier: ${expected}".`;
  }
  if (lines.length > 1) {
    return `${path} has ${String(lines.length)} SPDX-License-Identifier lines at the top. Keep one: "SPDX-License-Identifier: ${expected}".`;
  }
  // Everything after the tag, the space after the colon included, so only the exact form matches.
  const licence = line.slice(line.indexOf(TAG) + TAG.length).replace(LINE_END, "");
  if (licence !== ` ${expected}`) {
    return `${path} says "${licence.trim()}", but files there say exactly "SPDX-License-Identifier: ${expected}".`;
  }
  return undefined;
}

/** The package.json licence fields and licence files the repository must have. */
export function manifestProblems(read: (path: string) => string | undefined, packages: readonly string[]): string[] {
  const problems: string[] = [];
  for (const file of ["LICENSE", "packages/client/LICENSE"]) {
    if (read(file) === undefined) {
      problems.push(`${file} is missing.`);
    }
  }
  if (!(read("LICENSE") ?? "").includes("GNU AFFERO GENERAL PUBLIC LICENSE")) {
    problems.push("LICENSE is not the GNU Affero General Public License.");
  }
  const mit = read("packages/client/LICENSE") ?? "";
  if (!mit.includes("MIT License")) {
    problems.push("packages/client/LICENSE is not the MIT licence.");
  }
  const holders = mit.split(/\r?\n/).filter((line) => line.startsWith("Copyright "));
  if (holders.length !== 1 || holders[0] !== COPYRIGHT_LINE) {
    problems.push(`packages/client/LICENSE must name the holder in one line: "${COPYRIGHT_LINE}".`);
  }
  for (const manifest of packages) {
    const parsed: unknown = JSON.parse(read(manifest) ?? "{}");
    const licence = typeof parsed === "object" && parsed !== null && "license" in parsed ? parsed.license : undefined;
    const expected = expectedLicence(manifest);
    if (licence !== expected) {
      problems.push(`${manifest} must say "license": "${expected}".`);
    }
  }
  return problems;
}
