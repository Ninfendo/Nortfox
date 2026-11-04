// SPDX-License-Identifier: AGPL-3.0-only

// verifyTotp: the TOTP step of a password sign-in (issue 12, behaviour 4;
// RFC 6238). In this order:
//
// 1. The challenge is found by its token's hash: one that is used, past its
//    20 minutes or out of attempts gives nothing. While the identity's TOTP
//    step is locked, the attempt gets 429 too-many-attempts, and claims
//    nothing. Otherwise one attempt of the challenge is claimed, in a
//    transaction that commits, before the code is checked: so parallel calls
//    on one challenge get five attempts in all.
// 2. The code is checked against the person's active TOTP secret, or the
//    pending one of a new identity, opened with the install key, in the
//    window of one step on each side.
// 3. A wrong code counts in the identity's TOTP counter. The tenth in 15
//    minutes locks the step for 15 minutes. Each wrong code, and the lock
//    once, is written to Kontoaktivitet after the answer.
// 4. A right code, in one transaction as the person: the challenge is used,
//    and gives its attempt back; the code's step is taken once, so one code
//    gives one session also when it is sent twice at once (a step taken
//    before counts as a wrong code); a pending secret becomes active; the
//    browser becomes a known device, with a new device cookie when it had
//    none; and the session opens, with its cookie and a sign-in in
//    Kontoaktivitet.
//
// Every failure but the lock gets the one answer, 422 sign-in-failed.

import { verifyTotp } from "@nortfox/contract";
import type { SignInMethod } from "../../api/context.ts";
import { handleNone, ok, refused, tooManyAttempts, type Answer, type NoneCall } from "../../api/operation.ts";
import type { CookieEffect } from "../../auth/cookies.ts";
import { open } from "../../auth/secret-box.ts";
import { matchingStep } from "../../auth/totp.ts";
import { newToken, tokenHash } from "../../auth/tokens.ts";
import { commit, rollBack, type Ending } from "../../db/database.ts";
import { addAccountEvent, addAfterAnswer, asPerson, signInDetails, type AccountEvent } from "./account-events.ts";
import { TOTP_CAP, TOTP_LOCK_MS, TOTP_WINDOW_MS, attemptCounter, countFailure, lockAttempts, lockWait } from "./limits.ts";
import { CODE_FAILED, openSession } from "./sign-in.ts";

/** A live challenge, as access.challenge_by_token gives it with the person's TOTP secret. */
interface ChallengeRow {
  readonly challenge_id: string;
  readonly identity_id: string;
  readonly status: string;
  readonly method: SignInMethod;
  readonly device_hash: Buffer | null;
  readonly totp_secret_id: string | null;
  readonly totp_secret: Buffer | null;
}

/** What the first transaction found: a claimed attempt, a lock to wait for, or nothing. */
type Claimed = { readonly claimed: ChallengeRow } | { readonly wait: number } | undefined;

/** The browser's device: the challenge's, or a new one whose cookie the answer sets. */
function deviceOf(challengeDevice: Buffer | null): { readonly hash: Buffer; readonly token?: string } {
  if (challengeDevice !== null) {
    return { hash: challengeDevice };
  }
  const token = newToken("device");
  return { hash: tokenHash(token), token };
}

/** The person's TOTP secret in clear, with its row's id; undefined when there is none or it does not open. */
function secretOf(challenge: ChallengeRow, call: NoneCall): { readonly id: string; readonly secret: Buffer } | undefined {
  // A challenge gives both, or neither when the person has no secret.
  const { totp_secret_id: id, totp_secret: sealed } = challenge;
  if (id === null || sealed === null) {
    return undefined;
  }
  const secret = open(call.services.installKey, "totp-secret v1", sealed, [challenge.identity_id, id]);
  return secret === undefined ? undefined : { id, secret };
}

/** Counts a wrong code, locks the step at the tenth, and writes both to Kontoaktivitet after the answer. */
async function wrongCode(call: NoneCall, challenge: ChallengeRow, at: Date): Promise<Answer<never>> {
  const { database, channel } = call;
  const person = challenge.identity_id;
  const until = new Date(at.getTime() + TOTP_LOCK_MS);
  const failed = await database.write({ channel }, async (tx) => {
    const counted = await countFailure(tx, person, "totp", TOTP_WINDOW_MS, at);
    if (counted.failures >= TOTP_CAP) {
      await lockAttempts(tx, person, "totp", until);
    }
    return commit(counted);
  });
  const events: AccountEvent[] = [{ kind: "sign-in", details: signInDetails(challenge.method, "totp", call.request, "failed") }];
  if (failed.failures === TOTP_CAP) {
    events.push({ kind: "sign-in-locked", details: { step: "totp", until: until.toISOString() } });
  }
  addAfterAnswer(call.later, database, channel, person, events);
  return refused(CODE_FAILED);
}

/** What the right code's transaction gave: the session and the device's new token, or why it gave none. */
type Opened = { readonly session: string; readonly device?: string } | "challenge-used" | "step-used" | "not-active";

export const verifyTotpHandler = handleNone(verifyTotp, async (call, { body }): Promise<Answer<Record<string, never>>> => {
  const { database, channel, request } = call;
  const at = call.now();
  const found = await database.write({ channel }, async (tx): Promise<Ending<Claimed>> => {
    const rows = await tx.query<ChallengeRow>(
      "SELECT challenge_id, identity_id, status, method, device_hash, totp_secret_id, totp_secret FROM access.challenge_by_token($1, $2)",
      [tokenHash(body.challenge), at],
    );
    const [challenge] = rows.rows;
    if (challenge?.status !== "active") {
      return rollBack(undefined);
    }
    const wait = lockWait(await attemptCounter(tx, challenge.identity_id, "totp"), at);
    if (wait !== undefined) {
      return rollBack({ wait });
    }
    const claim = await tx.query<{ attempt: number | null }>("SELECT access.claim_attempt($1, $2) AS attempt", [challenge.challenge_id, at]);
    // A SELECT of one function call gives one row: the attempt's number, or NULL when none was left.
    return (claim.rows as [{ readonly attempt: number | null }])[0].attempt === null ? rollBack(undefined) : commit({ claimed: challenge });
  });
  if (found === undefined) {
    return refused(CODE_FAILED);
  }
  if ("wait" in found) {
    return tooManyAttempts(found.wait);
  }
  const challenge = found.claimed;
  const secret = secretOf(challenge, call);
  const step = secret === undefined ? undefined : matchingStep(secret.secret, body.code, at);
  if (secret === undefined || step === undefined) {
    return wrongCode(call, challenge, at);
  }
  const secretId = secret.id;
  const person = challenge.identity_id;
  const opened = await database.write(asPerson(person, channel), async (tx): Promise<Ending<Opened>> => {
    const used = await tx.query<{ used: boolean }>("SELECT access.use_challenge($1, $2) AS used", [challenge.challenge_id, at]);
    if (!(used.rows as [{ readonly used: boolean }])[0].used) {
      return rollBack("challenge-used");
    }
    const taken = await tx.query<{ taken: boolean }>("SELECT access.use_totp_step($1, $2, $3, $4) AS taken", [secretId, person, step, at]);
    if (!(taken.rows as [{ readonly taken: boolean }])[0].taken) {
      return rollBack("step-used");
    }
    const device = deviceOf(challenge.device_hash);
    const remembered = await tx.query<{ id: string | null }>("SELECT access.remember_device($1, $2, $3) AS id", [person, device.hash, at]);
    const session = await openSession(tx, person, challenge.method, (remembered.rows as [{ readonly id: string | null }])[0].id, at);
    if (session === undefined) {
      return rollBack("not-active");
    }
    await addAccountEvent(tx, person, { kind: "sign-in", details: signInDetails(challenge.method, "totp", request, "succeeded") });
    return commit(device.token === undefined ? { session } : { session, device: device.token });
  });
  if (opened === "step-used") {
    return wrongCode(call, challenge, at);
  }
  if (typeof opened === "string") {
    return refused(CODE_FAILED);
  }
  const effects: CookieEffect[] = [{ kind: "set-session", token: opened.session }];
  if (opened.device !== undefined) {
    effects.push({ kind: "set-device", token: opened.device });
  }
  return ok({}, effects);
});
