// SPDX-License-Identifier: AGPL-3.0-only

// A pull request's head commit, read through git as data. The approval
// workflow checks out the default branch with its history. This fetches the
// one commit that a run judges, by its SHA, into that checkout, and reads its
// objects with git cat-file. Nothing is checked out, and nothing from the PR
// runs: no hook, filter, text conversion or attribute of the PR applies. Git
// lists every file and every commit, so nothing is cut off at a limit the way
// an API listing is, and the reads cost no API requests.

import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";

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

/** Splits bytes at each NUL, as String.split does: n NULs give n + 1 parts. */
function splitAtNul(bytes: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let at = 0;
  for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, at)) {
    parts.push(bytes.subarray(at, end));
    at = end + 1;
  }
  parts.push(bytes.subarray(at));
  return parts;
}

/**
 * The paths in a list that git ends each of with a NUL, such as `-z` output,
 * as bytes. git stores a path as bytes, which need not be UTF-8, so a path is
 * never read as text here: the check reads it every way it may be seen.
 */
export function nulSeparated(bytes: Buffer): Buffer[] {
  return splitAtNul(bytes).filter((part) => part.length > 0);
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
  /** The path as git stores it: bytes, which need not be UTF-8. */
  readonly path: Buffer;
  /** A for added, D for deleted, M for modified, T for a changed type, U for unmerged. */
  readonly status: string;
  /** The file's mode at the head: 100644, 100755, 120000 (a link) or 160000 (a submodule). */
  readonly mode: string;
  /** The file's object at the head. */
  readonly sha: string;
}

const RAW_CHANGE = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])$/;

/**
 * Reads what `git diff-tree -r -z --raw --no-renames` prints, and `git diff
 * --cached` with the same options: a line of modes, objects and a status,
 * then a path, each ended by a NUL. The path is kept as its bytes. Anything
 * else fails, so no file is ever passed unread.
 */
export function parseRawChanges(output: Buffer): Change[] {
  const parts = splitAtNul(output);
  if (parts.pop()?.length !== 0 || parts.length % 2 !== 0) {
    throw new SnapshotError("git listed the changed files in a form the check cannot read.");
  }
  const changes: Change[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = RAW_CHANGE.exec(parts[index]?.toString("latin1") ?? "");
    const path = parts[index + 1];
    if (match === null || path === undefined) {
      throw new SnapshotError("git listed the changed files in a form the check cannot read.");
    }
    changes.push({ path, mode: String(match[1]), sha: String(match[2]), status: String(match[3]) });
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
    ),
  );
}

/** The commits that the head has and the base has not, oldest first: the PR's commits. */
export function commitsBetween(cwd: string, base: string, head: string): string[] {
  return lines(git(cwd, ["rev-list", "--reverse", requireObjectName(head), "--not", base], "list the PR's commits"), "\n");
}

/** Every path in a commit's tree, as its bytes. */
export function treePaths(cwd: string, commit: string): Buffer[] {
  return nulSeparated(
    git(cwd, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", requireObjectName(commit)], "list the files of the PR's head commit"),
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

/**
 * A commit's texts, each in every reading that someone who looks at the
 * commit may see. The first reading is UTF-8.
 */
export interface CommitText {
  readonly message: readonly string[];
  /** "Name <address>", without the time. */
  readonly author: readonly string[];
  readonly committer: readonly string[];
}

/**
 * The decoders for the encoding that a commit's header names. git converts
 * with iconv, which does not agree with TextDecoder on the byte order of
 * every UTF-16 name, so a UTF-16 name gets both orders. A name that
 * TextDecoder does not know is refused: git may know it, and show a text
 * that the check cannot read.
 */
function declaredDecoders(label: string | undefined): TextDecoder[] {
  if (label === undefined) {
    return [];
  }
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    throw new SnapshotError("A commit is written in a text encoding the check cannot read.");
  }
  return decoder.encoding.startsWith("utf-16") ? [new TextDecoder("utf-16le"), new TextDecoder("utf-16be")] : [decoder];
}

/**
 * Every reading of some bytes of a commit: the bytes as they are, in UTF-8
 * and in Latin-1, and in the encoding that the header names. git shows the
 * bytes as they are when it cannot convert them, so those two readings are
 * always there; the header's encoding alone would leave out what git shows.
 * A reading that does not decode cleanly is kept too: one reading too many
 * can only find more. `shifted` also reads UTF-16 from the second byte,
 * because git converts the whole commit, headers too, so a message may start
 * at either byte of a two-byte unit.
 */
function readingsOf(bytes: Uint8Array, decoders: readonly TextDecoder[], shifted = false): string[] {
  const raw = Buffer.from(bytes);
  const readings = [raw.toString("utf8"), raw.toString("latin1")];
  for (const decoder of decoders) {
    readings.push(decoder.decode(bytes));
    if (shifted && decoder.encoding.startsWith("utf-16")) {
      readings.push(decoder.decode(bytes.subarray(1)));
    }
  }
  return readings;
}

const unique = (readings: readonly string[]): string[] => [...new Set(readings)];

/** Where the headers end: at the first blank line, or at the end when there is none. */
function headerEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) {
      return index;
    }
  }
  return bytes.length;
}

/**
 * The bytes of the one header with this key, without the time: "Name
 * <address>". A commit without exactly one is refused. git fsck refuses such
 * a commit too, and the check never passes a text that it did not find.
 */
function identityBytes(headers: Uint8Array, key: "author" | "committer"): Uint8Array {
  // Latin-1 gives one character per byte, so a place in the text is the same place in the bytes.
  const lines = Buffer.from(headers).toString("latin1").split("\n");
  const found: Uint8Array[] = [];
  let at = 0;
  for (const line of lines) {
    if (line.startsWith(`${key} `)) {
      const start = at + key.length + 1;
      found.push(headers.subarray(start, start + line.slice(key.length + 1).replace(/ \d+ [+-]\d{4}$/, "").length));
    }
    at += line.length + 1;
  }
  const [only] = found;
  if (only === undefined || found.length !== 1) {
    throw new SnapshotError(`A commit does not have exactly one ${key}.`);
  }
  return only;
}

/**
 * A commit's message, author and committer, read from the commit object. The
 * headers are ASCII up to their values, so the object is split on its bytes,
 * and each text is then read every way that git may show it (readingsOf).
 */
export function parseCommit(bytes: Uint8Array): CommitText {
  const end = headerEnd(bytes);
  const headers = bytes.subarray(0, end);
  const encoding = /^encoding (.*)$/m.exec(Buffer.from(headers).toString("latin1"))?.[1];
  const decoders = declaredDecoders(encoding);
  return {
    message: unique(readingsOf(bytes.subarray(end + 2), decoders, true).map((reading) => reading.trimEnd())),
    author: unique(readingsOf(identityBytes(headers, "author"), decoders)),
    committer: unique(readingsOf(identityBytes(headers, "committer"), decoders)),
  };
}
