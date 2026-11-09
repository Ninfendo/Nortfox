// SPDX-License-Identifier: AGPL-3.0-only

// Which programs the actor reaches in the user administration (issue 12,
// "Roles, admin levels, programs and permissions" 2 and 3): a system
// administrator every program; a program administrator only the programs
// they administer, which they alone see and grant. The request holds both
// as its credential took them: a session when it chose the company, so a
// change reaches the session when it chooses the company again (R11).
// users:admin is the permission that only a system administrator holds.

import type { CompanyAccess } from "../../api/context.ts";
import type { Reach } from "../memberships/members.ts";

/** The programs that the actor of `access` reaches. */
export function reachOf(access: CompanyAccess): Reach {
  if (access.permissions.includes("users:admin")) {
    return { all: true };
  }
  return { all: false, programs: access.programsAdministered };
}
