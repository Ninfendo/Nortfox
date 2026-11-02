// SPDX-License-Identifier: AGPL-3.0-only

// The tests plant numbers from Skatteverket's published test series and read
// them with an empty list of test values, so the guard finds them while this
// file, read with the committed list, passes.

import { describe, expect, it } from "vitest";
import type { SourceFile } from "../names/sources.ts";
import { address } from "../testing/personal-data.ts";
import { report, scanFile, scanText, unlistedKinds, unlistedPathKinds, type Finding, type Reason } from "./check.ts";
import { parseTestValues } from "./test-values.ts";

const NONE = parseTestValues("").values;
const LISTED = parseTestValues(
  "personal-identity-number 19900101-2385\norganisation-number 556000-0167\nemail " + address("noreply", "zarquon.zz"),
).values;
const placeOf = (line: number): string => `f:${String(line)}`;

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** The alias that `file` gives every file. */
const ALIAS = "tracked file 7 (git ls-files)";

/** No line of a report holds a part of a planted value. */
function expectNoValue(findings: readonly Finding[]): void {
  expect(report(findings, 1).join("\n")).not.toMatch(/zarquon|ann\.berg|2385|2384/);
}

/** A file as a source gives it. */
function file(path: string, contents: string | Uint8Array | undefined, extra: Partial<SourceFile> = {}): SourceFile {
  return {
    path,
    alias: "tracked file 7 (git ls-files)",
    bytes: typeof contents === "string" ? Buffer.from(contents, "utf8") : contents,
    ...extra,
  };
}

/** A digest of the exact sha512 shape that pnpm writes, with a test number among its letters. */
const DIGEST = `sha512-${"Ab+199001012385/".padEnd(86, "Q")}==`;

describe("unlistedKinds", () => {
  it("gives each kind once, and leaves out a listed value", () => {
    expect(unlistedKinds("19900101-2385 and 20000101-2384", NONE)).toEqual(["personal-identity-number"]);
    expect(unlistedKinds("19900101-2385 and 20000101-2384", LISTED)).toEqual(["personal-identity-number"]);
    expect(unlistedKinds("19900101-2385 and 556000-0167", LISTED)).toEqual([]);
  });

  it.each([
    ["percent-encoded", `https://zarquon.zz/send?to=${encodeURIComponent(address("ann", "zarquon.zz"))}`, "email"],
    ["in an HTML character reference", ["ann", "zarquon.zz"].join("&#64;"), "email"],
    ["in base64, as in the payload of a test token", `eyJhbGciOiJub25lIn0.${base64(`{"email":"${address("ann", "zarquon.zz")}"}`)}.`, "email"],
    ["a number in base64", base64("pnr 19900101-2385"), "personal-identity-number"],
    [
      "percent-encoded as the user name of a URL",
      `url = https://${encodeURIComponent(address("ann.berg", "zarquon.zz"))}@git.zarquon.zz/team/repo.git`,
      "email",
    ],
    [
      "percent-encoded as the user name of a URL at a reserved host, where only the decoded reading holds it",
      `url = https://${encodeURIComponent(address("ann.berg", "zarquon.zz"))}@git.example.com/team/repo.git`,
      "email",
    ],
  ])("finds a value %s", (_how, line, kind) => {
    expect(unlistedKinds(line, NONE)).toEqual([kind]);
  });
});

describe("unlistedPathKinds", () => {
  it("reads a path as it decodes, and strictly", () => {
    expect(unlistedPathKinds(`fixtures/${encodeURIComponent(address("ann", "zarquon.zz"))}.json`, NONE)).toEqual(["email"]);
    expect(unlistedPathKinds("kunder/900101-2385-faktura.csv", NONE)).toEqual(["personal-identity-number"]);
    expect(unlistedPathKinds("kunder/900101-2385-faktura.csv", LISTED)).toEqual([]);
  });
});

describe("scanText", () => {
  it("names the line of each value, and each kind on a line", () => {
    const text = [
      "fine",
      "pnr 19900101-2385",
      `org 556000-0167, mail ${address("ann", "zarquon.zz")}`,
      "samordningsnummer 260161-2381",
    ].join("\r\n");
    expect(scanText(text, NONE, placeOf)).toEqual<Finding[]>([
      { place: "f:2", reason: "personal-identity-number" },
      { place: "f:3", reason: "organisation-number" },
      { place: "f:3", reason: "email" },
      { place: "f:4", reason: "coordination-number" },
    ]);
  });

  it("leaves out the integrity digest of pnpm-lock.yaml, only in that file and only at pnpm's own key", () => {
    const resolution = `    resolution: {integrity: ${DIGEST}}`;
    const alone = `      integrity: ${DIGEST}`;
    expect(scanText([resolution, alone].join("\n"), NONE, placeOf, true)).toEqual([]);
    // Anywhere else, the same run is read like any other text.
    expect(scanText(resolution, NONE, placeOf)).toEqual([{ place: "f:1", reason: "personal-identity-number" }]);
    expect(scanText(`# ${DIGEST}`, NONE, placeOf, true)).toEqual([{ place: "f:1", reason: "personal-identity-number" }]);
    expect(scanText(`    resolution: {tarball: ${DIGEST}}`, NONE, placeOf, true)).toEqual([
      { place: "f:1", reason: "personal-identity-number" },
    ]);
    // A digest one letter too long is not pnpm's.
    expect(scanText(`      integrity: ${DIGEST.replace("==", "Q==")}`, NONE, placeOf, true)).toEqual([
      { place: "f:1", reason: "personal-identity-number" },
    ]);
    // A value after the digest on the same line is still read.
    expect(scanText(`    resolution: {integrity: ${DIGEST}, note: 20000101-2384}`, NONE, placeOf, true)).toEqual([
      { place: "f:1", reason: "personal-identity-number" },
    ]);
  });
});

describe("scanFile", () => {
  it("reads a text file and names it by its path", () => {
    expect(scanFile(file("docs/a.md", "one\n19900101-2385\n"), NONE)).toEqual([
      { place: "docs/a.md:2", reason: "personal-identity-number" },
    ]);
    expect(scanFile(file("docs/a.md", "one\n19900101-2385\n"), LISTED)).toEqual([]);
  });

  it("reads pnpm-lock.yaml at the root as the lockfile, and a file of that name elsewhere as text", () => {
    const text = `    resolution: {integrity: ${DIGEST}}\n`;
    expect(scanFile(file("pnpm-lock.yaml", text), NONE)).toEqual([]);
    expect(scanFile(file("apps/web/pnpm-lock.yaml", text), NONE)).toEqual([
      { place: "apps/web/pnpm-lock.yaml:1", reason: "personal-identity-number" },
    ]);
  });

  it("names a file whose path holds a value by its alias, never by its path", () => {
    const findings = scanFile(file("fixtures/19900101-2385.json", '{"note": 20000101-2384}\n'), NONE);
    expect(findings).toEqual([
      { place: "tracked file 7 (git ls-files) (its path)", reason: "personal-identity-number" },
      { place: "tracked file 7 (git ls-files):1", reason: "personal-identity-number" },
    ]);
    expect(JSON.stringify(findings)).not.toMatch(/2385|2384/);
  });

  it("reads every reading of a path", () => {
    const named = file("fixtures/a.json", "{}\n", { pathAlsoReadAs: ["fixtures/a.json", "fixtures/199001012385.json"] });
    expect(scanFile(named, NONE)).toEqual([
      { place: "tracked file 7 (git ls-files) (its path)", reason: "personal-identity-number" },
    ]);
  });

  it.each<[string, string, Reason]>([
    ["an address before .json", `fixtures/${address("ann.berg", "zarquon.zz")}.json`, "email"],
    ["an address as a folder name", `fixtures/${address("ann.berg", "zarquon.zz")}/statement.csv`, "email"],
    ["an address before a space", `fixtures/${address("ann.berg", "zarquon.zz")} a.json`, "email"],
    ["an identity number joined by dashes", "kunder/900101-2385-faktura.csv", "personal-identity-number"],
    ["an identity number with the century, joined by dashes", "kunder/19900101-2385-2024.csv", "personal-identity-number"],
  ])("refuses %s in a path, and the report never shows it", (_case, path, reason) => {
    const findings = scanFile(file(path, "20000101-2384\n"), NONE);
    expect(findings).toEqual<Finding[]>([
      { place: `${ALIAS} (its path)`, reason },
      { place: `${ALIAS}:1`, reason: "personal-identity-number" },
    ]);
    expectNoValue(findings);
  });

  it.each<[string, string, Reason]>([
    ["a scan named by an identity number", "skannat/900101-2385-kontrakt.pdf", "personal-identity-number"],
    ["a photo named by an address", `bilder/${address("ann.berg", "zarquon.zz")}.jpg`, "email"],
    ["a photo named by an address with a dash and a word after it", `avatars/${address("ann.berg", "zarquon.zz")}-photo.png`, "email"],
    ["a photo in a folder named by an address with a dash and a year", `inbox/${address("ann.berg", "zarquon.zz")}-2024/mail.png`, "email"],
    ["a photo named by an address with a digit after it", `avatars/${address("ann.berg", "zarquon.zz")}2.png`, "email"],
  ])("refuses %s, a binary file, by its alias", (_case, path, reason) => {
    const findings = scanFile(file(path, new Uint8Array([0x25, 0x50, 0x44, 0x46])), NONE);
    expect(findings).toEqual<Finding[]>([
      { place: `${ALIAS} (its path)`, reason },
      { place: ALIAS, reason: "binary" },
    ]);
    expectNoValue(findings);
  });

  it("names a file by its alias when its path holds only the shape of a value", () => {
    // A listed number, an address at example.com, a timestamp and a domain without a local part are no finding,
    // but the path is kept out of the log all the same.
    for (const path of [
      "fixtures/19900101-2385-anna.json",
      `fixtures/${address("ann", "example.com")}.json`,
      "logs/1767225600.json",
      "people/@zarquon.zz/a.json",
    ]) {
      expect(scanFile(file(path, "20000101-2384\n"), LISTED)).toEqual([{ place: `${ALIAS}:1`, reason: "personal-identity-number" }]);
    }
    const binary = scanFile(file("people/@zarquon.zz-photo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])), NONE);
    expect(binary).toEqual([{ place: ALIAS, reason: "binary" }]);
    expectNoValue(binary);
    expect(scanFile(file("docs/logo@2x.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])), NONE)).toEqual([
      { place: "docs/logo@2x.png", reason: "binary" },
    ]);
  });

  it("refuses a clean text file whose path holds an address with a dash and a year after it", () => {
    const findings = scanFile(file(`people/${address("ann.berg", "zarquon.zz")}-2024.json`, "{}\n"), NONE);
    expect(findings).toEqual<Finding[]>([{ place: `${ALIAS} (its path)`, reason: "email" }]);
    expectNoValue(findings);
  });

  it("lets through a listed address used as a file name, with any extension", () => {
    for (const extension of [".json", ".eml"]) {
      expect(scanFile(file(`mail/${address("noreply", "zarquon.zz")}${extension}`, "{}\n"), LISTED)).toEqual([]);
      expect(scanFile(file(`mail/${address("ann", "zarquon.zz")}${extension}`, "{}\n"), LISTED)).toEqual([
        { place: `${ALIAS} (its path)`, reason: "email" },
      ]);
    }
  });

  it("refuses a binary file, a Git LFS pointer and a file it cannot get", () => {
    expect(scanFile(file("docs/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), NONE)).toEqual([
      { place: "docs/logo.png", reason: "binary" },
    ]);
    expect(scanFile(file("docs/data.bin", "plain text\n"), NONE)).toEqual([{ place: "docs/data.bin", reason: "binary" }]);
    expect(scanFile(file("docs/a.txt", new Uint8Array([0x61, 0x00, 0x62])), NONE)).toEqual([
      { place: "docs/a.txt", reason: "binary" },
    ]);
    // UTF-16 text holds a zero byte beside each ASCII letter, so it is refused too, not read past.
    expect(scanFile(file("docs/people.csv", Buffer.from("19900101-2385\n", "utf16le")), NONE)).toEqual([
      { place: "docs/people.csv", reason: "binary" },
    ]);
    expect(
      scanFile(file("docs/big.csv", "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n"), NONE),
    ).toEqual([{ place: "docs/big.csv", reason: "lfs" }]);
    expect(scanFile(file("vendor/lib", undefined, { unreadable: true }), NONE)).toEqual([
      { place: "vendor/lib", reason: "unreadable" },
    ]);
  });

  it("refuses a binary file whose path holds a value by its alias", () => {
    expect(scanFile(file("19900101-2385.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])), NONE)).toEqual([
      { place: "tracked file 7 (git ls-files) (its path)", reason: "personal-identity-number" },
      { place: "tracked file 7 (git ls-files)", reason: "binary" },
    ]);
  });

  it("has nothing to read in a file without contents, such as one deleted in the working tree", () => {
    expect(scanFile(file("docs/gone.md", undefined), NONE)).toEqual([]);
  });
});

describe("report", () => {
  it("says what it checked when it found nothing", () => {
    expect(report([], 12)).toEqual(["fixtures: checked 12 files. Nothing found."]);
  });

  it("names each place and kind, then what to do", () => {
    expect(
      report(
        [
          { place: "a.ts:1", reason: "personal-identity-number" },
          { place: "a.ts:2", reason: "coordination-number" },
          { place: "a.ts:3", reason: "organisation-number" },
          { place: "a.ts:4", reason: "email" },
          { place: "b.png", reason: "binary" },
          { place: "c.csv", reason: "lfs" },
          { place: "d", reason: "unreadable" },
        ],
        4,
      ),
    ).toEqual([
      "fixtures: a.ts:1 holds a real-looking personal identity number (personnummer).",
      "fixtures: a.ts:2 holds a real-looking coordination number (samordningsnummer).",
      "fixtures: a.ts:3 holds a real-looking organisation number.",
      "fixtures: a.ts:4 holds an e-mail address outside the reserved example domains.",
      "fixtures: b.png is a binary file of a type the fixture guard cannot read yet.",
      "fixtures: c.csv uses Git LFS, whose files the fixture guard cannot read.",
      "fixtures: d has contents the fixture guard cannot get, such as a submodule.",
      "fixtures: checked 4 files; 7 to fix. The guard never shows what it found. " +
        "Use a test value from scripts/fixtures/test-values.txt, or an address at example.com or under .test or .invalid.",
    ]);
  });
});
