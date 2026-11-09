// SPDX-License-Identifier: AGPL-3.0-only

// listPermissions (issue 12, "Roles, admin levels, programs and
// permissions"; BFNAR 2013:2 punkt 9.12): the permission catalogue as the
// install holds it, in its order, for any signed-in person. The programs,
// the groups, the permissions and each program's set come from the
// catalogue's tables, which every role but the readers may read and only a
// migration changes; the plan's six roles are sets in this model, from the
// contract.

import { ROLES, listPermissions, type PermissionCatalogue } from "@nortfox/contract";
import { handlePerson, ok } from "../../api/operation.ts";

type Catalogue = PermissionCatalogue;

export const listPermissionsHandler = handlePerson(listPermissions, async ({ tx }) => {
  const programs = await tx.query<{ program: Catalogue["programs"][number]["key"]; label: string; lifetime_days: number | null }>(
    "SELECT program, label, lifetime_days FROM access.catalogue_programs ORDER BY position",
  );
  const groups = await tx.query<{ group_key: Catalogue["groups"][number]["key"]; kind: Catalogue["groups"][number]["kind"]; label: string }>(
    "SELECT group_key, kind, label FROM access.catalogue_groups ORDER BY position",
  );
  const permissions = await tx.query<{ permission: Catalogue["permissions"][number]["key"]; group_key: Catalogue["groups"][number]["key"]; label: string; is_view: boolean; manual_only: boolean }>(
    "SELECT permission, group_key, label, is_view, manual_only FROM access.catalogue_permissions ORDER BY position",
  );
  const sets = await tx.query<{ program: string; permission: Catalogue["permissions"][number]["key"]; in_full: boolean }>(
    `SELECT s.program, s.permission, s.in_full FROM access.catalogue_program_permissions AS s
     JOIN access.catalogue_permissions AS p ON p.permission = s.permission ORDER BY p.position`,
  );
  const catalogue: Catalogue = {
    roles: ROLES.map((role) => ({ ...role })),
    programs: programs.rows.map((row) => ({
      key: row.program,
      label: row.label,
      ...(row.lifetime_days === null ? {} : { lifetimeDays: row.lifetime_days }),
      permissions: sets.rows.filter((entry) => entry.program === row.program).map((entry) => ({ key: entry.permission, full: entry.in_full })),
    })),
    groups: groups.rows.map((row) => ({ key: row.group_key, kind: row.kind, label: row.label })),
    permissions: permissions.rows.map((row) => ({ key: row.permission, group: row.group_key, label: row.label, view: row.is_view, manualOnly: row.manual_only })),
  };
  return ok(catalogue);
});
