// SPDX-License-Identifier: AGPL-3.0-only

// verifyTotp: the TOTP step of a password sign-in (issue 12, behaviour 4;
// RFC 6238). In this order:
//
// 1. The challenge is found by its token's hash: one that is used, past its
//    20 minutes or out of attempts gives nothing. Then, in a transaction that
//    commits before the code is checked, the attempt is counted as a wrong
//    code of the identity, under its counter's row lock, and one attempt of
//    the challenge is claimed. While the identity's TOTP step is locked, or
//    its counter is at the cap, the attempt gets 429 too-many-attempts, and
//    counts and claims nothing. So parallel calls on one challenge get five
//    attempts in all, and parallel calls across the identity's challenges
//    get ten in 15 minutes in all (limits.ts).
// 2. The code is checked against the person's active TOTP secret, or the
//    pending one of a new identity, opened with the install key, in the
//    window of one step on each side. A secret that does not open is the
//    server's fault, not a wrong code: the attempt gives its count back, the
//    error goes to the report, and the answer is 500.
// 3. A wrong code has counted already. The tenth in 15 minutes locks the step
//    for 15 minutes. Each wrong code, and the lock once, is written to
//    Kontoaktivitet after the answer.
// 4. A right code, in one transaction as the person: it gives back its count
//    of the identity's wrong codes; the challenge is used, and gives its
//    attempt back; the code's step is taken once, so one code gives one
//    session also when it is sent twice at once (a step taken before counts
//    as a wrong code); a pending secret becomes active; the browser becomes a
//    known device; and the session opens, with its cookie and a sign-in in
//    Kontoaktivitet. The browser's device cookie is kept only when it names a
//    device that the person knows already. Otherwise the server makes a new
//    device token and sets its cookie: a token that the server did not give
//    this person, such as one that someone else put in the browser, never
//    becomes the person's known device.
//
// Every failure of the person's but the lock gets the one answer, 422
// sign-in-failed.

import { verifyTotp } from "@nortfox/contract";
import type { SignInMethod } from "../../api/context.ts";
import { handleNone, ok, refused, tooManyAttempts, type Answer, type NoneCall } from "../../api/operation.ts";
import type { CookieEffect } from "../../auth/cookies.ts";
import { open } from "../../auth/secret-box.ts";
import { matchingStep } from "../../auth/totp.ts";
import { newToken, tokenHash } from "../../auth/tokens.ts";
import { commit, rollBack, type Ending, type Queryable } from "../../db/database.ts";
import { addAccountEvent, addAfterAnswer, asPerson, signInDetails, type AccountEvent } from "./account-events.ts";
import { TOTP_CAP, TOTP_WINDOW_MS, countFailure, giveBackFailure, lockAttempts, totpLockEnd, totpWait, type AttemptCounter } from "./limits.ts";
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

/** What the first transaction found: a claimed attempt with the identity's counter after its count, a lock to wait for, or nothing. */
type Claimed = { readonly claimed: ChallengeRow; readonly counted: AttemptCounter } | { readonly wait: number } | undefined;

/**
 * The browser's device: the challenge's when the person knows it already, at
 * any age, or else a new one whose cookie the answer sets.
 */
async function deviceOf(tx: Queryable, person: string, challengeDevice: Buffer | null): Promise<{ readonly hash: Buffer; readonly token?: string }> {
  if (challengeDevice !== null) {
    const known = await tx.query("SELECT 1 FROM access.known_device($1, $2)", [person, challengeDevice]);
    if (known.rows.length > 0) {
      return { hash: challengeDevice };
    }
  }
  const token = newToken("device");
  return { hash: tokenHash(token), token };
}

/** The person's TOTP secret: in clear, with its row's id; sealed, when it does not open with the install key; or none. */
type TotpSecret = { readonly id: string; readonly secret: Buffer } | { readonly id: string; readonly unopened: Buffer } | undefined;

function secretOf(challenge: ChallengeRow, call: NoneCall): TotpSecret {
  // A challenge gives both, or neither when the person has no secret.
  const { totp_secret_id: id, totp_secret: sealed } = challenge;
  if (id === null || sealed === null) {
    return undefined;
  }
  const secret = open(call.services.installKey, "totp-secret v1", sealed, [challenge.identity_id, id]);
  return secret === undefined ? { id, unopened: sealed } : { id, secret };
}

/**
 * A secret that does not open is the server's fault, not the person's: a
 * value sealed under another install secret, or changed bytes. The attempt
 * gives its count back, nothing goes to Kontoaktivitet, and the error goes
 * to the report, with the secret's id and the key id that its sealed form
 * names, never the secret: the answer is 500.
 */
async function unopened(call: NoneCall, person: string, secret: { readonly id: string; readonly unopened: Buffer }): Promise<never> {
  await call.database.write({ channel: call.channel }, async (tx) => {
    await giveBackFailure(tx, person, "totp");
    return commit(undefined);
  });
  throw new Error(
    `The TOTP secret ${secret.id} does not open with the install secret of key id ${String(call.services.installKey.keyId)}. ` +
      `Its sealed form names key id ${String(secret.unopened[1])}. Its person cannot pass the TOTP step.`,
  );
}

/** A wrong code, which counted before its check: the tenth locks the step, and both go to Kontoaktivitet after the answer. */
async function wrongCode(call: NoneCall, challenge: ChallengeRow, counted: AttemptCounter, at: Date): Promise<Answer<never>> {
  const { database, channel } = call;
  const person = challenge.identity_id;
  const until = totpLockEnd(at);
  const events: AccountEvent[] = [{ kind: "sign-in", details: signInDetails(challenge.method, "totp", call.request, "failed") }];
  if (counted.failures === TOTP_CAP) {
    await database.write({ channel }, async (tx) => {
      await lockAttempts(tx, person, "totp", until);
      return commit(undefined);
    });
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
    // The identity's counter first, then the challenge: the right code's transaction locks them in the same order.
    const { before, after } = await countFailure(tx, challenge.identity_id, "totp", TOTP_WINDOW_MS, at);
    const wait = totpWait(before, at);
    if (wait !== undefined) {
      return rollBack({ wait });
    }
    const claim = await tx.query<{ attempt: number | null }>("SELECT access.claim_attempt($1, $2) AS attempt", [challenge.challenge_id, at]);
    // A SELECT of one function call gives one row: the attempt's number, or NULL when none was left.
    return (claim.rows as [{ readonly attempt: number | null }])[0].attempt === null ? rollBack(undefined) : commit({ claimed: challenge, counted: after });
  });
  if (found === undefined) {
    return refused(CODE_FAILED);
  }
  if ("wait" in found) {
    return tooManyAttempts(found.wait);
  }
  const { claimed: challenge, counted } = found;
  const secret = secretOf(challenge, call);
  if (secret !== undefined && "unopened" in secret) {
    return unopened(call, challenge.identity_id, secret);
  }
  const step = secret === undefined ? undefined : matchingStep(secret.secret, body.code, at);
  if (secret === undefined || step === undefined) {
    return wrongCode(call, challenge, counted, at);
  }
  const secretId = secret.id;
  const person = challenge.identity_id;
  const opened = await database.write(asPerson(person, channel), async (tx): Promise<Ending<Opened>> => {
    await giveBackFailure(tx, person, "totp");
    const used = await tx.query<{ used: boolean }>("SELECT access.use_challenge($1, $2) AS used", [challenge.challenge_id, at]);
    if (!(used.rows as [{ readonly used: boolean }])[0].used) {
      return rollBack("challenge-used");
    }
    const taken = await tx.query<{ taken: boolean }>("SELECT access.use_totp_step($1, $2, $3, $4) AS taken", [secretId, person, step, at]);
    if (!(taken.rows as [{ readonly taken: boolean }])[0].taken) {
      return rollBack("step-used");
    }
    const device = await deviceOf(tx, person, challenge.device_hash);
    const remembered = await tx.query<{ id: string | null }>("SELECT access.remember_device($1, $2, $3) AS id", [person, device.hash, at]);
    const session = await openSession(tx, person, challenge.method, (remembered.rows as [{ readonly id: string | null }])[0].id, at);
    if (session === undefined) {
      return rollBack("not-active");
    }
    await addAccountEvent(tx, person, { kind: "sign-in", details: signInDetails(challenge.method, "totp", request, "succeeded") });
    return commit(device.token === undefined ? { session } : { session, device: device.token });
  });
  if (opened === "step-used") {
    return wrongCode(call, challenge, counted, at);
  }
  if (typeof opened === "string") {
    // A right code that found no use: it was no wrong code, so it gives its count back.
    await database.write({ channel }, async (tx) => {
      await giveBackFailure(tx, person, "totp");
      return commit(undefined);
    });
    return refused(CODE_FAILED);
  }
  const effects: CookieEffect[] = [{ kind: "set-session", token: opened.session }];
  if (opened.device !== undefined) {
    effects.push({ kind: "set-device", token: opened.device });
  }
  return ok({}, effects);
});
