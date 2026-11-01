// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";

export class GitError extends Error {
  override readonly name = "GitError";
}

/** Runs git and gives back its output as bytes. */
export function gitBytes(cwd: string, args: readonly string[]): Buffer {
  const result = spawnSync("git", args, { cwd, maxBuffer: 512 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw new GitError(`git could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new GitError(`git ${args[0] ?? ""} failed.`);
  }
  return result.stdout;
}

export function gitText(cwd: string, args: readonly string[]): string {
  return gitBytes(cwd, args).toString("utf8");
}

/** Like gitText, but undefined when git fails, for example on a ref that does not exist. */
export function gitTextOrUndefined(cwd: string, args: readonly string[]): string | undefined {
  try {
    return gitText(cwd, args);
  } catch (error) {
    if (error instanceof GitError) {
      return undefined;
    }
    throw error;
  }
}

/** Splits git's NUL-separated path lists. */
export function nulList(text: string): string[] {
  return text.split("\0").filter((item) => item !== "");
}
