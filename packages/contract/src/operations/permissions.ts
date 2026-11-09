// SPDX-License-Identifier: AGPL-3.0-only

// The permission catalogue as /v1 gives it (issue 12, "Roles, admin levels,
// programs and permissions" 1, 9 and 10; BFNAR 2013:2 punkt 9.12): the
// plan's six roles, the programs with their sets, the groups and the
// permissions, each in the catalogue's order, with the view and manual-only
// marks. So the systemdokumentation can say how an outside examiner gets
// access.
//
// The zod schemas are named for what they hold, and their components for
// the terms: PermissionKey, Permission, PermissionGroup, ProgramDefinition,
// RoleDefinition and PermissionCatalogue. The contract's own types of the
// catalogue keep the names Catalogue* and Permission (operation.ts).

import { z } from "zod";
import { CATALOGUE_GROUPS, CATALOGUE_PERMISSIONS, GROUP_KINDS, type CataloguePermissionKey, type GroupKey } from "../access/catalogue.ts";
import { defineOperation } from "../operation.ts";
import { ProgramKey, RoleKey, SysAdmin } from "./companies.ts";

/** Behörighet: a permission of the catalogue, by its key, such as vouchers.book (Bokför). */
export const PermissionKey = z.enum(CATALOGUE_PERMISSIONS.map((permission) => permission.key) as [CataloguePermissionKey, ...CataloguePermissionKey[]]).meta({
  id: "PermissionKey",
  description: "A permission of the catalogue, by its key, such as vouchers.view (Verifikationer) or vouchers.book (Bokför).",
});

/** A group of the catalogue, by its key. */
export const PermissionGroupKey = z.enum(CATALOGUE_GROUPS.map((group) => group.key) as [GroupKey, ...GroupKey[]]).meta({
  id: "PermissionGroupKey",
  description: "A group of the catalogue, by its key: vouchers (Verifikationer), supplier-invoices (Leverantörsfakturor), reports (Rapporter) or register (Register/Övrigt).",
});

export const PermissionEntry = z
  .strictObject({
    key: PermissionKey,
    group: PermissionGroupKey,
    label: z.string().meta({ description: "The permission's words on the screen, such as Bokför." }),
    view: z.boolean().meta({ description: "Whether it is its group's view right, which every other permission of the group needs." }),
    manualOnly: z.boolean().meta({ description: "Whether it is only switched on by hand: Full behörighet never holds it." }),
  })
  .meta({ id: "Permission", description: "Behörighet: a permission of the catalogue, with its group, its screen words and its marks." });

export const PermissionGroup = z
  .strictObject({
    key: PermissionGroupKey,
    kind: z.enum(GROUP_KINDS).meta({ description: "program, for a Bokföring group of a program's own rights; reports, for Rapporter; or register, for Register/Övrigt." }),
    label: z.string().meta({ description: "The group's words on the screen, such as Verifikationer." }),
  })
  .meta({ id: "PermissionGroup", description: "A group of permissions, with its kind and its screen words." });

export const ProgramDefinition = z
  .strictObject({
    key: ProgramKey,
    label: z.string().meta({ description: "The program's words on the screen, such as Bokföring." }),
    lifetimeDays: z.int().min(1).optional().meta({ description: "The days after which a grant of the program ends by itself: 30 for Revisor. Absent for a program whose grant has no end." }),
    permissions: z
      .array(
        z.strictObject({
          key: PermissionKey,
          full: z.boolean().meta({ description: "Whether Full behörighet holds it. A permission that it does not hold is only switched on by hand." }),
        }),
      )
      .meta({ description: "The program's set: every permission a grant of it may hold, in the catalogue's order." }),
  })
  .meta({ id: "ProgramDefinition", description: "Program: a program of the catalogue, with its screen words, its end, and its set." });

export const RoleEntry = z
  .strictObject({
    key: RoleKey,
    adminLevel: SysAdmin.optional(),
    program: ProgramKey.optional(),
    full: z.boolean().optional().meta({ description: "For a program's role: whether only a grant with Full behörighet makes it, as for bookkeeper." }),
  })
  .meta({
    id: "RoleDefinition",
    description:
      "One of the plan's six roles, as a set in this model: owner and admin by the admin level that adminLevel names; the other four by a grant of the program that program names, with Full behörighet when full is true.",
  });

export const PermissionCatalogue = z
  .strictObject({
    roles: z.array(RoleEntry).meta({ description: "The plan's six roles, in their order." }),
    programs: z.array(ProgramDefinition).meta({ description: "The programs, in the catalogue's order." }),
    groups: z.array(PermissionGroup).meta({ description: "The groups, in the catalogue's order." }),
    permissions: z.array(PermissionEntry).meta({ description: "Every permission, in the catalogue's order." }),
  })
  .meta({ id: "PermissionCatalogue", description: "The permission catalogue: the roles, the programs with their sets, the groups and the permissions, in order." });

export type PermissionCatalogue = z.infer<typeof PermissionCatalogue>;

/** The catalogue, for any signed-in person. */
export const listPermissions = defineOperation({
  id: "listPermissions",
  method: "get",
  path: "/v1/permissions",
  tags: ["users"],
  summary: "List the permissions",
  description:
    "Gives the permission catalogue as the install holds it: the plan's six roles, the programs with each one's set and what Full behörighet holds, " +
    "the groups, and every permission, each in the catalogue's order, with its view and manual-only marks.",
  output: PermissionCatalogue,
  permission: "signed-in",
  tool: "Gives the permission catalogue: the roles, the programs with their sets, the groups and every permission in order, with the view and manual-only marks.",
  writes: false,
});
