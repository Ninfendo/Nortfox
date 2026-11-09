// SPDX-License-Identifier: AGPL-3.0-only

// The invitations a system administrator sends (issue 12, "Users in a
// company" 1 and 2; The login identity 12), each by mail, inside the
// request, before it commits: a mail that the mail server refuses throws, so
// nothing changes, and the request answers 500.
//
// - inviteUser, "Lägg till användare": an invited member with the name, and
//   an invitation to the address. An address that a member of the company
//   has, or that an open invitation of it goes to, is refused (already-member).
//   It takes the company's turn of its invitations first, so two invitations
//   of one company take turns, and the second of two to one address at once
//   finds the first's and is refused too. The turn is not the company's row,
//   so no other change of the company waits for the mail.
// - resendInvitation, "Skicka en ny inbjudan": a new invitation of an
//   invited member, to their latest one's name and address. The database
//   stops the old one and its link.
// - disconnectUserIdentity: the member's identity no longer reaches the
//   company, and a new invitation goes to the person's name and the member's
//   work e-mail, which a new or an existing identity may accept. The member
//   keeps the admin level and the programs, and the company its last active
//   system administrator: the check takes the administrators' turn alone, so
//   a change that takes another one away commits first or waits for the
//   disconnect, and the one of the two that loses sends no mail.
//
// With no mail set up for the install, each is refused first, with 422
// mail-not-configured, before it reads or changes anything: the setting is
// the install's, so the answer tells nothing about anyone. The answers of
// inviteUser and disconnectUserIdentity hold the member's name, so their
// keys are kept outside every company table.

import { disconnectUserIdentity, inviteUser, resendInvitation } from "@nortfox/contract";
import { handleData, ok, refused, type RuleRefusal } from "../../api/operation.ts";
import type { Queryable } from "../../db/database.ts";
import { MAIL_NOT_CONFIGURED, type InstallMail } from "../../mail/mailer.ts";
import { invitationLink, invitationMail } from "../../mail/texts.ts";
import { addInvitation, addInvitedMember, addressInCompany, latestInvitation, takeInvitationsTurn, type InvitationTo } from "../memberships/invitations.ts";
import { disconnectMember, hasOtherAdministrator, heldMemberNow, holdMember, lastAdministrator, takesAdministrator } from "../memberships/members.ts";
import { userNotFound } from "./users.ts";

const ALREADY_MEMBER: RuleRefusal = {
  code: "already-member",
  detail: "A member of the company, or an open invitation of it, has this e-mail address already.",
  pointer: "/email",
};

const NOT_INVITED: RuleRefusal = {
  code: "user-not-invited",
  detail: "The member is not invited, so there is no invitation to send again.",
  pointer: "/memberId",
};

const NO_IDENTITY: RuleRefusal = {
  code: "user-invited",
  detail: "The member has not accepted the invitation yet, so no identity is connected.",
  pointer: "/memberId",
};

/** Invites a held invited member of the company to `to` at `at`, and sends the invitation's mail. */
async function sendInvitation(tx: Queryable, mail: InstallMail, companyId: string, membershipId: string, to: InvitationTo, at: Date): Promise<void> {
  const link = await addInvitation(tx, companyId, membershipId, to, at);
  await mail.mailer.send(
    invitationMail({ to: to.email, name: to.name, companyName: link.companyName, inviterName: link.inviterName, link: invitationLink(mail.publicOrigin, link.token) }),
  );
}

export const inviteUserHandler = handleData(inviteUser, async ({ context, tx, now, services }, { body }) => {
  const { mail } = services;
  if (mail === undefined) {
    return refused(MAIL_NOT_CONFIGURED);
  }
  const email = body.email.normalize("NFC");
  // The company's invitations take turns: a second one to the same address waits, and then finds the first.
  await takeInvitationsTurn(tx);
  if (await addressInCompany(tx, email)) {
    return refused(ALREADY_MEMBER);
  }
  const { companyId } = context.company;
  const id = await addInvitedMember(tx, companyId);
  const at = now();
  await sendInvitation(tx, mail, companyId, id, { name: body.name, email }, at);
  return ok(await heldMemberNow(tx, { id }, at));
});

export const resendInvitationHandler = handleData(resendInvitation, async ({ context, tx, now, services }, { params }) => {
  const { mail } = services;
  if (mail === undefined) {
    return refused(MAIL_NOT_CONFIGURED);
  }
  const member = await holdMember(tx, params.memberId);
  if (member === undefined) {
    return userNotFound();
  }
  const latest = member.status === "invited" ? await latestInvitation(tx, member.id) : undefined;
  if (latest === undefined) {
    return refused(NOT_INVITED);
  }
  await sendInvitation(tx, mail, context.company.companyId, member.id, latest, now());
  return ok({});
});

export const disconnectUserIdentityHandler = handleData(disconnectUserIdentity, async ({ context, tx, now, services }, { params }) => {
  const { mail } = services;
  if (mail === undefined) {
    return refused(MAIL_NOT_CONFIGURED);
  }
  const member = await holdMember(tx, params.memberId);
  if (member === undefined) {
    return userNotFound();
  }
  if (member.status === "invited") {
    return refused(NO_IDENTITY);
  }
  // The disconnect sends its mail before its commit, so it takes the administrators' turn alone: its check reads every competing change settled.
  if (takesAdministrator(member, { status: "invited", adminLevel: member.adminLevel }) && !(await hasOtherAdministrator(tx, member, "alone"))) {
    return lastAdministrator(member);
  }
  const to = await disconnectMember(tx, member);
  const at = now();
  await sendInvitation(tx, mail, context.company.companyId, member.id, to, at);
  return ok(await heldMemberNow(tx, member, at));
});
