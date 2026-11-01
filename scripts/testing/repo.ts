// SPDX-License-Identifier: AGPL-3.0-only

// Throwaway git repositories for the tests of the repository's own checks.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Made-up words for the tests. The real list never appears in a test. */
export const FAKE_WORDS = ["zarquon", "blirvex"] as const;
export const FAKE_LIST = FAKE_WORDS.join("\n");

export interface TestRepo {
  readonly dir: string;
  write(path: string, contents: string | Uint8Array): void;
  git(...args: string[]): string;
  commitAll(message: string): void;
  remove(): void;
}

export function createTestRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "nortfox-names-"));
  const git = (...args: string[]): string => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  return {
    dir,
    write(path, contents) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    },
    git,
    commitAll(message) {
      git("add", "--all");
      git("commit", "--quiet", "--allow-empty", "-m", message);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
