// SPDX-License-Identifier: AGPL-3.0-only

// Loads the list of protected names. In CI the list comes from the
// PROTECTED_NAMES secret and nothing else; on a laptop it comes from that
// variable or from a file outside the repository. Nothing here ever prints a
// word from the list.

import { homedir } from "node:os";
import { join } from "node:path";
import { fold } from "./fold.ts";

/** The shortest a folded name may be: shorter would match almost anything. */
export const MIN_WORD_LENGTH = 3;

export type WordList =
  | { readonly kind: "words"; readonly words: readonly string[] }
  | { readonly kind: "missing"; readonly required: boolean };

export type Environment = Readonly<Record<string, string | undefined>>;

export class WordListError extends Error {
  override readonly name = "WordListError";
}

/** True when the check runs in CI, where the list must be there. */
export function inCi(env: Environment): boolean {
  return env["GITHUB_ACTIONS"] === "true" || env["CI"] === "true";
}

/** Where the list sits on a laptop. */
export function localListPath(env: Environment): string {
  return env["NORTFOX_PROTECTED_NAMES_FILE"] ?? join(homedir(), ".nortfox", "protected-names.txt");
}

/** Folds the list: one name per line; empty lines and # comments are skipped. */
export function parseWords(text: string): string[] {
  const words: string[] = [];
  let entry = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    entry += 1;
    const folded = fold(trimmed);
    if (folded.length < MIN_WORD_LENGTH) {
      throw new WordListError(
        `Entry ${String(entry)} of the protected names list is too short to check once folded.`,
      );
    }
    words.push(folded);
  }
  return [...new Set(words)];
}

export function loadWords(env: Environment, readText: (path: string) => string | undefined): WordList {
  const required = inCi(env);
  const fromEnv = env["PROTECTED_NAMES"];
  const text = fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : required ? undefined : readText(localListPath(env));
  if (text === undefined) {
    return { kind: "missing", required };
  }
  const words = parseWords(text);
  if (words.length === 0) {
    return { kind: "missing", required };
  }
  return { kind: "words", words };
}
