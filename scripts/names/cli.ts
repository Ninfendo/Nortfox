// SPDX-License-Identifier: AGPL-3.0-only

// The names check (docs/plan.md, section 6). Modes:
//
//   --all      every tracked file, its path and contents, and the last commit
//   --staged   the staged files, the branch name and the next commit's author (the pre-commit hook)
//   --text     standard input, for example a commit message (the commit-msg hook)
//   --pr       a pull request: its head commit read with git, its title and body through the GitHub API
//
// Options: --base <ref> (where the marker allowlist is read; default
// origin/main) and --label <name> (what --text calls its input).
//
// --pr runs in the approval workflow. It also reads OWNER_LOGIN, HEAD_SHA (the
// head commit that the event which started the run names) and
// TRIGGERING_ACTOR (who started the run, or re-ran it). It reads a PR from
// another account with the list only in a run that the owner started, on an
// open PR whose head commit the owner has approved, and its report then gives
// no places: otherwise anyone could fill a PR with guesses and read from the
// public log which of them are on the list. It reads the PR at HEAD_SHA only,
// and gives no result when the PR changed while it read it.

import { readFileSync } from "node:fs";
import { field, stringField } from "../github/api.ts";
import {
  loadPullRequest,
  outsideApprovalOf,
  PullRequestMovedError,
  requireEnv,
  requireUnchanged,
  type PullRequest,
} from "../github/pull-request.ts";
import { check, report } from "./check.ts";
import { allSource, baseAllowlist, pullRequestSource, stagedSource, textSource, type Source } from "./sources.ts";
import { loadWords, WordListError, type Environment } from "./words.ts";

export interface Io {
  readonly cwd: string;
  readonly env: Environment;
  readonly stdin: () => string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

type Mode = "--all" | "--staged" | "--text" | "--pr";
const MODES: readonly string[] = ["--all", "--staged", "--text", "--pr"];

interface Options {
  readonly mode: Mode;
  readonly base: string;
  readonly label: string;
}

const USAGE = "Usage: node scripts/names/cli.ts --all | --staged | --text [--label <name>] | --pr  [--base <ref>]";

function parseArgs(args: readonly string[]): Options | string {
  let mode: Mode | undefined;
  let base = "origin/main";
  let label = "text";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (MODES.includes(arg)) {
      if (mode !== undefined) {
        return "Choose one mode.";
      }
      mode = arg as Mode;
    } else if (arg === "--base" || arg === "--label") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return `${arg} needs a value.`;
      }
      if (arg === "--base") {
        base = value;
      } else {
        label = value;
      }
      index += 1;
    } else {
      return `Unknown argument ${JSON.stringify(arg)}.`;
    }
  }
  return mode === undefined ? "Choose a mode." : { mode, base, label };
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

type Gathered =
  | { readonly kind: "source"; readonly source: Source; readonly showPlaces: boolean }
  | { readonly kind: "waiting"; readonly why: string };

/** The one line for every run that does not read a PR from another account. */
export const WAITING =
  "The PR comes from outside the owner's account. The check reads it only in a run that the owner starts, on an open PR whose head commit the owner has approved. It waits for the owner.";

/** A PR that --pr may read, and whether its report may name places. */
interface Admitted {
  readonly pr: PullRequest;
  readonly fromOwner: boolean;
}

/**
 * Decides whether --pr reads the PR at all, before the list is read. A PR
 * from the owner's account is always read. Any other PR is read only in a run
 * that the owner started, while the PR is open, and once the owner has
 * approved its head commit: the author's own pushes and edits start runs too,
 * and they must never learn anything from the list.
 */
async function admit(io: Io): Promise<Admitted | string> {
  const owner = requireEnv(io.env, "OWNER_LOGIN");
  const pr = await loadPullRequest(io.env);
  if (pr.author === owner) {
    return { pr, fromOwner: true };
  }
  if (io.env["TRIGGERING_ACTOR"] !== owner || field(pr.data, "state") !== "open") {
    return WAITING;
  }
  return (await outsideApprovalOf(pr, owner)).pass ? { pr, fromOwner: false } : WAITING;
}

function gatherLocal(mode: Exclude<Mode, "--pr">, options: Options, io: Io): Gathered {
  switch (mode) {
    case "--all":
      return { kind: "source", source: allSource(io.cwd, options.base), showPlaces: true };
    case "--staged":
      return { kind: "source", source: stagedSource(io.cwd, options.base), showPlaces: true };
    case "--text":
      return { kind: "source", source: textSource(io.stdin(), options.label), showPlaces: true };
  }
}

/**
 * Reads an admitted PR at the head commit the run judges, then reads the PR
 * again. When the head commit, title, body, branch or base changed in
 * between, the run gives no result at all, not even a count.
 */
async function gatherPullRequest({ pr, fromOwner }: Admitted, io: Io): Promise<Gathered> {
  const body = field(pr.data, "body");
  // The approval workflow checks out the default branch only, so HEAD is the base.
  const source = pullRequestSource(
    io.cwd,
    {
      number: pr.number,
      title: stringField(pr.data, "title"),
      body: typeof body === "string" ? body : "",
      branch: stringField(field(pr.data, "head"), "ref"),
      headSha: pr.headSha,
    },
    baseAllowlist(io.cwd, "HEAD"),
  );
  try {
    await requireUnchanged(pr);
  } catch (error) {
    if (error instanceof PullRequestMovedError) {
      return { kind: "waiting", why: error.message };
    }
    throw error;
  }
  return { kind: "source", source, showPlaces: fromOwner };
}

/** Runs the check and gives the exit code: 0 clean, 1 found or failed, 2 misused. */
export async function main(args: readonly string[], io: Io): Promise<number> {
  const options = parseArgs(args);
  if (typeof options === "string") {
    io.err(`names: ${options}`);
    io.err(USAGE);
    return 2;
  }

  // The message of a failed step names the step, never a word from the list.
  const failed = (error: unknown): number => {
    io.err(`names: could not read what to check: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  };

  // --pr decides first whether it reads the PR at all, before it reads the list.
  let read: () => Promise<Gathered>;
  if (options.mode === "--pr") {
    let decided: Admitted | string;
    try {
      decided = await admit(io);
    } catch (error) {
      return failed(error);
    }
    if (typeof decided === "string") {
      io.err(`names: ${decided}`);
      return 1;
    }
    const admitted = decided;
    read = () => gatherPullRequest(admitted, io);
  } else {
    const mode = options.mode;
    read = () => Promise.resolve(gatherLocal(mode, options, io));
  }

  let list;
  try {
    list = loadWords(io.env, readTextFile);
  } catch (error) {
    if (error instanceof WordListError) {
      io.err(`names: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (list.kind === "missing") {
    if (list.required) {
      io.err("names: the protected names list is missing. CI reads it from the PROTECTED_NAMES secret, and the check never passes without it.");
      return 1;
    }
    io.out("names: no protected names list on this machine, so the check is skipped here. CI runs it on every pull request.");
    return 0;
  }

  let gathered: Gathered;
  try {
    gathered = await read();
  } catch (error) {
    return failed(error);
  }
  if (gathered.kind === "waiting") {
    io.err(`names: ${gathered.why}`);
    return 1;
  }
  const { source, showPlaces } = gathered;
  const findings = check(source, list.words);
  for (const line of report(findings, { files: source.files.length, fields: source.fields.length }, showPlaces)) {
    (findings.length === 0 ? io.out : io.err)(line);
  }
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdin: () => readFileSync(0, "utf8"),
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
}
