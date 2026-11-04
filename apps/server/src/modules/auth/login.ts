// SPDX-License-Identifier: AGPL-3.0-only

// loginWithPassword: the first step of a password sign-in (issue 12,
// behaviours 2 and 4; docs/api.md, Signing in). In this order:
//
// 1. The identifier is written as the database finds it (identifier.ts),
//    and its login is looked up: the identity, its two-step choice and its
//    password's hash. The failures count under the identity's id, or, for an
//    identifier that names no identity, under the HMAC of the identifier.
// 2. An attempt that comes too soon after failures, or while the step is
//    locked, gets 429 too-many-attempts and the seconds to wait. Its password
//    is not checked.
// 3. The password is checked through the one wrapper: against the dummy hash
//    when there is no identity or no password, so the time tells nothing.
// 4. A failure of any kind counts once, and gets the one answer, 422
//    sign-in-failed. At 100 failures in the window the step is locked until
//    the window's hour has passed. A failure for an identity is written to
//    its Kontoaktivitet after the answer, and so is the lock, once.
// 5. A right password clears the count. With new_device_90_days, on a device
//    the person knows whose last TOTP step is less than 90 days old, it opens
//    a session at once: the session cookie, and a sign-in in Kontoaktivitet.
//    Otherwise it opens a login challenge for the TOTP step, bound to the
//    browser's device cookie if it has one, and gives the challenge.
//
// An identity that is deleted between the steps gets no challenge and no
// session: the database's functions make them only for an active identity.

import { loginWithPassword, type PasswordSignIn } from "@nortfox/contract";
import type { SignInMethod } from "../../api/context.ts";
import { handleNone, ok, refused, tooManyAttempts, type Answer } from "../../api/operation.ts";
import { newToken, tokenHash } from "../../auth/tokens.ts";
import { commit, rollBack, type Ending, type Queryable } from "../../db/database.ts";
import { addAccountEvent, addAfterAnswer, asPerson, signInDetails, type AccountEvent } from "./account-events.ts";
import { readIdentifier, unknownSubject } from "./identifier.ts";
import { PASSWORD_CAP, PASSWORD_WINDOW_MS, attemptCounter, clearAttempts, countFailure, lockAttempts, passwordLockEnd, passwordWait } from "./limits.ts";
import { CHALLENGE_LIFETIME_MS, PASSWORD_FAILED, deviceHashOf, knownDevice, openSession } from "./sign-in.ts";

/** An identity's login, as access.find_login gives it. */
interface Login {
  readonly identityId: string;
  readonly twoStep: "new_device_90_days" | "every_login";
  readonly passwordHash: string | undefined;
}

interface LoginRow {
  readonly identity_id: string;
  readonly two_step: Login["twoStep"];
  readonly password_hash: string | null;
}

/**
 * The login of an identifier, or undefined when it names none. A deleted
 * identity holds no e-mail address and no personnummer, so no identifier
 * finds it.
 */
async function findLogin(tx: Queryable, identifier: string): Promise<Login | undefined> {
  const found = await tx.query<LoginRow>("SELECT identity_id, two_step, password_hash FROM access.find_login($1)", [identifier]);
  const [row] = found.rows;
  return row === undefined ? undefined : { identityId: row.identity_id, twoStep: row.two_step, passwordHash: row.password_hash ?? undefined };
}

/** What a right password opened: a session's token, or a challenge; or nothing, for an identity no longer active. */
type Opened = { readonly session: string } | { readonly challenge: string } | undefined;

export const loginWithPasswordHandler = handleNone(loginWithPassword, async (call, { body }): Promise<Answer<PasswordSignIn>> => {
  const { database, services, channel, request, later } = call;
  const at = call.now();
  const identifier = readIdentifier(body.identifier, at);
  const method: SignInMethod = identifier.kind === "email" ? "password-email" : "password-personnummer";
  const { login, subject, counter } = await database.read({ channel }, async (tx) => {
    const found = await findLogin(tx, identifier.value);
    const counted = found === undefined ? unknownSubject(services.installKey, identifier) : found.identityId;
    return commit({ login: found, subject: counted, counter: await attemptCounter(tx, counted, "password") });
  });
  const wait = passwordWait(counter, at);
  if (wait !== undefined) {
    return tooManyAttempts(wait);
  }
  const right = await services.passwords.verify(body.password, login?.passwordHash);
  if (!right || login === undefined) {
    const after = await database.write({ channel }, async (tx) => {
      const failed = await countFailure(tx, subject, "password", PASSWORD_WINDOW_MS, at);
      if (failed.failures >= PASSWORD_CAP) {
        await lockAttempts(tx, subject, "password", passwordLockEnd(failed));
      }
      return commit(failed);
    });
    if (login !== undefined) {
      const events: AccountEvent[] = [{ kind: "sign-in", details: signInDetails(method, undefined, request, "failed") }];
      if (after.failures === PASSWORD_CAP) {
        events.push({ kind: "sign-in-locked", details: { step: "password", until: passwordLockEnd(after).toISOString() } });
      }
      addAfterAnswer(later, database, channel, login.identityId, events);
    }
    return refused(PASSWORD_FAILED);
  }
  const deviceHash = deviceHashOf(request.device);
  const opened = await database.write(asPerson(login.identityId, channel), async (tx): Promise<Ending<Opened>> => {
    await clearAttempts(tx, login.identityId, "password");
    const device = login.twoStep === "new_device_90_days" && deviceHash !== undefined ? await knownDevice(tx, login.identityId, deviceHash, at) : undefined;
    if (device !== undefined) {
      const session = await openSession(tx, login.identityId, method, device, at);
      if (session === undefined) {
        return rollBack(undefined);
      }
      await addAccountEvent(tx, login.identityId, { kind: "sign-in", details: signInDetails(method, "known-device", request, "succeeded") });
      return commit({ session });
    }
    const challenge = newToken("challenge");
    const made = await tx.query<{ id: string | null }>("SELECT access.open_challenge($1, $2, $3, $4, $5, $6) AS id", [
      tokenHash(challenge),
      login.identityId,
      method,
      deviceHash ?? null,
      at,
      new Date(at.getTime() + CHALLENGE_LIFETIME_MS),
    ]);
    // A SELECT of one function call gives one row: the challenge's id, or NULL.
    return (made.rows as [{ readonly id: string | null }])[0].id === null ? rollBack(undefined) : commit({ challenge });
  });
  if (opened === undefined) {
    return refused(PASSWORD_FAILED);
  }
  if ("session" in opened) {
    return ok({ outcome: "signed-in" }, [{ kind: "set-session", token: opened.session }]);
  }
  return ok({ outcome: "totp-required", challenge: opened.challenge });
});
