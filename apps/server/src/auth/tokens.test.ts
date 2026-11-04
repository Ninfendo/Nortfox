// SPDX-License-Identifier: AGPL-3.0-only

// Every secret token is nf, a letter for its kind, an underscore, and the
// base64url of 32 random bytes: 43 characters. The prefix says what the token
// is, so a token found in a log names its kind, and a bearer token picks its
// table. A token is stored only as the SHA-256 of the whole string: 256
// random bits make a fast hash enough.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TOKEN_HASH_BYTES, TOKEN_LETTERS, newToken, tokenHash, tokenKind, type TokenKind } from "./tokens.ts";

const KINDS = Object.keys(TOKEN_LETTERS) as TokenKind[];

describe("a token", () => {
  it("has a prefix of its own for each kind", () => {
    expect(TOKEN_LETTERS).toEqual({
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
    });
    expect(new Set(Object.values(TOKEN_LETTERS)).size).toBe(KINDS.length);
  });

  it.each(KINDS)("of the kind %s is nf, its letter, an underscore and 43 characters of base64url from 32 random bytes", (kind) => {
    const token = newToken(kind);
    expect(token).toMatch(new RegExp(`^nf${TOKEN_LETTERS[kind]}_[A-Za-z0-9_-]{43}$`));
    expect(Buffer.from(token.slice(4), "base64url")).toHaveLength(32);
    expect(Buffer.from(token.slice(4), "base64url").toString("base64url")).toBe(token.slice(4));
    expect(tokenKind(token)).toBe(kind);
  });

  it("is random: no two are the same", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newToken("session")));
    expect(tokens.size).toBe(200);
  });

  it("gives no kind for a text that is not a token", () => {
    const body = newToken("session").slice(4);
    for (const text of ["", `nfs_${body.slice(1)}`, `nfs_${body}A`, `nfz_${body}`, `nfk_${body}`, `nfS_${body}`, `NFS_${body}`, `nfs-${body}`, `nfs_${body.slice(1)}+`, ` nfs_${body}`, `nfs_${body}\n`]) {
      expect(tokenKind(text)).toBeUndefined();
    }
  });

  it("is stored as the SHA-256 of the whole string, 32 bytes", () => {
    const token = newToken("apiToken");
    expect(TOKEN_HASH_BYTES).toBe(32);
    expect(tokenHash(token)).toEqual(createHash("sha256").update(token, "utf8").digest());
    expect(tokenHash(token)).toHaveLength(32);
    expect(tokenHash(token).equals(tokenHash(`nfs_${token.slice(4)}`))).toBe(false);
  });
});
