// SPDX-License-Identifier: AGPL-3.0-only

// The approval workflow keeps the triggers, the checkout, the concurrency and
// the settings that its checks depend on (docs/plan.md, section 6).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPROVAL_EVENT_TYPES, approvalsProblems, block, children, listOf } from "./workflows.ts";

const approvals = readFileSync(new URL("../../.github/workflows/approvals.yml", import.meta.url), "utf8");

/** The workflow with one text replaced; the replaced text must be there. */
function changed(from: string, to: string): string {
  expect(approvals).toContain(from);
  return approvals.replace(from, to);
}

describe("the approval workflow", () => {
  it("has nothing for the guard to find", () => {
    expect(approvalsProblems(approvals)).toEqual([]);
  });

  it("runs on pull_request_target only, for the events that change what the checks read, for PRs into main", () => {
    const triggers = children(block(approvals, "on") ?? []);
    expect([...triggers.keys()]).toEqual(["pull_request_target"]);
    expect(listOf(triggers.get("pull_request_target") ?? [], "types")).toEqual(APPROVAL_EVENT_TYPES);
    expect(listOf(triggers.get("pull_request_target") ?? [], "branches")).toEqual(["main"]);
  });

  it("passes every check the event's head commit, and Names who started the run", () => {
    const jobs = children(block(approvals, "jobs") ?? []);
    expect([...jobs.keys()]).toEqual(["names", "outside-approval", "owner-ok"]);
    for (const lines of jobs.values()) {
      expect(lines.map((line) => line.trim())).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    }
    expect((jobs.get("names") ?? []).map((line) => line.trim())).toContain("TRIGGERING_ACTOR: ${{ github.triggering_actor }}");
  });
});

describe("the approval workflow guard", () => {
  it("fails a second trigger, such as a review, which runs the PR's own copy of the workflow", () => {
    const text = changed("    branches: [main]\n", "    branches: [main]\n  pull_request_review:\n    types: [submitted]\n");
    expect(approvalsProblems(text)).toEqual([
      "The workflow must run on pull_request_target only, which always runs the default branch's copy. It also runs on pull_request_review.",
    ]);
  });

  it("fails a missing event type and another branch", () => {
    const text = changed("edited, ready_for_review", "ready_for_review").replace("branches: [main]", "branches: [main, next]");
    expect(approvalsProblems(text)).toEqual([
      "pull_request_target must also run on edited.",
      "pull_request_target must run only for PRs into main.",
    ]);
  });

  it("fails a concurrency group per kind of event, and a run that is cancelled", () => {
    for (const text of [
      changed("approvals-${{ github.event.pull_request.number }}", "approvals-${{ github.event_name }}-${{ github.event.pull_request.number }}"),
      changed("cancel-in-progress: false", "cancel-in-progress: true"),
    ]) {
      expect(approvalsProblems(text)).toEqual([
        "The concurrency group must be one per PR, approvals-${{ github.event.pull_request.number }}, with cancel-in-progress: false.",
      ]);
    }
  });

  it("fails a checkout of the PR", () => {
    const text = changed(
      "ref: ${{ github.event.repository.default_branch }}\n          fetch-depth",
      "ref: ${{ github.event.pull_request.head.ref }}\n          fetch-depth",
    );
    expect(approvalsProblems(text)).toEqual([
      "Every checkout must check out the default branch, and nothing else.",
      'The PR\'s head and base may appear only in the line "HEAD_SHA: ${{ github.event.pull_request.head.sha }}".',
    ]);
  });

  it("fails a check without the event's head commit", () => {
    const text = changed(
      "          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n          NAMES_RESULT",
      "          NAMES_RESULT",
    );
    expect(approvalsProblems(text)).toEqual([
      'The job owner-ok must pass "HEAD_SHA: ${{ github.event.pull_request.head.sha }}" to its check.',
    ]);
  });

  it("fails an expression inside a run: step, also in a block and in a shell comment", () => {
    for (const run of [
      "run: node scripts/names/cli.ts --pr --head ${{ github.event.pull_request.head.sha }}",
      "run: |\n          set -euo pipefail\n\n          # ${{ github.triggering_actor }}\n          node scripts/names/cli.ts --pr",
    ]) {
      expect(approvalsProblems(changed("run: node scripts/names/cli.ts --pr", run))).toContain(
        "A run: step holds an expression. Pass the value in through env instead.",
      );
    }
  });

  it("fails who started the run anywhere but in Names' env", () => {
    const text = changed("    name: Names\n", "    name: Names\n    if: github.triggering_actor == 'someone'\n");
    expect(approvalsProblems(text)).toEqual([
      'Who started the run may appear only in the line "TRIGGERING_ACTOR: ${{ github.triggering_actor }}".',
    ]);
  });

  it("fails a Names job without the list, without who started the run, or without the history", () => {
    const text = changed("          PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}\n", "")
      .replace("          TRIGGERING_ACTOR: ${{ github.triggering_actor }}\n", "")
      .replace("          fetch-depth: 0 # the whole history, to find where the PR branched off\n", "");
    expect(approvalsProblems(text)).toEqual([
      'The Names job must read the protected names list: "PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}".',
      'The Names job must know who started the run: "TRIGGERING_ACTOR: ${{ github.triggering_actor }}".',
      'The Names job must check out the whole history, to find where the PR branched off: "fetch-depth: 0".',
    ]);
  });

  it("fails the list in another job", () => {
    const text = changed(
      "          NAMES_RESULT: ${{ needs.names.result }}\n",
      "          NAMES_RESULT: ${{ needs.names.result }}\n          PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}\n",
    );
    expect(approvalsProblems(text)).toEqual([
      "Only the Names job may read the protected names list, and owner-ok reads it.",
    ]);
  });

  it("fails a workflow that has none of what it needs", () => {
    expect(approvalsProblems("name: Approvals\n")).toEqual([
      "pull_request_target must also run on opened, synchronize, reopened, edited, ready_for_review, labeled, unlabeled.",
      "pull_request_target must run only for PRs into main.",
      "The concurrency group must be one per PR, approvals-${{ github.event.pull_request.number }}, with cancel-in-progress: false.",
      "Every checkout must check out the default branch, and nothing else.",
      'The Names job must read the protected names list: "PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}".',
      'The Names job must know who started the run: "TRIGGERING_ACTOR: ${{ github.triggering_actor }}".',
      'The Names job must check out the whole history, to find where the PR branched off: "fetch-depth: 0".',
    ]);
  });

  it("reads blocks, keys and lists, and finds nothing where nothing is", () => {
    expect(block("a: 1\n", "on")).toBeUndefined();
    expect(block("on:\n  push:\n# note\nb: 2\n", "on")).toEqual(["  push:", "# note"]);
    expect([...children(["  push:", "    branches: [main]", "", "# note"]).entries()]).toEqual([["push", ["    branches: [main]"]]]);
    expect(listOf(["    types: [a, b]"], "branches")).toEqual([]);
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
