// SPDX-License-Identifier: AGPL-3.0-only

// What each mode checks. A source gathers the files and the text fields;
// check.ts does the checking.

import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { field, numberField, stringField, type GitHub } from "../github/api.ts";
import { gitBytes, gitText, gitTextOrUndefined, nulList } from "./git.ts";
import { ALLOWLIST_FILE, isMarker, parseAllowlist } from "./markers.ts";

export interface SourceFile {
  readonly path: string;
  /** How to name the file if its path holds a name. */
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
}

export interface Source {
  readonly files: readonly SourceFile[];
  readonly fields: readonly TextField[];
  /** Every marker the check can see, also those in files it does not check. */
  readonly markers: readonly string[];
  /** The marker allowlist, read from the base branch. */
  readonly allowlist: readonly string[];
}

/** The marker allowlist on the base branch. A base that cannot be read means an empty list. */
export function baseAllowlist(cwd: string, base: string): string[] {
  const text = gitTextOrUndefined(cwd, ["show", `${base}:${ALLOWLIST_FILE}`]);
  return text === undefined ? [] : parseAllowlist(text);
}

function readWorkingFile(cwd: string, path: string): Uint8Array | undefined {
  const full = join(cwd, path);
  let stats;
  try {
    stats = lstatSync(full);
  } catch {
    // Tracked but deleted in the working tree: nothing to read.
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    return Buffer.from(readlinkSync(full), "utf8");
  }
  if (stats.isDirectory()) {
    // A submodule.
    return undefined;
  }
  return readFileSync(full);
}

/**
 * The fields of one commit: its message, and the name and e-mail address of
 * its author and of its committer. They are public on every commit, and a
 * squash merge copies the authors into the commit on main.
 */
function commitFields(sha: string, message: string, author: string, committer: string): TextField[] {
  const commit = `commit ${sha.slice(0, 7)}`;
  return [
    { field: commit, text: message },
    { field: `${commit} author`, text: author },
    { field: `${commit} committer`, text: committer },
  ];
}

function lastCommit(cwd: string): TextField[] {
  const text = gitTextOrUndefined(cwd, ["log", "-1", "--format=%H%n%an <%ae>%n%cn <%ce>%n%B"]);
  if (text === undefined) {
    return [];
  }
  const [sha = "", author = "", committer = "", ...message] = text.split("\n");
  return commitFields(sha, message.join("\n").trimEnd(), author, committer);
}

/** --all: every tracked file and its contents, and the last commit. */
export function allSource(cwd: string, base: string): Source {
  const paths = nulList(gitText(cwd, ["ls-files", "-z"]));
  return {
    files: paths.map((path, index) => ({
      path,
      alias: `tracked file ${String(index + 1)} (git ls-files)`,
      bytes: readWorkingFile(cwd, path),
    })),
    fields: lastCommit(cwd),
    markers: paths.filter(isMarker),
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

/** --staged: the staged files, as staged, the branch name, and who the next commit names. */
export function stagedSource(cwd: string, base: string): Source {
  const paths = nulList(gitText(cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT"]));
  const branch = gitTextOrUndefined(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim();
  const fields: TextField[] = branch === undefined || branch === "" ? [] : [{ field: "branch name", text: branch }];
  for (const [label, variable] of IDENTITIES) {
    const text = nextIdentity(cwd, variable);
    if (text !== undefined) {
      fields.push({ field: label, text });
    }
  }
  return {
    files: paths.map((path, index) => ({
      path,
      alias: `staged file ${String(index + 1)} (git diff --cached --name-only)`,
      bytes: gitBytes(cwd, ["cat-file", "blob", `:${path}`]),
    })),
    fields,
    markers: nulList(gitText(cwd, ["ls-files", "-z"])).filter(isMarker),
    allowlist: baseAllowlist(cwd, base),
  };
}

/** --text: one text, for example a commit message from the commit-msg hook. */
export function textSource(text: string, label: string): Source {
  return { files: [], fields: [{ field: label, text }], markers: [], allowlist: [] };
}

/** The most files and commits the API lists for one PR. */
export const MAX_PR_FILES = 3000;
export const MAX_PR_COMMITS = 250;

/** "Name <address>" of a commit's author or committer, as the API gives it. */
function identityOf(person: unknown): string {
  const name = field(person, "name");
  const email = field(person, "email");
  return `${typeof name === "string" ? name : ""} <${typeof email === "string" ? email : ""}>`;
}

/**
 * --pr: the PR's changed files at its head commit, their paths, its title,
 * body and branch name, and every commit's message, author and committer, all
 * read through the API as data. The PR's code is never checked out or run.
 * `pr` is the PR as the API gives it.
 */
export async function pullRequestSource(
  github: GitHub,
  repository: string,
  pr: unknown,
  allowlist: readonly string[],
): Promise<Source> {
  const prefix = `/repos/${repository}`;
  const number = String(numberField(pr, "number"));
  const head = field(pr, "head");
  const headSha = stringField(head, "sha");
  if (numberField(pr, "changed_files") > MAX_PR_FILES) {
    throw new Error(`The PR changes more than ${String(MAX_PR_FILES)} files; the API cannot list them all. Split it.`);
  }
  if (numberField(pr, "commits") > MAX_PR_COMMITS) {
    throw new Error(`The PR has more than ${String(MAX_PR_COMMITS)} commits; the API cannot list them all. Squash or split it.`);
  }

  const files: SourceFile[] = [];
  const changed = await github.list(`${prefix}/pulls/${number}/files?per_page=100`);
  for (const [index, entry] of changed.entries()) {
    if (stringField(entry, "status") === "removed") {
      continue;
    }
    const sha = field(entry, "sha");
    const file = {
      path: stringField(entry, "filename"),
      alias: `changed file ${String(index + 1)} (in the PR's Files tab)`,
    };
    if (typeof sha === "string" && sha !== "") {
      const blob = await github.get(`${prefix}/git/blobs/${sha}`);
      files.push({ ...file, bytes: Buffer.from(stringField(blob, "content"), "base64") });
    } else {
      // A file the API gives no blob for is never passed unread.
      files.push({ ...file, bytes: undefined, unreadable: true });
    }
  }

  const markers = files.map((file) => file.path).filter(isMarker);
  for (const folder of allowlist) {
    const path = `${folder}/.protected-name-ok`;
    if (!markers.includes(path)) {
      const found = await github.find(`${prefix}/contents/${encodeURI(path)}?ref=${headSha}`);
      if (found !== undefined) {
        markers.push(path);
      }
    }
  }

  const fields: TextField[] = [
    { field: "PR title", text: stringField(pr, "title") },
    { field: "PR body", text: typeof field(pr, "body") === "string" ? stringField(pr, "body") : "" },
    { field: "branch name", text: stringField(head, "ref") },
  ];
  const commits = await github.list(`${prefix}/pulls/${number}/commits?per_page=100`);
  for (const commit of commits) {
    const data = field(commit, "commit");
    fields.push(
      ...commitFields(
        stringField(commit, "sha"),
        stringField(data, "message"),
        identityOf(field(data, "author")),
        identityOf(field(data, "committer")),
      ),
    );
  }
  return { files, fields, markers, allowlist };
}
