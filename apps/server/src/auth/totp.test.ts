// SPDX-License-Identifier: AGPL-3.0-only

// TOTP (RFC 6238) as NortFox uses it for the second step of a password
// login: HMAC-SHA1 (RFC 4226), 6 digits, 30 seconds, a 20-byte secret, and a
// window of one step on each side. The six digits are compared with
// timingSafeEqual. A person's app takes the secret as an otpauth URI, with the
// secret in base32 (RFC 4648). Each part is checked against its RFC's own
// test vectors.

import type * as NodeCrypto from "node:crypto";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  TOTP_WINDOW,
  base32Decode,
  base32Encode,
  hotp,
  matchingStep,
  newTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
} from "./totp.ts";

const { compared } = vi.hoisted(() => ({ compared: [] as [string, string][] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
      compared.push([Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString(), Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString()]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

/** The secret of RFC 4226's and RFC 6238's test vectors for SHA-1. */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

const at = (seconds: number): Date => new Date(seconds * 1000);

describe("base32", () => {
  // RFC 4648, section 10.
  it.each([
    ["", ""],
    ["f", "MY======"],
    ["fo", "MZXQ===="],
    ["foo", "MZXW6==="],
    ["foob", "MZXW6YQ="],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI======"],
  ])("gives RFC 4648's vector for %j", (text, encoded) => {
    const bytes = Buffer.from(text, "ascii");
    expect(base32Encode(bytes, { padding: true })).toBe(encoded);
    expect(base32Encode(bytes)).toBe(encoded.replace(/=+$/, ""));
    expect(base32Decode(encoded)).toEqual(bytes);
    expect(base32Decode(encoded.replace(/=+$/, ""))).toEqual(bytes);
  });

  it("reads lower case as upper case, and refuses a text that is not base32", () => {
    expect(base32Decode("mzxw6ytboi")).toEqual(Buffer.from("foobar"));
    for (const text of ["MZXW1", "MZXW6YTB0I", "MZ=XW", "M", "MZX", "MZXW6Y", "MZXW6YT=", "MZXW6YTBOI======="]) {
      expect(base32Decode(text)).toBeUndefined();
    }
  });

  it("gives back the bytes it was given, with or without padding, in either case", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.boolean(), fc.boolean(), (bytes, padding, lower) => {
        const encoded = base32Encode(bytes, { padding });
        expect(encoded).toMatch(padding ? /^([A-Z2-7]{8})*([A-Z2-7]{2}={6}|[A-Z2-7]{4}={4}|[A-Z2-7]{5}={3}|[A-Z2-7]{7}=)?$/ : /^[A-Z2-7]*$/);
        expect(base32Decode(lower ? encoded.toLowerCase() : encoded)).toEqual(Buffer.from(bytes));
      }),
    );
  });

  it("gives the RFC secret in the form the otpauth URI carries", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
});

describe("HOTP", () => {
  // RFC 4226, appendix D.
  it.each([
    [0, "755224"],
    [1, "287082"],
    [2, "359152"],
    [3, "969429"],
    [4, "338314"],
    [5, "254676"],
    [6, "287922"],
    [7, "162583"],
    [8, "399871"],
    [9, "520489"],
  ])("gives RFC 4226's vector for the counter %i", (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe("TOTP", () => {
  it("uses 6 digits, 30 seconds, a 20-byte secret and a window of one step on each side", () => {
    expect([TOTP_DIGITS, TOTP_PERIOD_SECONDS, TOTP_SECRET_BYTES, TOTP_WINDOW, TOTP_ISSUER]).toEqual([6, 30, 20, 1, "NortFox"]);
  });

  // RFC 6238, appendix B, the SHA-1 rows. The RFC gives 8 digits; NortFox's 6
  // are the last 6 of them.
  it.each([
    [59, 1, "94287082"],
    [1111111109, 37037036, "07081804"],
    [1111111111, 37037037, "14050471"],
    [1234567890, 41152263, "89005924"],
    [2000000000, 66666666, "69279037"],
    [20000000000, 666666666, "65353130"],
  ])("gives RFC 6238's vector at %i seconds", (seconds, step, code) => {
    expect(totpStep(at(seconds))).toBe(step);
    expect(hotp(RFC_SECRET, step, 8)).toBe(code);
    expect(totpCode(RFC_SECRET, at(seconds))).toBe(code.slice(2));
  });

  it("takes the code of the step before, the step and the step after, and gives the step it matched", () => {
    const now = at(1111111111);
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, step + offset), now)).toBe(step + offset);
    }
  });

  it("refuses the code of two steps before or after, and a code that was never right", () => {
    const now = at(1111111111);
    const step = totpStep(now);
    expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeUndefined();
    expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeUndefined();
    const wrong = String((Number(totpCode(RFC_SECRET, now)) + 1) % 1_000_000).padStart(6, "0");
    expect([hotp(RFC_SECRET, step - 1), hotp(RFC_SECRET, step), hotp(RFC_SECRET, step + 1)]).not.toContain(wrong);
    expect(matchingStep(RFC_SECRET, wrong, now)).toBeUndefined();
  });

  it("refuses anything but six ASCII digits, without comparing", () => {
    const now = at(1111111111);
    const code = totpCode(RFC_SECRET, now);
    compared.length = 0;
    for (const text of ["", code.slice(1), `${code}0`, ` ${code}`, `${code}\n`, "１２３４５６", "12345a", "-12345"]) {
      expect(matchingStep(RFC_SECRET, text, now)).toBeUndefined();
    }
    expect(compared).toEqual([]);
  });

  it("compares the digits with timingSafeEqual, each step of the window, also after a match", () => {
    const now = at(1111111111);
    const step = totpStep(now);
    compared.length = 0;
    expect(matchingStep(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(compared).toEqual([
      [hotp(RFC_SECRET, step - 1), hotp(RFC_SECRET, step - 1)],
      [hotp(RFC_SECRET, step), hotp(RFC_SECRET, step - 1)],
      [hotp(RFC_SECRET, step + 1), hotp(RFC_SECRET, step - 1)],
    ]);
  });

  it("makes a fresh secret of 20 random bytes", () => {
    const first = newTotpSecret();
    expect(first).toHaveLength(20);
    expect(newTotpSecret().equals(first)).toBe(false);
  });
});

describe("the otpauth URI", () => {
  it("names NortFox as the issuer and the e-mail as the account, with the secret in base32 and the parameters spelled out", () => {
    expect(otpauthUri(RFC_SECRET, "anna.lind@example.com")).toBe(
      "otpauth://totp/NortFox:anna.lind%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=NortFox&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("encodes an account that holds characters a URI may not carry as they are", () => {
    expect(otpauthUri(RFC_SECRET, "åsa öst+test@example.org")).toContain("/NortFox:%C3%A5sa%20%C3%B6st%2Btest%40example.org?");
  });
});
