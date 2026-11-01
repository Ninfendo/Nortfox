// SPDX-License-Identifier: AGPL-3.0-only

// The owner path list (.github/owner-paths.txt): one glob per line, matched
// from the repository root. "**" matches any number of folders, "*" and "?"
// stay inside one folder or file name. All three match every character in a
// name, also a line break, U+2028 and U+2029: git and GitHub keep such a
// character in a path, and most views do not show it. A pattern without a
// slash matches at the root only. Matching ignores case as Unicode does, and
// each path is matched in capitals too, so LICENSE, License.md, license,
// LICENſE (a long s) and LıCENSE (a dotless i) all match: a laptop that
// ignores case may treat them as one file, and the owner should see every one
// of them.

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
  // "s": "." matches a line break too. "iu": case is ignored as Unicode folds it.
  return new RegExp(`${source}$`, "isu");
}

/** The paths that match at least one owner path, as they are or in capitals. */
export function ownerPathsIn(paths: readonly string[], globs: readonly string[]): string[] {
  const patterns = globs.map(globToRegExp);
  return paths.filter((path) =>
    [path, path.toUpperCase()].some((spelling) => patterns.some((pattern) => pattern.test(spelling))),
  );
}
