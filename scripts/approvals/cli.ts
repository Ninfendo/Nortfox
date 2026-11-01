// SPDX-License-Identifier: AGPL-3.0-only

// The approval workflow's checks. It runs from the base branch and reads the
// PR only through the API, as data.
//
//   node scripts/approvals/cli.ts outside-approval
//   node scripts/approvals/cli.ts owner-ok
//   node scripts/approvals/cli.ts names-mirror
//
// Settings come from the environment: GITHUB_TOKEN, GITHUB_REPOSITORY,
// PR_NUMBER and OWNER_LOGIN; owner-ok also reads EVENT_ACTION, BEFORE_SHA,
// AFTER_SHA and NAMES_RESULT.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { field, pullRequestContext, stringField, type GitHub } from "../github/api.ts";
import { decideOutsideApproval, decideOwnerOk, labelMustGo, OWNER_OK_LABEL, type Review } from "./decide.ts";
import { OWNER_PATHS_FILE, parseOwnerPaths } from "./owner-paths.ts";

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

interface Pr {
  readonly prefix: string;
  readonly number: string;
  readonly github: GitHub;
  readonly data: unknown;
  readonly headSha: string;
}

async function loadPr(env: Io["env"]): Promise<Pr> {
  const { github, repository, number } = pullRequestContext(env);
  const prefix = `/repos/${repository}`;
  const data = await github.get(`${prefix}/pulls/${String(number)}`);
  return { prefix, number: String(number), github, data, headSha: stringField(field(data, "head"), "sha") };
}

function requireEnv(env: Io["env"], name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

async function outsideApproval(io: Io): Promise<boolean> {
  const owner = requireEnv(io.env, "OWNER_LOGIN");
  const pr = await loadPr(io.env);
  const listed = await pr.github.list(`${pr.prefix}/pulls/${pr.number}/reviews?per_page=100`);
  const reviews: Review[] = listed.map((review) => ({
    login: stringField(field(review, "user"), "login"),
    state: stringField(review, "state"),
    commitId: stringField(review, "commit_id"),
  }));
  const verdict = decideOutsideApproval({
    owner,
    author: stringField(field(pr.data, "user"), "login"),
    headSha: pr.headSha,
    reviews,
  });
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

/** The most files the compare API lists. A push with more cannot be read in full. */
const COMPARE_FILE_LIMIT = 300;

async function pushTouchesOwnerPaths(io: Io, pr: Pr, globs: readonly string[]): Promise<boolean> {
  const before = requireEnv(io.env, "BEFORE_SHA");
  const after = requireEnv(io.env, "AFTER_SHA");
  const compare = await pr.github.find(`${pr.prefix}/compare/${before}...${after}`);
  const files = field(compare, "files");
  const listed = Array.isArray(files) ? (files as unknown[]) : [];
  const status = field(compare, "status");
  return labelMustGo({
    compareStatus: typeof status === "string" ? status : undefined,
    pushedPaths: changedPaths(listed),
    complete: listed.length < COMPARE_FILE_LIMIT,
    globs,
  });
}

async function ownerOk(io: Io): Promise<boolean> {
  const globs = parseOwnerPaths(readFileSync(join(io.cwd, OWNER_PATHS_FILE), "utf8"));
  const pr = await loadPr(io.env);
  let labels = labelsOf(pr.data);

  if (io.env["EVENT_ACTION"] === "synchronize" && labels.includes(OWNER_OK_LABEL)) {
    if (await pushTouchesOwnerPaths(io, pr, globs)) {
      await pr.github.remove(`${pr.prefix}/issues/${pr.number}/labels/${OWNER_OK_LABEL}`);
      labels = labels.filter((label) => label !== OWNER_OK_LABEL);
      io.out("Owner OK: the new commits touch owner paths, so the owner-ok label is removed.");
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
 * A review changes no text, so on a review the names check repeats the
 * verdict of the last full check on the head commit (the pull_request_target
 * run, which has the secret), waiting for it if it still runs.
 */
async function namesMirror(io: Io): Promise<boolean> {
  const pr = await loadPr(io.env);
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
