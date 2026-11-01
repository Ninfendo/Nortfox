// SPDX-License-Identifier: AGPL-3.0-only

// CODEOWNERS asks the owner to review exactly the owner paths
// (.github/owner-paths.txt): the database migrations, the licences and the
// exceptions to the names rule, and nothing else. CODEOWNERS matches case and
// the owner path list does not, so a name that may sit in any folder comes in
// the three spellings people write: LICENSE, license and License.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OWNER_PATHS_FILE, parseOwnerPaths } from "../approvals/owner-paths.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** The CODEOWNERS patterns that stand for one owner path glob. */
function codeownersPatterns(glob: string): string[] {
  if (glob.startsWith("**/")) {
    const name = glob.slice(3);
    const capitalised = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    return [...new Set([name, name.toLowerCase(), capitalised])];
  }
  if (glob.endsWith("/**")) {
    return [`/${glob.slice(0, -2)}`];
  }
  return [`/${glob}`];
}

/** What keeps a CODEOWNERS file from asking `owner` for exactly the owner paths. */
function codeownersProblems(codeowners: string, globs: readonly string[], owner: string): string[] {
  const rules = codeowners
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  const expected = new Set(globs.flatMap(codeownersPatterns));
  const listed = new Set(rules.map(([pattern = ""]) => pattern));
  return [
    ...[...expected].filter((pattern) => !listed.has(pattern)).map((pattern) => `CODEOWNERS lacks ${pattern}.`),
    ...[...listed].filter((pattern) => !expected.has(pattern)).map((pattern) => `CODEOWNERS lists ${pattern}, which is no owner path.`),
    ...rules
      .filter(([, ...owners]) => owners.join(" ") !== `@${owner}`)
      .map(([pattern = ""]) => `CODEOWNERS must give ${pattern} to @${owner} alone.`),
  ];
}

const owner = /^ {2}OWNER_LOGIN: (\S+)$/m.exec(read(".github/workflows/approvals.yml"))?.[1] ?? "";
const globs = parseOwnerPaths(read(OWNER_PATHS_FILE));

describe("CODEOWNERS", () => {
  it("asks the owner of the approval checks for exactly the owner paths", () => {
    expect(owner).not.toBe("");
    expect(codeownersProblems(read(".github/CODEOWNERS"), globs, owner)).toEqual([]);
  });

  it("stands for each kind of owner path glob", () => {
    expect(codeownersPatterns("**/LICENSE*")).toEqual(["LICENSE*", "license*", "License*"]);
    expect(codeownersPatterns("**/.protected-name-ok")).toEqual([".protected-name-ok"]);
    expect(codeownersPatterns("db/migrations/**")).toEqual(["/db/migrations/"]);
    expect(codeownersPatterns(".github/owner-paths.txt")).toEqual(["/.github/owner-paths.txt"]);
  });

  it("fails a missing path, a path that is no owner path and another owner", () => {
    const text = "# Owners\n\n/db/migrations/ @owner\r\n/.github/ @owner\nLICENSE* @someone\nlicense* @owner @someone\n";
    expect(codeownersProblems(text, ["db/migrations/**", "**/LICENSE*", ".github/owner-paths.txt"], "owner")).toEqual([
      "CODEOWNERS lacks License*.",
      "CODEOWNERS lacks /.github/owner-paths.txt.",
      "CODEOWNERS lists /.github/, which is no owner path.",
      "CODEOWNERS must give LICENSE* to @owner alone.",
      "CODEOWNERS must give license* to @owner alone.",
    ]);
  });
});
