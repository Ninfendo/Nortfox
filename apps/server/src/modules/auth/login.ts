// SPDX-License-Identifier: AGPL-3.0-only

// loginWithPassword: the first step of a password sign-in (issue 12,
// behaviours 2 and 4; docs/api.md, Signing in). In this order:
//
// 1. The identifier is written as the database finds it (identifier.ts),
//    and its login is looked up: the identity, its two-step choice and its
//    password's hash. The failures count under the identity's id, or, for an
//    identifier that names no identity, under the HMAC of the form that the
//    database matches on. One statement gives the login and the form for
//    every identifier, and the HMAC is taken every time, so a known and an
//    unknown identifier do the same work before the answer.
// 2. The attempt is counted as a failure before its password is checked, in
//    the same transaction, under the counter's row lock (limits.ts). An
//    attempt that comes too soon after failures, or while the step is locked,
//    rolls its count back and gets 429 too-many-attempts and the seconds to
//    wait. Its password is not checked. So attempts sent at once come one
//    after another, and a burst gets no more checked than one attempt after
//    another would.
// 3. The password is checked through the one wrapper: against the dummy hash
//    when there is no identity or no password, so the time tells nothing. A
//    password the wrapper could not check, such as when it is busy, gives its
//    count back.
// 4. A failure of any kind has counted once, and gets the one answer, 422
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
import { handleNone, ok, refused, tooManyAttempts, type Answer, type NoneCall } from "../../api/operation.ts";
import { newToken, tokenHash } from "../../auth/tokens.ts";
import { commit, rollBack, type Ending, type Queryable } from "../../db/database.ts";
import { addAccountEvent, addAfterAnswer, asPerson, signInDetails, type AccountEvent } from "./account-events.ts";
import { readIdentifier, unknownSubject } from "./identifier.ts";
import { PASSWORD_CAP, PASSWORD_WINDOW_MS, clearAttempts, countFailure, giveBackFailure, lockAttempts, passwordLockEnd, passwordWait, type AttemptCounter } from "./limits.ts";
import { CHALLENGE_LIFETIME_MS, PASSWORD_FAILED, deviceHashOf, knownDevice, openSession } from "./sign-in.ts";

/** An identity's login, as access.find_login gives it. */
interface Login {
  readonly identityId: string;
  readonly twoStep: "new_device_90_days" | "every_login";
  readonly passwordHash: string | undefined;
}

/** The one row of the lookup: the login's columns, all NULL when the identifier names no identity, and always the form. */
type LoginRow = { readonly form: string } & (
  | { readonly identity_id: string; readonly two_step: Login["twoStep"]; readonly password_hash: string | null }
  | { readonly identity_id: null; readonly two_step: null; readonly password_hash: null }
);

/** What the lookup found: the login, or undefined when the identifier names none, and the form that the database matches on. */
interface Found {
  readonly login: Login | undefined;
  readonly form: string;
}

/**
 * The login of an identifier and its form, in one statement that gives one
 * row for every identifier, so a known and an unknown one cost the same. A
 * deleted identity holds no e-mail address and no personnummer, so no
 * identifier finds it.
 */
async function findLogin(tx: Queryable, identifier: string): Promise<Found> {
  const found = await tx.query<LoginRow>(
    "SELECT f.identity_id, f.two_step, f.password_hash, access.identifier_form($1) AS form FROM (SELECT) AS one LEFT JOIN access.find_login($1) AS f ON true",
    [identifier],
  );
  // The left join gives one row, whether find_login finds the identity or not.
  const [row] = found.rows as [LoginRow];
  const login = row.identity_id === null ? undefined : { identityId: row.identity_id, twoStep: row.two_step, passwordHash: row.password_hash ?? undefined };
  return { login, form: row.form };
}

/** What a right password opened: a session's token, or a challenge; or nothing, for an identity no longer active. */
type Opened = { readonly session: string } | { readonly challenge: string } | undefined;

/** The attempt, counted and free to run, or the seconds it must wait. */
type Claim = { readonly login: Login | undefined; readonly subject: string; readonly counted: AttemptCounter } | { readonly wait: number };

/** Checks the password. When the wrapper cannot check it, the attempt gives its count back, and the error goes on. */
async function checkPassword(call: NoneCall, password: string, login: Login | undefined, subject: string): Promise<boolean> {
  try {
    return await call.services.passwords.verify(password, login?.passwordHash);
  } catch (error) {
    await call.database.write({ channel: call.channel }, async (tx) => {
      await giveBackFailure(tx, subject, "password");
      return commit(undefined);
    });
    throw error;
  }
}

export const loginWithPasswordHandler = handleNone(loginWithPassword, async (call, { body }): Promise<Answer<PasswordSignIn>> => {
  const { database, services, channel, request, later } = call;
  const at = call.now();
  const identifier = readIdentifier(body.identifier, at);
  const method: SignInMethod = identifier.kind === "email" ? "password-email" : "password-personnummer";
  const claim = await database.write({ channel }, async (tx): Promise<Ending<Claim>> => {
    const { login, form } = await findLogin(tx, identifier.value);
    // The HMAC is taken for a known identity too, so both cost the same.
    const unknown = unknownSubject(services.installKey, form);
    const subject = login === undefined ? unknown : login.identityId;
    const { before, after } = await countFailure(tx, subject, "password", PASSWORD_WINDOW_MS, at);
    const wait = passwordWait(before, at);
    return wait === undefined ? commit({ login, subject, counted: after }) : rollBack({ wait });
  });
  if ("wait" in claim) {
    return tooManyAttempts(claim.wait);
  }
  const { login, subject, counted } = claim;
  const right = await checkPassword(call, body.password, login, subject);
  if (!right || login === undefined) {
    // The failure counted before the check. The one that reached the cap locks the step.
    if (counted.failures === PASSWORD_CAP) {
      await database.write({ channel }, async (tx) => {
        await lockAttempts(tx, subject, "password", passwordLockEnd(counted));
        return commit(undefined);
      });
    }
    if (login !== undefined) {
      const events: AccountEvent[] = [{ kind: "sign-in", details: signInDetails(method, undefined, request, "failed") }];
      if (counted.failures === PASSWORD_CAP) {
        events.push({ kind: "sign-in-locked", details: { step: "password", until: passwordLockEnd(counted).toISOString() } });
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
