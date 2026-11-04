// SPDX-License-Identifier: AGPL-3.0-only

// The login identities as the database tests make them (db/README.md, the
// schema access). In an install only the database's own functions make an
// identity, as nortfox_owner. A test makes one the same way, as the owner,
// whose policy on the install-wide tables reads and writes every row, and
// then works as the app with the person set. Every value is made up: the
// addresses are at example.com, and a personnummer comes only from the
// fixture guard's list.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { inTransaction } from "./database.ts";

/** The test personnummer on the fixture guard's list (scripts/fixtures/test-values.txt). */
export const PERSONAL_IDENTITY_NUMBERS = ["19900101-2385", "20000101-2384", "20100101-2382"] as const;

/** What a test may give a new identity. Each value left out takes a made-up one. */
export interface NewIdentity {
  readonly id?: string;
  readonly name?: string;
  readonly email?: string | null;
  readonly personalIdentityNumber?: string | null;
  readonly mobile?: string | null;
  readonly twoStep?: string;
}

/** A made-up address of its own, at example.com. */
export function someEmail(): string {
  return `person-${randomBytes(5).toString("hex")}@example.com`;
}

/** Adds an identity as the owner, as the database's own functions do, and gives its id. */
export async function addIdentity(owner: Client, identity: NewIdentity = {}): Promise<string> {
  const found = await owner.query<{ id: string }>(
    `INSERT INTO access.identities (id, name, email, personal_identity_number, mobile, two_step)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'new_device_90_days')) RETURNING id`,
    [
      identity.id ?? randomUUID(),
      identity.name ?? "Alva Berg",
      identity.email === undefined ? someEmail() : identity.email,
      identity.personalIdentityNumber ?? null,
      identity.mobile ?? null,
      identity.twoStep ?? null,
    ],
  );
  const [row] = found.rows;
  if (row === undefined) {
    throw new Error("The identity was not added.");
  }
  return row.id;
}

/** A made-up token's hash: 32 random bytes, as the server keeps the SHA-256 of a token. */
export function tokenHash(): Buffer {
  return randomBytes(32);
}

/** A made-up sealed TOTP secret in its stored form: version 1, key id 1, then 48 bytes of nonce, ciphertext and tag. */
export function sealedSecret(): Buffer {
  return Buffer.concat([Buffer.from([1, 1]), randomBytes(48)]);
}

/** Base64 without padding, as the PHC string format writes it. */
function phcBase64(bytes: number): string {
  return randomBytes(bytes).toString("base64").replace(/=+$/, "");
}

/** A made-up Argon2id hash in the PHC string format, with OWASP's first setting. It is no password's hash. */
export function phcString(): string {
  return `$argon2id$v=19$m=19456,t=2,p=1$${phcBase64(16)}$${phcBase64(32)}`;
}

/** Runs `work` in one transaction as the app, with the person as the actor of `kind`, as a signed-in request does. */
export function asPerson<T>(app: Client, person: string, work: () => Promise<T>, kind = "user"): Promise<T> {
  return inTransaction(app, { actor: person, kind, channel: "rest" }, work);
}

/** Runs one statement as `client` in an anonymous transaction, as a sign-in does before it knows the person: only the channel. */
export async function anonymously<T extends object = Record<string, unknown>>(client: Client, sql: string, params: readonly unknown[] = []): Promise<T[]> {
  return inTransaction(client, { channel: "rest" }, async () => (await client.query<T>(sql, [...params])).rows);
}

/** Adds a password to an identity, as the owner. */
export async function addPassword(owner: Client, person: string, hash = phcString()): Promise<string> {
  await owner.query("INSERT INTO access.password_credentials (identity_id, password_hash, changed_at) VALUES ($1, $2, pg_catalog.clock_timestamp())", [
    person,
    hash,
  ]);
  return hash;
}

/** Adds a TOTP secret to an identity, as the owner, and gives its id. */
export async function addTotpSecret(owner: Client, person: string, state: "pending" | "active" | "replaced" = "pending"): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO access.totp_secrets (id, identity_id, secret, state, created_at, confirmed_at)
     VALUES ($1, $2, $3, $4, pg_catalog.clock_timestamp(), CASE WHEN $4 = 'pending' THEN NULL ELSE pg_catalog.clock_timestamp() END)`,
    [id, person, sealedSecret(), state],
  );
  return id;
}

/** The update that deletes an identity: its status, and no e-mail, personnummer or mobile number. */
export const DELETE_IDENTITY =
  "UPDATE access.identities SET status = 'deleted', email = NULL, personal_identity_number = NULL, mobile = NULL WHERE id = $1";

/** Deletes the person's identity as the app, as the person, in a transaction of its own. */
export async function deleteIdentity(app: Client, person: string): Promise<void> {
  await asPerson(app, person, () => app.query(DELETE_IDENTITY, [person]));
}

/** A moment of the server's clock, `minutes` after `from`. */
export function later(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * 60_000);
}
