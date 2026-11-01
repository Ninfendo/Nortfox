// SPDX-License-Identifier: AGPL-3.0-only

// The fixture guard over a throwaway repository. The planted numbers come
// from Skatteverket's published test series: the committed list lets them
// through, and the tests that must find them give the guard an empty list.
// Planted addresses are joined while the tests run.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { address } from "../testing/personal-data.ts";
import { createTestRepo, type TestRepo } from "../testing/repo.ts";
import { main, processIo } from "./cli.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMMITTED = readFileSync(new URL("./test-values.txt", import.meta.url), "utf8");

const SUMMARY_END =
  "The guard never shows what it found. Use a test value from scripts/fixtures/test-values.txt, or an address at example.com or under .test or .invalid.";

/** Each kind in each form, one per line, as the guard should find them without a list. */
const PLANTED: readonly (readonly [string, string])[] = [
  ["19900101-2385", "personal identity number (personnummer)"],
  ["199001012385", "personal identity number (personnummer)"],
  ["19900101+2385", "personal identity number (personnummer)"],
  ["900101-2385", "personal identity number (personnummer)"],
  ["900101+2385", "personal identity number (personnummer)"],
  ["9001012385", "personal identity number (personnummer)"],
  ["20260161-2381", "coordination number (samordningsnummer)"],
  ["202601612381", "coordination number (samordningsnummer)"],
  ["260161-2381", "coordination number (samordningsnummer)"],
  ["260161+2381", "coordination number (samordningsnummer)"],
  ["2601612381", "coordination number (samordningsnummer)"],
  ["556000-0167", "organisation number"],
  ["16556000-0167", "organisation number"],
  ["165560000167", "organisation number"],
  [address("ann.berg", "zarquon.se"), "e-mail address"],
  [`mailto:${address("Ann", "Zarquon.SE")}`, "e-mail address"],
  [`"${address("bo", "mail.zarquon.se")}"`, "e-mail address"],
];

/** Values that look like the kinds above but are not, so the guard lets them through without a list. */
const NEAR_MISSES = [
  "19900101-2386",
  "900101-2380",
  "19901301-2385",
  "19900132-2385",
  "19900230-2385",
  "19000229-2385",
  "19900192-2385",
  "21900101-2385",
  "556000-0168",
  "456000-0167",
  "5560000167",
  "1767225600",
  "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "@types/node",
  "typescript@7.0.2",
  "git@github.com:owner/repo.git",
  "https://user:token@registry.zarquon.se/",
  "logo@2x.png",
];

/** The forms the committed list lets through. */
const ALLOWED = [
  "19900101-2385",
  "199001012385",
  "900101-2385",
  "900101+2385",
  "9001012385",
  "20000101-2384",
  "20100101-2382",
  "20260161-2381",
  "260161-2381",
  "556000-0167",
  "16556000-0167",
  "165560000167",
  "599999-0129",
  "noreply@anthropic.com",
  address("ann", "example.com"),
  address("ann", "example.org"),
  address("ann", "example.net"),
  address("ann", "zarquon.example"),
  address("ann", "zarquon.test"),
  address("ann", "zarquon.invalid"),
  address("ann", "app.localhost"),
  address("1043590+zarquon", "users.noreply.github.com"),
];

const repos: TestRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.remove();
  }
});

function repo(): TestRepo {
  const created = createTestRepo();
  repos.push(created);
  return created;
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

function run(args: string[], cwd: string, testValues = ""): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, {
    cwd,
    testValues: () => testValues,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

/** No line of the output holds a planted value, in any of its forms, or a part of a planted address. */
function expectNoValue(lines: readonly string[]): void {
  const text = lines.join("\n").toLowerCase();
  for (const [value] of PLANTED) {
    expect(text).not.toContain(value.toLowerCase());
    const digits = value.replace(/\D/g, "");
    if (digits !== "") {
      expect(text).not.toContain(digits.slice(-10));
    }
  }
  expect(text).not.toMatch(/zarquon|ann\.berg|\d{4}/);
}

describe("--all", () => {
  it("finds each kind in each form, in contents and in a path, and never shows it", () => {
    const r = repo();
    r.write("docs/people.md", `${PLANTED.map(([value]) => `Value: ${value}`).join("\n")}\n`);
    r.write("docs/clean.md", "Nothing here.\n");
    r.write("fixtures/19900101-2385.json", "{}\n");
    r.commitAll("Start");

    const result = run(["--all"], r.dir);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([
      ...PLANTED.map(([, kind], index) =>
        kind === "e-mail address"
          ? `fixtures: docs/people.md:${String(index + 1)} holds an e-mail address outside the reserved example domains.`
          : `fixtures: docs/people.md:${String(index + 1)} holds a real-looking ${kind}.`,
      ),
      "fixtures: tracked file 3 (git ls-files) (its path) holds a real-looking personal identity number (personnummer).",
      `fixtures: checked 3 files; ${String(PLANTED.length + 1)} to fix. ${SUMMARY_END}`,
    ]);
    expectNoValue(result.err);
  });

  it("lets through the near misses without a list, and the allowed forms with the committed list", () => {
    const r = repo();
    r.write("docs/near.md", `${NEAR_MISSES.join("\n")}\n`);
    r.write("docs/allowed.md", `${ALLOWED.join("\n")}\n`);
    r.commitAll("Start");
    r.git("rm", "--quiet", "--cached", "docs/allowed.md");
    expect(run(["--all"], r.dir)).toEqual({ code: 0, out: ["fixtures: checked 1 files. Nothing found."], err: [] });
    r.git("add", "docs/allowed.md");
    expect(run(["--all"], r.dir, COMMITTED)).toEqual({ code: 0, out: ["fixtures: checked 2 files. Nothing found."], err: [] });
  });

  it("reads tracked files as they are in the working tree, and no untracked file", () => {
    const r = repo();
    r.write("docs/a.md", "clean\n");
    r.commitAll("Start");
    r.write("docs/a.md", "19900101-2385\n");
    r.write("docs/untracked.md", "20000101-2384\n");
    expect(run(["--all"], r.dir).err).toEqual([
      "fixtures: docs/a.md:1 holds a real-looking personal identity number (personnummer).",
      `fixtures: checked 1 files; 1 to fix. ${SUMMARY_END}`,
    ]);
  });
});

describe("--staged", () => {
  it("reads the staged files as staged, and skips a staged deletion", () => {
    const r = repo();
    r.write("docs/a.md", "clean\n");
    r.write("docs/b.md", "clean\n");
    r.write("docs/c.md", "clean\n");
    r.commitAll("Start");

    // Staged with a value, then cleaned in the working tree only: the commit would hold the value.
    r.write("docs/a.md", "556000-0167\n");
    r.git("add", "docs/a.md");
    r.write("docs/a.md", "clean again\n");
    // Changed in the working tree only: not part of the commit.
    r.write("docs/b.md", "19900101-2385\n");
    r.git("rm", "--quiet", "docs/c.md");

    const result = run(["--staged"], r.dir);
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "fixtures: docs/a.md:1 holds a real-looking organisation number.",
      `fixtures: checked 1 files; 1 to fix. ${SUMMARY_END}`,
    ]);
  });

  it("names a staged file whose path holds a value by its place in the list", () => {
    const r = repo();
    r.commitAll("Start");
    r.write("docs/clean.md", "clean\n");
    r.write(`docs/${address("ann", "zarquon.se")} notes.md`, "clean\n");
    r.git("add", "--all");
    const result = run(["--staged"], r.dir);
    expect(result.err).toEqual([
      "fixtures: staged file 1 (git diff --cached --name-only --no-renames) (its path) holds an e-mail address outside the reserved example domains.",
      `fixtures: checked 2 files; 1 to fix. ${SUMMARY_END}`,
    ]);
    expectNoValue(result.err);
  });

  it("passes when nothing is staged", () => {
    const r = repo();
    r.commitAll("Start");
    expect(run(["--staged"], r.dir)).toEqual({ code: 0, out: ["fixtures: checked 0 files. Nothing found."], err: [] });
  });
});

describe("the command line", () => {
  it.each([
    [[], "fixtures: Choose a mode."],
    [["--text"], "fixtures: Give one mode and nothing else."],
    [["--all", "--staged"], "fixtures: Give one mode and nothing else."],
  ])("refuses %j", (args, line) => {
    expect(run(args, ROOT)).toEqual({ code: 2, out: [], err: [line, "Usage: node scripts/fixtures/cli.ts --all | --staged"] });
  });

  it("fails on a list of test values that breaks its rules, and names only the lines", () => {
    const r = repo();
    r.commitAll("Start");
    const result = run(["--all"], r.dir, "phone 19900101-2385\npersonal-identity-number 19900101-2386\n");
    expect(result).toEqual({
      code: 1,
      out: [],
      err: [
        'fixtures: scripts/fixtures/test-values.txt:1 is not "<kind> <value>", where the kind is one of personal-identity-number, coordination-number, organisation-number, email.',
        "fixtures: scripts/fixtures/test-values.txt:2: the value is not a personal identity number with a valid date and check digit, so the guard lets it through without an entry.",
        "fixtures: fix the list of test values first.",
      ],
    });
  });

  it("fails when it cannot read what to check", () => {
    const dir = mkdtempSync(join(tmpdir(), "nortfox-fixtures-"));
    try {
      const result = run(["--all"], dir);
      expect(result.code).toBe(1);
      expect(result.err).toEqual([expect.stringMatching(/^fixtures: could not read what to check: git /)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const unreadable = main(["--all"], {
      cwd: ROOT,
      testValues: () => {
        throw new Error("no list");
      },
      out: () => undefined,
      err: (line) => {
        expect(line).toBe("fixtures: could not read what to check: no list");
      },
    });
    expect(unreadable).toBe(1);
  });

  it("gives the command line the committed list and the console", () => {
    const io = processIo(ROOT);
    expect(io.cwd).toBe(ROOT);
    expect(io.testValues()).toBe(COMMITTED);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      io.out("fixtures: out");
      io.err("fixtures: err");
      expect(log).toHaveBeenCalledWith("fixtures: out");
      expect(error).toHaveBeenCalledWith("fixtures: err");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("runs from the command line with the committed list, and its output holds no value", () => {
    const r = repo();
    r.write("docs/a.md", `19900101-2385\n${address("ann", "zarquon.se")}\n`);
    r.commitAll("Start");
    const found = spawnSync(process.execPath, [CLI, "--all"], { cwd: r.dir, encoding: "utf8" });
    expect(found.status).toBe(1);
    expect(found.stdout).toBe("");
    expect(found.stderr.trimEnd().split(/\r?\n/)).toEqual([
      "fixtures: docs/a.md:2 holds an e-mail address outside the reserved example domains.",
      `fixtures: checked 1 files; 1 to fix. ${SUMMARY_END}`,
    ]);
    expectNoValue([found.stderr]);
  });
});

describe("the repository", () => {
  it("holds no real-looking value that is not a test value", () => {
    const result = run(["--all"], ROOT, COMMITTED);
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("runs the guard in pnpm check, in CI's build job and in the pre-commit hook", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["fixtures"]).toBe("node scripts/fixtures/cli.ts --all");
    expect(manifest.scripts["check"]?.split(" && ")).toContain("pnpm fixtures");

    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8").replaceAll("\r\n", "\n");
    const build = /^ {2}build:\n((?: {4}.*\n|\n)*)/m.exec(ci)?.[1] ?? "";
    expect(build).toContain("      - name: No real-looking personal data\n        run: pnpm fixtures\n");

    const hook = readFileSync(join(ROOT, ".githooks/pre-commit"), "utf8");
    expect(hook).toMatch(/^node scripts\/fixtures\/cli\.ts --staged \|\| status=1$/m);
    expect(hook).toMatch(/^exit "\$status"$/m);
  });
});
