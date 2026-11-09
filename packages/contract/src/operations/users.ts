// SPDX-License-Identifier: AGPL-3.0-only

// The company's users and their programs (issue 12, "Users in a company" and
// "Roles, admin levels, programs and permissions"). A user here is a member
// of the request's company: a membership, which an invited member has too
// before any person accepts it. So the paths name a member by the
// membership's id, memberId, which is Membership.id; Membership.userId is
// the person's. The operations reach the company's invited, active and
// inactive members: a removed or a left member's row stays, but no
// operation here finds it.
//
// A system administrator runs the users and their programs. A program
// administrator reads the users and grants the programs they administer,
// and sees only those programs. "Tilldela program" preselects "Full
// behörighet"; a list of permissions narrows it. The database holds each
// grant to its program's set and to the view rule.

import { z } from "zod";
import { personal } from "../fields.ts";
import { NoBody, defineListOperation, defineOperation } from "../operation.ts";
import { emailAddress } from "../address.ts";
import { noNul, singleLine, wellFormed } from "../text.ts";
import { IdleTimeout, Membership, ProgramAdmin, ProgramGrant, WorkEmail, WorkPhone } from "./companies.ts";
import { PermissionKey } from "./permissions.ts";
import { CATALOGUE_GROUPS, CATALOGUE_PERMISSIONS, PROGRAMS, type CataloguePermissionKey } from "../access/catalogue.ts";

const { id, companyId, userId, ...membership } = Membership.shape;

/** Användare: a member of the company, with the person's name. */
export const Member = z
  .strictObject({
    id,
    companyId,
    userId,
    name: personal(
      z.string().meta({ description: "The person's name; for an invited member, the name the latest invitation was sent to. Absent for an invited member with no invitation." }),
    ).optional(),
    ...membership,
  })
  .meta({
    id: "Member",
    description:
      "Användare: a member of the company, by the membership's id, with the person's name, the status, the system administrator's level, the idle logout, the work contacts, the roles, the program grants and the programs administered. " +
      "A program administrator sees only the grants and the administration of the programs they administer, and the roles those give.",
  });

export type Member = z.infer<typeof Member>;

/** A member's Rapporter and Register/Övrigt rights, and the grants that hold them. */
export const UserRights = z
  .strictObject({
    permissions: z.array(z.string()).meta({ description: "The member's Rapporter and Register/Övrigt rights, as the grants hold them now, in the catalogue's order." }),
    programs: z.array(ProgramGrant).meta({ description: "The member's grants as they are now, in the catalogue's order." }),
  })
  .meta({ id: "UserRights", description: "A member's Rapporter and Register/Övrigt rights, and the program grants that hold them." });

export type UserRights = z.infer<typeof UserRights>;

/** The member a path names. */
const MemberId = z.uuid().meta({ description: "The member's id: the membership's id, Membership.id." });

/** A program as a path names it. */
const ProgramParameter = z.enum(PROGRAMS).meta({ description: "The program: bookkeeping, approval-read, read or auditor." });

/** The rights of a grant as a change gives them: each a permission of the catalogue, at most once each. */
const GrantPermissions = z
  .array(PermissionKey)
  .max(64)
  .meta({ description: "The rights the grant holds: the program's own, its Rapporter and its Register/Övrigt rights, as the catalogue's keys." });

/** The kind of each group of the catalogue, by its key. */
const GROUP_KIND = new Map(CATALOGUE_GROUPS.map((group) => [group.key, group.kind]));

/** The keys of the catalogue's Rapporter and Register/Övrigt rights, in its order. */
const RIGHT_KEYS = CATALOGUE_PERMISSIONS.filter((permission) => GROUP_KIND.get(permission.group) !== "program").map((permission) => permission.key);

/** Anpassa Rapporter and Anpassa Register/Övrigt: a right that stands alone, by its key, such as reports.vat (Momsrapport). */
export const RightKey = z.enum(RIGHT_KEYS as [CataloguePermissionKey, ...CataloguePermissionKey[]]).meta({
  id: "RightKey",
  description:
    "A Rapporter or Register/Övrigt right of the catalogue, by its key, such as reports.vat (Momsrapport) or register.sie-export (Sie-export). A right of a program's own group, such as vouchers.view, is not one.",
});

/** The paths of one member, and of one of a member's programs. */
const MemberPath = z.strictObject({ memberId: MemberId });
const ProgramPath = z.strictObject({ memberId: MemberId, program: ProgramParameter });

export const listUsers = defineListOperation({
  id: "listUsers",
  method: "get",
  path: "/v1/users",
  tags: ["users"],
  summary: "List the users",
  description:
    "Lists the company's invited, active and inactive members, in the order they were added, each with the person's name, the status, the admin level, the idle logout, the work contacts and the programs. " +
    "A program administrator sees only the programs they administer.",
  item: Member,
  permission: "users:read",
  tool: "Lists the users of the company you work in, with their status, admin level and programs. A program administrator sees only the programs they administer.",
});

export const getUser = defineOperation({
  id: "getUser",
  method: "get",
  path: "/v1/users/{memberId}",
  tags: ["users"],
  summary: "Read a user",
  description:
    "Gives one invited, active or inactive member of the company, as listUsers gives it. Any other id, also one of a removed or a left member, gets 422 user-not-found.",
  params: MemberPath,
  output: Member,
  permission: "users:read",
  tool: "Gives one user of the company you work in, by the member's id.",
  writes: false,
});

export const updateUser = defineOperation({
  id: "updateUser",
  method: "patch",
  path: "/v1/users/{memberId}",
  tags: ["users"],
  summary: "Change a user",
  description:
    "Changes a member of the company: Aktiv användare, the system administrator's level, the programs the member administers, the idle logout and the work contacts. " +
    "A field left out stays as it is. adminLevel admin makes the member a system administrator, and null makes them no longer one; only creating a company gives the owner's level, which admin keeps. " +
    "The work e-mail address is required, so null is refused for it. The company always keeps an active system administrator.",
  params: MemberPath,
  body: z.strictObject({
    active: z.boolean().optional().meta({ description: "Aktiv användare: true lets the member work in the company, false stops it, and keeps their rights. An invited member has not accepted yet, and takes neither." }),
    // An enum, not a literal, so the API description takes null too.
    adminLevel: z
      .enum(["admin"])
      .nullable()
      .optional()
      .meta({ description: "admin makes the member a system administrator, or keeps the level of one; null makes them no longer one. Only creating a company gives the owner's level." }),
    programsAdministered: z.array(ProgramAdmin).max(4).optional().meta({ description: "Every program the member administers, Programadministratör: the list replaces the one there was." }),
    idleTimeout: IdleTimeout.optional(),
    workEmail: WorkEmail.optional(),
    workPhone: WorkPhone.optional(),
  }),
  output: Member,
  permission: "users:admin",
  tool: "Changes a user of the company you work in: whether they are active, their system administrator's level, the programs they administer, their idle logout and their work contacts.",
  writes: true,
});

export const removeUser = defineOperation({
  id: "removeUser",
  method: "delete",
  path: "/v1/users/{memberId}",
  tags: ["users"],
  summary: "Remove a user",
  description:
    "Ta bort användaren: removes a member of the company, never yourself. The membership stays, with the status removed, and its sessions end. " +
    "The member's work contacts are erased. The company always keeps an active system administrator.",
  params: MemberPath,
  output: NoBody,
  status: 204,
  permission: "users:admin",
  tool: "Removes a user from the company you work in. You cannot remove yourself.",
  writes: true,
});

export const assignProgram = defineOperation({
  id: "assignProgram",
  method: "put",
  path: "/v1/users/{memberId}/programs/{program}",
  tags: ["users"],
  summary: "Grant a program",
  description:
    "Tilldela program: grants the program to a member, with Full behörighet (full: true), or with a list of its rights. " +
    "For a member who holds the program, the list replaces the grant's, which keeps its time and its end; a grant that has ended is granted again. " +
    "A program administrator grants only the programs they administer.",
  params: ProgramPath,
  body: z
    .strictObject({
      full: z.literal(true).optional().meta({ description: "Full behörighet: every right of the program's Full behörighet." }),
      permissions: GrantPermissions.optional(),
    })
    .check((check) => {
      const { full, permissions } = check.value;
      if (full === undefined && permissions === undefined) {
        check.issues.push({
          code: "custom",
          input: check.value,
          path: ["full"],
          message: "is missing: give full: true for Full behörighet, or a list of permissions.",
          params: { code: "missing-field", data: {} },
        });
      }
      if (full !== undefined && permissions !== undefined) {
        check.issues.push({
          code: "custom",
          input: check.value,
          path: ["permissions"],
          message: "cannot come with full: true. Give one of the two.",
          params: { code: "invalid-value", data: {} },
        });
      }
    }),
  output: ProgramGrant,
  permission: "programs:grant",
  tool: "Grants a program to a user of the company you work in, with Full behörighet or with a list of its rights.",
  writes: true,
});

export const removeProgram = defineOperation({
  id: "removeProgram",
  method: "delete",
  path: "/v1/users/{memberId}/programs/{program}",
  tags: ["users"],
  summary: "Remove a program",
  description: "Ta bort program: takes the program's grant from a member. A program administrator removes only the programs they administer.",
  params: ProgramPath,
  output: NoBody,
  status: 204,
  permission: "programs:grant",
  tool: "Takes a program from a user of the company you work in.",
  writes: true,
});

export const moveProgram = defineOperation({
  id: "moveProgram",
  method: "post",
  path: "/v1/users/{memberId}/programs/{program}/move",
  tags: ["users"],
  summary: "Move a program",
  description:
    "Flytta program: gives a member's grant of the program to another member, who must not hold the program, and takes it from the first. The grant keeps its time and its end. " +
    "With permissions, it is narrowed first: the list holds only rights the grant holds. A program administrator moves only the programs they administer.",
  params: ProgramPath,
  body: z.strictObject({
    targetMemberId: z.uuid().meta({ description: "The member who gets the grant, by the membership's id." }),
    permissions: GrantPermissions.optional(),
  }),
  output: ProgramGrant,
  permission: "programs:grant",
  tool: "Moves a program from one user of the company you work in to another, narrowed first if you give a list of its rights.",
  writes: true,
});

/** What the mail of an invitation says about the link, for the operations that send one. */
const SENDS =
  "The mail holds a link that works once, for 14 days, and stops the link of the member's earlier invitation. " +
  "With no mail set up for the install, the call gets 422 mail-not-configured, and nothing changes.";

export const inviteUser = defineOperation({
  id: "inviteUser",
  method: "post",
  path: "/v1/users",
  tags: ["users"],
  summary: "Invite a user",
  description:
    "Lägg till användare: makes an invited member of the company, with a name and an e-mail address, and sends the invitation to that address. " +
    `${SENDS} An address that a member of the company has, or that an open invitation of the company goes to, gets 422 already-member.`,
  body: z.strictObject({
    name: z.string().min(1).max(200).check(noNul(), wellFormed(), singleLine()).meta({ description: "Namn: the invited person's name, on one line." }),
    email: emailAddress().meta({
      description:
        "E-postadress: where the invitation goes, one mailbox. A new identity that accepts takes it as its e-mail address, and the member takes it as the work e-mail address.",
    }),
  }),
  output: Member,
  status: 201,
  permission: "users:admin",
  tool: "Invites a person to the company you work in, with a name and an e-mail address: the invitation goes to that address by mail.",
  writes: true,
});

export const resendInvitation = defineOperation({
  id: "resendInvitation",
  method: "post",
  path: "/v1/users/{memberId}/invitation",
  tags: ["users"],
  summary: "Send a new invitation",
  description:
    "Skicka en ny inbjudan: sends an invited member a new invitation, to the name and the e-mail address of their latest one. " +
    `${SENDS} A member who is not invited gets 422 user-not-invited.`,
  params: MemberPath,
  output: NoBody,
  status: 204,
  permission: "users:admin",
  tool: "Sends a new invitation to a user of the company you work in who has not accepted theirs, and stops the old link.",
  writes: true,
});

export const disconnectUserIdentity = defineOperation({
  id: "disconnectUserIdentity",
  method: "post",
  path: "/v1/users/{memberId}/disconnect",
  tags: ["users"],
  summary: "Disconnect a user's identity",
  description:
    "Takes the identity from an active or inactive member, so it no longer reaches the company, and sends the member a new invitation, " +
    "to the person's name and the member's work e-mail address: a new or an existing identity may accept it. The member keeps the admin level and the programs, " +
    "and is invited again; their sessions end, and their work contacts are erased. " +
    `${SENDS} An invited member gets 422 user-invited. The company always keeps an active system administrator.`,
  params: MemberPath,
  output: Member,
  permission: "users:admin",
  tool: "Disconnects the identity of a user of the company you work in, and sends the user a new invitation that a new or an existing identity may accept.",
  writes: true,
});

export const updateUserRights = defineOperation({
  id: "updateUserRights",
  method: "put",
  path: "/v1/users/{memberId}/rights",
  tags: ["users"],
  summary: "Change a user's rights",
  description:
    "Anpassa Rapporter and Anpassa Register/Övrigt: sets a member's Rapporter and Register/Övrigt rights, the whole list. Each of the member's grants holds those its program covers, and keeps its own rights. " +
    "A right that no grant of the member covers is refused. A program administrator sets them only in the grants of the programs they administer.",
  params: MemberPath,
  body: z.strictObject({
    permissions: z.array(RightKey).max(RIGHT_KEYS.length).meta({ description: "Every Rapporter and Register/Övrigt right the member is to hold, as the catalogue's keys. A right of a program's own is refused." }),
  }),
  output: UserRights,
  permission: "programs:grant",
  tool: "Sets the Rapporter and Register/Övrigt rights of a user of the company you work in.",
  writes: true,
});
