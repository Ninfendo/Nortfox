// SPDX-License-Identifier: AGPL-3.0-only

// The approval workflow keeps the triggers, the checkout, the concurrency and
// the settings that its checks depend on (docs/plan.md, section 6). The CI
// workflow checks every commit that a push to main adds.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestRepo, FAKE_LIST, FAKE_WORDS, type TestRepo } from "../testing/repo.ts";
import { APPROVAL_EVENT_TYPES, approvalsProblems, block, children, listOf } from "./workflows.ts";

const approvals = readFileSync(new URL("../../.github/workflows/approvals.yml", import.meta.url), "utf8");

/** The workflow with one text replaced; the replaced text must be there. */
function changed(from: string, to: string): string {
  expect(approvals).toContain(from);
  return approvals.replace(from, to);
}

const PR_PART =
  "The workflow may name the PR only by github.event.pull_request.number, " +
  'and its head commit only in the line "HEAD_SHA: ${{ github.event.pull_request.head.sha }}". ' +
  "So it names no other part of the PR, no head_ref or base_ref, and no github.event.after or github.event.before.";
const PLAIN_LINE =
  "Outside run:, each line must be one plain key, with a value that ends on that line. " +
  "The guard cannot read a quoted key, a space before a colon, a list item without a key, or a text over more lines, as after | or >.";
const BRACKETS =
  "The workflow holds { }, [ ] or a .* filter outside run:. The guard cannot see the keys in a { } or [ ] form, " +
  "or what an index such as a['b'] or a filter reads. Only {} and a one-line list of plain words may hold brackets.";
const LINE_BREAK =
  "The workflow holds a character that YAML reads as a line break, where the guard sees none: " +
  "a carriage return without a line feed, U+0085, U+2028 or U+2029.";
const NAMES_RESULT = "          NAMES_RESULT: ${{ needs.names.result }}\n";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const NAMES_CHECKOUT =
  `        uses: ${CHECKOUT} # v7.0.1\n        with:\n          ref: \${{ github.event.repository.default_branch }}\n          fetch-depth`;
const OUTSIDE_STEP =
  "      - name: The owner wrote the PR, or approved its head commit\n        run: node scripts/approvals/cli.ts outside-approval\n";
const OUTSIDE_ENV_END = "          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n\n  owner-ok:";

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

  it("passes every check the event's head commit, and Names who started the run and whose rights it has", () => {
    const jobs = children(block(approvals, "jobs") ?? []);
    expect([...jobs.keys()]).toEqual(["names", "outside-approval", "owner-ok"]);
    for (const lines of jobs.values()) {
      expect(lines.map((line) => line.trim())).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    }
    const names = (jobs.get("names") ?? []).map((line) => line.trim());
    expect(names).toContain("TRIGGERING_ACTOR: ${{ github.triggering_actor }}");
    // So that a run Dependabot started says why it has no list.
    expect(names).toContain("RUN_ACTOR: ${{ github.actor }} # whose rights the run has, which a re-run keeps");
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
    expect(approvalsProblems(text)).toEqual(["Every checkout must check out the default branch, and nothing else.", PR_PART]);
  });

  it("fails a checkout of another repository, such as the author's fork, and any other input an action does not need", () => {
    for (const repository of [
      "${{ github.event.sender.login }}/${{ github.event.repository.name }}",
      "${{ github.actor }}/${{ github.event.repository.name }}",
      "${{ github.event['pull_request']['head']['repo']['full_name'] }}",
    ]) {
      const text = changed(NAMES_CHECKOUT, NAMES_CHECKOUT.replace("        with:\n", `        with:\n          repository: ${repository}\n`));
      expect(approvalsProblems(text)).toContain(
        "The step that uses actions/checkout may give it only ref, fetch-depth and persist-credentials. It also gives repository.",
      );
    }
    const two = changed("          persist-credentials: false\n", "          persist-credentials: false\n          path: other\n          token: x\n");
    expect(approvalsProblems(two)).toEqual([
      "The step that uses actions/checkout may give it only ref, fetch-depth and persist-credentials. It also gives path and token.",
    ]);
    const cache = changed("          package-manager-cache: false\n", "          package-manager-cache: false\n          cache: pnpm\n");
    expect(approvalsProblems(cache)).toEqual([
      "The step that uses actions/setup-node may give it only node-version-file and package-manager-cache. It also gives cache.",
    ]);
  });

  it("fails an input to checkout however the step is written: with first, or the action's name in other cases", () => {
    const step =
      "      - with:\n          repository: someone/nortfox\n" +
      `          ref: \${{ github.event.repository.default_branch }}\n        uses: ${CHECKOUT}\n`;
    for (const text of [
      changed("      - uses: actions/setup-node", `${step}      - uses: actions/setup-node`),
      changed(
        NAMES_CHECKOUT,
        NAMES_CHECKOUT.replace("actions/checkout", "Actions/Checkout").replace("        with:\n", "        with:\n          repository: x/y\n"),
      ),
    ]) {
      expect(approvalsProblems(text)).toEqual([
        "The step that uses actions/checkout may give it only ref, fetch-depth and persist-credentials. It also gives repository.",
      ]);
    }
  });

  it("fails any other action, an action not pinned to a commit, and a reusable workflow", () => {
    const only = "The workflow may use only actions/checkout and actions/setup-node, each pinned to a full commit SHA.";
    const sha = CHECKOUT.slice(-40);
    for (const uses of ["actions/checkout@v7.0.1", `someone/checkout-pr@${sha}`, `"${CHECKOUT}"`, `actions/checkout/sub@${sha}`]) {
      expect(approvalsProblems(changed(`        uses: ${CHECKOUT} # v7.0.1\n`, `        uses: ${uses}\n`))).toEqual([`${only} It uses "${uses}".`]);
    }
    const reusable = changed("  owner-ok:\n", "  reuse:\n    uses: ./.github/workflows/other.yml\n  owner-ok:\n");
    expect(approvalsProblems(reusable)).toContain(`${only} It uses "./.github/workflows/other.yml".`);
  });

  it("fails each line the guard cannot read as one plain key with its value", () => {
    for (const text of [
      changed("    branches: [main]\n", '    branches: [main]\n  "pull_request_review":\n    types: [submitted]\n'),
      changed("    branches: [main]\n", "    branches: [main]\n  'pull_request_review':\n    types: [submitted]\n"),
      changed("    branches: [main]\n", "    branches: [main]\n  pull_request_review :\n    types: [submitted]\n"),
      // A quoted key, which the rule on checkouts does not see, reads the head commit from env.
      changed(NAMES_CHECKOUT, NAMES_CHECKOUT.replace("ref: ${{ github.event.repository.default_branch }}", '"ref": ${{ env.HEAD_SHA }}')),
      // A quoted text over two lines: its second line looks like a comment, which the guard does not read.
      changed(NAMES_RESULT, `${NAMES_RESULT}          LIST: "x\n          # \${{ secrets.PROTECTED_NAMES }}"\n`),
      changed(NAMES_RESULT, `${NAMES_RESULT}          LIST: |\n            # \${{ secrets.PROTECTED_NAMES }}\n`),
      changed(NAMES_RESULT, `${NAMES_RESULT}          LIST: >-\n            x\n`),
      changed(NAMES_RESULT, `${NAMES_RESULT}          LIST: 'x\n`),
      changed(NAMES_RESULT, `${NAMES_RESULT}          LIST:x\n`),
    ]) {
      expect(approvalsProblems(text)).toEqual([PLAIN_LINE]);
    }
    expect(approvalsProblems(changed("    branches: [main]\n", "    branches:\n      - main\n"))).toContain(PLAIN_LINE);
  });

  it("reads a quoted value that ends on its line", () => {
    for (const value of ['"x"', "'it''s'", '"x" # a note', "''"]) {
      expect(approvalsProblems(changed(NAMES_RESULT, `${NAMES_RESULT}          LIST: ${value}\n`))).toEqual([]);
    }
  });

  it("fails a { } or [ ] form, an index and a .* filter", () => {
    const after = changed(
      "      - name: Check the PR's files, paths, title, body, branch and commits\n",
      `      - uses: ${CHECKOUT}\n        with: { ref: "\${{ github.event.after }}", clean: false, persist-credentials: false }\n` +
        "      - name: Check the PR's files, paths, title, body, branch and commits\n",
    );
    expect(approvalsProblems(after)).toEqual([PR_PART, BRACKETS]);
    for (const value of [
      "{ repository: someone/nortfox }",
      "[a, b: c]",
      "[a, {b: c}]",
      "${{ github['event'].number }}",
      "${{ join(github.event.commits.*.id) }}",
    ]) {
      expect(approvalsProblems(changed(NAMES_RESULT, `${NAMES_RESULT}          OTHER: ${value}\n`))).toEqual([BRACKETS]);
    }
  });

  it("fails a character that YAML reads as a line break, also in a comment", () => {
    for (const lineBreak of ["\r", "\u0085", "\u2028", "\u2029"]) {
      const text = changed("    branches: [main]\n", `    branches: [main]\n  # a note${lineBreak}  pull_request_review:\n`);
      expect(approvalsProblems(text)).toEqual([LINE_BREAK]);
    }
  });

  it("reads the keys of a step that starts with run:, and leaves the text of a run: block alone", () => {
    const runFirst = changed(
      OUTSIDE_STEP,
      "      - run: node scripts/approvals/cli.ts outside-approval\n        name: The owner wrote the PR, or approved its head commit\n",
    );
    expect(approvalsProblems(runFirst)).toEqual([]);
    expect(approvalsProblems(runFirst.replace(OUTSIDE_ENV_END, `          "LIST": x\n${OUTSIDE_ENV_END}`))).toEqual([PLAIN_LINE]);
    const script = OUTSIDE_STEP.replace(
      "run: node scripts/approvals/cli.ts outside-approval\n",
      "run: |\n          echo \"{ref: x}\" 'a: [b]'\n          node scripts/approvals/cli.ts outside-approval\n",
    );
    expect(approvalsProblems(changed(OUTSIDE_STEP, script))).toEqual([]);
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

  const SECRETS_ONLY_IN_ONE_LINE = 'The workflow may name its secrets only in the line "PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}".';
  const ONLY_THE_CHECK_STEP =
    'In the Names job, only the env of the step that runs "run: node scripts/names/cli.ts --pr" may read the protected names list.';

  it("fails the list in another job, in its step or in its own env", () => {
    for (const text of [
      changed(NAMES_RESULT, `${NAMES_RESULT}          PROTECTED_NAMES: \${{ secrets.PROTECTED_NAMES }}\n`),
      changed("    needs: names\n", "    needs: names\n    env:\n      PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}\n"),
    ]) {
      expect(approvalsProblems(text)).toEqual(["Only the Names job may read the protected names list, and owner-ok reads it."]);
    }
  });

  it("fails the list in the workflow's own env, which every job gets", () => {
    const text = changed("  OWNER_LOGIN: Ninfendo\n", "  OWNER_LOGIN: Ninfendo\n  PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}\n");
    expect(approvalsProblems(text)).toEqual([
      "Only the Names job may read the protected names list, and the workflow reads it outside its jobs.",
    ]);
  });

  it("fails the list anywhere in the Names job but the env of the step that runs the check", () => {
    for (const text of [
      changed("    timeout-minutes: 15\n", "    timeout-minutes: 15\n    env:\n      PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}\n"),
      changed(
        "          package-manager-cache: false\n      - name: Check the PR's files",
        "          package-manager-cache: false\n        env:\n          PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}\n      - name: Check the PR's files",
      ),
      changed(
        "          persist-credentials: false\n      - uses: actions/setup-node",
        "          persist-credentials: false\n          PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}\n      - uses: actions/setup-node",
      ),
    ]) {
      expect(approvalsProblems(text)).toContain(ONLY_THE_CHECK_STEP);
    }
  });

  it("fails every other way to name a secret, in any case, also all of them at once", () => {
    for (const line of [
      "          LIST: ${{ secrets.PROTECTED_NAMES }}\n",
      "          PROTECTED_NAMES: ${{ SECRETS.protected_names }}\n",
      "          PROTECTED_NAMES: ${{ secrets['PROTECTED_NAMES'] }}\n",
      "          ALL: ${{ toJSON(secrets) }}\n",
      '          PROTECTED_NAMES: "${{ secrets.PROTECTED_NAMES }}"\n',
    ]) {
      expect(approvalsProblems(changed(NAMES_RESULT, `${NAMES_RESULT}${line}`))).toContain(SECRETS_ONLY_IN_ONE_LINE);
    }
    const inherit = changed("  owner-ok:\n", "  reuse:\n    uses: ./.github/workflows/other.yml\n    secrets: inherit\n  owner-ok:\n");
    expect(approvalsProblems(inherit)).toContain(SECRETS_ONLY_IN_ONE_LINE);
  });

  it("fails a whole object passed with toJSON", () => {
    expect(approvalsProblems(changed(NAMES_RESULT, `${NAMES_RESULT}          EVENT: \${{ toJSON(github.event) }}\n`))).toEqual([
      "The workflow passes no whole object with toJSON. Pass each value it needs on its own.",
    ]);
  });

  it("fails any part of the PR but its number, and the event's own head commits, in any case", () => {
    for (const value of [
      "github.head_ref",
      "github.base_ref",
      "github.event.pull_request.head.repo.full_name",
      "github.event.pull_request.base.sha",
      "github.event.PULL_REQUEST.Head.Sha",
      "github.event.pull_request.merge_commit_sha",
      "github.event.pull_request.title",
      "github.event.pull_request",
      "github.event.pull_request.numbers",
      "github.event.after",
      "github.event.Before",
    ]) {
      expect(approvalsProblems(changed(NAMES_RESULT, `${NAMES_RESULT}          BRANCH: \${{ ${value} }}\n`))).toEqual([PR_PART]);
    }
    // Read by index, the PR also fails the rule on brackets.
    for (const value of [
      "github['head_ref']",
      "github.event.pull_request['head']['ref']",
      "github.event['pull_request']['head']['ref']",
      'github.event["pull_request"]["head"]',
    ]) {
      expect(approvalsProblems(changed(NAMES_RESULT, `${NAMES_RESULT}          BRANCH: \${{ ${value} }}\n`))).toEqual([PR_PART, BRACKETS]);
    }
  });

  it("fails a YAML anchor, alias or merge key, which could copy the list into another job", () => {
    const anchored = changed("        env:\n          PROTECTED_NAMES", "        env: &names\n          PROTECTED_NAMES");
    for (const text of [anchored, anchored.replace(NAMES_RESULT, `${NAMES_RESULT}          <<: *names\n`)]) {
      expect(approvalsProblems(text)).toContain("The workflow uses a YAML anchor or alias. They copy lines without the guard seeing them.");
    }
    expect(approvalsProblems(changed("    needs: names\n", "    needs: names\n    env: *names\n"))).toEqual([
      "The workflow uses a YAML anchor or alias. They copy lines without the guard seeing them.",
    ]);
  });

  it("fails a backslash outside run:, which YAML can read as an escape", () => {
    const text = changed(NAMES_RESULT, `${NAMES_RESULT}          LIST: "\${{ \\x73ecrets.PROTECTED_NAMES }}"\n`);
    expect(approvalsProblems(text)).toEqual(["The workflow holds a backslash outside run:. YAML reads it as an escape in a quoted text."]);
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
// adds, and no newer run cancels a run on main.

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

  it("runs the database tests in the build job, against PostgreSQL as a service of the job, with no more permissions", () => {
    const lines = ci.split(/\r?\n/);
    const build = linesUnder(lines, lines.indexOf("  build:"));
    const text = build.join("\n");
    expect(text).toMatch(/^ {4}services:\n {6}postgres:\n {8}image: postgres:18-bookworm@sha256:[0-9a-f]{64}$/m);
    expect(text).toContain("\n        env:\n          POSTGRES_HOST_AUTH_METHOD: trust\n");
    expect(text).toContain('--health-cmd "pg_isready --username postgres --dbname postgres"');
    expect(step(ci, "Test with coverage").map((line) => line.trim())).toEqual([
      "- name: Test with coverage",
      "run: pnpm test:coverage",
      "env:",
      "NORTFOX_TEST_DATABASE_URL: postgres://postgres@localhost:5432/postgres",
    ]);
    const permissions = linesUnder(build, build.indexOf("    permissions:")).map((line) => line.trim());
    expect(permissions).toEqual(["permissions:", "contents: read # check out the code"]);
  });

  it("runs the point-in-time restore test in a job of its own, with the checkout alone and no more permissions", () => {
    const lines = ci.split(/\r?\n/);
    const backup = linesUnder(lines, lines.indexOf("  backup:"))
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(backup).toEqual([
      "backup:",
      "name: backup",
      "runs-on: ubuntu-24.04",
      "timeout-minutes: 20",
      "permissions:",
      "contents: read # check out the code",
      "steps:",
      "- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "with:",
      "persist-credentials: false",
      "- name: Point-in-time restore from both repositories",
      "run: bash deploy/backup-test/pitr.sh",
    ]);
  });

  it("makes CI OK need every other job that runs on a PR", () => {
    const lines = ci.split(/\r?\n/);
    const jobs = linesUnder(lines, lines.indexOf("jobs:"))
      .filter((line) => /^ {2}[a-z-]+:$/.test(line))
      .map((line) => line.trim().slice(0, -1));
    expect(jobs).toEqual(["build", "workflows", "backup", "ci-ok", "names-main"]);
    const ciOk = linesUnder(lines, lines.indexOf("  ci-ok:")).map((line) => line.trim());
    expect(ciOk).toContain("needs: [build, workflows, backup]");
    expect(ciOk).toContain("if: always()");
  });

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
