// SPDX-License-Identifier: AGPL-3.0-only

// leaveCompany, "Koppla bort användaren" (issue 12, "Users in a company" 6
// and 7): the person leaves a company where they are an active member, from
// the company list. The runner gives the person's active membership there
// from the one membership function, in the request's own transaction, or
// refuses with company-not-available; a repeat with the leave's key gives
// its first answer there, from the person's keys. The handler locks the membership's
// row and reads it after the lock, so a change that committed first, such as
// a removal or a disconnect, leaves nothing to leave. The company's last
// active system administrator cannot leave: the server refuses it first,
// with last-system-administrator, and the database at the commit. The
// membership stays, with the status left, as the person's own act in the
// behandlingshistorik; its sessions end, and its work contacts are erased.
// Only a new invitation lets the person back.

import { leaveCompany } from "@nortfox/contract";
import { companyNotAvailable, handlePerson, inputMembership, ok } from "../../api/operation.ts";
import { ADMINISTRATORS_TURN, hasOtherAdministrator, holdMember, lastAdministrator, leaveMember, takesAdministrator } from "./members.ts";

export const leaveCompanyHandler = handlePerson(leaveCompany, async ({ tx, company }) => {
  const membership = inputMembership(company);
  const member = await holdMember(tx, membership.membershipId);
  if (member?.status !== "active" || member.userId !== membership.personId) {
    return companyNotAvailable(leaveCompany);
  }
  if (takesAdministrator(member, { status: "left", adminLevel: member.adminLevel }) && !(await hasOtherAdministrator(tx, member))) {
    return lastAdministrator(member);
  }
  await leaveMember(tx, member);
  return ok({});
}, { turn: () => ADMINISTRATORS_TURN.shared });
