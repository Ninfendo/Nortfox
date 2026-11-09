// SPDX-License-Identifier: AGPL-3.0-only

// The company's users (issue 12, "Users in a company" 4, 5, 7 and 8; "Roles,
// admin levels, programs and permissions" 2 and 3): listUsers and getUser
// for a system administrator and a program administrator, who sees only the
// programs they administer; updateUser and removeUser for a system
// administrator. Each works in the request's company, by row level
// security, and reaches its invited, active and inactive members.
//
// - updateUser: "Aktiv användare" (a deactivation keeps the member's rights,
//   and the database ends their sessions), the system administrator's level
//   (admin, or none; only creating a company gives the owner's level, which
//   admin keeps), the programs administered, the idle logout (the five
//   values; a lower one holds at once for the member's sessions, by the
//   database) and the work contacts. A system administrator's own raise of
//   their idle logout holds for the request's session from its next request,
//   as updateMyMembership's does.
// - removeUser: "Ta bort användaren", never yourself. The row stays, with
//   the status removed; its sessions end and its work contacts are erased.
// - A removal, a deactivation or a demotion of the company's last active
//   system administrator is refused, by the server first and by the
//   database at the commit, with the same answer (last-system-administrator).
//
// The answers hold the work contacts and the person's name, so the keys of
// updateUser are kept outside every company table.

import { getUser, listUsers, removeUser, updateUser } from "@nortfox/contract";
import { handleData, handleList, ok, refused, type Answer } from "../../api/operation.ts";
import { seeSession } from "../../auth/resolver.ts";
import { setWorkContacts } from "../memberships/membership.ts";
import { hasOtherAdministrator, heldMemberNow, holdMember, lastAdministrator, memberPage, readMember, removeMember, takesAdministrator, writeMember } from "../memberships/members.ts";
import { setAdministered } from "../memberships/programs.ts";
import { reachOf } from "./reach.ts";

/** The refusal of a member that the company does not have: the same for one of another company, a removed or a left one, and an id that is not there. */
export function userNotFound(field = "memberId"): Answer<never> {
  return refused({
    code: "user-not-found",
    detail: `The company has no invited, active or inactive member with the id that ${field} names.`,
    pointer: `/${field}`,
  });
}

export const listUsersHandler = handleList(listUsers, async ({ context, tx, now, page }) => ok(await memberPage(tx, page, now(), await reachOf(tx, context.company))));

export const getUserHandler = handleData(getUser, async ({ context, tx, now }, { params }) => {
  const member = await readMember(tx, params.memberId, now(), await reachOf(tx, context.company));
  return member === undefined ? userNotFound() : ok(member);
});

export const updateUserHandler = handleData(updateUser, async ({ context, tx, now }, { params, body }) => {
  const member = await holdMember(tx, params.memberId);
  if (member === undefined) {
    return userNotFound();
  }
  if (body.active !== undefined && member.status === "invited") {
    return refused({ code: "user-invited", detail: "The member has not accepted the invitation yet, so Aktiv användare cannot be set.", pointer: "/active" });
  }
  const status = body.active === undefined ? member.status : body.active ? "active" : "inactive";
  // admin keeps the level of a system administrator, the owner's too.
  const adminLevel = body.adminLevel === undefined ? member.adminLevel : body.adminLevel === null ? null : (member.adminLevel ?? body.adminLevel);
  if (takesAdministrator(member, { status, adminLevel }) && !(await hasOtherAdministrator(tx, member))) {
    return lastAdministrator(member);
  }
  const idleTimeoutMinutes = body.idleTimeout ?? member.idleTimeoutMinutes;
  await writeMember(tx, member, { status, adminLevel, idleTimeoutMinutes });
  if (body.programsAdministered !== undefined) {
    await setAdministered(
      tx,
      member.companyId,
      member.id,
      body.programsAdministered.map((administered) => administered.program),
    );
  }
  await setWorkContacts(tx, member.companyId, member.id, body);
  const at = now();
  if (body.idleTimeout !== undefined && member.id === context.company.membershipId) {
    await seeSession(tx, context.credential.sessionId, at, idleTimeoutMinutes, member.id);
  }
  // updateUser needs users:admin, which only a system administrator holds: they see every program.
  return ok(await heldMemberNow(tx, member, at));
});

export const removeUserHandler = handleData(removeUser, async ({ context, tx }, { params }) => {
  const member = await holdMember(tx, params.memberId);
  if (member === undefined) {
    return userNotFound();
  }
  if (member.id === context.company.membershipId) {
    return refused({ code: "cannot-remove-yourself", detail: "A system administrator cannot remove themselves.", pointer: "/memberId" });
  }
  if (takesAdministrator(member, { status: "removed", adminLevel: member.adminLevel }) && !(await hasOtherAdministrator(tx, member))) {
    return lastAdministrator(member);
  }
  await removeMember(tx, member);
  return ok({});
});
