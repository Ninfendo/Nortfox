// SPDX-License-Identifier: AGPL-3.0-only

// What the two steps of a password sign-in share (docs/api.md, Signing in):
// the one answer of every failure, the lifetimes, the known device, and the
// opening of a session. Each token is random, goes to the browser in a
// cookie or, for a login challenge, in the answer, and is kept only as its
// hash (auth/tokens.ts).

import type { SignInMethod } from "../../api/context.ts";
import type { RuleRefusal } from "../../api/operation.ts";
import { newToken, tokenHash, tokenKind } from "../../auth/tokens.ts";
import type { Queryable } from "../../db/database.ts";

/** The one answer of every failed password step: an unknown identifier, a deleted identity, no password and a wrong password. */
export const PASSWORD_FAILED: RuleRefusal = { code: "sign-in-failed", detail: "The sign-in failed: the identifier or the password is wrong." };

/** The one answer of every failed TOTP step: a wrong code, a code used before, and a challenge that has ended. */
export const CODE_FAILED: RuleRefusal = {
  code: "sign-in-failed",
  detail: "The sign-in failed: the code is wrong, or the sign-in has ended. Start again with the password when it has ended.",
};

/** A login challenge works this long, as long as the established system's codes work (choice 3). */
export const CHALLENGE_LIFETIME_MS = 20 * 60 * 1000;

/** A device counts as known this long after its last TOTP step (issue 12, behaviour 4). */
export const KNOWN_DEVICE_MS = 90 * 24 * 60 * 60 * 1000;

/** The hash of the browser's device cookie, when it holds a device's token. */
export function deviceHashOf(device: string | undefined): Buffer | undefined {
  return device !== undefined && tokenKind(device) === "device" ? tokenHash(device) : undefined;
}

/** A device the person knows, inside its 90 days at `at`: its id, or undefined. */
export async function knownDevice(tx: Queryable, identityId: string, deviceHash: Buffer, at: Date): Promise<string | undefined> {
  const found = await tx.query<{ device_id: string; last_totp_at: Date }>("SELECT device_id, last_totp_at FROM access.known_device($1, $2)", [identityId, deviceHash]);
  const [device] = found.rows;
  return device !== undefined && at.getTime() < device.last_totp_at.getTime() + KNOWN_DEVICE_MS ? device.device_id : undefined;
}

/**
 * Opens a session of an active identity, on its device if any, and gives the
 * session's token, which only the cookie carries; undefined when the
 * identity is no longer active.
 */
export async function openSession(tx: Queryable, identityId: string, method: SignInMethod, deviceId: string | null, at: Date): Promise<string | undefined> {
  const token = newToken("session");
  const opened = await tx.query<{ id: string | null }>("SELECT access.open_session($1, $2, $3, $4, $5) AS id", [tokenHash(token), identityId, method, deviceId, at]);
  // A SELECT of one function call gives one row: the session's id, or NULL.
  const [row] = opened.rows as [{ readonly id: string | null }];
  return row.id === null ? undefined : token;
}
