// SPDX-License-Identifier: AGPL-3.0-only

// Throwaway git repositories for the tests of the repository's own checks.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Made-up words for the tests. The real list never appears in a test. */
export const FAKE_WORDS = ["zarquon", "blirvex"] as const;
export const FAKE_LIST = FAKE_WORDS.join("\n");

export interface TestRepo {
  readonly dir: string;
  write(path: string, contents: string | Uint8Array): void;
  git(...args: string[]): string;
  /**
   * Stages a file under a path given as bytes, which need not be UTF-8, as
   * git stores it. git reads the path from its input, so no argument has to
   * carry it. The working tree is left as it is.
   */
  stageBytes(path: Uint8Array, contents: string): void;
  commitAll(message: string): void;
  remove(): void;
}

export interface CloneOf {
  readonly origin: TestRepo;
  /** How many commits of history to clone; all of them when left out. */
  readonly depth?: number;
}

/**
 * A throwaway repository. With `clone`, a clone of another one's main branch,
 * over git's own transport, so that only what the branch reaches comes along:
 * the approval workflow's checkout of the default branch, whose origin is the
 * other repository.
 */
export function createTestRepo(clone?: CloneOf): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "nortfox-names-"));
  const gitWith = (input: Uint8Array | undefined, args: readonly string[]): string => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf8", input },
    );
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  };
  const git = (...args: string[]): string => gitWith(undefined, args);
  if (clone === undefined) {
    git("init", "--quiet", "--initial-branch=main");
  } else {
    const depth = clone.depth === undefined ? [] : ["--depth", String(clone.depth)];
    git("clone", "--quiet", "--branch", "main", ...depth, "--", pathToFileURL(clone.origin.dir).href, ".");
  }
  // The names check reads the identity of the next commit with git var, so
  // the repository carries its own, whatever this machine's git config says.
  // Written straight into the config file: one git process fewer per setting.
  appendFileSync(
    join(dir, ".git", "config"),
    "[core]\n\tautocrlf = false\n[user]\n\tname = Test\n\temail = test@example.invalid\n",
  );
  return {
    dir,
    write(path, contents) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    },
    git,
    stageBytes(path, contents) {
      const blob = gitWith(Buffer.from(contents, "utf8"), ["hash-object", "-w", "--stdin"]).trim();
      gitWith(Buffer.concat([Buffer.from(`100644 ${blob}\t`), path, Buffer.from([0])]), ["update-index", "--add", "-z", "--index-info"]);
    },
    commitAll(message) {
      git("add", "--all");
      git("commit", "--quiet", "--allow-empty", "-m", message);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
