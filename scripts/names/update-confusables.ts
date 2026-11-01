// SPDX-License-Identifier: AGPL-3.0-only

// Writes scripts/names/confusables.txt, the look-alike table of the names
// check, from Unicode's confusables data (UTS #39):
//
//   node scripts/names/update-confusables.ts
//
// It downloads the pinned version, checks its SHA-256 and keeps the entries
// that fold() cannot read yet: a letter or digit outside ASCII that looks like
// Latin letters. A new Unicode version is a reviewed change to the three
// constants below.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nodeTransport, type Transport } from "../github/api.ts";
import { foldWith } from "./fold.ts";

export const UNICODE_VERSION = "18.0.0";
export const SOURCE_URL = `https://www.unicode.org/Public/${UNICODE_VERSION}/security/confusables.txt`;
export const SOURCE_SHA256 = "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92";
export const TABLE_FILE = new URL("confusables.txt", import.meta.url);

const NO_TABLE: ReadonlyMap<string, string> = new Map();
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const LATIN_TARGET = /^[A-Za-z013457]+$/;

/**
 * The entry for one character, or undefined when fold() reads it already, or
 * when it does not look like Latin letters.
 */
export function entryFor(char: string, target: string): string | undefined {
  if ((char.codePointAt(0) ?? 0) < 0x80 || !LETTER_OR_DIGIT.test(char)) {
    return undefined;
  }
  const plainTarget = target.normalize("NFKD").replace(/\p{M}/gu, "");
  if (!LATIN_TARGET.test(plainTarget) || foldWith(char, NO_TABLE) !== "") {
    return undefined;
  }
  return foldWith(plainTarget, NO_TABLE);
}

function hex(char: string): string {
  return (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
}

function fromHex(codes: string): string {
  return codes
    .trim()
    .split(/\s+/)
    .map((code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .join("");
}

/** The entries of confusables.txt as Unicode publishes it. */
export function upstreamEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const [source, target] = line.replace(/#.*/, "").split(";");
    if (source === undefined || target === undefined || source.trim().includes(" ")) {
      continue;
    }
    const char = fromHex(source);
    const letters = entryFor(char, fromHex(target));
    if (letters !== undefined) {
      entries.set(char, letters);
    }
  }
  return entries;
}

const HEADER = `# The look-alike table of the names check (scripts/names/fold.ts): one entry
# per line, a code point in hex and the folded Latin letters it looks like.
# Written by scripts/names/update-confusables.ts; do not edit it by hand.
#
# It is derived from confusables.txt of the Unicode Security Mechanisms
# (UTS #39), version ${UNICODE_VERSION}:
# ${SOURCE_URL}
# SHA-256 ${SOURCE_SHA256}
# It keeps the letters and digits outside ASCII that the data maps to Latin
# letters and that fold() does not read already.
#
# The Unicode data is used under the Unicode License v3:
#
# UNICODE LICENSE V3
#
# COPYRIGHT AND PERMISSION NOTICE
#
# Copyright © 1991-2026 Unicode, Inc.
#
# NOTICE TO USER: Carefully read the following legal agreement. BY
# DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
# SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
# TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
# DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.
#
# Permission is hereby granted, free of charge, to any person obtaining a
# copy of data files and any associated documentation (the "Data Files") or
# software and any associated documentation (the "Software") to deal in the
# Data Files or Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, and/or sell
# copies of the Data Files or Software, and to permit persons to whom the
# Data Files or Software are furnished to do so, provided that either (a)
# this copyright and permission notice appear with all copies of the Data
# Files or Software, or (b) this copyright and permission notice appear in
# associated Documentation.
#
# THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
# KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
# MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
# THIRD PARTY RIGHTS.
#
# IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
# BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
# OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
# WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
# ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
# FILES OR SOFTWARE.
#
# Except as contained in this notice, the name of a copyright holder shall
# not be used in advertising or otherwise to promote the sale, use or other
# dealings in these Data Files or Software without prior written
# authorization of the copyright holder.
`;

/** The table file for a set of entries, in code point order. */
export function renderTable(entries: ReadonlyMap<string, string>): string {
  const lines = [...entries]
    .sort(([a], [b]) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0))
    .map(([char, letters]) => `${hex(char)} ${letters}`);
  return `${HEADER}\n${lines.join("\n")}\n`;
}

/** Downloads the pinned confusables.txt, checks it, and gives the table file. */
export async function buildTable(transport: Transport, sha256 = SOURCE_SHA256): Promise<string> {
  const response = await transport("GET", SOURCE_URL, { "user-agent": "nortfox-checks" });
  if (response.status !== 200) {
    throw new Error(`${SOURCE_URL} answered ${String(response.status)}.`);
  }
  const digest = createHash("sha256").update(response.body, "utf8").digest("hex");
  if (digest !== sha256) {
    throw new Error(`${SOURCE_URL} has SHA-256 ${digest}, not the pinned ${sha256}.`);
  }
  return renderTable(upstreamEntries(response.body));
}

if (import.meta.main) {
  writeFileSync(TABLE_FILE, await buildTable(nodeTransport));
  console.log(`Wrote ${fileURLToPath(TABLE_FILE)}.`);
}
