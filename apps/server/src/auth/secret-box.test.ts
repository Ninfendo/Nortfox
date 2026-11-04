// SPDX-License-Identifier: AGPL-3.0-only

// A secret that the server must read again, such as a TOTP secret, is kept
// sealed with AES-256-GCM, under a key that HKDF derives from the install
// secret for that use. The sealed form is the format's version (1 byte), the
// key's id (1), a fresh nonce (12), the ciphertext and the tag (16). The
// associated data binds it to its use, to the header and to its row, such as
// the identity's id and the secret row's id, so a ciphertext copied to
// another row does not open.

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InstallKey } from "./install-key.ts";
import { HEADER_BYTES, NONCE_BYTES, SEALED_FORMAT_VERSION, TAG_BYTES, open, seal, sealedLength } from "./secret-box.ts";
import { base32Encode } from "./totp.ts";

const KEY = new InstallKey(3, Buffer.from("a made-up install secret, for this test only.", "utf8"));
const SECRET = Buffer.from("0123456789abcdefghij", "ascii");
const PERSON = randomUUID();
const ROW = randomUUID();

describe("a sealed secret", () => {
  it("opens again with the same key, use and row", () => {
    const sealed = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    expect(open(KEY, "totp-secret v1", sealed, [PERSON, ROW])).toEqual(SECRET);
  });

  it("is 50 bytes for a TOTP secret of 20: the version, the key id, the nonce, the ciphertext and the tag", () => {
    expect([SEALED_FORMAT_VERSION, HEADER_BYTES, NONCE_BYTES, TAG_BYTES]).toEqual([1, 2, 12, 16]);
    expect(sealedLength(20)).toBe(50);
    const sealed = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    expect(sealed).toHaveLength(50);
    expect([...sealed.subarray(0, 2)]).toEqual([1, 3]);
  });

  it("carries the key's id in its second byte", () => {
    for (const keyId of [1, 128, 255]) {
      const key = new InstallKey(keyId, Buffer.alloc(32, keyId));
      expect(seal(key, "provider-secret v1", SECRET, [])[1]).toBe(keyId);
    }
  });

  it("does not open in another row: moved to another person or another secret row", () => {
    const sealed = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    expect(open(KEY, "totp-secret v1", sealed, [randomUUID(), ROW])).toBeUndefined();
    expect(open(KEY, "totp-secret v1", sealed, [PERSON, randomUUID()])).toBeUndefined();
    expect(open(KEY, "totp-secret v1", sealed, [ROW, PERSON])).toBeUndefined();
    expect(open(KEY, "totp-secret v1", sealed, [`${PERSON}${ROW}`])).toBeUndefined();
    expect(open(KEY, "totp-secret v1", sealed, [])).toBeUndefined();
  });

  it("opens to what was sealed in its own row, and to nothing in any other", () => {
    const row = fc.array(fc.string({ maxLength: 40 }), { maxLength: 3 });
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), row, row, (secret, context, other) => {
        const sealed = seal(KEY, "totp-secret v1", secret, context);
        expect(sealed).toHaveLength(sealedLength(secret.length));
        expect(open(KEY, "totp-secret v1", sealed, context)).toEqual(Buffer.from(secret));
        fc.pre(JSON.stringify(other) !== JSON.stringify(context));
        expect(open(KEY, "totp-secret v1", sealed, other)).toBeUndefined();
      }),
    );
  });

  it("does not open for another use of the same key", () => {
    const sealed = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    expect(open(KEY, "provider-secret v1", sealed, [PERSON, ROW])).toBeUndefined();
  });

  it("does not open with a wrong key: another secret under the same key id, or another key id", () => {
    const sealed = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    expect(open(new InstallKey(3, Buffer.from("another made-up install secret, for this test.", "utf8")), "totp-secret v1", sealed, [PERSON, ROW])).toBeUndefined();
    expect(open(new InstallKey(4, Buffer.from("a made-up install secret, for this test only.", "utf8")), "totp-secret v1", sealed, [PERSON, ROW])).toBeUndefined();
  });

  it("does not open when a byte of it changed, or when it is cut short", () => {
    const sealed = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    for (let index = 0; index < sealed.length; index += 1) {
      const changed = Buffer.from(sealed);
      changed[index] = (changed[index] ?? 0) ^ 0x01;
      expect(open(KEY, "totp-secret v1", changed, [PERSON, ROW])).toBeUndefined();
    }
    for (const length of [0, 1, 2, HEADER_BYTES + NONCE_BYTES + TAG_BYTES - 1]) {
      expect(open(KEY, "totp-secret v1", sealed.subarray(0, length), [PERSON, ROW])).toBeUndefined();
    }
  });

  it("takes a fresh nonce each time, so the same secret seals two ways", () => {
    const first = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    const second = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    expect(first.subarray(2, 14).equals(second.subarray(2, 14))).toBe(false);
    expect(first.equals(second)).toBe(false);
  });

  it("never holds the secret: not its bytes, nor its hexadecimal, base32 or base64 form", () => {
    const sealed = seal(KEY, "totp-secret v1", SECRET, [PERSON, ROW]);
    expect(sealed.includes(SECRET)).toBe(false);
    for (const form of [SECRET.toString("hex"), base32Encode(SECRET), SECRET.toString("base64")]) {
      expect(sealed.toString("latin1")).not.toContain(form);
    }
    // Not even a third of it in a row.
    for (let start = 0; start + 7 <= SECRET.length; start += 1) {
      expect(sealed.includes(SECRET.subarray(start, start + 7))).toBe(false);
    }
  });
});
