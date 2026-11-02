// SPDX-License-Identifier: AGPL-3.0-only

// Decodes the escapes that JSON and JavaScript write for a character:
// \u00f6, \u{f6} and \xf6. Python's json.dumps and .NET's JSON encoder write
// every letter outside ASCII that way by default, so an address at a domain
// with å, ä or ö reads as an address only once its escapes are decoded.

import { isUtf8 } from "node:buffer";

/** One escape: \uNNNN, \u{N…} or \xNN. */
const ESCAPE = /\\u([0-9A-Fa-f]{4})|\\u\{([0-9A-Fa-f]{1,6})\}|\\x([0-9A-Fa-f]{2})/g;

/** A run of \xNN escapes. */
const BYTE_RUN = /(?:\\x[0-9A-Fa-f]{2})+/g;

/** The character of one escape, or the escape as it stands when it names no character. */
function character(escape: string, four = "", braced = "", two = ""): string {
  const code = Number.parseInt(four + braced + two, 16);
  return code > 0x10ffff ? escape : String.fromCodePoint(code);
}

/** A run of \xNN escapes as the text its bytes make in UTF-8, or the run as it stands when they make none. */
function utf8Run(run: string): string {
  const bytes = Buffer.from(run.replaceAll("\\x", ""), "hex");
  return isUtf8(bytes) ? bytes.toString("utf8") : run;
}

/**
 * What a text reads as once its escapes are decoded where they stand, or
 * nothing when it holds none. It gives up to two readings. In the first,
 * \xNN is the character NN, as JavaScript reads it. In the second, a run of
 * \xNN is the bytes of UTF-8, as a Python bytes literal holds them
 * (b"\xc3\xb6" for ö).
 */
export function escapeDecodings(text: string): string[] {
  if (!text.includes("\\")) {
    return [];
  }
  const characters = text.replace(ESCAPE, character);
  const bytes = text.replace(BYTE_RUN, utf8Run).replace(ESCAPE, character);
  return [...new Set([characters, bytes])].filter((reading) => reading !== text);
}
