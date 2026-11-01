// SPDX-License-Identifier: AGPL-3.0-only

// The fixture guard (docs/plan.md, step 1). It refuses a real-looking
// personal identity number, coordination number, organisation number or
// e-mail address that is not on its list of test values,
// scripts/fixtures/test-values.txt. Modes:
//
//   --all      every tracked file, its path and contents ("pnpm fixtures", CI)
//   --staged   the staged files, as staged (the pre-commit hook)
//
// It reads files the way the names check does (../names/sources.ts), and
// prints only where a value is and its kind, never the value.

import { readFileSync } from "node:fs";
import { allSource, stagedSource, type SourceFile } from "../names/sources.ts";
import { report, scanFile } from "./check.ts";
import { parseTestValues } from "./test-values.ts";

export interface Io {
  readonly cwd: string;
  /** The text of the list of test values. */
  readonly testValues: () => string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = "Usage: node scripts/fixtures/cli.ts --all | --staged";

/** The files of a mode. Neither mode reads the marker allowlist, so its base is HEAD. */
function filesOf(mode: string, cwd: string): readonly SourceFile[] {
  return mode === "--all" ? allSource(cwd, "HEAD").files : stagedSource(cwd, "HEAD").files;
}

/** Runs the guard and gives the exit code: 0 clean, 1 found or failed, 2 misused. */
export function main(args: readonly string[], io: Io): number {
  const [mode, ...rest] = args;
  if (mode === undefined || !["--all", "--staged"].includes(mode) || rest.length > 0) {
    io.err(`fixtures: ${mode === undefined ? "Choose a mode." : "Give one mode and nothing else."}`);
    io.err(USAGE);
    return 2;
  }
  let files: readonly SourceFile[];
  let listText: string;
  try {
    listText = io.testValues();
    files = filesOf(mode, io.cwd);
  } catch (error) {
    io.err(`fixtures: could not read what to check: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
  const { values, problems } = parseTestValues(listText);
  if (problems.length > 0) {
    for (const problem of problems) {
      io.err(`fixtures: ${problem}`);
    }
    io.err("fixtures: fix the list of test values first.");
    return 1;
  }
  const findings = files.flatMap((file) => scanFile(file, values));
  for (const line of report(findings, files.length)) {
    (findings.length === 0 ? io.out : io.err)(line);
  }
  return findings.length === 0 ? 0 : 1;
}

/** What the command line gives the guard: the list of test values next to this file, and the console. */
export function processIo(cwd: string): Io {
  return {
    cwd,
    testValues: () => readFileSync(new URL("./test-values.txt", import.meta.url), "utf8"),
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  };
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), processIo(process.cwd()));
}
