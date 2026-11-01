// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Transport } from "../github/api.ts";
import { ENTITIES, parseEntities } from "./entities.ts";
import { runGenerator } from "./tables.ts";
import { buildTable, renderTable, SOURCE_SHA256, SOURCE_URL, TABLE_FILE, upstreamEntities } from "./update-entities.ts";

/** Entries in the form the HTML standard publishes them in. */
const UPSTREAM = `{
  "&zopf;": { "codepoints": [120171], "characters": "\\uD835\\uDD6B" },
  "&amp": { "codepoints": [38], "characters": "\\u0026" },
  "&amp;": { "codepoints": [38], "characters": "\\u0026" },
  "&NotEqualTilde;": { "codepoints": [8770, 824], "characters": "\\u2242\\u0338" },
  "&frac12;": { "codepoints": [189], "characters": "\\u00BD" }
}`;

describe("the entity table", () => {
  it("keeps every name, with and without its semicolon", () => {
    expect([...upstreamEntities(UPSTREAM)]).toEqual([
      ["zopf;", String.fromCodePoint(0x1d56b)],
      ["amp", "&"],
      ["amp;", "&"],
      ["NotEqualTilde;", "≂̸"],
      ["frac12;", "½"],
    ]);
  });

  it.each([
    ["a list", "[]"],
    ["a name without its &", '{ "amp;": { "codepoints": [38] } }'],
    ["a name that is not one", '{ "&a-b;": { "codepoints": [38] } }'],
    ["no code points", '{ "&amp;": { "codepoints": [] } }'],
    ["a code point beyond Unicode", '{ "&amp;": { "codepoints": [1114112] } }'],
    ["an entry that is not an object", '{ "&amp;": 38 }'],
  ])("refuses %s", (_case, json) => {
    expect(() => upstreamEntities(json)).toThrow(/^entities\.json (is not an object|has an entry .* that is not a name and its code points)\.$/);
  });

  it("is written in the order of the names after the source and its licence", () => {
    const table = renderTable(upstreamEntities(UPSTREAM));
    expect(table).toContain(`# ${SOURCE_URL}\n# SHA-256 ${SOURCE_SHA256}\n`);
    expect(table).toContain("# Copyright © WHATWG (Apple, Google, Mozilla, Microsoft).");
    expect(table).toContain("licensed under the BSD 3-Clause License");
    expect(table.split("\n").filter((line) => !line.startsWith("#") && line !== "")).toEqual([
      "NotEqualTilde; 2242 0338",
      "amp 0026",
      "amp; 0026",
      "frac12; 00BD",
      "zopf; 1D56B",
    ]);
    expect([...parseEntities(table)]).toEqual([...upstreamEntities(UPSTREAM)].sort(([a], [b]) => (a < b ? -1 : 1)));
  });

  // The pinned file is not in the repository, so this test cannot see a
  // changed code point. "node scripts/names/update-entities.ts --check" does.
  it("on disk has the generator's header, form and order, and each name once", () => {
    const committed = readFileSync(TABLE_FILE, "utf8");
    expect(renderTable(ENTITIES)).toBe(committed);
    expect(ENTITIES.size).toBe(2231);
    expect(ENTITIES.get("zopf;")).toBe(String.fromCodePoint(0x1d56b));
    expect(ENTITIES.get("amp")).toBe("&");
    // A table out of order, or with a name twice, does not render back to itself.
    const table = renderTable(upstreamEntities(UPSTREAM));
    for (const bad of [table.replace("amp 0026\namp; 0026", "amp; 0026\namp 0026"), table.replace("amp; 0026", "amp; 0026\namp; 0026")]) {
      expect(bad).not.toBe(table);
      expect(renderTable(parseEntities(bad))).not.toBe(bad);
    }
  });

  it("--check fails a table with one changed code point, and passes the table the pinned file gives", async () => {
    const sha = createHash("sha256").update(UPSTREAM, "utf8").digest("hex");
    const transport: Transport = () => Promise.resolve({ status: 200, headers: {}, body: UPSTREAM });
    const dir = mkdtempSync(join(tmpdir(), "nortfox-entities-"));
    try {
      const file = pathToFileURL(join(dir, "entities.txt"));
      const generator = { file, build: (via: Transport) => buildTable(via, sha) };
      const table = renderTable(upstreamEntities(UPSTREAM));
      writeFileSync(file, table);
      await expect(runGenerator(["--check"], generator, transport)).resolves.toMatchObject({ code: 0 });
      writeFileSync(file, table.replace("zopf; 1D56B", "zopf; 0020"));
      const line = String(table.split("\n").indexOf("zopf; 1D56B") + 1);
      await expect(runGenerator(["--check"], generator, transport)).resolves.toEqual({
        code: 1,
        line: `${fileURLToPath(file)} is not the table the pinned file gives. At line ${line}, the table has "zopf; 0020", and the pinned file gives "zopf; 1D56B".`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is built only from the pinned file", async () => {
    const answer = (status: number, body: string): Transport => () => Promise.resolve({ status, headers: {}, body });
    const sha = createHash("sha256").update(UPSTREAM, "utf8").digest("hex");
    await expect(buildTable(answer(200, UPSTREAM), sha)).resolves.toBe(renderTable(upstreamEntities(UPSTREAM)));
    await expect(buildTable(answer(200, UPSTREAM))).rejects.toThrow(`has SHA-256 ${sha}, not the pinned ${SOURCE_SHA256}.`);
    await expect(buildTable(answer(404, ""), sha)).rejects.toThrow(`${SOURCE_URL} answered 404.`);
  });
});
