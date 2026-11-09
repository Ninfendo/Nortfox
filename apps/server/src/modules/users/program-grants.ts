// SPDX-License-Identifier: AGPL-3.0-only

// The members' programs (issue 12, "Roles, admin levels, programs and
// permissions" 3 to 8): a system administrator grants every program, and a
// program administrator only the programs they administer.
//
// - assignProgram, "Tilldela program": Full behörighet, or a list that
//   narrows it. A second grant of a held program gives it the new list and
//   keeps its time and its end; a grant that has ended is taken away and
//   granted again, with a new time and a new end.
// - removeProgram, "Ta bort program".
// - moveProgram, "Flytta program": the grant goes to another member, who
//   must not hold the program, narrowed first when a list says so. It keeps
//   its time and its end, so a move never restarts a Revisor grant's days.
//   The target's grant of the program that has ended is taken away first.
// - updateUserRights, "Anpassa Rapporter" and "Anpassa Register/Övrigt":
//   the member's Rapporter and Register/Övrigt rights, set in each grant in
//   reach whose program covers them; each grant keeps its program's own.
//
// A grant that has ended, a Revisor grant after its days by the server's
// clock, gives nothing, so it counts as none: no move takes it, a move or a
// new grant replaces it, and Anpassa neither counts it nor changes it.
// removeProgram still takes it away.
//
// The database holds every grant to its program's set and to the view rule
// (NF024, NF023). The server checks the same of a list first, so the
// refusal names the right's place in the list; the database stays the
// authority. Each change locks the members' rows first, in the order of
// their ids, so two changes of one member take turns.

import {
  CATALOGUE_GROUPS,
  CATALOGUE_PERMISSIONS,
  assignProgram,
  fullPermissions,
  grantHolds,
  moveProgram,
  programPermissions,
  removeProgram,
  updateUserRights,
  viewPermissionOf,
  type CataloguePermissionKey,
  type GroupKind,
  type Program,
} from "@nortfox/contract";
import { LEDGER_REFUSALS } from "../../api/ledger-refusals.ts";
import { handleData, invalidInput, ok, refused, type Answer, type RuleRefusal } from "../../api/operation.ts";
import { holdMember, holdMembers, reaches } from "../memberships/members.ts";
import { deleteGrant, grantOutput, grantsOf, insertGrant, moveGrant, readPrograms, setGrantRights, type HeldGrant } from "../memberships/programs.ts";
import { reachOf } from "./reach.ts";
import { userNotFound } from "./users.ts";

/** The refusal of a program that the program administrator does not administer. */
function notAdministered(program: Program): Answer<never> {
  return refused({ code: "program-not-administered", detail: "A program administrator grants only the programs they administer.", pointer: "/program", data: { program } });
}

/** The refusal of a program that the member does not hold. */
function notGranted(): Answer<never> {
  return refused({ code: "program-not-granted", detail: "The member holds no grant of the program.", pointer: "/program" });
}

/**
 * What the database would refuse of a list of rights for `program`, with the
 * right's place in the list: the first right that the program's set does
 * not hold, then the first action right whose group's view right the list
 * lacks, in the list's order, as the database checks them.
 */
function listProblem(program: Program, permissions: readonly CataloguePermissionKey[]): RuleRefusal | undefined {
  const set = programPermissions(program);
  for (const [index, permission] of permissions.entries()) {
    if (!set.includes(permission)) {
      return { code: "not-in-program", detail: LEDGER_REFUSALS.not_in_program.detail, pointer: `/permissions/${String(index)}`, data: { permission, program } };
    }
  }
  for (const [index, permission] of permissions.entries()) {
    const view = viewPermissionOf(permission);
    if (view !== null && !permissions.includes(view)) {
      return { code: "view-permission-missing", detail: LEDGER_REFUSALS.view_permission_missing.detail, pointer: `/permissions/${String(index)}`, data: { permission, view } };
    }
  }
  return undefined;
}

export const assignProgramHandler = handleData(assignProgram, async ({ context, tx, now }, { params, body }) => {
  const { program } = params;
  if (!reaches(reachOf(context.company), program)) {
    return notAdministered(program);
  }
  const member = await holdMember(tx, params.memberId);
  if (member === undefined) {
    return userNotFound();
  }
  // The contract takes full: true or a list, one of the two.
  const permissions = body.permissions ?? fullPermissions(program);
  const problem = listProblem(program, permissions);
  if (problem !== undefined) {
    return refused(problem);
  }
  const held = (await grantsOf(tx, member.id)).find((grant) => grant.program === program);
  if (held !== undefined && grantHolds(held, now())) {
    return ok(grantOutput(await setGrantRights(tx, held, permissions)));
  }
  if (held !== undefined) {
    await deleteGrant(tx, held);
  }
  return ok(grantOutput(await insertGrant(tx, member.companyId, member.id, program, permissions)));
});

export const removeProgramHandler = handleData(removeProgram, async ({ context, tx }, { params }) => {
  const { program } = params;
  if (!reaches(reachOf(context.company), program)) {
    return notAdministered(program);
  }
  const member = await holdMember(tx, params.memberId);
  if (member === undefined) {
    return userNotFound();
  }
  const held = (await grantsOf(tx, member.id)).find((grant) => grant.program === program);
  if (held === undefined) {
    return notGranted();
  }
  await deleteGrant(tx, held);
  return ok({});
});

export const moveProgramHandler = handleData(moveProgram, async ({ context, tx, now }, { params, body }) => {
  const { program } = params;
  if (!reaches(reachOf(context.company), program)) {
    return notAdministered(program);
  }
  const held = await holdMembers(tx, [params.memberId, body.targetMemberId]);
  const source = held.get(params.memberId);
  if (source === undefined) {
    return userNotFound();
  }
  const target = held.get(body.targetMemberId);
  if (target === undefined) {
    return userNotFound("targetMemberId");
  }
  const at = now();
  const grant: HeldGrant | undefined = (await grantsOf(tx, source.id)).find((each) => each.program === program && grantHolds(each, at));
  if (grant === undefined) {
    return notGranted();
  }
  const targetGrant = (await grantsOf(tx, target.id)).find((each) => each.program === program);
  if (targetGrant !== undefined && grantHolds(targetGrant, at)) {
    return refused({ code: "program-already-granted", detail: "The member that targetMemberId names holds the program already.", pointer: "/targetMemberId" });
  }
  const permissions = (body.permissions ?? grant.permissions) as readonly CataloguePermissionKey[];
  for (const [index, permission] of permissions.entries()) {
    if (!grant.permissions.includes(permission)) {
      return refused({
        code: "not-in-grant",
        detail: "The grant does not hold that right, so a move cannot give it.",
        pointer: `/permissions/${String(index)}`,
        data: { permission },
      });
    }
  }
  const problem = listProblem(program, permissions);
  if (problem !== undefined) {
    return refused(problem);
  }
  if (targetGrant !== undefined) {
    await deleteGrant(tx, targetGrant);
  }
  return ok(grantOutput(await moveGrant(tx, grant, target.id, permissions)));
});

/** The kind of each group, by its key. */
const GROUP_KIND: ReadonlyMap<string, GroupKind> = new Map(CATALOGUE_GROUPS.map((group) => [group.key, group.kind]));

/** The kind of each permission's group: a program's own, Rapporter or Register/Övrigt. */
const KIND: ReadonlyMap<string, GroupKind | undefined> = new Map(CATALOGUE_PERMISSIONS.map((permission) => [permission.key, GROUP_KIND.get(permission.group)]));

/** Whether a permission is a Rapporter or a Register/Övrigt right. */
function reportOrRegister(permission: string): boolean {
  return KIND.get(permission) !== "program";
}

/** The keys of `wanted`, once each, in the catalogue's order. */
function inOrder(wanted: ReadonlySet<string>): string[] {
  return CATALOGUE_PERMISSIONS.map((permission) => permission.key).filter((key) => wanted.has(key));
}

export const updateUserRightsHandler = handleData(updateUserRights, async ({ context, tx, now }, { params, body }) => {
  const { permissions } = body;
  const own = permissions.flatMap((permission, index) =>
    reportOrRegister(permission)
      ? []
      : [{ code: "invalid-value", detail: `The field /permissions/${String(index)} is not a Rapporter or Register/Övrigt right.`, pointer: `/permissions/${String(index)}`, data: {} }],
  );
  if (own.length > 0) {
    return invalidInput(own);
  }
  const member = await holdMember(tx, params.memberId);
  if (member === undefined) {
    return userNotFound();
  }
  const reach = reachOf(context.company);
  const at = now();
  const grants = (await grantsOf(tx, member.id)).filter((grant) => reaches(reach, grant.program) && grantHolds(grant, at));
  for (const [index, permission] of permissions.entries()) {
    if (!grants.some((grant) => programPermissions(grant.program).includes(permission))) {
      return refused({ code: "right-not-covered", detail: "No program that the member holds covers the right.", pointer: `/permissions/${String(index)}`, data: { permission } });
    }
  }
  for (const grant of grants) {
    const set = programPermissions(grant.program);
    const rights = inOrder(new Set([...grant.permissions.filter((permission) => !reportOrRegister(permission)), ...permissions.filter((permission) => set.includes(permission))]));
    if (rights.join() !== grant.permissions.join()) {
      await setGrantRights(tx, grant, rights);
    }
  }
  const programs = (await readPrograms(tx, member.id)).grants.filter((grant) => reaches(reach, grant.program));
  return ok({
    permissions: inOrder(new Set(programs.filter((grant) => grantHolds(grant, at)).flatMap((grant) => grant.permissions.filter(reportOrRegister)))),
    programs: programs.map(grantOutput),
  });
});
