// SPDX-License-Identifier: AGPL-3.0-only

// The invited person's side of an invitation (issue 12, "Users in a company"
// 2 and 3; open point 5; choice 28): its link, which works once, for 14 days,
// and stops when a newer invitation of the member comes or the member is
// removed. Both operations run before there is an actor, and serve the
// browser's sign-in.
//
// - getInvitation reads the live link by its token's hash, in a transaction
//   with only the channel set: the name and the address it was sent to, the
//   company's and the sender's names, and its end.
// - acceptInvitation: the link is the credential. One transaction, as the
//   person who accepts: the signed-in person, "Koppla ihop med befintligt
//   NortFox ID", which needs a session; or a new identity, "Skapa ett nytt
//   NortFox ID", whose id the server picks, with the name, the invitation's
//   address, the password and a pending TOTP secret, sealed with the install
//   key and bound to the identity and the secret's row. The transaction
//   reads the live link (resolve.ts), enters the link's company with it,
//   and locks the member's row first, as every change of a member does, so
//   a new invitation or a removal of the member either came first or waits.
//   It finds the member still invited. Then the database uses the link once,
//   with the new identity, and finds it stopped when a newer invitation or
//   a removal came first; the invitation is accepted, the membership active
//   with the person, and the member's work e-mail the invitation's address.
//   So of two acceptances of one link at once, the second waits for the
//   first's lock and finds the member accepted. A link that is unknown, used, stopped or past its end
//   gets one answer, 422 invitation-link-invalid, and a refusal changes
//   nothing. An address that another identity has (email-taken) is the
//   identities' unique key, the only check of a new identity's address,
//   since the app reads no other identity. A person's second live
//   membership in the company (already-member), which only a race can get
//   past the server's check, is the memberships' unique key. The runner
//   answers both as rules.
//
// The answer gives the person and the membership, and for a new identity
// its TOTP secret, which no answer gives again. It sets no session: a new
// identity signs in next, with the password and the secret's first code,
// which makes it active, as after completeSetup.

import { randomUUID } from "node:crypto";
import { acceptInvitation, getInvitation, type User } from "@nortfox/contract";
import { handleNone, invalidInput, ok, refused, type Answer, type RuleRefusal } from "../../api/operation.ts";
import { seal } from "../../auth/secret-box.ts";
import { newTotpSecret, otpauthUri } from "../../auth/totp.ts";
import { tokenHash } from "../../auth/tokens.ts";
import { commit, rollBack, type Ending, type PersonQueryable } from "../../db/database.ts";
import { asPerson } from "../auth/account-events.ts";
import { readMe } from "../users/identity.ts";
import { readMembership, setWorkContacts } from "./membership.ts";
import { invitationEntry } from "./resolve.ts";
import type { Membership } from "@nortfox/contract";

const LINK_INVALID: RuleRefusal = {
  code: "invitation-link-invalid",
  detail: "The invitation's link does not work: it is unknown, used, stopped by a newer invitation, or past its end.",
};

const SIGN_IN_REQUIRED: RuleRefusal = {
  code: "sign-in-required",
  detail: "Koppla ihop med befintligt NortFox ID needs a signed-in session. Sign in first, or create a new NortFox ID with newIdentity.",
};

const ALREADY_MEMBER: RuleRefusal = { code: "already-member", detail: "The person is a member of the company already." };

interface LinkRow {
  readonly name: string;
  readonly email: string;
  readonly company_name: string;
  readonly inviter_name: string;
  readonly expires_at: Date;
}

export const getInvitationHandler = handleNone(getInvitation, async ({ database, channel, now }, { params }) => {
  const link = await database.read({ channel }, async (tx) => {
    const found = await tx.query<LinkRow>("SELECT name, email, company_name, inviter_name, expires_at FROM access.invitation_by_token($1, $2)", [tokenHash(params.token), now()]);
    return commit(found.rows[0]);
  });
  if (link === undefined) {
    return refused(LINK_INVALID);
  }
  return ok({ name: link.name, email: link.email, expiresAt: link.expires_at.toISOString(), companyName: link.company_name, inviterName: link.inviter_name });
});

/** The person and the membership of an accepted invitation. */
interface Accepted {
  readonly user: User;
  readonly membership: Membership;
}

/** How the database uses the link, once, in the transaction that entered its company: with the person, or with a new identity. */
type UseLink = (tx: PersonQueryable) => Promise<boolean>;

/**
 * Accepts the invitation of the live link `linkHash` at `at`, as the
 * transaction's person, `personId`, when `useLink` uses it; with `linking`,
 * an identity that may be a member of the company already. Rolls back with
 * the refusal when it cannot.
 */
async function accept(tx: PersonQueryable, linkHash: Buffer, at: Date, personId: string, linking: boolean, useLink: UseLink): Promise<Ending<Answer<Accepted>>> {
  const entry = await invitationEntry(tx, linkHash, at);
  if (entry === undefined) {
    return rollBack(refused(LINK_INVALID));
  }
  await tx.enter(entry);
  const invitation = await tx.query<{ membership_id: string }>("SELECT membership_id FROM access.invitations WHERE id = $1", [entry.invitationId]);
  // The live link's invitation is in its company, which the transaction entered.
  const [{ membership_id: membershipId }] = invitation.rows as [{ readonly membership_id: string }];
  const member = await tx.query("SELECT 1 FROM access.memberships WHERE id = $1 AND status = 'invited' FOR NO KEY UPDATE", [membershipId]);
  if (member.rows.length === 0) {
    return rollBack(refused(LINK_INVALID));
  }
  if (linking && (await tx.query("SELECT 1 FROM access.memberships WHERE live_user_id = $1", [personId])).rows.length > 0) {
    return rollBack(refused(ALREADY_MEMBER));
  }
  if (!(await useLink(tx))) {
    return rollBack(refused(LINK_INVALID));
  }
  await tx.query("UPDATE access.invitations SET accepted_at = $2 WHERE id = $1", [entry.invitationId, at]);
  await tx.query("UPDATE access.memberships SET status = 'active', user_id = $2 WHERE id = $1", [membershipId, personId]);
  await setWorkContacts(tx, entry.companyId, membershipId, { workEmail: entry.email });
  const me = await readMe(tx, personId);
  return commit(ok({ user: me.user, membership: await readMembership(tx, membershipId, at) }));
}

export const acceptInvitationHandler = handleNone(acceptInvitation, async ({ principal, database, services, channel, now }, { params, body }) => {
  const linkHash = tokenHash(params.token);
  const identity = body.newIdentity;
  if (identity === undefined) {
    if (principal === undefined) {
      return refused(SIGN_IN_REQUIRED);
    }
    const at = now();
    const settings = { actorId: principal.personId, actorKind: principal.actorKind, channel };
    const useLink: UseLink = async (tx) => {
      const used = await tx.query<{ used: boolean }>("SELECT access.use_invitation_link($1, $2) AS used", [linkHash, at]);
      // A SELECT of one function call gives one row.
      return (used.rows as [{ readonly used: boolean }])[0].used;
    };
    return database.person("write", settings, (tx) => accept(tx, linkHash, at, principal.personId, true, useLink));
  }
  const password = await services.passwords.hash(identity.password, "/newIdentity/password");
  if (!password.ok) {
    return invalidInput([password.issue]);
  }
  const at = now();
  const personId = randomUUID();
  const secretId = randomUUID();
  const secret = newTotpSecret();
  const sealed = seal(services.installKey, "totp-secret v1", secret, [personId, secretId]);
  const useLink: UseLink = async (tx) => {
    const made = await tx.query<{ made: boolean }>("SELECT access.accept_invitation_as_new($1, $2, $3, $4, $5, $6) AS made", [
      linkHash,
      at,
      identity.name,
      password.hash,
      secretId,
      sealed,
    ]);
    // A SELECT of one function call gives one row.
    return (made.rows as [{ readonly made: boolean }])[0].made;
  };
  const answer = await database.person("write", asPerson(personId, channel), (tx) => accept(tx, linkHash, at, personId, false, useLink));
  return answer.ok ? ok({ ...answer.output, totpEnrolment: { otpauthUri: otpauthUri(secret, answer.output.user.email) } }) : answer;
});
