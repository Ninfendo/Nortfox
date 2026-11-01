// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Transport } from "../github/api.ts";
import { CONFUSABLES } from "./fold.ts";
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
  "2223 ;\t006C ;\tMA\t# dropped: a symbol, which the fold reads as a separator",
  "0430 ;\t0061 ;\tMA\t# dropped: a hand-made table reads it already",
  "FF4D ;\t0072 006E ;\tMA\t# dropped: NFKC reads it already",
  "0B66 ;\t006F ;\tMA\t# kept: a digit that looks like a letter, as 0 does",
  "0661 ;\t0031 0032 ;\tMA\t# dropped: 2 stands for no letter",
  "05D5 ;\t05C0 ;\tMA\t# dropped: the look-alike is not Latin",
  "0041 0301 ;\t00C1 ;\tMA\t# dropped: more than one code point",
  "",
].join("\n");

describe("the look-alike table", () => {
  it("keeps only letters outside ASCII that look like Latin letters and that fold() cannot read yet", () => {
    expect([...upstreamEntries(UPSTREAM)]).toEqual([
      ["օ", "o"],
      ["Ꭰ", "d"],
      ["Ʒ", "e"],
      ["ꓲ", "i"],
      ["ɑ", "a"],
      ["୦", "o"],
    ]);
    expect(entryFor("a", "a")).toBeUndefined();
  });

  it("is written in code point order after the source and its licence", () => {
    const table = renderTable(upstreamEntries(UPSTREAM));
    expect(table).toContain(`# ${SOURCE_URL}\n# SHA-256 ${SOURCE_SHA256}\n`);
    expect(table).toContain("# UNICODE LICENSE V3");
    expect(table.split("\n").filter((line) => /^[0-9A-F]+ /.test(line))).toEqual([
      "01B7 e",
      "0251 a",
      "0585 o",
      "0B66 o",
      "13A0 d",
      "A4F2 i",
    ]);
  });

  it("on disk is what the generator writes from its own entries: no entry was edited by hand", () => {
    const committed = readFileSync(TABLE_FILE, "utf8");
    const kept = new Map([...CONFUSABLES].filter(([char, letters]) => entryFor(char, letters) === letters));
    expect(kept.size).toBe(CONFUSABLES.size);
    expect(renderTable(kept)).toBe(committed);
    expect(CONFUSABLES.size).toBeGreaterThan(500);
  });

  it("is built only from the pinned file", async () => {
    const answer = (status: number, body: string): Transport => () => Promise.resolve({ status, headers: {}, body });
    const sha = createHash("sha256").update(UPSTREAM, "utf8").digest("hex");
    await expect(buildTable(answer(200, UPSTREAM), sha)).resolves.toBe(renderTable(upstreamEntries(UPSTREAM)));
    await expect(buildTable(answer(200, UPSTREAM))).rejects.toThrow(`has SHA-256 ${sha}, not the pinned ${SOURCE_SHA256}.`);
    await expect(buildTable(answer(404, ""), sha)).rejects.toThrow(`${SOURCE_URL} answered 404.`);
  });
});
