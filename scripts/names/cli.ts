// SPDX-License-Identifier: AGPL-3.0-only

// The names check (docs/plan.md, section 6). Modes:
//
//   --all      every tracked file, its path and contents, and the last commit message
//   --staged   the staged files and the branch name (the pre-commit hook)
//   --text     standard input, for example a commit message (the commit-msg hook)
//   --pr       a pull request, read through the GitHub API (the approval workflow)
//
// Options: --base <ref> (where the marker allowlist is read; default
// origin/main) and --label <name> (what --text calls its input).

import { readFileSync } from "node:fs";
import { pullRequestContext } from "../github/api.ts";
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

async function gather(options: Options, io: Io): Promise<Source> {
  switch (options.mode) {
    case "--all":
      return allSource(io.cwd, options.base);
    case "--staged":
      return stagedSource(io.cwd, options.base);
    case "--text":
      return textSource(io.stdin(), options.label);
    case "--pr": {
      const { github, repository, number } = pullRequestContext(io.env);
      // The approval workflow checks out the base branch only, so HEAD is the base.
      return pullRequestSource(github, repository, number, baseAllowlist(io.cwd, "HEAD"));
    }
  }
}

/** Runs the check and gives the exit code: 0 clean, 1 found or failed, 2 misused. */
export async function main(args: readonly string[], io: Io): Promise<number> {
  const options = parseArgs(args);
  if (typeof options === "string") {
    io.err(`names: ${options}`);
    io.err(USAGE);
    return 2;
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

  let source: Source;
  try {
    source = await gather(options, io);
  } catch (error) {
    // The message names a step, never a word from the list.
    io.err(`names: could not read what to check: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
  const findings = check(source, list.words);
  for (const line of report(findings, { files: source.files.length, fields: source.fields.length })) {
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
