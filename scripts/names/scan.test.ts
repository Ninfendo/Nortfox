// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { FAKE_WORDS } from "../testing/repo.ts";
import { fold } from "./fold.ts";
import { fileTexts, isBinary, lineHasName, readings, scanField, scanFile, scanText } from "./scan.ts";

const words = FAKE_WORDS.map(fold);
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const char = (code: number): string => String.fromCodePoint(code);

describe("lineHasName finds a planted word", () => {
  it.each([
    ["as it is", "see the zarquon notes"],
    ["in capitals", "SEE THE ZARQUON NOTES"],
    ["in mixed case", "ZarQuon"],
    ["with accents", "zárquön"],
    ["with Cyrillic look-alikes", "zаrquоn"],
    ["with Greek look-alikes", "ΖΑRQUΟΝ"],
    ["in digits and symbols", "z4rqu0n"],
    ["with 1 for l", "b1irvex"],
    ["spaced out", "z a r q u o n"],
    ["split by dots and dashes", "z.a-r_q/u:o|n"],
    ["split across two words", "the bazar quonset hut"],
    ["with zero-width spaces", `zar${char(0x200b)}quon`],
    ["in full-width letters", "ｚａｒｑｕｏｎ"],
    ["in base64", base64("the zarquon file")],
    ["in base64 without padding", base64("zarquon").replace(/=+$/, "")],
    ["in url-safe base64", base64("??zarquon??").replaceAll("+", "-").replaceAll("/", "_")],
    ["in base64 inside a sentence", `token: ${base64("zarquon")} here`],
    ["in percent-encoding", "%7A%61%72%71%75%6F%6E"],
    ["in decimal HTML entities", "&#122;&#97;&#114;&#113;&#117;&#111;&#110;"],
    ["in hex HTML entities", "&#x7a;&#X61;rquon"],
    ["among named HTML entities", "zar&amp;quon"],
    ["in base64 of percent-encoding", base64("%7A%61%72%71%75%6F%6E")],
    ["next to an integrity digest", "zarquon sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ])("%s", (_form, line) => {
    expect(lineHasName(line, words)).toBe(true);
  });
});

describe("lineHasName passes", () => {
  it.each([
    ["ordinary text", "The ledger law lives in PostgreSQL."],
    ["base64 that decodes to bytes, not text", "sha1-q2NCfVFfULshR3qT5bLQsdNJvwQ="],
    ["an unknown named entity", "zar&bogus;quon is not decoded into one word"],
    ["an entity beyond Unicode", "&#x110000;"],
  ])("%s", (_case, line) => {
    expect(lineHasName(line, ["zarquonzarquon"])).toBe(false);
  });

  it("an integrity digest, whatever its letters spell", () => {
    expect(lineHasName("integrity: sha512-xxZARQUONxxAAAAAAAAAAAAAAAAAAAAAAAAAAA==", words)).toBe(false);
  });
});

describe("readings", () => {
  it("stops decoding after two levels", () => {
    const thrice = base64(base64(base64("zarquon")));
    expect(lineHasName(thrice, words)).toBe(false);
    expect(lineHasName(base64(base64("zarquon")), words)).toBe(true);
  });

  it("gives the line itself first", () => {
    expect(readings("plain")[0]).toBe("plain");
  });
});

describe("scanText and scanField", () => {
  it("name the line of each hit", () => {
    expect(scanText("one\nzarquon\nthree\r\nblirvex", words, (line) => `f:${String(line)}`)).toEqual([
      { place: "f:2", reason: "name" },
      { place: "f:4", reason: "name" },
    ]);
  });

  it("name a one-line field without a line number", () => {
    expect(scanField("Add zarquon", words, "PR title")).toEqual([{ place: "PR title", reason: "name" }]);
    expect(scanField("Fine\n\nzarquon", words, "PR body")).toEqual([{ place: "PR body line 3", reason: "name" }]);
    expect(scanField("Fine", words, "PR title")).toEqual([]);
  });
});

describe("fileTexts", () => {
  it("reads a Latin-1 file as Latin-1 too", () => {
    const latin1 = Buffer.from("zárquon", "latin1");
    expect(lineHasName(Buffer.from(latin1).toString("utf8"), words)).toBe(false);
    expect(fileTexts(latin1).some((text) => lineHasName(text, words))).toBe(true);
  });

  it("reads a CP437 file as CP437 too", () => {
    // In code page 437, 0xA0 is "á"; in Latin-1 it is a no-break space.
    const cp437 = Buffer.from([0x7a, 0xa0, 0x72, 0x71, 0x75, 0x6f, 0x6e]);
    expect(lineHasName(Buffer.from(cp437).toString("latin1"), words)).toBe(false);
    expect(fileTexts(cp437).some((text) => lineHasName(text, words))).toBe(true);
  });

  it("reads plain ASCII once", () => {
    expect(fileTexts(Buffer.from("abc"))).toEqual(["abc"]);
  });
});

describe("scanFile", () => {
  const file = (path: string, contents: string | Uint8Array | undefined, honouredFolder?: string) => ({
    path,
    alias: "changed file 7",
    bytes: typeof contents === "string" ? Buffer.from(contents) : contents,
    honouredFolder,
  });

  it("names the line of a hit in the contents", () => {
    expect(scanFile(file("docs/a.md", "fine\nzarquon\n"), words)).toEqual([{ place: "docs/a.md:2", reason: "name" }]);
    expect(scanFile(file("docs/a.md", "zarquon"), words)).toEqual([{ place: "docs/a.md:1", reason: "name" }]);
  });

  it("never shows a path that holds a name: it uses the alias", () => {
    expect(scanFile(file("docs/zarquon/a.md", "and blirvex"), words)).toEqual([
      { place: "changed file 7 (its path)", reason: "name" },
      { place: "changed file 7:1", reason: "name" },
    ]);
    expect(scanFile(file(`docs/${base64("zarquon")}.md`, "fine"), words)).toEqual([
      { place: "changed file 7 (its path)", reason: "name" },
    ]);
  });

  it("reports a hit once, also when several readings of the file find it", () => {
    expect(scanFile(file("a.txt", Buffer.from("zárquon zarquon", "utf8")), words)).toEqual([
      { place: "a.txt:1", reason: "name" },
    ]);
  });

  it("refuses a binary file it cannot read", () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x00]))).toBe(true);
    expect(scanFile(file("images/logo.png", Buffer.from([0x89, 0x50, 0x00])), words)).toEqual([
      { place: "images/logo.png", reason: "binary" },
    ]);
    expect(scanFile(file("BLOB", Buffer.from([0x00])), words)).toEqual([{ place: "BLOB", reason: "binary" }]);
  });

  it("skips the contents of a file in an honoured folder, but not the folder's own path", () => {
    expect(scanFile(file("adapters/a1/notes.md", "zarquon", "adapters/a1"), words)).toEqual([]);
    expect(scanFile(file("adapters/a1/zarquon.md", "", "adapters/a1"), words)).toEqual([]);
    expect(scanFile(file("adapters/zarquon/x.md", "", "adapters/zarquon"), words)).toEqual([
      { place: "changed file 7 (its path)", reason: "name" },
    ]);
  });

  it("checks only the path of a file without contents", () => {
    expect(scanFile(file("vendor/sub", undefined), words)).toEqual([]);
  });
});
