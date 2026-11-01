// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Transport } from "../github/api.ts";
import { ENTITIES, parseEntities } from "./entities.ts";
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

  it("on disk is what the generator writes from its own entries: no entry was edited by hand", () => {
    const committed = readFileSync(TABLE_FILE, "utf8");
    expect(renderTable(ENTITIES)).toBe(committed);
    expect(ENTITIES.size).toBe(2231);
    expect(ENTITIES.get("zopf;")).toBe(String.fromCodePoint(0x1d56b));
    expect(ENTITIES.get("amp")).toBe("&");
  });

  it("is built only from the pinned file", async () => {
    const answer = (status: number, body: string): Transport => () => Promise.resolve({ status, headers: {}, body });
    const sha = createHash("sha256").update(UPSTREAM, "utf8").digest("hex");
    await expect(buildTable(answer(200, UPSTREAM), sha)).resolves.toBe(renderTable(upstreamEntities(UPSTREAM)));
    await expect(buildTable(answer(200, UPSTREAM))).rejects.toThrow(`has SHA-256 ${sha}, not the pinned ${SOURCE_SHA256}.`);
    await expect(buildTable(answer(404, ""), sha)).rejects.toThrow(`${SOURCE_URL} answered 404.`);
  });
});
