// SPDX-License-Identifier: AGPL-3.0-only

// NortFox's secret tokens (docs/decisions/0008-authentication.md). Each is
// nf, a letter for its kind, an underscore, and the base64url of 32 random
// bytes: 43 characters. The prefix says what a token is, so a bearer token
// picks its table, and a token found where it must not be names its kind.
// A token is stored only as the SHA-256 of the whole string, 32 bytes under
// a unique key. 256 random bits make a fast hash enough. A code that a person
// types has fewer bits, and gets an HMAC instead (install-key.ts).

import { createHash, randomBytes } from "node:crypto";

/** The letter of each kind of token. */
export const TOKEN_LETTERS = {
  session: "s",
  device: "d",
  challenge: "c",
  login: "l",
  setup: "u",
  invitation: "i",
  reset: "p",
  apiToken: "t",
  oauthRequest: "q",
  oauthCode: "a",
  mcpAccess: "o",
  mcpRefresh: "r",
  bankidOrder: "b",
} as const;

export type TokenKind = keyof typeof TOKEN_LETTERS;

/** The random bytes of a token. */
const TOKEN_BYTES = 32;

/** The length of a token's stored hash. */
export const TOKEN_HASH_BYTES = 32;

/** A token: its letter, and its 43 characters of base64url. */
const TOKEN_FORM = /^nf([a-z])_[A-Za-z0-9_-]{43}$/;

const KIND_OF_LETTER: ReadonlyMap<string, TokenKind> = new Map(Object.entries(TOKEN_LETTERS).map(([kind, letter]) => [letter, kind as TokenKind]));

/** A new random token of `kind`. */
export function newToken(kind: TokenKind): string {
  return `nf${TOKEN_LETTERS[kind]}_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** The kind of a token, or undefined when the text is not one. */
export function tokenKind(text: string): TokenKind | undefined {
  const letter = TOKEN_FORM.exec(text)?.[1];
  return letter === undefined ? undefined : KIND_OF_LETTER.get(letter);
}

/** The hash a token is stored as: the SHA-256 of the whole string. */
export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
