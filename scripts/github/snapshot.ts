// SPDX-License-Identifier: AGPL-3.0-only

// A pull request's head commit, read through git as data. The approval
// workflow checks out the default branch with its history. This fetches the
// one commit that a run judges, by its SHA, into that checkout, and reads its
// objects with git cat-file. Nothing is checked out, and nothing from the PR
// runs: no hook, filter, text conversion or attribute of the PR applies. Git
// lists every file and every commit, so nothing is cut off at a limit the way
// an API listing is, and the reads cost no API requests.

import { spawnSync } from "node:child_process";

export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
}

/** A full object name, SHA-1 or SHA-256. Anything else is refused before git sees it. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function requireObjectName(name: string): string {
  if (!OBJECT_NAME.test(name)) {
    throw new SnapshotError("A commit or file is named by something that is not a full SHA.");
  }
  return name;
}

function git(cwd: string, args: readonly string[], step: string, input?: string): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    input,
    maxBuffer: 1024 * 1024 * 1024,
    // A fetch that needs a password fails at once instead of waiting for one.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error !== undefined) {
    throw new SnapshotError(`git could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new SnapshotError(`git could not ${step}.`);
  }
  return result.stdout;
}

function lines(output: Buffer, separator: string): string[] {
  return output
    .toString("utf8")
    .split(separator)
    .filter((item) => item !== "");
}

/**
 * Fetches one commit by its SHA from origin, with the objects it needs. It
 * writes no branch, no tag and no FETCH_HEAD.
 */
export function fetchCommit(cwd: string, sha: string): void {
  requireObjectName(sha);
  git(
    cwd,
    ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", sha],
    "fetch the PR's head commit",
  );
  if (git(cwd, ["cat-file", "-t", sha], "find the PR's head commit").toString("utf8").trim() !== "commit") {
    throw new SnapshotError("The PR's head is not a commit.");
  }
}

/** Where the head branched off the base: the commit git diffs the PR against, as GitHub does. */
export function mergeBase(cwd: string, base: string, head: string): string {
  return git(cwd, ["merge-base", base, requireObjectName(head)], "find where the PR branched off the default branch")
    .toString("utf8")
    .trim();
}

export interface Change {
  readonly path: string;
  /** A for added, D for deleted, M for modified, T for a changed type. */
  readonly status: string;
  /** The file's mode at the head: 100644, 100755, 120000 (a link) or 160000 (a submodule). */
  readonly mode: string;
  /** The file's object at the head. */
  readonly sha: string;
}

const RAW_CHANGE = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])$/;

/**
 * Reads what `git diff-tree -r -z --raw --no-renames` prints: a line of
 * modes, objects and a status, then a path, each ended by a NUL. Anything
 * else fails, so no file is ever passed unread.
 */
export function parseRawChanges(output: string): Change[] {
  const parts = output.split("\0");
  if (parts.pop() !== "" || parts.length % 2 !== 0) {
    throw new SnapshotError("git listed the changed files in a form the check cannot read.");
  }
  const changes: Change[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = RAW_CHANGE.exec(String(parts[index]));
    if (match === null) {
      throw new SnapshotError("git listed the changed files in a form the check cannot read.");
    }
    changes.push({ path: String(parts[index + 1]), mode: String(match[1]), sha: String(match[2]), status: String(match[3]) });
  }
  return changes;
}

/** Every file that differs between two commits, in git's order, renames read as a delete and an add. */
export function changesBetween(cwd: string, from: string, to: string): Change[] {
  return parseRawChanges(
    git(
      cwd,
      ["diff-tree", "-r", "-z", "--raw", "--no-renames", requireObjectName(from), requireObjectName(to)],
      "list the PR's changed files",
    ).toString("utf8"),
  );
}

/** The commits that the head has and the base has not, oldest first: the PR's commits. */
export function commitsBetween(cwd: string, base: string, head: string): string[] {
  return lines(git(cwd, ["rev-list", "--reverse", requireObjectName(head), "--not", base], "list the PR's commits"), "\n");
}

/** Every path in a commit's tree. */
export function treePaths(cwd: string, commit: string): string[] {
  return lines(
    git(cwd, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", requireObjectName(commit)], "list the files of the PR's head commit"),
    "\0",
  );
}

/**
 * Reads the objects with these names in one git process, each once however
 * often it is named, exactly as git stores them. Each must be of the given
 * type. Gives a lookup that fails for a name it was not given.
 */
export function readObjects(cwd: string, names: readonly string[], type: "blob" | "commit"): (name: string) => Buffer {
  const unique = [...new Set(names.map(requireObjectName))];
  const objects = new Map<string, Buffer>();
  const output =
    unique.length === 0
      ? Buffer.alloc(0)
      : git(cwd, ["cat-file", "--batch"], `read the PR's ${type}s`, unique.map((name) => `${name}\n`).join(""));
  let at = 0;
  for (const name of unique) {
    const end = output.indexOf(0x0a, at);
    const header = output.subarray(at, Math.max(end, at)).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (end === -1 || header[0] !== name || header[1] !== type || !Number.isInteger(size)) {
      throw new SnapshotError(`git could not read one of the PR's ${type}s.`);
    }
    objects.set(name, output.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return (name) => {
    const found = objects.get(name);
    if (found === undefined) {
      throw new SnapshotError(`The check did not read the ${type} it looks for.`);
    }
    return found;
  };
}

export interface CommitText {
  readonly message: string;
  /** "Name <address>", without the time. */
  readonly author: string;
  readonly committer: string;
}

function decode(bytes: Uint8Array, encoding: string | undefined): string {
  let decoder;
  try {
    decoder = new TextDecoder(encoding ?? "utf-8");
  } catch {
    throw new SnapshotError("A commit is written in a text encoding the check cannot read.");
  }
  return decoder.decode(bytes);
}

/**
 * A commit's message, author and committer, read from the commit object. The
 * whole object is read in the encoding its header names, as git log does.
 */
export function parseCommit(bytes: Uint8Array): CommitText {
  // The headers are ASCII up to their values, so Latin-1 finds the encoding header safely.
  const encoding = /^encoding (.+)$/m.exec(Buffer.from(bytes).toString("latin1").split("\n\n", 1).join(""))?.[1];
  const text = decode(bytes, encoding);
  const split = text.indexOf("\n\n");
  const headers = (split === -1 ? text : text.slice(0, split)).split("\n");
  const identity = (key: string): string =>
    (headers.find((line) => line.startsWith(`${key} `)) ?? "").slice(key.length + 1).replace(/ \d+ [+-]\d{4}$/, "");
  return {
    message: split === -1 ? "" : text.slice(split + 2).trimEnd(),
    author: identity("author"),
    committer: identity("committer"),
  };
}
