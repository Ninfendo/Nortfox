// SPDX-License-Identifier: AGPL-3.0-only

// TOTP (RFC 6238), the second step of a password login
// (docs/decisions/0008-authentication.md): HOTP (RFC 4226) over HMAC-SHA1,
// with 6 digits, a step of 30 seconds, a secret of 20 random bytes, and a
// window of one step before and one after the server's own, for a clock that
// is a little off. A person's authenticator app takes the secret as an
// otpauth URI, with the secret in base32 (RFC 4648) and NortFox as the
// issuer.
//
// The six digits are compared with timingSafeEqual, against each step of the
// window, also after one matched, so the time tells nothing of which step
// matched or how many digits did. The step a code matched is given back: the
// database takes each step of a secret once (access.use_totp_step), so a
// code works once.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_SECRET_BYTES = 20;
/** The steps taken on each side of the server's own. */
export const TOTP_WINDOW = 1;
export const TOTP_ISSUER = "NortFox";

/** RFC 4648's base32 alphabet. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 (RFC 4648), without its padding unless asked for: an otpauth URI carries none. */
export function base32Encode(bytes: Uint8Array, options: { readonly padding?: boolean } = {}): string {
  let text = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += BASE32.charAt((value >>> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) {
    text += BASE32.charAt((value << (5 - bits)) & 31);
  }
  return options.padding === true ? text.padEnd(Math.ceil(text.length / 8) * 8, "=") : text;
}

/** The data characters a base32 text may end its last group of 8 with. */
const WHOLE_GROUP_ENDS = new Set([0, 2, 4, 5, 7]);

/**
 * The bytes of a base32 text, in either case, with or without its padding;
 * undefined when the text is not one. A text whose last character carries
 * bits beyond its bytes is not one either, so each value has one text.
 */
export function base32Decode(text: string): Buffer | undefined {
  const parts = /^([A-Za-z2-7]*)(=*)$/.exec(text);
  const data = (parts?.[1] ?? "").toUpperCase();
  const padding = parts?.[2] ?? "";
  const rest = data.length % 8;
  const paddingWanted = (8 - rest) % 8;
  if (parts === null || !WHOLE_GROUP_ENDS.has(rest) || (padding !== "" && padding.length !== paddingWanted)) {
    return undefined;
  }
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of data) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
    value &= (1 << bits) - 1;
  }
  return value === 0 ? Buffer.from(bytes) : undefined;
}

/** HOTP (RFC 4226): the code of `counter`, with `digits` digits. */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The TOTP step of a time: the whole periods of 30 seconds since 1970. */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / (TOTP_PERIOD_SECONDS * 1000));
}

/** The code of the step at `at`. */
export function totpCode(secret: Uint8Array, at: Date): string {
  return hotp(secret, totpStep(at));
}

/** Six ASCII digits, and nothing else. */
const CODE = /^[0-9]{6}$/;

/**
 * The step of the window around `at` whose code `code` is, or undefined when
 * it is the code of none. Each step of the window is compared.
 */
export function matchingStep(secret: Uint8Array, code: string, at: Date): number | undefined {
  if (!CODE.test(code)) {
    return undefined;
  }
  const given = Buffer.from(code, "ascii");
  const step = totpStep(at);
  const steps = Array.from({ length: 2 * TOTP_WINDOW + 1 }, (_, index) => step - TOTP_WINDOW + index);
  // Every step is compared, so the time is the same wherever the code matched.
  const matches = steps.map((candidate) => timingSafeEqual(Buffer.from(hotp(secret, candidate), "ascii"), given));
  const first = matches.indexOf(true);
  return first === -1 ? undefined : steps[first];
}

/** A new TOTP secret: 20 random bytes. */
export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** The otpauth URI that an authenticator app takes: NortFox as the issuer, the account (the e-mail) and the secret. */
export function otpauthUri(secret: Uint8Array, account: string): string {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  return (
    `otpauth://totp/${issuer}:${encodeURIComponent(account)}` +
    `?secret=${base32Encode(secret)}&issuer=${issuer}&algorithm=SHA1&digits=${String(TOTP_DIGITS)}&period=${String(TOTP_PERIOD_SECONDS)}`
  );
}
