// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Transport } from "../github/api.ts";
import { CONFUSABLES, parseLookAlikes } from "./fold.ts";
import { runGenerator } from "./tables.ts";
import { buildTable, entryFor, renderTable, SOURCE_SHA256, SOURCE_URL, TABLE_FILE, upstreamEntries } from "./update-confusables.ts";

/** Lines in the form Unicode publishes them in, with the reason each is kept or dropped. */
const UPSTREAM = [
  "# confusables.txt",
  "0585 ;\t006F ;\tMA\t# ( օ → o ) ARMENIAN SMALL LETTER OH → LATIN SMALL LETTER O\t# kept",
  "13A0 ;\t0044 ;\tMA\t# kept, a capital: folded to d",
  "01B7 ;\t0033 ;\tMA\t# kept: 3 stands for e",
  "A4F2 ;\t006C ;\tMA\t# kept: l folds to i",
  "0251 ;\t0061 ;\tMA\t# kept",
  "006D ;\t0072 006E ;\tMA\t# dropped: ASCII is read as it is",
  "2223 ;\t006C ;\tMA\t# kept: a symbol, read as l (and so i) or as a separator",
  "007C ;\t006C ;\tMA\t# dropped: ASCII is read by the fold's own rules",
  "00A2 ;\t0063 0338 ;\tMA\t# kept: a symbol; the mark goes",
  "03F9 ;\t0043 ;\tMA\t# kept: NFKC makes it a Greek capital sigma, which folds to o",
  "017F ;\t0066 ;\tMA\t# dropped: NFKC makes it an s",
  "0438 ;\t0078 ;\tMA\t# dropped: a hand-made table reads it, and wins",
  "0C02 ;\t006F ;\tMA\t# kept: a vowel sign, which the fold drops as a mark",
  "0430 ;\t0061 ;\tMA\t# dropped: a hand-made table reads it already",
  "FF4D ;\t0072 006E ;\tMA\t# dropped: NFKC reads it already",
  "0B66 ;\t006F ;\tMA\t# kept: a digit that looks like a letter, as 0 does",
  "0661 ;\t0031 0032 ;\tMA\t# dropped: 2 stands for no letter",
  "05D5 ;\t05C0 ;\tMA\t# dropped: the look-alike is not Latin",
  "0041 0301 ;\t00C1 ;\tMA\t# dropped: more than one code point",
  "",
].join("\n");

describe("the look-alike table", () => {
  it("keeps the characters outside ASCII that look like Latin letters and that fold() does not read as them", () => {
    expect([...upstreamEntries(UPSTREAM)]).toEqual([
      ["օ", "o"],
      ["Ꭰ", "d"],
      ["Ʒ", "e"],
      ["ꓲ", "i"],
      ["ɑ", "a"],
      ["∣", "i"],
      ["¢", "c"],
      ["Ϲ", "c"],
      [String.fromCodePoint(0xc02), "o"],
      ["୦", "o"],
    ]);
    expect(entryFor("a", "a")).toBeUndefined();
  });

  it("is written in code point order after the source and its licence", () => {
    const table = renderTable(upstreamEntries(UPSTREAM));
    expect(table).toContain(`# ${SOURCE_URL}\n# SHA-256 ${SOURCE_SHA256}\n`);
    expect(table).toContain("# UNICODE LICENSE V3");
    expect(table.split("\n").filter((line) => /^[0-9A-F]+ /.test(line))).toEqual([
      "00A2 c",
      "01B7 e",
      "0251 a",
      "03F9 c",
      "0585 o",
      "0B66 o",
      "0C02 o",
      "13A0 d",
      "2223 i",
      "A4F2 i",
    ]);
  });

  // The pinned file is not in the repository, so this test cannot see a
  // changed letter. "node scripts/names/update-confusables.ts --check" does.
  it("on disk has the generator's header, form and order, and only entries that the generator keeps", () => {
    const committed = readFileSync(TABLE_FILE, "utf8");
    const kept = new Map([...CONFUSABLES].filter(([char, letters]) => entryFor(char, letters) === letters));
    expect(kept.size).toBe(CONFUSABLES.size);
    expect(renderTable(kept)).toBe(committed);
    expect(CONFUSABLES.size).toBeGreaterThan(500);
    // A table out of order, or with a code point twice, does not render back to itself.
    const table = renderTable(upstreamEntries(UPSTREAM));
    for (const bad of [table.replace("00A2 c\n01B7 e", "01B7 e\n00A2 c"), table.replace("0251 a", "0251 a\n0251 a")]) {
      expect(bad).not.toBe(table);
      expect(renderTable(parseLookAlikes(bad))).not.toBe(bad);
    }
  });

  it("on disk holds look-alike symbols and the lunate sigma, and no ASCII", () => {
    expect(CONFUSABLES.get("│")).toBe("i");
    expect(CONFUSABLES.get("∅")).toBe("o");
    expect(CONFUSABLES.get("×")).toBe("x");
    expect(CONFUSABLES.get("Ϲ")).toBe("c");
    expect([...CONFUSABLES.keys()].filter((char) => (char.codePointAt(0) ?? 0) < 0x80)).toEqual([]);
  });

  it("--check fails a table with one changed letter, and passes the table the pinned file gives", async () => {
    const sha = createHash("sha256").update(UPSTREAM, "utf8").digest("hex");
    const transport: Transport = () => Promise.resolve({ status: 200, headers: {}, body: UPSTREAM });
    const dir = mkdtempSync(join(tmpdir(), "nortfox-confusables-"));
    try {
      const file = pathToFileURL(join(dir, "confusables.txt"));
      const generator = { file, build: (via: Transport) => buildTable(via, sha) };
      const table = renderTable(upstreamEntries(UPSTREAM));
      writeFileSync(file, table);
      await expect(runGenerator(["--check"], generator, transport)).resolves.toMatchObject({ code: 0 });
      writeFileSync(file, table.replace("0B66 o", "0B66 x"));
      const line = String(table.split("\n").indexOf("0B66 o") + 1);
      await expect(runGenerator(["--check"], generator, transport)).resolves.toEqual({
        code: 1,
        line: `${fileURLToPath(file)} is not the table the pinned file gives. At line ${line}, the table has "0B66 x", and the pinned file gives "0B66 o".`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is built only from the pinned file", async () => {
    const answer = (status: number, body: string): Transport => () => Promise.resolve({ status, headers: {}, body });
    const sha = createHash("sha256").update(UPSTREAM, "utf8").digest("hex");
    await expect(buildTable(answer(200, UPSTREAM), sha)).resolves.toBe(renderTable(upstreamEntries(UPSTREAM)));
    await expect(buildTable(answer(200, UPSTREAM))).rejects.toThrow(`has SHA-256 ${sha}, not the pinned ${SOURCE_SHA256}.`);
    await expect(buildTable(answer(404, ""), sha)).rejects.toThrow(`${SOURCE_URL} answered 404.`);
  });
});
