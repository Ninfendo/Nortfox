// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the approval workflow as its checks need it (docs/plan.md, section 6).
// It runs on pull_request_target only, so GitHub always runs the default
// branch's copy, in the default branch's context, and never the PR's. It
// checks out the default branch only. One run per PR runs at a time. Each
// check gets the head commit that the event names, and Names gets who started
// the run, both through env and never inside a run: line. The workflow names
// its secrets in one line only: the list, in the env of the Names step that
// runs the check. Names checks out the whole history so that it can find
// where the PR branched off. The guard reads the text, so the workflow also
// does without what would build a line it looks for out of sight: toJSON, a
// YAML anchor or alias, and a backslash escape.

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
const NAMES_RUN = "run: node scripts/names/cli.ts --pr";
/** The PR's head or base, in each way an expression can name them. GitHub reads names in any case. */
const HEAD_OR_BASE = /pull_request\s*(?:\.\s*|\[\s*'\s*)(?:head|base)\b|\b(?:head|base)_ref\b/i;

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

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Where the lines of every run: step are, a block scalar with its body included. */
function runLines(lines: readonly string[]): Set<number> {
  const found = new Set<number>();
  let indent: number | undefined;
  for (const [index, line] of lines.entries()) {
    const width = indentOf(line);
    if (indent !== undefined && (width > indent || line.trim() === "")) {
      found.add(index);
      continue;
    }
    indent = undefined;
    if (/^\s*(?:- )?run:/.test(line)) {
      found.add(index);
      indent = width;
    }
  }
  return found;
}

/**
 * Where the lines that hold the line at `index` are, nearest first: its
 * parent, the parent's parent, and so on. A line's parent is the closest
 * line above it that is indented less.
 */
function parents(lines: readonly string[], index: number): number[] {
  const found: number[] = [];
  let indent = indentOf(lines[index] ?? "");
  for (let at = index - 1; at >= 0 && indent > 0; at -= 1) {
    const line = lines[at] ?? "";
    if (isContent(line) && indentOf(line) < indent) {
      found.push(at);
      indent = indentOf(line);
    }
  }
  return found;
}

/** The step that starts at `index`, a "- " line: that line and the lines under it, trimmed. */
function stepAt(lines: readonly string[], index: number): string[] {
  const indent = indentOf(lines[index] ?? "");
  const end = lines.findIndex((line, at) => at > index && isContent(line) && indentOf(line) <= indent);
  return lines
    .slice(index, end === -1 ? undefined : end)
    .filter(isContent)
    .map((line) => line.trim());
}

const isSecretLine = (trimmed: string): boolean => trimmed === SECRET_LINE || trimmed.startsWith(`${SECRET_LINE} #`);

/**
 * Where the workflow names its secrets. Only one line may: SECRET_LINE, in
 * the env of the Names step that runs the check. GitHub reads `secrets` in
 * any case, and `secrets: inherit` and `toJSON(secrets)` pass every secret,
 * so the word itself counts, on any line.
 */
function secretProblems(lines: readonly string[]): string[] {
  const problems = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!isContent(line) || !/\bsecrets\b/i.test(line)) {
      continue;
    }
    if (!isSecretLine(line.trim())) {
      problems.add(`The workflow may name its secrets only in the line "${SECRET_LINE}".`);
      continue;
    }
    const chain = parents(lines, index).map((at) => ({ at, text: (lines[at] ?? "").trim() }));
    const job = chain.at(-1)?.text === "jobs:" ? chain.at(-2)?.text.replace(/:$/, "") : undefined;
    // Inside the job, the line must sit in an env, of a step, of the job's steps.
    const inJob = chain.slice(0, -2);
    const [env, step, steps] = inJob;
    if (job === undefined) {
      problems.add("Only the Names job may read the protected names list, and the workflow reads it outside its jobs.");
    } else if (job !== "names") {
      problems.add(`Only the Names job may read the protected names list, and ${job} reads it.`);
    } else if (
      inJob.length !== 3 ||
      env?.text !== "env:" ||
      steps?.text !== "steps:" ||
      step?.text.startsWith("- ") !== true ||
      !stepAt(lines, step.at).includes(NAMES_RUN)
    ) {
      problems.add(`In the Names job, only the env of the step that runs "${NAMES_RUN}" may read the protected names list.`);
    }
  }
  return [...problems];
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
  const all = text.split(/\r?\n/);
  const lines = all.filter(isContent);
  const outsideEnv = (pattern: RegExp, allowed: string): boolean =>
    lines.some((line) => pattern.test(line) && line.trim() !== allowed);
  if (outsideEnv(HEAD_OR_BASE, HEAD_SHA_LINE)) {
    problems.push(`The PR's head and base may appear only in the line "${HEAD_SHA_LINE}".`);
  }
  if (outsideEnv(/triggering_actor/i, ACTOR_LINE)) {
    problems.push(`Who started the run may appear only in the line "${ACTOR_LINE}".`);
  }
  // A run: block is read whole: GitHub fills in an expression even inside a shell comment.
  const runs = runLines(all);
  if ([...runs].some((index) => all[index]?.includes("${{") === true)) {
    problems.push("A run: step holds an expression. Pass the value in through env instead.");
  }
  if (lines.some((line) => /\btoJSON\s*\(/i.test(line))) {
    problems.push("The workflow passes no whole object with toJSON. Pass each value it needs on its own.");
  }
  // Outside run: blocks, YAML itself could build a line that the guard looks for.
  const yaml = all.filter((line, index) => isContent(line) && !runs.has(index)).map((line) => line.replace(/\s+#.*$/, ""));
  if (yaml.some((line) => /(?:^|[\s[{,])[&*][\w-]/.test(line) || /^\s*(?:- )?<<\s*:/.test(line))) {
    problems.push("The workflow uses a YAML anchor or alias. They copy lines without the guard seeing them.");
  }
  if (yaml.some((line) => line.includes("\\"))) {
    problems.push("The workflow holds a backslash outside run:. YAML reads it as an escape in a quoted text.");
  }

  problems.push(...secretProblems(all));

  const jobs = children(block(text, "jobs") ?? []);
  for (const [job, jobLines] of jobs) {
    const trimmed = jobLines.map((line) => line.trim());
    if (!trimmed.includes(HEAD_SHA_LINE)) {
      problems.push(`The job ${job} must pass "${HEAD_SHA_LINE}" to its check.`);
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
