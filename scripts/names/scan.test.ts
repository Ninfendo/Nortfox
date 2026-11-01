// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { FAKE_WORDS } from "../testing/repo.ts";
import { fold } from "./fold.ts";
import {
  fileTexts,
  isBinary,
  isLfsPointer,
  lineHasName,
  readings,
  scanField,
  scanFile,
  scanText,
  type FileToCheck,
} from "./scan.ts";

const words = FAKE_WORDS.map(fold);
const base64 = (text: string | Uint8Array): string => Buffer.from(text).toString("base64");
const char = (code: number): string => String.fromCodePoint(code);
/** The letters of ZARQUON in a block of letters that runs from A to Z. */
const inBlock = (first: number): string => "ZARQUON".replace(/[A-Z]/g, (letter) => char(first + letter.charCodeAt(0) - 65));
const lines = (text: string) => scanText(text, words, (line) => `f:${String(line)}`);

/** A digest of the exact sha512 shape: 86 base64 letters and "==". */
const digestOf = (letters: string): string => `sha512-${letters.padEnd(86, "A")}==`;

describe("lineHasName finds a planted word", () => {
  it.each([
    ["as it is", "see the zarquon notes"],
    ["in capitals", "SEE THE ZARQUON NOTES"],
    ["in mixed case", "ZarQuon"],
    ["with accents", "zárquön"],
    ["with Cyrillic look-alikes", "zаrquоn"],
    ["with Greek look-alikes", "ΖΑRQUΟΝ"],
    ["with Lisu and Armenian look-alikes", `za${char(0xa4e3)}qu${char(0x585)}n`],
    ["in small capitals", "ᴢᴀʀqᴜᴏɴ"],
    ["in negative squared letters", inBlock(0x1f170)],
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
    ["in double-struck HTML entities", "&zopf;&aopf;&ropf;&qopf;&uopf;&oopf;&nopf;"],
    ["in script and fraktur HTML entities", "&Zscr;&ascr;r&qfr;&uscr;&ofr;n"],
    ["in an old HTML entity without its semicolon", "z&aacute rquon"],
    ["in HTML entities without their semicolons", "&#122&#97rquon"],
    ["with a look-alike symbol for a letter", "zarqu∅n"],
    ["with a box-drawing line for l", "b│irvex"],
    ["with a | for l inside a word", "b|irvex"],
    ["with a look-alike symbol between its letters", "zar×quon"],
    ["in base64 of percent-encoding", base64("%7A%61%72%71%75%6F%6E")],
    ["next to a digest", "zarquon sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["inside a run shaped like a digest", "see sha1-ZarquonImportAdapterForSIE"],
    ["inside a digest of the exact length", `integrity: ${digestOf("xxZARQUONxx")}`],
    ["in base64 inside a digest", `sha512-${base64("hello zarquon world!!")}`],
    [
      "in the text chunk of a picture in a data: URI",
      `<image href="data:image/png;base64,${base64(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x14]), Buffer.from("tEXtAuthor"), Buffer.from([0]), Buffer.from("zarquon AB"), Buffer.from([0xde, 0xad, 0xbe, 0xef])]))}"/>`,
    ],
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

  // fold("blirvex") is "biirvex": a | read as l on each side of a cell would
  // spell it.
  it.each([
    ["a Markdown table", "| b | irvex |"],
    ["a union type", "type T = b | irvex;"],
    ["a shell pipe", "echo b |irvex"],
    ["an ! between letters", "b!irvex"],
  ])("a | or ! that is not a letter: %s", (_case, line) => {
    expect(lineHasName(line, words)).toBe(false);
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
    expect(lines("one\nzarquon\nthree\r\nblirvex")).toEqual([
      { place: "f:2", reason: "name" },
      { place: "f:4", reason: "name" },
    ]);
  });

  it("name a one-line field without a line number", () => {
    expect(scanField("Add zarquon", words, "PR title")).toEqual([{ place: "PR title", reason: "name" }]);
    expect(scanField("Fine\n\nzarquon", words, "PR body")).toEqual([{ place: "PR body line 3", reason: "name" }]);
    expect(scanField("Fine", words, "PR title")).toEqual([]);
  });

  it("find a word wrapped across lines, at the line where it starts", () => {
    expect(lines("We read the Zar\nquon files.")).toEqual([{ place: "f:1", reason: "name" }]);
    expect(lines("fine\nz-a\nrq\nuon")).toEqual([{ place: "f:2", reason: "name" }]);
    expect(scanField("Add the import\n\nIt reads the Zar\nquon screens.", words, "commit message")).toEqual([
      { place: "commit message line 3", reason: "name" },
    ]);
  });

  it("report a word that fits on one line only there, and read on across an empty line", () => {
    expect(lines("bazar\nzarquon\nquonset")).toEqual([{ place: "f:2", reason: "name" }]);
    expect(lines("zar\n\nquon")).toEqual([{ place: "f:1", reason: "name" }]);
  });

  it("find a word wrapped across lines with a look-alike symbol between its letters", () => {
    expect(lines("zar×\nquon")).toEqual([{ place: "f:1", reason: "name" }]);
    expect(lines("zarqu∅\nn")).toEqual([{ place: "f:1", reason: "name" }]);
  });

  it("find a word with HTML entities wrapped across lines", () => {
    expect(lines("Read the z&#97;r\nquon notes.")).toEqual([{ place: "f:1", reason: "name" }]);
    expect(lines("&#122; &#97;\n&#114; &#113; &#117; &#111; &#110;")).toEqual([{ place: "f:1", reason: "name" }]);
    expect(lines("zar&#x\n71;uon")).toEqual([{ place: "f:1", reason: "name" }]);
  });

  it("find a word in a run shaped like a digest, outside the lockfile", () => {
    expect(scanField("Add the sha1-ZarquonImportAdapterForSIE", words, "PR title")).toEqual([
      { place: "PR title", reason: "name" },
    ]);
    expect(lines(`# Importing from sha256-QuintevoAndZarquonExportsLikeThis`)).toEqual([{ place: "f:0", reason: "name" }]);
  });
});

describe("an encoding wrapped across lines", () => {
  it.each([
    ["base64", "emFy\ncXVvbg=="],
    ["base64 between other text", "token emFy\ncXVvbg== here"],
    ["base64 over three lines", "em\nFycX\nVvbg"],
    ["indented base64", "    emFy\n    cXVvbg=="],
    ["quoted base64", "> emFy\n> cXVvbg=="],
    ["base64 in // comments", "// emFy\n// cXVvbg=="],
    ["base64 in # comments", "# emFy\n# cXVvbg=="],
    ["base64 in a nested quote", ">> emFy\n>>cXVvbg=="],
    ["an entity split before its #", "zar&\n#113;uon"],
    ["an entity split before its ;", "zar&#113\n;uon"],
    ["percent-encoding", "%7A%61%72\n%71%75%6F%6E"],
    ["percent-encoding split inside an escape", "%7A%61%7\n2%71%75%6F%6E"],
    ["decimal HTML entities", "&#122;&#97;&#114;\n&#113;&#117;&#111;&#110;"],
    ["named HTML entities", "&zopf;&aopf;&ropf;\n&qopf;&uopf;&oopf;&nopf;"],
  ])("is put back together before it is decoded: %s", (_form, text) => {
    expect(lines(text)).toEqual([{ place: "f:1", reason: "name" }]);
  });

  it("is put back together inside a block comment", () => {
    expect(lines("/*\n * emFy\n * cXVvbg==\n */")).toEqual([{ place: "f:2", reason: "name" }]);
  });

  it("is reported at the line where the word starts, in a blob wrapped at 76 columns", () => {
    const blob = base64(`${"x".repeat(225)}zarquon${"y".repeat(60)}`).match(/.{1,76}/g) ?? [];
    expect(blob).toHaveLength(6);
    expect(lines(blob.join("\n"))).toEqual([{ place: "f:4", reason: "name" }]);
    expect(lines(blob.map((line) => `  > ${line}`).join("\n"))).toEqual([{ place: "f:4", reason: "name" }]);
  });

  it("is placed in a long blob without decoding every window of it", () => {
    const blob = base64(`${"x".repeat(240)}zarquon${"y".repeat(50)}`).match(/.{1,4}/g) ?? [];
    expect(blob).toHaveLength(99);
    expect(lines(blob.join("\n"))).toEqual([{ place: "f:81", reason: "name" }]);
  });

  it("is reported at the first line of the run when the name is wider than the search", () => {
    // One base64 letter per line: the name takes 56 lines, more than a
    // window, and then 96, more than a stretch.
    const entities = "&#122;&#97;&#114;&#113;&#117;&#111;&#110;";
    const padded = "&#0000122;&#0000097;&#0000114;&#0000113;&#0000117;&#0000111;&#0000110;";
    for (const [text, length] of [
      [entities, 56],
      [padded, 96],
    ] as const) {
      const letters = base64(text).match(/./g) ?? [];
      expect(letters).toHaveLength(length);
      expect(lines(["fine", "", ...letters].join("\n"))).toEqual([{ place: "f:3", reason: "name" }]);
    }
  });

  it("is reported once for each word: a word on one line there, a wrapped one where it starts", () => {
    expect(lines(`${base64("zarquon")}\nYmxp\ncnZleA==`)).toEqual([
      { place: "f:1", reason: "name" },
      { place: "f:2", reason: "name" },
    ]);
  });

  it("is not joined across an empty line", () => {
    expect(lines("emFy\n\ncXVvbg==")).toEqual([]);
    expect(lines("// emFy\n//\n// cXVvbg==")).toEqual([]);
  });
});

describe("pnpm-lock.yaml", () => {
  const lockfile = (text: string) => scanText(text, words, (line) => `lock:${String(line)}`, { lockfile: true });

  it("does not read the letters of an integrity digest of the exact length as text", () => {
    expect(lockfile(`    resolution: {integrity: ${digestOf("xxZARQUONxx")}}`)).toEqual([]);
    expect(lockfile(`    integrity: ${digestOf("xxZARQUONxx")}`)).toEqual([]);
  });

  it("still decodes the digest's base64", () => {
    const hidden = `sha512-${base64("made by zarquon AB, sixty-four bytes of text, to fit the shape..")}`;
    // The exact shape of a sha512 digest, so the line holds no other text.
    expect(hidden).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(lockfile(`    resolution: {integrity: ${hidden}}`)).toEqual([{ place: "lock:0", reason: "name" }]);
    expect(lockfile(`      integrity: ${hidden}`)).toEqual([{ place: "lock:0", reason: "name" }]);
  });

  it("reads a digest so only in pnpm's own forms of the integrity key", () => {
    const digest = digestOf("xxZARQUONxx");
    expect(lockfile(`    resolution: {integrity: ${digest}, tarball: https://x.invalid/a.tgz}`)).toEqual([]);
    expect(lockfile(`      integrity: ${digest}`)).toEqual([]);
  });

  it.each([
    ["on a comment line", "    # integrity: "],
    ["on a comment line in the flow form", "    # resolution: {integrity: "],
    ["in another key", "    note: integrity: "],
    ["after another key in the braces", "    resolution: {tarball: x, integrity: "],
    ["without indentation", "resolution: {integrity: "],
  ])("reads the letters of a digest as text %s", (_case, before) => {
    expect(lockfile(`${before}${digestOf("xxZARQUONxx")}}`)).toEqual([{ place: "lock:0", reason: "name" }]);
  });

  it("reads the letters of a digest as text when more follows it on the line", () => {
    expect(lockfile(`    integrity: ${digestOf("xxZARQUONxx")} # note`)).toEqual([{ place: "lock:0", reason: "name" }]);
  });

  it("reads every other digest-shaped run, and the rest of the line, as text", () => {
    expect(lockfile(`    integrity: sha512-xxZARQUONxxAAAAAAAAAAAAAAAAAAAAAAAAAAA==`)).toEqual([{ place: "lock:0", reason: "name" }]);
    expect(lockfile(`    checksum: ${digestOf("xxZARQUONxx")}`)).toEqual([{ place: "lock:0", reason: "name" }]);
    expect(lockfile(`  zarquon@1.0.0: {integrity: ${digestOf("AAAA")}}`)).toEqual([{ place: "lock:0", reason: "name" }]);
  });

  it("is the only file read this way", () => {
    const line = `    resolution: {integrity: ${digestOf("xxZARQUONxx")}}\n`;
    const file = (path: string): FileToCheck => ({ path, alias: "a", bytes: Buffer.from(line), honouredFolder: undefined });
    expect(scanFile(file("pnpm-lock.yaml"), words)).toEqual([]);
    for (const path of ["docs/notes.md", "scripts/x.ts", "apps/web/pnpm-lock.yaml"]) {
      expect(scanFile(file(path), words)).toEqual([{ place: `${path}:1`, reason: "name" }]);
    }
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

describe("isBinary", () => {
  it.each([
    ["a NUL byte", [0x61, 0x00, 0x62], "a.txt"],
    ["a control byte", [0x61, 0x01, 0x62], "a.txt"],
    ["DEL", [0x61, 0x7f], "a.txt"],
    ["a PDF", [...Buffer.from("%PDF-1.7\n"), 0xe2, 0xe3, 0xcf, 0xd3], "doc"],
    ["a zip", [0x50, 0x4b, 0x03, 0x04, 0x14], "x"],
    ["a gzip", [0x1f, 0x8b, 0x08], "x"],
    ["a zlib stream", [0x78, 0x9c, 0x4b], "x"],
    ["a JPEG", [0xff, 0xd8, 0xff, 0xe0], "x"],
    ["a GIF", [...Buffer.from("GIF89a")], "x"],
    ["a PDF by its name", [...Buffer.from("plain text")], "docs/brochure.PDF"],
    ["a font by its name", [...Buffer.from("plain text")], "fonts/a.woff2"],
  ])("refuses %s", (_case, bytes, path) => {
    expect(isBinary(Uint8Array.from(bytes), path)).toBe(true);
  });

  it.each([
    ["text with tabs, newlines, a form feed and an escape", "a\tb\r\nc\fd\u001b[0m", "a.txt"],
    ["UTF-8 text", "Bokföring och räkenskaper", "a.md"],
    ["an SVG", "<svg></svg>", "logo.svg"],
    ["a file without an extension", "text", "Makefile"],
  ])("reads %s", (_case, text, path) => {
    expect(isBinary(Buffer.from(text), path)).toBe(false);
  });
});

describe("scanFile", () => {
  const file = (
    path: string,
    contents: string | Uint8Array | undefined,
    honouredFolder?: string,
    unreadable?: boolean,
  ): FileToCheck => ({
    path,
    alias: "changed file 7",
    bytes: typeof contents === "string" ? Buffer.from(contents) : contents,
    honouredFolder,
    ...(unreadable === undefined ? {} : { unreadable }),
  });

  it("names the line of a hit in the contents", () => {
    expect(scanFile(file("docs/a.md", "fine\nzarquon\n"), words)).toEqual([{ place: "docs/a.md:2", reason: "name" }]);
    expect(scanFile(file("docs/a.md", "zarquon"), words)).toEqual([{ place: "docs/a.md:1", reason: "name" }]);
  });

  it("finds a word wrapped across two lines of a file", () => {
    expect(scanFile(file("docs/a.md", "We read the Zar\nquon files.\n"), words)).toEqual([
      { place: "docs/a.md:1", reason: "name" },
    ]);
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
    expect(scanFile(file("images/logo.png", Buffer.from([0x89, 0x50, 0x00])), words)).toEqual([
      { place: "images/logo.png", reason: "binary" },
    ]);
    expect(scanFile(file("BLOB", Buffer.from([0x00])), words)).toEqual([{ place: "BLOB", reason: "binary" }]);
    expect(scanFile(file("docs/a.pdf", Buffer.from("%PDF-1.7\n(no NUL byte here)")), words)).toEqual([
      { place: "docs/a.pdf", reason: "binary" },
    ]);
  });

  it("refuses a Git LFS pointer, and a .gitattributes line that sends files to Git LFS", () => {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a\nsize 12345\n";
    expect(isLfsPointer(Buffer.from(pointer))).toBe(true);
    expect(isLfsPointer(Buffer.from("version 2"))).toBe(false);
    expect(scanFile(file("docs/brochure.pdf", pointer), words)).toEqual([{ place: "docs/brochure.pdf", reason: "lfs" }]);
    expect(
      scanFile(file(".gitattributes", "* text=auto\n*.pdf filter=lfs diff=lfs merge=lfs -text\n# filter=lfs\n"), words),
    ).toEqual([{ place: ".gitattributes:2", reason: "lfs" }]);
    expect(scanFile(file("docs/.gitattributes", "*.psd\tfilter=lfs"), words)).toEqual([
      { place: "docs/.gitattributes:1", reason: "lfs" },
    ]);
    expect(scanFile(file("notes.md", "*.pdf filter=lfs"), words)).toEqual([]);
  });

  it("refuses a file whose contents it cannot get", () => {
    expect(scanFile(file("vendor/sub", undefined, undefined, true), words)).toEqual([
      { place: "vendor/sub", reason: "unreadable" },
    ]);
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
