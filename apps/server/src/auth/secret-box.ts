// SPDX-License-Identifier: AGPL-3.0-only

// A secret that the server must read again, such as a person's TOTP secret,
// is kept sealed with AES-256-GCM under a key that the install secret
// derives for that use (install-key.ts). The sealed form:
//
//   the format's version (1 byte, 1) | the key id (1) | the nonce (12) |
//   the ciphertext (as long as the secret) | the tag (16)
//
// so a TOTP secret of 20 bytes is 50, as the database's check wants. The
// nonce is fresh for each seal. The associated data is the header, the use
// and the row the secret belongs to, such as the identity's id and the
// secret row's id. So a sealed secret opens only with the same key, for the
// same use, in the same row: one copied to another row, or opened with
// another key, gives nothing.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { InstallKey, SealPurpose } from "./install-key.ts";

export const SEALED_FORMAT_VERSION = 1;
export const HEADER_BYTES = 2;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

const CIPHER = "aes-256-gcm";

/** The length of a sealed secret of `plaintextBytes`. */
export function sealedLength(plaintextBytes: number): number {
  return HEADER_BYTES + NONCE_BYTES + plaintextBytes + TAG_BYTES;
}

/** The associated data: the header, then the use and the row's parts as one JSON array, which keeps the parts apart. */
function associatedData(header: Uint8Array, purpose: SealPurpose, context: readonly string[]): Buffer {
  return Buffer.concat([header, Buffer.from(JSON.stringify([purpose, ...context]), "utf8")]);
}

/** Seals `plaintext` under the key of `purpose`, bound to the row that `context` names. */
export function seal(key: InstallKey, purpose: SealPurpose, plaintext: Uint8Array, context: readonly string[]): Buffer {
  const header = Buffer.from([SEALED_FORMAT_VERSION, key.keyId]);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key.key(purpose), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(header, purpose, context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * The secret that `sealed` holds, or undefined when it does not open: not
 * this format, another key id, another key, another use or row, or a byte
 * changed.
 */
export function open(key: InstallKey, purpose: SealPurpose, sealed: Uint8Array, context: readonly string[]): Buffer | undefined {
  const bytes = Buffer.from(sealed);
  if (bytes.length < sealedLength(0) || bytes[0] !== SEALED_FORMAT_VERSION || bytes[1] !== key.keyId) {
    return undefined;
  }
  const header = bytes.subarray(0, HEADER_BYTES);
  const nonce = bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const decipher = createDecipheriv(CIPHER, key.key(purpose), nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData(header, purpose, context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return undefined;
  }
}
