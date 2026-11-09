// SPDX-License-Identifier: AGPL-3.0-only

// docs/api.md lists what a client of /v1 relies on: each operation with its
// method, path, permission and whether the assistant may call it, each
// problem code with its status, and each field problem code. This test reads
// those tables and holds them to the contract, so a new operation or code
// changes docs/api.md in the same change, and a stale row fails. The ledger's
// rules are not listed one by one there: one row stands for them, and
// db/README.md lists every reason.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIELD_PROBLEM_CODES, LEDGER_RULES, PROBLEM_CODES } from "./problem.ts";
import { REGISTRY } from "./registry.ts";

/** docs/api.md, as lines. */
const LINES = readFileSync(new URL("../../../docs/api.md", import.meta.url), "utf8").split(/\r?\n/);

/** The lines of the section under a heading, up to the next heading of its level or higher. */
function section(heading: string): string[] {
  const start = LINES.indexOf(heading);
  if (start < 0) {
    throw new Error(`docs/api.md has no heading "${heading}".`);
  }
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const end = LINES.findIndex((line, index) => index > start && /^#+ /.test(line) && (/^#+/.exec(line)?.[0].length ?? 0) <= level);
  return LINES.slice(start + 1, end < 0 ? undefined : end);
}

/** The cells of a table row. */
function cellsOf(line: string): string[] {
  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/** The body rows, as cells, of the table in a section whose header row has these cells. */
function table(heading: string, header: readonly string[]): string[][] {
  const lines = section(heading);
  const start = lines.findIndex((line) => line.startsWith("|") && cellsOf(line).join("|") === header.join("|"));
  if (start < 0) {
    throw new Error(`docs/api.md has no table "${header.join(" | ")}" under "${heading}".`);
  }
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    rows.push(cellsOf(line));
  }
  return rows;
}

/** The one name that a cell writes in backticks and nothing else, or undefined. */
function onlyName(cell: string | undefined): string | undefined {
  return /^`([^`]+)`$/.exec(cell ?? "")?.[1];
}

/** Every name that a cell writes in backticks. */
function names(cell: string | undefined): string[] {
  return [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((match) => String(match[1]));
}

const RULES: ReadonlySet<string> = new Set(LEDGER_RULES);

describe("docs/api.md's operations", () => {
  const rows = table("## Operations", ["Operation", "Method and path", "Output", "Permission", "Open to the assistant"]);

  it.each(REGISTRY.map((operation) => [operation.operationId, operation] as const))("lists %s with its method, path, permission and the assistant's access", (id, operation) => {
    const row = rows.find((cells) => onlyName(cells[0]) === id);
    expect(row, `docs/api.md's table of operations has no row for ${id}.`).toBeDefined();
    const meta = operation["x-nortfox"];
    expect(row?.[1]).toBe(`\`${operation.method.toUpperCase()} ${operation.path}\``);
    expect(row?.[3]).toBe(`\`${meta.permission}\``);
    expect(row?.[4]).toBe(meta.assistant ? "yes" : "no");
  });

  it("lists only the registry's operations, each once", () => {
    expect(rows.map((cells) => onlyName(cells[0]))).toEqual(REGISTRY.map((operation) => operation.operationId));
  });
});

describe("docs/api.md's problem codes", () => {
  const rows = table("### Codes", ["Status", "Code", "When"]);
  const listed = rows.filter((cells) => onlyName(cells[1]) !== undefined);

  it.each(Object.entries(PROBLEM_CODES).filter(([code]) => !RULES.has(code)))("lists %s with the status %i", (code, status) => {
    const row = listed.find((cells) => onlyName(cells[1]) === code);
    expect(row, `docs/api.md's table of codes has no row for ${code}.`).toBeDefined();
    expect(row?.[0]).toBe(String(status));
  });

  it("lists each code once, and only codes of the contract that are no ledger rule", () => {
    const codes = listed.map((cells) => String(onlyName(cells[1])));
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(Object.keys(PROBLEM_CODES), code).toContain(code);
      expect(RULES.has(code), `${code} is a ledger rule, which the row "a rule's code" stands for.`).toBe(false);
    }
  });

  it("gives the ledger's rules one row of their own, with the status 422", () => {
    const others = rows.filter((cells) => onlyName(cells[1]) === undefined);
    expect(others.map((cells) => [cells[0], cells[1]])).toEqual([["422", "a rule's code"]]);
  });

  it("names in that row only codes of the ledger's rules", () => {
    const row = rows.find((cells) => cells[1] === "a rule's code");
    for (const code of names(row?.[2])) {
      expect(RULES.has(code), code).toBe(true);
    }
  });
});

describe("docs/api.md's field problem codes", () => {
  const rows = table("### Codes", ["Code", "When"]);
  const listed = rows.flatMap((cells) => names(cells[0]));

  it.each([...FIELD_PROBLEM_CODES])("lists %s", (code) => {
    expect(listed).toContain(code);
  });

  it("lists each code once, and only codes of the contract", () => {
    expect(new Set(listed).size).toBe(listed.length);
    for (const code of listed) {
      expect(FIELD_PROBLEM_CODES, code).toContain(code);
    }
  });
});
