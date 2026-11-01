// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the licence identifiers and files in place
// (docs/decisions/0004-licences.md): every source file names its licence in
// its first lines, MIT inside packages/client and AGPL-3.0-only everywhere
// else, and each licence file is where it belongs.

/** File types that carry an SPDX line. JSON and Markdown cannot or need not. */
const SOURCE = /\.(?:ts|tsx|js|mjs|cjs|css|html|ya?ml|sh)$|^\.githooks\//;

/** Files that are not ours to label: the licence texts themselves and the like. */
const EXEMPT = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml"]);

export const MIT_FOLDER = "packages/client/";

export function expectedLicence(path: string): "MIT" | "AGPL-3.0-only" {
  return path.startsWith(MIT_FOLDER) ? "MIT" : "AGPL-3.0-only";
}

export function needsSpdx(path: string): boolean {
  return SOURCE.test(path) && !EXEMPT.has(path);
}

/** The problems with one file, or none. */
export function spdxProblem(path: string, text: string): string | undefined {
  if (!needsSpdx(path)) {
    return undefined;
  }
  const head = text.split("\n").slice(0, 3).join("\n");
  const match = /SPDX-License-Identifier: ([A-Za-z0-9.+-]+)/.exec(head);
  const expected = expectedLicence(path);
  if (match === null) {
    return `${path} has no SPDX-License-Identifier line at the top. Add "SPDX-License-Identifier: ${expected}".`;
  }
  if (match[1] !== expected) {
    return `${path} says ${String(match[1])}, but files there are ${expected}.`;
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
  if (!(read("packages/client/LICENSE") ?? "").includes("MIT License")) {
    problems.push("packages/client/LICENSE is not the MIT licence.");
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
