// SPDX-License-Identifier: AGPL-3.0-only

// completeSetup: the first identity of an empty install (open point 12),
// from the setup link that the install's command prints (setup.ts). The
// password is checked and hashed through the one wrapper first, so a
// password of fewer than 12 characters is a field problem at /password, and
// the link is left as it was. Then one transaction, as the new person, whose
// id the server picks: the database uses the link once, if it is live, and
// makes the identity with its password and its pending TOTP secret, sealed
// with the install key and bound to the identity and the secret's row. Two
// uses at once take the link's lock in turn, so one makes the identity. A
// link that is unknown, used, stopped by a newer one or past its 28 days
// gets one answer, 422 setup-link-invalid. An install that has an identity
// refuses, 422 install-not-empty.
//
// The answer gives the new TOTP secret, and sets no session: the person
// signs in next, with the password and the secret's first code, which makes
// it active.

import { randomUUID } from "node:crypto";
import { completeSetup } from "@nortfox/contract";
import { handleNone, invalidInput, ok, refused, type RuleRefusal } from "../../api/operation.ts";
import { seal } from "../../auth/secret-box.ts";
import { newTotpSecret, otpauthUri } from "../../auth/totp.ts";
import { tokenHash } from "../../auth/tokens.ts";
import { commit, rollBack } from "../../db/database.ts";
import { readMe } from "../users/identity.ts";
import { asPerson } from "./account-events.ts";

const SETUP_LINK_INVALID: RuleRefusal = {
  code: "setup-link-invalid",
  detail: "The setup link does not work: it is unknown, used, stopped by a newer link, or past its end.",
};

export const completeSetupHandler = handleNone(completeSetup, async ({ database, services, channel, now }, { params, body }) => {
  const password = await services.passwords.hash(body.password, "/password");
  if (!password.ok) {
    return invalidInput([password.issue]);
  }
  const at = now();
  const personId = randomUUID();
  const secretId = randomUUID();
  const secret = newTotpSecret();
  const sealed = seal(services.installKey, "totp-secret v1", secret, [personId, secretId]);
  const user = await database.write(asPerson(personId, channel), async (tx) => {
    const done = await tx.query<{ done: boolean }>("SELECT access.complete_setup($1, $2, $3, $4, $5, $6, $7, $8) AS done", [
      tokenHash(params.token),
      at,
      personId,
      body.name,
      body.email.normalize("NFC"),
      password.hash,
      secretId,
      sealed,
    ]);
    // A SELECT of one function call gives one row.
    return (done.rows as [{ readonly done: boolean }])[0].done ? commit((await readMe(tx, personId)).user) : rollBack(undefined);
  });
  if (user === undefined) {
    return refused(SETUP_LINK_INVALID);
  }
  return ok({ user, totpEnrolment: { otpauthUri: otpauthUri(secret, user.email) } });
});
