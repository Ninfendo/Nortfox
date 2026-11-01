// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the approval workflow as its checks need it (docs/plan.md, section 6).
// It runs on pull_request_target only, so GitHub always runs the default
// branch's copy, in the default branch's context, and never the PR's. It
// checks out the default branch only. One run per PR runs at a time. Each
// check gets the head commit that the event names, and Names gets who started
// the run, both through env and never inside a run: line. Only Names gets the
// list, and it checks out the whole history so that it can find where the PR
// branched off.

/** The types of pull_request_target event that start the workflow. */
export const APPROVAL_EVENT_TYPES = ["opened", "synchronize", "reopened", "edited", "ready_for_review", "labeled", "unlabeled"];

export const CONCURRENCY = [
  "  group: approvals-${{ github.event.pull_request.number }}",
  "  cancel-in-progress: false",
];

const DEFAULT_BRANCH = "${{ github.event.repository.default_branch }}";
const HEAD_SHA_LINE = "HEAD_SHA: ${{ github.event.pull_request.head.sha }}";
const ACTOR_LINE = "TRIGGERING_ACTOR: ${{ github.triggering_actor }}";
const SECRET_LINE = "PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}";

const isContent = (line: string): boolean => line.trim() !== "" && !line.trimStart().startsWith("#");

/** The lines of a top-level key's block, up to the next top-level key. */
export function block(text: string, key: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  if (start === -1) {
    return undefined;
  }
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && isContent(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The keys right under a block, at its first level of indentation, with their own lines. */
export function children(lines: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const key = /^ {2}([A-Za-z0-9_-]+):/.exec(line)?.[1];
    if (key !== undefined) {
      current = [];
      found.set(key, current);
    } else if (current !== undefined && isContent(line)) {
      current.push(line);
    }
  }
  return found;
}

/** The value of a one-line list, "key: [a, b]", among a trigger's lines. */
export function listOf(lines: readonly string[], key: string): string[] {
  for (const line of lines) {
    const list = new RegExp(`^ {4}${key}: \\[([^\\]]*)\\]`).exec(line)?.[1];
    if (list !== undefined) {
      return list.split(",").map((item) => item.trim());
    }
  }
  return [];
}

/** The lines of every run: step, a block scalar with its body included. */
function runLines(lines: readonly string[]): string[] {
  const found: string[] = [];
  let indent: number | undefined;
  for (const line of lines) {
    const width = line.length - line.trimStart().length;
    if (indent !== undefined && (width > indent || line.trim() === "")) {
      found.push(line);
      continue;
    }
    indent = undefined;
    if (/^\s*(?:- )?run:/.test(line)) {
      found.push(line);
      indent = width;
    }
  }
  return found;
}

/** What is wrong with the approval workflow, in plain words; empty when nothing is. */
export function approvalsProblems(text: string): string[] {
  const problems: string[] = [];
  const triggers = children(block(text, "on") ?? []);
  const others = [...triggers.keys()].filter((name) => name !== "pull_request_target");
  if (others.length > 0) {
    problems.push(
      `The workflow must run on pull_request_target only, which always runs the default branch's copy. It also runs on ${others.join(", ")}.`,
    );
  }
  const target = triggers.get("pull_request_target") ?? [];
  const types = listOf(target, "types");
  const missing = APPROVAL_EVENT_TYPES.filter((type) => !types.includes(type));
  if (missing.length > 0) {
    problems.push(`pull_request_target must also run on ${missing.join(", ")}.`);
  }
  if (listOf(target, "branches").join(",") !== "main") {
    problems.push("pull_request_target must run only for PRs into main.");
  }

  const concurrency = (block(text, "concurrency") ?? []).filter(isContent);
  if (concurrency.join("\n") !== CONCURRENCY.join("\n")) {
    problems.push(
      "The concurrency group must be one per PR, approvals-${{ github.event.pull_request.number }}, with cancel-in-progress: false.",
    );
  }

  const refs = [...text.matchAll(/^\s+ref: (.*)$/gm)].map(([, ref]) => ref);
  if (refs.length === 0 || refs.some((ref) => ref !== DEFAULT_BRANCH)) {
    problems.push("Every checkout must check out the default branch, and nothing else.");
  }

  // Comments may name anything; only what the workflow does counts.
  const lines = text.split(/\r?\n/).filter(isContent);
  const outsideEnv = (pattern: RegExp, allowed: string): boolean =>
    lines.some((line) => pattern.test(line) && line.trim() !== allowed);
  if (outsideEnv(/pull_request\.(?:base|head)\.(?:ref|sha)/, HEAD_SHA_LINE)) {
    problems.push(`The PR's head and base may appear only in the line "${HEAD_SHA_LINE}".`);
  }
  if (outsideEnv(/triggering_actor/, ACTOR_LINE)) {
    problems.push(`Who started the run may appear only in the line "${ACTOR_LINE}".`);
  }
  // A run: block is read whole: GitHub fills in an expression even inside a shell comment.
  if (runLines(text.split(/\r?\n/)).some((line) => line.includes("${{"))) {
    problems.push("A run: step holds an expression. Pass the value in through env instead.");
  }

  const jobs = children(block(text, "jobs") ?? []);
  for (const [job, jobLines] of jobs) {
    const trimmed = jobLines.map((line) => line.trim());
    if (!trimmed.includes(HEAD_SHA_LINE)) {
      problems.push(`The job ${job} must pass "${HEAD_SHA_LINE}" to its check.`);
    }
    if (job !== "names" && trimmed.includes(SECRET_LINE)) {
      problems.push(`Only the Names job may read the protected names list, and ${job} reads it.`);
    }
  }
  const names = (jobs.get("names") ?? []).map((line) => line.trim());
  for (const [line, why] of [
    [SECRET_LINE, "read the protected names list"],
    [ACTOR_LINE, "know who started the run"],
    ["fetch-depth: 0", "check out the whole history, to find where the PR branched off"],
  ] as const) {
    if (!names.some((found) => found === line || found.startsWith(`${line} #`))) {
      problems.push(`The Names job must ${why}: "${line}".`);
    }
  }
  return problems;
}
