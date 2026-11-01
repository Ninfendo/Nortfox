// SPDX-License-Identifier: AGPL-3.0-only

// The approval workflow's checks. It runs from the default branch and reads
// the PR only through the API, as data.
//
//   node scripts/approvals/cli.ts outside-approval
//   node scripts/approvals/cli.ts owner-ok
//   node scripts/approvals/cli.ts names-mirror
//
// Settings come from the environment: GITHUB_TOKEN, GITHUB_REPOSITORY,
// PR_NUMBER and OWNER_LOGIN; owner-ok also reads NAMES_RESULT. Each command
// fails a PR that is not aimed at the default branch.
//
// Each command decides from the PR as it is when it runs, never from the
// event that started it. So a run that is missed, fails or is dropped leaves
// nothing behind that a later run would trust.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { field, stringField } from "../github/api.ts";
import { loadPullRequest, outsideApprovalOf, requireEnv, type PullRequest } from "../github/pull-request.ts";
import { decideLabelHolds, decideOwnerOk, OWNER_OK_LABEL, type BranchMove, type LabelEvent, type Verdict } from "./decide.ts";
import { OWNER_PATHS_FILE, parseOwnerPaths } from "./owner-paths.ts";

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

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

  const files = await pr.github.list(`${pr.prefix}/pulls/${pr.number}/files?per_page=100`);
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

const MIRROR_WAIT_MS = 15_000;
const MIRROR_ROUNDS = 40;

/**
 * On a review in a run without the list (a PR from a fork), the names check
 * repeats the verdict of the last full check on the head commit (a
 * pull_request_target run, which has the list), waiting for it if it still
 * runs.
 */
async function namesMirror(io: Io): Promise<boolean> {
  const pr = await loadPullRequest(io.env);
  for (let round = 0; round < MIRROR_ROUNDS; round += 1) {
    const answer = await pr.github.get(
      `${pr.prefix}/commits/${pr.headSha}/check-runs?check_name=Names&filter=all&per_page=100`,
    );
    const runs = field(answer, "check_runs");
    let waiting = false;
    let latest: { completedAt: string; conclusion: string } | undefined;
    for (const run of Array.isArray(runs) ? (runs as unknown[]) : []) {
      const suite = field(field(run, "check_suite"), "id");
      const workflows = await pr.github.get(
        `${pr.prefix}/actions/runs?check_suite_id=${String(suite)}&event=pull_request_target&per_page=1`,
      );
      const found = field(workflows, "workflow_runs");
      if (!Array.isArray(found) || found.length === 0) {
        continue;
      }
      if (stringField(run, "status") !== "completed") {
        waiting = true;
        continue;
      }
      const completedAt = stringField(run, "completed_at");
      if (latest === undefined || completedAt > latest.completedAt) {
        latest = { completedAt, conclusion: stringField(run, "conclusion") };
      }
    }
    if (!waiting && latest !== undefined) {
      const pass = latest.conclusion === "success";
      (pass ? io.out : io.err)(`Names: the last full check on this commit ended in ${latest.conclusion}.`);
      return pass;
    }
    if (!waiting) {
      io.err("Names: no full check has run on this commit yet. Its own run will report.");
      return false;
    }
    await io.sleep(MIRROR_WAIT_MS);
  }
  io.err("Names: the full check on this commit did not finish in time.");
  return false;
}

const COMMANDS: Readonly<Record<string, (io: Io) => Promise<boolean>>> = {
  "outside-approval": outsideApproval,
  "owner-ok": ownerOk,
  "names-mirror": namesMirror,
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
