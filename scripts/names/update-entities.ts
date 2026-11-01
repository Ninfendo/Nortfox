// SPDX-License-Identifier: AGPL-3.0-only

// Writes scripts/names/entities.txt, the table of named character references
// that the names check decodes, from the list in the HTML standard:
//
//   node scripts/names/update-entities.ts           writes the table
//   node scripts/names/update-entities.ts --check   writes nothing, and fails
//                                                   when the committed table is not
//                                                   the one the pinned file gives
//
// It downloads the list, checks its SHA-256 and keeps every name, with and
// without its semicolon, as the standard lists them. GitHub decodes the same
// names when it shows a Markdown file or a PR body. The standard is a living
// one, so a newer list is a reviewed change to the pinned SHA-256 below.

import { createHash } from "node:crypto";
import { nodeTransport, type Transport } from "../github/api.ts";
import type { Entities } from "./entities.ts";
import { runGenerator } from "./tables.ts";

export const SOURCE_URL = "https://html.spec.whatwg.org/entities.json";
export const SOURCE_SHA256 = "d741d877ac77c4194c4ad526b5b4a19aef8dfe411ab840a466891cdbb9f362e6";
export const TABLE_FILE = new URL("entities.txt", import.meta.url);

const KEY = /^&([A-Za-z][A-Za-z0-9]*;?)$/;

/** The code points of a text in hex, one space between them. */
function codePoints(text: string): string {
  const codes: string[] = [];
  for (const char of text) {
    codes.push((char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0"));
  }
  return codes.join(" ");
}

function isCodePoint(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0x10ffff;
}

/** The entries of entities.json as the standard publishes it: a name without its "&", and its characters. */
export function upstreamEntities(text: string): Map<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("entities.json is not an object.");
  }
  const entities = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    const name = KEY.exec(key)?.[1];
    const codepoints: unknown = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["codepoints"] : undefined;
    if (name === undefined || !Array.isArray(codepoints) || codepoints.length === 0 || !codepoints.every(isCodePoint)) {
      throw new Error(`entities.json has an entry ${JSON.stringify(key)} that is not a name and its code points.`);
    }
    entities.set(name, String.fromCodePoint(...codepoints));
  }
  return entities;
}

const BSD_3_CLAUSE = `# Copyright © WHATWG (Apple, Google, Mozilla, Microsoft). The HTML Living
# Standard is licensed under a Creative Commons Attribution 4.0 International
# License. To the extent portions of it are incorporated into source code, such
# portions in the source code are licensed under the BSD 3-Clause License
# instead:
#
# Copyright © WHATWG (Apple, Google, Mozilla, Microsoft).
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice,
#    this list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# 3. Neither the name of the copyright holder nor the names of its
#    contributors may be used to endorse or promote products derived from
#    this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
`;

const HEADER = `# The named character references of the names check (scripts/names/entities.ts):
# one entry per line, a name without its "&" and the code points it stands
# for, in hex. Most names end in ";". The old names that HTML also reads
# without one are listed both ways.
# Written by scripts/names/update-entities.ts; do not edit it by hand.
#
# It is derived from entities.json of the HTML Living Standard, written here
# as lines of text instead of JSON:
# ${SOURCE_URL}
# SHA-256 ${SOURCE_SHA256}
#
${BSD_3_CLAUSE}`;

/** The table file for a set of entries, in the order of their names. */
export function renderTable(entities: Entities): string {
  const lines = [...entities]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, chars]) => `${name} ${codePoints(chars)}`);
  return `${HEADER}\n${lines.join("\n")}\n`;
}

/** Downloads the pinned entities.json, checks it, and gives the table file. */
export async function buildTable(transport: Transport, sha256 = SOURCE_SHA256): Promise<string> {
  const response = await transport("GET", SOURCE_URL, { "user-agent": "nortfox-checks" });
  if (response.status !== 200) {
    throw new Error(`${SOURCE_URL} answered ${String(response.status)}.`);
  }
  const digest = createHash("sha256").update(response.body, "utf8").digest("hex");
  if (digest !== sha256) {
    throw new Error(`${SOURCE_URL} has SHA-256 ${digest}, not the pinned ${sha256}.`);
  }
  return renderTable(upstreamEntities(response.body));
}

if (import.meta.main) {
  const { code, line } = await runGenerator(process.argv.slice(2), { file: TABLE_FILE, build: buildTable }, nodeTransport);
  (code === 0 ? console.log : console.error)(line);
  process.exitCode = code;
}
