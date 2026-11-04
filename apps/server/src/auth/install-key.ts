// SPDX-License-Identifier: AGPL-3.0-only

// The install secret (deploy/README.md): a key id from 1 to 255 and at least
// 32 random bytes, which the operator keeps in a file and backs up apart
// from the database. The server needs it to start (config.ts).
//
// - HKDF-SHA256 derives one key of 32 bytes for each use, with the use's name
//   as its info and no salt, so no two uses share a key. Three uses seal a
//   value that the server reads again (secret-box.ts): a TOTP secret, a
//   provider's secret, and the key check value. Four make an HMAC: an e-mail
//   code, a recovery code, an identifier that names no identity, and a
//   request's fingerprint. A sealed value keeps the key id in its header,
//   and an identifier's HMAC keeps it in its subject (hmac:<key id>:...). A
//   request's fingerprint keeps none: it is 64 hexadecimal digits, which the
//   idempotency key tables check. So after a change of install key, a retry
//   of an older write no longer matches its stored request, and is refused
//   as another request instead of getting the stored answer again.
// - The key never shows itself: the secret and the derived keys live in
//   private fields, and inspecting the key, writing it as JSON or as text
//   gives only its key id.
// - The key check value. The first start of an install stores, in
//   access.install_keys, the key id and a fixed text sealed under the key.
//   Each later start opens it with its own key, and refuses to start when it
//   cannot, or when its key id is not the stored one. So a key made again by
//   mistake, with the same key id or another, fails loudly, before it writes
//   anything that the old key cannot read. The server cannot yet open what
//   another key sealed, so a start never stores the check value of a second
//   key id. A change of install secret comes with the old key files and the
//   rekey command, in a later part.

import { createHmac, hkdfSync } from "node:crypto";
import { inspect } from "node:util";
import { commit, type Database } from "../db/database.ts";
import { open, seal } from "./secret-box.ts";

/** The uses whose keys seal a value that the server reads again. */
export const SEAL_PURPOSES = ["totp-secret v1", "provider-secret v1", "key-check v1"] as const;

/** The uses whose keys make an HMAC. */
export const MAC_PURPOSES = ["email-code v1", "recovery-code v1", "identifier v1", "idempotency-fingerprint v1"] as const;

export type SealPurpose = (typeof SEAL_PURPOSES)[number];
export type MacPurpose = (typeof MAC_PURPOSES)[number];
export type KeyPurpose = SealPurpose | MacPurpose;

/** The fewest secret bytes an install secret has. */
export const INSTALL_SECRET_MIN_BYTES = 32;

/** The highest key id: the sealed form keeps it in one byte, and 0 is never one. */
export const KEY_ID_MAX = 255;

/** The length of each derived key: AES-256 and HMAC-SHA256 both take 32 bytes. */
const DERIVED_KEY_BYTES = 32;

/** The install secret, as the keys it derives. */
export class InstallKey {
  readonly keyId: number;
  readonly #keys: Readonly<Record<KeyPurpose, Buffer>>;

  constructor(keyId: number, secret: Uint8Array) {
    if (!Number.isInteger(keyId) || keyId < 1 || keyId > KEY_ID_MAX) {
      throw new Error(`The install secret's key id must be a whole number from 1 to ${String(KEY_ID_MAX)}.`);
    }
    if (secret.length < INSTALL_SECRET_MIN_BYTES) {
      throw new Error(`The install secret must be at least ${String(INSTALL_SECRET_MIN_BYTES)} bytes.`);
    }
    this.keyId = keyId;
    // Every purpose gets its key here.
    this.#keys = Object.fromEntries(
      [...SEAL_PURPOSES, ...MAC_PURPOSES].map((purpose) => [purpose, Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), purpose, DERIVED_KEY_BYTES))]),
    ) as Record<KeyPurpose, Buffer>;
  }

  /** A copy of the key of `purpose`. */
  key(purpose: KeyPurpose): Buffer {
    return Buffer.from(this.#keys[purpose]);
  }

  /** The HMAC-SHA256 of `data` under the key of `purpose`, as 64 lower-case hexadecimal digits. */
  mac(purpose: MacPurpose, data: string | Uint8Array): string {
    return createHmac("sha256", this.#keys[purpose]).update(data).digest("hex");
  }

  toJSON(): { readonly keyId: number } {
    return { keyId: this.keyId };
  }

  toString(): string {
    return `InstallKey ${String(this.keyId)}`;
  }

  [inspect.custom](): string {
    return `InstallKey { keyId: ${String(this.keyId)} }`;
  }
}

/** The fixed text that the key check value seals. */
const CHECK_TEXT = Buffer.from("The install key of this NortFox install.", "utf8");

/** The key check value of `key`: the fixed text, sealed under its key-check key, bound to its key id. */
export function checkValue(key: InstallKey): Buffer {
  return seal(key, "key-check v1", CHECK_TEXT, [String(key.keyId)]);
}

/** Whether `value` is a key check value that `key` made. */
export function opensCheckValue(key: InstallKey, value: Uint8Array): boolean {
  return open(key, "key-check v1", value, [String(key.keyId)])?.equals(CHECK_TEXT) === true;
}

/**
 * The key check at start: stores the key's check value on an install that
 * has none, and throws when the install has the check value of another key
 * id, or when the stored one does not open with the key. No row the function
 * writes takes the channel; it is set because every transaction needs one.
 */
export async function checkInstallKey(database: Database, key: InstallKey): Promise<void> {
  const stored = await database.write({ channel: "rest" }, async (tx) => {
    const found = await tx.query<{ kept_key_id: number; kept: Buffer }>("SELECT kept_key_id, kept FROM access.install_key($1, $2)", [key.keyId, checkValue(key)]);
    return commit(found.rows);
  });
  const others = stored.filter((row) => row.kept_key_id !== key.keyId).map((row) => String(row.kept_key_id));
  if (others.length > 0) {
    throw new Error(
      `The install secret has key id ${String(key.keyId)}, but this install stored the check value of key id ${others.join(", ")} at its first start. ` +
        "It is not the key that the install was set up with. Start the server with that key, from your backup of it.",
    );
  }
  // The install has a check value, the one just stored at the least, and only of this key id.
  const [{ kept }] = stored as unknown as [{ readonly kept: Buffer }];
  if (!opensCheckValue(key, kept)) {
    throw new Error(
      `The install secret does not open the check value that this install stored for key id ${String(key.keyId)} at its first start. ` +
        "It is not the key that the install was set up with. Start the server with that key, from your backup of it.",
    );
  }
}
