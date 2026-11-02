// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideCiOk, decideLabelHolds, decideOutsideApproval, decideOwnerOk } from "./decide.ts";
import { globToRegExp, ownerPathsIn, parseOwnerPaths } from "./owner-paths.ts";

/** The repository's own list, as the workflow reads it from the default branch. */
const GLOBS = parseOwnerPaths(readFileSync(new URL("../../.github/owner-paths.txt", import.meta.url), "utf8"));

/** A sample list, not the repository's: it shows how globs match. */
const SAMPLE = parseOwnerPaths(
  [
    "# A sample list",
    "",
    "**/LICENSE*",
    "**/LICENCE*",
    "**/COPYING*",
    "**/.protected-name-ok",
    ".github/protected-name-allowlist.txt",
    ".github/owner-paths.txt",
  ].join("\n"),
);

describe("owner paths", () => {
  it("reads one glob per line, without comments", () => {
    expect(parseOwnerPaths("# Owner paths\n\ndb/migrations/**\r\n  LICENSE  \n")).toEqual(["db/migrations/**", "LICENSE"]);
  });

  it("are none: of all PRs, only those from outside contributors need the owner", () => {
    expect(GLOBS).toEqual([]);
  });

  it.each([
    // The database.
    ["db/migrations/0001_start.sql", false],
    ["db/seed.sql", false],
    // The licences, in any case and at any depth.
    ["LICENSE", true],
    ["packages/client/LICENSE", true],
    ["packages/client/LICENSE.md", true],
    ["packages/client/LICENCE", true],
    ["packages/client/license.md", true],
    ["License.txt", true],
    ["COPYING", true],
    ["apps/web/copying.lesser", true],
    // The exceptions to the names rule, and the list.
    ["adapters/a1/.protected-name-ok", true],
    [".protected-name-ok", true],
    [".github/protected-name-allowlist.txt", true],
    [".GitHub/owner-paths.txt", true],
    [".github/owner-paths.txt", true],
    ["docs/.github/protected-name-allowlist.txt", false],
    ["docs/.github/owner-paths.txt", false],
    // Anything else.
    [".github/workflows/ci.yml", false],
    [".github/workflows/approvals.yml", false],
    [".github/CODEOWNERS", false],
    ["scripts/approvals/owner-paths.ts", false],
    ["scripts/names/check.ts", false],
    [".githooks/pre-commit", false],
    ["package.json", false],
    ["pnpm-workspace.yaml", false],
    ["tsconfig.json", false],
    ["eslint.config.js", false],
    ["vitest.config.ts", false],
    ["CLAUDE.md", false],
    ["AGENTS.md", false],
    ["docs/decisions/0011-names-policy.md", false],
    ["apps/server/src/modules/auth/login.ts", false],
    ["packages/client/openapi.json", false],
    ["packages/engine/src/money.ts", false],
    ["packages/engine/src/ledger/checks.ts", false],
    ["README.md", false],
  ])("%s matches the sample list: %s", (path, expected) => {
    expect(ownerPathsIn([path], SAMPLE).length > 0).toBe(expected);
    // The repository's own list is empty, so no path is an owner path, and Owner OK passes on Names alone.
    expect(ownerPathsIn([path], GLOBS)).toEqual([]);
    expect(decideOwnerOk({ namesResult: "success", paths: [path], globs: GLOBS, labels: [] })).toEqual({
      pass: true,
      why: "The PR changes no owner path.",
      ownerPaths: [],
    });
  });

  it.each([
    // A line break or a line separator in a name: git and GitHub keep it, and most views do not show it.
    "LICENCE .md",
    "docs/COPYING\n.txt",
    "docs/LICENCE\r",
    "x y/LICENCE",
    "\r\n/.protected-name-ok",
    "a\rb/COPYING",
    "x y/LICENSE",
    "packages/client/LICENSE\n.md",
    "x\ny/.protected-name-ok",
    // A letter that Unicode's case folding, or capitals, read as an ASCII one.
    "packages/client/LICENſE",
    "packages/client/LıCENSE",
    "adapters/a1/.protected-name-oK",
    ".github/protected-name-allowliﬆ.txt",
  ])("finds the sample owner path %j, and Owner OK fails on it without the label", (path) => {
    expect(ownerPathsIn([path], SAMPLE)).toEqual([path]);
    expect(decideOwnerOk({ namesResult: "success", paths: [path], globs: SAMPLE, labels: [] })).toEqual({
      pass: false,
      why: "The PR changes owner paths. Owner OK passes when the owner sets the owner-ok label.",
      ownerPaths: [path],
    });
  });

  it("lets *, ? and ** match a line break, U+2028 and U+2029, but never a slash", () => {
    for (const char of ["\n", "\r", " ", " "]) {
      expect(globToRegExp("a/?.ts").test(`a/${char}.ts`)).toBe(true);
      expect(globToRegExp("a/*.ts").test(`a/b${char}c.ts`)).toBe(true);
      expect(globToRegExp("a/**").test(`a/b${char}/c`)).toBe(true);
      expect(globToRegExp("**/b").test(`a${char}/b`)).toBe(true);
      expect(globToRegExp("a**b").test(`a${char}/${char}b`)).toBe(true);
    }
    expect(globToRegExp("a/?.ts").test("a///.ts")).toBe(false);
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false);
  });

  it("matches a folder glob for the folder and everything in it, in any case, and nothing beside it", () => {
    const inside = [
      "db/migrations/0001_start.sql",
      "db/migrations/sub/x.sql",
      "db/migrations",
      "DB/Migrations/0001_start.sql",
      "db/migrations/a .sql",
      "db/migrations/a\n.sql",
      "db/migrations/a\r.sql",
      "db/migrations/x y/b.sql",
      "db/migrations/\r\n",
    ];
    expect(ownerPathsIn([...inside, "db/migrationsx/a.sql", "db/seed.sql"], ["db/migrations/**"])).toEqual(inside);
  });

  it("matches a pattern without a slash at the root only", () => {
    expect(ownerPathsIn(["CLAUDE.md", "docs/CLAUDE.md", "claude.md"], ["CLAUDE.md"])).toEqual(["CLAUDE.md", "claude.md"]);
  });

  it("supports ? and ** inside a path, and escapes the rest", () => {
    expect(globToRegExp("a/?.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("a/?.ts").test("a/bc.ts")).toBe(false);
    expect(globToRegExp("a/**.md").test("a/b/c.md")).toBe(true);
    expect(globToRegExp("a+(b).md").test("a+(b).md")).toBe(true);
    expect(globToRegExp("a.md").test("aXmd")).toBe(false);
  });
});

describe("Outside approval", () => {
  const head = "h1";
  const here = { fullName: "owner/r", owner: "owner" };
  const base = { owner: "owner", author: "someone", repository: "owner/r", head: here, headSha: head };
  const FORK =
    "The owner opened this PR from a branch in another account's fork, and that account can push to it. So it needs the owner's approval of its head commit, which GitHub does not let the owner give to their own PR. To take the work over, make the changes again as new commits on your own machine, where the git hooks check them, run pnpm names, and push those commits to a branch in this repository. Never push that account's commits or branch here: on a PR from the owner's account, Names shows where it finds a name, also in text that the other account wrote.";

  it("passes a PR that the owner opened from a branch in this repository, or in the owner's own fork", () => {
    for (const where of [base, { ...base, repository: "org/r", head: { fullName: "owner/r", owner: "owner" } }]) {
      expect(decideOutsideApproval({ ...where, author: "owner", reviews: [] })).toEqual({
        pass: true,
        why: "The PR comes from the owner's account.",
      });
    }
  });

  it("counts a PR that the owner opened from another account's fork, or from a fork that is gone, as from outside", () => {
    for (const fork of [{ fullName: "someone/r", owner: "someone" }, undefined]) {
      const owners = { ...base, author: "owner", head: fork };
      expect(decideOutsideApproval({ ...owners, reviews: [] })).toEqual({ pass: false, why: FORK });
      expect(decideOutsideApproval({ ...owners, reviews: [{ login: "owner", state: "COMMENTED", commitId: head }] })).toEqual({
        pass: false,
        why: FORK,
      });
      // GitHub does not let an author approve their own PR. If it ever did, the approval would count as for any other PR.
      expect(decideOutsideApproval({ ...owners, reviews: [{ login: "owner", state: "APPROVED", commitId: head }] })).toEqual({
        pass: true,
        why: "The owner approved this PR's head commit.",
      });
    }
  });

  it("never counts a PR from another author as the owner's, wherever its branch is", () => {
    expect(decideOutsideApproval({ ...base, reviews: [] })).toEqual({ pass: false, why: "The owner has not approved this PR yet." });
  });

  it("passes when the owner's latest deciding review approves the head commit", () => {
    const verdict = decideOutsideApproval({
      ...base,
      reviews: [
        { login: "owner", state: "CHANGES_REQUESTED", commitId: "h0" },
        { login: "owner", state: "APPROVED", commitId: head },
        { login: "owner", state: "COMMENTED", commitId: head },
        { login: "other", state: "CHANGES_REQUESTED", commitId: head },
      ],
    });
    expect(verdict).toEqual({ pass: true, why: "The owner approved this PR's head commit." });
  });

  it.each([
    [[], "The owner has not approved this PR yet."],
    [[{ login: "other", state: "APPROVED", commitId: "h1" }], "The owner has not approved this PR yet."],
    [[{ login: "owner", state: "COMMENTED", commitId: "h1" }], "The owner has not approved this PR yet."],
    [
      [
        { login: "owner", state: "APPROVED", commitId: "h1" },
        { login: "owner", state: "DISMISSED", commitId: "h1" },
      ],
      "The owner's latest review does not approve this PR.",
    ],
    [
      [
        { login: "owner", state: "APPROVED", commitId: "h1" },
        { login: "owner", state: "CHANGES_REQUESTED", commitId: "h1" },
      ],
      "The owner's latest review does not approve this PR.",
    ],
    [
      [{ login: "owner", state: "APPROVED", commitId: "h0" }],
      "The owner approved an earlier commit. The new commits need the owner's approval too.",
    ],
  ])("fails with %j", (reviews, why) => {
    expect(decideOutsideApproval({ ...base, reviews })).toEqual({ pass: false, why });
  });
});

describe("Owner OK", () => {
  it("passes a PR that changes no owner path", () => {
    expect(decideOwnerOk({ namesResult: "success", paths: ["README.md"], globs: GLOBS, labels: [] })).toEqual({
      pass: true,
      why: "The PR changes no owner path.",
      ownerPaths: [],
    });
  });

  it("fails a PR that changes an owner path, until the owner-ok label is set", () => {
    const input = { namesResult: "success", paths: ["README.md", "packages/client/LICENSE"], globs: SAMPLE };
    expect(decideOwnerOk({ ...input, labels: ["other"] })).toEqual({
      pass: false,
      why: "The PR changes owner paths. Owner OK passes when the owner sets the owner-ok label.",
      ownerPaths: ["packages/client/LICENSE"],
    });
    expect(decideOwnerOk({ ...input, labels: ["owner-ok"] })).toMatchObject({ pass: true });
  });

  it("passes on Names alone while the repository's list is empty, the licences and the markers too", () => {
    const paths = ["LICENSE", "packages/client/LICENSE", "adapters/a1/.protected-name-ok", ".github/owner-paths.txt"];
    expect(decideOwnerOk({ namesResult: "success", paths, globs: GLOBS, labels: [] })).toEqual({
      pass: true,
      why: "The PR changes no owner path.",
      ownerPaths: [],
    });
  });

  it.each(["failure", "cancelled", "skipped", "missing"])("fails when the names check ended in %s", (namesResult) => {
    expect(decideOwnerOk({ namesResult, paths: ["README.md"], globs: GLOBS, labels: [] })).toEqual({
      pass: false,
      why: `The names check did not pass (${namesResult}). Owner OK waits for it.`,
      ownerPaths: [],
    });
    expect(decideOwnerOk({ namesResult, paths: [], globs: SAMPLE, labels: ["owner-ok"] })).toEqual({
      pass: false,
      why: `The names check did not pass (${namesResult}). Owner OK waits for it.`,
      ownerPaths: [],
    });
  });
});

describe("whether the owner-ok label counts", () => {
  const input = {
    owner: "owner",
    headSha: "h2",
    label: { actor: "owner", at: "2026-11-01T10:00:05Z" },
    lastMove: { after: "h2", at: "2026-11-01T10:00:00Z" },
  };

  it("counts when the owner set it after the last push, which left the branch at the head commit", () => {
    expect(decideLabelHolds(input)).toEqual({ pass: true, why: "The owner set the owner-ok label on the PR's head commit." });
  });

  it.each([
    ["GitHub has no record of the label", { label: undefined }, "GitHub has no record of who set the owner-ok label, or when."],
    [
      "another account set it",
      { label: { actor: "someone", at: "2026-11-01T10:00:05Z" } },
      "The owner-ok label was set by an account that is not the owner's.",
    ],
    [
      "the branch history cannot be read",
      { lastMove: undefined },
      "The history of the PR's branch does not end at the PR's head commit, so the label cannot be tied to it.",
    ],
    [
      "the last push is not the head commit",
      { lastMove: { after: "h3", at: "2026-11-01T10:00:00Z" } },
      "The history of the PR's branch does not end at the PR's head commit, so the label cannot be tied to it.",
    ],
    [
      "the owner set it before the last push",
      { lastMove: { after: "h2", at: "2026-11-01T10:00:06Z" } },
      "The owner-ok label was set before the last push to the PR's branch. It counts only for the head commit it was set on.",
    ],
    [
      "the owner set it in the same second as the last push",
      { lastMove: { after: "h2", at: "2026-11-01T10:00:05Z" } },
      "The owner-ok label was set before the last push to the PR's branch. It counts only for the head commit it was set on.",
    ],
    [
      "a time cannot be read",
      { label: { actor: "owner", at: "soon" } },
      "The owner-ok label was set before the last push to the PR's branch. It counts only for the head commit it was set on.",
    ],
  ])("does not count when %s", (_case, change, why) => {
    expect(decideLabelHolds({ ...input, ...change })).toEqual({ pass: false, why });
  });
});

describe("CI OK", () => {
  it("passes when every job succeeded", () => {
    expect(decideCiOk({ build: { result: "success" }, workflows: { result: "success" } })).toEqual({
      pass: true,
      why: "Every CI job passed.",
      lines: ["build: success", "workflows: success"],
    });
  });

  it.each(["failure", "cancelled", "skipped"])("fails when a job ended in %s", (result) => {
    expect(decideCiOk({ build: { result: "success" }, workflows: { result } })).toEqual({
      pass: false,
      why: "1 CI job(s) did not succeed.",
      lines: ["build: success", `workflows: ${result}`],
    });
  });

  it.each([
    [null, "CI OK got no list of jobs."],
    [[], "CI OK got no list of jobs."],
    [{}, "CI OK needs at least one job."],
  ])("fails on %j", (needs, why) => {
    expect(decideCiOk(needs)).toMatchObject({ pass: false, why });
  });

  it("fails on a job without a result", () => {
    expect(decideCiOk({ build: {}, test: { result: 1 }, lint: null })).toMatchObject({
      pass: false,
      lines: ["build: unknown", "test: unknown", "lint: unknown"],
    });
  });
});
