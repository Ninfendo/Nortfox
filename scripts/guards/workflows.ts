// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the approval workflow as its checks need it (docs/plan.md, section 6).
// It runs on pull_request_target only, so GitHub always runs the default
// branch's copy, in the default branch's context, and never the PR's. It uses
// no action but checkout and setup-node, and gives each only the inputs listed
// below, so a checkout never names another repository. It checks out the
// default branch only. One run per PR runs at a time. Each check gets the head
// commit that the event names, and Names gets who started the run, both
// through env and never inside a run: line. The workflow names the PR only by
// its number, and its secrets in one line only: the list, in the env of the
// Names step that runs the check. Names checks out the whole history so that
// it can find where the PR branched off.
//
// The guard reads the text, line by line. So outside run: the workflow keeps
// to the YAML that the guard can read: each line is one plain key, with a
// value that ends on that line. It does without each form that would hide a
// line or a key from the guard, or build one out of its sight: a quoted key, a
// space before a colon, a text over more lines, a { } or [ ] form, a value
// read by index or by a .* filter, toJSON, a YAML anchor or alias, a backslash
// escape, and a character that YAML reads as a line break.

/** The types of pull_request_target event that start the workflow. */
export const APPROVAL_EVENT_TYPES = ["opened", "synchronize", "reopened", "edited", "ready_for_review", "labeled", "unlabeled"];

export const CONCURRENCY = [
  "  group: approvals-${{ github.event.pull_request.number }}",
  "  cancel-in-progress: false",
];

/** The actions the workflow may use, each with the inputs it may give that action. */
const ACTION_INPUTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["actions/checkout", ["ref", "fetch-depth", "persist-credentials"]],
  ["actions/setup-node", ["node-version-file", "package-manager-cache"]],
]);

const DEFAULT_BRANCH = "${{ github.event.repository.default_branch }}";
const HEAD_SHA_LINE = "HEAD_SHA: ${{ github.event.pull_request.head.sha }}";
const ACTOR_LINE = "TRIGGERING_ACTOR: ${{ github.triggering_actor }}";
const SECRET_LINE = "PROTECTED_NAMES: ${{ secrets.PROTECTED_NAMES }}";
const NAMES_RUN = "run: node scripts/names/cli.ts --pr";
/**
 * More of the PR than its number: its head or base, any other part of it, and
 * github.event.after and github.event.before, which on synchronize are head
 * commits of the PR. GitHub reads names in any case. A name read by index or
 * by a .* filter is refused on its own, since the guard cannot tell what it reads.
 */
const PR_PART = /pull_request(?!\w)(?!\s*\.\s*number\b)|\b(?:head|base)_ref\b|\bevent\s*\.\s*(?:after|before)\b/i;
/** What YAML may read as a line break, where the guard reads none. */
const LINE_BREAK = /[\r\u0085\u2028\u2029]/;
/** The start of a line of one plain key, up to its colon. */
const KEY_LINE = /^ *(?:- )?[A-Za-z0-9_-]+:/;
/** The { } and [ ] forms that the guard reads: {}, and a one-line list of plain words. */
const PLAIN_FLOW = /^(?:\{\}|\[[A-Za-z0-9_-]+(?:, [A-Za-z0-9_-]+)*\])$/;
/** An action pinned to a commit, and its name. */
const PINNED_ACTION = /^([\w.-]+\/[\w.-]+)@[0-9a-f]{40}$/i;

const isContent = (line: string): boolean => line.trim() !== "" && !line.trimStart().startsWith("#");
const withoutComment = (line: string): string => line.replace(/\s+#.*$/, "");

/** "a", "a and b", "a, b and c". */
function listed(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.slice(-1).join("")}`;
}

/** A line of one plain key: the key, and the rest of the line after its colon. */
function keyOf(line: string): { key: string; rest: string } | undefined {
  if (!KEY_LINE.test(line)) {
    return undefined;
  }
  const body = line.trimStart().replace(/^- /, "");
  const colon = body.indexOf(":");
  return { key: body.slice(0, colon), rest: body.slice(colon + 1) };
}

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

/**
 * Where the run: lines are, and the lines of their values: those indented
 * further than the run key, as a block text's body is, and blank lines among
 * them. The next key of a step that starts with "- run:" sits at the run key's
 * own column, so it is no part of the value.
 */
function runLines(lines: readonly string[]): { keys: Set<number>; bodies: Set<number> } {
  const keys = new Set<number>();
  const bodies = new Set<number>();
  let column: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (column !== undefined && (indentOf(line) > column || line.trim() === "")) {
      bodies.add(index);
      continue;
    }
    column = undefined;
    if (/^ *(?:- )?run:(?: |$)/.test(line)) {
      keys.add(index);
      column = line.indexOf("run:");
    }
  }
  return { keys, bodies };
}

/**
 * Whether the guard can read a line, its comment taken off: one plain key,
 * then nothing, or a value that ends on that line. A quoted key, a space
 * before the colon, a list item without a key, a quote that the line does not
 * close, and a text after | or >, which goes on over the lines below, all fail.
 */
function isPlainLine(line: string): boolean {
  const rest = keyOf(line)?.rest;
  if (rest === undefined || (rest !== "" && !rest.startsWith(" "))) {
    return false;
  }
  const value = rest.trim();
  if (value.startsWith('"')) {
    return /^"[^"]*"$/.test(value);
  }
  if (value.startsWith("'")) {
    return /^'(?:[^']|'')*'$/.test(value);
  }
  return !/^[|>]/.test(value);
}

/** Whether a line, its comment taken off, holds a { } or [ ] form, an index or a .* filter. */
function hidesInBrackets(line: string): boolean {
  const value = (keyOf(line)?.rest ?? line).trim();
  return !PLAIN_FLOW.test(value) && /[[\]{}]|\.\s*\*/.test(value.replaceAll("${{", "").replaceAll("}}", ""));
}

/** A key line as the guard reads it: where its key sits, and whether it starts a list item. */
interface Entry {
  readonly indent: number;
  readonly column: number;
  readonly item: boolean;
  readonly key: string;
  readonly value: string;
}

/** The key lines outside the values of run: steps, their comments taken off, in order. */
function entriesOf(lines: readonly string[], bodies: ReadonlySet<number>): Entry[] {
  const found: Entry[] = [];
  for (const [index, line] of lines.entries()) {
    const text = withoutComment(line);
    const keyed = keyOf(text);
    if (bodies.has(index) || !isContent(line) || keyed === undefined) {
      continue;
    }
    const indent = indentOf(text);
    const item = text.trimStart().startsWith("- ");
    found.push({ indent, column: indent + (item ? 2 : 0), item, key: keyed.key, value: keyed.rest.trim() });
  }
  return found;
}

/** The entries after the one at `index` that sit further in than `column`, with where each is. */
function under(entries: readonly Entry[], index: number, column: number): { found: Entry; at: number }[] {
  const end = entries.findIndex((entry, at) => at > index && entry.indent <= column);
  return entries.slice(index + 1, end === -1 ? undefined : end).map((found, offset) => ({ found, at: index + 1 + offset }));
}

/**
 * What is wrong with the actions: each uses: names one of ACTION_INPUTS,
 * pinned to a commit, and a step gives its action only that action's inputs.
 */
function actionProblems(entries: readonly Entry[]): string[] {
  const problems: string[] = [];
  /** The action that a uses: value names, with the inputs it may get, when it is one of ACTION_INPUTS, pinned. */
  const actionOf = (value: string): { name: string; inputs: readonly string[] } | undefined => {
    const name = PINNED_ACTION.exec(value)?.[1]?.toLowerCase();
    const inputs = name === undefined ? undefined : ACTION_INPUTS.get(name);
    return name === undefined || inputs === undefined ? undefined : { name, inputs };
  };
  for (const [index, entry] of entries.entries()) {
    if (entry.key === "uses" && actionOf(entry.value) === undefined) {
      problems.push(
        `The workflow may use only ${listed([...ACTION_INPUTS.keys()])}, each pinned to a full commit SHA. It uses "${entry.value}".`,
      );
    }
    if (!entry.item) {
      continue;
    }
    // A list item, such as a step. Its own keys sit at its column: the one on its "- " line, and those below it.
    const own = [{ found: entry, at: index }, ...under(entries, index, entry.indent)].filter(({ found }) => found.column === entry.column);
    const actions = own.filter(({ found }) => found.key === "uses").map(({ found }) => actionOf(found.value));
    for (const { found, at } of own.filter(({ found }) => found.key === "with")) {
      const inputs = under(entries, at, found.column).map((input) => input.found.key);
      for (const action of actions.filter((known) => known !== undefined)) {
        const extra = inputs.filter((input) => !action.inputs.includes(input));
        if (extra.length > 0) {
          problems.push(`The step that uses ${action.name} may give it only ${listed(action.inputs)}. It also gives ${listed(extra)}.`);
        }
      }
    }
  }
  return problems;
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

  const refs = [...text.matchAll(/^\s*(?:- )?ref:[ \t]*(.*?)[ \t]*$/gm)].map(([, ref]) => ref);
  if (refs.length === 0 || refs.some((ref) => ref !== DEFAULT_BRANCH)) {
    problems.push("Every checkout must check out the default branch, and nothing else.");
  }

  const all = text.split(/\r?\n/);
  const runs = runLines(all);
  problems.push(...actionProblems(entriesOf(all, runs.bodies)));

  // Comments may name anything; only what the workflow does counts.
  const lines = all.filter(isContent);
  const outsideEnv = (pattern: RegExp, allowed: string): boolean =>
    lines.some((line) => pattern.test(line) && line.trim() !== allowed);
  if (outsideEnv(PR_PART, HEAD_SHA_LINE)) {
    problems.push(
      `The workflow may name the PR only by github.event.pull_request.number, and its head commit only in the line "${HEAD_SHA_LINE}". ` +
        "So it names no other part of the PR, no head_ref or base_ref, and no github.event.after or github.event.before.",
    );
  }
  if (outsideEnv(/triggering_actor/i, ACTOR_LINE)) {
    problems.push(`Who started the run may appear only in the line "${ACTOR_LINE}".`);
  }
  // A run: block is read whole: GitHub fills in an expression even inside a shell comment.
  if ([...runs.keys, ...runs.bodies].some((index) => all[index]?.includes("${{") === true)) {
    problems.push("A run: step holds an expression. Pass the value in through env instead.");
  }
  if (lines.some((line) => /\btoJSON\s*\(/i.test(line))) {
    problems.push("The workflow passes no whole object with toJSON. Pass each value it needs on its own.");
  }
  // A comment line counts too: YAML would start a new line after the break.
  if (all.some((line) => LINE_BREAK.test(line))) {
    problems.push(
      "The workflow holds a character that YAML reads as a line break, where the guard sees none: " +
        "a carriage return without a line feed, U+0085, U+2028 or U+2029.",
    );
  }
  // Outside run: blocks, YAML itself could hide a line or build one that the guard looks for.
  const yaml = all
    .filter((line, index) => isContent(line) && !runs.keys.has(index) && !runs.bodies.has(index))
    .map(withoutComment);
  if (!yaml.every(isPlainLine)) {
    problems.push(
      "Outside run:, each line must be one plain key, with a value that ends on that line. " +
        "The guard cannot read a quoted key, a space before a colon, a list item without a key, or a text over more lines, as after | or >.",
    );
  }
  if (yaml.some(hidesInBrackets)) {
    problems.push(
      "The workflow holds { }, [ ] or a .* filter outside run:. The guard cannot see the keys in a { } or [ ] form, " +
        "or what an index such as a['b'] or a filter reads. Only {} and a one-line list of plain words may hold brackets.",
    );
  }
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
