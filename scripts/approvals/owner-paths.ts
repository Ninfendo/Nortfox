// SPDX-License-Identifier: AGPL-3.0-only

// The owner path list (.github/owner-paths.txt): one glob per line, matched
// from the repository root. "**" matches any number of folders, "*" and "?"
// stay inside one folder or file name. A pattern without a slash matches at
// the root only.

export const OWNER_PATHS_FILE = ".github/owner-paths.txt";

export function parseOwnerPaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function escape(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

export function globToRegExp(glob: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (glob.startsWith("/**", index) && index + 3 === glob.length) {
      source += "(?:/.*)?";
      index += 3;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else {
      const char = glob.charAt(index);
      source += char === "*" ? "[^/]*" : char === "?" ? "[^/]" : escape(char);
      index += 1;
    }
  }
  return new RegExp(`${source}$`);
}

/** The paths that match at least one owner path. */
export function ownerPathsIn(paths: readonly string[], globs: readonly string[]): string[] {
  const patterns = globs.map(globToRegExp);
  return paths.filter((path) => patterns.some((pattern) => pattern.test(path)));
}
