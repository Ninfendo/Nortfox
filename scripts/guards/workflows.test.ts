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
