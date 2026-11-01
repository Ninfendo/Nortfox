// SPDX-License-Identifier: AGPL-3.0-only

// What each mode checks. A source gathers the files and the text fields;
// check.ts does the checking.

import { isUtf8 } from "node:buffer";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, sep } from "node:path";
import type { PullRequestAuthor } from "../github/pull-request.ts";
import {
  changesBetween,
  commitsBetween,
  fetchCommit,
  mergeBase,
  nulSeparated,
  parseCommit,
  parseRawChanges,
  readObjects,
  treePaths,
} from "../github/snapshot.ts";
import { gitBytes, gitTextOrUndefined } from "./git.ts";
import { ALLOWLIST_FILE, isMarker, parseAllowlist } from "./markers.ts";
import { gitForWindowsName, pathOf, type PathText } from "./scan.ts";

/**
 * A file. Its path is read from the bytes git gives for it, in every way
 * that someone who looks at it may see (scan.ts, pathOf).
 */
export interface SourceFile extends PathText {
  /** How to name the file if some reading of its path holds a name. */
  readonly alias: string;
  /** Undefined for a file whose contents are not checked (a submodule). */
  readonly bytes: Uint8Array | undefined;
  /** True when the file has contents the check cannot get, which fails the check. */
  readonly unreadable?: boolean;
}

export interface TextField {
  /** "PR title", "branch name", "commit 1a2b3c4", "commit 1a2b3c4 author". */
  readonly field: string;
  readonly text: string;
  /**
   * More readings of the same bytes, such as a commit's message read in
   * another encoding. A name in any of them is found at the field's place.
   */
  readonly alsoReadAs?: readonly string[];
}

export interface Source {
  readonly files: readonly SourceFile[];
  readonly fields: readonly TextField[];
  /** Every marker the check can see, also those in files it does not check. */
  readonly markers: readonly PathText[];
  /** The marker allowlist, read from the base branch. */
  readonly allowlist: readonly string[];
}

/** The mode git gives a submodule. */
const SUBMODULE = "160000";

/** The marker allowlist on the base branch. A base that cannot be read means an empty list. */
export function baseAllowlist(cwd: string, base: string): string[] {
  const text = gitTextOrUndefined(cwd, ["show", `${base}:${ALLOWLIST_FILE}`]);
  return text === undefined ? [] : parseAllowlist(text);
}

/** The paths of every marker among these paths, which are bytes as git gives them. */
function markersAmong(paths: readonly Buffer[]): PathText[] {
  return paths.map(pathOf).filter((path) => isMarker(path.path));
}

/**
 * Where git wrote a tracked file in the working tree. On Windows that is the
 * name Git for Windows gives the path. Elsewhere it is the path's own bytes,
 * which the file system keeps as they are.
 */
function workingPath(cwd: string, path: Buffer): string | Buffer {
  return process.platform === "win32"
    ? join(cwd, gitForWindowsName(path))
    : Buffer.concat([Buffer.from(`${cwd}${sep}`, "utf8"), path]);
}

/** A tracked file's contents in the working tree, from its path as git gives it. */
function readWorkingFile(cwd: string, path: Buffer): Pick<SourceFile, "bytes" | "unreadable"> {
  const full = workingPath(cwd, path);
  let stats;
  try {
    stats = lstatSync(full);
  } catch {
    // Tracked but deleted in the working tree: nothing to read. A path that
    // is not UTF-8 may also be one that the check could not find, so it
    // fails instead.
    return isUtf8(path) ? { bytes: undefined } : { bytes: undefined, unreadable: true };
  }
  if (stats.isSymbolicLink()) {
    return { bytes: readlinkSync(full, { encoding: "buffer" }) };
  }
  if (stats.isDirectory()) {
    // A submodule.
    return { bytes: undefined };
  }
  return { bytes: readFileSync(full) };
}

/** One field, read every way in `readings`. */
function fieldOf(field: string, readings: readonly string[]): TextField {
  const [text = "", ...alsoReadAs] = readings;
  return alsoReadAs.length === 0 ? { field, text } : { field, text, alsoReadAs };
}

/**
 * The fields of one commit: its message, and the name and e-mail address of
 * its author and of its committer, each in every reading given. They are
 * public on every commit, and a squash merge copies the authors into the
 * commit on main.
 */
function commitFields(
  sha: string,
  message: readonly string[],
  author: readonly string[],
  committer: readonly string[],
): TextField[] {
  const commit = `commit ${sha.slice(0, 7)}`;
  return [fieldOf(commit, message), fieldOf(`${commit} author`, author), fieldOf(`${commit} committer`, committer)];
}

function lastCommit(cwd: string): TextField[] {
  const text = gitTextOrUndefined(cwd, ["log", "-1", "--format=%H%n%an <%ae>%n%cn <%ce>%n%B"]);
  if (text === undefined) {
    return [];
  }
  const [sha = "", author = "", committer = "", ...message] = text.split("\n");
  return commitFields(sha, [message.join("\n").trimEnd()], [author], [committer]);
}

/** --all: every tracked file and its contents, and the last commit. */
export function allSource(cwd: string, base: string): Source {
  const paths = nulSeparated(gitBytes(cwd, ["ls-files", "-z"]));
  return {
    files: paths.map((path, index) => ({
      ...pathOf(path),
      alias: `tracked file ${String(index + 1)} (git ls-files)`,
      ...readWorkingFile(cwd, path),
    })),
    fields: lastCommit(cwd),
    markers: markersAmong(paths),
    allowlist: baseAllowlist(cwd, base),
  };
}

const IDENTITIES = [
  ["author (git var GIT_AUTHOR_IDENT)", "GIT_AUTHOR_IDENT"],
  ["committer (git var GIT_COMMITTER_IDENT)", "GIT_COMMITTER_IDENT"],
] as const;

/**
 * The name and e-mail address git will write into the next commit, without
 * the time: "Name <address>". Undefined when git has none.
 */
function nextIdentity(cwd: string, variable: string): string | undefined {
  return gitTextOrUndefined(cwd, ["var", variable])
    ?.trim()
    .replace(/ \d+ [+-]\d{4}$/, "");
}

/**
 * --staged: the staged files, as staged, the branch name, and who the next
 * commit names. Each file is read by the object that the index holds for it,
 * so its path is never handed back to git as text.
 */
export function stagedSource(cwd: string, base: string): Source {
  const changes = parseRawChanges(gitBytes(cwd, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"]));
  const branch = gitTextOrUndefined(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim();
  const fields: TextField[] = branch === undefined || branch === "" ? [] : [{ field: "branch name", text: branch }];
  for (const [label, variable] of IDENTITIES) {
    const text = nextIdentity(cwd, variable);
    if (text !== undefined) {
      fields.push({ field: label, text });
    }
  }
  const files: SourceFile[] = [];
  for (const [index, change] of changes.entries()) {
    // A deleted file has nothing to read, and git commits nothing while a file is unmerged.
    if (change.status === "D" || change.status === "U") {
      continue;
    }
    const file = {
      ...pathOf(change.path),
      alias: `staged file ${String(index + 1)} (git diff --cached --name-only --no-renames)`,
    };
    files.push(
      change.mode === SUBMODULE
        ? { ...file, bytes: undefined, unreadable: true }
        : { ...file, bytes: gitBytes(cwd, ["cat-file", "blob", change.sha]) },
    );
  }
  return {
    files,
    fields,
    markers: markersAmong(nulSeparated(gitBytes(cwd, ["ls-files", "-z"]))),
    allowlist: baseAllowlist(cwd, base),
  };
}

/** --text: one text, for example a commit message from the commit-msg hook. */
export function textSource(text: string, label: string): Source {
  return { files: [], fields: [{ field: label, text }], markers: [], allowlist: [] };
}

/** What --pr reads from the PR itself, through the API. */
export interface PullRequestText {
  readonly number: string;
  readonly title: string;
  readonly body: string;
  /** The PR's branch: its head ref. */
  readonly branch: string;
  /** The head commit the run judges. */
  readonly headSha: string;
  /** The account that opened the PR. */
  readonly author: PullRequestAuthor;
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * The texts that a squash merge writes into the default branch: the title, a
 * blank line and the body. One text checks them together, so a name split
 * between the title and the body is found. A second one is the commit
 * message exactly as GitHub writes it, with the PR number after the title,
 * because the number's digits fold to letters too.
 */
function squashFields(pr: PullRequestText): TextField[] {
  const title = `${pr.title} (#${pr.number})`;
  return [
    { field: "PR title and body", text: `${pr.title}\n\n${pr.body}` },
    { field: "squash commit message", text: pr.body === "" ? title : `${title}\n\n${pr.body}` },
  ];
}

/**
 * The author that a squash merge writes into the commit on the default
 * branch: the account that opened the PR, by its profile name, or its login
 * when it has none, and by an e-mail address. That is the account's noreply
 * address, in its newer form with the account's number or its older one, or
 * the account's own address. The check reads the public one. A private
 * address is not in the API, so the check cannot read it.
 */
function squashAuthorField(author: PullRequestAuthor): TextField {
  const name = author.name ?? author.login;
  const addresses = [
    `${String(author.id)}+${author.login}@users.noreply.github.com`,
    `${author.login}@users.noreply.github.com`,
    ...(author.email === undefined ? [] : [author.email]),
  ];
  return fieldOf(
    "PR author",
    addresses.map((address) => `${name} <${address}>`),
  );
}

/**
 * --pr: the PR's changed files at its head commit, their paths, every marker
 * in the head commit, the PR's title, body and branch name, the author that
 * the squash merge will name, and every commit's message, author and
 * committer. `cwd` is a checkout of the default branch,
 * with its history. The head commit is fetched there by its SHA and read with
 * git as data (../github/snapshot.ts): the PR's code is never checked out or
 * run, and nothing newer than that commit is read.
 */
export function pullRequestSource(cwd: string, pr: PullRequestText, allowlist: readonly string[]): Source {
  const head = pr.headSha;
  fetchCommit(cwd, head);
  const base = mergeBase(cwd, "HEAD", head);
  const changes = changesBetween(cwd, base, head);
  const readable = changes.filter((change) => change.status !== "D" && change.mode !== SUBMODULE);
  const blob = readObjects(cwd, readable.map((change) => change.sha), "blob");
  const files: SourceFile[] = [];
  for (const [index, change] of changes.entries()) {
    if (change.status === "D") {
      continue;
    }
    const file = {
      ...pathOf(change.path),
      alias: `changed file ${String(index + 1)} (git diff --name-only --no-renames ${short(base)} ${short(head)})`,
    };
    // A submodule's contents are in another repository, so the check cannot read them.
    files.push(
      change.mode === SUBMODULE ? { ...file, bytes: undefined, unreadable: true } : { ...file, bytes: blob(change.sha) },
    );
  }

  const fields: TextField[] = [
    { field: "PR title", text: pr.title },
    { field: "PR body", text: pr.body },
    ...squashFields(pr),
    squashAuthorField(pr.author),
    { field: "branch name", text: pr.branch },
  ];
  const commits = commitsBetween(cwd, "HEAD", head);
  const commit = readObjects(cwd, commits, "commit");
  for (const sha of commits) {
    const { message, author, committer } = parseCommit(commit(sha));
    fields.push(...commitFields(sha, message, author, committer));
  }
  return { files, fields, markers: markersAmong(treePaths(cwd, head)), allowlist };
}
