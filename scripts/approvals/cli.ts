// SPDX-License-Identifier: AGPL-3.0-only

// The approval workflow's checks. It runs from the default branch and reads
// the PR only through the API, as data.
//
//   node scripts/approvals/cli.ts outside-approval
//   node scripts/approvals/cli.ts owner-ok
//
// Settings come from the environment: GITHUB_TOKEN, GITHUB_REPOSITORY,
// PR_NUMBER, HEAD_SHA and OWNER_LOGIN; owner-ok also reads NAMES_RESULT. Each
// command fails a PR that is not aimed at the default branch, and a PR whose
// head is not HEAD_SHA, the commit that the event which started the run names.
//
// Each command decides from the PR as it is when it runs. From the event it
// takes only the head commit, to refuse a PR that has moved on. So a run that
// is missed, fails or is dropped leaves nothing behind that a later run would
// trust.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { field, numberField, stringField } from "../github/api.ts";
import { loadPullRequest, outsideApprovalOf, requireEnv, requireUnchanged, type PullRequest } from "../github/pull-request.ts";
import { decideLabelHolds, decideOwnerOk, OWNER_OK_LABEL, type BranchMove, type LabelEvent, type Verdict } from "./decide.ts";
import { OWNER_PATHS_FILE, parseOwnerPaths } from "./owner-paths.ts";

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The most changed files GitHub lists for one PR. */
export const MAX_LISTED_FILES = 3000;

async function outsideApproval(io: Io): Promise<boolean> {
  const owner = requireEnv(io.env, "OWNER_LOGIN");
  const verdict = await outsideApprovalOf(await loadPullRequest(io.env), owner);
  (verdict.pass ? io.out : io.err)(`Outside approval: ${verdict.why}`);
  return verdict.pass;
}

function changedPaths(files: readonly unknown[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    paths.push(stringField(file, "filename"));
    const previous = field(file, "previous_filename");
    if (typeof previous === "string") {
      paths.push(previous);
    }
  }
  return paths;
}

function labelsOf(data: unknown): string[] {
  const labels = field(data, "labels");
  return Array.isArray(labels) ? labels.map((label) => stringField(label, "name")) : [];
}

/** The last time the owner-ok label was set, from the PR's issue events (oldest first). */
function lastLabelEvent(events: readonly unknown[]): LabelEvent | undefined {
  const set = events
    .filter((event) => field(event, "event") === "labeled" && field(field(event, "label"), "name") === OWNER_OK_LABEL)
    .at(-1);
  return set === undefined ? undefined : { actor: stringField(field(set, "actor"), "login"), at: stringField(set, "created_at") };
}

/** The newest push to `ref` in a page of repository activity. */
function lastBranchMove(activity: unknown, ref: string): BranchMove | undefined {
  let last: BranchMove | undefined;
  for (const entry of Array.isArray(activity) ? (activity as unknown[]) : []) {
    if (field(entry, "ref") !== ref) {
      continue;
    }
    const move = { after: stringField(entry, "after"), at: stringField(entry, "timestamp") };
    if (last === undefined || Date.parse(move.at) > Date.parse(last.at)) {
      last = move;
    }
  }
  return last;
}

/**
 * Whether the owner-ok label counts for the PR's head commit. It reads who set
 * the label and when, and when the PR's branch last moved and to which
 * commit. Anything it cannot read means the label does not count.
 */
async function labelHolds(pr: PullRequest, owner: string): Promise<Verdict> {
  let label: LabelEvent | undefined;
  let lastMove: BranchMove | undefined;
  try {
    label = lastLabelEvent(await pr.github.list(`${pr.prefix}/issues/${pr.number}/events?per_page=100`));
    const head = field(pr.data, "head");
    const ref = `refs/heads/${stringField(head, "ref")}`;
    const repository = stringField(field(head, "repo"), "full_name");
    lastMove = lastBranchMove(
      await pr.github.get(`/repos/${repository}/activity?ref=${encodeURIComponent(ref)}&direction=desc&per_page=10`),
      ref,
    );
  } catch (error) {
    return {
      pass: false,
      why: `Owner OK could not read when the label was set and when the PR's branch last moved (${error instanceof Error ? error.message : "unknown error"}).`,
    };
  }
  return decideLabelHolds({ owner, headSha: pr.headSha, label, lastMove });
}

async function ownerOk(io: Io): Promise<boolean> {
  const owner = requireEnv(io.env, "OWNER_LOGIN");
  const globs = parseOwnerPaths(readFileSync(join(io.cwd, OWNER_PATHS_FILE), "utf8"));
  const pr = await loadPullRequest(io.env);
  let labels = labelsOf(pr.data);

  if (labels.includes(OWNER_OK_LABEL)) {
    const holds = await labelHolds(pr, owner);
    if (!holds.pass) {
      labels = labels.filter((label) => label !== OWNER_OK_LABEL);
      io.out(`Owner OK: ${holds.why} The owner-ok label is removed.`);
      await pr.github.remove(`${pr.prefix}/issues/${pr.number}/labels/${OWNER_OK_LABEL}`);
    }
  }

  // A listing cut off at GitHub's limit could leave out an owner path, so it never counts.
  const changed = numberField(pr.data, "changed_files");
  if (changed > MAX_LISTED_FILES) {
    io.err(`Owner OK: The PR changes more than ${String(MAX_LISTED_FILES)} files, and GitHub lists only ${String(MAX_LISTED_FILES)}. Split it.`);
    return false;
  }
  const files = await pr.github.list(`${pr.prefix}/pulls/${pr.number}/files?per_page=100`);
  if (files.length !== changed) {
    io.err(`Owner OK: GitHub listed ${String(files.length)} changed files, but the PR changes ${String(changed)}. Run the check again.`);
    return false;
  }
  // The file list is read live, so the head must still be the commit this run judges.
  await requireUnchanged(pr);
  const verdict = decideOwnerOk({
    namesResult: io.env["NAMES_RESULT"] ?? "missing",
    paths: changedPaths(files),
    globs,
    labels,
  });
  // The names check passed before any path is printed, so no path holds a name.
  for (const path of verdict.ownerPaths) {
    io.out(`Owner path: ${path}`);
  }
  (verdict.pass ? io.out : io.err)(`Owner OK: ${verdict.why}`);
  return verdict.pass;
}

const COMMANDS: Readonly<Record<string, (io: Io) => Promise<boolean>>> = {
  "outside-approval": outsideApproval,
  "owner-ok": ownerOk,
};

export async function main(args: readonly string[], io: Io): Promise<number> {
  const command = COMMANDS[args[0] ?? ""];
  if (command === undefined || args.length !== 1) {
    io.err(`Usage: node scripts/approvals/cli.ts ${Object.keys(COMMANDS).join(" | ")}`);
    return 2;
  }
  try {
    return (await command(io)) ? 0 : 1;
  } catch (error) {
    io.err(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
}
