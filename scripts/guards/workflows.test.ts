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
