// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { FAKE_LIST } from "../testing/repo.ts";
import { inCi, loadWords, localListPath, parseWords, WordListError } from "./words.ts";

const noFile = (): undefined => undefined;

describe("parseWords", () => {
  it("folds each name and skips blank lines and comments", () => {
    expect(parseWords("# made-up words\n\nZarquon\r\n  BLIRVEX  \nzarquon\n")).toEqual(["zarquon", "biirvex"]);
  });

  it("refuses a name too short to check, without showing it", () => {
    const run = () => parseWords("zarquon\nq-x\n");
    expect(run).toThrow(WordListError);
    expect(run).toThrow("Entry 2 of the protected names list is too short to check once folded.");
    expect(new WordListError("x").name).toBe("WordListError");
  });
});

describe("inCi", () => {
  it("knows GitHub Actions and other CI", () => {
    expect(inCi({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(inCi({ CI: "true" })).toBe(true);
    expect(inCi({})).toBe(false);
  });
});

describe("loadWords", () => {
  it("reads PROTECTED_NAMES first", () => {
    expect(loadWords({ PROTECTED_NAMES: FAKE_LIST }, () => "other")).toEqual({
      kind: "words",
      words: ["zarquon", "biirvex"],
    });
  });

  it("in CI, needs PROTECTED_NAMES and never reads a file", () => {
    expect(loadWords({ GITHUB_ACTIONS: "true" }, () => FAKE_LIST)).toEqual({ kind: "missing", required: true });
    expect(loadWords({ CI: "true", PROTECTED_NAMES: "  \n" }, () => FAKE_LIST)).toEqual({
      kind: "missing",
      required: true,
    });
    expect(loadWords({ CI: "true", PROTECTED_NAMES: "# only a comment" }, noFile)).toEqual({
      kind: "missing",
      required: true,
    });
  });

  it("on a laptop, reads the file named by NORTFOX_PROTECTED_NAMES_FILE", () => {
    const read: string[] = [];
    const list = loadWords({ NORTFOX_PROTECTED_NAMES_FILE: "/lists/names.txt" }, (path) => {
      read.push(path);
      return FAKE_LIST;
    });
    expect(list).toEqual({ kind: "words", words: ["zarquon", "biirvex"] });
    expect(read).toEqual(["/lists/names.txt"]);
  });

  it("on a laptop without a list, says so and does not require one", () => {
    expect(loadWords({}, noFile)).toEqual({ kind: "missing", required: false });
  });

  it("looks for the file in ~/.nortfox by default", () => {
    expect(localListPath({}).replaceAll("\\", "/")).toMatch(/\/\.nortfox\/protected-names\.txt$/);
  });
});
