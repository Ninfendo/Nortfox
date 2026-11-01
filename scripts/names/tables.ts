// SPDX-License-Identifier: AGPL-3.0-only

// The command line that the two table generators share
// (update-entities.ts and update-confusables.ts). Without an option it
// writes the table from the pinned upstream file. With --check it writes
// nothing, and fails when the committed table is not the one the pinned file
// gives: the tests cannot see a changed value, because the pinned file is not
// in the repository.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Transport } from "../github/api.ts";

export interface TableGenerator {
  /** The committed table. */
  readonly file: URL;
  /** Downloads the pinned file, checks it, and gives the table. */
  readonly build: (transport: Transport) => Promise<string>;
}

export interface Outcome {
  readonly code: number;
  readonly line: string;
}

/** The lines of a text, without the empty one after its last line break. */
function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** Where a committed table first differs from the one the pinned file gives, or undefined when they are the same. */
export function tableDifference(path: string, committed: string, built: string): string | undefined {
  if (committed === built) {
    return undefined;
  }
  const have = linesOf(committed);
  const want = linesOf(built);
  const first = have.findIndex((line, index) => line !== want[index]);
  const at = first === -1 ? have.length : first;
  const table = have[at] === undefined ? "the table ends" : `the table has ${JSON.stringify(have[at])}`;
  const pinned = want[at] === undefined ? "the pinned file ends" : `the pinned file gives ${JSON.stringify(want[at])}`;
  const where =
    at < have.length || at < want.length ? `At line ${String(at + 1)}, ${table}, and ${pinned}.` : "Only the line break at its end differs.";
  return `${path} is not the table the pinned file gives. ${where}`;
}

/** Runs a generator with its command-line arguments: no option, or --check. */
export async function runGenerator(args: readonly string[], generator: TableGenerator, transport: Transport): Promise<Outcome> {
  const unknown = args.find((arg) => arg !== "--check");
  if (unknown !== undefined) {
    return { code: 2, line: `Unknown option ${JSON.stringify(unknown)}. Give no option to write the table, or --check to compare it.` };
  }
  const path = fileURLToPath(generator.file);
  const built = await generator.build(transport);
  if (args.includes("--check")) {
    const difference = tableDifference(path, readFileSync(generator.file, "utf8"), built);
    return difference === undefined ? { code: 0, line: `${path} is the table the pinned file gives.` } : { code: 1, line: difference };
  }
  writeFileSync(generator.file, built);
  return { code: 0, line: `Wrote ${path}.` };
}
