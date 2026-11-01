// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { decideCiOk, decideLabelHolds, decideOutsideApproval, decideOwnerOk } from "./decide.ts";
import { globToRegExp, ownerPathsIn, parseOwnerPaths } from "./owner-paths.ts";

const GLOBS = [
  "db/migrations/**",
  "packages/engine/src/ledger/**",
  "packages/engine/src/money*",
  "packages/client/openapi.json",
  "**/LICENSE*",
  "**/LICENCE*",
  "**/COPYING*",
  "LICENSE",
  ".github/**",
  "**/tsconfig*.json",
  "**/.protected-name-ok",
  "CLAUDE.md",
];

describe("owner paths", () => {
  it("reads one glob per line, without comments", () => {
    expect(parseOwnerPaths("# Owner paths\n\ndb/migrations/**\r\n  LICENSE  \n")).toEqual(["db/migrations/**", "LICENSE"]);
  });

  it.each([
    ["db/migrations/0001_start.sql", true],
    ["db/migrations/sub/x.sql", true],
    ["db/migrations", true],
    ["db/migrationsx/a.sql", false],
    ["db/seed.sql", false],
    ["packages/engine/src/money.ts", true],
    ["packages/engine/src/money.property.test.ts", true],
    ["packages/engine/src/moneybox/x.ts", false],
    ["packages/engine/src/vat.ts", false],
    ["packages/engine/src/ledger/checks.ts", true],
    ["packages/client/openapi.json", true],
    ["packages/client/src/index.ts", false],
    ["LICENSE", true],
    ["packages/client/LICENSE", true],
    ["packages/client/LICENSE.md", true],
    ["packages/client/LICENCE", true],
    ["packages/client/license.md", true],
    ["License.txt", true],
    ["COPYING", true],
    ["apps/web/copying.lesser", true],
    ["tsconfig.json", true],
    ["apps/web/tsconfig.json", true],
    ["packages/client/tsconfig.build.json", true],
    ["apps/web/src/config.ts", false],
    [".github/workflows/ci.yml", true],
    [".GitHub/workflows/ci.yml", true],
    [".github/owner-paths.txt", true],
    ["docs/.github/x", false],
    ["adapters/a1/.protected-name-ok", true],
    [".protected-name-ok", true],
    ["CLAUDE.md", true],
    ["docs/CLAUDE.md", false],
    ["README.md", false],
  ])("%s is an owner path: %s", (path, expected) => {
    expect(ownerPathsIn([path], GLOBS).length > 0).toBe(expected);
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
  const base = { owner: "owner", author: "someone", headSha: head };

  it("passes a PR from the owner's account", () => {
    expect(decideOutsideApproval({ ...base, author: "owner", reviews: [] })).toEqual({
      pass: true,
      why: "The PR comes from the owner's account.",
    });
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
    const input = { namesResult: "success", paths: ["README.md", ".github/workflows/ci.yml"], globs: GLOBS };
    expect(decideOwnerOk({ ...input, labels: ["other"] })).toEqual({
      pass: false,
      why: "The PR changes owner paths. Owner OK passes when the owner sets the owner-ok label.",
      ownerPaths: [".github/workflows/ci.yml"],
    });
    expect(decideOwnerOk({ ...input, labels: ["owner-ok"] })).toMatchObject({ pass: true });
  });

  it.each(["failure", "cancelled", "skipped", "missing"])("fails when the names check ended in %s", (namesResult) => {
    expect(decideOwnerOk({ namesResult, paths: [], globs: GLOBS, labels: ["owner-ok"] })).toEqual({
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
