// SPDX-License-Identifier: AGPL-3.0-only

// The install secret: a key id from 1 to 255 and at least 32 secret bytes.
// HKDF-SHA256 derives one key of 32 bytes for each use, with the use's name
// as its info, so no two uses share a key. The key never shows itself: not
// in a log line, not as JSON. The check value is a fixed text sealed under
// the key, which a later start opens to know it has the same key.

import { createHmac, hkdfSync } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { InstallKey, MAC_PURPOSES, SEAL_PURPOSES, checkValue, opensCheckValue } from "./install-key.ts";

const SECRET = Buffer.from("9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e1f3b5d7a9c1e3f5b7d9a", "hex");
const KEY = new InstallKey(7, SECRET);

describe("an install key", () => {
  it("has a key id from 1 to 255 and a secret of at least 32 bytes", () => {
    expect(new InstallKey(1, SECRET).keyId).toBe(1);
    expect(new InstallKey(255, Buffer.alloc(32)).keyId).toBe(255);
    for (const keyId of [0, 256, -1, 1.5, Number.NaN]) {
      expect(() => new InstallKey(keyId, SECRET)).toThrow("The install secret's key id must be a whole number from 1 to 255.");
    }
    expect(() => new InstallKey(1, Buffer.alloc(31))).toThrow("The install secret must be at least 32 bytes.");
  });

  it("derives one 32-byte key for each use with HKDF-SHA256, the use's name as the info and no salt", () => {
    const uses = [...SEAL_PURPOSES, ...MAC_PURPOSES];
    expect(uses).toEqual([
      "totp-secret v1",
      "provider-secret v1",
      "key-check v1",
      "email-code v1",
      "recovery-code v1",
      "identifier v1",
      "idempotency-fingerprint v1",
    ]);
    const keys = uses.map((use) => KEY.key(use));
    for (const [index, use] of uses.entries()) {
      expect(keys[index]).toEqual(Buffer.from(hkdfSync("sha256", SECRET, Buffer.alloc(0), use, 32)));
    }
    expect(new Set(keys.map((key) => key.toString("hex"))).size).toBe(uses.length);
  });

  it("derives other keys from another secret, and the same from the same", () => {
    expect(new InstallKey(7, SECRET).key("totp-secret v1")).toEqual(KEY.key("totp-secret v1"));
    expect(new InstallKey(7, Buffer.alloc(32, 1)).key("totp-secret v1")).not.toEqual(KEY.key("totp-secret v1"));
  });

  it("gives a copy of a key, so a caller cannot change it", () => {
    KEY.key("identifier v1").fill(0);
    expect(KEY.key("identifier v1")).toEqual(Buffer.from(hkdfSync("sha256", SECRET, Buffer.alloc(0), "identifier v1", 32)));
  });

  it("keeps no copy of the secret that a change of the caller's buffer reaches", () => {
    const given = Buffer.from(SECRET);
    const key = new InstallKey(7, given);
    given.fill(0);
    expect(key.key("totp-secret v1")).toEqual(KEY.key("totp-secret v1"));
  });

  it("makes an HMAC-SHA256 under the key of its use, as 64 lower-case hexadecimal digits", () => {
    const mac = KEY.mac("identifier v1", "anna.lind@example.com");
    expect(mac).toBe(createHmac("sha256", KEY.key("identifier v1")).update("anna.lind@example.com").digest("hex"));
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(KEY.mac("identifier v1", Buffer.from("anna.lind@example.com"))).toBe(mac);
    expect(KEY.mac("email-code v1", "anna.lind@example.com")).not.toBe(mac);
  });

  it("never shows its secret or a derived key: not inspected, not as JSON, not as text", () => {
    const shown = [inspect(KEY), inspect({ nested: { KEY } }, { depth: 5 }), JSON.stringify(KEY), JSON.stringify({ KEY }), String(KEY), String(KEY.keyId)];
    for (const text of shown) {
      expect(text).not.toContain(SECRET.toString("hex"));
      expect(text).not.toContain(SECRET.toString("base64"));
      for (const use of [...SEAL_PURPOSES, ...MAC_PURPOSES]) {
        expect(text).not.toContain(KEY.key(use).toString("hex"));
      }
    }
    expect(inspect(KEY)).toBe("InstallKey { keyId: 7 }");
    expect(JSON.stringify(KEY)).toBe('{"keyId":7}');
    expect(String(KEY)).toBe("InstallKey 7");
  });
});

describe("the key check value", () => {
  it("opens with the key that made it", () => {
    expect(opensCheckValue(KEY, checkValue(KEY))).toBe(true);
  });

  it("does not open with another secret under the same key id, nor under another key id", () => {
    const value = checkValue(KEY);
    expect(opensCheckValue(new InstallKey(7, Buffer.alloc(32, 1)), value)).toBe(false);
    expect(opensCheckValue(new InstallKey(8, SECRET), value)).toBe(false);
  });

  it("does not open when it is not a sealed value", () => {
    expect(opensCheckValue(KEY, Buffer.alloc(0))).toBe(false);
    expect(opensCheckValue(KEY, Buffer.alloc(60, 1))).toBe(false);
  });

  it("is sealed, with the key's id in it, and holds no secret", () => {
    const value = checkValue(KEY);
    expect([...value.subarray(0, 2)]).toEqual([1, 7]);
    expect(value.includes(SECRET)).toBe(false);
    expect(value.toString("latin1")).not.toContain("NortFox");
  });
});
