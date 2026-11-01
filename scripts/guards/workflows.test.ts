// SPDX-License-Identifier: AGPL-3.0-only

// The approval workflow keeps the triggers and the checkout that its checks
// depend on (docs/plan.md, section 6).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const approvals = readFileSync(new URL("../../.github/workflows/approvals.yml", import.meta.url), "utf8");

/** The lines of a top-level key's block, up to the next top-level key. */
function block(text: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  expect(start, `${key}: is a top-level key`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && !line.startsWith("#"));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** The value of a one-line list, "key: [a, b]", under `trigger` in the on: block. */
function listUnder(trigger: string, key: string): string[] {
  const on = block(approvals, "on");
  const match = new RegExp(`^ {2}${trigger}:.*\\n((?: {4}.*\\n?)*)`, "m").exec(on);
  const body = match?.[1] ?? "";
  const list = new RegExp(`^ {4}${key}: \\[([^\\]]*)\\]`, "m").exec(body)?.[1];
  return list === undefined ? [] : list.split(",").map((item) => item.trim());
}

describe("the approval workflow", () => {
  it("runs again when the title, the body or the base of a PR changes", () => {
    // The squash merge copies the title and body into main, so they must be
    // checked as they are at the end.
    expect(listUnder("pull_request_target", "types")).toEqual(
      expect.arrayContaining(["opened", "synchronize", "reopened", "edited", "ready_for_review", "labeled", "unlabeled"]),
    );
    expect(listUnder("pull_request_review", "types")).toEqual(["submitted", "dismissed"]);
  });

  it("runs only for PRs into main", () => {
    expect(listUnder("pull_request_target", "branches")).toEqual(["main"]);
  });

  it("checks out the default branch only, never the PR's base or head", () => {
    const refs = [...approvals.matchAll(/^\s+ref: (.*)$/gm)].map(([, ref]) => ref);
    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs)).toEqual(new Set(["${{ github.event.repository.default_branch }}"]));
    expect(approvals).not.toMatch(/pull_request\.(base|head)\.(ref|sha)/);
  });

  it("runs one event at a time per PR, and lets a run finish", () => {
    expect(block(approvals, "concurrency")).toBe(
      "  group: approvals-${{ github.event_name }}-${{ github.event.pull_request.number }}\n  cancel-in-progress: false\n",
    );
  });

  it("finds what it looks for, and fails on what it does not", () => {
    expect(listUnder("pull_request_target", "nothing")).toEqual([]);
    expect(listUnder("push", "types")).toEqual([]);
    expect(() => block("a: 1\n", "on")).toThrow();
  });
});

// The CI workflow's "names (main)" job checks every commit that a push to main
// adds, and no newer run cancels a run on main. These imports sit with the
// tests that use them.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestRepo, FAKE_LIST, FAKE_WORDS, type TestRepo } from "../testing/repo.ts";

describe("the CI workflow", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const STEP = "No protected name in a commit the push added";
  const CLI = fileURLToPath(new URL("../names/cli.ts", import.meta.url)).replaceAll("\\", "/");

  const indentOf = (line: string): number => line.length - line.trimStart().length;

  /** The line at `start` and the lines under it: those indented further, and blank lines among them. */
  function linesUnder(lines: readonly string[], start: number): string[] {
    const indent = indentOf(lines[start] ?? "");
    const end = lines.findIndex((line, index) => index > start && line.trim() !== "" && indentOf(line) <= indent);
    return lines.slice(start, end === -1 ? undefined : end);
  }

  /** The lines of the step with this name, from its "- name:" line. */
  function step(workflow: string, name: string): string[] {
    const lines = workflow.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
    if (start === -1) {
      throw new Error(`No step is named ${JSON.stringify(name)}.`);
    }
    return linesUnder(lines, start);
  }

  /** The script in a step's "run: |", as bash gets it. */
  function script(workflow: string, name: string): string {
    const lines = step(workflow, name);
    const run = lines.findIndex((line) => line.trim() === "run: |");
    if (run === -1) {
      throw new Error(`The step ${JSON.stringify(name)} has no "run: |".`);
    }
    const body = linesUnder(lines, run).slice(1);
    const indent = Math.min(...body.filter((line) => line.trim() !== "").map(indentOf));
    return body.map((line) => line.slice(indent)).join("\n");
  }

  /** bash. On Windows, the one that comes with git: a bare "bash" may be another one, such as WSL's. */
  function bash(): string {
    if (process.platform !== "win32") {
      return "bash";
    }
    const gitCore = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
    return `${gitCore}/../../../bin/bash.exe`;
  }

  /**
   * A stand-in for the names check, for the tests of which texts the step
   * passes it: it notes each label and fails on a made-up word. It is quick,
   * where each run of the real check starts Node.
   */
  const STAND_IN = `stand_in() { printf '%s\\n' "$3" >> "$RUNNER_TEMP/labels"; ! grep -qiE '${FAKE_WORDS.join("|")}'; }\n`;

  interface StepRun {
    readonly code: number | null;
    readonly out: string;
    readonly err: string;
    /** The labels the stand-in was given, in order. */
    readonly labels: string[];
  }

  /** Runs the step's script in a repository, as CI runs it after a push. */
  function runStep(repo: TestRepo, before: string, after: string, check: "real" | "stand-in"): StepRun {
    const body = script(ci, STEP);
    const call = "node scripts/names/cli.ts --text --label";
    expect(body).toContain(call);
    expect(CLI).not.toContain("'");
    const runnable =
      check === "real"
        ? body.replaceAll("node scripts/names/cli.ts", `node '${CLI}'`)
        : STAND_IN + body.replaceAll(call, "stand_in --text --label");
    const temp = `${repo.dir.replaceAll("\\", "/")}/.git`;
    // The labels file is emptied first, so it is there even when the stand-in is never called.
    const result = spawnSync(bash(), ["-c", `: > "$RUNNER_TEMP/labels"\n${runnable}`], {
      cwd: repo.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        PROTECTED_NAMES: FAKE_LIST,
        NORTFOX_PROTECTED_NAMES_FILE: undefined,
        RUNNER_TEMP: temp,
        BEFORE: before,
        AFTER: after,
      },
    });
    const labels = readFileSync(`${temp}/labels`, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    return { code: result.status, out: result.stdout, err: result.stderr, labels };
  }

  /** The labels of the three texts of each commit, in the order given. */
  const labelsOf = (...commits: string[]): string[] =>
    commits.flatMap((commit) => {
      const short = `commit ${commit.slice(0, 7)}`;
      return [short, `${short} author`, `${short} committer`];
    });

  function withRepo(test: (repo: TestRepo, head: () => string) => void): void {
    const repo = createTestRepo();
    try {
      test(repo, () => repo.git("rev-parse", "HEAD").trim());
    } finally {
      repo.remove();
    }
  }

  function expectNoWord(text: string): void {
    for (const word of FAKE_WORDS) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  }

  it("never cancels a run on main, and cancels an older run of the same PR", () => {
    expect(/^concurrency:\n((?: {2}.*\n)*)/m.exec(ci)?.[1]).toBe(
      "  group: ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}\n" +
        "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
    );
  });

  it("gives names (main) the whole history and the range of the push, never inside run:", () => {
    const lines = ci.split(/\r?\n/);
    const job = linesUnder(lines, lines.indexOf("  names-main:")).join("\n");
    expect(job).toContain("fetch-depth: 0");
    expect(job).toContain(`- name: ${STEP}`);
    const found = step(ci, STEP).join("\n");
    expect(found).toContain("if: ${{ !cancelled() }}");
    expect(found).toMatch(/^ {10}BEFORE: \$\{\{ github\.event\.before \}\}$/m);
    expect(found).toMatch(/^ {10}AFTER: \$\{\{ github\.sha \}\}$/m);
    expect(found).toMatch(/^ {10}PROTECTED_NAMES: \$\{\{ secrets\.PROTECTED_NAMES \}\}$/m);
    expect(script(ci, STEP)).not.toContain("${{");
  });

  it("checks every commit that the push added, and goes on after a find", () => {
    withRepo((repo, head) => {
      repo.commitAll("Start");
      const before = head();
      // Author and committer both carry a made-up word.
      repo.git("-c", `user.name=${FAKE_WORDS[1]}`, "commit", "--quiet", "--allow-empty", "-m", "Tidy");
      const named = head();
      repo.commitAll(`Add the ${FAKE_WORDS[0]} notes`);
      const after = head();

      // The newest commit is checked first, so the find in it must not stop the check.
      const found = runStep(repo, before, after, "real");
      expect(found.code).toBe(1);
      expect(found.err.split("\n").filter((line) => line.endsWith("holds a protected name."))).toEqual([
        `names: commit ${after.slice(0, 7)} holds a protected name.`,
        `names: commit ${named.slice(0, 7)} author holds a protected name.`,
        `names: commit ${named.slice(0, 7)} committer holds a protected name.`,
      ]);
      expect(found.out).toContain("names: checked 2 commits that the push added.");
      expectNoWord(found.out + found.err);
    });
  });

  it("checks the commits that a merge brings in", () => {
    withRepo((repo, head) => {
      repo.commitAll("Start");
      const before = head();
      repo.git("checkout", "--quiet", "-b", "side");
      repo.commitAll(`Add the ${FAKE_WORDS[0]} notes`);
      const side = head();
      repo.git("checkout", "--quiet", "main");
      repo.git("merge", "--quiet", "--no-ff", "-m", "Merge side", "side");
      const merge = head();

      const found = runStep(repo, before, merge, "stand-in");
      expect(found.code).toBe(1);
      expect([...found.labels].sort()).toEqual(labelsOf(merge, side).sort());
      expect(found.out).toContain("names: checked 2 commits that the push added.");
    });
  });

  it("checks the pushed commit alone when the push made the branch", () => {
    withRepo((repo, head) => {
      repo.commitAll(`Add the ${FAKE_WORDS[0]} notes`);
      repo.commitAll("Finish");
      const after = head();

      const clean = runStep(repo, "0".repeat(40), after, "stand-in");
      expect(clean).toMatchObject({ code: 0, err: "", labels: labelsOf(after) });
      expect(clean.out).toContain("names: checked 1 commits that the push added.");
    });
  });

  it("fails when it cannot tell which commits the push added", () => {
    withRepo((repo, head) => {
      repo.commitAll("Start");
      for (const before of ["1".repeat(40), "main", ""]) {
        const missing = runStep(repo, before, head(), "stand-in");
        expect(missing).toMatchObject({ code: 1, labels: [] });
        expect(missing.err).toContain("names: the commit before the push is not in the clone");
      }
      for (const after of ["HEAD", ""]) {
        const notAnId = runStep(repo, "0".repeat(40), after, "stand-in");
        expect(notAnId).toMatchObject({ code: 1, labels: [] });
        expect(notAnId.err).toContain("names: the pushed commit is not a commit id.");
      }
    });
  });

  it("finds the steps it looks for, and fails on those it does not", () => {
    const workflow =
      "jobs:\n  a:\n    steps:\n      - name: One\n        run: |\n          echo one\n\n          echo two\n      - name: Two\n        run: echo two\n";
    expect(script(workflow, "One")).toBe("echo one\n\necho two");
    expect(() => script(workflow, "Two")).toThrow('The step "Two" has no "run: |".');
    expect(() => step(workflow, "Three")).toThrow('No step is named "Three".');
  });
});
